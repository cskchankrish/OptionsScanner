/**
 * Weekly Outlook option setups (SHADOW — display and measurement only, never traded, not advice).
 *
 * Owner idea (2026-11-21): buy longer-dated (about 2 months, e.g. the January monthly) OTM calls
 * near put-wall support, or puts near call-wall resistance. This module turns that into a rule that
 * can be measured:
 *
 *   zone    the nearest support (call side) / resistance (put side): the near-money put / call OI wall
 *           of the outlook expiry, merged with recorded price and volume levels within the ladder
 *           tolerance max(25 pts, 0.15 × straddle); the previous day's low / high when there is no wall
 *   stop    a daily close beyond the next recorded structure past the zone (swing, previous week,
 *           previous day, volume levels, whole-chain wall); half a straddle past the zone otherwise
 *   target  T1 = the opposite near-money wall of the outlook expiry (whole-chain wall, then the
 *           expected-range edge when missing); T2 = the setup chain's own wall when farther
 *   regime  calls are blocked in TREND_DOWN / BREAK_RISK_DOWN, puts in TREND_UP / BREAK_RISK_UP, both
 *           without a regime. Fading a trend at its wall is the case this rule refuses.
 *   option  the setup expiry's strike nearest the target delta (Black–Scholes on the chain's own IV),
 *           with estimated premiums at the planned entry, at T1 and at the stop after `holdDays`
 *
 * A setup TRIGGERS when it is allowed, its reward:risk to T1 is at least `minRr` and the close is
 * inside the zone (up to one tolerance on the near side). evaluateSetupOutcome measures a triggered
 * setup against later sessions: T1 touched (day high / low) or a daily close beyond the stop, within
 * `horizonSessions`, plus the real option premium recorded on the exit day when the setup chain was
 * captured. Pure; never throws. See docs/weekly-outlook.md.
 */

const isFin = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const r2 = (n) => Math.round(n * 100) / 100;
const f0 = (n) => (isFin(n) ? Math.round(Number(n)).toLocaleString("en-IN") : "—");

const num = (v, d) => {
  const n = Number(v);
  return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : d;
};

export function getSetupConfig(env = {}) {
  const e = env || {};
  return {
    minRr: num(e.SWING_SETUP_MIN_RR, 1.5),
    targetDelta: num(e.SWING_SETUP_TARGET_DELTA, 0.375),
    minDelta: num(e.SWING_SETUP_MIN_DELTA, 0.25),
    maxDelta: num(e.SWING_SETUP_MAX_DELTA, 0.5),
    holdDays: num(e.SWING_SETUP_HOLD_DAYS, 10), // calendar days assumed held when estimating premiums
    horizonSessions: Math.round(num(e.SWING_SETUP_HORIZON_SESSIONS, 15)),
    rate: num(e.SWING_SETUP_RATE, 0.065), // annual, continuous
    minDte: Math.round(num(e.SWING_SETUP_MIN_DTE, 45)), // setup expiry: first monthly with ≥ this many days
  };
}

// ── Black–Scholes (no dividends; r continuous). Normal CDF: Abramowitz–Stegun 7.1.26 (|ε| < 1.5e-7).
function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Black–Scholes price and delta. type "CE" | "PE"; tYears > 0; iv as a fraction (0.15). null when unusable. */
export function bs({ type, S, K, tYears, iv, r = 0.065 }) {
  if (!(S > 0) || !(K > 0) || !(iv > 0)) return null;
  const T = Math.max(tYears, 1 / 365 / 4);
  const sd = iv * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (iv * iv) / 2) * T) / sd;
  const d2 = d1 - sd;
  const df = Math.exp(-r * T);
  if (type === "CE") return { price: S * ncdf(d1) - K * df * ncdf(d2), delta: ncdf(d1) };
  return { price: K * df * ncdf(-d2) - S * ncdf(-d1), delta: ncdf(d1) - 1 };
}

