/**
 * Daily scorecard — MEASUREMENT ONLY.
 *
 * Records what each section of the scanner said during a session and measures what futures price
 * did afterwards, so thresholds can be set from evidence after 20–30 sessions. Nothing here feeds a
 * decision, veto, score, alert or dispatch, and it makes no NSE calls: it only reads values the
 * scanner already computed and the per-minute timeline it already stores.
 *
 * Storage (Redis, TTL 180 days):
 *   nifty:sc:events:<date>   append-only list of events (RPUSH, capped at SC_MAX_EVENTS_PER_DAY)
 *   nifty:sc:state:<date>    small change-detection state (previous quadrant, stages seen, …)
 *   nifty:sc:day:<date>      the compact day document written at finalisation
 *   nifty:sc:eod_pending     the last final EOD verdict waiting for the next session's open
 *
 * Outcomes are measured on NIFTY futures (never the spot index, which freezes 15:15–15:30), using only
 * windows that pass the data-coverage rule (src/dataQuality.js); otherwise UNMEASURABLE with reason.
 *
 * Pure functions + small DI'd I/O helpers (store adapter: get, set, setNx, del, rpush, ltrim, lrange,
 * expire, incr, mget).
 */
import { windowCoverage, hhmm, DQ_GAP_LIST_MIN, DQ_GAP_ALERT_MIN, DQ_WINDOW_MAX_GAP_MIN, DQ_WINDOW_MIN_COVERAGE_PCT, DQ_STALE_AFTER_SEC } from "./dataQuality.js";
import { getSessionKindForDate } from "./marketCalendar.js";
import { TRAP_SHADOW_ENV_KEYS } from "./trapShadow.js";
import { measurePlanCall, getPlanDocConfig, PLAN_DOC_ENV_KEYS } from "./planDocShadow.js";
import { firstLiveIndex } from "./sessionOpen.js";
import { isCandidateTelegramEnabled, formatCandidateOutcomeLine } from "./candidateShadow.js";
import { ivCuts, ivBandOf, IV_BANDS } from "./ivShadow.js";
import { evaluateDayExitRules, formatExitRuleLines } from "./exitRuleShadow.js";
import { evaluateDayOverrides, formatOverrideLines } from "./overrideCost.js";

export const SC_TTL_SEC = 180 * 86400;
export const SC_MAX_EVENTS_PER_DAY = 300; // worst-case day document ≈ 300 × ~1.4 KB + ~30 KB series < 0.5 MB
export const SC_CLOSE_MEASURE_MINS = 938; // 15:38: last minute used for "to the close" outcomes
export const SC_OPEN_MINS = 555; // 09:15
export const SC_EOD_CHECK_MINS = 560; // 09:20
export const SC_HORIZONS = [15, 30, 60];
export const SC_MIN_SAMPLE = 30;
export const SC_NO_CARRY_BAND_PCT = 0.35;

export const keys = {
  events: (d) => `nifty:sc:events:${d}`,
  state: (d) => `nifty:sc:state:${d}`,
  day: (d) => `nifty:sc:day:${d}`,
  dedupe: (d, k) => `nifty:sc:ev:${d}:${k}`,
  dropped: (d) => `nifty:sc:dropped:${d}`,
  finLock: (d) => `nifty:sc:finalising:${d}`,
  tgDaily: (d) => `nifty:sc:tg:${d}`,
  tgMorning: (d) => `nifty:sc:tg_eod:${d}`,
  eodPending: "nifty:sc:eod_pending",
  outside: (d) => `nifty:sc:outside:${d}`, // owner-logged trades taken outside the system (override cost)
};

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** FUSION events: minutes after an emitted change before the same stream may emit again (0 = every change). */
export const SC_FUSION_REARM_MIN = 10;

function nonNegative(v, d) {
  if (v === undefined || v === null || String(v).trim() === "") return d;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}

