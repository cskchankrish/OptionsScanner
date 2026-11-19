/**
 * Carry check (SHADOW, owner 2026-11-19): "is it worth holding an existing position overnight?"
 *
 * Measurement only. Nothing here feeds a decision, the Algo's square-off, the EOD verdict or the
 * carry bridge. Pure functions over data already stored (scorecard day documents, daily swing
 * summaries, the Weekly Outlook snapshot taken that day).
 *
 * For every session D it records, as they stood at the close, a set of candidate metrics. Each one
 * votes BULLISH (worth holding a long), BEARISH (worth holding a short) or NEUTRAL. On the next
 * session it measures what holding in each voted direction would have done compared with exiting at
 * the 15:36 square-off:
 *   - futures at the next open (first live tick), 09:20 and 10:30, versus D's 15:36 futures price;
 *   - the best and worst move before 11:00.
 * Primary hit rule (fixed now, before any results): holding in the voted direction was ahead at
 * 10:30 (signed move > 0). Also recorded: whether a major move (≥ 0.35%) in the voted direction was
 * reached before 11:00, and whether a major move against it was.
 *
 * Point in time: the Weekly Outlook is the snapshot stored on D (what was known then), never one
 * recomputed later with more data. A futures contract roll between D and the next session makes the
 * outcome UNMEASURABLE (prices from different contracts are not comparable).
 */
import { firstLiveIndex } from "./sessionOpen.js";

export const CARRY_CHECK_DEFAULTS = Object.freeze({
  priceDeadbandPct: 0.08, // same day-level deadbands as the whole-day futures classifier
  oiDeadbandPct: 0.25,
  strongOiPct: 5, // "large OI build" (18-Nov: +7.9%)
  closeLowPct: 35, // close in the bottom 35% of the day's range → bearish
  closeHighPct: 65, // top 35% → bullish
  pcrShift: 0.15, // day-on-day change in the next-weekly PCR that counts
  eodScoreMin: 1, // |EOD score| ≥ 1 votes (lower than the carry threshold, on purpose)
  squareoffMins: 936, // 15:36: the price you exit at if you don't hold
  checkMins: 630, // 10:30 next session: primary measurement
  windowEndMins: 660, // 11:00: best / worst window end
  majorPct: 0.35, // a "major" overnight follow-through
  confluenceMin: 3, // at least this many independent metrics on one side and none opposed
});

export const CARRY_METRICS = [
  ["DAY_QUADRANT", "Whole-day futures reading (price vs previous close, OI open→close)"],
  ["STRONG_BUILDUP", "Build-up with a large OI rise (≥ 5%)"],
  ["DAY_DIRECTION", "Futures day direction"],
  ["CLOSE_IN_RANGE", "Close position in the day's spot range"],
  ["PCR_SHIFT", "PCR change vs the previous session (same expiry)"],
  ["WEEKLY_OUTLOOK", "Weekly Outlook regime (snapshot taken that day)"],
  ["EOD_SCORE", "EOD score sign (|score| ≥ 1)"],
  ["EOD_A", "EOD group A — options positioning"],
  ["EOD_B", "EOD group B — closing options flow"],
  ["EOD_C", "EOD group C — futures"],
  ["BREAKDOWN_COMBO", "Short build-up + OI ≥ 5% + PCR falling (mirror for longs) — the 18-Nov pattern"],
  ["CONFLUENCE", "≥ 3 of {day reading, close in range, PCR change, outlook, EOD score} agree, none against"],
];

const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);
const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const signVote = (x) => (x > 0 ? "BULLISH" : x < 0 ? "BEARISH" : "NEUTRAL");

function quadrantOf(pricePct, oiPct, cfg) {
  if (!Number.isFinite(pricePct) || !Number.isFinite(oiPct)) return null;
  if (Math.abs(pricePct) < cfg.priceDeadbandPct || Math.abs(oiPct) < cfg.oiDeadbandPct) return "NEUTRAL_CHOP";
  if (pricePct > 0) return oiPct > 0 ? "LONG_BUILDUP" : "SHORT_COVERING";
  return oiPct > 0 ? "SHORT_BUILDUP" : "LONG_UNWINDING";
}
const QUAD_VOTE = { LONG_BUILDUP: "BULLISH", SHORT_COVERING: "BULLISH", SHORT_BUILDUP: "BEARISH", LONG_UNWINDING: "BEARISH", NEUTRAL_CHOP: "NEUTRAL" };
const OUTLOOK_VOTE = { TREND_UP: "BULLISH", BREAK_RISK_UP: "BULLISH", TREND_DOWN: "BEARISH", BREAK_RISK_DOWN: "BEARISH" };

