/**
 * Turn Tracker — the primary reading of the "Smart Money Futures + Options Fusion" panel.
 *
 * DISPLAY AND TELEGRAM ONLY. Nothing here feeds futures.quadrant, the fusion scenario used by
 * fuseChartWithOptionChain, any veto/sizing path, the EOD scoring groups or the carry dispatcher —
 * those keep the whole-day quadrant exactly as before. Nothing here is ever sent to the Algo.
 *
 * Why (12-Nov-2026): NIFTY futures fell 157 pts from the 10:04 high to 12:33 while futures OI rose
 * 1.9% and call writing went 84k → 244k, yet every reading stayed bullish because it is anchored on
 * the previous close or the session open. The tracker measures from the session's SWING EXTREME:
 *
 *  • Futures leg since the extreme: price move (pts, %), combined OI change (contracts, %), and the
 *    quadrant those imply (same 4-quadrant rule, deadbands = the noise thresholds below).
 *  • Options leg since the extreme: put / call writing change with the two-leg decomposition
 *    (WRITING / UNWINDING / MIXED and which side), ΔPCR at the extreme vs now, floor/roof migration.
 *
 * Stages (per direction: BEARISH from the high, BULLISH from the low):
 *  NO_TURN      neither leg has moved beyond noise.
 *  EARLY        one leg has turned: futures off the extreme by ≥ TURN_NOISE_PCT with OI up by
 *               ≥ TURN_OI_NOISE_PCT (options not yet confirming), OR the options delta since the
 *               extreme points the turn's way, is WRITING-driven and ≥ TURN_OPTIONS_MIN_NET while
 *               price is still within the noise band.
 *  LIKELY_TURN  both legs have turned, below the full thresholds.
 *  CONFIRMED    full thresholds: price ≥ REVERSAL_MIN_MOVE_PCT from the extreme, OI ≥
 *               REVERSAL_MIN_OI_PCT, options leg turned, ≥ REVERSAL_MIN_ELAPSED_MIN since the extreme
 *               (this is the Part 4 alert condition).
 * The side shown: if both sides have a stage above NO_TURN, the more recent extreme; otherwise the
 * one that has; otherwise the active reference (the most recent extreme price has left by ≥ noise).
 * No stage is ever shown when the timeline between the extreme and now is not covered
 * (src/dataQuality.js): "not enough data since hh:mm" instead. Futures are used for price
 * throughout; nothing is evaluated while the current tick is inside 15:15–15:30, and the options leg
 * is not compared across the 15:30 auction print (the writing corridor re-centres on it).
 */
import { decomposeWritingDelta, quadrantFromChanges, SPOT_FREEZE_START_MINS, SPOT_FREEZE_END_MINS } from "./flowCalc.js";
import { windowCoverage, hhmm } from "./dataQuality.js";

// ── Named thresholds ──────────────────────────────────────────────────────────
// Price noise band: 0.15% ≈ 38 pts at NIFTY 25,300. One-minute futures prints jitter by 10–30 pts
// on this feed (11-Nov: 25401 → 25434 within a minute), so a move inside ~0.15% is not a move away
// from the extreme. It is also below half the full 0.35% confirmation move, leaving room for EARLY
// and LIKELY TURN before CONFIRMED.
export const TURN_NOISE_PCT = 0.15;
// OI noise: 0.10% (~200 contracts on ~202k combined OI) — the rolling-window OI deadband, above
// the ~0.05% one-minute reporting jitter of combined OI.
export const TURN_OI_NOISE_PCT = 0.10;
// Options leg: the net writing change since the extreme must be at least this many contracts of
// corridor writing to count — the 1-tier closing-flow level (10k) doubled, because the window can be
// hours long; 12-Nov's turn moved net writing by −1.5L.
export const TURN_OPTIONS_MIN_NET = 20000;
// Confirmation (Part 4 alert condition).
export const TURN_CONFIRM = { minMovePct: 0.35, minOiPct: 0.5, minElapsedMin: 20 };
export const INFO_ONLY = "information only — not a trade signal and not sent to the Algo";
export const STAGES = ["NO_TURN", "EARLY", "LIKELY_TURN", "CONFIRMED"];
export const STAGE_LABEL = { NO_TURN: "NO TURN", EARLY: "EARLY", LIKELY_TURN: "LIKELY TURN", CONFIRMED: "CONFIRMED" };

