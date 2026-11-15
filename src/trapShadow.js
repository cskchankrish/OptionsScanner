/**
 * SHADOW Bear Trap / Bull Trap rules — MEASUREMENT ONLY.
 *
 * The live fusion rules (src/smartMoneyFusion.js, evaluateFusionScenario) label
 *   BEAR_TRAP when the quadrant is LONG_UNWINDING and (floorPutWritingBlitz OR ΔPCR >= 1.30)
 *   BULL_TRAP when the quadrant is SHORT_COVERING and (roofCallWritingBlitz OR ΔPCR <= 0.75).
 * This module re-states exactly that condition ("base") and a tighter version ("strict" = base AND
 * five extra conditions) so both can be measured side by side by the scorecard (section
 * TRAP_SHADOW). Nothing reads the result back into a decision, veto, score, alert or dispatch.
 *
 * Pure: no I/O, no Date.now(), never throws on partial data. Every threshold is a named default in
 * getTrapShadowConfig(env) with a TRAP_SHADOW_* override, and every raw input value is returned
 * inside the condition objects so thresholds can be re-fitted later from recorded events.
 */
import { DQ_GAP_LIST_MIN, DQ_GAP_ALERT_MIN } from "./dataQuality.js";

// ── Live rule (must stay identical to evaluateFusionScenario; guarded by test/trapShadow.test.js,
// which compares against evaluateSmartMoneyFusion over a grid of inputs). Not configurable.
export const LIVE_BEAR_TRAP_QUADRANT = "LONG_UNWINDING";
export const LIVE_BULL_TRAP_QUADRANT = "SHORT_COVERING";
export const LIVE_BEAR_TRAP_MIN_DELTA_PCR = 1.30; // isFloorPutBlitz: floorPutWritingBlitz || deltaPcr >= 1.30
export const LIVE_BULL_TRAP_MAX_DELTA_PCR = 0.75; // isRoofCallBlitz: roofCallWritingBlitz || deltaPcr <= 0.75

// ── Shadow defaults ─────────────────────────────────────────────────────────
export const TRAP_SHADOW_DEFAULTS = Object.freeze({
  enabled: true,
  // strength: the day's writing is clearly one-sided (same bar as the Synergy rules)
  bearMinDeltaPcr: 1.35,
  bullMaxDeltaPcr: 0.70,
  // recent: change in net writing (put − call) over the window (30-min radar trap thresholds)
  recentWindowMin: 30,
  bearMinNetChange: 28000,
  bullMaxNetChange: -26000,
  // relative: |net writing change| / max(|futures combined-OI change|, 1) in the same window
  minRelativeRatio: 3,
  // proximity: points from the defended strike (bear: spot − floor; bull: roof − spot)
  maxDistancePts: 75,
  maxBreakPts: 25,
  // stalled: extreme of the last N minutes of futures is at least M minutes old and price has
  // come off it by at least P %
  stallWindowMin: 20,
  stallMinAgeMin: 5,
  stallMinBouncePct: 0.03,
  // window coverage: a tick within this many minutes of the window start, and no hole (between
  // ticks, or from the last tick to the window end) longer than windowMaxGapMin
  windowStartTolMin: DQ_GAP_LIST_MIN, // 3
  windowMaxGapMin: DQ_GAP_ALERT_MIN, // 5
  // scorecard capture: a variant re-arms only after being false for this many minutes
  rearmMin: 10,
});

const ENV_KEYS = {
  bearMinDeltaPcr: "TRAP_SHADOW_BEAR_MIN_DELTA_PCR",
  bullMaxDeltaPcr: "TRAP_SHADOW_BULL_MAX_DELTA_PCR",
  recentWindowMin: "TRAP_SHADOW_RECENT_WINDOW_MIN",
  bearMinNetChange: "TRAP_SHADOW_BEAR_MIN_NET_CHANGE",
  bullMaxNetChange: "TRAP_SHADOW_BULL_MAX_NET_CHANGE",
  minRelativeRatio: "TRAP_SHADOW_MIN_RELATIVE_RATIO",
  maxDistancePts: "TRAP_SHADOW_MAX_DISTANCE_PTS",
  maxBreakPts: "TRAP_SHADOW_MAX_BREAK_PTS",
  stallWindowMin: "TRAP_SHADOW_STALL_WINDOW_MIN",
  stallMinAgeMin: "TRAP_SHADOW_STALL_MIN_AGE_MIN",
  stallMinBouncePct: "TRAP_SHADOW_STALL_MIN_BOUNCE_PCT",
  windowStartTolMin: "TRAP_SHADOW_WINDOW_START_TOL_MIN",
  windowMaxGapMin: "TRAP_SHADOW_WINDOW_MAX_GAP_MIN",
  rearmMin: "TRAP_SHADOW_REARM_MIN",
};
export const TRAP_SHADOW_ENV_KEYS = ["TRAP_SHADOW_ENABLED", ...Object.values(ENV_KEYS)];