/** Picks the strike nearest the target |delta| from a setup chain summary's strike list. */
export function pickStrike({ setupChain, type, cfg }) {
  const rows = Array.isArray(setupChain?.strikes) ? setupChain.strikes : [];
  const S = Number(setupChain?.spot);
  const dte = Number(setupChain?.dte);
  if (!rows.length || !(S > 0) || !(dte > 0)) return null;
  const atmIv = Number(setupChain?.atmIv?.[type === "CE" ? "ce" : "pe"]) || Number(setupChain?.atmIv?.ce) || Number(setupChain?.atmIv?.pe) || null;
  const T = dte / 365;
  let best = null;
  for (const row of rows) {
    const ltp = Number(type === "CE" ? row.ce : row.pe);
    if (!(ltp > 0)) continue;
    const ownIv = Number(type === "CE" ? row.ceIv : row.peIv);
    const ivPct = ownIv > 0 ? ownIv : atmIv;
    if (!(ivPct > 0)) continue;
    const m = bs({ type, S, K: Number(row.k), tYears: T, iv: ivPct / 100, r: cfg.rate });
    if (!m) continue;
    const ad = Math.abs(m.delta);
    // OTM side only (the owner's idea), inside the delta band
    if (type === "CE" ? Number(row.k) < S : Number(row.k) > S) continue;
    if (ad < cfg.minDelta || ad > cfg.maxDelta) continue;
    const score = Math.abs(ad - cfg.targetDelta);
    if (!best || score < best.score) best = { score, strike: Number(row.k), ltp, ivPct: r2(ivPct), ivSource: ownIv > 0 ? "strike" : "atm", delta: r2(m.delta), oi: Number(type === "CE" ? row.ceOi : row.peOi) || null };
  }
  if (!best) return null;
  const { score, ...rest } = best;
  return rest;
}

function levelCandidates(levels, ladder) {
  const inp = ladder?.inputs || {};
  const vr = ladder?.volumeReference || inp.profile || null;
  const out = [];
  const add = (type, value, note) => { if (isFin(value) && Number(value) > 0) out.push({ type, value: Number(value), note }); };
  add("PREV_DAY_LOW", levels?.prevDayLow, `${levels?.prevDayDate || "previous day"} low`);
  add("PREV_DAY_HIGH", levels?.prevDayHigh, `${levels?.prevDayDate || "previous day"} high`);
  add("PREV_WEEK_LOW", levels?.prevWeekLow, "previous week low");
  add("PREV_WEEK_HIGH", levels?.prevWeekHigh, "previous week high");
  if (inp.swingLow) add("SWING_LOW", inp.swingLow.value, `swing low (${inp.swingLow.date})`);
  if (inp.swingHigh) add("SWING_HIGH", inp.swingHigh.value, `swing high (${inp.swingHigh.date})`);
  if (vr) {
    add("POC", vr.poc, `${vr.sessions}-session volume point of control`);
    add("VWAP", vr.vwap, `${vr.sessions}-session volume-weighted average`);
    add("VALUE_AREA_LOW", vr.val, `${vr.sessions}-session value-area low`);
    add("VALUE_AREA_HIGH", vr.vah, `${vr.sessions}-session value-area high`);
  }
  return out;
}

const CALL_BLOCK = new Set(["TREND_DOWN", "BREAK_RISK_DOWN", "INSUFFICIENT_DATA"]);
const PUT_BLOCK = new Set(["TREND_UP", "BREAK_RISK_UP", "INSUFFICIENT_DATA"]);