/**
 * Metrics for session D as they stood at the close.
 * @param {{ day, prevDay, eodFinal, outlook, cfg }} args
 *   day / prevDay: swing day summaries ({ fut:{close,oiChangePct}, spot:{high,low,close}, chains:{nextWeekly:{pcr,expiry}} })
 *   eodFinal: the scorecard's FINAL EOD event of D ({ data:{ score, groups:{A,B,C} } })
 *   outlook: the Weekly Outlook snapshot stored on D ({ regime })
 */
export function computeCarryMetrics({ day, prevDay = null, eodFinal = null, outlook = null, cfg = CARRY_CHECK_DEFAULTS } = {}) {
  const m = {};
  const put = (id, vote, value, detail) => { m[id] = { vote, value, detail }; };
  const fc = Number(day?.fut?.close);
  const pc = Number(prevDay?.fut?.close);
  const pricePct = fc > 0 && pc > 0 ? ((fc - pc) / pc) * 100 : NaN;
  const oiPct = Number(day?.fut?.oiChangePct);
  const quad = quadrantOf(pricePct, oiPct, cfg);
  put("DAY_QUADRANT", quad ? QUAD_VOTE[quad] : "NEUTRAL", quad, quad ? `futures ${r2(fc - pc)} pts (${r2(pricePct)}%), OI ${r2(oiPct)}%` : "previous close or OI change not recorded");

  const strong = quad && Math.abs(oiPct) >= cfg.strongOiPct && (quad === "SHORT_BUILDUP" || quad === "LONG_BUILDUP");
  put("STRONG_BUILDUP", strong ? QUAD_VOTE[quad] : "NEUTRAL", Number.isFinite(oiPct) ? r2(oiPct) : null, strong ? `${quad} with OI ${r2(oiPct)}%` : "no build-up with OI ≥ 5%");

  put("DAY_DIRECTION", Number.isFinite(pricePct) && Math.abs(pricePct) >= cfg.priceDeadbandPct ? signVote(pricePct) : "NEUTRAL",
    Number.isFinite(pricePct) ? r2(pricePct) : null, Number.isFinite(pricePct) ? `${r2(pricePct)}% close to close` : "previous close not recorded");

  const hi = Number(day?.spot?.high), lo = Number(day?.spot?.low), cl = Number(day?.spot?.close);
  const pos = hi > lo && cl > 0 ? ((cl - lo) / (hi - lo)) * 100 : NaN;
  put("CLOSE_IN_RANGE", Number.isFinite(pos) ? (pos <= cfg.closeLowPct ? "BEARISH" : pos >= cfg.closeHighPct ? "BULLISH" : "NEUTRAL") : "NEUTRAL",
    Number.isFinite(pos) ? Math.round(pos) : null, Number.isFinite(pos) ? `closed at ${Math.round(pos)}% of the day's range` : "day range not recorded");

  // Same expiry on both days (a weekly expiry in between moves "next weekly" to a new contract:
  // 17-Nov's next weekly 23-Nov is 18-Nov's NEAR chain). Prefer the soonest expiry both days have,
  // skipping a chain that is expiring that day (its OI collapses into settlement).
  const chainsOf = (dd) => ["near", "nextWeekly", "monthly"].map((k) => dd?.chains?.[k]).filter((c) => c && c.expiry && Number(c.pcr) > 0 && Number(c.dte) !== 0);
  const prevByExp = new Map(chainsOf(prevDay).map((c) => [c.expiry, c]));
  const common = chainsOf(day).filter((c) => prevByExp.has(c.expiry)).sort((a, b) => (Number(a.dte) || 99) - (Number(b.dte) || 99))[0] || null;
  const pc0 = common ? prevByExp.get(common.expiry) : null;
  const dPcr = common ? Number(common.pcr) - Number(pc0.pcr) : NaN;
  put("PCR_SHIFT", Number.isFinite(dPcr) && Math.abs(dPcr) >= cfg.pcrShift ? signVote(dPcr) : "NEUTRAL", Number.isFinite(dPcr) ? r2(dPcr) : null,
    Number.isFinite(dPcr) ? `${common.expiry} PCR ${pc0.pcr} → ${common.pcr} (${dPcr >= 0 ? "+" : ""}${r2(dPcr)})` : "no expiry recorded on both days");

  const reg = outlook?.regime || null;
  put("WEEKLY_OUTLOOK", OUTLOOK_VOTE[reg] || "NEUTRAL", reg, reg ? `regime ${reg}` : "no outlook snapshot that day");

  const sc = Number(eodFinal?.data?.score);
  put("EOD_SCORE", Number.isFinite(sc) && Math.abs(sc) >= cfg.eodScoreMin ? signVote(sc) : "NEUTRAL", Number.isFinite(sc) ? sc : null, Number.isFinite(sc) ? `final EOD score ${sc}` : "no final EOD reading");
  for (const g of ["A", "B", "C"]) {
    const v = Number(eodFinal?.data?.groups?.[g]);
    put(`EOD_${g}`, Number.isFinite(v) ? signVote(v) : "NEUTRAL", Number.isFinite(v) ? v : null, Number.isFinite(v) ? `group ${g} ${v >= 0 ? "+" : ""}${v}` : "not recorded");
  }

  const pcrDown = Number.isFinite(dPcr) && dPcr <= -cfg.pcrShift;
  const pcrUp = Number.isFinite(dPcr) && dPcr >= cfg.pcrShift;
  const combo = strong && quad === "SHORT_BUILDUP" && pcrDown ? "BEARISH" : strong && quad === "LONG_BUILDUP" && pcrUp ? "BULLISH" : "NEUTRAL";
  put("BREAKDOWN_COMBO", combo, null, combo === "NEUTRAL" ? "pattern not present" : `${quad}, OI ${r2(oiPct)}%, PCR ${r2(dPcr)}`);

  const indep = ["DAY_QUADRANT", "CLOSE_IN_RANGE", "PCR_SHIFT", "WEEKLY_OUTLOOK", "EOD_SCORE"].map((k) => m[k].vote);
  const bull = indep.filter((v) => v === "BULLISH").length, bear = indep.filter((v) => v === "BEARISH").length;
  const conf = bull >= cfg.confluenceMin && bear === 0 ? "BULLISH" : bear >= cfg.confluenceMin && bull === 0 ? "BEARISH" : "NEUTRAL";
  put("CONFLUENCE", conf, `${bull} bullish / ${bear} bearish`, `${bull} bullish, ${bear} bearish of 5`);
  return m;
}