// Values that must be positive; bullMaxNetChange must be negative; the rest non-negative.
const POSITIVE = new Set(["bearMinDeltaPcr", "bullMaxDeltaPcr", "recentWindowMin", "minRelativeRatio", "stallWindowMin", "windowMaxGapMin"]);

export function getTrapShadowConfig(env = process.env) {
  const e = env || {};
  const raw = String(e.TRAP_SHADOW_ENABLED ?? "true").trim().toLowerCase();
  const cfg = { ...TRAP_SHADOW_DEFAULTS, enabled: !(raw === "false" || raw === "0") };
  for (const [k, name] of Object.entries(ENV_KEYS)) {
    const v = e[name];
    if (v === undefined || v === null || String(v).trim() === "") continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (k === "bullMaxNetChange" ? !(n < 0) : POSITIVE.has(k) ? !(n > 0) : n < 0) continue;
    cfg[k] = n;
  }
  return cfg;
}

// ── Helpers ─────────────────────────────────────────────────────────────────
const fin = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
const r2 = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);

/** Real ticks (not synthetic, finite minutes, at or before nowMins), sorted by minute. */
function realTicks(timeline, nowMins) {
  const out = [];
  for (const p of Array.isArray(timeline) ? timeline : []) {
    if (!p || typeof p !== "object" || p.synthetic === true) continue;
    const m = Number(p.minutes);
    if (!Number.isFinite(m)) continue;
    if (Number.isFinite(nowMins) && m > nowMins) continue;
    out.push(p);
  }
  return out.sort((a, b) => Number(a.minutes) - Number(b.minutes));
}

/**
 * Ticks for window [end − len, end] whose fields satisfy `valid`.
 * Baseline = the valid tick closest to the window start within ±windowStartTolMin (earlier wins a tie);
 * the window then runs from the baseline to the last valid tick at or before `end`. Not covered when
 * there is no baseline, or any hole between ticks or from the last tick to `end` exceeds windowMaxGapMin.
 */
export function shadowWindow(ticks, end, len, cfg, valid, label) {
  const start = end - len;
  const ok = ticks.filter((p) => { try { return valid(p); } catch (e) { return false; } });
  const tol = cfg.windowStartTolMin;
  let base = null;
  for (const p of ok) {
    const m = Number(p.minutes);
    if (m < start - tol || m > start + tol || m > end) continue;
    if (!base || Math.abs(m - start) < Math.abs(Number(base.minutes) - start)) base = p;
  }
  if (!base) return { ok: false, reason: `no tick within ${tol} min of the ${label} window start`, start, end };
  const inWin = ok.filter((p) => Number(p.minutes) >= Number(base.minutes) && Number(p.minutes) <= end);
  let maxGap = 0;
  for (let i = 1; i < inWin.length; i++) maxGap = Math.max(maxGap, Number(inWin[i].minutes) - Number(inWin[i - 1].minutes));
  const last = inWin[inWin.length - 1];
  maxGap = Math.max(maxGap, end - Number(last.minutes));
  if (maxGap > cfg.windowMaxGapMin) {
    return { ok: false, reason: `${label} window has a ${maxGap}-min hole (max ${cfg.windowMaxGapMin})`, start, end, maxGapMin: maxGap };
  }
  return { ok: true, start, end, ticks: inWin, first: base, last, maxGapMin: maxGap, observed: inWin.length };
}

const writingValid = (p) => fin(p.putWriting) && fin(p.callWriting);
const futOiValid = (p) => writingValid(p) && Number(p.futCombinedOI) > 0;
const futPriceValid = (p) => Number(p.futPrice) > 0;

const unverified = (reason, extra = {}) => ({ pass: null, reason, ...extra });