function oneSide({ type, regime, close, chain, setupChain, levels, ladder, cfg, asOf }) {
  const call = type === "CE";
  const side = call ? "CALL" : "PUT";
  const straddle = Number(chain?.straddle) > 0 ? Number(chain.straddle) : null;
  const tol = Math.max(25, straddle ? 0.15 * straddle : 0);
  const res = { side, type, allowed: false, status: "NO_DATA", triggered: false, reasons: [] };
  if (!(close > 0) || !chain) {
    res.reasons.push("Needs a recorded close and the outlook expiry's option chain.");
    return res;
  }
  const blocked = (call ? CALL_BLOCK : PUT_BLOCK).has(regime);
  res.allowed = !blocked;
  // below the close for calls (support), above for puts (resistance)
  const onSide = (v) => (call ? v < close : v > close);
  const cands = levelCandidates(levels, ladder).filter((c) => onSide(c.value));
  const wall = call ? chain.nearPutWall : chain.nearCallWall;
  // The zone needs a real option wall: a previous-day extreme alone is not support / resistance
  // (simulated on 20-Nov-2026: the put side "triggered" at the day's high after a 430-pt rally).
  if (wall && isFin(wall.strike) && !onSide(Number(wall.strike)) && Number(wall.strike) !== close) {
    res.status = blocked ? "BLOCKED" : "BROKEN";
    res.zone = { low: Number(wall.strike), high: Number(wall.strike) };
    res.reasons.push(`The close ${f0(close)} is already ${call ? "below the put" : "above the call"} wall ${f0(wall.strike)}.`);
    return res;
  }
  if (!(wall && isFin(wall.strike) && onSide(Number(wall.strike)))) {
    res.status = blocked ? "BLOCKED" : "NO_DATA";
    res.reasons.push(`No near-money ${call ? "put" : "call"} OI wall ${call ? "below" : "above"} the close in the outlook expiry's chain${"nearPutWall" in chain || "nearCallWall" in chain ? "" : " (recorded from the 19-Nov-2026 capture on)"}.`);
    return res;
  }
  const anchor = { type: call ? "NEAR_PUT_WALL" : "NEAR_CALL_WALL", value: Number(wall.strike), note: `largest near-money ${call ? "put" : "call"} OI (${Math.round(Number(wall.oi || 0) / 1000)}k)` };
  const merged = [anchor, ...cands.filter((c) => c.value !== anchor.value && Math.abs(c.value - anchor.value) <= tol)];
  const vals = merged.map((c) => c.value);
  const zone = { low: r2(Math.min(...vals)), high: r2(Math.max(...vals)) };
  // stop: the next structure past the zone (nearest one beyond it by more than a tolerance)
  const past = (v) => (call ? v < zone.low - tol : v > zone.high + tol);
  const stopCands = cands.filter((c) => past(c.value));
  const cw = isFin(chain.callWall) ? Number(chain.callWall) : null;
  const pw = isFin(chain.putWall) ? Number(chain.putWall) : null;
  if (call && pw !== null && past(pw)) stopCands.push({ type: "PUT_WALL", value: pw, note: "whole-chain put wall" });
  if (!call && cw !== null && past(cw)) stopCands.push({ type: "CALL_WALL", value: cw, note: "whole-chain call wall" });
  stopCands.sort((a, b) => (call ? b.value - a.value : a.value - b.value));
  const stop = stopCands[0]
    ? { value: r2(stopCands[0].value), basis: `a daily close ${call ? "below" : "above"} ${f0(stopCands[0].value)} (${stopCands[0].note})` }
    : straddle
      ? { value: r2(call ? zone.low - 0.5 * straddle : zone.high + 0.5 * straddle), basis: `a daily close ${call ? "below" : "above"} ${f0(call ? zone.low - 0.5 * straddle : zone.high + 0.5 * straddle)} (half a straddle past the zone; no recorded structure beyond it)` }
      : null;
  // targets
  const opp = call ? chain.nearCallWall : chain.nearPutWall;
  const beyondClose = (v) => (call ? v > close : v < close);
  // T1: the opposite near-money wall; without one, the NEARER of the whole-chain wall and the
  // expected-range edge (the whole-chain wall alone sits on far hedge strikes and inflates R:R).
  let t1 = null;
  if (opp && isFin(opp.strike) && beyondClose(Number(opp.strike))) t1 = { value: Number(opp.strike), note: `largest near-money ${call ? "call" : "put"} OI` };
  else {
    const alt = [];
    const wv = call ? cw : pw;
    if (wv !== null && beyondClose(wv)) alt.push({ value: wv, note: `whole-chain ${call ? "call" : "put"} wall` });
    const ev = chain.expectedRange ? Number(call ? chain.expectedRange.high : chain.expectedRange.low) : NaN;
    if (Number.isFinite(ev) && beyondClose(ev)) alt.push({ value: ev, note: `expected-range ${call ? "high" : "low"}` });
    alt.sort((a, b) => Math.abs(a.value - close) - Math.abs(b.value - close));
    t1 = alt[0] || null;
  }
  const sw = setupChain ? Number(call ? setupChain.callWall : setupChain.putWall) : NaN;
  const t2 = t1 && Number.isFinite(sw) && (call ? sw > t1.value : sw < t1.value) ? { value: sw, note: `${setupChain.expiry} ${call ? "call" : "put"} wall` } : null;

  // status
  const inZone = call ? close >= zone.low && close <= zone.high + tol : close <= zone.high && close >= zone.low - tol;
  const broken = call ? close < zone.low : close > zone.high;
  const entry = inZone ? close : call ? zone.high : zone.low;
  const reward = t1 ? (call ? t1.value - entry : entry - t1.value) : null;
  const risk = stop ? (call ? entry - stop.value : stop.value - entry) : null;
  const rr = reward !== null && risk > 0 ? r2(reward / risk) : null;
  const rrOk = rr !== null && rr >= cfg.minRr;
  res.zone = zone;
  res.zoneComponents = merged;
  res.distance = r2(call ? close - zone.high : zone.low - close);
  res.entrySpot = r2(entry);
  res.stop = stop;
  res.target = t1 ? { value: r2(t1.value), note: t1.note } : null;
  res.target2 = t2 ? { value: r2(t2.value), note: t2.note } : null;
  res.rewardPts = reward !== null ? r2(reward) : null;
  res.riskPts = risk !== null ? r2(risk) : null;
  res.rr = rr;
  res.rrOk = rrOk;
  if (blocked) {
    res.status = "BLOCKED";
    res.reasons.push(regime === "INSUFFICIENT_DATA" ? "No regime yet." : `Regime ${regime}: ${call ? "buying calls against a down view" : "buying puts against an up view"} is not allowed.`);
  } else if (broken && !inZone) {
    res.status = "BROKEN";
    res.reasons.push(`The close ${f0(close)} is already ${call ? "below" : "above"} the zone.`);
  } else if (inZone) {
    res.status = "IN_ZONE";
  } else {
    res.status = "WAITING";
  }
  if (rr !== null && !rrOk) res.reasons.push(`Reward:risk ${rr} to T1 is below ${cfg.minRr}.`);
  if (!stop) res.reasons.push("No stop level could be set.");
  res.triggered = res.allowed && res.status === "IN_ZONE" && rrOk;

  // option on the setup expiry
  if (setupChain && setupChain.expiry) {
    const pick = pickStrike({ setupChain, type, cfg });
    if (pick) {
      const iv = pick.ivPct / 100;
      const T = Number(setupChain.dte) / 365;
      const Th = Math.max(Number(setupChain.dte) - cfg.holdDays, 1) / 365;
      const val = (S, t) => {
        const m = bs({ type, S, K: pick.strike, tYears: t, iv, r: cfg.rate });
        return m ? r2(m.price) : null;
      };
      const atEntry = inZone ? pick.ltp : val(entry, T);
      const atT1 = res.target ? val(res.target.value, Th) : null;
      const atStop = stop ? val(stop.value, Th) : null;
      res.option = {
        expiry: setupChain.expiry, dte: Number(setupChain.dte), strike: pick.strike, type, ltp: pick.ltp, ivPct: pick.ivPct, ivSource: pick.ivSource, delta: pick.delta, oi: pick.oi,
        estAtEntry: atEntry, estAtTarget: atT1, estAtStop: atStop, holdDays: cfg.holdDays,
        estRr: atEntry && atT1 !== null && atStop !== null && atEntry - atStop > 0 ? r2((atT1 - atEntry) / (atEntry - atStop)) : null,
        asOf,
      };
    } else {
      res.option = null;
      res.reasons.push(`No ${setupChain.expiry} ${type} strike with |delta| ${cfg.minDelta}–${cfg.maxDelta} and a price recorded.`);
    }
  } else {
    res.option = null;
    res.reasons.push("The setup expiry's chain (about 2 months out) is recorded from the next daily capture.");
  }
  return res;
}