function futTicks(series) {
  const out = [];
  if (!series?.m) return out;
  for (let i = 0; i < series.m.length; i++) if (Number(series.f?.[i]) > 0) out.push({ minutes: Number(series.m[i]), f: Number(series.f[i]) });
  return out.sort((a, b) => a.minutes - b.minutes);
}
const atOrBefore = (ticks, m) => { let b = null; for (const t of ticks) if (t.minutes <= m) b = t; return b; };

/**
 * What the next session did versus D's 15:36 futures price. Unsigned (up = +); each metric signs it.
 */
export function measureCarryOutcome({ daySeries, nextSeries, dayExpiry = null, nextExpiry = null, nextDate = null, cfg = CARRY_CHECK_DEFAULTS } = {}) {
  if (dayExpiry && nextExpiry && dayExpiry !== nextExpiry) return { status: "UNMEASURABLE", reason: `futures contract rolled (${dayExpiry} → ${nextExpiry})`, nextDate };
  const d = futTicks(daySeries);
  const ref = atOrBefore(d, cfg.squareoffMins);
  if (!ref || cfg.squareoffMins - ref.minutes > 4) return { status: "UNMEASURABLE", reason: "no futures tick at the 15:36 square-off", nextDate };
  if (!nextSeries?.m?.length) return { status: "PENDING", reason: "next session not recorded yet", nextDate, refPrice: r2(ref.f), refAt: hhmm(ref.minutes) };
  const live = firstLiveIndex(nextSeries);
  const n = futTicks(nextSeries).filter((t) => t.minutes >= Number(nextSeries.m[Math.max(0, live.index)] ?? 0));
  if (!n.length || n[0].minutes > 555 + 10) return { status: "UNMEASURABLE", reason: "next session's open not recorded", nextDate };
  const last = n[n.length - 1];
  if (last.minutes < cfg.checkMins) return { status: "PENDING", reason: `next session not yet at ${hhmm(cfg.checkMins)}`, nextDate, refPrice: r2(ref.f) };
  const p = (m) => atOrBefore(n, m);
  const t0920 = p(560), t1030 = p(cfg.checkMins);
  if (!t1030 || cfg.checkMins - t1030.minutes > 4) return { status: "UNMEASURABLE", reason: `no tick near ${hhmm(cfg.checkMins)}`, nextDate };
  const win = n.filter((t) => t.minutes <= cfg.windowEndMins);
  const hiT = win.reduce((a, t) => (t.f > a.f ? t : a), win[0]);
  const loT = win.reduce((a, t) => (t.f < a.f ? t : a), win[0]);
  const pct = (x) => r2(((x - ref.f) / ref.f) * 100);
  return {
    status: "MEASURED", nextDate, refPrice: r2(ref.f), refAt: hhmm(ref.minutes),
    open: { at: hhmm(n[0].minutes), pts: r2(n[0].f - ref.f), pct: pct(n[0].f) },
    at0920: t0920 ? { at: hhmm(t0920.minutes), pts: r2(t0920.f - ref.f), pct: pct(t0920.f) } : null,
    at1030: { at: hhmm(t1030.minutes), pts: r2(t1030.f - ref.f), pct: pct(t1030.f) },
    high: { at: hhmm(hiT.minutes), pts: r2(hiT.f - ref.f), pct: pct(hiT.f) },
    low: { at: hhmm(loT.minutes), pts: r2(loT.f - ref.f), pct: pct(loT.f) },
  };
}

