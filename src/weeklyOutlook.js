/**
 * Weekly Outlook (SHADOW — display and measurement only, never traded, never sent to Telegram).
 *
 * computeWeeklyOutlook({ days, config }) turns the recorded daily swing summaries
 * (src/swingSummary.js) into a multi-day reading: four evidence groups (price, futures, options,
 * volatility), a regime (TREND_UP / TREND_DOWN / RANGE / BREAK_RISK_UP / BREAK_RISK_DOWN /
 * INSUFFICIENT_DATA), reference levels and a confidence. evaluateOutlookOutcome measures a stored
 * outlook against the sessions that followed it. Every threshold is a named default in
 * getOutlookConfig (SWING_* env overrides) and every raw input is kept in `inputs`, so the
 * thresholds can be re-fitted later. Pure; never throws. See docs/weekly-outlook.md.
 */
import { PRICE_DEADBAND_PCT, OI_DEADBAND_PCT } from "./smartMoneyFusion.js";
import { combineProfiles } from "./volumeProfile.js";
import { getSessionKindForDate } from "./marketCalendar.js";
import { computeSetups, getSetupConfig } from "./outlookSetups.js";

// v2 (2026-11-21): days to expiry counted in trading sessions, volatility compares like with like,
// ladder steps always ordered, volume reference kept, shadow option setups.
export const OUTLOOK_VERSION = 2;
export const REGIMES = ["TREND_UP", "TREND_DOWN", "RANGE", "BREAK_RISK_UP", "BREAK_RISK_DOWN", "INSUFFICIENT_DATA"];

export const OUTLOOK_HIT_RULES = {
  TREND_UP: "Hit when the spot close on the horizon day is above the reference close.",
  TREND_DOWN: "Hit when the spot close on the horizon day is below the reference close.",
  RANGE: "Hit when every daily spot close after the outlook, up to and including the horizon day, stays inside the expected range.",
  BREAK_RISK_UP: "Hit when any daily spot close after the outlook, up to the horizon day, is above the expected-range high.",
  BREAK_RISK_DOWN: "Hit when any daily spot close after the outlook, up to the horizon day, is below the expected-range low.",
  INSUFFICIENT_DATA: "Not measured.",
};
export const OUTLOOK_HORIZON_RULE = "Horizon = the first recorded session on/after the outlook's expiry date, or the 5th later session, whichever comes first.";

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};