/** Both sides for the latest session. Never throws. */
export function computeSetups({ regime, last, chain, setupChain, levels, volatility, cfg } = {}) {
  const c = cfg || getSetupConfig({});
  try {
    const close = Number(last?.spot?.close);
    const ladder = levels?.ladder || null;
    const asOf = last?.date || null;
    const call = oneSide({ type: "CE", regime, close, chain, setupChain, levels, ladder, cfg: c, asOf });
    const put = oneSide({ type: "PE", regime, close, chain, setupChain, levels, ladder, cfg: c, asOf });
    const rich = volatility?.state === "COMPRESSED";
    return {
      shadow: true,
      asOf,
      setupExpiry: setupChain?.expiry || null,
      premium: volatility?.available ? { state: volatility.state, rich, note: rich ? "Options price bigger moves than the market has been making: premium is expensive to buy." : volatility.state === "EXPANDING" ? "The market is moving more than options price in: premium is cheap relative to realised moves." : "Implied and realised moves are in line." } : null,
      call,
      put,
      rules: { minRr: c.minRr, targetDelta: c.targetDelta, deltaBand: [c.minDelta, c.maxDelta], holdDays: c.holdDays, horizonSessions: c.horizonSessions },
    };
  } catch (e) {
    return { shadow: true, asOf: last?.date || null, error: String(e?.message || e), call: null, put: null };
  }
}

