/**
 * Shadow "candidate" alerts from the TradingView indicator (v4.3.1) — LOG ONLY.
 *
 * Pine cannot see the option chain; in Auto mode its put/call "writing blitz" is a proxy from the
 * futures premium. A candidate is sent when the chart/futures conditions of a synergy or trap hold
 * WITHOUT that proxy. The webhook asks the existing fusion rules what the REAL grade would get
 * against the real 22-strike chain and only records the answer here. A candidate never opens a
 * trade, never dispatches to the Algo and never touches the live signal log. Its only outbound effect
 * is one clearly labelled shadow Telegram per verdict (CANDIDATE_TELEGRAM_ENABLED, default on), sent
 * after the verdict is recorded and after the webhook has answered TradingView.
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
    iv: fused?.ivShadow ?? null, // IV shadow (src/ivShadow.js), measurement only
    shadowOnly: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Telegram: one shadow verdict message per candidate + one scorecard line per outcome (pure)
// ─────────────────────────────────────────────────────────────────────────────

/** Switch CANDIDATE_TELEGRAM_ENABLED: default on; "false" / "0" turns the candidate messages off. */
export function isCandidateTelegramEnabled(env = process.env) {
  const raw = String(env?.CANDIDATE_TELEGRAM_ENABLED ?? "true").trim().toLowerCase();
  return !(raw === "false" || raw === "0");
}

/** Dedupe key prefix: SET NX per candidate, so a re-delivery or a concurrent invocation sends once. */
export const CANDIDATE_TG_DEDUPE_PREFIX = "nifty:tv:candidate_tg:";
export const CANDIDATE_TG_DEDUPE_TTL_SEC = 3 * 86400;
/** Upper bound on one verdict send (claim + Telegram), so a hung call can never pin the function. */
export const CANDIDATE_TG_TIMEOUT_MS = 5000;

/** Small, stable 32-bit FNV-1a hex digest (no crypto import needed; collisions are irrelevant here). */
function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Dedupe key for one candidate. Keyed on the IST date + candidate grade + the alert's own bar
 * identity. Pine sends no bar time, and the record's chartTime falls back to the receipt time
 * (different on every re-delivery), so when the payload has no `t` the identity is a digest of the
 * alert's bar fields (symbol, timeframe, direction, close, stop, signal count): a TradingView
 * re-delivery repeats them exactly, a genuinely new candidate (a later bar, ≥ 4-bar cooldown) does not.
 */
export function candidateTelegramDedupeKey({ istDate, grade, payload = {} }) {
  const g = normalizeGrade(grade);
  const t = payload?.t !== undefined && payload?.t !== null && String(payload.t).trim() !== "" ? String(payload.t).trim() : null;
  const ident = t
    ? `t=${t}`
    : `b=${fnv1a([payload?.sym, payload?.tf, payload?.dir, payload?.close, payload?.sl, payload?.cappedSl, payload?.sig].map((v) => String(v ?? "")).join("|"))}`;
  return `${CANDIDATE_TG_DEDUPE_PREFIX}${istDate}:${g}:${ident}`;
}

/** Free text made safe for Telegram legacy Markdown (no entity characters), one line, bounded. */
const tgPlain = (v, max = 300) => {
  const s = String(v ?? "").replace(/[_*`[\]]/g, " ").replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};
/** Identifier in a code span (underscores stay readable and cannot break Markdown). */
const tgCode = (v) => `\`${String(v ?? "?").replace(/`/g, "'")}\``;
const num = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? "—" : String(Number(v)));

/** Plain-words explanation of the "could not judge" case, from the stored record. */
function unverifiableReason(rec, maxAgeSec) {
  const age = rec?.snapshotAgeSec;
  if (age === null || age === undefined) return "no live option-chain snapshot was available";
  if (Number.isFinite(Number(maxAgeSec)) && Number(age) > Number(maxAgeSec)) return `the option-chain snapshot was ${age}s old (limit ${maxAgeSec}s)`;
  if (rec?.deltaPcr === null || rec?.deltaPcr === undefined) return "the snapshot had no ΔPCR";
  return "no fresh option-chain reading";
}