/** One metric's vote scored against the outcome. */
export function scoreVote(vote, outcome, cfg = CARRY_CHECK_DEFAULTS) {
  if (outcome?.status !== "MEASURED") return { status: outcome?.status || "UNMEASURABLE" };
  if (vote !== "BULLISH" && vote !== "BEARISH") return { status: "NO_VOTE" };
  const s = vote === "BULLISH" ? 1 : -1;
  const at1030 = r2(s * outcome.at1030.pts);
  const best = r2(s > 0 ? outcome.high.pts : -outcome.low.pts);
  const worst = r2(s > 0 ? outcome.low.pts : -outcome.high.pts);
  const bestPct = r2(s > 0 ? outcome.high.pct : -outcome.low.pct);
  const worstPct = r2(s > 0 ? outcome.low.pct : -outcome.high.pct);
  return {
    status: "MEASURED",
    hit: at1030 > 0, // holding beat exiting at the square-off, measured at 10:30
    at1030Pts: at1030,
    openPts: r2(s * outcome.open.pts),
    bestPts: best,
    worstPts: worst,
    majorFor: bestPct >= cfg.majorPct,
    majorAgainst: worstPct <= -cfg.majorPct,
  };
}

/** One row per session: metrics at the close, the next-session outcome, and each vote's score. */
export function buildCarryRows({ swingDays = [], scDocs = {}, outlooks = {}, cfg = CARRY_CHECK_DEFAULTS } = {}) {
  const days = [...swingDays].filter((d) => d && d.date).sort((a, b) => a.date.localeCompare(b.date));
  const scDates = Object.keys(scDocs).sort();
  const rows = [];
  for (let i = 0; i < days.length; i++) {
    const day = days[i];
    const prevDay = i > 0 ? days[i - 1] : null;
    const doc = scDocs[day.date] || null;
    const nextDate = scDates.find((d) => d > day.date) || null;
    const next = nextDate ? scDocs[nextDate] : null;
    const metrics = computeCarryMetrics({ day, prevDay, eodFinal: doc?.eodFinal || null, outlook: outlooks[day.date] || null, cfg });
    const outcome = doc?.series
      ? measureCarryOutcome({ daySeries: doc.series, nextSeries: next?.series || null, dayExpiry: doc.futuresExpiry || null, nextExpiry: next?.futuresExpiry || null, nextDate, cfg })
      : { status: "UNMEASURABLE", reason: "no recorded series for the day" };
    const scores = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, scoreVote(v.vote, outcome, cfg)]));
    rows.push({ date: day.date, metrics, outcome, scores });
  }
  return rows;
}

function wilson(k, n, z = 1.959964) {
  if (!n) return { lo: null, hi: null };
  const p = k / n, d = 1 + (z * z) / n, c = p + (z * z) / (2 * n), s = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { lo: r2((c - s) / d), hi: r2((c + s) / d) };
}

/** Per-metric summary across sessions. */
export function summariseCarry(rows, { minSample = 20 } = {}) {
  const measuredDays = rows.filter((r) => r.outcome?.status === "MEASURED");
  const majorDays = measuredDays.filter((r) => Math.max(r.outcome.high.pct, -r.outcome.low.pct) >= CARRY_CHECK_DEFAULTS.majorPct);
  const by = {};
  for (const [id, label] of CARRY_METRICS) {
    const sc = rows.map((r) => ({ r, s: r.scores[id] })).filter((x) => x.s?.status === "MEASURED");
    const hits = sc.filter((x) => x.s.hit).length;
    const mean = (k) => (sc.length ? r2(sc.reduce((a, x) => a + x.s[k], 0) / sc.length) : null);
    by[id] = {
      label,
      votes: sc.length,
      noVote: rows.filter((r) => r.scores[id]?.status === "NO_VOTE").length,
      hits,
      hitRate: sc.length ? r2(hits / sc.length) : null,
      wilson95: wilson(hits, sc.length),
      meanAt1030Pts: mean("at1030Pts"),
      meanBestPts: mean("bestPts"),
      meanWorstPts: mean("worstPts"),
      majorCaught: sc.filter((x) => x.s.majorFor).length,
      majorAgainst: sc.filter((x) => x.s.majorAgainst).length,
      // of the sessions that delivered a major overnight move, how many did this metric vote for in the right direction
      majorMovesCalled: majorDays.filter((d) => d.scores[id]?.status === "MEASURED" && d.scores[id].majorFor).length,
      tooFewToJudge: sc.length < minSample,
    };
  }
  return { sessions: rows.length, measuredSessions: measuredDays.length, majorMoveSessions: majorDays.length, minSample, byMetric: by };
}