function strikePrice(day, expiry, strike, type) {
  const sc = day?.chains?.setup;
  if (!sc || !expiry || String(sc.expiry).toLowerCase() !== String(expiry).toLowerCase() || !Array.isArray(sc.strikes)) return null;
  const row = sc.strikes.find((x) => Number(x.k) === Number(strike));
  const p = row ? Number(type === "CE" ? row.ce : row.pe) : NaN;
  return p > 0 ? p : null;
}

/**
 * Measures one triggered setup side against later recorded sessions (ascending, after asOf).
 * TARGET: a later day's high (call) / low (put) reaches T1. STOP: a daily close beyond the stop.
 * Same day both: STOP (conservative). OPEN while within the horizon, EXPIRED after it.
 */
export function evaluateSetupOutcome({ setup, asOf, laterDays = [], cfg } = {}) {
  const c = cfg || getSetupConfig({});
  const base = { status: "NOT_TRIGGERED", exitDate: null, exitSpot: null, sessions: 0, optionEntry: null, optionExit: null, optionPnlPct: null };
  try {
    if (!setup || !setup.triggered || !setup.target || !setup.stop) return base;
    const call = setup.type === "CE";
    const later = (Array.isArray(laterDays) ? laterDays : [])
      .filter((d) => d && d.date > asOf && d.spot && isFin(d.spot.close))
      .sort((a, b) => (a.date < b.date ? -1 : 1))
      .slice(0, c.horizonSessions);
    const opt = setup.option || null;
    const out = { ...base, status: "OPEN", optionEntry: opt ? opt.ltp : null };
    for (let i = 0; i < later.length; i++) {
      const d = later[i];
      const stopHit = call ? Number(d.spot.close) < setup.stop.value : Number(d.spot.close) > setup.stop.value;
      const tgtHit = call ? Number(d.spot.high) >= setup.target.value : Number(d.spot.low) <= setup.target.value;
      if (stopHit || tgtHit) {
        out.status = stopHit ? "STOP" : "TARGET";
        out.exitDate = d.date;
        out.exitSpot = stopHit ? Number(d.spot.close) : setup.target.value;
        out.sessions = i + 1;
        break;
      }
      out.sessions = i + 1;
    }
    if (out.status === "OPEN" && later.length >= c.horizonSessions) {
      out.status = "EXPIRED";
      out.exitDate = later[later.length - 1].date;
      out.exitSpot = Number(later[later.length - 1].spot.close);
    }
    if (opt && out.exitDate) {
      const exitDay = later.find((d) => d.date === out.exitDate);
      const px = strikePrice(exitDay, opt.expiry, opt.strike, opt.type);
      if (px !== null && opt.ltp > 0) {
        out.optionExit = px;
        out.optionPnlPct = r2(((px - opt.ltp) / opt.ltp) * 100);
      }
    }
    return out;
  } catch (e) {
    return { ...base, status: "ERROR", reason: String(e?.message || e) };
  }
}

/**
 * Tally of triggered setups across stored outlooks (ascending by date). A setup counts once per
 * episode: a side that was already triggered on the previous stored outlook with the same option
 * (expiry + strike) is a continuation, not a new setup.
 */
export function tallySetups(pastOutlooks = []) {
  const blank = () => ({ n: 0, target: 0, stop: 0, open: 0, expired: 0, optionPnlPcts: [], avgOptionPnlPct: null });
  const t = { call: blank(), put: blank() };
  const prevKey = { call: null, put: null };
  for (const p of [...pastOutlooks].sort((a, b) => (a.date < b.date ? -1 : 1))) {
    for (const k of ["call", "put"]) {
      const s = p.setups?.[k];
      const key = s?.triggered ? `${s.option?.expiry || ""}|${s.option?.strike || ""}|${s.zone?.low}` : null;
      if (key && key !== prevKey[k]) {
        const o = p.setupOutcomes?.[k];
        const b = t[k];
        b.n += 1;
        if (o?.status === "TARGET") b.target += 1;
        else if (o?.status === "STOP") b.stop += 1;
        else if (o?.status === "EXPIRED") b.expired += 1;
        else b.open += 1;
        if (isFin(o?.optionPnlPct)) b.optionPnlPcts.push(Number(o.optionPnlPct));
      }
      prevKey[k] = key;
    }
  }
  for (const k of ["call", "put"]) {
    const a = t[k].optionPnlPcts;
    t[k].avgOptionPnlPct = a.length ? r2(a.reduce((x, y) => x + y, 0) / a.length) : null;
  }
  return t;
}