const pos = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export function getTurnConfig(env = process.env) {
  return {
    noisePct: pos(env.TURN_NOISE_PCT, TURN_NOISE_PCT),
    oiNoisePct: pos(env.TURN_OI_NOISE_PCT, TURN_OI_NOISE_PCT),
    optionsMinNet: pos(env.TURN_OPTIONS_MIN_NET, TURN_OPTIONS_MIN_NET),
    minMovePct: pos(env.REVERSAL_MIN_MOVE_PCT, TURN_CONFIRM.minMovePct),
    minOiPct: pos(env.REVERSAL_MIN_OI_PCT, TURN_CONFIRM.minOiPct),
    minElapsedMin: pos(env.REVERSAL_MIN_ELAPSED_MIN, TURN_CONFIRM.minElapsedMin),
  };
}

/** Same rule as calculateDeltaPcr (api/nifty-oi.js), kept local so this module stays browser-safe. */
export function deltaPcrOf(put, call) {
  const p = Number(put) || 0;
  const c = Number(call) || 0;
  if (c > 0 && p > 0) return Number((p / c).toFixed(2));
  if (c <= 0 && p > 0) return 2.5;
  if (p <= 0 && c > 0) return 0.35;
  if (c < 0 && p < 0) return Number((p / c).toFixed(2));
  return 1.0;
}

export const fmtLots = (n) => {
  if (!Number.isFinite(n)) return "?";
  const a = Math.abs(n);
  const s = n > 0 ? "+" : n < 0 ? "-" : "";
  return a >= 100000 ? `${s}${(a / 100000).toFixed(2)}L` : a >= 1000 ? `${s}${(a / 1000).toFixed(1)}k` : `${s}${Math.round(a)}`;
};
const absLots = (n) => fmtLots(Math.abs(Number(n))).replace(/^\+/, "");
const sgn = (n, d = 1) => `${n >= 0 ? "+" : ""}${Number(n).toFixed(d)}`;

function validFut(p) {
  return p && p.synthetic !== true && Number.isFinite(Number(p.minutes)) && Number(p.futPrice) > 0 && Number(p.futCombinedOI) > 0;
}