// ── Conditions (side: +1 bear trap / bullish, −1 bull trap / bearish) ───────
function condStrength(side, optionsMetrics, cfg) {
  const om = optionsMetrics || {};
  const deltaPcr = fin(om.deltaPcr) ? Number(om.deltaPcr) : null;
  const put = fin(om.totalPutWriting) ? Number(om.totalPutWriting) : null;
  const call = fin(om.totalCallWriting) ? Number(om.totalCallWriting) : null;
  const threshold = side > 0 ? cfg.bearMinDeltaPcr : cfg.bullMaxDeltaPcr;
  const vals = { deltaPcr, totalPutWriting: put, totalCallWriting: call, netWriting: put !== null && call !== null ? put - call : null, threshold };
  if (deltaPcr === null || put === null || call === null) return unverified("ΔPCR or total writing missing", vals);
  const pass = side > 0 ? deltaPcr >= threshold && vals.netWriting > 0 : deltaPcr <= threshold && vals.netWriting < 0;
  return { pass, ...vals };
}

function condRecent(side, ticks, end, cfg) {
  const threshold = side > 0 ? cfg.bearMinNetChange : cfg.bullMaxNetChange;
  const w = shadowWindow(ticks, end, cfg.recentWindowMin, cfg, writingValid, `${cfg.recentWindowMin}-min writing`);
  const vals = { windowMin: cfg.recentWindowMin, threshold };
  if (!w.ok) return unverified(w.reason, vals);
  const net0 = Number(w.first.putWriting) - Number(w.first.callWriting);
  const net1 = Number(w.last.putWriting) - Number(w.last.callWriting);
  const netChange = net1 - net0;
  return {
    pass: side > 0 ? netChange >= threshold : netChange <= threshold,
    ...vals, from: Number(w.first.minutes), to: Number(w.last.minutes), netStart: net0, netEnd: net1, netChange,
    putChange: Number(w.last.putWriting) - Number(w.first.putWriting), callChange: Number(w.last.callWriting) - Number(w.first.callWriting),
  };
}

function condRelative(ticks, end, cfg) {
  const w = shadowWindow(ticks, end, cfg.recentWindowMin, cfg, futOiValid, `${cfg.recentWindowMin}-min writing / futures-OI`);
  const vals = { windowMin: cfg.recentWindowMin, threshold: cfg.minRelativeRatio };
  if (!w.ok) return unverified(w.reason, vals);
  const netChange = (Number(w.last.putWriting) - Number(w.last.callWriting)) - (Number(w.first.putWriting) - Number(w.first.callWriting));
  const futOiChange = Number(w.last.futCombinedOI) - Number(w.first.futCombinedOI);
  const numerator = Math.abs(netChange);
  const denominator = Math.max(Math.abs(futOiChange), 1);
  const ratio = numerator / denominator;
  return {
    pass: ratio >= cfg.minRelativeRatio,
    ...vals, from: Number(w.first.minutes), to: Number(w.last.minutes), netChange, futOiStart: Number(w.first.futCombinedOI), futOiEnd: Number(w.last.futCombinedOI), futOiChange,
    numerator, denominator, ratio: r2(ratio),
  };
}

function condProximity(side, spot, strike, cfg) {
  const s = Number(spot);
  const k = Number(strike);
  const vals = { spot: fin(spot) ? s : null, strike: fin(strike) ? k : null, maxDistancePts: cfg.maxDistancePts, maxBreakPts: cfg.maxBreakPts };
  if (!(s > 0)) return unverified("spot missing", vals);
  if (!(k > 0)) return unverified(side > 0 ? "floor strike missing" : "roof strike missing", vals);
  const distancePts = r2(side > 0 ? s - k : k - s);
  return { pass: distancePts >= -cfg.maxBreakPts && distancePts <= cfg.maxDistancePts, ...vals, distancePts };
}

function condStalled(side, ticks, end, cfg) {
  const vals = { windowMin: cfg.stallWindowMin, minAgeMin: cfg.stallMinAgeMin, minBouncePct: cfg.stallMinBouncePct };
  const w = shadowWindow(ticks, end, cfg.stallWindowMin, cfg, futPriceValid, `${cfg.stallWindowMin}-min futures`);
  if (!w.ok) return unverified(w.reason, vals);
  // Extreme (low for a bear trap, high for a bull trap); on ties the LATEST occurrence (conservative).
  let ext = w.ticks[0];
  for (const p of w.ticks) {
    const v = Number(p.futPrice);
    const e = Number(ext.futPrice);
    if (side > 0 ? v <= e : v >= e) ext = p;
  }
  const extPrice = Number(ext.futPrice);
  const current = Number(w.last.futPrice);
  const extremeAgeMin = Number(w.last.minutes) - Number(ext.minutes);
  const bouncePct = side > 0 ? ((current - extPrice) / extPrice) * 100 : ((extPrice - current) / extPrice) * 100;
  return {
    pass: extremeAgeMin >= cfg.stallMinAgeMin && bouncePct >= cfg.stallMinBouncePct,
    ...vals, from: Number(w.first.minutes), to: Number(w.last.minutes),
    extremeKind: side > 0 ? "LOW" : "HIGH", extremePrice: extPrice, extremeAt: Number(ext.minutes), extremeAgeMin, currentPrice: current, bouncePct: r4(bouncePct),
  };
}

