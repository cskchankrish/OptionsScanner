/**
 * Flow execution bridge — scanner side (contract v1).
 *
 * Sends an approved trap/synergy signal to the external execution engine ("the Algo") as a
 * signed FLOW_ENTRY instruction and classifies the reply. Pure / dependency-injected: the
 * caller passes `fetchImpl`, so tests never touch the network.
 *
 * Contract v1 (see docs/flow-bridge.md):
 *   POST {FLOW_BRIDGE_URL}
 *   body    { v:1, type:"FLOW_ENTRY", id, ts, grade, decision, dir, spot, entry, sl, t1, t2, lots:1, snapshotAgeSec }
 *   headers Content-Type: application/json
 *           X-Flow-Timestamp: <ts>
 *           X-Flow-Signature: hex(HMAC-SHA256(FLOW_BRIDGE_SECRET, "<ts>.<raw body>"))
 *   reply   HTTP 200 { status:"accepted"|"rejected"|"duplicate", reason, mode, orderRef }
 *           anything else (non-200, bad JSON, unknown status, timeout, network error) = UNKNOWN.
 *
 * An entry is NEVER retried automatically: a retry after an unknown outcome could execute twice.
 * The `id` makes a manual resend idempotent on the Algo side (it answers "duplicate").
 */
import { createHmac, randomBytes } from "node:crypto";

export const FLOW_BRIDGE_GRADES = ["BEAR_TRAP_BUY", "BULL_TRAP_SELL", "SYNERGY_BULL", "SYNERGY_BEAR"];
export const DEFAULT_FLOW_BRIDGE_DECISIONS = ["EXECUTE_TIER1_SCOUT", "EXECUTE_HIGH_CONVICTION_SYNERGY"];

/** Vercel kills api/*.js at 15s (vercel.json maxDuration). */
export const FUNCTION_BUDGET_MS = 15000;
/**
 * Time kept free AFTER the dispatch returns: Redis update of the trade (~0.3s), the bridge
 * Telegram message (3s client timeout), the five archive writes (~0.5s), the main alert and the
 * watchdog. 4s covers the bounded parts; the main alert is sent last so a slow Telegram cannot
 * lose state.
 */
export const POST_DISPATCH_RESERVE_MS = 4000;
/** Below this, a dispatch is not attempted at all (outcome would almost surely be UNKNOWN). */
export const MIN_DISPATCH_MS = 1000;
export const DEFAULT_DISPATCH_TIMEOUT_MS = 3000;

/** Statuses that make a trade "bridge-owned": the Algo, not the auto-lifecycle, drives it. */
export const BRIDGE_OWNED_STATUSES = ["PENDING", "ACCEPTED", "UNKNOWN"];

export function isBridgeOwned(trade) {
  return Boolean(trade && trade.execution && BRIDGE_OWNED_STATUSES.includes(trade.execution.status));
}