function evaluateSide(side, extreme, cur, timeline, cfg) {
  const bearish = side === "BEARISH";
  const kind = bearish ? "high" : "low";
  const elapsedMin = cur.minutes - extreme.minutes;
  const movePts = Number((cur.futPrice - extreme.futPrice).toFixed(2));
  const movePct = Number(((movePts / extreme.futPrice) * 100).toFixed(3));
  const awayPct = bearish ? -movePct : movePct; // positive = moved away from the extreme
  const oiChange = Number(cur.futCombinedOI) - Number(extreme.futCombinedOI);
  const oiPct = Number(((oiChange / Number(extreme.futCombinedOI)) * 100).toFixed(3));
  const quadrant = quadrantFromChanges(movePct, oiPct, cfg.noisePct, cfg.oiNoisePct);

  const acrossAuction = extreme.minutes < SPOT_FREEZE_END_MINS && cur.minutes >= SPOT_FREEZE_END_MINS;
  const flow = decomposeWritingDelta(extreme, cur);
  const optionsComparable = !acrossAuction && flow.putLegDelta !== null;

  const futuresTurned = awayPct >= cfg.noisePct && oiPct >= cfg.oiNoisePct;
  const optionsTurned = optionsComparable && flow.driver === "WRITING" &&
    flow.direction === (bearish ? "BEARISH" : "BULLISH") && Math.abs(flow.netDelta) >= cfg.optionsMinNet;
  const confirmed = futuresTurned && optionsTurned && awayPct >= cfg.minMovePct && oiPct >= cfg.minOiPct && elapsedMin >= cfg.minElapsedMin;
  const stage = confirmed ? "CONFIRMED" : futuresTurned && optionsTurned ? "LIKELY_TURN" : futuresTurned || optionsTurned ? "EARLY" : "NO_TURN";

  const writingWord = bearish ? "call writing rising (WRITING-driven)" : "put writing rising (WRITING-driven)";
  const buildWord = bearish ? "short build-up" : "long build-up";
  let reason;
  if (stage === "CONFIRMED") {
    reason = `${buildWord} from the ${kind}: price ${sgn(movePct, 2)}%, OI ${sgn(oiPct, 2)}%, ${writingWord} — full thresholds met`;
  } else if (stage === "LIKELY_TURN") {
    const short = [];
    if (awayPct < cfg.minMovePct) short.push(`price ${sgn(movePct, 2)}% (needs ${bearish ? "−" : "+"}${cfg.minMovePct}%)`);
    if (oiPct < cfg.minOiPct) short.push(`OI ${sgn(oiPct, 2)}% (needs +${cfg.minOiPct}%)`);
    if (elapsedMin < cfg.minElapsedMin) short.push(`${elapsedMin} min (needs ${cfg.minElapsedMin})`);
    reason = `both legs point ${bearish ? "down" : "up"}: ${buildWord} and ${writingWord}; below full threshold — ${short.join(", ")}`;
  } else if (stage === "EARLY") {
    reason = futuresTurned
      ? `price ${sgn(movePct, 2)}% off the ${kind} with OI ${sgn(oiPct, 2)}% — options not yet confirming (${optionsComparable ? flow.wording : "options leg not comparable across the 15:30 auction print"})`
      : `${writingWord}, net ${fmtLots(flow.netDelta)}, while price is still within ${cfg.noisePct}% of the ${kind}`;
  } else {
    reason = `neither leg beyond noise since the ${kind} (price ${sgn(movePct, 2)}%, OI ${sgn(oiPct, 2)}%, writing net ${fmtLots(flow.netDelta)})`;
  }

  const coverage = windowCoverage(timeline, extreme.minutes, cur.minutes, {
    label: `the window since the ${hhmm(extreme.minutes)} ${kind} (${hhmm(extreme.minutes)}–${hhmm(cur.minutes)})`,
  });
  const lvl = (k) => (Number(extreme[k]) > 0 && Number(cur[k]) > 0 ? { from: Number(extreme[k]), to: Number(cur[k]), moved: Number(cur[k]) - Number(extreme[k]) } : null);

  return {
    side,
    stage,
    stageRank: STAGES.indexOf(stage),
    reason,
    reference: { kind, time: extreme.time || hhmm(extreme.minutes), minutes: extreme.minutes, price: Number(extreme.futPrice) },
    current: { time: cur.time || hhmm(cur.minutes), minutes: cur.minutes, price: Number(cur.futPrice) },
    elapsedMin,
    awayPct: Number(awayPct.toFixed(3)),
    futuresLeg: {
      movePts, movePct, oiFrom: Number(extreme.futCombinedOI), oiTo: Number(cur.futCombinedOI), oiChange, oiPct,
      quadrant, turned: futuresTurned,
    },
    optionsLeg: {
      comparable: optionsComparable,
      putFrom: extreme.putWriting ?? null, putTo: cur.putWriting ?? null, putLegDelta: flow.putLegDelta,
      callFrom: extreme.callWriting ?? null, callTo: cur.callWriting ?? null, callLegDelta: flow.callLegDelta,
      netDelta: flow.netDelta, direction: flow.direction, driver: flow.driver, dominantLeg: flow.dominantLeg, wording: flow.wording,
      deltaPcrAtExtreme: deltaPcrOf(extreme.putWriting, extreme.callWriting),
      deltaPcrNow: deltaPcrOf(cur.putWriting, cur.callWriting),
      floor: lvl("floor"),
      roof: lvl("roof"),
      turned: optionsTurned,
    },
    coverage,
  };
}

function lineFor(t) {
  const bearish = t.side === "BEARISH";
  const f = t.futuresLeg;
  const o = t.optionsLeg;
  return `${STAGE_LABEL[t.stage]} ${t.side} — since ${t.reference.time} ${t.reference.kind} at ${t.reference.price}: futures ${t.current.price} (${sgn(f.movePts, 1)} pts, ${sgn(f.movePct, 2)}%), OI ${sgn(f.oiPct, 2)}% (${f.oiFrom.toLocaleString("en-IN")} → ${f.oiTo.toLocaleString("en-IN")}); call writing ${fmtLots(o.callLegDelta)} (${absLots(o.callFrom)}→${absLots(o.callTo)}), put writing ${fmtLots(o.putLegDelta)} (${absLots(o.putFrom)}→${absLots(o.putTo)}); ΔPCR ${o.deltaPcrAtExtreme} → ${o.deltaPcrNow}. ${bearish ? "🔻" : "🔺"} ${t.reason}.`;
}

