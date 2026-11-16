/**
 * Shadow "candidate" alerts from the TradingView indicator (v4.3.1) — LOG ONLY.
 *
 * Pine cannot see the option chain; in Auto mode its put/call "writing blitz" is a proxy from the
 * futures premium. A candidate is sent when the chart/futures conditions of a synergy or trap hold
 * WITHOUT that proxy. The webhook asks the existing fusion rules what the REAL grade would get
 * against the real 22-strike chain and only records the answer here. A candidate never opens a
 * trade, never dispatches to the Algo, never sends Telegram and never touches the live signal log.
 *
 * Pure functions only.
 */

/** Candidate grade → the real grade whose verdict it is measured against. */
export const CANDIDATE_GRADES = Object.freeze({
  SYNERGY_BULL_CAND: "SYNERGY_BULL",
  SYNERGY_BEAR_CAND: "SYNERGY_BEAR",
  BEAR_TRAP_BUY_CAND: "BEAR_TRAP_BUY",
  BULL_TRAP_SELL_CAND: "BULL_TRAP_SELL",
});

export const CANDIDATE_CATEGORIES = ["CONFIRMED", "UNCONFIRMED", "REJECTED", "UNVERIFIABLE"];

/** Redis list per IST date; newest first (LPUSH), capped, with its own TTL. */
export const CANDIDATE_LIST_PREFIX = "nifty:tv:candidates:";
export const CANDIDATE_LIST_CAP = 200;
export const CANDIDATE_TTL_SEC = 14 * 86400;
export const candidateListKey = (istDate) => `${CANDIDATE_LIST_PREFIX}${istDate}`;

/**
 * Same "near the wall" distance (points) that fuseChartWithOptionChain uses for its 2-lot trap
 * sizing (nearPutWall / nearCallWall: |distance| <= 80). A test pins the two together.
 */
export const WALL_NEAR_PTS = 80;

/** Normalised candidate grade ("" when the value is not a string-like grade). */
export function normalizeGrade(grade) {
  return grade === null || grade === undefined ? "" : String(grade).trim().toUpperCase();
}

export function isCandidateGrade(grade) {
  return Object.prototype.hasOwnProperty.call(CANDIDATE_GRADES, normalizeGrade(grade));
}

export function realGradeFor(grade) {
  return CANDIDATE_GRADES[normalizeGrade(grade)] || null;
}

/** Kill switch CANDIDATE_SHADOW_ENABLED: default on; "false" / "0" turns candidates off. */
export function isCandidateShadowEnabled(env = process.env) {
  const raw = String(env?.CANDIDATE_SHADOW_ENABLED ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0");
}

const finiteOrNull = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * What the real option chain says about a candidate.
 *   UNVERIFIABLE — no fresh live snapshot (missing, older than the max age) or no numeric ΔPCR.
 *   REJECTED     — the real grade's verdict is a VETO_* decision.
 *   CONFIRMED    — the chain positively confirms the writing: synergy → EXECUTE_HIGH_CONVICTION_SYNERGY;
 *                  trap → EXECUTE_TIER1_SCOUT with the chain blitz in the trade's direction AND price
 *                  within WALL_NEAR_PTS of the wall (exactly when the trap is sized at 2 lots).
 *   UNCONFIRMED  — anything else today's rules would let through without positive confirmation.
 * @param {{ realGrade: string, fused: object, snapshotOk: boolean }} p
 */
export function classifyCandidate({ realGrade, fused, snapshotOk } = {}) {
  const m = fused?.liveOptionChainMetrics || {};
  if (!snapshotOk || finiteOrNull(m.deltaPCR) === null) return "UNVERIFIABLE";
  const decision = String(fused?.decision || "");
  if (decision.startsWith("VETO")) return "REJECTED";
  const grade = normalizeGrade(realGrade);
  if (grade === "SYNERGY_BULL" || grade === "SYNERGY_BEAR") {
    return decision === "EXECUTE_HIGH_CONVICTION_SYNERGY" ? "CONFIRMED" : "UNCONFIRMED";
  }
  if (grade === "BEAR_TRAP_BUY" || grade === "BULL_TRAP_SELL") {
    if (decision !== "EXECUTE_TIER1_SCOUT") return "UNCONFIRMED";
    const close = finiteOrNull(fused?.entryPrice);
    if (grade === "BEAR_TRAP_BUY") {
      const floor = finiteOrNull(m.floorStrike);
      const near = close !== null && floor !== null && floor > 0 && Math.abs(close - floor) <= WALL_NEAR_PTS;
      return m.realPutBlitz === true && near ? "CONFIRMED" : "UNCONFIRMED";
    }
    const roof = finiteOrNull(m.roofStrike);
    const near = close !== null && roof !== null && roof > 0 && Math.abs(roof - close) <= WALL_NEAR_PTS;
    return m.realCallBlitz === true && near ? "CONFIRMED" : "UNCONFIRMED";
  }
  return "UNCONFIRMED";
}

/** Compact record stored in nifty:tv:candidates:<date> (and returned by GET /api/tv-webhook). */
export function buildCandidateRecord({ grade, realGrade, fused, category, snapshotAgeSec, nowMs }) {
  const m = fused?.liveOptionChainMetrics || {};
  return {
    t: nowMs,
    timestamp: new Date(nowMs).toISOString(),
    istTime: new Date(nowMs).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    chartTime: fused?.istTime ?? null,
    grade: normalizeGrade(grade),
    realGrade,
    direction: fused?.direction ?? null,
    entry: finiteOrNull(fused?.entryPrice),
    sl: finiteOrNull(fused?.stopLoss),
    t1: finiteOrNull(fused?.target1Price),
    t2: finiteOrNull(fused?.target2Price),
    category,
    realDecision: fused?.decision ?? null,
    realReasoning: String(fused?.reasoning || "").slice(0, 400),
    deltaPcr: finiteOrNull(m.deltaPCR),
    serverFutQuad: m.serverFutQuad ?? null,
    chartFutQuad: m.chartFutQuad ?? null,
    floor: finiteOrNull(m.floorStrike),
    roof: finiteOrNull(m.roofStrike),
    snapshotAgeSec: snapshotAgeSec ?? null,
    shadowOnly: true,
  };
}