/** Reads the bridge config from env on every call (so a redeploy/env flip takes effect at once). */
export function getFlowBridgeConfig(env = process.env) {
  const url = typeof env.FLOW_BRIDGE_URL === "string" ? env.FLOW_BRIDGE_URL.trim() : "";
  const secret = typeof env.FLOW_BRIDGE_SECRET === "string" ? env.FLOW_BRIDGE_SECRET : "";
  const flag = String(env.FLOW_BRIDGE_ENABLED || "").trim().toLowerCase() === "true";
  const decisionsRaw = typeof env.FLOW_BRIDGE_DECISIONS === "string" && env.FLOW_BRIDGE_DECISIONS.trim()
    ? env.FLOW_BRIDGE_DECISIONS
    : DEFAULT_FLOW_BRIDGE_DECISIONS.join(",");
  const decisions = decisionsRaw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const t = Number(env.FLOW_BRIDGE_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(t) && t > 0 ? Math.min(5000, Math.max(MIN_DISPATCH_MS, t)) : DEFAULT_DISPATCH_TIMEOUT_MS;
  return {
    enabled: flag && url.length > 0 && secret.length > 0,
    url,
    secret,
    decisions,
    timeoutMs,
  };
}

/** True when this fused verdict is one the bridge should send to the Algo. */
export function shouldDispatch(config, fused) {
  if (!config?.enabled || !fused) return false;
  return FLOW_BRIDGE_GRADES.includes(String(fused.grade)) && config.decisions.includes(String(fused.decision));
}

/**
 * Time the dispatch may take, given how long the request has already run. Returns 0 when there
 * is not enough budget left to dispatch safely.
 */
export function computeDispatchTimeoutMs(configTimeoutMs, elapsedMs) {
  const left = FUNCTION_BUDGET_MS - POST_DISPATCH_RESERVE_MS - Math.max(0, Number(elapsedMs) || 0);
  const t = Math.min(configTimeoutMs, left);
  return t >= MIN_DISPATCH_MS ? t : 0;
}

export function newTradeId(nowMs = Date.now()) {
  return `ft-${nowMs}-${randomBytes(4).toString("hex")}`;
}

const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * Builds the FLOW_ENTRY body. Returns { entry } or { error } when a level the Algo needs is
 * missing (a real order is never sent without a stop and both targets).
 */
export function buildFlowEntry({ id, ts, fused }) {
  const entry = num(fused?.entryPrice);
  const sl = num(fused?.stopLoss);
  const t1 = num(fused?.target1Price);
  const t2 = num(fused?.target2Price);
  const dir = String(fused?.direction || "").toUpperCase();
  const missing = [];
  if (!(entry > 0)) missing.push("entry");
  if (!(sl > 0)) missing.push("sl");
  if (!(t1 > 0)) missing.push("t1");
  if (!(t2 > 0)) missing.push("t2");
  if (dir !== "LONG" && dir !== "SHORT") missing.push("dir");
  if (missing.length) return { error: `missing/invalid ${missing.join(", ")}` };
  const age = num(fused?.liveOptionChainMetrics?.snapshotAgeSec);
  return {
    entry: {
      v: 1,
      type: "FLOW_ENTRY",
      id: String(id),
      ts: Number(ts),
      grade: String(fused.grade),
      decision: String(fused.decision),
      dir,
      // The scanner's spot at signal time is the chart's signal close (the same level as `entry`).
      spot: entry,
      entry,
      sl,
      t1,
      t2,
      lots: 1, // hard cap: always 1 lot, whatever recommendedLots says
      snapshotAgeSec: age,
    },
  };
}

/** Lowercase hex HMAC-SHA256 of "<timestamp>.<body>" keyed with the shared secret. */
export function signFlowBody(secret, timestamp, body) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex");
}

/**
 * Sends one FLOW_ENTRY. Never throws, never retries.
 * @returns {Promise<{ outcome: "ACCEPTED"|"REJECTED"|"DUPLICATE"|"UNKNOWN", mode: string|null,
 *   orderRef: string|null, reason: string|null, httpStatus: number|null, error: string|null,
 *   durationMs: number, body: string }>}
 */
export async function dispatchFlowEntry({ config, entry, fetchImpl = globalThis.fetch, timeoutMs }) {
  const started = Date.now();
  const body = JSON.stringify(entry);
  const ts = String(entry.ts);
  const headers = {
    "Content-Type": "application/json",
    "X-Flow-Timestamp": ts,
    "X-Flow-Signature": signFlowBody(config.secret, ts, body),
  };
  const result = (outcome, extra = {}) => ({
    outcome,
    mode: null,
    orderRef: null,
    reason: null,
    httpStatus: null,
    error: null,
    ...extra,
    durationMs: Date.now() - started,
    body,
  });

  const ctrl = new AbortController();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve({ timedOut: true });
    }, timeoutMs);
  });
  try {
    const call = (async () => {
      const res = await fetchImpl(config.url, { method: "POST", headers, body, signal: ctrl.signal });
      const status = Number(res?.status);
      let text = "";
      try { text = await res.text(); } catch (e) { text = ""; }
      return { status, text };
    })().catch((e) => ({ networkError: e?.message || String(e) }));
    const r = await Promise.race([call, timeout]);
    if (r.timedOut) return result("UNKNOWN", { error: `timeout after ${timeoutMs}ms` });
    if (r.networkError) return result("UNKNOWN", { error: `network error: ${r.networkError}` });
    if (r.status !== 200) return result("UNKNOWN", { httpStatus: r.status, error: `HTTP ${r.status}` });
    let json = null;
    try { json = JSON.parse(r.text); } catch (e) { json = null; }
    const st = String(json?.status || "").toLowerCase();
    const fields = {
      httpStatus: 200,
      mode: typeof json?.mode === "string" ? json.mode : null,
      orderRef: json?.orderRef === null || json?.orderRef === undefined ? null : String(json.orderRef),
      reason: json?.reason === null || json?.reason === undefined ? null : String(json.reason),
    };
    if (st === "accepted") return result("ACCEPTED", fields);
    if (st === "rejected") return result("REJECTED", fields);
    if (st === "duplicate") return result("DUPLICATE", fields);
    return result("UNKNOWN", { ...fields, error: json ? `unrecognised status ${JSON.stringify(json?.status ?? null)}` : "response is not JSON" });
  } finally {
    clearTimeout(timer);
  }
}