/**
 * @returns turnTracker payload object: { status, stage, stageLabel, direction, reason, reference,
 *   current, futuresLeg, optionsLeg, elapsedMin, coverage, thresholds, sides, message, informational }
 */
export function computeTurnTracker({ timeline = [], nowMins = null, config = getTurnConfig() } = {}) {
  const ticks = (Array.isArray(timeline) ? timeline : [])
    .filter(validFut)
    .filter((p) => nowMins === null || p.minutes <= nowMins)
    .slice()
    .sort((a, b) => a.minutes - b.minutes);
  const base = { informational: true, displayOnly: true, thresholds: config, stage: null, stageLabel: null, direction: null };
  if (ticks.length < 2) return { ...base, status: "BUILDING", message: "Turn Tracker: collecting futures ticks." };
  const cur = ticks[ticks.length - 1];
  if (cur.minutes >= SPOT_FREEZE_START_MINS && cur.minutes < SPOT_FREEZE_END_MINS) {
    return { ...base, status: "AUCTION_WINDOW", message: "Turn Tracker: not evaluated 15:15–15:30 (closing auction; the writing corridor re-centres at 15:30)." };
  }
  // Session extremes so far (first occurrence of the high / low, current tick included).
  let hi = ticks[0];
  let lo = ticks[0];
  for (const p of ticks) {
    if (p.futPrice > hi.futPrice) hi = p;
    if (p.futPrice < lo.futPrice) lo = p;
  }
  const sides = {
    bearish: evaluateSide("BEARISH", hi, cur, timeline, config),
    bullish: evaluateSide("BULLISH", lo, cur, timeline, config),
  };
  const both = [sides.bearish, sides.bullish];
  const active = both.filter((s) => s.stageRank > 0).sort((a, b) => b.reference.minutes - a.reference.minutes);
  let chosen = active[0];
  if (!chosen) {
    // Active reference: the most recent extreme price has left by ≥ noise; else the more recent extreme.
    const left = both.filter((s) => s.awayPct >= config.noisePct).sort((a, b) => b.reference.minutes - a.reference.minutes);
    chosen = left[0] || both.slice().sort((a, b) => b.reference.minutes - a.reference.minutes)[0];
  }
  if (!chosen.coverage.ok) {
    return {
      ...base, status: "INSUFFICIENT_DATA", sides, reference: chosen.reference, current: chosen.current, coverage: chosen.coverage,
      message: `⚠️ Turn Tracker: not enough data since ${chosen.reference.time} — ${chosen.coverage.text}. No stage shown.`,
    };
  }
  return {
    ...base,
    status: "OK",
    stage: chosen.stage,
    stageLabel: STAGE_LABEL[chosen.stage],
    direction: chosen.stage === "NO_TURN" ? null : chosen.side,
    reason: chosen.reason,
    reference: chosen.reference,
    current: chosen.current,
    elapsedMin: chosen.elapsedMin,
    futuresLeg: chosen.futuresLeg,
    optionsLeg: chosen.optionsLeg,
    coverage: chosen.coverage,
    sides,
    message: chosen.stage === "NO_TURN"
      ? `● Turn Tracker: NO TURN — ${chosen.reason}.`
      : `${lineFor(chosen)} ${INFO_ONLY[0].toUpperCase()}${INFO_ONLY.slice(1)}.`,
  };
}

/**
 * Telegram on entering LIKELY_TURN and on CONFIRMED, once per (direction, extreme, stage) with an
 * atomic SET NX; for the same direction and stage, a new alert only after a new extreme at least
 * minMovePct away from the last alerted one. deps = { get, set, setNx, del, send }.
 */