export function getScorecardConfig(env = process.env) {
  return {
    enabled: String(env.SCORECARD_ENABLED ?? "true").trim().toLowerCase() !== "false",
    bandPct: num(env.SCORECARD_BAND_PCT, 0.2),
    minSample: Math.round(num(env.SCORECARD_MIN_SAMPLE, SC_MIN_SAMPLE)),
    noCarryBandPct: num(env.SCORECARD_NO_CARRY_BAND_PCT, SC_NO_CARRY_BAND_PCT),
    fusionRearmMin: nonNegative(env.SCORECARD_FUSION_REARM_MIN, SC_FUSION_REARM_MIN),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Hit rules (fixed; documented in docs/scorecard.md)
// ─────────────────────────────────────────────────────────────────────────────
export const HIT_RULES = {
  FUSION: "Directional: futures reach +band in the event's direction before −band, within 60 minutes (band 0.20%).",
  TURN: "Directional: futures reach +band in the event's direction before −band, within 60 minutes (band 0.20%).",
  RADAR: "Directional: futures reach +band in the event's direction before −band, within 60 minutes (band 0.20%).",
  TRAP_SHADOW: "Directional: futures reach +band in the event's direction before −band, within 60 minutes (band 0.20%). Shadow trap rules (current vs tighter) — no decision uses them.",
  EOD_SLOT: "Directional: futures reach +band in the verdict's direction before −band, within 60 minutes (band 0.20%).",
  EOD: "BTST/STBT: next session's 09:20 futures price is beyond the final reading's reference in the verdict's direction. NO CARRY: |09:20 − reference| < 0.35%.",
  SIGNAL: "Futures-equivalent T1 is reached before the stop, within the same session (approved and vetoed alike).",
  CANDIDATE: "Same rule as SIGNAL: futures-equivalent T1 is reached before the stop, within the same session. Shadow candidate alerts judged against the real option chain — no orders, no Telegram.",
  TRADE: "The Algo-reported rupee result is above zero, counted only when the Algo says every account's exit price is known.",
  PLAN_DOC: "Plan document (Gemini) half-day call vs the futures move over its window (first tick at/after the start → last tick at/before the end, ±0.15% band): BULLISH = UP, BEARISH = DOWN, RANGE = FLAT. UNPARSED calls are not scored. Compare with the outcome mix (base rate). Shadow — feeds nothing.",
};

// ─────────────────────────────────────────────────────────────────────────────
//  Settings snapshot (non-secret values only)
// ─────────────────────────────────────────────────────────────────────────────
const ENV_WHITELIST = [
  "FUSION_QUADRANT_MODE", "FUSION_INTRADAY_WINDOW_MINS", "FLOW_MAX_AGE_SEC", "FLOW_BLIND_ALERT_SEC", "FLOW_REFRESH_TIMEOUT_MS",
  "EOD_FLIP_MIN_GAP_SECONDS", "POLL_MIN_INTERVAL_SEC", "POLLER_DOWN_ALERT_SEC",
  "TURN_NOISE_PCT", "TURN_OI_NOISE_PCT", "TURN_OPTIONS_MIN_NET", "REVERSAL_MIN_MOVE_PCT", "REVERSAL_MIN_OI_PCT", "REVERSAL_MIN_ELAPSED_MIN",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS", "FLOW_BRIDGE_FILL_WAIT_SEC", "FLOW_ALGO_SQUAREOFF_TIME",
  "CARRY_BRIDGE_ENABLED", "CARRY_WINDOW_START", "CARRY_WINDOW_END", "CARRY_REPORT_TIME", "CARRY_REQUIRED_POLLS", "CARRY_MIN_AGREEMENT", "CARRY_MIN_POLL_GAP_SEC",
  "SCORECARD_ENABLED", "SCORECARD_BAND_PCT", "SCORECARD_MIN_SAMPLE", "SCORECARD_NO_CARRY_BAND_PCT", "SCORECARD_FUSION_REARM_MIN",
  "CANDIDATE_SHADOW_ENABLED", "CANDIDATE_TELEGRAM_ENABLED",
  ...TRAP_SHADOW_ENV_KEYS,
  ...PLAN_DOC_ENV_KEYS,
];

/**
 * @param {object} p  `constants` is supplied by the caller (api/nifty-oi.js) so this module stays pure.
 */
export function settingsSnapshot({ env = process.env, constants = {} } = {}) {
  const envOverrides = {};
  for (const k of ENV_WHITELIST) if (env[k] !== undefined && env[k] !== "") envOverrides[k] = String(env[k]).slice(0, 120);
  return {
    takenAt: null,
    dataQuality: { gapListMin: DQ_GAP_LIST_MIN, gapAlertMin: DQ_GAP_ALERT_MIN, windowMaxGapMin: DQ_WINDOW_MAX_GAP_MIN, windowMinCoveragePct: DQ_WINDOW_MIN_COVERAGE_PCT, staleAfterSec: DQ_STALE_AFTER_SEC },
    scorecard: getScorecardConfig(env),
    ...constants,
    envOverrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Event capture (pure)
// ─────────────────────────────────────────────────────────────────────────────
const QUAD_DIR = { LONG_BUILDUP: "BULLISH", SHORT_COVERING: "BULLISH", SHORT_BUILDUP: "BEARISH", LONG_UNWINDING: "BEARISH" };
const SCEN_DIR = { BULLISH_SYNERGY: "BULLISH", BEAR_TRAP: "BULLISH", BEARISH_SYNERGY: "BEARISH", BULL_TRAP: "BEARISH" };
const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

function baseEvent(reading, section, type, direction, data, dq, key) {
  return {
    id: `${section}:${type}:${reading.minutes}:${key || ""}`.slice(0, 120),
    key: key || null,
    t: reading.t,
    time: hhmm(reading.minutes),
    minutes: reading.minutes,
    section,
    type,
    direction: direction || null,
    futPrice: r2(reading.futPrice),
    spot: r2(reading.spot),
    data,
    dq,
  };
}

/**
 * @param {object} prev   previous state (or null for the first reading of the day)
 * @param {object} reading { t, minutes, futPrice, spot, futuresExpiry, dq:{state,coveragePct},
 *   fusion:{quadrant, scenario}, turn (turnTracker), radar (macroTurn), eod:{verdict,bias,score,
 *   groups:{A,B,C}, unverifiedGroups, slot, category, stopLoss} }
 * @param {object} [opts] { fusionRearmMin } — default SC_FUSION_REARM_MIN (recordReading passes the env value)
 * @returns {{ events: object[], state: object }}  never mutates its inputs
 */
export function captureEvents(prev, reading, opts = {}) {
  const s = prev ? JSON.parse(JSON.stringify(prev)) : { fusionQuadrant: null, fusionScenario: null, turn: {}, radarKeys: [], eod: { lastSlot: null, lastCategory: null, last: null } };
  const events = [];
  const sessionDq = { ok: reading.dq?.state === "OK", state: reading.dq?.state || null, coveragePct: reading.dq?.coveragePct ?? null };

  // Fusion (whole day), per stream (quadrant, scenario): a change event only when the value differs
  // from the last EMITTED value and at least `rearmMin` minutes have passed since that emit, so
  // flicker (16-Nov 14:02–14:11) counts once. `from` is the last emitted value. The first value of
  // the day initialises the stream without an event. s.fusionQuadrant / s.fusionScenario still track
  // the latest reading. A state written before this rule (no `fusionEmit`) starts from the stored
  // latest value with no emit time, so its next change emits.
  const rearmMin = nonNegative(opts.fusionRearmMin, SC_FUSION_REARM_MIN);
  if (!s.fusionEmit || typeof s.fusionEmit !== "object") s.fusionEmit = {};
  const fusionStream = (name, latestKey, value, type, dirMap) => {
    if (!s.fusionEmit[name] || typeof s.fusionEmit[name] !== "object") {
      s.fusionEmit[name] = { lastEmitted: s[latestKey] || null, lastEmitMinutes: null };
    }
    const st = s.fusionEmit[name];
    if (!value) return;
    if (!st.lastEmitted) {
      st.lastEmitted = value;
    } else if (value !== st.lastEmitted && (st.lastEmitMinutes == null || !Number.isFinite(Number(reading.minutes)) || Number(reading.minutes) - Number(st.lastEmitMinutes) >= rearmMin)) {
      events.push(baseEvent(reading, "FUSION", type, dirMap[value] || null, { from: st.lastEmitted, to: value }, sessionDq, `${st.lastEmitted}>${value}`));
      st.lastEmitted = value;
      st.lastEmitMinutes = Number.isFinite(Number(reading.minutes)) ? Number(reading.minutes) : null;
    }
    s[latestKey] = value;
  };
  fusionStream("quadrant", "fusionQuadrant", reading.fusion?.quadrant || null, "QUADRANT_CHANGE", QUAD_DIR);
  fusionStream("scenario", "fusionScenario", reading.fusion?.scenario || null, "SCENARIO_CHANGE", SCEN_DIR);

  // Turn Tracker: each stage transition per extreme.
  const tt = reading.turn;
  if (tt && tt.status === "OK" && tt.direction && ["EARLY", "LIKELY_TURN", "CONFIRMED"].includes(tt.stage)) {
    const rank = { EARLY: 1, LIKELY_TURN: 2, CONFIRMED: 3 }[tt.stage];
    const k = `${tt.direction}:${tt.reference?.minutes}`;
    if (rank > (s.turn[k] || 0)) {
      s.turn[k] = rank;
      const f = tt.futuresLeg || {};
      const o = tt.optionsLeg || {};
      events.push(baseEvent(reading, "TURN", tt.stage, tt.direction, {
        stage: tt.stage, extreme: { time: tt.reference?.time, price: tt.reference?.price, kind: tt.reference?.kind },
        futures: { movePts: f.movePts, movePct: f.movePct, oiChange: f.oiChange, oiPct: f.oiPct, quadrant: f.quadrant },
        options: { putLegDelta: o.putLegDelta, callLegDelta: o.callLegDelta, netDelta: o.netDelta, driver: o.driver, dominantLeg: o.dominantLeg, deltaPcrAtExtreme: o.deltaPcrAtExtreme, deltaPcrNow: o.deltaPcrNow },
        elapsedMin: tt.elapsedMin,
      }, { ok: Boolean(tt.coverage?.ok), coveragePct: tt.coverage?.coveragePct ?? null, text: tt.coverage?.text || null }, k));
    }
  }

  // 30-minute radar: declared turns/traps and "divergence, not a trap".
  const mt = reading.radar;
  if (mt && (mt.isTriggered || mt.type === "UNWINDING_DIVERGENCE" || mt.type === "MIXED_DIVERGENCE")) {
    // One event per declared turn: keyed on the type and the window start (C2 grows minute by minute).
    const k = `${mt.type}:${String(mt.window || "").split("-")[0]}`;
    if (!s.radarKeys.includes(k)) {
      s.radarKeys = [...s.radarKeys, k].slice(-50);
      const dir = mt.direction === "BULLISH_TURN" || mt.direction === "BULLISH_LEAN" ? "BULLISH" : mt.direction === "BEARISH_TURN" || mt.direction === "BEARISH_LEAN" ? "BEARISH" : null;
      events.push(baseEvent(reading, "RADAR", mt.isTriggered ? mt.type : "DIVERGENCE", dir, {
        type: mt.type, window: mt.window, priceSource: mt.priceSource, totalPriceDelta: mt.totalPriceDelta,
        netDelta: mt.flow?.netDelta ?? null, putLegDelta: mt.flow?.putLegDelta ?? null, callLegDelta: mt.flow?.callLegDelta ?? null, driver: mt.flow?.driver ?? null,
      }, { ok: true, text: null }, k));
    }
  }

  // EOD: each scheduled slot and each flip; the last reading at or before 15:38 becomes FINAL.
  const e = reading.eod;
  if (e && e.slot !== null && e.slot !== undefined) {
    const dir = e.category === "BTST" ? "BULLISH" : e.category === "STBT" ? "BEARISH" : null;
    const data = {
      verdict: e.verdict, category: e.category, score: e.score,
      groups: { A: e.groups?.A ?? null, B: e.groups?.B ?? null, C: e.groups?.C ?? null },
      unverifiedGroups: e.unverifiedGroups || [], stopLoss: e.stopLoss ?? null, slot: hhmm(e.slot),
    };
    const eodDq = { ok: !(e.unverifiedGroups || []).length, text: (e.unverifiedGroups || []).length ? `UNVERIFIED group(s) ${e.unverifiedGroups.join(", ")}` : null };
    if (e.slot !== s.eod.lastSlot) events.push(baseEvent(reading, "EOD_SLOT", "SLOT", dir, data, eodDq, `slot:${e.slot}`));
    else if (s.eod.lastCategory && e.category !== s.eod.lastCategory) events.push(baseEvent(reading, "EOD_SLOT", "FLIP", dir, { ...data, from: s.eod.lastCategory }, eodDq, `flip:${reading.minutes}`));
    s.eod.lastSlot = e.slot;
    s.eod.lastCategory = e.category;
    if (reading.minutes <= SC_CLOSE_MEASURE_MINS) {
      s.eod.last = { ...data, minutes: reading.minutes, t: reading.t, futPrice: r2(reading.futPrice), spot: r2(reading.spot), futuresExpiry: reading.futuresExpiry || null, dq: eodDq };
    }
  }

  // Shadow trap rules (src/trapShadow.js): rising edge per variant; re-armed only after the variant
  // has been false for rearmMin minutes (first false reading → a false reading ≥ rearmMin later),
  // so a flickering label is counted once.
  const ts = reading.trapShadow;
  if (ts && ts.enabled !== false && Number.isFinite(Number(reading.minutes))) {
    const m = Number(reading.minutes);
    const rearm = Number(ts.rearmMin) > 0 ? Number(ts.rearmMin) : TRAP_SHADOW_REARM_MIN;
    if (!s.trapShadow || typeof s.trapShadow !== "object") s.trapShadow = {};
    for (const [variant, sideKey, mode] of TRAP_SHADOW_VARIANTS) {
      const side = ts[sideKey];
      if (!side) continue;
      const on = Boolean(side[mode]);
      const st = s.trapShadow[variant] || { armed: true, falseSince: null };
      if (on) {
        if (st.armed) {
          const strikeKey = sideKey === "bearTrap" ? "floorStrike" : "roofStrike";
          events.push(baseEvent(reading, "TRAP_SHADOW", variant, side.direction || (sideKey === "bearTrap" ? "BULLISH" : "BEARISH"), {
            variant, base: Boolean(side.base), strict: Boolean(side.strict),
            conditions: side.conditions || null, failed: side.failed || [], unverified: side.unverified || [],
            quadrant: ts.quadrant ?? null, deltaPcr: ts.deltaPcr ?? null, [strikeKey]: ts[strikeKey] ?? null, spotAtEvent: ts.spot ?? null,
          }, sessionDq, variant));
          st.armed = false;
        }
        st.falseSince = null;
      } else if (!st.armed) {
        if (st.falseSince === null) st.falseSince = m;
        if (m - st.falseSince >= rearm) { st.armed = true; st.falseSince = null; }
      }
      s.trapShadow[variant] = st;
    }
  }
  return { events, state: s };
}

export const TRAP_SHADOW_REARM_MIN = 10;
/** [variant, side in the shadow result, which flag] */
export const TRAP_SHADOW_VARIANTS = [
  ["BEAR_TRAP_BASE", "bearTrap", "base"],
  ["BEAR_TRAP_STRICT", "bearTrap", "strict"],
  ["BULL_TRAP_BASE", "bullTrap", "base"],
  ["BULL_TRAP_STRICT", "bullTrap", "strict"],
];

/** FINAL EOD event from the state's last reading at or before 15:38. */
export function finalEodEvent(state) {
  const last = state?.eod?.last;
  if (!last) return null;
  const dir = last.category === "BTST" ? "BULLISH" : last.category === "STBT" ? "BEARISH" : null;
  return {
    id: `EOD:FINAL:${last.minutes}:`, key: "final", t: last.t, time: hhmm(last.minutes), minutes: last.minutes,
    section: "EOD", type: "FINAL", direction: dir, futPrice: last.futPrice, spot: last.spot,
    data: { ...last, dq: undefined }, dq: last.dq, futuresExpiry: last.futuresExpiry || null,
  };
}

/** SIGNAL event from a fused TradingView verdict (after every decision was made). */
export function buildSignalEvent(fused, nowMs) {
  const ist = istOf(nowMs);
  const dec = String(fused?.decision || "");
  const category = dec.startsWith("EXECUTE")
    ? (fused.execution?.status === "NOT_EXECUTED" ? "NOT_EXECUTED" : "APPROVED")
    : dec.startsWith("VETO") ? "VETOED" : dec === "BLOCKED_BY_ACTIVE_TRADE" ? "BLOCKED" : dec === "DOWNGRADE_TO_SCALP" ? "DOWNGRADED" : "OTHER";
  const reason = category === "APPROVED" ? null : category === "NOT_EXECUTED" ? (fused.execution?.reason || fused.execution?.outcome || null) : String(fused?.reasoning || "").slice(0, 200);
  return {
    id: `SIGNAL:${fused?.grade}:${ist.minutes}:${nowMs}`,
    key: String(nowMs),
    t: nowMs,
    time: hhmm(ist.minutes),
    minutes: ist.minutes,
    section: "SIGNAL",
    type: String(fused?.grade || "SIGNAL"),
    direction: fused?.direction === "LONG" ? "BULLISH" : fused?.direction === "SHORT" ? "BEARISH" : null,
    futPrice: null,
    spot: r2(fused?.entryPrice),
    data: {
      grade: fused?.grade, decision: dec, category, reason, tradeId: fused?.tradeId || null,
      execution: fused?.execution?.status || null, entry: r2(fused?.entryPrice), sl: r2(fused?.stopLoss), t1: r2(fused?.target1Price), t2: r2(fused?.target2Price),
      snapshotAgeSec: fused?.liveOptionChainMetrics?.snapshotAgeSec ?? null,
      iv: fused?.ivShadow ?? null, // IV shadow (src/ivShadow.js), measurement only
    },
    dq: { ok: fused?.decision !== "VETO_STALE_OPTION_CHAIN", text: fused?.snapshotProvenance || null },
  };
}

/**
 * CANDIDATE event from a shadow candidate record (src/candidateShadow.js buildCandidateRecord).
 * Same shape as a SIGNAL event (spot entry, sl, t1, t2 in data) so measureSignal applies unchanged.
 */
export function buildCandidateEvent(rec, nowMs) {
  const ist = istOf(nowMs);
  return {
    id: `CANDIDATE:${rec?.grade}:${ist.minutes}:${nowMs}`,
    key: String(nowMs),
    t: nowMs,
    time: hhmm(ist.minutes),
    minutes: ist.minutes,
    section: "CANDIDATE",
    type: String(rec?.grade || "CANDIDATE"),
    direction: rec?.direction === "LONG" ? "BULLISH" : rec?.direction === "SHORT" ? "BEARISH" : null,
    futPrice: null,
    spot: r2(rec?.entry),
    data: {
      realGrade: rec?.realGrade ?? null, category: rec?.category ?? null, decision: rec?.realDecision ?? null,
      entry: r2(rec?.entry), sl: r2(rec?.sl), t1: r2(rec?.t1), t2: r2(rec?.t2),
      deltaPcr: rec?.deltaPcr ?? null, serverFutQuad: rec?.serverFutQuad ?? null, chartFutQuad: rec?.chartFutQuad ?? null,
      snapshotAgeSec: rec?.snapshotAgeSec ?? null,
      iv: rec?.iv ?? null,
    },
    dq: { ok: rec?.category !== "UNVERIFIABLE", text: rec?.category === "UNVERIFIABLE" ? "no fresh option-chain snapshot / ΔPCR" : null },
  };
}

/**
 * PLAN_DOC events from a stored plan-document snapshot (src/planDocShadow.js buildPlanSnapshot):
 * one per parsed half-day call. Shadow only — measured by measurePlanCall, never in Telegram.
 */
export function buildPlanEvents(snapshot) {
  const calls = snapshot?.parsed?.calls;
  const date = String(snapshot?.date || "");
  if (!Array.isArray(calls) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const dayStartUtc = Date.parse(`${date}T00:00:00Z`);
  const late = Boolean(snapshot.late);
  return calls.filter((c) => c && ["FIRST", "SECOND", "FULL"].includes(c.half) && Number.isFinite(Number(c.startMins))).map((c) => {
    const startMins = Number(c.startMins);
    return {
      id: `PLAN_DOC:${c.half}:${startMins}:`,
      key: c.half,
      t: dayStartUtc + (startMins - 330) * 60000,
      time: hhmm(startMins),
      minutes: startMins,
      section: "PLAN_DOC",
      type: c.half,
      direction: c.call === "BULLISH" || c.call === "BEARISH" ? c.call : null,
      futPrice: null,
      spot: null,
      data: {
        half: c.half, call: c.call, phrase: c.phrase ?? null, reason: c.reason ?? null, conviction: snapshot.parsed?.conviction ?? null,
        startMins, endMins: Number(c.endMins), late, source: snapshot.source ?? null,
      },
      dq: { ok: true, text: late ? "late snapshot (dashboard cache read at the first live poll, not before the open)" : null },
    };
  });
}

/** TRADE event (Algo-owned intraday exit or carry exit) with the Algo's rupee result. */
export function buildTradeEvent({ kind, tradeId, exitGrade, direction, entry, exitPrice, pnlInr, pnlKnown, accountsCount, qty = null, closeReason = null, nowMs }) {
  const ist = istOf(nowMs);
  return {
    id: `TRADE:${kind}:${tradeId || nowMs}:${exitGrade}`,
    key: String(tradeId || nowMs),
    t: nowMs,
    time: hhmm(ist.minutes),
    minutes: ist.minutes,
    section: "TRADE",
    type: kind,
    direction: direction === "LONG" ? "BULLISH" : direction === "SHORT" ? "BEARISH" : direction || null,
    futPrice: null,
    spot: r2(exitPrice),
    data: { kind, tradeId: tradeId || null, exitGrade, entry: r2(entry), exitPrice: r2(exitPrice), pnlInr: Number.isFinite(Number(pnlInr)) ? Number(pnlInr) : null, pnlKnown: typeof pnlKnown === "boolean" ? pnlKnown : null, accounts: accountsCount ?? null,
      ...(Number.isFinite(Number(qty)) && Number(qty) > 0 ? { qty: Number(qty) } : {}),
      ...(closeReason ? { closeReason: String(closeReason).slice(0, 120) } : {}) },
    dq: { ok: true, text: null },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Series (compact per-minute record) and outcomes (pure)
// ─────────────────────────────────────────────────────────────────────────────
/** Compact columnar series: m minutes, f futures, o OI, v cumulative futures volume, s spot, p put writing, c call writing. */
export function compactSeries(timeline = []) {
  const ticks = (Array.isArray(timeline) ? timeline : [])
    .filter((p) => p && p.synthetic !== true && Number.isFinite(Number(p.minutes)))
    .slice().sort((a, b) => a.minutes - b.minutes);
  const pick = (k, d, positiveOnly = true) => ticks.map((p) => {
    const v = Number(p[k]);
    if (p[k] === null || p[k] === undefined || !Number.isFinite(v) || (positiveOnly && !(v > 0))) return null;
    return Math.round(v * 10 ** d) / 10 ** d;
  });
  return {
    m: ticks.map((p) => Math.round(p.minutes)),
    f: pick("futPrice", 2),
    o: pick("futCombinedOI", 0),
    v: pick("futVolume", 0),
    s: pick("spot", 2),
    p: pick("putWriting", 0, false),
    c: pick("callWriting", 0, false),
  };
}

/** Futures ticks [{minutes, futPrice, spot}] from a compact series. */
export function futTicks(series) {
  const out = [];
  if (!series?.m) return out;
  for (let i = 0; i < series.m.length; i++) {
    if (Number(series.f[i]) > 0) out.push({ minutes: series.m[i], futPrice: series.f[i], spot: series.s?.[i] ?? null });
  }
  return out;
}

const lastAtOrBefore = (ticks, m) => {
  let best = null;
  for (const t of ticks) if (t.minutes <= m) best = t;
  return best;
};

/**
 * Directional outcome on futures: forward moves at +15/+30/+60 and the close, MFE/MAE within 60
 * minutes and to the close, and which side of a symmetric band came first within 60 minutes.
 */
export function measureDirectional(event, series, { bandPct = 0.2 } = {}) {
  const dir = event.direction === "BULLISH" ? 1 : event.direction === "BEARISH" ? -1 : 0;
  if (!dir) return { status: "NOT_DIRECTIONAL" };
  const ticks = futTicks(series).filter((t) => t.minutes <= SC_CLOSE_MEASURE_MINS);
  const m0 = event.minutes;
  const p0 = Number(event.futPrice) > 0 ? Number(event.futPrice) : lastAtOrBefore(ticks, m0)?.futPrice;
  if (!(p0 > 0)) return { status: "UNMEASURABLE", reason: "no futures price at the event" };
  if (m0 >= SC_CLOSE_MEASURE_MINS) return { status: "UNMEASURABLE", reason: "event at or after 15:38" };
  const cov = (a, b, label) => windowCoverage(ticks, a, b, { label });
  const pts = (p) => Math.round(dir * (p - p0) * 100) / 100;
  const pct = (p) => Math.round(((dir * (p - p0)) / p0) * 100000) / 1000;

  const horizons = {};
  for (const h of [...SC_HORIZONS, "close"]) {
    const target = h === "close" ? SC_CLOSE_MEASURE_MINS : m0 + h;
    if (target > SC_CLOSE_MEASURE_MINS) { horizons[h] = { status: "AFTER_CLOSE" }; continue; }
    const c = cov(m0, target, `+${h} window ${hhmm(m0)}–${hhmm(target)}`);
    if (!c.ok) { horizons[h] = { status: "UNMEASURABLE", reason: c.text }; continue; }
    const p = lastAtOrBefore(ticks, target).futPrice;
    horizons[h] = { status: "OK", price: p, pts: pts(p), pct: pct(p) };
  }

  const excursion = (end, label) => {
    const c = cov(m0, end, label);
    if (!c.ok) return { status: "UNMEASURABLE", reason: c.text };
    let mfe = 0;
    let mae = 0;
    for (const t of ticks) {
      if (t.minutes <= m0 || t.minutes > end) continue;
      mfe = Math.max(mfe, pts(t.futPrice));
      mae = Math.min(mae, pts(t.futPrice));
    }
    return { status: "OK", mfePts: mfe, maePts: mae, mfePct: Math.round((mfe / p0) * 100000) / 1000, maePct: Math.round((mae / p0) * 100000) / 1000 };
  };
  const end60 = Math.min(m0 + 60, SC_CLOSE_MEASURE_MINS);
  const exc60 = excursion(end60, `60-min window ${hhmm(m0)}–${hhmm(end60)}`);
  const excClose = excursion(SC_CLOSE_MEASURE_MINS, `window ${hhmm(m0)}–15:38`);

  // Band-first within 60 minutes.
  const band = (p0 * bandPct) / 100;
  let bandFirst = null;
  let resolvedAt = null;
  for (const t of ticks) {
    if (t.minutes <= m0 || t.minutes > end60) continue;
    const d = dir * (t.futPrice - p0);
    if (d >= band) { bandFirst = "FAVOURABLE"; resolvedAt = t.minutes; break; }
    if (d <= -band) { bandFirst = "ADVERSE"; resolvedAt = t.minutes; break; }
  }
  let band60;
  if (bandFirst) {
    const c = cov(m0, resolvedAt, `band window ${hhmm(m0)}–${hhmm(resolvedAt)}`);
    band60 = c.ok ? { status: "OK", first: bandFirst, at: hhmm(resolvedAt), bandPct } : { status: "UNMEASURABLE", reason: c.text };
  } else if (m0 + 60 > SC_CLOSE_MEASURE_MINS) {
    band60 = { status: "UNMEASURABLE", reason: `60-min window cut by the 15:38 close (neither ±${bandPct}% reached by then)` };
  } else {
    const c = cov(m0, m0 + 60, `60-min window ${hhmm(m0)}–${hhmm(m0 + 60)}`);
    band60 = c.ok ? { status: "OK", first: "NEITHER", at: null, bandPct } : { status: "UNMEASURABLE", reason: c.text };
  }
  const measurable = band60.status === "OK";
  return {
    status: measurable ? "MEASURED" : "UNMEASURABLE",
    reason: measurable ? null : band60.reason,
    refPrice: p0,
    horizons,
    excursion60: exc60,
    excursionClose: excClose,
    band60,
    hit: measurable ? band60.first === "FAVOURABLE" : null,
  };
}

/** TradingView signal: futures-equivalent T1 vs stop, first reached within the same session. */
export function measureSignal(event, series) {
  const d = event.data || {};
  const dir = event.direction === "BULLISH" ? 1 : event.direction === "BEARISH" ? -1 : 0;
  const ticks = futTicks(series).filter((t) => t.minutes <= SC_CLOSE_MEASURE_MINS);
  if (!dir || !(Number(d.t1) > 0) || !(Number(d.sl) > 0)) return { status: "UNMEASURABLE", reason: "signal has no T1 / stop levels" };
  const m0 = event.minutes;
  if (!(m0 >= SC_OPEN_MINS && m0 < SC_CLOSE_MEASURE_MINS)) return { status: "UNMEASURABLE", reason: "signal outside the session window" };
  const t0 = lastAtOrBefore(ticks, m0);
  if (!t0 || m0 - t0.minutes > DQ_WINDOW_MAX_GAP_MIN || !(Number(t0.spot) > 0)) return { status: "UNMEASURABLE", reason: "no futures/spot tick at the signal time" };
  const basis = t0.futPrice - t0.spot;
  const t1f = Number(d.t1) + basis;
  const slf = Number(d.sl) + basis;
  let first = null;
  let at = null;
  for (const t of ticks) {
    if (t.minutes <= m0) continue;
    const hitT1 = dir > 0 ? t.futPrice >= t1f : t.futPrice <= t1f;
    const hitSl = dir > 0 ? t.futPrice <= slf : t.futPrice >= slf;
    if (hitSl) { first = "STOP"; at = t.minutes; break; } // same tick → stop counted first (conservative)
    if (hitT1) { first = "T1"; at = t.minutes; break; }
  }
  const end = first ? at : SC_CLOSE_MEASURE_MINS;
  const c = windowCoverage(ticks, t0.minutes, end, { label: `signal window ${hhmm(t0.minutes)}–${hhmm(end)}` });
  if (!c.ok) return { status: "UNMEASURABLE", reason: c.text, basis: r2(basis) };
  return { status: "MEASURED", first: first || "NEITHER", at: at ? hhmm(at) : null, basis: r2(basis), t1Fut: r2(t1f), slFut: r2(slf), hit: first === "T1" };
}

/** Next-session outcome of a FINAL EOD verdict: open and 09:20 futures vs the final reference. */
export function measureEodNext(final, nextSeries, { nextDate, noCarryBandPct = SC_NO_CARRY_BAND_PCT, nextFuturesExpiry = null } = {}) {
  const ref = Number(final?.futPrice);
  if (!(ref > 0)) return { status: "UNMEASURABLE", reason: "final reading has no futures reference" };
  if (final.futuresExpiry && nextFuturesExpiry && final.futuresExpiry !== nextFuturesExpiry) {
    return { status: "UNMEASURABLE", reason: `futures contract rolled (${final.futuresExpiry} → ${nextFuturesExpiry})`, nextDate };
  }
  const ticks = futTicks(nextSeries);
  const open = ticks.find((t) => t.minutes >= SC_OPEN_MINS && t.minutes <= SC_OPEN_MINS + DQ_WINDOW_MAX_GAP_MIN);
  const c = windowCoverage(ticks, SC_OPEN_MINS, SC_EOD_CHECK_MINS, { label: "the next session's 09:15–09:20 window" });
  if (!open || !c.ok) return { status: "UNMEASURABLE", reason: !open ? "no futures tick in the first minutes of the next session" : c.text, nextDate };
  // The 09:20 price is the last tick AT OR BEFORE 09:20; when 09:20 itself is missing that is an
  // earlier minute, and the outcome says which (price0920At) instead of calling it 09:20.
  const t920 = lastAtOrBefore(ticks, SC_EOD_CHECK_MINS);
  const p920 = t920.futPrice;
  const category = final.data?.category ?? final.category;
  const dir = category === "BTST" ? 1 : category === "STBT" ? -1 : 0;
  const movePct = Math.round(((p920 - ref) / ref) * 100000) / 1000;
  // The displayed open is the first LIVE tick: leading carry-over quotes (the previous session's price,
  // see src/sessionOpen.js) are skipped. Status and the 09:20 hit rule are unaffected.
  const live = firstLiveIndex(nextSeries);
  let openTick = open;
  if (live.skipped > 0) {
    const lt = ticks.find((t) => t.minutes >= Number(live.minutes));
    if (lt) openTick = lt;
  }
  const out = {
    status: "MEASURED", nextDate, refPrice: ref, openPrice: openTick.futPrice, openAt: hhmm(openTick.minutes), price0920: p920,
    price0920At: hhmm(t920.minutes),
    openGapPts: r2(openTick.futPrice - ref), move0920Pts: r2(p920 - ref), move0920Pct: movePct,
  };
  if (live.skipped > 0 && openTick !== open) out.openStaleSkipped = live.skipped;
  out.hit = dir !== 0 ? dir * (p920 - ref) > 0 : Math.abs(movePct) < noCarryBandPct;
  out.signedMove0920Pts = dir !== 0 ? r2(dir * (p920 - ref)) : null;
  return out;
}

/** Outcome for any recorded event. */
export function measureEvent(event, series, cfg = getScorecardConfig()) {
  // CANDIDATE uses the SIGNAL rule unchanged so the two hit rates are directly comparable.
  if (event.section === "SIGNAL" || event.section === "CANDIDATE") return measureSignal(event, series);
  if (event.section === "TRADE") {
    const d = event.data || {};
    if (d.pnlKnown === true && Number.isFinite(Number(d.pnlInr))) return { status: "MEASURED", pnlInr: Number(d.pnlInr), hit: Number(d.pnlInr) > 0 };
    return { status: "UNMEASURABLE", reason: d.pnlInr == null ? "₹ result not reported by the Algo" : "₹ result incomplete (an account's exit price unknown)" };
  }
  if (event.section === "EOD") return { status: "PENDING", reason: "waiting for the next session's 09:20 futures price" };
  // Plan document: own window rule (start → end of the half), independent of event.minutes.
  if (event.section === "PLAN_DOC") return measurePlanCall(event.data || {}, series, { bandPct: cfg?.planBandPct ?? getPlanDocConfig().bandPct });
  return measureDirectional(event, series, { bandPct: cfg.bandPct });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Aggregation (pure)
// ─────────────────────────────────────────────────────────────────────────────
/** Wilson score interval (95%) for k hits out of n. */
export function wilson(k, n, z = 1.959964) {
  if (!n) return { lo: null, hi: null };
  const p = k / n;
  const den = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return { lo: Math.round(Math.max(0, centre - half) * 1000) / 1000, hi: Math.round(Math.min(1, centre + half) * 1000) / 1000 };
}

const mean = (a) => (a.length ? Math.round((a.reduce((s, x) => s + x, 0) / a.length) * 100) / 100 : null);

/** Stats for a list of {event, outcome} rows. Unmeasurable rows are excluded and counted. */
export function statsFor(rows, { minSample = SC_MIN_SAMPLE } = {}) {
  const measurable = rows.filter((r) => r.outcome && r.outcome.status === "MEASURED");
  const hits = measurable.filter((r) => r.outcome.hit === true).length;
  const n = measurable.length;
  const h = (key, field) => mean(measurable.map((r) => r.outcome.horizons?.[key]).filter((x) => x?.status === "OK").map((x) => x[field]));
  return {
    sessions: new Set(rows.map((r) => r.date)).size,
    events: rows.length,
    measurable: n,
    excludedUnmeasurable: rows.filter((r) => r.outcome?.status === "UNMEASURABLE").length,
    nonDirectional: rows.filter((r) => r.outcome?.status === "NOT_DIRECTIONAL").length,
    pending: rows.filter((r) => r.outcome?.status === "PENDING").length,
    hits,
    hitRate: n ? Math.round((hits / n) * 1000) / 1000 : null,
    wilson95: wilson(hits, n),
    tooFewToJudge: n < minSample,
    meanForward: {
      m15: { pts: h(15, "pts"), pct: h(15, "pct") },
      m30: { pts: h(30, "pts"), pct: h(30, "pct") },
      m60: { pts: h(60, "pts"), pct: h(60, "pct") },
      close: { pts: h("close", "pts"), pct: h("close", "pct") },
    },
    meanExcursion60: {
      mfePts: mean(measurable.map((r) => r.outcome.excursion60).filter((x) => x?.status === "OK").map((x) => x.mfePts)),
      maePts: mean(measurable.map((r) => r.outcome.excursion60).filter((x) => x?.status === "OK").map((x) => x.maePts)),
    },
    meanSignedMove0920Pts: mean(measurable.map((r) => r.outcome.signedMove0920Pts).filter((x) => Number.isFinite(x))),
    meanPnlInr: mean(measurable.map((r) => r.outcome.pnlInr).filter((x) => Number.isFinite(x))),
  };
}

const SECTIONS = ["FUSION", "TURN", "RADAR", "TRAP_SHADOW", "EOD", "EOD_SLOT", "SIGNAL", "CANDIDATE", "TRADE", "PLAN_DOC"];
export const PLAN_DOC_HALVES = ["FIRST", "SECOND", "FULL"];
export const PLAN_DOC_CALLS = ["BULLISH", "BEARISH", "RANGE"];
export const PLAN_DOC_CONVICTIONS = ["HIGHEST", "HIGH", "MEDIUM", "LOW"];

/** UP / DOWN / FLAT counts over every measured plan window (scored or not): the base rate. */
export function planOutcomeMix(rows) {
  const mix = { UP: 0, DOWN: 0, FLAT: 0, windows: 0 };
  for (const r of rows) {
    const o = r.outcome?.outcome;
    if ((r.outcome?.status === "MEASURED" || r.outcome?.status === "NOT_SCORED") && (o === "UP" || o === "DOWN" || o === "FLAT")) {
      mix[o]++;
      mix.windows++;
    }
  }
  return mix;
}
export const CANDIDATE_SC_CATEGORIES = ["CONFIRMED", "UNCONFIRMED", "REJECTED", "UNVERIFIABLE"];
export const CANDIDATE_SC_GRADES = ["SYNERGY_BULL_CAND", "SYNERGY_BEAR_CAND", "BEAR_TRAP_BUY_CAND", "BULL_TRAP_SELL_CAND"];

/**
 * Read-time correction for PLAN_DOC outcomes only: a stored day document keeps the outcome measured at
 * finalisation, which may have used a carry-over quote at the open as the reference. When the document
 * carries its own series, each PLAN_DOC event is re-measured with the current rule; when the answer
 * differs from the stored outcome it replaces it (marked `remeasured: true`; `storedHit` /
 * `storedRefPrice` kept when they differ), otherwise the stored outcome is kept untouched. No other section is touched and nothing is written. Never throws: falls back to the stored
 * outcome when there is no series or re-measuring fails. Returns the same object when nothing applies.
 */
export function withRemeasuredPlanDoc(doc) {
  try {
    if (!doc || doc.provisional || !doc.series || !Array.isArray(doc.series.m) || !doc.series.m.length) return doc;
    const evs = (doc.events || []).filter((e) => e && e.section === "PLAN_DOC" && e.id);
    if (!evs.length) return doc;
    const outcomes = { ...(doc.outcomes || {}) };
    let changed = false;
    for (const ev of evs) {
      const stored = outcomes[ev.id];
      try {
        const bandPct = Number(stored?.bandPct) > 0 ? Number(stored.bandPct) : getPlanDocConfig().bandPct;
        const fresh = measurePlanCall(ev.data || {}, doc.series, { bandPct });
        if (!fresh || typeof fresh !== "object") continue;
        if (stored && JSON.stringify(stored) === JSON.stringify(fresh)) continue; // same answer: keep the stored outcome as-is
        const o = { ...fresh, remeasured: true };
        if (stored && stored.hit !== fresh.hit) o.storedHit = stored.hit ?? null;
        if (stored && stored.refPrice !== undefined && stored.refPrice !== fresh.refPrice) o.storedRefPrice = stored.refPrice;
        outcomes[ev.id] = o;
        changed = true;
      } catch (e) {
        /* keep the stored outcome */
      }
    }
    return changed ? { ...doc, outcomes } : doc;
  } catch (e) {
    return doc;
  }
}

/** Rolling aggregate over day documents. */
export function aggregate(days, { minSample = SC_MIN_SAMPLE, includeTrades = true } = {}) {
  const rows = [];
  for (const raw of days) {
    const d = withRemeasuredPlanDoc(raw);
    for (const ev of d?.events || []) rows.push({ date: d.date, event: ev, outcome: d.outcomes?.[ev.id] || null });
    if (d?.eodFinal) rows.push({ date: d.date, event: d.eodFinal, outcome: d.eodOutcome || { status: "PENDING" } });
  }
  const out = { sessions: days.length, backfilledSessions: days.filter((d) => d.backfilled).length, minSample, sections: {} };
  // IV shadow: one set of LOW/MID/HIGH cut-offs (terciles of the ATM IV recorded on this window's
  // signals and candidates), so the two sections' IV bands mean the same thing. Measurement only.
  const ivRows = rows.filter((x) => (x.event.section === "SIGNAL" || x.event.section === "CANDIDATE"));
  const cuts = ivCuts(ivRows.map((x) => x.event.data?.iv?.atmIv));
  out.ivBands = cuts;
  const byIv = (r) => Object.fromEntries([...IV_BANDS, "UNKNOWN"].map((b) => [b, statsFor(r.filter((x) => ivBandOf(x.event.data?.iv?.atmIv, cuts) === b), { minSample })]));
  for (const sec of SECTIONS) {
    if (sec === "TRADE" && !includeTrades) continue;
    const r = rows.filter((x) => x.event.section === sec);
    out.sections[sec] = { rule: HIT_RULES[sec], ...statsFor(r, { minSample }) };
    if (sec === "TURN") out.sections[sec].byStage = Object.fromEntries(["EARLY", "LIKELY_TURN", "CONFIRMED"].map((st) => [st, statsFor(r.filter((x) => x.event.type === st), { minSample })]));
    if (sec === "TRAP_SHADOW") out.sections[sec].byVariant = Object.fromEntries(TRAP_SHADOW_VARIANTS.map(([v]) => [v, statsFor(r.filter((x) => x.event.type === v), { minSample })]));
    if (sec === "SIGNAL") out.sections[sec].byDecision = Object.fromEntries(["APPROVED", "VETOED", "NOT_EXECUTED", "BLOCKED", "DOWNGRADED"].map((c) => [c, statsFor(r.filter((x) => x.event.data?.category === c), { minSample })]));
    if (sec === "CANDIDATE") {
      out.sections[sec].byCategory = Object.fromEntries(CANDIDATE_SC_CATEGORIES.map((c) => [c, statsFor(r.filter((x) => x.event.data?.category === c), { minSample })]));
      out.sections[sec].byGrade = Object.fromEntries(CANDIDATE_SC_GRADES.map((g) => [g, statsFor(r.filter((x) => x.event.type === g), { minSample })]));
    }
    if (sec === "SIGNAL" || sec === "CANDIDATE") out.sections[sec].byIv = byIv(r);
    if (sec === "PLAN_DOC") {
      const s = out.sections[sec];
      s.notScored = r.filter((x) => x.outcome?.status === "NOT_SCORED").length;
      s.late = r.filter((x) => x.event.data?.late === true).length;
      s.byHalf = Object.fromEntries(PLAN_DOC_HALVES.map((h) => [h, statsFor(r.filter((x) => x.event.data?.half === h), { minSample })]));
      s.byCall = Object.fromEntries(PLAN_DOC_CALLS.map((c) => [c, statsFor(r.filter((x) => x.event.data?.call === c), { minSample })]));
      s.byConviction = Object.fromEntries(PLAN_DOC_CONVICTIONS.map((c) => [c, statsFor(r.filter((x) => x.event.data?.conviction === c), { minSample })]));
      s.outcomeMix = planOutcomeMix(r);
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Day document, Telegram text, CSV (pure)
// ─────────────────────────────────────────────────────────────────────────────
export function buildDayDoc({ date, events, finalEvent, series, settings, dataQuality, cfg = getScorecardConfig(), backfilled = false, notes = [], futuresExpiry = null, nowMs = Date.now() }) {
  const outcomes = {};
  for (const ev of events) outcomes[ev.id] = measureEvent(ev, series, cfg);
  return {
    v: 1,
    date,
    backfilled,
    notes,
    finalisedAt: new Date(nowMs).toISOString(),
    settings,
    dataQuality: dataQuality ? { state: dataQuality.state, coveragePct: dataQuality.coveragePct, ticksToday: dataQuality.ticksToday, expectedTicks: dataQuality.expectedTicks, gaps: dataQuality.gaps } : null,
    futuresExpiry,
    series,
    events,
    outcomes,
    eodFinal: finalEvent || null,
    eodOutcome: finalEvent ? { status: "PENDING", reason: "waiting for the next session's 09:20 futures price" } : null,
  };
}

/** Removes rupee results and the settings snapshot (public view). */
export function publicDayView(raw) {
  if (!raw) return null;
  const doc = withRemeasuredPlanDoc(raw);
  const { settings, ...rest } = doc;
  return {
    ...rest,
    events: (doc.events || []).map((e) => (e.section === "TRADE" ? { ...e, data: { ...e.data, pnlInr: undefined, accounts: undefined } } : e)),
    outcomes: Object.fromEntries(Object.entries(doc.outcomes || {}).map(([k, o]) => [k, o && "pnlInr" in o ? { ...o, pnlInr: undefined } : o])),
  };
}

function rowsOf(doc) {
  const rows = (doc.events || []).map((ev) => ({ ev, out: doc.outcomes?.[ev.id] }));
  if (doc.eodFinal) rows.push({ ev: doc.eodFinal, out: doc.eodOutcome });
  return rows;
}

const plain = (v) => String(v ?? "").replace(/[_*`[\]]/g, " ").replace(/\s+/g, " ").trim();
const gapList = (gaps) => { const g = (gaps || []).map((x) => `${x.from}–${x.to}`); return g.length > 6 ? `${g.slice(0, 6).join(", ")} … (${g.length - 6} more)` : g.join(", "); };

export const SC_TG_MAX_CANDIDATE_LINES = 25;

export function formatDailyTelegram(doc, { candidates = true, outside = [] } = {}) {
  // Shadow candidates and plan-document calls never count in the sections below or in the
  // unmeasurable count. Candidates get their own "Candidates" block at the end (one line each, the
  // SIGNAL-rule outcome unchanged) unless CANDIDATE_TELEGRAM_ENABLED is off.
  const rows = rowsOf(doc).filter((x) => x.ev.section !== "CANDIDATE" && x.ev.section !== "PLAN_DOC");
  const lines = [`📊 *Scorecard ${doc.date}*${doc.backfilled ? " (backfilled)" : ""}`];
  const dq = doc.dataQuality;
  lines.push(`• *Data:* ${dq ? `${dq.state} · ${dq.coveragePct ?? "?"}% coverage${dq.gaps?.length ? ` · gaps ${gapList(dq.gaps)}` : ""}` : "unknown"}`);
  for (const sec of ["FUSION", "TURN", "RADAR", "EOD_SLOT", "SIGNAL"]) {
    const r = rows.filter((x) => x.ev.section === sec);
    if (!r.length) continue;
    const m = r.filter((x) => x.out?.status === "MEASURED");
    const hits = m.filter((x) => x.out.hit);
    const misses = m.filter((x) => x.out.hit === false);
    const notable = (arr) => arr.sort((a, b) => Math.abs(b.out.horizons?.[60]?.pts ?? 0) - Math.abs(a.out.horizons?.[60]?.pts ?? 0))[0];
    const h = notable(hits);
    const mi = notable(misses);
    lines.push(`• *${plain(sec)}:* ${r.length} event(s), hits ${hits.length}/${m.length} measurable${r.length - m.length ? ` (${r.length - m.length} not measured)` : ""}${h ? ` · best ${h.ev.time} ${plain(h.ev.type)} ${h.ev.direction || ""}` : ""}${mi ? ` · miss ${mi.ev.time} ${plain(mi.ev.type)} ${mi.ev.direction || ""}` : ""}`);
  }
  const fin = doc.eodFinal;
  if (fin) lines.push(`• *EOD final:* ${plain(fin.data?.verdict || fin.data?.category)} (score ${fin.data?.score}) at ${fin.time}, ref fut ${fin.futPrice} — outcome next session 09:20`);
  const trades = rows.filter((x) => x.ev.section === "TRADE");
  for (const t of trades) {
    const d = t.ev.data || {};
    lines.push(`• *Trade ${d.kind || ""} ${d.tradeId || ""}:* ${plain(d.exitGrade)} ${d.pnlInr != null ? `${d.pnlInr >= 0 ? "+" : "-"}₹${Math.abs(d.pnlInr).toLocaleString("en-IN")}${d.pnlKnown === false ? " (incomplete)" : ""}` : "₹ not reported"}`);
  }
  const unm = rows.filter((x) => x.out?.status === "UNMEASURABLE");
  if (unm.length) {
    const reasons = {};
    for (const x of unm) {
      const k = String(x.out.reason || "unknown").replace(/\(\d+ of \d+ expected ticks; gap [^)]+\)/, "(gap)").slice(0, 70);
      reasons[k] = (reasons[k] || 0) + 1;
    }
    lines.push(`• *Unmeasurable:* ${unm.length} — ${Object.entries(reasons).slice(0, 3).map(([k, v]) => `${v}× ${plain(k)}`).join("; ")}`);
  }
  // Exit-rule shadow (measurement only): the day's positions under rules A–E, in futures points.
  if (doc.series) {
    try { lines.push(...formatExitRuleLines(evaluateDayExitRules(doc))); } catch (e) { /* never blocks the message */ }
  }
  // Override cost (measurement only): manual closes and logged outside trades vs the system.
  try { lines.push(...formatOverrideLines(evaluateDayOverrides(doc, outside, { authed: true }))); } catch (e) { /* never blocks the message */ }
  if (candidates) {
    const cand = rowsOf(doc).filter((x) => x.ev.section === "CANDIDATE").sort((a, b) => (a.ev.t ?? 0) - (b.ev.t ?? 0));
    if (cand.length) {
      lines.push(`• *Candidates* (shadow, no orders): ${cand.length}`);
      for (const x of cand.slice(0, SC_TG_MAX_CANDIDATE_LINES)) lines.push(formatCandidateOutcomeLine(x.ev, x.out));
      if (cand.length > SC_TG_MAX_CANDIDATE_LINES) lines.push(`  – … ${cand.length - SC_TG_MAX_CANDIDATE_LINES} more (see the Scorecard tab)`);
    }
  }
  return lines.join("\n");
}

export function formatMorningTelegram(date, final, outcome) {
  if (!final || !outcome) return null;
  if (outcome.status !== "MEASURED") return `🌅 *EOD outcome ${date}:* ${plain(final.data?.category)} — unmeasurable: ${plain(outcome.reason)}`;
  return `🌅 *EOD outcome ${date}:* ${plain(final.data?.category)} (score ${final.data?.score}) · ref fut ${outcome.refPrice} → open ${outcome.openPrice} (${outcome.openGapPts >= 0 ? "+" : ""}${outcome.openGapPts}) → 09:20 ${outcome.price0920}${outcome.price0920At && outcome.price0920At !== "09:20" ? ` (${outcome.price0920At} tick; 09:20 missing)` : ""} (${outcome.move0920Pct >= 0 ? "+" : ""}${outcome.move0920Pct}%) · ${outcome.hit ? "HIT" : "MISS"} (${outcome.nextDate})`;
}

const csvEsc = (v) => {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function dayToCsv(doc, { authed = false } = {}) {
  const head = ["date", "time", "section", "type", "direction", "futPrice", "status", "hit", "reason", "m15_pts", "m30_pts", "m60_pts", "close_pts", "mfe60_pts", "mae60_pts", "band60_first", "signal_first", "eod_move0920_pct", "pnlInr", "dq_ok", "data", "plan_move_pct", "plan_outcome"];
  const rows = rowsOf(doc).map(({ ev, out }) => [
    doc.date, ev.time, ev.section, ev.type, ev.direction, ev.futPrice, out?.status, out?.hit, out?.reason,
    out?.horizons?.[15]?.pts, out?.horizons?.[30]?.pts, out?.horizons?.[60]?.pts, out?.horizons?.close?.pts,
    out?.excursion60?.mfePts, out?.excursion60?.maePts, out?.band60?.first, out?.first, out?.move0920Pct,
    authed ? ev.data?.pnlInr : null, ev.dq?.ok, ev.section === "TRADE" && !authed ? { ...ev.data, pnlInr: undefined, accounts: undefined } : ev.data,
    ev.section === "PLAN_DOC" ? out?.movePct : null, ev.section === "PLAN_DOC" ? out?.outcome : null,
  ]);
  return [head.join(","), ...rows.map((r) => r.map(csvEsc).join(","))].join("\n");
}

export function aggregateToCsv(agg) {
  const head = ["section", "split", "sessions", "events", "measurable", "excludedUnmeasurable", "pending", "hits", "hitRate", "wilsonLo", "wilsonHi", "tooFewToJudge", "m15_pts", "m30_pts", "m60_pts", "close_pts", "mfe60_pts", "mae60_pts"];
  const line = (sec, split, s) => [sec, split, s.sessions, s.events, s.measurable, s.excludedUnmeasurable, s.pending, s.hits, s.hitRate, s.wilson95.lo, s.wilson95.hi, s.tooFewToJudge, s.meanForward.m15.pts, s.meanForward.m30.pts, s.meanForward.m60.pts, s.meanForward.close.pts, s.meanExcursion60.mfePts, s.meanExcursion60.maePts];
  const out = [head.join(",")];
  for (const [sec, s] of Object.entries(agg.sections)) {
    out.push(line(sec, "all", s).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byStage || {})) out.push(line(sec, `stage:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byDecision || {})) out.push(line(sec, `decision:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byVariant || {})) out.push(line(sec, `variant:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byCategory || {})) out.push(line(sec, `category:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byGrade || {})) out.push(line(sec, `grade:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byHalf || {})) out.push(line(sec, `half:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byCall || {})) out.push(line(sec, `call:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byConviction || {})) out.push(line(sec, `conviction:${k}`, v).map(csvEsc).join(","));
    for (const [k, v] of Object.entries(s.byIv || {})) out.push(line(sec, `iv:${k}`, v).map(csvEsc).join(","));
    // Base rate: windows (events column) whose futures move was UP / DOWN / FLAT.
    if (s.outcomeMix) for (const k of ["UP", "DOWN", "FLAT"]) out.push([sec, `outcome:${k}`, "", s.outcomeMix[k]].map(csvEsc).join(","));
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
//  I/O helpers (DI store; never throw to callers)
// ─────────────────────────────────────────────────────────────────────────────
async function appendEvents(store, date, events) {
  let dropped = 0;
  for (const ev of events) {
    try {
      if (!(await store.setNx(keys.dedupe(date, ev.id), 1, 2 * 86400))) continue; // concurrent refreshes record once
      const len = Number(await store.rpush(keys.events(date), ev)) || 0;
      if (len === 1) await store.expire(keys.events(date), SC_TTL_SEC);
      if (len > SC_MAX_EVENTS_PER_DAY) {
        await store.ltrim(keys.events(date), 0, SC_MAX_EVENTS_PER_DAY - 1);
        dropped++;
      }
    } catch (e) { /* measurement only */ }
  }
  if (dropped) { try { await store.incr(keys.dropped(date), dropped); } catch (e) { /* ignore */ } }
  return dropped;
}

/** Records one refresh reading: change detection + append-only events. Measurement only. */
export async function recordReading({ store, date, reading, env = process.env }) {
  try {
    const cfg = getScorecardConfig(env);
    if (!store || !cfg.enabled) return { status: "DISABLED", events: 0 };
    const prev = await store.get(keys.state(date));
    const { events, state } = captureEvents(prev, reading, { fusionRearmMin: cfg.fusionRearmMin });
    await store.set(keys.state(date), state, SC_TTL_SEC);
    if (events.length) await appendEvents(store, date, events);
    return { status: "OK", events: events.length };
  } catch (e) {
    return { status: "ERROR", error: e?.message };
  }
}

/** Records a single event coming from the webhook (signal received, trade/carry exit). */
export async function recordEvent({ store, date, event, env = process.env }) {
  try {
    if (!store || !getScorecardConfig(env).enabled) return { status: "DISABLED" };
    await appendEvents(store, date, [event]);
    return { status: "OK" };
  } catch (e) {
    return { status: "ERROR", error: e?.message };
  }
}

export const NO_SESSION_REASON_WEEKEND = "weekend closed (not a Muhurat date): no session to measure";
export const NO_SESSION_REASON_EMPTY = "no timeline ticks and no recorded events (holiday or no session): nothing to measure";

/**
 * True for a stored day document that measured nothing: no events, no final EOD verdict and no
 * ticks. Such documents (e.g. lazily finalised weekend days) are not sessions.
 */
export function isEmptyDayDoc(doc) {
  if (!doc) return true;
  const events = Array.isArray(doc.events) ? doc.events.length : 0;
  const ticks = Math.max(Number(doc.series?.m?.length) || 0, Number(doc.dataQuality?.ticksToday) || 0);
  return events === 0 && !doc.eodFinal && ticks === 0;
}

/**
 * Whether a stored day document counts as a session in the rolling aggregate: not empty and not
 * dated on a closed weekend day. Real weekday sessions count, including backfilled and
 * low-coverage ones.
 */
export function isSessionDayDoc(doc) {
  if (!doc || !doc.date) return false;
  if (getSessionKindForDate(doc.date) === "CLOSED") return false;
  return !isEmptyDayDoc(doc);
}

/**
 * Finalises a day (idempotent): measures every event on the day's series and writes the day doc;
 * returns { status: "NO_SESSION" } without writing or sending when the date is a closed weekend
 * day or the day has no ticks and no recorded events;
 * queues the FINAL EOD verdict for next-session measurement; sends the daily Telegram once.
 * deps = { getTimeline(date) -> ticks[], computeDataQuality?(timeline) -> dq, settings, send?, now }
 */
export async function finaliseDay({ store, date, deps, env = process.env, futuresExpiry = null, force = false }) {
  try {
    if (!store) return { status: "NO_STORE" };
    // A closed weekend day (not a Muhurat date) is never a session: nothing to finalise.
    if (getSessionKindForDate(date) === "CLOSED") return { status: "NO_SESSION", reason: NO_SESSION_REASON_WEEKEND };
    const cfg = getScorecardConfig(env);
    const existing = await store.get(keys.day(date));
    if (existing?.finalisedAt && !force) return { status: "ALREADY_FINAL", doc: existing };
    if (!(await store.setNx(keys.finLock(date), 1, 120))) return { status: "IN_PROGRESS", doc: existing };
    const events = ((await store.lrange(keys.events(date), 0, -1)) || []).filter((e) => e && e.id);
    const state = await store.get(keys.state(date));
    const final = finalEodEvent(state);
    const timeline = (await deps.getTimeline(date)) || [];
    const series = compactSeries(timeline);
    // No ticks and nothing recorded (weekend, exchange holiday): no day document, no Telegram.
    if (!series.m.length && !events.length && !final) {
      await store.del(keys.finLock(date));
      return { status: "NO_SESSION", reason: NO_SESSION_REASON_EMPTY };
    }
    const dq = deps.computeDataQuality ? deps.computeDataQuality(timeline) : null;
    const nowMs = deps.now ? deps.now() : Date.now();
    const settings = { ...(deps.settings || {}), takenAt: new Date(nowMs).toISOString() };
    const doc = buildDayDoc({ date, events, finalEvent: final, series, settings, dataQuality: dq, cfg, futuresExpiry: futuresExpiry || final?.futuresExpiry || null, nowMs });
    let dropped = 0;
    try { dropped = Number(await store.get(keys.dropped(date))) || 0; } catch (e) { dropped = 0; }
    if (dropped) doc.notes = [...doc.notes, `${dropped} event(s) beyond the ${SC_MAX_EVENTS_PER_DAY}/day cap were not recorded`];
    await store.set(keys.day(date), doc, SC_TTL_SEC);
    if (final) await store.set(keys.eodPending, { date, final }, 30 * 86400);
    await store.del(keys.finLock(date));
    if (deps.send && (await store.setNx(keys.tgDaily(date), 1, 3 * 86400))) {
      let outside = [];
      try { outside = (await store.get(keys.outside(date))) || []; } catch (e) { outside = []; }
      const ok = await deps.send(formatDailyTelegram(doc, { candidates: isCandidateTelegramEnabled(env), outside: Array.isArray(outside) ? outside : [] }));
      if (!ok) await store.del(keys.tgDaily(date));
    }
    return { status: "FINALISED", doc };
  } catch (e) {
    return { status: "ERROR", error: e?.message };
  }
}

/**
 * Completes the pending EOD outcome on a LATER session once it has ticks up to 09:20
 * (weekends/holidays: simply the next session with data). Idempotent; Telegram once.
 */
export async function completePendingEod({ store, today, timeline, nowMins, futuresExpiry = null, send = null, env = process.env }) {
  try {
    if (!store || nowMins < SC_EOD_CHECK_MINS) return { status: "NOT_YET" };
    const pending = await store.get(keys.eodPending);
    if (!pending?.date || pending.date >= today) return { status: "NOTHING_PENDING" };
    const outcome = measureEodNext(pending.final, compactSeries(timeline), { nextDate: today, noCarryBandPct: getScorecardConfig(env).noCarryBandPct, nextFuturesExpiry: futuresExpiry });
    const doc = await store.get(keys.day(pending.date));
    if (doc) {
      doc.eodOutcome = outcome;
      await store.set(keys.day(pending.date), doc, SC_TTL_SEC);
    }
    await store.del(keys.eodPending);
    if (send && (await store.setNx(keys.tgMorning(pending.date), 1, 3 * 86400))) {
      const text = formatMorningTelegram(pending.date, pending.final, outcome);
      if (text && !(await send(text))) await store.del(keys.tgMorning(pending.date));
    }
    return { status: "COMPLETED", date: pending.date, outcome };
  } catch (e) {
    return { status: "ERROR", error: e?.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Store adapters
// ─────────────────────────────────────────────────────────────────────────────
const enc = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const dec = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { return v; }
};

/** Over an Upstash REST command function cmd(["GET", k]) → result. */
export function scStoreFromCommand(cmd) {
  return {
    get: async (k) => dec(await cmd(["GET", k])),
    set: async (k, v, ttl) => cmd(ttl ? ["SET", k, enc(v), "EX", String(ttl)] : ["SET", k, enc(v)]),
    setNx: async (k, v, ttl) => (await cmd(["SET", k, enc(v), "NX", "EX", String(ttl)])) === "OK",
    del: async (k) => cmd(["DEL", k]),
    rpush: async (k, v) => cmd(["RPUSH", k, enc(v)]),
    ltrim: async (k, a, b) => cmd(["LTRIM", k, String(a), String(b)]),
    lrange: async (k, a, b) => ((await cmd(["LRANGE", k, String(a), String(b)])) || []).map(dec),
    expire: async (k, ttl) => cmd(["EXPIRE", k, String(ttl)]),
    incr: async (k, by = 1) => cmd(["INCRBY", k, String(by)]),
    mget: async (ks) => ((await cmd(["MGET", ...ks])) || []).map(dec),
  };
}

/** Over an @upstash/redis-style client. */
export function scStoreFromClient(redis) {
  if (!redis) return null;
  return {
    get: async (k) => dec(await redis.get(k)),
    set: async (k, v, ttl) => (ttl ? redis.set(k, enc(v), { ex: ttl }) : redis.set(k, enc(v))),
    setNx: async (k, v, ttl) => (await redis.set(k, enc(v), { nx: true, ex: ttl })) === "OK",
    del: async (k) => redis.del(k),
    rpush: async (k, v) => (redis.rpush ? redis.rpush(k, enc(v)) : redis.lpush(k, enc(v))),
    ltrim: async (k, a, b) => redis.ltrim(k, a, b),
    lrange: async (k, a, b) => ((await redis.lrange(k, a, b)) || []).map(dec),
    expire: async (k, ttl) => (redis.expire ? redis.expire(k, ttl) : null),
    incr: async (k, by = 1) => (redis.incrby ? redis.incrby(k, by) : null),
    mget: async (ks) => (redis.mget ? ((await redis.mget(...ks)) || []).map(dec) : Promise.all(ks.map(async (k) => dec(await redis.get(k))))),
  };
}

/** IST calendar date (YYYY-MM-DD) and minutes for an epoch ms. */
export function istOf(ms) {
  const d = new Date(ms + 330 * 60000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Timeline Redis key variants for an ISO date (the scanner keys by en-IN "D-M-YYYY" / "DD-MM-YYYY"). */
export function timelineKeysFor(isoDate) {
  const [y, m, d] = isoDate.split("-");
  return [...new Set([`nifty_timeline_v2_${d}-${m}-${y}`, `nifty_timeline_v2_${Number(d)}-${Number(m)}-${y}`, `nifty_timeline_v2_${Number(d)}-${m}-${y}`])];
}