export function getOutlookConfig(env = process.env) {
  const e = env || {};
  setExchangeHolidays(e.SWING_EXCHANGE_HOLIDAYS || []);
  return {
    minDaysForRegime: Math.round(num(e.SWING_MIN_DAYS_FOR_REGIME, 3)),
    priceMinDays: Math.round(num(e.SWING_PRICE_MIN_DAYS, 5)),
    priceMeanBandPct: num(e.SWING_PRICE_MEAN_BAND_PCT, 0.3),
    futuresMinDays: Math.round(num(e.SWING_FUTURES_MIN_DAYS, 3)),
    futuresLookbackDays: Math.round(num(e.SWING_FUTURES_LOOKBACK_DAYS, 5)),
    futPriceDeadbandPct: num(e.SWING_FUT_PRICE_DEADBAND_PCT, PRICE_DEADBAND_PCT),
    futOiDeadbandPct: num(e.SWING_FUT_OI_DEADBAND_PCT, OI_DEADBAND_PCT),
    futRollBasisPct: num(e.SWING_FUT_ROLL_BASIS_PCT, 0.35),
    pcrSupportive: num(e.SWING_PCR_SUPPORTIVE, 1.2),
    pcrResistive: num(e.SWING_PCR_RESISTIVE, 0.8),
    volMinDays: Math.round(num(e.SWING_VOL_MIN_DAYS, 3)),
    volLookbackDays: Math.round(num(e.SWING_VOL_LOOKBACK_DAYS, 5)),
    volRatio: num(e.SWING_VOL_RATIO, 1.3),
    trendScore: num(e.SWING_TREND_SCORE, 3),
    highConfidenceScore: num(e.SWING_HIGH_CONFIDENCE_SCORE, 5),
    breakProximityStraddleFrac: num(e.SWING_BREAK_PROXIMITY_FRAC, 0.25),
    minNearDte: num(e.SWING_MIN_NEAR_DTE, 3), // used only when trading sessions cannot be counted
    // The near weekly is the outlook expiry only with at least this many trading sessions left after
    // the recorded session (Friday → Monday expiry is 1 session even though it is 3 calendar days).
    minNearSessions: Math.round(num(e.SWING_MIN_NEAR_SESSIONS, 2)),
    // Variance weight of a closed (weekend) calendar day relative to a session, for the straddle's time.
    closedDayVarWeight: num(e.SWING_CLOSED_DAY_VAR_WEIGHT, 0.25),
    // ATM straddle ≈ 0.8 σ√T and a session's expected high–low range ≈ 1.6 σ, so the implied range per
    // session ≈ 2 × straddle / √T. (v1 compared straddle/√calendar-days with the range: ~3× too low.)
    volRangeFactor: num(e.SWING_VOL_RANGE_FACTOR, 2),
    setup: getSetupConfig(e),
    pivotMinSessions: Math.round(num(e.SWING_PIVOT_MIN_SESSIONS, 4)),
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "24-Nov-2026" → "2026-11-24" (null when unparseable). */
export function expiryToIso(expiry) {
  const p = String(expiry || "").trim().split("-");
  if (p.length !== 3) return null;
  const mi = MONTHS.findIndex((m) => m.toLowerCase() === p[1].toLowerCase());
  const d = Number(p[0]);
  const y = Number(p[2]);
  if (mi < 0 || !(d >= 1 && d <= 31) || !(y > 2000)) return null;
  return `${y}-${String(mi + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const isFin = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const r2 = (n) => Math.round(n * 100) / 100;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : 0);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const f0 = (n) => (isFin(n) ? String(Math.round(Number(n))) : "—");
const pct = (n) => (isFin(n) ? `${Number(n) >= 0 ? "+" : ""}${Number(n).toFixed(2)}%` : "—");
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const needsN = (n) => `${plural(n, "more session")}`;
const dowOf = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay();
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
const mondayOf = (iso) => shift(iso, -((dowOf(iso) + 6) % 7));

/**
 * NSE trading holidays that fall on weekdays, used ONLY to count sessions to an expiry (the live
 * session logic in src/marketCalendar.js is unchanged). Audit 21-Nov-2026: Tue 24-Nov-2026 (Guru
 * Nanak Jayanti; the weekly expiry moved to Mon 23-Nov) was counted as a session, so 7 sessions
 * were shown to 01-Dec instead of 6. Defaults are dates NSE closes every year or whose expiry
 * shift confirms them; add more with SWING_EXCHANGE_HOLIDAYS (comma-separated YYYY-MM-DD).
 */
export const DEFAULT_EXCHANGE_HOLIDAYS = Object.freeze(["2026-11-24", "2026-12-25", "2027-01-26"]);
let exchangeHolidays = new Set(DEFAULT_EXCHANGE_HOLIDAYS);
/** Replaces the holiday list (defaults + the given dates). Returns the list in use. */
export function setExchangeHolidays(extra = []) {
  const ok = (Array.isArray(extra) ? extra : String(extra || "").split(",")).map((x) => String(x).trim()).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
  exchangeHolidays = new Set([...DEFAULT_EXCHANGE_HOLIDAYS, ...ok]);
  return [...exchangeHolidays].sort();
}
const isSessionDate = (iso) => !exchangeHolidays.has(iso) && getSessionKindForDate(iso) !== "CLOSED";

/**
 * Trading sessions strictly after fromIso up to and including toIso (weekdays and Muhurat dates,
 * minus the exchange holidays above), and the closed calendar days in between. null when either
 * date is unusable or toIso is more than 400 days away.
 */
export function sessionsBetween(fromIso, toIso) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(String(fromIso || "")) || !re.test(String(toIso || ""))) return null;
  const span = Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(span) || span > 400) return null;
  if (span <= 0) return { sessions: 0, closedDays: 0, calendarDays: Math.max(0, span) };
  let sessions = 0;
  for (let i = 1; i <= span; i++) if (isSessionDate(shift(fromIso, i))) sessions += 1;
  return { sessions, closedDays: span - sessions, calendarDays: span };
}

/** Sessions left to a chain's expiry after the recorded session asOf (null when not countable). */
function sessionsLeft(asOf, expiry) {
  const iso = expiryToIso(expiry);
  return iso && asOf ? sessionsBetween(asOf, iso) : null;
}

const hasSpotBar = (d) => d?.spot && isFin(d.spot.close) && isFin(d.spot.high) && isFin(d.spot.low) && Number(d.spot.close) > 0;
const hasFutBar = (d) => d?.fut && Number(d.fut.close) > 0 && Number(d.fut.oiClose) > 0;

function cleanDays(days) {
  const byDate = new Map();
  for (const d of Array.isArray(days) ? days : []) {
    if (d && typeof d === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(d.date || ""))) byDate.set(d.date, d);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const CHAIN_LABEL = { near: "near weekly", nextWeekly: "next weekly", monthly: "monthly" };

/** The outlook expiry: the near weekly with ≥ minNearDte days left, else the next weekly; fallback to any captured chain. */
export function chooseHorizon(last, cfg) {
  const chains = last?.chains || {};
  const near = chains.near;
  const okChain = (c) => c && Number(c.straddle) > 0;
  let want = "nextWeekly";
  let why = "";
  const nearLeft = okChain(near) ? sessionsLeft(last?.date, near.expiry) : null;
  if (okChain(near) && nearLeft && nearLeft.sessions >= cfg.minNearSessions) {
    want = "near";
    why = `near weekly has ${plural(nearLeft.sessions, "trading session")} left (≥ ${cfg.minNearSessions})`;
  } else if (okChain(near) && nearLeft) {
    why = `near weekly has ${plural(nearLeft.sessions, "trading session")} left (< ${cfg.minNearSessions}), so the next weekly is used`;
  } else if (okChain(near) && isFin(near.dte) && Number(near.dte) >= cfg.minNearDte) {
    want = "near";
    why = `near weekly has ${plural(Number(near.dte), "day")} left (≥ ${cfg.minNearDte}; sessions not countable)`;
  } else if (okChain(near)) {
    why = `near weekly has ${plural(Number(near.dte) || 0, "day")} left (< ${cfg.minNearDte}), so the next weekly is used`;
  } else {
    why = "near weekly chain not captured, so the next weekly is used";
  }
  const out = (k, c, basis, fallback) => {
    const left = sessionsLeft(last?.date, c.expiry);
    return { key: k, chain: c, expiry: c.expiry || null, dte: isFin(c.dte) ? Number(c.dte) : null, sessionsLeft: left ? left.sessions : null, closedDaysLeft: left ? left.closedDays : null, basis, fallback };
  };
  if (okChain(chains[want])) return out(want, chains[want], `${CHAIN_LABEL[want]} ${chains[want].expiry || "?"}: ${why}`, false);
  for (const k of ["near", "nextWeekly", "monthly"]) {
    if (okChain(chains[k])) return out(k, chains[k], `${CHAIN_LABEL[want]} chain was not captured on ${last?.date}; using the ${CHAIN_LABEL[k]} ${chains[k].expiry || "?"} instead`, true);
  }
  return { key: null, chain: null, expiry: null, dte: null, sessionsLeft: null, closedDaysLeft: null, basis: last ? `no option chain recorded on ${last.date}` : "no sessions recorded", fallback: false };
}

function priceGroup(ds, cfg) {
  const bars = ds.filter(hasSpotBar);
  const g = { available: false, score: null, reasons: [], needs: null, inputs: { bars: bars.length } };
  if (bars.length < cfg.priceMinDays) {
    g.needs = needsN(cfg.priceMinDays - bars.length);
    g.reasons.push(`Price trend needs ${cfg.priceMinDays} daily bars; ${bars.length} recorded.`);
    return g;
  }
  const last5 = bars.slice(-5);
  const closes = last5.map((d) => Number(d.spot.close));
  const c = closes[closes.length - 1];
  const m5 = mean(closes);
  const band = cfg.priceMeanBandPct / 100;
  let sMean = 0;
  if (c > m5 * (1 + band)) { sMean = 1; g.reasons.push(`Close ${f0(c)} is above the 5-day average ${f0(m5)} (by more than ${cfg.priceMeanBandPct}%).`); }
  else if (c < m5 * (1 - band)) { sMean = -1; g.reasons.push(`Close ${f0(c)} is below the 5-day average ${f0(m5)} (by more than ${cfg.priceMeanBandPct}%).`); }
  else g.reasons.push(`Close ${f0(c)} is within ${cfg.priceMeanBandPct}% of the 5-day average ${f0(m5)}.`);
  const last3 = bars.slice(-3);
  const h = last3.map((d) => Number(d.spot.high));
  const l = last3.map((d) => Number(d.spot.low));
  const hh = h[1] > h[0] && h[2] > h[1];
  const hl = l[1] > l[0] && l[2] > l[1];
  const ll = l[1] < l[0] && l[2] < l[1];
  const lh = h[1] < h[0] && h[2] < h[1];
  let sStruct = 0;
  if (hh && hl) { sStruct = 1; g.reasons.push("Higher highs and higher lows over the last 3 sessions."); }
  else if (ll && lh) { sStruct = -1; g.reasons.push("Lower highs and lower lows over the last 3 sessions."); }
  else g.reasons.push("No clean higher-high/higher-low or lower-low/lower-high pattern over the last 3 sessions.");
  const hi5 = Math.max(...last5.map((d) => Number(d.spot.high)));
  const lo5 = Math.min(...last5.map((d) => Number(d.spot.low)));
  const pos = hi5 > lo5 ? (c - lo5) / (hi5 - lo5) : 0.5;
  let sPos = 0;
  if (pos >= 2 / 3) { sPos = 1; g.reasons.push(`Close sits in the top third of the 5-day range ${f0(lo5)}–${f0(hi5)}.`); }
  else if (pos <= 1 / 3) { sPos = -1; g.reasons.push(`Close sits in the bottom third of the 5-day range ${f0(lo5)}–${f0(hi5)}.`); }
  else g.reasons.push(`Close sits in the middle third of the 5-day range ${f0(lo5)}–${f0(hi5)}.`);
  g.available = true;
  g.score = clamp(sMean + sStruct + sPos, -2, 2);
  g.inputs = { bars: bars.length, dates: last5.map((d) => d.date), closes, mean5: r2(m5), bandPct: cfg.priceMeanBandPct, highs3: h, lows3: l, hi5, lo5, rangePos: r2(pos), components: { mean: sMean, structure: sStruct, rangePos: sPos } };
  return g;
}

function futuresGroup(ds, cfg) {
  const bars = ds.filter(hasFutBar);
  const g = { available: false, score: null, reasons: [], needs: null, inputs: { bars: bars.length } };
  if (bars.length < cfg.futuresMinDays) {
    g.needs = needsN(cfg.futuresMinDays - bars.length);
    g.reasons.push(`Futures build-up needs ${cfg.futuresMinDays} sessions with futures close and open interest; ${bars.length} recorded.`);
    return g;
  }
  const win = bars.slice(-cfg.futuresLookbackDays);
  const a = win[0];
  const b = win[win.length - 1];
  // Contract roll inside the window (audit 21-Nov-2026: the November contract expires 23-Nov; the
  // December one trades ~0.6% higher, a fake rise big enough to flip the quadrant). Detected by a
  // change of the recorded contract expiry, or — when the expiry is not recorded — by a jump of the
  // futures basis (fut − spot) of at least SWING_FUT_ROLL_BASIS_PCT (0.35% of spot). On a roll the
  // price leg uses the SPOT change; open interest is near + next month combined, so roll-safe.
  const basisPct = (d) => (Number(d.spot?.close) > 0 ? ((Number(d.fut.close) - Number(d.spot.close)) / Number(d.spot.close)) * 100 : null);
  const expiryRolled = Boolean(a.fut.expiry && b.fut.expiry && a.fut.expiry !== b.fut.expiry);
  const ba = basisPct(a), bb = basisPct(b);
  const basisJump = !(a.fut.expiry && b.fut.expiry) && ba !== null && bb !== null && Math.abs(bb - ba) >= cfg.futRollBasisPct;
  const rolled = expiryRolled || basisJump;
  const spotOk = Number(a.spot?.close) > 0 && Number(b.spot?.close) > 0;
  const pricePct = rolled && spotOk
    ? ((Number(b.spot.close) - Number(a.spot.close)) / Number(a.spot.close)) * 100
    : ((Number(b.fut.close) - Number(a.fut.close)) / Number(a.fut.close)) * 100;
  const oiPct = ((Number(b.fut.oiClose) - Number(a.fut.oiClose)) / Number(a.fut.oiClose)) * 100;
  let quadrant = "NEUTRAL";
  let score = 0;
  if (Math.abs(pricePct) < cfg.futPriceDeadbandPct || Math.abs(oiPct) < cfg.futOiDeadbandPct) { quadrant = "NEUTRAL"; score = 0; }
  else if (pricePct > 0 && oiPct > 0) { quadrant = "LONG_BUILDUP"; score = 2; }
  else if (pricePct < 0 && oiPct > 0) { quadrant = "SHORT_BUILDUP"; score = -2; }
  else if (pricePct > 0 && oiPct < 0) { quadrant = "SHORT_COVERING"; score = 1; }
  else { quadrant = "LONG_UNWINDING"; score = -1; }
  const label = { NEUTRAL: "no clear build-up (inside the deadbands)", LONG_BUILDUP: "long build-up", SHORT_BUILDUP: "short build-up", SHORT_COVERING: "short covering", LONG_UNWINDING: "long unwinding" }[quadrant];
  g.reasons.push(`From the ${a.date} close to the ${b.date} close (${plural(win.length, "session")} recorded) ${rolled && spotOk ? "price (spot, contract rolled)" : "futures"} moved ${pct(pricePct)} with open interest ${pct(oiPct)}: ${label}.`);
  if (rolled) g.reasons.push(expiryRolled
    ? `The futures contract changed (${a.fut.expiry} → ${b.fut.expiry}); ${spotOk ? "the price change is measured on spot" : "no spot close to measure on, so the price change spans two contracts"}.`
    : `The futures basis jumped ${ba.toFixed(2)}% → ${bb.toFixed(2)}% of spot (a contract roll); the price change is measured on spot.`);
  g.available = true;
  g.score = score;
  g.inputs = { bars: bars.length, from: a.date, to: b.date, sessions: win.length, closeFrom: a.fut.close, closeTo: b.fut.close, oiFrom: a.fut.oiClose, oiTo: b.fut.oiClose, pricePct: r2(pricePct), oiPct: r2(oiPct), priceDeadbandPct: cfg.futPriceDeadbandPct, oiDeadbandPct: cfg.futOiDeadbandPct, quadrant, contractRolled: Boolean(rolled), rollDetectedBy: expiryRolled ? "expiry" : basisJump ? "basis" : null, priceLeg: rolled && spotOk ? "spot" : "futures", basisPctFrom: ba === null ? null : r2(ba), basisPctTo: bb === null ? null : r2(bb) };
  return g;
}

function findSameExpiryChain(day, expiry) {
  if (!day?.chains || !expiry) return null;
  for (const k of ["near", "nextWeekly", "monthly"]) {
    const c = day.chains[k];
    if (c && c.expiry && String(c.expiry).toLowerCase() === String(expiry).toLowerCase()) return c;
  }
  return null;
}

function optionsGroup(ds, horizon, refSpot, cfg) {
  const g = { available: false, score: null, reasons: [], needs: null, inputs: {}, migration: null };
  const chain = horizon.chain;
  if (!chain) {
    g.needs = "1 more session with an option-chain capture (15:20–15:40 IST)";
    g.reasons.push("No option chain for the outlook expiry on the last recorded session.");
    return g;
  }
  const s = isFin(refSpot) ? Number(refSpot) : Number(chain.spot);
  const pw = isFin(chain.putWall) ? Number(chain.putWall) : null;
  const cw = isFin(chain.callWall) ? Number(chain.callWall) : null;
  let sPos = 0;
  let pos = null;
  if (pw !== null && cw !== null && cw > pw) {
    if (s > cw) { sPos = 1; g.reasons.push(`Spot ${f0(s)} is above the call wall ${cw}: call writers are under pressure.`); }
    else if (s < pw) { sPos = -1; g.reasons.push(`Spot ${f0(s)} is below the put wall ${pw}: put writers are under pressure.`); }
    else {
      pos = (s - pw) / (cw - pw);
      if (pos <= 1 / 3) { sPos = 1; g.reasons.push(`Spot ${f0(s)} sits near the put wall ${pw} (support) inside ${pw}–${cw}.`); }
      else if (pos >= 2 / 3) { sPos = -1; g.reasons.push(`Spot ${f0(s)} sits near the call wall ${cw} (resistance) inside ${pw}–${cw}.`); }
      else g.reasons.push(`Spot ${f0(s)} sits mid-way between the put wall ${pw} and the call wall ${cw}.`);
    }
  } else {
    g.reasons.push(pw !== null && cw !== null ? `Walls are inverted (put wall ${pw} ≥ call wall ${cw}); position not scored.` : "Put or call wall missing; position not scored.");
  }
  let sPcr = 0;
  if (isFin(chain.pcr)) {
    if (Number(chain.pcr) >= cfg.pcrSupportive) { sPcr = 1; g.reasons.push(`PCR ${chain.pcr} (≥ ${cfg.pcrSupportive}) is supportive.`); }
    else if (Number(chain.pcr) <= cfg.pcrResistive) { sPcr = -1; g.reasons.push(`PCR ${chain.pcr} (≤ ${cfg.pcrResistive}) is resistive.`); }
    else g.reasons.push(`PCR ${chain.pcr} is neutral.`);
  }
  let sMig = 0;
  const prevDay = ds.length >= 2 ? ds[ds.length - 2] : null;
  const prev = findSameExpiryChain(prevDay, chain.expiry);
  let migration = null;
  if (prev && pw !== null && cw !== null && isFin(prev.putWall) && isFin(prev.callWall)) {
    const dPut = pw - Number(prev.putWall);
    const dCall = cw - Number(prev.callWall);
    sMig = clamp(sign(dPut) + sign(dCall), -1, 1);
    const dir = dPut === 0 && dCall === 0 ? "NONE" : sMig > 0 ? "UP" : sMig < 0 ? "DOWN" : "MIXED";
    migration = { fromDate: prevDay.date, putFrom: Number(prev.putWall), putTo: pw, callFrom: Number(prev.callWall), callTo: cw, dPut, dCall, direction: dir };
    if (dir === "NONE") g.reasons.push(`Walls unchanged since ${prevDay.date}.`);
    else g.reasons.push(`Since ${prevDay.date} the put wall moved ${prev.putWall} → ${pw} and the call wall ${prev.callWall} → ${cw} (${dir === "MIXED" ? "mixed" : dir === "UP" ? "upward" : "downward"}).`);
  } else {
    g.reasons.push("Wall migration needs the same expiry's chain on the previous session.");
  }
  g.available = true;
  g.score = clamp(sPos + sPcr + sMig, -2, 2);
  g.migration = migration;
  g.inputs = { expiry: chain.expiry, spot: r2(s), putWall: pw, callWall: cw, wallPos: pos === null ? null : r2(pos), pcr: chain.pcr ?? null, pcrSupportive: cfg.pcrSupportive, pcrResistive: cfg.pcrResistive, migration, components: { position: sPos, pcr: sPcr, migration: sMig } };
  return g;
}

function volatilityGroup(ds, horizon, cfg) {
  const g = { available: false, state: null, score: null, reasons: [], needs: null, inputs: {} };
  const bars = ds.filter(hasSpotBar);
  const straddle = horizon.chain ? Number(horizon.chain.straddle) : null;
  if (!(straddle > 0)) {
    g.needs = "1 more session with an option-chain capture (15:20–15:40 IST)";
    g.reasons.push("Needs the ATM straddle of the outlook expiry.");
    return g;
  }
  if (bars.length < cfg.volMinDays) {
    g.needs = needsN(cfg.volMinDays - bars.length);
    g.reasons.push(`Needs ${cfg.volMinDays} daily ranges; ${bars.length} recorded.`);
    return g;
  }
  const win = bars.slice(-cfg.volLookbackDays);
  const ranges = win.map((d) => Number(d.spot.high) - Number(d.spot.low));
  const realised = mean(ranges);
  const dte = isFin(horizon.dte) ? Number(horizon.dte) : 1;
  // Time in session units: sessions left + a small weight for closed days (weekends carry little
  // variance). Falls back to calendar days when sessions cannot be counted.
  const counted = isFin(horizon.sessionsLeft);
  const tUnits = counted ? Math.max(1, Number(horizon.sessionsLeft) + cfg.closedDayVarWeight * Number(horizon.closedDaysLeft || 0)) : Math.max(dte, 1);
  const impliedRange = (cfg.volRangeFactor * straddle) / Math.sqrt(tUnits);
  let state = "NORMAL";
  if (impliedRange >= cfg.volRatio * realised) state = "COMPRESSED";
  else if (realised >= cfg.volRatio * impliedRange) state = "EXPANDING";
  const txt = { COMPRESSED: "options price bigger moves than the market is making (premium is rich)", EXPANDING: "the market is moving more than options price in (premium is cheap)", NORMAL: "realised and implied moves are in line" }[state];
  const tTxt = counted ? `${plural(Number(horizon.sessionsLeft), "session")}${horizon.closedDaysLeft ? ` + ${plural(Number(horizon.closedDaysLeft), "closed day")}` : ""}` : plural(Math.max(dte, 1), "calendar day");
  g.reasons.push(`Straddle ${f0(straddle)} over ${tTxt} implies a ~${f0(impliedRange)}-pt high–low range a session; the last ${plural(win.length, "session")} averaged ${f0(realised)}: ${txt}.`);
  g.available = true;
  g.state = state;
  g.inputs = { straddle, dte, sessionsLeft: counted ? Number(horizon.sessionsLeft) : null, closedDaysLeft: counted ? Number(horizon.closedDaysLeft || 0) : null, timeUnits: r2(tUnits), rangeFactor: cfg.volRangeFactor, impliedRangePerSession: r2(impliedRange), realisedAvgRange: r2(realised), realisedToImplied: impliedRange > 0 ? r2(realised / impliedRange) : null, ranges: ranges.map(r2), dates: win.map((d) => d.date), ratio: cfg.volRatio };
  return g;
}

function weekLevels(ds, last, cfg) {
  if (!last) return { pivot: { value: null, basis: "no sessions recorded" }, prevWeek: null };
  const dow = dowOf(last.date);
  const weekStart = dow === 5 || dow === 6 || dow === 0 ? mondayOf(last.date) : shift(mondayOf(last.date), -7);
  const weekEnd = shift(weekStart, 6);
  const wk = ds.filter((d) => d.date >= weekStart && d.date <= weekEnd && hasSpotBar(d));
  const prevWeek = wk.length
    ? { from: weekStart, to: shift(weekStart, 4), sessions: wk.length, high: Math.max(...wk.map((d) => Number(d.spot.high))), low: Math.min(...wk.map((d) => Number(d.spot.low))), close: Number(wk[wk.length - 1].spot.close) }
    : null;
  if (prevWeek && prevWeek.sessions >= cfg.pivotMinSessions) {
    return { pivot: { value: r2((prevWeek.high + prevWeek.low + prevWeek.close) / 3), basis: `classic weekly pivot (H+L+C)/3 of the week ${weekStart} to ${shift(weekStart, 4)} (${prevWeek.sessions} sessions)` }, prevWeek };
  }
  const bars = ds.filter(hasSpotBar).slice(-5);
  if (!bars.length) return { pivot: { value: null, basis: "no spot closes recorded" }, prevWeek };
  return {
    pivot: { value: r2(mean(bars.map((d) => Number(d.spot.close)))), basis: `mean of the last ${plural(bars.length, "recorded close")} (no full previous week of ≥ ${cfg.pivotMinSessions} sessions recorded yet)` },
    prevWeek,
  };
}

/**
 * Invalidation ladder (owner 2026-11-19). The old invalidation was the whole-chain call/put wall:
 * 26000 / 24000 on 18-Nov, ~800 pts away — on 5 years of daily bars a level that far was reached
 * 7 times, never in time to matter. A level beyond which the view is wrong is a RISK boundary, not
 * a forecast (a close beyond the last swing level predicted the next 3 days no better than chance:
 * 51% / 56% vs 54% base, 2021-10 to 2026-11), so it should sit at the nearest real structure:
 *
 *   1 WARNING      a daily close back across the multi-session volume centre (POC / VWAP)
 *   2 INVALIDATED  a daily close beyond the previous day's high (bearish view) / low (bullish),
 *                  merged with the value-area edge and the near-money OI wall when they are close
 *   3 FLIPPED      a daily close beyond the last confirmed swing high / low, merged with the
 *                  near-money OI wall when close; the expected-range edge when no swing is recorded
 *
 * "Merged" = within max(25 pts, 0.15 × straddle) of the anchor: the step is then a ZONE and is
 * breached by a daily close beyond its far edge. Every component is listed with its source.
 */
export const LADDER_PROFILE_SESSIONS = 5;

function confirmedSwings(ds) {
  const bars = ds.filter(hasSpotBar);
  let hi = null, lo = null;
  for (let i = 1; i < bars.length - 1; i++) {
    const h = Number(bars[i].spot.high), l = Number(bars[i].spot.low);
    if (h > Number(bars[i - 1].spot.high) && h > Number(bars[i + 1].spot.high)) hi = { value: h, date: bars[i].date };
    if (l < Number(bars[i - 1].spot.low) && l < Number(bars[i + 1].spot.low)) lo = { value: l, date: bars[i].date };
  }
  return { hi, lo };
}

function zoneOf(components, side, tol) {
  const anchor = components[0];
  const kept = components.filter((c, i) => i === 0 || Math.abs(c.value - anchor.value) <= tol);
  const vals = kept.map((c) => c.value);
  const low = Math.min(...vals), high = Math.max(...vals);
  return { value: r2(side === "above" ? high : low), zone: { low: r2(low), high: r2(high) }, components: kept };
}

function buildLadder({ side, close, prevDay, swing, profile, nearWall, expectedRange, tol }) {
  const steps = [];
  const beyond = (v) => isFin(v) && (side === "above" ? Number(v) > close : Number(v) < close);
  const fmtC = (c) => `${c.note} ${f0(c.value)}`;
  const wallComp = () => ({ type: side === "above" ? "NEAR_CALL_WALL" : "NEAR_PUT_WALL", value: Number(nearWall.strike), note: `largest near-money ${side === "above" ? "call" : "put"} OI (${Math.round(nearWall.oi / 1000)}k)` });
  // 2 INVALIDATED (built first: the warning must sit between the close and step 2): previous day's extreme, merged with the value-area edge and the near-money wall
  const pdx = side === "above" ? prevDay.high : prevDay.low;
  if (beyond(pdx)) {
    const comps = [{ type: side === "above" ? "PREV_DAY_HIGH" : "PREV_DAY_LOW", value: Number(pdx), note: `${prevDay.date} ${side === "above" ? "high" : "low"}` }];
    const va = profile ? (side === "above" ? profile.vah : profile.val) : null;
    if (beyond(va)) comps.push({ type: side === "above" ? "VALUE_AREA_HIGH" : "VALUE_AREA_LOW", value: va, note: `${profile.sessions}-session value-area ${side === "above" ? "high" : "low"}` });
    if (nearWall && beyond(nearWall.strike)) comps.push(wallComp());
    const z = zoneOf(comps, side, tol);
    steps.push({ key: "INVALIDATED", ...z, status: "NOT_REACHED", basis: `a daily close ${side} ${f0(z.value)} (${z.components.map(fmtC).join(", ")})` });
  }
  // 3 FLIPPED: the last confirmed swing extreme beyond step 2, merged with the near-money wall
  const s2 = steps.find((x) => x.key === "INVALIDATED");
  const past2 = (v) => beyond(v) && (!s2 || (side === "above" ? Number(v) > s2.zone.high + tol : Number(v) < s2.zone.low - tol));
  const sw = side === "above" ? swing.hi : swing.lo;
  let comps3 = null;
  if (sw && past2(sw.value)) {
    comps3 = [{ type: side === "above" ? "SWING_HIGH" : "SWING_LOW", value: sw.value, note: `last swing ${side === "above" ? "high" : "low"} (${sw.date})` }];
    if (nearWall && past2(nearWall.strike)) comps3.push(wallComp());
  } else {
    // No recorded swing beyond step 2: the NEARER of the near-money OI wall and the expected-range
    // edge, merged with the other when close (owner 2026-11-21: on 20-Nov the 26000 call wall sat
    // between step 2 at 25804 and the range edge at 26317 and appeared in neither step).
    const alt = [];
    if (nearWall && past2(nearWall.strike)) alt.push(wallComp());
    const ev = expectedRange ? (side === "above" ? expectedRange.high : expectedRange.low) : null;
    if (ev !== null && past2(ev)) alt.push({ type: "EXPECTED_RANGE", value: ev, note: `expected-range ${side === "above" ? "high" : "low"}` });
    alt.sort((a, b) => Math.abs(a.value - close) - Math.abs(b.value - close));
    if (alt.length) {
      alt[0] = { ...alt[0], note: `${alt[0].note} (no recorded swing beyond step 2)` };
      comps3 = alt;
    }
  }
  if (comps3) {
    const z = zoneOf(comps3, side, tol);
    steps.push({ key: "FLIPPED", ...z, status: "NOT_REACHED", basis: `a daily close ${side} ${f0(z.value)} (${z.components.map(fmtC).join(", ")})` });
  }
  // 1 WARNING: the volume centre on the view's wrong side, but only where it comes BEFORE step 2
  // (v1 could place it beyond step 2: 25225 below 25368 on 20-Nov-2026, a warning after the view
  // was already wrong). Preference: the original centre (the farther of POC / VWAP), then the
  // nearer of the two, then the near-money OI wall. None in between → no warning step; the volume
  // levels stay visible as the ladder's volume reference.
  // Bound: the nearest later step — step 2, or step 3 when there is no step 2 (review 21-Nov: a close
  // at the session low builds no step 2, and the warning landed beyond the swing-low flip).
  const s2pre = steps.find((x) => x.key === "INVALIDATED") || steps.find((x) => x.key === "FLIPPED");
  const before2 = (v) => beyond(v) && (!s2pre || (side === "above" ? Number(v) < s2pre.zone.low - tol / 2 : Number(v) > s2pre.zone.high + tol / 2));
  let warning = null;
  let warningNote = null;
  if (profile) {
    const comps = [
      { type: "POC", value: profile.poc, note: `${profile.sessions}-session volume point of control` },
      { type: "VWAP", value: profile.vwap, note: `${profile.sessions}-session volume-weighted average` },
    ];
    const far = side === "above" ? Math.max(profile.poc, profile.vwap) : Math.min(profile.poc, profile.vwap);
    const nearer = side === "above" ? Math.min(profile.poc, profile.vwap) : Math.max(profile.poc, profile.vwap);
    const pickV = before2(far) ? far : before2(nearer) ? nearer : null;
    if (pickV !== null) {
      // only the level actually used is a component (audit 21-Nov-2026: the POC 25225, beyond step 2,
      // was listed inside the warning at 25403); the other is named as skipped
      const used = comps.filter((c) => Number(c.value) === Number(pickV));
      const skipped = comps.filter((c) => Number(c.value) !== Number(pickV));
      const usedComps = used.length ? used : comps;
      // only when the FAR level was skipped is it "beyond" the next step; when the far level is the
      // warning, the nearer one simply sits between the close and it (review 21-Nov-2026)
      const skipTxt = used.length && skipped.length && Number(far) !== Number(nearer) && Number(pickV) === Number(nearer)
        ? `; ${skipped.map(fmtC).join(", ")} lies beyond step ${s2pre?.key === "FLIPPED" ? 3 : 2}`
        : "";
      warning = {
        key: "WARNING",
        value: r2(pickV),
        zone: { low: r2(Math.min(profile.poc, profile.vwap)), high: r2(Math.max(profile.poc, profile.vwap)) },
        components: usedComps,
        skipped: skipTxt ? skipped : [],
        status: "NOT_REACHED",
        basis: `a daily close ${side} the volume centre ${f0(pickV)} (${usedComps.map(fmtC).join(", ")}${skipTxt})`,
      };
      // A zone that straddles step 2 would be breached (far edge) only after step 2: clip it to the level.
      if (s2pre) warning.zone = { low: r2(pickV), high: r2(pickV) };
    } else if (!beyond(far) && !beyond(nearer)) {
      warningNote = `the close is already ${side === "above" ? "above" : "below"} the volume centre`;
    } else {
      warningNote = `the volume centre lies beyond step ${s2pre?.key === "FLIPPED" ? 3 : 2}`;
    }
  }
  if (!warning && nearWall && before2(nearWall.strike)) {
    warning = { key: "WARNING", value: Number(nearWall.strike), zone: { low: Number(nearWall.strike), high: Number(nearWall.strike) }, components: [wallComp()], status: "NOT_REACHED", basis: `a daily close ${side} ${f0(nearWall.strike)} (${wallComp().note})` };
    if (warningNote) warningNote += "; the near-money OI wall is used instead";
  }
  if (warning) steps.unshift(warning);
  for (const st of steps) st.distance = r2(Math.abs(st.value - close));
  return { side, steps, warningNote };
}

/** The ladder(s) for a regime: one side for a trend / break view, both sides for a range. Never throws. */
export function computeInvalidationLadder({ ds, last, chain, regime }) {
  try {
    if (!hasSpotBar(last)) return null;
    const close = Number(last.spot.close);
    const straddle = chain && Number(chain.straddle) > 0 ? Number(chain.straddle) : null;
    const tol = Math.max(25, straddle ? 0.15 * straddle : 0);
    const profile = combineProfiles(ds.slice(-LADDER_PROFILE_SESSIONS).map((d) => d.volProfile).filter(Boolean));
    const swing = confirmedSwings(ds);
    const expectedRange = straddle
      ? { low: Number(chain.expectedRange?.low ?? chain.spot - straddle), high: Number(chain.expectedRange?.high ?? chain.spot + straddle) }
      : null;
    const prevDay = { date: last.date, high: Number(last.spot.high), low: Number(last.spot.low) };
    const common = { close, prevDay, swing, profile, expectedRange, tol };
    const up = () => buildLadder({ ...common, side: "above", nearWall: chain?.nearCallWall || null });
    const dn = () => buildLadder({ ...common, side: "below", nearWall: chain?.nearPutWall || null });
    const inputs = {
      close, tolerance: r2(tol), profile, swingHigh: swing.hi, swingLow: swing.lo,
      nearCallWall: chain?.nearCallWall || null, nearPutWall: chain?.nearPutWall || null,
      nearWallsRecorded: Boolean(chain && ("nearCallWall" in chain || "nearPutWall" in chain)),
    };
    // Volume reference (owner 2026-11-21: keep the POC / VWAP commentary visible even when the volume
    // centre is not a ladder step).
    const fmtIn = (v) => Math.round(Number(v)).toLocaleString("en-IN");
    const volumeReference = profile
      ? {
          poc: profile.poc, vwap: profile.vwap, vah: profile.vah, val: profile.val, sessions: profile.sessions,
          text: `${profile.sessions}-session volume point of control ${fmtIn(profile.poc)} · ${profile.sessions}-session volume-weighted average ${fmtIn(profile.vwap)}`,
          valueArea: `value area ${fmtIn(profile.val)}–${fmtIn(profile.vah)}`,
          closeVsVwap: r2(close - profile.vwap),
        }
      : null;
    if (regime === "TREND_DOWN" || regime === "BREAK_RISK_DOWN") return { view: "BEARISH", ladders: [up()], inputs, volumeReference };
    if (regime === "TREND_UP" || regime === "BREAK_RISK_UP") return { view: "BULLISH", ladders: [dn()], inputs, volumeReference };
    if (regime === "RANGE") return { view: "RANGE", ladders: [up(), dn()], inputs, volumeReference };
    return null;
  } catch (e) {
    return null;
  }
}

/** First later daily close beyond each step of a stored outlook's ladder (within its horizon). */
export function ladderBreaches(ladder, laterDays) {
  if (!ladder?.ladders) return null;
  return ladder.ladders.map((l) => ({
    side: l.side,
    steps: l.steps.map((st) => {
      const far = l.side === "above" ? st.zone.high : st.zone.low;
      const hit = laterDays.find((d) => hasSpotBar(d) && (l.side === "above" ? Number(d.spot.close) > far : Number(d.spot.close) < far));
      return { key: st.key, level: far, breachedOn: hit ? hit.date : null, close: hit ? Number(hit.spot.close) : null };
    }),
  }));
}

function emptyGroup(needs) {
  return { available: false, score: null, reasons: [], needs, inputs: {} };
}

/**
 * The Weekly Outlook from ascending daily summaries. Never throws; well-formed for 0..n days.
 */
export function computeWeeklyOutlook({ days = [], config = null } = {}) {
  const cfg = config || getOutlookConfig({});
  try {
    const ds = cleanDays(days);
    const last = ds[ds.length - 1] || null;
    const notes = [];
    const reference = { spotClose: hasSpotBar(last) ? Number(last.spot.close) : null, futClose: last?.fut && Number(last.fut.close) > 0 ? Number(last.fut.close) : null };
    const horizon = chooseHorizon(last, cfg);
    if (horizon.fallback) notes.push(horizon.basis);
    const chain = horizon.chain;
    const expectedRange = chain && Number(chain.straddle) > 0
      ? { low: chain.expectedRange?.low ?? r2(chain.spot - chain.straddle), high: chain.expectedRange?.high ?? r2(chain.spot + chain.straddle), straddle: chain.straddle, pctOfSpot: chain.spot > 0 ? r2((chain.straddle / chain.spot) * 100) : null, expiry: chain.expiry || null }
      : null;

    const price = priceGroup(ds, cfg);
    const futures = futuresGroup(ds, cfg);
    const options = optionsGroup(ds, horizon, reference.spotClose, cfg);
    const volatility = volatilityGroup(ds, horizon, cfg);
    const directional = [price, futures, options].filter((g) => g.available);
    const score = directional.reduce((a, g) => a + g.score, 0);
    const pos = directional.filter((g) => g.score > 0).length;
    const neg = directional.filter((g) => g.score < 0).length;

    let regime = "INSUFFICIENT_DATA";
    let breakInfo = null;
    const enoughDays = ds.length >= cfg.minDaysForRegime;
    if (directional.length && enoughDays) {
      if (score >= cfg.trendScore && pos >= 2 && neg === 0) regime = "TREND_UP";
      else if (score <= -cfg.trendScore && neg >= 2 && pos === 0) regime = "TREND_DOWN";
      else {
        const s = reference.spotClose;
        const st = chain ? Number(chain.straddle) : null;
        const mig = options.migration;
        if (isFin(s) && st > 0) {
          const near = cfg.breakProximityStraddleFrac * st;
          const cw = isFin(chain.callWall) ? Number(chain.callWall) : null;
          const pw = isFin(chain.putWall) ? Number(chain.putWall) : null;
          const upNear = cw !== null && s >= cw - near;
          const dnNear = pw !== null && s <= pw + near;
          const expanding = volatility.state === "EXPANDING";
          const upOk = upNear && (expanding || (mig && mig.dCall > 0));
          const dnOk = dnNear && (expanding || (mig && mig.dPut < 0));
          if (upOk && dnOk) regime = Math.abs(cw - s) <= Math.abs(s - pw) ? "BREAK_RISK_UP" : "BREAK_RISK_DOWN";
          else if (upOk) regime = "BREAK_RISK_UP";
          else if (dnOk) regime = "BREAK_RISK_DOWN";
          if (regime.startsWith("BREAK_RISK")) {
            const up = regime === "BREAK_RISK_UP";
            breakInfo = { wall: up ? cw : pw, distance: r2(up ? cw - s : s - pw), proximity: r2(near), expanding, wallMigrated: up ? Boolean(mig && mig.dCall > 0) : Boolean(mig && mig.dPut < 0) };
          }
        }
        if (regime === "INSUFFICIENT_DATA") regime = "RANGE";
      }
    }

    let confidence = "LOW";
    if (regime === "TREND_UP" || regime === "TREND_DOWN") confidence = Math.abs(score) >= cfg.highConfidenceScore ? "HIGH" : "MEDIUM";
    else if (regime.startsWith("BREAK_RISK")) confidence = breakInfo?.expanding && breakInfo?.wallMigrated ? "HIGH" : "MEDIUM";
    else if (regime === "RANGE") confidence = Math.abs(score) <= 1 && volatility.state !== "EXPANDING" ? (volatility.available ? "HIGH" : "MEDIUM") : "MEDIUM";
    const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 };
    const cap = directional.length >= 3 ? "HIGH" : directional.length === 2 ? "MEDIUM" : "LOW";
    if (rank[confidence] > rank[cap]) confidence = cap;
    if (last?.partial) {
      confidence = "LOW";
      notes.push(`The last session (${last.date}) is partial${last.source === "scorecard-series" ? " (derived from the scorecard series, no option chain)" : ""}; confidence is LOW.`);
    }

    const wl = weekLevels(ds, last, cfg);
    const callWall = chain && isFin(chain.callWall) ? Number(chain.callWall) : null;
    const putWall = chain && isFin(chain.putWall) ? Number(chain.putWall) : null;
    let invalidation = { value: null, side: null, basis: "no regime yet" };
    const ladder = computeInvalidationLadder({ ds, last, chain, regime });
    const ladderStep = (l) => l?.steps.find((x) => x.key === "INVALIDATED") || l?.steps.find((x) => x.key === "FLIPPED") || null;
    if (ladder && ladder.view !== "RANGE" && ladderStep(ladder.ladders[0])) {
      const stp = ladderStep(ladder.ladders[0]);
      invalidation = { value: stp.value, side: ladder.ladders[0].side, basis: stp.basis, source: "ladder", step: stp.key };
    } else if (regime === "TREND_UP" || regime === "BREAK_RISK_UP") {
      invalidation = putWall !== null
        ? { value: putWall, side: "below", basis: `a daily close below the put wall ${putWall}` }
        : expectedRange ? { value: expectedRange.low, side: "below", basis: `a daily close below the expected-range low ${f0(expectedRange.low)} (no put wall)` } : { value: null, side: "below", basis: "no put wall or expected range recorded" };
    } else if (regime === "TREND_DOWN" || regime === "BREAK_RISK_DOWN") {
      invalidation = callWall !== null
        ? { value: callWall, side: "above", basis: `a daily close above the call wall ${callWall}` }
        : expectedRange ? { value: expectedRange.high, side: "above", basis: `a daily close above the expected-range high ${f0(expectedRange.high)} (no call wall)` } : { value: null, side: "above", basis: "no call wall or expected range recorded" };
    } else if (regime === "RANGE") {
      invalidation = { value: null, side: "outside", basis: expectedRange ? `a daily close outside the expected range ${f0(expectedRange.low)}–${f0(expectedRange.high)}` : "a daily close outside the expected range (no expected range recorded)" };
    }
    const levels = {
      pivot: wl.pivot,
      callWall,
      putWall,
      prevDayHigh: hasSpotBar(last) ? Number(last.spot.high) : null,
      prevDayLow: hasSpotBar(last) ? Number(last.spot.low) : null,
      prevDayDate: last?.date ?? null,
      prevWeekHigh: wl.prevWeek?.high ?? null,
      prevWeekLow: wl.prevWeek?.low ?? null,
      prevWeek: wl.prevWeek,
      invalidation,
      ladder,
    };

    const setups = computeSetups({ regime, last, chain, setupChain: last?.chains?.setup || null, levels, volatility, ds, cfg: cfg.setup });
    const exp = horizon.expiry || "the next expiry";
    const rangeTxt = expectedRange ? `${f0(expectedRange.low)}–${f0(expectedRange.high)}` : null;
    const sc = `${score > 0 ? "+" : ""}${score}`;
    let headline;
    if (regime === "INSUFFICIENT_DATA") {
      headline = `Not enough history yet (${plural(ds.length, "session")} recorded; a regime needs ${cfg.minDaysForRegime} sessions and one available group)${rangeTxt ? `; options price a range of ${rangeTxt} to ${exp}` : ""}.`;
    } else if (regime === "TREND_UP") headline = `Uptrend favoured into ${exp} (score ${sc}, no group against); invalidated by ${invalidation.basis}.`;
    else if (regime === "TREND_DOWN") headline = `Downtrend favoured into ${exp} (score ${sc}, no group against); invalidated by ${invalidation.basis}.`;
    else if (regime === "BREAK_RISK_UP") headline = `Upside break risk: close ${f0(reference.spotClose)} is pressing the call wall ${callWall} with ${breakInfo?.expanding ? "expanding realised moves" : "the call wall moving up"}.`;
    else if (regime === "BREAK_RISK_DOWN") headline = `Downside break risk: close ${f0(reference.spotClose)} is pressing the put wall ${putWall} with ${breakInfo?.expanding ? "expanding realised moves" : "the put wall moving down"}.`;
    else headline = rangeTxt ? `Range favoured into ${exp} between ${rangeTxt} (score ${sc}).` : `Range favoured (score ${sc}); no expected range recorded.`;

    const detail = [];
    for (const [name, g] of [["Price", price], ["Futures", futures], ["Options", options], ["Volatility", volatility]]) {
      for (const r of g.reasons) detail.push(`${name}: ${r}`);
    }
    if (!enoughDays && directional.length) notes.push(`A regime is called from ${cfg.minDaysForRegime} recorded sessions; ${ds.length} so far.`);
    const scoreless = (g) => ({ available: g.available, score: g.score, reasons: g.reasons, needs: g.needs, inputs: g.inputs });
    return {
      v: OUTLOOK_VERSION,
      shadow: true,
      asOf: last?.date ?? null,
      reference,
      horizon: { expiry: horizon.expiry, dte: horizon.dte, sessionsLeft: horizon.sessionsLeft ?? null, closedDaysLeft: horizon.closedDaysLeft ?? null, basis: horizon.basis, chain: horizon.key },
      setups,
      expectedRange,
      levels,
      groups: {
        price: scoreless(price),
        futures: scoreless(futures),
        options: scoreless(options),
        volatility: { available: volatility.available, state: volatility.state, score: null, reasons: volatility.reasons, needs: volatility.needs, inputs: volatility.inputs },
      },
      score,
      directionalGroupsAvailable: directional.length,
      regime,
      breakInfo,
      confidence,
      headline,
      detail,
      daysUsed: ds.length,
      partialDays: ds.filter((d) => d.partial).map((d) => d.date),
      config: cfg,
      notes,
    };
  } catch (e) {
    return {
      v: OUTLOOK_VERSION, shadow: true, asOf: null, reference: { spotClose: null, futClose: null },
      horizon: { expiry: null, dte: null, basis: "error", chain: null }, expectedRange: null,
      levels: { pivot: { value: null, basis: "error" }, callWall: null, putWall: null, prevDayHigh: null, prevDayLow: null, prevDayDate: null, prevWeekHigh: null, prevWeekLow: null, prevWeek: null, invalidation: { value: null, side: null, basis: "no regime yet" } },
      groups: { price: emptyGroup(null), futures: emptyGroup(null), options: emptyGroup(null), volatility: { ...emptyGroup(null), state: null } },
      score: 0, directionalGroupsAvailable: 0, regime: "INSUFFICIENT_DATA", breakInfo: null, confidence: "LOW",
      headline: "Outlook could not be computed.", detail: [], daysUsed: 0, partialDays: [], config: cfg, notes: [`error: ${e?.message || e}`],
    };
  }
}

/**
 * Measures a stored outlook against the sessions recorded after it. Pure; never throws.
 */
export function evaluateOutlookOutcome({ outlook, laterDays = [] } = {}) {
  const base = { status: "PENDING", horizonDate: null, hit: null, closeAtHorizon: null, maxClose: null, minClose: null, movePct: null, rule: null, reason: "" };
  try {
    if (!outlook || !outlook.asOf) return { ...base, reason: "no outlook" };
    const regime = outlook.regime;
    const rule = OUTLOOK_HIT_RULES[regime] || "Not measured.";
    // Not a measurement: say so (it was reported as "MEASURED" with a null hit). The tally never counted it.
    if (regime === "INSUFFICIENT_DATA" || !OUTLOOK_HIT_RULES[regime]) return { ...base, status: "NOT_MEASURED", rule, reason: "INSUFFICIENT_DATA outlooks are not measured." };
    const later = cleanDays(laterDays).filter((d) => d.date > outlook.asOf && hasSpotBar(d));
    const expIso = expiryToIso(outlook.horizon?.expiry || outlook.expectedRange?.expiry);
    const idxExp = expIso ? later.findIndex((d) => d.date >= expIso) : -1;
    const idx5 = later.length >= 5 ? 4 : -1;
    const cands = [idxExp, idx5].filter((i) => i >= 0);
    if (!cands.length) {
      return { ...base, rule, ladderBreaches: ladderBreaches(outlook.levels?.ladder, later), reason: `${plural(later.length, "later session")} recorded; waiting for ${expIso ? `the first session on/after ${expIso} or ` : ""}the 5th later session.` };
    }
    const h = Math.min(...cands);
    const win = later.slice(0, h + 1);
    const closes = win.map((d) => Number(d.spot.close));
    const closeAtHorizon = closes[closes.length - 1];
    const ref = Number(outlook.reference?.spotClose);
    const out = {
      ...base,
      status: "MEASURED",
      horizonDate: win[win.length - 1].date,
      horizonBasis: h === idxExp ? "expiry" : "5th session",
      closeAtHorizon,
      maxClose: Math.max(...closes),
      minClose: Math.min(...closes),
      movePct: ref > 0 ? r2(((closeAtHorizon - ref) / ref) * 100) : null,
      rule,
      ladderBreaches: ladderBreaches(outlook.levels?.ladder, win),
    };
    const er = outlook.expectedRange;
    if (regime === "TREND_UP" || regime === "TREND_DOWN") {
      if (!(ref > 0)) return { ...out, reason: "no reference close; not measured" };
      out.hit = regime === "TREND_UP" ? closeAtHorizon > ref : closeAtHorizon < ref;
      out.reason = `Close ${f0(closeAtHorizon)} on ${out.horizonDate} vs reference ${f0(ref)}.`;
    } else if (regime === "RANGE") {
      if (!er || !isFin(er.low) || !isFin(er.high)) return { ...out, reason: "no expected range; not measured" };
      out.hit = closes.every((c) => c >= er.low && c <= er.high);
      out.reason = `Closes ${f0(out.minClose)}–${f0(out.maxClose)} vs expected range ${f0(er.low)}–${f0(er.high)}.`;
    } else if (regime === "BREAK_RISK_UP") {
      if (!er || !isFin(er.high)) return { ...out, reason: "no expected range; not measured" };
      out.hit = closes.some((c) => c > er.high);
      out.reason = `Highest close ${f0(out.maxClose)} vs expected-range high ${f0(er.high)}.`;
    } else if (regime === "BREAK_RISK_DOWN") {
      if (!er || !isFin(er.low)) return { ...out, reason: "no expected range; not measured" };
      out.hit = closes.some((c) => c < er.low);
      out.reason = `Lowest close ${f0(out.minClose)} vs expected-range low ${f0(er.low)}.`;
    }
    return out;
  } catch (e) {
    return { ...base, reason: `evaluation failed: ${e?.message || e}` };
  }
}