export async function dispatchTurnAlert({ tracker, istDateStr, config = getTurnConfig(), deps }) {
  try {
    if (!tracker || tracker.status !== "OK" || !["LIKELY_TURN", "CONFIRMED"].includes(tracker.stage)) return { status: "NO_ALERT_STAGE", sent: false };
    const dir = tracker.direction;
    const stage = tracker.stage;
    const lastKey = `nifty:turn:last:${istDateStr}:${dir}:${stage}`;
    let last = null;
    try { last = await deps.get(lastKey); } catch (e) { return { status: "STATE_READ_ERROR", sent: false }; }
    if (last && Number(last.extremePrice) > 0 && last.extremeMinutes !== tracker.reference.minutes) {
      const awayPct = (Math.abs(tracker.reference.price - Number(last.extremePrice)) / Number(last.extremePrice)) * 100;
      if (awayPct < config.minMovePct) return { status: "ALREADY_ALERTED_NEAR_EXTREME", sent: false };
    }
    const claimKey = `nifty:turn:claim:${istDateStr}:${dir}:${tracker.reference.minutes}:${stage}`;
    let claimed = false;
    try { claimed = await deps.setNx(claimKey, { at: Date.now() }, 2 * 86400); } catch (e) { return { status: "CLAIM_ERROR", sent: false }; }
    if (!claimed) return { status: "ALREADY_CLAIMED", sent: false };
    const f = tracker.futuresLeg;
    const o = tracker.optionsLeg;
    const lv = (x, name) => (x ? ` · ${name} ${x.from}→${x.to}` : "");
    const text = [
      `${dir === "BEARISH" ? "🔻" : "🔺"} *TURN TRACKER · ${tracker.stageLabel} ${dir}* — ${dir === "BEARISH" ? "short build-up from the high" : "long build-up from the low"}`,
      `• *Since:* ${tracker.reference.time} ${tracker.reference.kind} at \`${tracker.reference.price}\` (NIFTY futures) → now \`${tracker.current.price}\` at ${tracker.current.time}`,
      `• *Futures leg:* \`${sgn(f.movePts, 1)} pts (${sgn(f.movePct, 2)}%)\` · OI \`${sgn(f.oiPct, 2)}%\` (${f.oiFrom} → ${f.oiTo}) · ${f.quadrant.replace(/_/g, " ")}`,
      `• *Options leg:* call writing ${fmtLots(o.callLegDelta)} (${absLots(o.callFrom)}→${absLots(o.callTo)}), put writing ${fmtLots(o.putLegDelta)} (${absLots(o.putFrom)}→${absLots(o.putTo)}) · ${o.driver}${o.dominantLeg ? ` (${o.dominantLeg})` : ""} · ΔPCR ${o.deltaPcrAtExtreme}→${o.deltaPcrNow}${lv(o.floor, "floor")}${lv(o.roof, "roof")}`,
      `• *Why:* ${tracker.reason}`,
      `• ℹ️ *${INFO_ONLY[0].toUpperCase()}${INFO_ONLY.slice(1)}.*`,
    ].join("\n");
    let ok = false;
    try { ok = await deps.send(text); } catch (e) { ok = false; }
    if (!ok) {
      try { await deps.del(claimKey); } catch (e) { /* best effort */ }
      return { status: "SEND_FAILED_RELEASED", sent: false };
    }
    try { await deps.set(lastKey, { extremePrice: tracker.reference.price, extremeMinutes: tracker.reference.minutes, at: Date.now() }, 2 * 86400); } catch (e) { /* claim still dedupes */ }
    return { status: "SENT", sent: true, text };
  } catch (e) {
    return { status: "ERROR", sent: false, error: e?.message };
  }
}

/** Replays a timeline minute by minute; returns the first time each stage appears per direction. */
export function replayFirstStages(timeline, { from = 555, to = 940, config = getTurnConfig() } = {}) {
  const first = {};
  const insufficientAt = [];
  for (let m = from; m <= to; m++) {
    if (!timeline.some((p) => p.minutes === m)) continue;
    const t = computeTurnTracker({ timeline, nowMins: m, config });
    if (t.status === "INSUFFICIENT_DATA") { insufficientAt.push(hhmm(m)); continue; }
    if (t.status !== "OK" || !t.direction) continue;
    const key = `${t.stage}:${t.direction}`;
    if (!first[key]) first[key] = { time: hhmm(m), since: `${t.reference.time} ${t.reference.kind} ${t.reference.price}`, price: t.current.price };
  }
  return { first, insufficientAt };
}