/** The verdict line (category in plain words). */
export function describeCandidateCategory(rec, { maxAgeSec = null } = {}) {
  const decision = rec?.realDecision ? tgCode(rec.realDecision) : "no decision";
  const why = tgPlain(rec?.realReasoning, 300);
  switch (rec?.category) {
    case "CONFIRMED":
      return `Confirmed — the real option chain would have approved it: ${decision}.`;
    case "UNCONFIRMED":
      return `Unconfirmed — today's rules would let it through as ${decision}, but the option chain did not positively back it.${why ? ` Missing: ${why}` : ""}`;
    case "REJECTED":
      return `Rejected — the real option chain vetoes it: ${decision}.${why ? ` Why: ${why}` : ""}`;
    case "UNVERIFIABLE":
      return `Could not judge — ${unverifiableReason(rec, maxAgeSec)}, so no verdict was possible (no refresh is made for candidates).`;
    default:
      return `Verdict ${tgPlain(rec?.category) || "unknown"}: ${decision}.${why ? ` ${why}` : ""}`;
  }
}

/**
 * The shadow verdict Telegram. Its first line can never be read as a trade:
 *   🧪 *SHADOW CANDIDATE* · <CATEGORY> · `<realGrade>` (<direction>) — no order placed
 * @param {object} rec        buildCandidateRecord output (as stored)
 * @param {{ snapshotSource?: string, maxAgeSec?: number }} opts
 */
export function formatCandidateTelegram(rec, { snapshotSource = null, maxAgeSec = null } = {}) {
  const cat = tgPlain(rec?.category || "UNKNOWN", 20);
  const dir = tgPlain(rec?.direction || "?", 10);
  const age = rec?.snapshotAgeSec;
  const lines = [
    `🧪 *SHADOW CANDIDATE* · ${cat} · ${tgCode(rec?.realGrade)} (${dir}) — no order placed`,
    `• *Alert:* ${tgCode(rec?.grade)} · chart time ${tgPlain(rec?.chartTime || rec?.istTime || "?", 20)}`,
    `• *Levels:* entry ${num(rec?.entry)} · stop ${num(rec?.sl)} · T1 ${num(rec?.t1)} · T2 ${num(rec?.t2)}`,
    `• *Verdict:* ${describeCandidateCategory(rec, { maxAgeSec })}`,
    `• *Chain:* ΔPCR ${num(rec?.deltaPcr)} · floor ${num(rec?.floor)} · roof ${num(rec?.roof)}`,
    `• *Futures quadrant:* scanner ${tgPlain(rec?.serverFutQuad || "—", 30)} · chart ${tgPlain(rec?.chartFutQuad || "—", 30)}`,
    `• *Snapshot:* ${age === null || age === undefined ? "none (missing)" : `${tgPlain(snapshotSource || "unknown writer", 60)}, ${age}s old`}`,
    "Shadow only: not sent to the Algo; outcome will appear in the scorecard.",
  ];
  return lines.join("\n");
}

const hhmmOnly = (s) => (/^\d{1,2}:\d{2}/.test(String(s || "")) ? String(s).slice(0, String(s).indexOf(":") + 3) : null);

/** Plain-words scorecard outcome of one candidate (the SIGNAL rule's result, unchanged). */
export function describeCandidateOutcome(out) {
  if (!out) return "not measured yet";
  if (out.status === "UNMEASURABLE") return `unmeasurable: ${tgPlain(out.reason || "unknown", 90)}`;
  if (out.status !== "MEASURED") return tgPlain(out.status || "not measured", 40);
  if (out.first === "T1") return `T1 first${out.at ? ` (${out.at})` : ""}`;
  if (out.first === "STOP") return `stop first${out.at ? ` (${out.at})` : ""}`;
  if (out.first === "NEITHER") return "neither by the close";
  return tgPlain(out.first || "measured", 40);
}

/** One scorecard-Telegram line for a CANDIDATE event (scorecard buildCandidateEvent) and its outcome. */
export function formatCandidateOutcomeLine(ev, out) {
  const dir = ev?.direction === "BULLISH" ? "LONG" : ev?.direction === "BEARISH" ? "SHORT" : "?";
  const cat = tgPlain(ev?.data?.category || "?", 20);
  return `  – ${hhmmOnly(ev?.time) || ev?.time || "?"} ${tgCode(ev?.type)} ${dir} · ${cat} → ${describeCandidateOutcome(out)}`;
}