const CONDITION_NAMES = ["strength", "recent", "relative", "proximity", "stalled"];

function evaluateSide(side, { quadrant, optionsMetrics, spot, strike, ticks, end, cfg }) {
  const om = optionsMetrics || {};
  // Exactly the live expression (evaluateFusionScenario): Number(deltaPcr ?? 1.0), Boolean(blitz flag).
  const liveDeltaPcr = Number(om?.deltaPcr ?? 1.0);
  const base = side > 0
    ? quadrant === LIVE_BEAR_TRAP_QUADRANT && (Boolean(om?.floorPutWritingBlitz) || liveDeltaPcr >= LIVE_BEAR_TRAP_MIN_DELTA_PCR)
    : quadrant === LIVE_BULL_TRAP_QUADRANT && (Boolean(om?.roofCallWritingBlitz) || liveDeltaPcr <= LIVE_BULL_TRAP_MAX_DELTA_PCR);
  const safe = (fn) => { try { return fn(); } catch (e) { return unverified(`error: ${e?.message || "evaluation failed"}`); } };
  const conditions = {
    strength: safe(() => condStrength(side, optionsMetrics, cfg)),
    recent: safe(() => condRecent(side, ticks, end, cfg)),
    relative: safe(() => condRelative(ticks, end, cfg)),
    proximity: safe(() => condProximity(side, spot, strike, cfg)),
    stalled: safe(() => condStalled(side, ticks, end, cfg)),
  };
  const failed = CONDITION_NAMES.filter((n) => conditions[n].pass === false);
  const unverifiedNames = CONDITION_NAMES.filter((n) => conditions[n].pass !== true && conditions[n].pass !== false);
  const allPass = CONDITION_NAMES.every((n) => conditions[n].pass === true);
  return {
    base,
    strict: Boolean(base && allPass),
    conditions,
    failed,
    unverified: unverifiedNames,
    direction: side > 0 ? "BULLISH" : "BEARISH",
    blitzFlag: side > 0 ? Boolean(om?.floorPutWritingBlitz) : Boolean(om?.roofCallWritingBlitz),
  };
}

/**
 * @returns null when disabled (TRAP_SHADOW_ENABLED=false/0), otherwise
 *   { enabled, minutes, quadrant, deltaPcr, spot, floorStrike, roofStrike, rearmMin, bearTrap, bullTrap }
 */
export function evaluateShadowTraps({ quadrant = null, optionsMetrics = null, spot = null, floorStrike = null, roofStrike = null, timeline = [], nowMins = null, config = null } = {}) {
  try {
    const cfg = { ...TRAP_SHADOW_DEFAULTS, ...(config || {}) };
    if (!cfg.enabled) return null;
    let ticks = realTicks(timeline, fin(nowMins) ? Number(nowMins) : NaN);
    const end = fin(nowMins) ? Number(nowMins) : ticks.length ? Number(ticks[ticks.length - 1].minutes) : NaN;
    if (!Number.isFinite(end)) ticks = [];
    const common = { quadrant, optionsMetrics, spot, ticks, end, cfg };
    return {
      enabled: true,
      minutes: Number.isFinite(end) ? end : null,
      quadrant: quadrant || null,
      deltaPcr: fin(optionsMetrics?.deltaPcr) ? Number(optionsMetrics.deltaPcr) : null,
      spot: fin(spot) ? Number(spot) : null,
      floorStrike: fin(floorStrike) ? Number(floorStrike) : null,
      roofStrike: fin(roofStrike) ? Number(roofStrike) : null,
      rearmMin: cfg.rearmMin,
      bearTrap: evaluateSide(+1, { ...common, strike: floorStrike }),
      bullTrap: evaluateSide(-1, { ...common, strike: roofStrike }),
    };
  } catch (e) {
    return null;
  }
}

/** Compact display form for the API payload (display only; nothing server-side reads it). */
export function compactTrapShadow(ts) {
  if (!ts) return null;
  const side = (x) => (x ? { base: x.base, strict: x.strict, failed: x.failed, unverified: x.unverified, direction: x.direction } : null);
  return { enabled: true, minutes: ts.minutes, quadrant: ts.quadrant, bearTrap: side(ts.bearTrap), bullTrap: side(ts.bullTrap), note: "shadow rules — measurement only, no decision uses this" };
}
