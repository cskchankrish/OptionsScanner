/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OptionsScanner × TradingView v4.3 — Webhook Bridge Fusion Engine
 *  File: api/tv-webhook.js (Vercel / Express Serverless Endpoint)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  HOW IT WORKS:
 *  1. Receives real-time JSON alerts from TradingView Strategy Dashboard v4.3
 *     (`BEAR_TRAP_BUY`, `BULL_TRAP_SELL`, `SWING_BOTTOM`, `SWING_TOP`, `MEGA`,
 *      `WATCH`, `SYNERGY_BULL`, `SYNERGY_BEAR`, `RE_ENTRY`, `TREND_FLIP`).
 *  2. Authenticates the payload against `process.env.TV_WEBHOOK_SECRET` or fallback.
 *  3. Reads the latest 100% REAL 22-Strike NSE Option Chain + Futures snapshot
 *     from Upstash Redis (`nifty:flow:latest` & `nifty_latest_session_payload_v2`)
 *     computed by your live `api/nifty-oi.js` & `evaluateSmartMoneyFusion()`.
 *  4. Fuses TradingView's price-action/EMA/Supertrend/Real-Futures-OI trigger
 *     with the live NSE Option Chain corridor (`deltaPCR`, `floorStrike`,
 *     `roofStrike`, `scenarios`) to produce a final Execution Decision:
 *       • EXECUTE_TIER1_SCOUT (1-2 Lots Early Trap / Reversal Scout with tight SL)
 *       • EXECUTE_TIER2_ADD   (Full/Add Lots on Confirmed Swing / Synergy / Mega)
 *       • DOWNGRADE_TO_SCALP  (1 Lot Intraday only if VETO_BTST/VETO_STBT is active)
 *       • VETO_SIGNAL         (0 Lots - Blocks trade when real 22-strike Option Chain
 *                              directly contradicts the chart signal)
 *       • BLOCKED_BY_ACTIVE_TRADE (0 Lots - Enforces the tested Single-Position Rule)
 *       • LOG_ONLY            (0 Lots - Informational logging for non-trap alerts)
 *  5. Logs the fused decision to Upstash Redis (`nifty:tv:signals:YYYY-MM-DD` and `nifty:tv:latest_signal`)
 *     and permanent master archive (`nifty:tv:signals:master_archive`) for 1-2 month review.
 */

import { Redis } from "@upstash/redis";
import { authorizeRequest } from "../src/webhookAuth.js";
import { isSpotFrozenAt } from "../src/flowCalc.js";
import {
  getFlowBridgeConfig,
  shouldDispatch,
  buildFlowEntry,
  dispatchFlowEntry,
  computeDispatchTimeoutMs,
  newTradeId as defaultNewTradeId,
  isBridgeOwned,
  ENTRY_REPORTABLE_STATUSES,
  ENTRY_SYNC_GRADES,
  getFillWaitSec,
  isStuckAccepted,
} from "../src/flowBridge.js";
import { parseAlgoPnl, algoPnlLines, formatInr, indexMovePts } from "../src/algoPnl.js";
import { formatEodCardLines } from "../src/eodCard.js";
import { recordEvent as scRecordEvent, scStoreFromClient, buildSignalEvent, buildTradeEvent, istOf as scIstOf } from "../src/scorecard.js";

/** Appends one scorecard event (measurement only; never throws, never changes a response). */
async function scRecord(redis, event) {
  try {
    if (!redis || !event) return;
    await scRecordEvent({ store: scStoreFromClient(redis), date: scIstOf(event.t).date, event });
  } catch (e) { /* measurement only */ }
}
import {
  CARRY_ACTIVE_KEY,
  CARRY_SYNC_GRADES,
  handleCarrySync,
  storeFromClient,
  summarizeCarry,
  isCarryOpen,
} from "../src/carryBridge.js";

/** Summary of the open overnight carry (separate key; never blocks intraday validation). */
async function readOpenCarry(redis) {
  if (!redis) return null;
  try {
    const raw = await redis.get(CARRY_ACTIVE_KEY);
    const t = typeof raw === "string" ? JSON.parse(raw) : raw;
    return isCarryOpen(t) ? summarizeCarry(t) : null;
  } catch (e) {
    return null;
  }
}

export const ACTIVE_TRADE_KEY = "nifty:tv:active_trade";

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_TOKEN;

let _redisInstance = null;
let _redisOverride = null;
/** Test hook: inject an in-memory Redis-like client (pass null to clear). */
export function setRedisClientForTesting(client) {
  _redisOverride = client || null;
}
export function getRedisClient() {
  if (_redisOverride) return _redisOverride;
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  if (!_redisInstance) {
    try {
      _redisInstance = new Redis({
        url: REDIS_URL,
        token: REDIS_TOKEN,
      });
    } catch (e) {
      console.warn("Failed to initialize @upstash/redis client:", e.message);
      return null;
    }
  }
  return _redisInstance;
}

// Fallback direct REST helpers in case SDK encounters connection or serialization edge-cases
async function redisRestGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    return null;
  }
}

async function redisRestSet(key, value, exSeconds = 86400) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?ex=${exSeconds}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

/** Maximum accepted age (seconds) of the `nifty:flow:latest` snapshot for actionable grades. */
export function getFlowMaxAgeSec() {
  const v = Number(process.env.FLOW_MAX_AGE_SEC);
  return Number.isFinite(v) && v > 0 ? v : 900;
}

export const ACTIONABLE_GRADES = ["BEAR_TRAP_BUY", "BULL_TRAP_SELL", "SYNERGY_BULL", "SYNERGY_BEAR"];

/**
 * Budget (ms) for the webhook's one on-demand option-chain refresh. Vercel caps the function at
 * 15s (vercel.json maxDuration). Before the refresh the handler spends <~1s (auth + one Redis
 * GET); after it, up to ~5s more (Redis re-read, active-trade GET/SET, 5 list writes, Telegram
 * send, watchdog). 8s for the refresh leaves ~6s of headroom for that tail. Inside the refresh
 * the NSE fetch timeouts shrink to the deadline and ~2.5s is reserved for the awaited Redis
 * write. Override with FLOW_REFRESH_TIMEOUT_MS (clamped to 1000..10000).
 */
export function getFlowRefreshTimeoutMs() {
  const v = Number(process.env.FLOW_REFRESH_TIMEOUT_MS);
  if (!Number.isFinite(v) || v <= 0) return 8000;
  return Math.min(10000, Math.max(1000, v));
}

const SNAPSHOT_SOURCE_LABELS = {
  poller: "poller",
  "webhook-refresh": "on-demand refresh (earlier webhook)",
  browser: "browser view",
  cron: "legacy cron ping",
};

function describeSnapshotSource(liveScanner, refreshedNow) {
  if (refreshedNow) return "on-demand refresh (this alert)";
  const s = liveScanner?.snapshotSource;
  return SNAPSHOT_SOURCE_LABELS[s] || (s ? String(s) : "unknown writer");
}

let _webhookDepsOverride = null;
/** Test hook: override the refresh / session / clock / Telegram-text dependencies (null clears). */
export function setWebhookDepsForTesting(deps) {
  _webhookDepsOverride = deps || null;
}

function getWebhookDeps() {
  const defaults = {
    now: () => Date.now(),
    isLiveMarket: async () => {
      const { getMarketSessionInfo } = await import("./nifty-oi.js");
      return Boolean(getMarketSessionInfo().isLiveMarket);
    },
    refresh: async ({ deadlineMs }) => {
      // Without Redis the refreshed snapshot could not be persisted or re-read: fail fast, no NSE call.
      if (!REDIS_URL || !REDIS_TOKEN) return { ok: false, stage: "redis", error: "Redis not configured" };
      const { refreshLiveSnapshot } = await import("./nifty-oi.js");
      return refreshLiveSnapshot({ queryExpiry: "near", awaitPersist: true, source: "webhook-refresh", deadlineMs });
    },
    sendText: sendTelegramText,
    // Flow execution bridge (src/flowBridge.js): HTTP client and trade-id generator.
    bridgeFetch: (...args) => globalThis.fetch(...args),
    newTradeId: defaultNewTradeId,
  };
  return { ...defaults, ...(_webhookDepsOverride || {}) };
}

/** Runs the refresh core once, bounded by timeoutMs. Never throws. */
export async function attemptOnDemandRefresh({ refresh, timeoutMs, nowMs = Date.now() }) {
  const started = Date.now();
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, stage: "timeout", error: `refresh timed out after ${timeoutMs}ms` }),
      timeoutMs
    );
  });
  let result;
  try {
    result = await Promise.race([
      Promise.resolve()
        .then(() => refresh({ deadlineMs: nowMs + timeoutMs }))
        .catch((e) => ({ ok: false, stage: "exception", error: e?.message || String(e) })),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
  return {
    attempted: true,
    ok: Boolean(result?.ok),
    stage: result?.ok ? null : result?.stage || "unknown",
    error: result?.ok ? null : result?.error || "refresh failed",
    durationMs: Date.now() - started,
  };
}

async function readFlowSnapshot(redis, { allowSessionFallback = false } = {}) {
  const parseMaybe = (v) => (typeof v === "string" ? JSON.parse(v) : v);
  let snap = null;
  if (redis) {
    try {
      snap = parseMaybe(await redis.get("nifty:flow:latest"));
      if (!snap && allowSessionFallback) snap = parseMaybe(await redis.get("nifty_latest_session_payload_v2"));
      return snap;
    } catch (e) {
      // fall through to REST
    }
  }
  snap = await redisRestGet("nifty:flow:latest");
  if (!snap && allowSessionFallback) snap = await redisRestGet("nifty_latest_session_payload_v2");
  return snap;
}

/** Watchdog adapter for the @upstash/redis client used by the webhook. Never throws. */
async function runWebhookWatchdog({ redis, snapshotAt, isLiveMarket, lastError, deps }) {
  if (!isLiveMarket) return { status: "OUTSIDE_SESSION", sent: false };
  try {
    const { checkFlowWatchdog } = await import("../src/flowWatchdog.js");
    let at = snapshotAt;
    if (at === undefined) {
      const snap = await readFlowSnapshot(redis);
      at = snap?.snapshotAt ?? null;
    }
    return await checkFlowWatchdog({
      snapshotAt: at,
      isLiveMarket,
      nowMs: deps.now(),
      trigger: "webhook",
      lastError,
      deps: {
        setNx: async (k, v, ttl) => {
          if (!redis) throw new Error("Redis not configured");
          const r = await redis.set(k, JSON.stringify(v), { nx: true, ex: ttl });
          return r === "OK";
        },
        del: async (k) => {
          if (!redis) throw new Error("Redis not configured");
          return Number(await redis.del(k)) || 0;
        },
        send: deps.sendText,
      },
    });
  } catch (e) {
    return { status: "WATCHDOG_ERROR", sent: false, error: e?.message };
  }
}

/** Age of a snapshot in whole seconds, or null when it carries no usable `snapshotAt`. */
export function getSnapshotAgeSec(liveScanner, nowMs = Date.now()) {
  const at = Number(liveScanner?.snapshotAt);
  if (!liveScanner || !Number.isFinite(at) || at <= 0) return null;
  // A timestamp more than 60s in the future is not trustworthy.
  if (at - nowMs > 60000) return null;
  return Math.max(0, Math.round((nowMs - at) / 1000));
}

// Helper: Current IST Date string (YYYY-MM-DD)
export function getIstDateString() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Core Webhook Bridge Fusion Evaluator
 * Combines TradingView v4.3 payload + Live OptionsScanner 22-Strike Option Chain
 */
export function fuseChartWithOptionChain(tv, liveScanner, nowMs = Date.now()) {
  const dir = String(tv.dir || "LONG").toUpperCase();
  const grade = String(tv.grade || "SIGNAL").toUpperCase();
  const close = Number(tv.close || 0);

  // Parse stops and distances safely (null/0 when non-existent, avoiding fake synthetic stops)
  const rawSl = (tv.sl === null || tv.sl === undefined || tv.sl === "null" || Number(tv.sl) <= 0) ? null : Number(tv.sl);
  const cappedSl = (tv.cappedSl === null || tv.cappedSl === undefined || tv.cappedSl === "null" || Number(tv.cappedSl) <= 0) ? null : Number(tv.cappedSl);
  const rDist = (tv.rDist === null || tv.rDist === undefined || tv.rDist === "null" || Number(tv.rDist) <= 0) ? null : Number(tv.rDist);
  const t1Dist = (tv.t1Dist === null || tv.t1Dist === undefined || tv.t1Dist === "null" || Number(tv.t1Dist) <= 0) ? null : Number(tv.t1Dist);
  const t2Dist = (tv.t2Dist === null || tv.t2Dist === undefined || tv.t2Dist === "null" || Number(tv.t2Dist) <= 0) ? null : Number(tv.t2Dist);
  const t1Price = (tv.t1 === null || tv.t1 === undefined || tv.t1 === "null" || Number(tv.t1) <= 0) ? null : Number(tv.t1);
  const t2Price = (tv.t2 === null || tv.t2 === undefined || tv.t2 === "null" || Number(tv.t2) <= 0) ? null : Number(tv.t2);
  const swingKind = String(tv.swingKind || (tv.reType === 7 ? "CONTINUATION" : "REVERSAL")).toUpperCase();
  const isArmed = Boolean(tv.isArmed);

  // Extract real-time Option Chain metrics supporting both corridor object and root properties
  const hasLiveOptions = Boolean(
    liveScanner &&
      (liveScanner.corridor ||
        liveScanner.strikes ||
        liveScanner.deltaPcr !== undefined ||
        liveScanner.deltaPCR !== undefined)
  );

  // Never fabricate a ΔPCR: missing/non-numeric values stay null (no option-chain confirmation).
  const rawDeltaPCR = hasLiveOptions
    ? (liveScanner.corridor?.deltaPCR ?? liveScanner.deltaPcr ?? liveScanner.deltaPCR ?? null)
    : null;
  const deltaPCR =
    rawDeltaPCR !== null && rawDeltaPCR !== "" && Number.isFinite(Number(rawDeltaPCR))
      ? Number(rawDeltaPCR)
      : null;
  const hasDeltaPCR = deltaPCR !== null;
  const snapshotAt = Number.isFinite(Number(liveScanner?.snapshotAt)) && Number(liveScanner?.snapshotAt) > 0
    ? Number(liveScanner.snapshotAt)
    : null;
  const snapshotAgeSec = getSnapshotAgeSec(liveScanner, nowMs);

  const floorStrike = hasLiveOptions
    ? Number(liveScanner.corridor?.floorStrike ?? liveScanner.floor ?? tv.actFloor ?? 0)
    : Number(tv.actFloor || 0);

  const roofStrike = hasLiveOptions
    ? Number(liveScanner.corridor?.roofStrike ?? liveScanner.roof ?? tv.actRoof ?? 0)
    : Number(tv.actRoof || 0);

  const scannerScenario =
    liveScanner?.smartMoneyFusion?.primaryScenario ||
    liveScanner?.fusion?.scenarioId ||
    tv.fusion ||
    "MIXED_FLOW";
  // Only a scenario computed by the server from real option-chain data may confirm a trade.
  const serverScenario = hasDeltaPCR
    ? (liveScanner?.smartMoneyFusion?.primaryScenario || liveScanner?.fusion?.scenarioId || null)
    : null;

  const scannerAction =
    liveScanner?.smartMoneyFusion?.actionTag ||
    liveScanner?.fusion?.eodCarryVeto ||
    "NEUTRAL";

  // Futures quadrant comes from the server only — never from the chart's own tv.futQuad
  // (that would make the futures veto circular). Missing or stale => "UNAVAILABLE",
  // which matches no veto and no confirmation condition below.
  const futuresStale = Boolean(liveScanner?.futures?.isStale);
  const serverFutQuadRaw =
    liveScanner?.futures?.quadrant ?? liveScanner?.fusion?.quadrantInfo?.quadrant ?? null;
  const liveFutQuad = !serverFutQuadRaw || futuresStale ? "UNAVAILABLE" : String(serverFutQuadRaw);
  // Which quadrant the server published: "INTRADAY" (rolling window) or "DAY" (vs prev close/open).
  const liveFutQuadSource = liveScanner?.futures?.quadrantSource ?? liveScanner?.fusion?.quadrantSource ?? null;
  const liveFutQuadSourceLabel = liveScanner?.futures?.quadrantSourceLabel ?? liveScanner?.fusion?.quadrantSourceLabel ?? null;
  // Rolling-window quadrant shown for information only when it is not the one driving decisions
  // (default day mode). Never read by any veto, sizing or confirmation below.
  const intradayInfo = liveScanner?.futures?.quadrantIntraday ?? liveScanner?.fusion?.quadrantIntraday ?? null;
  const intradayInfoText = liveFutQuadSource !== "INTRADAY" && intradayInfo?.available
    ? `Last ${intradayInfo.windowMins} min futures (informational, not used for this decision): ${intradayInfo.quadrant} (${intradayInfo.window}).`
    : null;
  const chartFutQuad = tv.futQuad ?? null;

  // Distance to real Option Chain walls
  const distToFloor = floorStrike > 0 ? close - floorStrike : null;
  const distToRoof = roofStrike > 0 ? roofStrike - close : null;
  const nearPutWall = distToFloor !== null && Math.abs(distToFloor) <= 80;
  const nearCallWall = distToRoof !== null && Math.abs(distToRoof) <= 80;

  // Real Option Chain Writer Blitz checks (from 22-strike corridor)
  // No data => no blitz (previously defaulted to true, i.e. failed open).
  const realPutBlitz = hasDeltaPCR ? deltaPCR >= 1.30 : false;
  const realCallBlitz = hasDeltaPCR ? deltaPCR <= 0.75 : false;
  const severeOppositeCallWriting = deltaPCR !== null && deltaPCR <= 0.55;
  const severeOppositePutWriting = deltaPCR !== null && deltaPCR >= 1.65;

  let decision = "EXECUTE";
  let tier = "TIER_2_CONFIRMED";
  let recommendedLots = 1;
  const reason = [];

  // ── CASE 1: Tier-1 Early Scout Signals (BEAR_TRAP_BUY / BULL_TRAP_SELL) ──
  if (grade === "BEAR_TRAP_BUY") {
    tier = "TIER_1_SCOUT";
    if (severeOppositeCallWriting && liveFutQuad === "SHORT_BUILDUP") {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `VETOED: Chart flagged Bear Trap Buy, but real 22-strike Option Chain shows heavy Call Writing (ΔPCR=${deltaPCR?.toFixed(2)}) + Futures Short Buildup${liveFutQuadSourceLabel ? ` [quadrant: ${liveFutQuadSourceLabel}]` : ""}.`
      );
    } else {
      decision = "EXECUTE_TIER1_SCOUT";
      recommendedLots = realPutBlitz && nearPutWall ? 2 : 1;
      reason.push(
        `TIER-1 BEAR TRAP SCOUT BUY confirmed (${tv.futOiSrc === "PROXY" ? "Basis/Flow" : "Real Fut OI " + (tv.futOiPct ?? "0") + "%"}).`
      );
      if (realPutBlitz) {
        reason.push(
          `Real 22-strike Option Chain confirms Put Writing support (ΔPCR=${deltaPCR?.toFixed(2)}) near Floor ${floorStrike}.`
        );
      }
    }
  } else if (grade === "BULL_TRAP_SELL") {
    tier = "TIER_1_SCOUT";
    if (severeOppositePutWriting && liveFutQuad === "LONG_BUILDUP") {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `VETOED: Chart flagged Bull Trap Sell, but real 22-strike Option Chain shows aggressive Put Writing (ΔPCR=${deltaPCR?.toFixed(2)}) + Futures Long Buildup${liveFutQuadSourceLabel ? ` [quadrant: ${liveFutQuadSourceLabel}]` : ""}.`
      );
    } else {
      decision = "EXECUTE_TIER1_SCOUT";
      recommendedLots = realCallBlitz && nearCallWall ? 2 : 1;
      reason.push(
        `TIER-1 BULL TRAP SCOUT SELL confirmed (${tv.futOiSrc === "PROXY" ? "Basis/Flow" : "Real Fut OI " + (tv.futOiPct ?? "0") + "%"}).`
      );
      if (realCallBlitz) {
        reason.push(
          `Real 22-strike Option Chain confirms Call Writing ceiling (ΔPCR=${deltaPCR?.toFixed(2)}) near Roof ${roofStrike}.`
        );
      }
    }
  }

  // ── CASE 2: High-Conviction Synergy (SYNERGY_BULL / SYNERGY_BEAR) ──
  else if (grade === "SYNERGY_BULL" || grade === "SYNERGY_BEAR") {
    tier = "HIGH_CONVICTION_SYNERGY";
    const isLong = dir === "LONG";

    if (isLong) {
      // Bull Synergy: Chart flagged Long Buildup + Put Blitz
      // Validate against real 22-strike Option Chain
      if (
        severeOppositeCallWriting ||
        liveFutQuad === "SHORT_BUILDUP" ||
        (deltaPCR !== null && deltaPCR < 0.95) ||
        (nearCallWall && deltaPCR !== null && deltaPCR <= 1.15)
      ) {
        decision = "VETO_DIVERGENT_SYNERGY";
        recommendedLots = 0;
        tier = "VETOED_DIVERGENT";
        reason.push(
          `VETOED: Chart flagged Bull Synergy, but real 22-strike Option Chain shows Call Writing resistance (ΔPCR=${deltaPCR !== null ? deltaPCR.toFixed(2) : "N/A"}) or Futures Short Buildup${liveFutQuadSourceLabel ? ` [quadrant: ${liveFutQuadSourceLabel}]` : ""}. Fake bull flow.`
        );
      } else if (distToRoof !== null && distToRoof < 50 && deltaPCR !== null && deltaPCR < 1.30) {
        decision = "DOWNGRADE_TO_SCALP";
        recommendedLots = 1;
        tier = "SCALP_ONLY";
        reason.push(
          `CAUTION: Bull Synergy approaching Call Roof ${roofStrike} (dist: ${distToRoof.toFixed(0)} pts). Cap at 1 intraday lot.`
        );
      } else {
        const verified =
          (deltaPCR !== null && deltaPCR >= 1.25) ||
          serverScenario === "HIGH_CONVICTION_BULLISH_SYNERGY" ||
          serverScenario === "BULLISH_SYNERGY";
        decision = verified ? "EXECUTE_HIGH_CONVICTION_SYNERGY" : "EXECUTE_MODERATE_SYNERGY";
        recommendedLots = verified ? 2 : 1;
        tier = verified ? "HIGH_CONVICTION_SYNERGY" : "MODERATE_SYNERGY";
        reason.push(
          verified
            ? `HIGH CONVICTION BULL SYNERGY VERIFIED: Real 22-strike Option Chain confirms Put Writing Blitz (ΔPCR=${deltaPCR !== null ? deltaPCR.toFixed(2) : "N/A"}) above Floor ${floorStrike}.`
            : hasDeltaPCR
            ? `MODERATE BULL SYNERGY: Chart triggered Bull Synergy, Option Chain is neutral/mixed (ΔPCR=${deltaPCR.toFixed(2)}). Sized to 1 Lot.`
            : `MODERATE BULL SYNERGY: Chart triggered Bull Synergy; Option Chain data unavailable (ΔPCR=N/A) — NOT confirmed. Sized to 1 Lot.`
        );
      }
    } else {
      // Bear Synergy: Chart flagged Short Buildup + Call Blitz
      // Validate against real 22-strike Option Chain
      if (
        severeOppositePutWriting ||
        liveFutQuad === "LONG_BUILDUP" ||
        (deltaPCR !== null && deltaPCR > 1.05) ||
        (nearPutWall && deltaPCR !== null && deltaPCR >= 0.85)
      ) {
        decision = "VETO_DIVERGENT_SYNERGY";
        recommendedLots = 0;
        tier = "VETOED_DIVERGENT";
        reason.push(
          `VETOED: Chart flagged Bear Synergy, but real 22-strike Option Chain shows aggressive Put Writing (ΔPCR=${deltaPCR !== null ? deltaPCR.toFixed(2) : "N/A"}) or Floor defense near ${floorStrike}${liveFutQuad === "LONG_BUILDUP" ? ` or Futures Long Buildup${liveFutQuadSourceLabel ? ` [quadrant: ${liveFutQuadSourceLabel}]` : ""}` : ""}. High risk of bounce.`
        );
      } else if (distToFloor !== null && distToFloor < 50 && deltaPCR !== null && deltaPCR > 0.70) {
        decision = "DOWNGRADE_TO_SCALP";
        recommendedLots = 1;
        tier = "SCALP_ONLY";
        reason.push(
          `CAUTION: Bear Synergy approaching Put Floor ${floorStrike} (dist: ${distToFloor.toFixed(0)} pts). Cap at 1 intraday lot.`
        );
      } else {
        const verified =
          (deltaPCR !== null && deltaPCR <= 0.75) ||
          serverScenario === "HIGH_CONVICTION_BEARISH_SYNERGY" ||
          serverScenario === "BEARISH_SYNERGY";
        decision = verified ? "EXECUTE_HIGH_CONVICTION_SYNERGY" : "EXECUTE_MODERATE_SYNERGY";
        recommendedLots = verified ? 2 : 1;
        tier = verified ? "HIGH_CONVICTION_SYNERGY" : "MODERATE_SYNERGY";
        reason.push(
          verified
            ? `HIGH CONVICTION BEAR SYNERGY VERIFIED: Real 22-strike Option Chain confirms Call Writing Blitz (ΔPCR=${deltaPCR !== null ? deltaPCR.toFixed(2) : "N/A"}) below Roof ${roofStrike}.`
            : hasDeltaPCR
            ? `MODERATE BEAR SYNERGY: Chart triggered Bear Synergy, Option Chain is neutral/mixed (ΔPCR=${deltaPCR.toFixed(2)}). Sized to 1 Lot.`
            : `MODERATE BEAR SYNERGY: Chart triggered Bear Synergy; Option Chain data unavailable (ΔPCR=N/A) — NOT confirmed. Sized to 1 Lot.`
        );
      }
    }
  }

  // ── CASE 3: Tier-2 Structural / Trend Confirmation (SWING_BOTTOM, SWING_TOP, MEGA, TREND_FLIP) ──
  else if (
    [
      "SWING_BOTTOM",
      "SWING_TOP",
      "MEGA",
      "TREND_FLIP",
    ].includes(grade)
  ) {
    tier = "TIER_2_CONFIRMED_ADD";
    const isLong = dir === "LONG";

    // Check if live Option Chain vetoes an overnight / structural hold
    if (
      isLong &&
      (scannerAction === "VETO_BTST" ||
        (severeOppositeCallWriting && scannerScenario === "BULL_TRAP"))
    ) {
      decision = "DOWNGRADE_TO_SCALP";
      recommendedLots = 1;
      reason.push(
        `CAUTION: Structural ${grade} LONG triggered, but real Option Chain flags ${scannerScenario} (ΔPCR=${deltaPCR?.toFixed(2)}). Cap at 1 intraday lot; do not hold BTST.`
      );
    } else if (
      !isLong &&
      (scannerAction === "VETO_STBT" ||
        (severeOppositePutWriting && scannerScenario === "BEAR_TRAP"))
    ) {
      decision = "DOWNGRADE_TO_SCALP";
      recommendedLots = 1;
      reason.push(
        `CAUTION: Structural ${grade} SHORT triggered, but real Option Chain flags ${scannerScenario} (ΔPCR=${deltaPCR?.toFixed(2)}). Cap at 1 intraday lot; do not hold STBT.`
      );
    } else {
      decision = "EXECUTE_TIER2_ADD";
      const synergyAligned =
        (isLong &&
          (scannerScenario === "HIGH_CONVICTION_BULLISH_SYNERGY" ||
            scannerScenario === "BULLISH_SYNERGY" ||
            realPutBlitz)) ||
        (!isLong &&
          (scannerScenario === "HIGH_CONVICTION_BEARISH_SYNERGY" ||
            scannerScenario === "BEARISH_SYNERGY" ||
            realCallBlitz));
      recommendedLots = synergyAligned ? 2 : 1;
      reason.push(
        hasDeltaPCR
          ? `TIER-2 CONFIRMED ${grade} (${dir}): EMA/Supertrend structure + Option Chain (${scannerScenario}, ΔPCR=${deltaPCR.toFixed(2)}) aligned.`
          : `TIER-2 ${grade} (${dir}): EMA/Supertrend structure only; Option Chain data unavailable (ΔPCR=N/A) — not confirmed by option chain.`
      );
    }
  }

  // ── CASE 3: Standard Intraday Signals (WATCH, SIGNAL, RE_ENTRY, VBO_BREAK, GAP_*) ──
  else {
    tier = "INTRADAY_CONFLUENCE";
    const isLong = dir === "LONG";
    if (
      (isLong && severeOppositeCallWriting) ||
      (!isLong && severeOppositePutWriting)
    ) {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `Blocked intraday ${grade} (${dir}) due to opposing real Option Chain blitz (ΔPCR=${deltaPCR?.toFixed(2)}).`
      );
    } else {
      decision = "EXECUTE_INTRADAY";
      recommendedLots = Number(tv.score || 0) >= 7 ? 2 : 1;
      reason.push(
        hasDeltaPCR
          ? `Intraday ${grade} (${dir}) passed Option Chain filter (Score ${tv.score || 0}/8).`
          : `Intraday ${grade} (${dir}) (Score ${tv.score || 0}/8); Option Chain data unavailable — filter not applied.`
      );
    }
  }

  // Derive final Stop Loss & Targets
  let finalSl = cappedSl !== null && cappedSl > 0
    ? cappedSl
    : (rawSl !== null && rawSl > 0 ? rawSl : null);

  let finalRiskPts = rDist !== null && rDist > 0
    ? Math.round(rDist * 100) / 100
    : (finalSl !== null ? Math.abs(Math.round((close - finalSl) * 100) / 100) : null);

  // Guard against inverted Stop Loss (e.g. SL below entry on a short, or SL above entry on a long)
  if (finalSl !== null && close > 0) {
    if (dir === "SHORT" && finalSl <= close) {
      finalRiskPts = finalRiskPts && finalRiskPts > 0 ? finalRiskPts : 70;
      finalSl = Math.round((close + finalRiskPts) * 100) / 100;
    } else if (dir === "LONG" && finalSl >= close) {
      finalRiskPts = finalRiskPts && finalRiskPts > 0 ? finalRiskPts : 70;
      finalSl = Math.round((close - finalRiskPts) * 100) / 100;
    }
  }

  const finalT1Dist = t1Dist !== null && t1Dist > 0
    ? Math.round(t1Dist * 100) / 100
    : (finalRiskPts !== null ? finalRiskPts : null);

  const finalT2Dist = t2Dist !== null && t2Dist > 0
    ? Math.round(t2Dist * 100) / 100
    : (finalRiskPts !== null ? Math.round(2 * finalRiskPts * 100) / 100 : null);

  const finalT1Price = (finalRiskPts !== null && finalSl !== null)
    ? Math.round((dir === "LONG" ? close + finalT1Dist : close - finalT1Dist) * 100) / 100
    : null;

  const finalT2Price = (finalRiskPts !== null && finalSl !== null)
    ? Math.round((dir === "LONG" ? close + finalT2Dist : close - finalT2Dist) * 100) / 100
    : null;

  return {
    timestamp: new Date().toISOString(),
    istTime: tv.t || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    symbol: tv.sym || "NSE:NIFTY",
    timeframe: tv.tf || "15",
    swingTimeframe: tv.swingTf || "125m",
    direction: dir,
    grade,
    tier,
    decision,
    recommendedLots,
    entryPrice: close,
    stopLoss: finalSl,
    rawStopLoss: rawSl,
    riskPoints: finalRiskPts,
    target1Price: finalT1Price,
    target2Price: finalT2Price,
    target1Dist: finalT1Dist,
    target2Dist: finalT2Dist,
    swingKind,
    isHtfArmed: isArmed,
    chartMetrics: {
      score: tv.score,
      futQuad: tv.futQuad,
      chartFutQuad,
      futOiPct: tv.futOiPct,
      futOiSrc: tv.futOiSrc,
      basis: tv.basis,
      adjBasis: tv.adjBasis,
      dte: tv.dte,
      chartRoof: tv.actRoof,
      chartFloor: tv.actFloor,
    },
    liveOptionChainMetrics: {
      connected: hasLiveOptions,
      deltaPCR,
      floorStrike,
      roofStrike,
      scannerScenario,
      scannerAction,
      liveFutQuad,
      serverFutQuad: liveFutQuad,
      serverFutQuadSource: liveFutQuadSource,
      serverFutQuadSourceLabel: liveFutQuadSourceLabel,
      intradayFutQuadInformational: intradayInfo?.available && liveFutQuadSource !== "INTRADAY" ? intradayInfo.quadrant : null,
      chartFutQuad,
      futuresStale,
      snapshotAt,
      snapshotAgeSec,
      realPutBlitz,
      realCallBlitz,
    },
    reasoning: (intradayInfoText ? [...reason, intradayInfoText] : reason).join(" "),
  };
}

/** "HH:MM" → IST minutes (NaN when unparsable). */
function slotClockMins(hhmm) {
  const m = /^(d{1,2}):(d{2})/.exec(String(hhmm || ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/**
 * Plain Telegram text sender (watchdog / operational alerts). Returns true only on HTTP 2xx.
 */
export async function sendTelegramText(text) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
      signal: AbortSignal.timeout(3000),
    });
    return r.ok;
  } catch (err) {
    console.error("Telegram text send error:", err.message);
    return false;
  }
}

/**
 * Telegram Notification Helper
 */
export async function sendTelegramAlert(fused) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const msg = formatTelegramAlert(fused);

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram webhook error:", err.message);
  }
}

/** One-line description of the open overnight carry for intraday alerts. */
function describeOpenCarry(c) {
  if (!c) return null;
  return `🌙 *Open overnight carry:* \`${c.verdict}\` (${c.dir}) · \`${c.status}\`${c.contract ? ` · \`${mdSafe(c.contract)}\`` : ""} · ID \`${c.id}\` — the Algo rejects new entries while it holds the carry.`;
}

/** Builds the Telegram text for a fused signal (pure; exported for tests). */
export function formatTelegramAlert(fused) {
  const isTrap = fused.grade === "BEAR_TRAP_BUY" || fused.grade === "BULL_TRAP_SELL";
  const isSynergy = fused.grade === "SYNERGY_BULL" || fused.grade === "SYNERGY_BEAR";
  const icon =
    fused.decision === "VETO_SIGNAL" ||
    fused.decision === "VETO_DIVERGENT_SYNERGY" ||
    fused.decision === "VETO_STALE_OPTION_CHAIN" ||
    fused.decision === "BLOCKED_BY_ACTIVE_TRADE"
      ? "🚫"
      : fused.decision === "LOG_ONLY"
      ? "ℹ️"
      : fused.direction === "LONG"
      ? "🟢"
      : "🔴";

  const kindBadge =
    fused.swingKind === "CONTINUATION"
      ? " [TREND CONTINUATION]"
      : fused.swingKind === "REVERSAL"
      ? " [STRUCTURAL REVERSAL]"
      : "";

  const armedBadge = fused.isHtfArmed ? " ⚡ (HTF Armed)" : "";

  let lines = [];

  if (fused.decision === "VETO_STALE_OPTION_CHAIN") {
    lines = [
      `🚫 *VETOED · OPTION CHAIN SNAPSHOT STALE OR MISSING*`,
      `• *Chart Signal:* \`${fused.grade}\`${kindBadge} (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      `• *Chart Price:* \`${fused.entryPrice}\``,
      `• *Verdict:* ${fused.reasoning}`,
      `• *Directive:* 🚫 *DO NOT TRADE (0 Lots)*. The signal could not be verified against a fresh option chain.`,
    ].filter(Boolean);
  } else if (fused.decision === "VETO_DIVERGENT_SYNERGY" || fused.decision === "VETO_SIGNAL") {
    lines = [
      `🚫 *VETOED · REAL OPTION CHAIN DIVERGENCE*`,
      `• *Chart Signal:* \`${fused.grade}\`${kindBadge} (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      `• *Chart Price:* \`${fused.entryPrice}\``,
      fused.stopLoss ? `• *Reference SL:* \`${fused.stopLoss}\` (${fused.riskPoints ?? "--"} pts)` : null,
      `• *Real Fut OI:* \`${fused.chartMetrics.futQuad}\` (${fused.chartMetrics.futOiPct}% · ${fused.chartMetrics.futOiSrc}) | *Basis:* \`${fused.chartMetrics.basis}\``,
      `• *22-Strike Option Chain:* ΔPCR \`${fused.liveOptionChainMetrics.deltaPCR ?? "N/A"}\` | Floor \`${fused.liveOptionChainMetrics.floorStrike}\` | Roof \`${fused.liveOptionChainMetrics.roofStrike}\``,
      `• *Institutional Verdict:* ${fused.reasoning}`,
      `• *Directive:* 🚫 *DO NOT TRADE (0 Lots)*. The TradingView proxy triggered, but live institutional option writers are defending the opposite side!`,
    ].filter(Boolean);
  } else if (fused.decision === "LOG_ONLY") {
    lines = [
      `${icon} *LOG_ONLY* · \`${fused.grade}\`${kindBadge} (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      `• *Signal Close:* \`${fused.entryPrice}\``,
      fused.stopLoss ? `• *Reference SL:* \`${fused.stopLoss}\` (${fused.riskPoints ?? "--"} pts)` : null,
      `• *Status:* Informational alert logged for review. Forward paper trading strictly executes Traps & Verified Synergy.`,
    ].filter(Boolean);
  } else if (fused.decision === "BLOCKED_BY_ACTIVE_TRADE") {
    lines = [
      `${icon} *BLOCKED_BY_ACTIVE_TRADE* · \`${fused.grade}\` (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m)`,
      `• *Signal Close:* \`${fused.entryPrice}\``,
      `• *Verdict:* ${fused.reasoning}`,
      `• *Rule:* Strictly 1 position at a time (as backtested). Close existing trade before entering a new one.`,
    ].filter(Boolean);
  } else {
    // Executable Trap or Synergy
    const targetLine = fused.target1Price
      ? `• *Targets (Fill-Relative):* T1: \`${fused.target1Price}\` (+${fused.target1Dist ?? "--"} pts / 1.0R) | T2: \`${fused.target2Price}\` (+${fused.target2Dist ?? "--"} pts / 2.0R)`
      : null;

    // A signal handed to the Algo must not print the paper-trading protocol.
    const algoHandled = Boolean(fused.execution);
    const squareOff = process.env.FLOW_ALGO_SQUAREOFF_TIME ? `${process.env.FLOW_ALGO_SQUAREOFF_TIME} IST` : "the Algo's configured square-off time";
    lines = [
      `${icon} *${fused.decision}* · \`${fused.grade}\`${kindBadge} (${fused.direction})${armedBadge}`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      algoHandled
        ? `• *Signal Close (spot):* \`${fused.entryPrice}\``
        : `• *Entry (Signal Close):* \`${fused.entryPrice}\` *(Fill at next bar open)*`,
      `• *Stop Loss:* \`${fused.stopLoss ?? "N/A"}\` (${fused.riskPoints ? fused.riskPoints + " pts, ATR-Capped" : "N/A"})`,
      algoHandled && fused.target1Price
        ? `• *Targets (spot):* T1 \`${fused.target1Price}\` | T2 \`${fused.target2Price}\``
        : targetLine,
      algoHandled
        ? `• *Size:* \`1 lot per account\` (Algo hard cap; scanner tier ${fused.tier})`
        : `• *Recommended Size:* \`${fused.recommendedLots} Lot(s)\` (${fused.tier})`,
      fused.tradeId ? `• *Trade ID:* \`${fused.tradeId}\`` : null,
      fused.execution ? `• *Algo Execution:* ${describeExecution(fused.execution)}` : null,
      `• *Real Fut OI:* \`${fused.chartMetrics.futQuad}\` (${fused.chartMetrics.futOiPct}% · ${fused.chartMetrics.futOiSrc}) | *Basis:* \`${fused.chartMetrics.basis}\``,
      `• *22-Strike Option Chain:* ΔPCR \`${fused.liveOptionChainMetrics.deltaPCR ?? "N/A"}\` | Floor \`${fused.liveOptionChainMetrics.floorStrike}\` | Roof \`${fused.liveOptionChainMetrics.roofStrike}\``,
      `• *Verdict:* ${fused.reasoning}`,
    ].filter(Boolean);

    if (algoHandled && (isTrap || isSynergy) && fused.decision.startsWith("EXECUTE")) {
      if (fused.execution.status === "NOT_EXECUTED") {
        lines.push(`\n🤖 *ALGO:* not executed — no position was opened for this signal.`);
      } else {
        lines.push(
          `\n🤖 *ALGO EXECUTION PROTOCOL:*`,
          `1. The Algo buys *1 lot per account immediately* on acceptance (no waiting for the next bar).`,
          `2. At T1 (\`${fused.target1Price ?? "--"}\`) it moves the stop to entry.`,
          `3. At T2 (\`${fused.target2Price ?? "--"}\`) it exits fully.`,
          `4. Any open position is squared off at ${squareOff}.`,
          `Exits are reported back by the Algo; the scanner does not auto-manage this trade.`
        );
      }
    } else if ((isTrap || isSynergy) && fused.decision.startsWith("EXECUTE")) {
      const isHtf = fused.timeframe === "125" || fused.timeframe === "D" || Number(fused.timeframe) >= 60;
      const holdProtocol = isHtf
        ? "Max 15 bars (3-5 Days Swing / Positional Hold on 125m/Daily)"
        : "Max 20 bars (5 Hours Intraday on 15m)";

      lines.push(
        `\n📋 *${isSynergy ? "SYNERGY" : "TRAP"} EXECUTION & EXIT PROTOCOL:*`,
        `1. *Fill:* At market open next bar. Levels are fill-relative:`,
        `   • Stop Loss: Entry ${fused.direction === "LONG" ? "-" : "+"} \`${fused.riskPoints}\` pts`,
        `   • Target 1: Entry ${fused.direction === "LONG" ? "+" : "-"} \`${fused.target1Dist}\` pts -> *Scale out 60% & Move SL to Breakeven*`,
        `   • Target 2: Entry ${fused.direction === "LONG" ? "+" : "-"} \`${fused.target2Dist}\` pts -> *Exit remaining 40%*`,
        `2. *Time-Stop:* ${holdProtocol}. Exit at market if open after max bars.`,
        `3. *Single-Position Rule:* Strictly one trade at a time.`
      );
    }
  }

  if (fused.snapshotProvenance && fused.decision !== "LOG_ONLY") {
    lines.splice(Math.min(3, lines.length), 0, `• *Option-Chain Snapshot:* ${fused.snapshotProvenance}`);
  }

  if (fused.openCarry) lines.push(describeOpenCarry(fused.openCarry));

  return lines.join("\n");
}

/**
 * Telegram T1 Hit & SL to Cost Helper
 */
export async function sendTelegramT1Alert(activeTrade, fillPrice) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !activeTrade) return;

  const t = activeTrade;
  const pts = Math.abs(Number(fillPrice) - Number(t.entryPrice)).toFixed(1);

  const lines = [
    `🎯 *TARGET 1 ACHIEVED (+${pts} pts)* · \`${t.grade}\` (${t.direction})`,
    `• *Entry Price:* \`${t.entryPrice}\` | *T1 Fill:* \`${fillPrice}\``,
    `• *Action Taken:* 60% position scaled out with locked profit!`,
    `• *SL Protection:* Stop Loss automatically moved to *Cost / Breakeven* (\`${t.entryPrice}\`).`,
    `• *Runner Active:* Remaining 40% targeting T2 (\`${t.target2Price}\`) with *ZERO downside risk*!`,
    `• *Time:* ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `• *CSV Log:* https://niftyninjaa.vercel.app/api/tv-webhook?export=csv`,
  ];

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram T1 alert error:", err.message);
  }
}

const signedPts = (v) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v}` : "N/A");

/**
 * Closing-message text (pure; exported for tests).
 *  - Algo-owned trade: leads with the Algo's ₹ result (or "₹ P&L not reported by the Algo");
 *    index points only as "index move, signal entry to exit (not your P&L)".
 *  - Paper trade: the points figure, labelled "paper result in index points".
 */
export function formatExitAlert(exitRecord) {
  const t = exitRecord.trade || {};
  const lines = [`🏁 *TRADE CLOSED* · \`${t.grade}\` (${t.direction})${t.id ? ` · ID \`${t.id}\`` : ""}`];
  if (exitRecord.algoOwned) {
    lines.push(...algoPnlLines(exitRecord.algoPnl));
    lines.push(`• *Exit Reason:* \`${exitRecord.exitReason}\`${exitRecord.closeReason ? ` (${mdSafe(exitRecord.closeReason)})` : ""}`);
    lines.push(`• *Signal Entry:* \`${t.entryPrice}\` | *Exit Level (spot):* \`${exitRecord.exitPrice || "Market"}\``);
    if (Number.isFinite(exitRecord.indexMovePts)) {
      lines.push(`• *Index move, signal entry to exit (not your P&L):* \`${signedPts(exitRecord.indexMovePts)} pts\``);
    }
  } else {
    const pnlStr = exitRecord.netPnl !== undefined && exitRecord.netPnl !== null ? signedPts(exitRecord.netPnl) : "N/A";
    lines.push(
      `• *Exit Reason:* \`${exitRecord.exitReason}\``,
      `• *Entry Price:* \`${t.entryPrice}\` | *Exit Level:* \`${exitRecord.exitPrice || "Market"}\``,
      `• *Paper result in index points:* \`${pnlStr} pts\``,
    );
  }
  lines.push(
    `• *Time Closed:* ${exitRecord.istTime}`,
    `• *Market Status:* 🟢 *NO ACTIVE TRADES (FLAT)*`,
    `• *Permission:* Single-position lock released. Bridge is unlocked! You may now evaluate the next Trap setup or Synergy trade.`,
    `• *Download CSV:* https://niftyninjaa.vercel.app/api/tv-webhook?export=csv`,
  );
  return lines.join("\n");
}

export const LAST_EXIT_KEY = "nifty:tv:last_exit";

/** Status-GET summary of a closed trade, leading with the money figure in the right unit. */
export function summarizeExitResult(rec) {
  if (!rec) return null;
  const algo = Boolean(rec.algoOwned);
  const p = rec.algoPnl || null;
  return {
    headline: algo
      ? (p?.reported ? `${formatInr(p.pnlInr)}${p.pnlKnown === false ? " (incomplete: excludes accounts with unknown exit price)" : ""}` : "₹ P&L not reported by the Algo")
      : `${signedPts(rec.netPnl)} pts (paper result in index points)`,
    basis: rec.pnlBasis || (algo ? "ALGO_INR" : "PAPER_INDEX_POINTS"),
    pnlInr: algo && p?.reported ? p.pnlInr : null,
    pnlKnown: algo ? (p?.pnlKnown ?? null) : null,
    accounts: algo ? (p?.accounts || []) : [],
    paperIndexPts: algo ? null : (Number.isFinite(rec.netPnl) ? rec.netPnl : null),
    indexMovePtsNotPnl: algo ? (rec.indexMovePts ?? null) : null,
    exitReason: rec.exitReason,
    closeReason: rec.closeReason ?? null,
    tradeId: rec.trade?.id ?? null,
    grade: rec.trade?.grade ?? null,
    direction: rec.trade?.direction ?? null,
    closedAt: rec.timestamp,
  };
}

/** Remembers the latest closed trade for the status GET. Never throws. */
async function recordLastExit(redis, exitRecord) {
  if (!redis) return;
  try {
    await redis.set(LAST_EXIT_KEY, JSON.stringify(exitRecord), { ex: 7 * 86400 });
  } catch (e) {}
}

/**
 * Telegram Exit Notification Helper
 */
export async function sendTelegramExitAlert(exitRecord) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !exitRecord?.trade) return;

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: formatExitAlert(exitRecord),
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram exit alert error:", err.message);
  }
}

/**
 * Telegram EOD 15:15 Decision Helper, Radar Updates (14:15 - 15:35 IST slots) & Flip Alerts
 */
const EOD_CATEGORY_LABELS = { BTST: "BTST (BUY CE)", STBT: "STBT (BUY PE)", NO_CARRY: "NO CARRY (CASH)" };
const fmtEodScore = (s) => (Number.isFinite(Number(s)) && s !== null ? (Number(s) >= 0 ? `+${Number(s)}` : `${Number(s)}`) : "n/a");

/**
 * @param {object} [opts]
 * @param {boolean} [opts.isScheduledSlot=true] false for an immediate flip alert sent between slots
 * @param {boolean} [opts.isLastScheduled] the 15:35 slot: last scheduled update before the 15:40 close
 * @param {object|null} [opts.flip] { fromCategory, toCategory, fromScore, toScore, fromTime, toTime }
 */
export async function sendTelegramEODAlert(eodDecision, spot, floorStrike, roofStrike, slotTimeStr = "15:15", opts = {}) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !eodDecision) return;

  const isScheduledSlot = opts?.isScheduledSlot !== false;
  const flip = opts?.flip || null;
  const isFinalDirective = (slotTimeStr === "15:15") && isScheduledSlot;
  const isBTST = eodDecision.verdict?.includes("BTST") || eodDecision.bias === "BULLISH";
  const isSTBT = eodDecision.verdict?.includes("STBT") || eodDecision.bias === "BEARISH";

  let header = "";
  if (isFinalDirective) {
    header = isBTST
      ? "🟢 *OFFICIAL EOD CARRY DIRECTIVE · BTST (BUY CE)*"
      : isSTBT
      ? "🔴 *OFFICIAL EOD CARRY DIRECTIVE · STBT (BUY PE)*"
      : "⚪ *OFFICIAL EOD CARRY DIRECTIVE · CASH ONLY (DO NOT CARRY)*";
  } else {
    header = isBTST
      ? `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · BTST CE BIAS*`
      : isSTBT
      ? `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · STBT PE BIAS*`
      : `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · NEUTRAL / CASH BIAS*`;
  }

  if (opts?.isLastScheduled && isScheduledSlot) {
    header = header.replace(`(${slotTimeStr} IST UPDATE)`, `(${slotTimeStr} IST · LAST SCHEDULED UPDATE BEFORE 15:40 CLOSE)`);
  }

  const lines = [];
  if (flip) {
    const fromLabel = EOD_CATEGORY_LABELS[flip.fromCategory] || flip.fromCategory;
    const toLabel = EOD_CATEGORY_LABELS[flip.toCategory] || flip.toCategory;
    lines.push(`🔀🚨 *EOD CARRY DECISION FLIP (${flip.toTime || slotTimeStr} IST) · ${fromLabel} → ${toLabel}*`);
    lines.push(`• *Decision Changed:* \`${fromLabel}\` (Score \`${fmtEodScore(flip.fromScore)}\`${flip.fromTime ? `, sent ${flip.fromTime} IST` : ""}) → \`${toLabel}\` (Score \`${fmtEodScore(flip.toScore)}\`)`);
    lines.push("");
  }
  // Verdict card header block (same wording as the dashboard card), before the existing detail.
  if (eodDecision.card) {
    lines.push(...formatEodCardLines(eodDecision.card), "");
  }
  lines.push(
    header,
    `• *${isFinalDirective ? "Official Verdict" : "Interim Verdict"}:* \`${eodDecision.verdict}\``,
    eodDecision.bias === "NEUTRAL" || eodDecision.conviction == null
      ? `• *Score vs thresholds:* ${eodDecision.thresholdDistance?.text || `Score ${eodDecision.score}`} (no carry: no agreement figure)`
      : `• *Bias & Agreement:* ${eodDecision.bias} (Score: \`${eodDecision.score >= 0 ? "+" + eodDecision.score : eodDecision.score}\` | Agreement: \`${eodDecision.conviction}/100\` — rule-based, not a probability${eodDecision.agreement ? `; ${eodDecision.agreement.groupsAgreeing.length}/3 evidence groups agree` : ""})`,
    `• *Recommended Sizing:* \`${eodDecision.sizing}\``,
    `• *Spot Index:* \`₹${Math.round(spot)}\`${isSpotFrozenAt(slotClockMins(slotTimeStr)) ? " ❄ _(frozen 15:15–15:30 for the NSE closing auction)_" : ""} | *Corridor:* Floor \`${floorStrike}\` ↔ Roof \`${roofStrike}\``,
  );

  if (eodDecision.targetContract) {
    const rolloverNotice = eodDecision.isRollover ? " 🔄 *(Next-Week Rollover)*" : "";
    lines.push(`• *Target Contract Expiry:* \`${eodDecision.targetContract}\`${rolloverNotice}`);
  }

  if (isBTST || isSTBT) {
    if (eodDecision.target) lines.push(`• *Target:* \`₹${eodDecision.target}\``);
    if (eodDecision.stopLoss) lines.push(`• *Strict SL:* \`₹${eodDecision.stopLoss}\``);
  }

  lines.push(`• *Action Guidance:* ${eodDecision.action}`);

  if (eodDecision.audit && eodDecision.audit.length > 0) {
    lines.push(`• *Institutional Evidence:*`);
    // Grouped audit: one line per independent evidence group, then any veto guardrails.
    const grouped = eodDecision.audit.filter(a => a.isGroupSummary || a.group === "GUARD");
    (grouped.length > 0 ? grouped : eodDecision.audit.slice(0, 4)).forEach(a => {
      lines.push(`  - ${a.label}: \`${a.status}\` (${a.impact})`);
    });
    const closingGroup = eodDecision.audit.find(a => a.isGroupSummary && a.group === "B");
    if (closingGroup?.detail) lines.push(`  - Closing flow: ${closingGroup.detail}`);
  }

  if (!isScheduledSlot) {
    lines.push(`• *Notice:* ⚡ *Immediate flip alert (between scheduled slots). Decision can keep changing until the 15:40 IST close.*`);
  } else if (opts?.isLastScheduled) {
    lines.push(`• *Notice:* 🔔 *LAST SCHEDULED UPDATE before the 15:40 IST close. Only a decision flip will trigger another alert.*`);
  } else if (!isFinalDirective) {
    if (slotTimeStr > "15:15") {
      lines.push(`• *Notice:* ⏳ *Post-directive 5-min pulse. Flow can still flip the carry until the 15:40 IST close; flips are alerted immediately.*`);
    } else if (slotTimeStr >= "15:05") {
      lines.push(`• *Notice:* ⏳ *Evolving 5-min pulse. Final carry directive finalized at 15:15 IST.*`);
    } else {
      lines.push(`• *Notice:* ⏳ *Evolving 15-min pulse. Final carry directive finalized at 15:15 IST.*`);
    }
  }

  lines.push(`• *Time Finalized:* ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST`);
  lines.push(`• *Live OptionsScanner:* https://niftyninjaa.vercel.app`);

  const rawText = lines.join("\n");
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: rawText,
        parse_mode: "Markdown",
      }),
    });
    if (res.ok) {
      return true;
    }
    const errText = await res.text();
    console.error("Telegram Markdown Send Error:", res.status, errText);
    // Robust fallback: strip markdown markup and send clean plain text
    const plainText = rawText.replace(/[*`_]/g, "");
    const retryRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: plainText,
      }),
    });
    return retryRes.ok;
  } catch (err) {
    console.error("Telegram EOD alert error:", err.message);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Flow execution bridge (scanner side) — see docs/flow-bridge.md
// ═══════════════════════════════════════════════════════════════════════════

/** Strips Telegram-Markdown control characters from text that came from outside (Algo reasons). */
function mdSafe(v) {
  return String(v ?? "").replace(/[*_`[\]]/g, "").slice(0, 300);
}

/** One-line description of a trade's execution state (Telegram). */
export function describeExecution(ex) {
  if (!ex) return "n/a";
  switch (ex.status) {
    case "ACCEPTED":
      return `📨 sent to Algo, awaiting fill · mode \`${mdSafe(ex.mode || "?")}\` · orderRef \`${mdSafe(ex.orderRef || "none")}\` · 1 lot`;
    case "FILLED":
      return `✅ FILLED by Algo · \`${mdSafe(ex.contract || "?")}\` @ \`${mdSafe(ex.optionFill ?? "?")}\` · mode \`${mdSafe(ex.mode || "?")}\``;
    case "NOT_EXECUTED":
      return `⚠️ NOT EXECUTED (${mdSafe(ex.outcome || "skipped")}): ${mdSafe(ex.reason || "no reason given")}`;
    case "UNKNOWN":
      return `🚨 UNKNOWN (${mdSafe(ex.error || "no response")}) — CHECK BROKER`;
    case "PENDING":
      return "⏳ dispatch pending";
    default:
      return mdSafe(ex.status);
  }
}

function parseMaybeJson(v) {
  return typeof v === "string" ? JSON.parse(v) : v;
}

/** Deletes the active-trade key only if it still holds the trade `id` (read-check-delete). */
async function releaseActiveTradeIfOwned(redis, id) {
  if (!redis) return false;
  try {
    const cur = parseMaybeJson(await redis.get(ACTIVE_TRADE_KEY));
    if (cur && cur.id === id) {
      await redis.del(ACTIVE_TRADE_KEY);
      return true;
    }
  } catch (e) {
    console.error("[flow-bridge] failed to release position lock:", e?.message);
  }
  return false;
}

/**
 * Dispatches an already-claimed trade to the Algo and applies the outcome to the lock.
 * Mutates `activeData.execution`; returns the execution record. Never throws.
 */
async function runBridgeDispatch({ redis, config, fused, activeData, activeTtl, deps, requestStartMs }) {
  const id = activeData.id;
  const at = () => new Date(deps.now()).toISOString();
  let execution;
  let dispatch = null;

  const built = buildFlowEntry({ id, ts: deps.now(), fused });
  const timeoutMs = computeDispatchTimeoutMs(config.timeoutMs, Date.now() - requestStartMs);
  if (built.error) {
    execution = { status: "NOT_EXECUTED", outcome: "NOT_SENT", reason: `not dispatched: ${built.error}`, mode: null, orderRef: null, at: at() };
  } else if (timeoutMs === 0) {
    execution = { status: "NOT_EXECUTED", outcome: "NOT_SENT", reason: "not dispatched: request time budget exhausted before dispatch", mode: null, orderRef: null, at: at() };
  } else {
    dispatch = await dispatchFlowEntry({ config, entry: built.entry, fetchImpl: deps.bridgeFetch, timeoutMs });
    if (dispatch.outcome === "ACCEPTED") {
      execution = { status: "ACCEPTED", mode: dispatch.mode, orderRef: dispatch.orderRef, at: at() };
    } else if (dispatch.outcome === "REJECTED" || dispatch.outcome === "DUPLICATE") {
      execution = { status: "NOT_EXECUTED", outcome: dispatch.outcome, reason: dispatch.reason, mode: dispatch.mode, orderRef: dispatch.orderRef, at: at() };
    } else {
      execution = { status: "UNKNOWN", error: dispatch.error, httpStatus: dispatch.httpStatus, timeoutMs, at: at() };
    }
    execution.dispatchMs = dispatch.durationMs;
  }
  activeData.execution = execution;

  if (execution.status === "NOT_EXECUTED") {
    // Nothing is held at the broker: free the single-position lock for the next signal.
    await releaseActiveTradeIfOwned(redis, id);
  } else if (redis) {
    try {
      // UNKNOWN is persisted WITHOUT expiry: only the owner (GET close_trade with tradeId) or an
      // Algo sync-back may clear it. ACCEPTED keeps the trade's normal TTL.
      const opts = execution.status === "UNKNOWN" ? undefined : { ex: activeTtl };
      if (opts) await redis.set(ACTIVE_TRADE_KEY, JSON.stringify(activeData), opts);
      else await redis.set(ACTIVE_TRADE_KEY, JSON.stringify(activeData));
    } catch (e) {
      // The claimed record still says PENDING, which is bridge-owned: the lock holds either way.
      console.error("[flow-bridge] failed to record execution outcome:", e?.message);
    }
  }

  const head = `\`${fused.grade}\` ${fused.direction} @ \`${fused.entryPrice}\` · Trade ID \`${id}\``;
  let text;
  if (execution.status === "ACCEPTED") {
    text = [
      `🤖📨 *SENT TO ALGO · AWAITING FILL (1 LOT)* · ${head}`,
      `• *Mode:* \`${mdSafe(execution.mode || "?")}\` | *Order Ref:* \`${mdSafe(execution.orderRef || "none")}\``,
      `• *Levels (spot):* SL \`${fused.stopLoss}\` | T1 \`${fused.target1Price}\` | T2 \`${fused.target2Price}\``,
      `• Accepted = validated and queued, NOT yet filled. A fill/fail report from the Algo follows.`,
      `• Exits now come from the Algo's sync-back; the scanner will not auto-manage this trade.`,
    ].join("\n");
  } else if (execution.status === "NOT_EXECUTED") {
    text = [
      `⚠️ *APPROVED BUT NOT EXECUTED* · ${head}`,
      `• *Algo said:* \`${mdSafe(execution.outcome)}\`${execution.mode ? ` (mode \`${mdSafe(execution.mode)}\`)` : ""}`,
      `• *Reason:* ${mdSafe(execution.reason || "no reason given")}`,
      `• Position lock released — the next signal can be taken.`,
    ].join("\n");
  } else {
    text = [
      `🚨🚨 *ALGO OUTCOME UNKNOWN — CHECK YOUR BROKER NOW* 🚨🚨`,
      `• ${head}`,
      `• *Problem:* ${mdSafe(execution.error || "no response")}`,
      `• The order MAY have been placed. Position stays LOCKED and will NOT auto-clear.`,
      `• If no position exists at the broker, close it here with \`GET /api/tv-webhook?close_trade=1&tradeId=${id}\` (+ secret).`,
      `• Do NOT resend blindly; a resend with the same id is safe (Algo answers duplicate).`,
    ].join("\n");
  }
  try {
    await deps.sendText(text);
  } catch (e) {
    console.error("[flow-bridge] Telegram send failed:", e?.message);
  }
  return execution;
}

export const BRIDGE_FAILED_PREFIX = "nifty:tv:bridge:failed:";
export const BRIDGE_STUCK_ALERT_PREFIX = "nifty:tv:bridge:stuck_alert:";
const BRIDGE_MARKER_TTL_SEC = 7 * 86400;

function tradeTtlSec(t) {
  const isHtf = t?.timeframe === "125" || t?.timeframe === "D" || Number(t?.timeframe) >= 60 || t?.grade?.includes("SYNERGY");
  return isHtf ? 604800 : 28800;
}

/**
 * Stuck-ACCEPTED guard: a trade still ACCEPTED (no ENTRY_FILLED / ENTRY_FAILED) more than
 * FLOW_BRIDGE_FILL_WAIT_SEC after acceptance triggers ONE Telegram (deduped with SET NX per trade
 * id). State is never changed. Never throws.
 */
export async function checkStuckAcceptedTrade(redis, trade, deps = getWebhookDeps()) {
  try {
    const waitSec = getFillWaitSec();
    if (!redis || !isStuckAccepted(trade, deps.now(), waitSec)) return false;
    const r = await redis.set(
      BRIDGE_STUCK_ALERT_PREFIX + trade.id,
      JSON.stringify({ at: new Date(deps.now()).toISOString() }),
      { nx: true, ex: BRIDGE_MARKER_TTL_SEC }
    );
    if (r !== "OK") return false;
    const ageSec = Math.round((deps.now() - Date.parse(trade.execution.at)) / 1000);
    await deps.sendText([
      `🚨 *NO FILL REPORT FROM ALGO — CHECK THE BROKER* 🚨`,
      `• \`${trade.grade}\` ${trade.direction} @ \`${trade.entryPrice}\` · Trade ID \`${trade.id}\``,
      `• Accepted ${ageSec}s ago (limit ${waitSec}s) with no ENTRY\\_FILLED / ENTRY\\_FAILED report.`,
      `• Position stays LOCKED; the scanner changes nothing. This alert is sent once.`,
    ].join("\n"));
    return true;
  } catch (e) {
    console.error("[flow-bridge] stuck-accepted check failed:", e?.message);
    return false;
  }
}

/**
 * ENTRY_FILLED / ENTRY_FAILED sync-back (contract v1.1). Requires a tradeId matching the open
 * trade; repeats are 200 no-ops; ENTRY_FAILED after FILLED (or FILLED after a FAILED) is a 409
 * with a loud Telegram.
 */
async function handleEntrySync({ redis, payload, res }) {
  const deps = getWebhookDeps();
  const grade = payload.grade;
  const tradeId = payload.tradeId === undefined || payload.tradeId === null ? "" : String(payload.tradeId);
  const reject = (status, error, detail) => {
    console.warn(`[tv-webhook] ${grade} rejected (${status}): ${detail}`);
    return res.status(status).json({ ok: false, error, detail });
  };
  if (!tradeId) return reject(409, "TRADE_ID_REQUIRED", `${grade} must carry the tradeId from FLOW_ENTRY`);
  if (!redis) return reject(503, "REDIS_UNAVAILABLE", "Redis not configured; cannot apply entry report");

  let activeTrade = null;
  try {
    activeTrade = parseMaybeJson(await redis.get(ACTIVE_TRADE_KEY));
  } catch (e) {
    return reject(503, "REDIS_UNAVAILABLE", `could not read the active trade: ${e?.message}`);
  }
  const nowIso = new Date(deps.now()).toISOString();
  const nowIst = new Date(deps.now()).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const sync = {
    source: payload.source ?? null,
    tradeId,
    spot: payload.spot ?? null,
    optionFill: payload.optionFill ?? null,
    contract: payload.contract ?? null,
    lots: payload.lots ?? null,
    mode: payload.mode ?? null,
    reason: payload.reason ?? null,
    t: payload.t ?? null,
  };
  const loud = async (text) => {
    try { await deps.sendText(text); } catch (e) {}
  };

  if (!activeTrade || String(activeTrade.id || "") !== tradeId) {
    let failed = null;
    try { failed = parseMaybeJson(await redis.get(BRIDGE_FAILED_PREFIX + tradeId)); } catch (e) {}
    if (failed && grade === "ENTRY_FAILED") {
      return res.status(200).json({ ok: true, event: "ENTRY_FAILED", duplicate: true, tradeId });
    }
    if (failed && grade === "ENTRY_FILLED") {
      await loud([
        `🚨🚨 *CONTRADICTORY ALGO REPORTS — CHECK YOUR BROKER NOW* 🚨🚨`,
        `• Trade ID \`${tradeId}\` was reported *ENTRY\\_FAILED* (lock released) but is now reported *FILLED*`,
        `• Contract \`${mdSafe(sync.contract || "?")}\` @ \`${mdSafe(sync.optionFill ?? "?")}\` · mode \`${mdSafe(sync.mode || "?")}\``,
        `• The scanner is NOT tracking this position. Manage it at the broker.`,
      ].join("\n"));
      return reject(409, "CONTRADICTORY_REPORT", `trade ${tradeId} already failed; FILLED report rejected`);
    }
    return reject(409, "TRADE_ID_MISMATCH", activeTrade
      ? `tradeId ${tradeId} does not match the active trade (${activeTrade.id || "no id"})`
      : `tradeId ${tradeId} does not match: no active trade`);
  }

  const ex = activeTrade.execution || null;
  const status = ex?.status || null;
  const head = `\`${activeTrade.grade}\` ${activeTrade.direction} @ \`${activeTrade.entryPrice}\` · Trade ID \`${tradeId}\``;

  if (grade === "ENTRY_FILLED") {
    if (status === "FILLED") return res.status(200).json({ ok: true, event: "ENTRY_FILLED", duplicate: true, tradeId });
    if (!ENTRY_REPORTABLE_STATUSES.includes(status)) {
      return reject(409, "INVALID_TRANSITION", `trade ${tradeId} is ${status || "a paper trade"}; ENTRY_FILLED not applicable`);
    }
    const filledAtMs = Number.isFinite(Number(payload.t)) && Number(payload.t) > 0 ? Number(payload.t) : deps.now();
    activeTrade.execution = {
      ...ex,
      status: "FILLED",
      previousStatus: status,
      optionFill: sync.optionFill,
      contract: sync.contract,
      mode: sync.mode ?? ex.mode ?? null,
      lots: sync.lots,
      fillSpot: sync.spot,
      filledAt: new Date(filledAtMs).toISOString(),
    };
    await redis.set(ACTIVE_TRADE_KEY, JSON.stringify(activeTrade), { ex: tradeTtlSec(activeTrade) });
    const record = {
      type: "ENTRY_FILLED", timestamp: nowIso, istTime: nowIst, trade: activeTrade, decision: "ENTRY_FILLED",
      recommendedLots: 0, sync,
      reasoning: `Algo filled ${sync.contract || "?"} @ ${sync.optionFill ?? "?"} (spot ${sync.spot ?? "?"}, mode ${sync.mode || "?"}).`,
    };
    try { await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(record)); } catch (e) {}
    await loud([
      `🤖✅ *ENTRY FILLED BY ALGO* · ${head}`,
      `• *Contract:* \`${mdSafe(sync.contract || "?")}\` | *Fill:* \`${mdSafe(sync.optionFill ?? "?")}\` | *Spot:* \`${mdSafe(sync.spot ?? "?")}\``,
      `• *Lots:* \`${mdSafe(sync.lots ?? "?")}\` | *Mode:* \`${mdSafe(sync.mode || "?")}\``,
    ].join("\n"));
    return res.status(200).json({ ok: true, event: "ENTRY_FILLED", tradeId, execution: activeTrade.execution });
  }

  // ENTRY_FAILED
  if (status === "FILLED") {
    await loud([
      `🚨🚨 *CONTRADICTORY ALGO REPORTS — CHECK YOUR BROKER NOW* 🚨🚨`,
      `• ${head}`,
      `• Already reported *FILLED* (\`${mdSafe(ex.contract || "?")}\` @ \`${mdSafe(ex.optionFill ?? "?")}\`), now reported *ENTRY\\_FAILED*: ${mdSafe(sync.reason || "no reason")}`,
      `• State NOT changed: the position stays open and locked.`,
    ].join("\n"));
    return reject(409, "CONTRADICTORY_REPORT", `trade ${tradeId} is FILLED; ENTRY_FAILED rejected`);
  }
  if (!ENTRY_REPORTABLE_STATUSES.includes(status)) {
    return reject(409, "INVALID_TRANSITION", `trade ${tradeId} is ${status || "a paper trade"}; ENTRY_FAILED not applicable`);
  }
  activeTrade.execution = {
    ...ex,
    status: "NOT_EXECUTED",
    previousStatus: status,
    outcome: "ENTRY_FAILED",
    reason: sync.reason,
    mode: sync.mode ?? ex.mode ?? null,
    at: nowIso,
  };
  activeTrade.active = false;
  try {
    await redis.set(BRIDGE_FAILED_PREFIX + tradeId, JSON.stringify({ reason: sync.reason, at: nowIso }), { ex: BRIDGE_MARKER_TTL_SEC });
  } catch (e) {}
  await releaseActiveTradeIfOwned(redis, tradeId);
  const record = {
    type: "ENTRY_FAILED", timestamp: nowIso, istTime: nowIst, trade: activeTrade, decision: "NOT_EXECUTED",
    recommendedLots: 0, sync,
    reasoning: `Algo reported entry failed: ${sync.reason || "no reason given"}. Position lock released.`,
  };
  try { await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(record)); } catch (e) {}
  await loud([
    `⚠️ *APPROVED BUT NOT EXECUTED* · ${head}`,
    `• *Algo said:* \`ENTRY_FAILED\`${sync.mode ? ` (mode \`${mdSafe(sync.mode)}\`)` : ""}`,
    `• *Reason:* ${mdSafe(sync.reason || "no reason given")}`,
    `• Position lock released — the next signal can be taken.`,
  ].join("\n"));
  return res.status(200).json({ ok: true, event: "ENTRY_FAILED", tradeId, execution: activeTrade.execution });
}

/**
 * Exit-matching rule. Returns null when the exit may proceed, or a reason string for a 409.
 *  - an exit carrying a tradeId must match the active trade's id;
 *  - a bridge-owned trade can only be exited with its matching tradeId.
 */
export function checkExitTradeMatch(activeTrade, tradeId) {
  const hasId = tradeId !== undefined && tradeId !== null && String(tradeId) !== "";
  if (hasId) {
    if (!activeTrade) return `tradeId ${tradeId} does not match: no active trade`;
    if (String(activeTrade.id || "") !== String(tradeId)) {
      return `tradeId ${tradeId} does not match the active trade (${activeTrade.id || "no id"})`;
    }
    return null;
  }
  if (isBridgeOwned(activeTrade)) {
    return `active trade ${activeTrade.id} is bridge-owned (${activeTrade.execution.status}); exits must carry its tradeId`;
  }
  return null;
}

/**
 * Automatically evaluates the active trade in Redis against live price action (T1, T2, Cost, SL, Time-Stop)
 */
export async function evaluateActiveTradeLifecycle(currentSpot, high = null, low = null, redisClient = null) {
  const redis = redisClient || getRedisClient();
  if (!redis) return null;

  let activeTrade = null;
  try {
    const raw = await redis.get("nifty:tv:active_trade");
    activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }

  if (!activeTrade || !activeTrade.active) return null;
  // A bridge-owned trade (sent to the Algo) is driven only by the Algo's sync-back exits:
  // never auto-scale or auto-close it from scanner prices.
  if (isBridgeOwned(activeTrade)) {
    await checkStuckAcceptedTrade(redis, activeTrade);
    return null;
  }

  const spot = Number(currentSpot);
  if (!spot || isNaN(spot)) return null;

  const barHigh = high !== null && !isNaN(Number(high)) ? Number(high) : spot;
  const barLow = low !== null && !isNaN(Number(low)) ? Number(low) : spot;
  const isLong = activeTrade.direction === "LONG";
  const entry = Number(activeTrade.entryPrice);
  const t1 = Number(activeTrade.target1Price);
  const t2 = Number(activeTrade.target2Price);
  const currentSl = Number(activeTrade.stopLoss);
  const riskPts = Number(activeTrade.riskPoints || Math.abs(entry - currentSl));
  const t1Dist = Number(activeTrade.target1Dist || riskPts);
  const t2Dist = Number(activeTrade.target2Dist || riskPts * 2);

  const nowIst = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const nowIso = new Date().toISOString();

  // 1. Target 1 Evaluation (60% scale-out, move SL to Cost)
  if (!activeTrade.hitT1) {
    const hitT1Now = isLong ? barHigh >= t1 : barLow <= t1;
    if (hitT1Now) {
      activeTrade.hitT1 = true;
      activeTrade.t1HitTime = nowIst;
      activeTrade.t1HitPrice = t1;
      activeTrade.stopLoss = entry; // Move SL to Cost
      activeTrade.slAtCost = true;

      const isHtf = activeTrade.timeframe === "125" || activeTrade.timeframe === "D" || Number(activeTrade.timeframe) >= 60 || activeTrade.grade?.includes("SYNERGY");
      const activeTtl = isHtf ? 604800 : 28800; // 7 days for 125m/Daily/Synergy, 8 hours for 15m intraday

      try {
        await redis.set("nifty:tv:active_trade", JSON.stringify(activeTrade), { ex: activeTtl });
      } catch (e) {}

      const t1Record = {
        type: "TARGET_1_HIT",
        timestamp: nowIso,
        istTime: nowIst,
        trade: activeTrade,
        exitPrice: t1,
        decision: "T1_SCALED_OUT",
        recommendedLots: 0.4,
        netPnl: Number((t1Dist * 0.6).toFixed(2)),
        reasoning: `Target 1 achieved (+${t1Dist} pts). 60% profit booked, SL moved to Cost (${entry}).`,
      };

      try {
        await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(t1Record));
      } catch (e) {}

      await sendTelegramT1Alert(activeTrade, t1);
      return { event: "TARGET_1_HIT", activeTrade };
    }
  }

  // 2. Target 2 Evaluation (Full Profit Close)
  const hitT2Now = isLong ? barHigh >= t2 : barLow <= t2;
  if (hitT2Now) {
    const netPnl = activeTrade.hitT1
      ? Number((t1Dist * 0.6 + t2Dist * 0.4 - 4.0).toFixed(2))
      : Number((t2Dist - 4.0).toFixed(2));

    const exitRecord = {
      type: "TRADE_EXIT",
      timestamp: nowIso,
      istTime: nowIst,
      exitReason: "TARGET_2_HIT",
      exitPrice: t2,
      netPnl,
      trade: activeTrade,
      decision: "EXIT_FULL_PROFIT",
        pnlBasis: "PAPER_INDEX_POINTS",
      recommendedLots: 0,
      reasoning: `Target 2 reached (+${t2Dist} pts). Position 100% closed. Realized net PnL: +${netPnl} pts.`,
    };

    try {
      await Promise.all([
        redis.del("nifty:tv:active_trade"),
        redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
      ]);
    } catch (e) {}

    await recordLastExit(redis, exitRecord);
    await sendTelegramExitAlert(exitRecord);
    return { event: "TARGET_2_HIT", exitRecord };
  }

  // 3. Breakeven / Cost Evaluation (Runner stopped out at Cost after T1)
  if (activeTrade.hitT1) {
    const hitBeNow = isLong ? barLow <= entry : barHigh >= entry;
    if (hitBeNow) {
      const netPnl = Number((t1Dist * 0.6 - 4.0).toFixed(2)); // Locked profit from T1 minus trading cost
      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: "BREAKEVEN_STOP",
        exitPrice: entry,
        netPnl,
        trade: activeTrade,
        decision: "EXIT_BREAKEVEN_RUNNER",
        pnlBasis: "PAPER_INDEX_POINTS",
        recommendedLots: 0,
        reasoning: `Runner stopped at cost (${entry}). Secured 60% profit from T1 with net realized PnL: +${netPnl} pts.`,
      };

      try {
        await Promise.all([
          redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      } catch (e) {}

      await recordLastExit(redis, exitRecord);
      await sendTelegramExitAlert(exitRecord);
      return { event: "BREAKEVEN_STOP", exitRecord };
    }
  } else {
    // 4. Initial Stop Loss Evaluation (before T1)
    const hitSlNow = isLong ? barLow <= currentSl : barHigh >= currentSl;
    if (hitSlNow) {
      const netPnl = Number((-riskPts - 4.0).toFixed(2));
      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: "STOP_LOSS_HIT",
        exitPrice: currentSl,
        netPnl,
        trade: activeTrade,
        decision: "EXIT_STOP_LOSS",
        pnlBasis: "PAPER_INDEX_POINTS",
        recommendedLots: 0,
        reasoning: `Stop loss hit at ${currentSl} (-${riskPts} pts). Loss realized: ${netPnl} pts.`,
      };

      try {
        await Promise.all([
          redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      } catch (e) {}

      await recordLastExit(redis, exitRecord);
      await sendTelegramExitAlert(exitRecord);
      return { event: "STOP_LOSS_HIT", exitRecord };
    }
  }

  return null;
}

/**
 * Main Vercel / Express Serverless Handler
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-webhook-secret");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const requestStartMs = Date.now();
  const istDate = getIstDateString();
  const redis = getRedisClient();

  // ── GET: Query Signals, Archive, Export CSV, or Close Active Trade ──
  if (req.method === "GET") {
    // State-changing or message-sending GETs require the webhook secret (fail closed).
    // Plain reads (status, latest signal, archive, CSV) stay open.
    const hasQueryValue = (v) => v !== undefined && v !== null && v !== "";
    const isMutatingGet =
      req.query?.close_trade === "1" ||
      req.query?.action === "close_trade" ||
      req.query?.test === "telegram" ||
      req.query?.test === "eod" ||
      req.query?.send_eod === "1" ||
      hasQueryValue(req.query?.spot) ||
      hasQueryValue(req.query?.high) ||
      hasQueryValue(req.query?.low);
    if (isMutatingGet) {
      const auth = authorizeRequest(req);
      if (!auth.ok) {
        return res.status(auth.status).json({ ok: false, error: auth.error });
      }
    }

    // 1. Close Active Trade manually or via exit trigger
    if (req.query?.close_trade === "1" || req.query?.action === "close_trade") {
      const exitReason = req.query?.reason || "MANUAL_CLOSE";
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }
      // Same matching rule as exit POSTs: a bridge-owned trade is closed here only with its
      // tradeId (the owner's manual escape hatch for an UNKNOWN outcome checked at the broker).
      const mismatch = checkExitTradeMatch(activeTrade, req.query?.tradeId);
      if (mismatch) {
        console.warn(`[tv-webhook] close_trade rejected (409): ${mismatch}`);
        return res.status(409).json({ ok: false, error: "TRADE_ID_MISMATCH", detail: mismatch });
      }
      if (redis && activeTrade) {
        try {
          await redis.del("nifty:tv:active_trade");
        } catch (e) {}
      }
      if (activeTrade) {
        const exitRecord = {
          type: "TRADE_EXIT",
          timestamp: new Date().toISOString(),
          istTime: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
          exitReason,
          trade: activeTrade,
          // Owner's manual close: no Algo ₹ figures arrive on this path.
          algoOwned: isBridgeOwned(activeTrade),
          algoPnl: null,
          pnlBasis: isBridgeOwned(activeTrade) ? "ALGO_INR" : "PAPER_INDEX_POINTS",
        };
        await recordLastExit(redis, exitRecord);
        if (redis) {
          try {
            await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord));
          } catch (e) {}
        }
        await sendTelegramExitAlert(exitRecord);
        return res.status(200).json({ success: true, message: `Trade closed (${exitReason})`, exitRecord });
      } else {
        return res.status(200).json({ success: true, message: "No active trade was open." });
      }
    }

    // 2. Test Telegram dispatch
    if (req.query?.test === "telegram") {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!botToken || !chatId) {
        return res.status(400).json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables.",
          configured: {
            hasBotToken: Boolean(botToken),
            hasChatId: Boolean(chatId),
          },
        });
      }

      const sampleFused = {
        decision: "EXECUTE_TIER1_SCOUT",
        grade: "BEAR_TRAP_BUY",
        direction: "LONG",
        symbol: "NSE:NIFTY",
        timeframe: "15",
        swingTimeframe: "125m",
        entryPrice: 25030.35,
        stopLoss: 24965,
        riskPoints: 65.35,
        target1Price: 25095.7,
        target2Price: 25161.05,
        target1Dist: 65.35,
        target2Dist: 130.7,
        recommendedLots: 1,
        tier: "TIER_1_SCOUT",
        chartMetrics: {
          futQuad: "LONG_UNWINDING",
          futOiPct: "-1.2",
          futOiSrc: "REAL_1_2",
          basis: "+82.5",
        },
        liveOptionChainMetrics: {
          deltaPCR: "1.45",
          floorStrike: 25000,
          roofStrike: 25200,
        },
        reasoning: "TEST: Telegram Webhook Bridge is 100% operational and linked with OptionsScanner!",
      };

      const tgResult = await sendTelegramAlert(sampleFused);
      return res.status(200).json({
        ok: true,
        message: "Test notification dispatched to your Telegram successfully!",
        tgResult,
      });
    }

    // 2b. Test or Trigger EOD Official Directive Dispatch
    if (req.query?.test === "eod" || req.query?.send_eod === "1") {
      let livePayload = null;
      try {
        const oiRes = await fetch("https://niftyninjaa.vercel.app/api/nifty-oi");
        if (oiRes.ok) livePayload = await oiRes.json();
      } catch (e) {}

      const decision = livePayload?.eodDecision || {
        verdict: "EXIT TO CASH / DO NOT CARRY",
        bias: "NEUTRAL",
        conviction: 50,
        sizing: "0% (Cash Only)",
        action: "Balanced flow without directional edge.",
        targetContract: "17-Nov-2026",
        isRollover: true,
        score: 0,
      };

      const spotVal = livePayload?.spotPrice || 25000;
      const floorVal = livePayload?.floor || 24900;
      const roofVal = livePayload?.roof || 25500;

      const sent = await sendTelegramEODAlert(decision, spotVal, floorVal, roofVal, "15:15");
      return res.status(200).json({
        ok: true,
        dispatched: sent,
        decision,
      });
    }

    try {
      const queryDate = req.query?.date || istDate;

      // 3. Master Historical Archive & CSV Export for reviewing 1-2 months later
      if (req.query?.export === "csv") {
        let allSignals = [];
        if (redis) {
          try {
            const raw = await redis.lrange("nifty:tv:signals:master_archive", 0, 999);
            allSignals = (raw || []).map(item => typeof item === "string" ? JSON.parse(item) : item);
          } catch (e) {}
        }
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=nifty_signals_${istDate}.csv`);
        // NetPnL holds PAPER index points only. Algo-owned rows leave it empty and carry the Algo's
        // rupees in PnlInr (with PnlKnown); IndexMovePtsNotPnl is context, never P&L.
        const header = "Timestamp,IST Time,Grade,Direction,Decision,Lots,Entry,StopLoss,RiskPts,T1,T2,ExitPrice,NetPnL,DeltaPCR,Floor,Roof,FutQuad,FutOI%,Reasoning,PnlBasis,PnlInr,PnlKnown,EntryFill,ExitFill,Qty,IndexMovePtsNotPnl,Accounts\n";
        const csvCell = (v) => (v === null || v === undefined ? "" : v);
        const rows = allSignals.map(s => {
          const cleanReason = (s.reasoning || s.exitReason || "").replace(/"/g, '""');
          const t = s.trade || s;
          const exitP = s.exitPrice !== undefined ? s.exitPrice : "";
          const pnlVal = s.algoOwned ? "" : csvCell(s.netPnl);
          const p = s.algoPnl || null;
          const accts = (p?.accounts || []).map(a => `${a.account ?? "?"}:${a.pnlInr ?? "?"}${a.exitFillSource ? `(${a.exitFillSource})` : ""}`).join("; ").replace(/"/g, '""');
          return `"${s.timestamp}","${s.istTime}","${t.grade || s.grade || s.type || ""}","${t.direction || s.direction || ""}","${s.decision || s.exitReason || s.type || ""}",${s.recommendedLots ?? 0},${t.entryPrice || ""},${t.stopLoss || ""},${t.riskPoints || ""},${t.target1Price || ""},${t.target2Price || ""},${exitP},${pnlVal},${s.liveOptionChainMetrics?.deltaPCR ?? ""},${s.liveOptionChainMetrics?.floorStrike ?? ""},${s.liveOptionChainMetrics?.roofStrike ?? ""},"${s.chartMetrics?.futQuad ?? ""}","${s.chartMetrics?.futOiPct ?? ""}","${cleanReason}",${csvCell(s.pnlBasis)},${p?.reported ? p.pnlInr : ""},${p && p.pnlKnown !== null ? p.pnlKnown : ""},${csvCell(p?.entryFill)},${csvCell(p?.exitFill)},${csvCell(p?.qty)},${s.algoOwned ? csvCell(s.indexMovePts) : ""},"${accts}"`;
        }).join("\n");
        return res.status(200).send(header + rows);
      }

      // 4. Archive JSON Query
      if (req.query?.archive === "1" || req.query?.history === "1") {
        let historyList = [];
        if (redis) {
          try {
            const raw = await redis.lrange("nifty:tv:signals:master_archive", 0, 499);
            historyList = (raw || []).map(item => typeof item === "string" ? JSON.parse(item) : item);
          } catch (e) {}
        }
        return res.status(200).json({
          success: true,
          total: historyList.length,
          signals: historyList,
        });
      }

      let latestSignal = null;
      let activeTrade = null;
      let signals = [];

      if (redis) {
        try {
          const [latest, list, active] = await Promise.all([
            redis.get("nifty:tv:latest_signal"),
            redis.lrange(`nifty:tv:signals:${queryDate}`, 0, 49),
            redis.get("nifty:tv:active_trade"),
          ]);
          latestSignal = typeof latest === "string" ? JSON.parse(latest) : latest;
          activeTrade = typeof active === "string" ? JSON.parse(active) : active;
          signals = (list || []).map(item =>
            typeof item === "string" ? JSON.parse(item) : item
          );
        } catch (e) {
          latestSignal = await redisRestGet("nifty:tv:latest_signal");
        }
      } else {
        latestSignal = await redisRestGet("nifty:tv:latest_signal");
      }

      // Automatic lifecycle evaluation if spot or high/low provided in GET
      if (req.query?.spot) {
        await evaluateActiveTradeLifecycle(req.query.spot, req.query.high, req.query.low, redis);
        if (redis) {
          try {
            const freshActive = await redis.get("nifty:tv:active_trade");
            activeTrade = typeof freshActive === "string" ? JSON.parse(freshActive) : freshActive;
          } catch (e) {}
        }
      }

      // Explicit status check endpoint
      const openCarry = await readOpenCarry(redis);
      let lastResult = null;
      if (redis) {
        try {
          const raw = await redis.get(LAST_EXIT_KEY);
          lastResult = summarizeExitResult(typeof raw === "string" ? JSON.parse(raw) : raw);
        } catch (e) {
          lastResult = null;
        }
      }

      if (req.query?.action === "status" || req.query?.status === "1") {
        const isFlat = !activeTrade || !activeTrade.active;
        return res.status(200).json({
          // Leads with the last closed trade's money result: ₹ from the Algo for Algo-owned
          // trades, index points only for paper trades (labelled as such).
          lastResult,
          success: true,
          status: isFlat ? "FLAT_NO_ACTIVE_TRADES" : "IN_TRADE",
          hasActiveTrade: !isFlat,
          permitsSynergyTrades: isFlat,
          activeTrade,
          // The overnight carry is tracked separately and does not block intraday validation.
          openCarry,
          message: isFlat
            ? "Market is FLAT. No active trades. You may take the next Trap setup or evaluate Bull/Bear Synergy."
            : `Active trade OPEN: ${activeTrade.grade} ${activeTrade.direction} @ ${activeTrade.entryPrice} (SL: ${activeTrade.stopLoss}, T1: ${activeTrade.target1Price}). Single-position lock active.`
        });
      }

      return res.status(200).json({
        lastResult,
        success: true,
        connected: Boolean(REDIS_URL),
        istDate: queryDate,
        activeTrade,
        openCarry,
        latestSignal,
        signals,
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to read signals", details: err.message });
    }
  }

  // ── POST: Process TradingView alert webhook ──
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed. Use POST or GET." });
  }

  try {
    // 1. Verify Webhook Secret — fail closed: 503 when TV_WEBHOOK_SECRET is unset/CHANGE_ME,
    //    401 when the request's secret (body `secret`, x-webhook-secret header or `key` query) is wrong.
    let payload = null;
    try {
      payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      payload = null;
    }
    const auth = authorizeRequest(req, payload);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }
    if (!payload || typeof payload !== "object") {
      return res.status(400).json({ error: "Invalid JSON payload" });
    }

    // 1a. Algo entry outcome sync-back (contract v1.1): ENTRY_FILLED / ENTRY_FAILED.
    if (ENTRY_SYNC_GRADES.includes(payload?.grade)) {
      return await handleEntrySync({ redis, payload, res });
    }

    // 1a'. Overnight carry sync-back: CARRY_FILLED / CARRY_FAILED / CARRY_EXIT (src/carryBridge.js).
    if (CARRY_SYNC_GRADES.includes(payload?.grade)) {
      const d = getWebhookDeps();
      const out = await handleCarrySync({
        payload,
        store: storeFromClient(redis),
        deps: { now: d.now, sendText: d.sendText },
      });
      // Scorecard (measurement only): carry exit with the Algo's rupee result.
      if (out.status === 200 && out.body?.event === "CARRY_EXIT" && !out.body.duplicate && out.body.record) {
        const rec = out.body.record;
        await scRecord(redis, buildTradeEvent({ kind: "CARRY", tradeId: rec.id, exitGrade: rec.exit?.reason || "CARRY_EXIT", direction: rec.dir, entry: rec.entry?.spotRef, exitPrice: rec.exit?.spot, pnlInr: rec.pnlInr, pnlKnown: rec.pnlKnown, accountsCount: rec.algoPnl?.accounts?.length ?? null, nowMs: d.now() }));
      }
      return res.status(out.status).json(out.body);
    }

    // 1b. Handle Trade Exit / T1 Scale-Out Webhooks directly from TradingView or Execution Bridge
    const exitGrades = ["TARGET_1_HIT", "TARGET_2_HIT", "BREAKEVEN_STOP", "STOP_LOSS_HIT", "TIME_STOP_EXIT", "MANUAL_CLOSE"];
    if (exitGrades.includes(payload?.grade)) {
      const runExitWatchdog = async () => {
        const wdDeps = getWebhookDeps();
        let live = false;
        try { live = await wdDeps.isLiveMarket(); } catch (e) { live = false; }
        return runWebhookWatchdog({ redis, snapshotAt: undefined, isLiveMarket: live, lastError: null, deps: wdDeps });
      };
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }

      // Exit matching: a tradeId must match the active trade; a bridge-owned trade needs one.
      const mismatch = checkExitTradeMatch(activeTrade, payload.tradeId);
      if (mismatch) {
        console.warn(`[tv-webhook] exit ${payload.grade} rejected (409): ${mismatch} (source=${payload.source || "unknown"})`);
        return res.status(409).json({ ok: false, error: "TRADE_ID_MISMATCH", detail: mismatch });
      }

      const nowIst = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
      const nowIso = new Date().toISOString();
      // Fill level (NIFTY spot): TradingView sends `close`, the Algo sync-back sends `spot`.
      const fillPrice = payload.close || payload.spot || payload.entry || (activeTrade ? (payload.grade === "TARGET_1_HIT" ? activeTrade.target1Price : payload.grade === "TARGET_2_HIT" ? activeTrade.target2Price : activeTrade.entryPrice) : 0);
      const hasTradeId = payload.tradeId !== undefined && payload.tradeId !== null && String(payload.tradeId) !== "";
      const sync = hasTradeId || payload.source
        ? {
            source: payload.source ?? null,
            tradeId: hasTradeId ? String(payload.tradeId) : null,
            spot: payload.spot ?? null,
            optionFill: payload.optionFill ?? null,
            lots: payload.lots ?? null,
            mode: payload.mode ?? null,
            t: payload.t ?? null,
            // e.g. "converted to carry" on the MANUAL_CLOSE the Algo sends when it turns the
            // intraday position into the overnight carry.
            reason: payload.reason ?? null,
          }
        : null;

      // Algo-owned trade: the Algo's ₹ figures are the only P&L; index points are context only.
      const algoOwned = isBridgeOwned(activeTrade) || payload.source === "algo";

      if (payload.grade === "TARGET_1_HIT") {
        const t1AlgoOwned = algoOwned;
        if (activeTrade) {
          if (sync) activeTrade.lastSync = { grade: payload.grade, ...sync };
          // A T1 sync-back for this exact trade proves the Algo holds a filled position: resolve
          // PENDING / ACCEPTED / UNKNOWN to FILLED (otherwise the stuck-ACCEPTED guard would fire).
          if (sync?.tradeId && ENTRY_REPORTABLE_STATUSES.includes(activeTrade.execution?.status)) {
            activeTrade.execution = { ...activeTrade.execution, status: "FILLED", previousStatus: activeTrade.execution.status, mode: sync.mode ?? activeTrade.execution.mode ?? null, resolvedBy: "sync-back", resolvedAt: nowIso };
          }
          activeTrade.hitT1 = true;
          activeTrade.t1HitTime = nowIst;
          activeTrade.t1HitPrice = fillPrice;
          activeTrade.stopLoss = activeTrade.entryPrice; // Cost
          activeTrade.slAtCost = true;
          const isHtf = activeTrade.timeframe === "125" || activeTrade.timeframe === "D" || Number(activeTrade.timeframe) >= 60 || activeTrade.grade?.includes("SYNERGY");
          const activeTtl = isHtf ? 604800 : 28800; // 7 days for 125m/Daily/Synergy, 8 hours for 15m intraday
          if (redis) {
            await redis.set("nifty:tv:active_trade", JSON.stringify(activeTrade), { ex: activeTtl });
          }
        }
        const t1Record = {
          type: "TARGET_1_HIT",
          timestamp: nowIso,
          istTime: nowIst,
          trade: activeTrade || { grade: "BEAR_TRAP_BUY", direction: "LONG", entryPrice: fillPrice },
          exitPrice: fillPrice,
          decision: "T1_SCALED_OUT",
          recommendedLots: 0.4,
          // Algo-owned: the paper 60% scale-out points are not the owner's P&L; record none.
          netPnl: t1AlgoOwned ? null : activeTrade ? Number(((activeTrade.target1Dist || 0) * 0.6).toFixed(2)) : 0,
          pnlBasis: t1AlgoOwned ? "ALGO_INR" : "PAPER_INDEX_POINTS",
          algoOwned: t1AlgoOwned,
          reasoning: t1AlgoOwned
            ? `Target 1 reported by the Algo (stop moved to entry). ₹ result comes with the final exit.`
            : `Target 1 achieved. 60% profit booked, SL moved to Cost (${activeTrade?.entryPrice || fillPrice}).`,
          ...(sync ? { sync } : {}),
        };
        if (redis) {
          await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(t1Record));
        }
        await sendTelegramT1Alert(activeTrade || t1Record.trade, fillPrice);
        await runExitWatchdog();
        return res.status(200).json({ ok: true, event: "TARGET_1_HIT", record: t1Record });
      }

      // Full exit event
      let netPnl = 0;
      if (activeTrade) {
        const isLong = activeTrade.direction === "LONG";
        const entry = Number(activeTrade.entryPrice);
        const exitP = Number(fillPrice);
        const t1Dist = Number(activeTrade.target1Dist || activeTrade.riskPoints || 0);
        const t2Dist = Number(activeTrade.target2Dist || t1Dist * 2);
        if (payload.grade === "TARGET_2_HIT") {
          netPnl = activeTrade.hitT1 ? Number((t1Dist * 0.6 + t2Dist * 0.4 - 4.0).toFixed(2)) : Number((t2Dist - 4.0).toFixed(2));
        } else if (payload.grade === "BREAKEVEN_STOP") {
          netPnl = Number((t1Dist * 0.6 - 4.0).toFixed(2));
        } else if (payload.grade === "STOP_LOSS_HIT") {
          netPnl = Number((-Math.abs(entry - exitP) - 4.0).toFixed(2));
        } else {
          // TIME_STOP_EXIT
          const diff = isLong ? exitP - entry : entry - exitP;
          netPnl = Number(((activeTrade.hitT1 ? t1Dist * 0.6 + diff * 0.4 : diff) - 4.0).toFixed(2));
        }
      }

      const exitTrade = activeTrade || { grade: payload.grade, direction: payload.dir || "LONG", entryPrice: fillPrice };
      const algoPnl = algoOwned ? parseAlgoPnl(payload) : null;
      const move = algoOwned ? indexMovePts(exitTrade.direction, exitTrade.entryPrice, fillPrice) : null;
      const closeNote = payload.reason ? `: ${String(payload.reason).slice(0, 120)}` : "";
      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: payload.grade,
        exitPrice: fillPrice,
        // Paper trades: index points. Algo-owned: null here — the money figure is algoPnl (₹).
        netPnl: algoOwned ? null : netPnl,
        pnlBasis: algoOwned ? "ALGO_INR" : "PAPER_INDEX_POINTS",
        algoOwned,
        algoPnl,
        pnlInr: algoPnl?.reported ? algoPnl.pnlInr : null,
        pnlKnown: algoPnl ? algoPnl.pnlKnown : null,
        indexMovePts: move,
        trade: exitTrade,
        decision: "TRADE_CLOSED_FLAT",
        recommendedLots: 0,
        reasoning: algoOwned
          ? `Trade exited (${payload.grade}${closeNote}) at ${fillPrice}. ${algoPnl?.reported ? `Algo result ${formatInr(algoPnl.pnlInr)}${algoPnl.pnlKnown === false ? " (incomplete: excludes accounts with unknown exit price)" : ""}` : "₹ P&L not reported by the Algo"}. Index move ${move ?? "n/a"} pts (not P&L). Market is now FLAT.`
          : `Trade exited (${payload.grade}${closeNote}) at ${fillPrice}. Paper result: ${netPnl >= 0 ? "+" : ""}${netPnl} index pts. Market is now FLAT.`,
        closeReason: payload.reason ?? null,
        ...(sync ? { sync } : {}),
      };
      await recordLastExit(redis, exitRecord);

      if (redis) {
        await Promise.all([
          // A trade with an id is deleted only if it is still the stored one (never a newer claim).
          activeTrade?.id ? releaseActiveTradeIfOwned(redis, activeTrade.id) : redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      }
      // Scorecard (measurement only): Algo-owned trade exit with the Algo's rupee result.
      if (algoOwned) {
        await scRecord(redis, buildTradeEvent({ kind: "FLOW", tradeId: exitTrade.id, exitGrade: payload.grade, direction: exitTrade.direction, entry: exitTrade.entryPrice, exitPrice: fillPrice, pnlInr: algoPnl?.reported ? algoPnl.pnlInr : null, pnlKnown: algoPnl ? algoPnl.pnlKnown : null, accountsCount: algoPnl?.accounts?.length ?? null, nowMs: Date.now() }));
      }
      await sendTelegramExitAlert(exitRecord);
      await runExitWatchdog();
      return res.status(200).json({ ok: true, event: "TRADE_CLOSED", exitRecord });
    }

    // 2. Fetch Latest Real-Time 22-Strike Option Chain Snapshot from Upstash Redis.
    //    Actionable grades may only be verified against the live `nifty:flow:latest`
    //    snapshot; the 14-day session payload is an informational fallback for other grades.
    const isTrap = payload.grade === "BEAR_TRAP_BUY" || payload.grade === "BULL_TRAP_SELL";
    const isSynergy = payload.grade === "SYNERGY_BULL" || payload.grade === "SYNERGY_BEAR";
    const isActionable = isTrap || isSynergy;
    const deps = getWebhookDeps();
    const maxAgeSec = getFlowMaxAgeSec();
    const isStale = (snap, atMs) => {
      const age = getSnapshotAgeSec(snap, atMs);
      return !snap || age === null || age > maxAgeSec;
    };

    let liveScanner = await readFlowSnapshot(redis, { allowSessionFallback: !isActionable });

    // 2b. Self-refresh: an actionable alert against a missing/stale snapshot triggers ONE bounded
    //     on-demand refresh (live market hours only), then the snapshot is re-read and re-validated.
    let isLiveMarket = null;
    let refreshInfo = null;
    if (isActionable && isStale(liveScanner, deps.now())) {
      try {
        isLiveMarket = await deps.isLiveMarket();
      } catch (e) {
        isLiveMarket = false;
      }
      if (!isLiveMarket) {
        refreshInfo = { attempted: false, ok: false, error: "outside live market hours" };
      } else {
        refreshInfo = await attemptOnDemandRefresh({
          refresh: deps.refresh,
          timeoutMs: getFlowRefreshTimeoutMs(),
          nowMs: deps.now(),
        });
        if (refreshInfo.ok) {
          liveScanner = await readFlowSnapshot(redis);
          if (isStale(liveScanner, deps.now())) {
            refreshInfo.ok = false;
            refreshInfo.stage = "reread";
            refreshInfo.error = liveScanner
              ? "refresh reported success but the re-read snapshot is still not fresh"
              : "refresh reported success but nifty:flow:latest could not be re-read";
          }
        }
      }
    }
    const refreshedNow = Boolean(refreshInfo?.attempted && refreshInfo.ok);

    // 3. Fuse TradingView v4.3 Signal with Live 22-Strike Option Chain
    const nowMs = deps.now();
    const fusedVerdict = fuseChartWithOptionChain(payload, liveScanner, nowMs);

    // 4. Enforce Baseline Paper Trading Policy (Traps & High-Conviction Synergy)
    const snapshotAgeSec = fusedVerdict.liveOptionChainMetrics.snapshotAgeSec;
    const isSnapshotStale = !liveScanner || snapshotAgeSec === null || snapshotAgeSec > maxAgeSec;

    if (isActionable) {
      const sourceLabel = liveScanner ? describeSnapshotSource(liveScanner, refreshedNow) : "none";
      fusedVerdict.liveOptionChainMetrics.snapshotSource = liveScanner?.snapshotSource || null;
      fusedVerdict.snapshotProvenance = liveScanner
        ? `${sourceLabel} · age ${snapshotAgeSec === null ? "unknown" : `${snapshotAgeSec}s`}`
        : "missing";
      if (refreshInfo) {
        fusedVerdict.snapshotRefresh = refreshInfo;
        if (refreshInfo.attempted && !refreshInfo.ok) {
          fusedVerdict.snapshotProvenance += ` · on-demand refresh failed (${refreshInfo.error})`;
        }
      }
    }

    if (isActionable && isSnapshotStale) {
      // Fail closed: never open a position without a fresh, live option-chain snapshot.
      fusedVerdict.decision = "VETO_STALE_OPTION_CHAIN";
      fusedVerdict.recommendedLots = 0;
      fusedVerdict.tier = "VETOED_STALE_DATA";
      fusedVerdict.liveOptionChainMetrics.maxAgeSec = maxAgeSec;
      fusedVerdict.reasoning = !liveScanner
        ? `VETOED: No live option-chain snapshot (nifty:flow:latest) available to verify ${payload.grade}. Snapshot age: unknown (missing). 0 Lots.`
        : snapshotAgeSec === null
        ? `VETOED: Option-chain snapshot has no snapshotAt timestamp, so its freshness cannot be verified for ${payload.grade}. Snapshot age: unknown. 0 Lots.`
        : `VETOED: Option-chain snapshot is stale (age ${snapshotAgeSec}s > max ${maxAgeSec}s); cannot verify ${payload.grade}. 0 Lots.`;
      if (refreshInfo?.attempted) {
        fusedVerdict.reasoning += ` On-demand refresh attempted (${refreshInfo.durationMs}ms) and failed: ${refreshInfo.error}.`;
      } else if (refreshInfo) {
        fusedVerdict.reasoning += ` No on-demand refresh attempted (${refreshInfo.error}).`;
      }
    } else if (!isActionable) {
      // Non-actionable signals (MEGA, SIGNAL, VBO_BREAK, SWING_BOTTOM, etc.) are informational only
      fusedVerdict.decision = "LOG_ONLY";
      fusedVerdict.recommendedLots = 0;
      fusedVerdict.reasoning = `Informational ${payload.grade || "SIGNAL"} alert logged for review. Forward paper trading executes Traps and Verified Synergy.`;
    } else {
      // Check Single-Position Rule for Traps & Synergy. The read below only shapes the BLOCKED
      // message; the actual lock is the atomic SET NX claim further down.
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }
      const blockAsActive = (t) => {
        fusedVerdict.decision = "BLOCKED_BY_ACTIVE_TRADE";
        fusedVerdict.recommendedLots = 0;
        fusedVerdict.reasoning = t
          ? `BLOCKED: Active trade already open (${t.grade} ${t.direction} @ ${t.entryPrice}${t.id ? `, id ${t.id}` : ""}). The tested system strictly enforces one position at a time.`
          : `BLOCKED: Another trade claimed the single-position lock at the same moment. The tested system strictly enforces one position at a time.`;
      };

      if (activeTrade && activeTrade.active) {
        if (isBridgeOwned(activeTrade)) await checkStuckAcceptedTrade(redis, activeTrade, deps);
        blockAsActive(activeTrade);
      } else if (fusedVerdict.decision.startsWith("EXECUTE")) {
        const isHtf = fusedVerdict.timeframe === "125" || fusedVerdict.timeframe === "D" || Number(fusedVerdict.timeframe) >= 60 || fusedVerdict.grade?.includes("SYNERGY");
        const activeTtl = isHtf ? 604800 : 28800; // 7 days for 125m/Daily/Synergy, 8 hours for 15m intraday
        const activeData = {
          active: true,
          grade: fusedVerdict.grade,
          direction: fusedVerdict.direction,
          timeframe: fusedVerdict.timeframe,
          swingTimeframe: fusedVerdict.swingTimeframe,
          entryPrice: fusedVerdict.entryPrice,
          stopLoss: fusedVerdict.stopLoss,
          riskPoints: fusedVerdict.riskPoints,
          target1Price: fusedVerdict.target1Price,
          target2Price: fusedVerdict.target2Price,
          target1Dist: fusedVerdict.target1Dist,
          target2Dist: fusedVerdict.target2Dist,
          timestamp: fusedVerdict.timestamp,
          istTime: fusedVerdict.istTime,
        };
        const bridgeConfig = getFlowBridgeConfig();
        const dispatchPlanned = shouldDispatch(bridgeConfig, fusedVerdict);
        const tradeId = deps.newTradeId(nowMs);
        activeData.id = tradeId;
        if (dispatchPlanned) activeData.execution = { status: "PENDING", at: new Date(nowMs).toISOString() };

        // Atomic single-position claim: exactly one of several concurrent alerts gets "OK".
        let claim = "NO_REDIS";
        if (redis) {
          try {
            const r = await redis.set("nifty:tv:active_trade", JSON.stringify(activeData), { nx: true, ex: activeTtl });
            claim = r === "OK" ? "CLAIMED" : "TAKEN";
          } catch (e) {
            claim = "ERROR";
          }
        }

        if (claim === "TAKEN") {
          let holder = null;
          try {
            holder = parseMaybeJson(await redis.get("nifty:tv:active_trade"));
          } catch (e) {}
          blockAsActive(holder);
        } else {
          fusedVerdict.tradeId = tradeId;
          if (dispatchPlanned) {
            if (claim !== "CLAIMED") {
              // Without a held lock a real order could double up: never dispatch.
              fusedVerdict.execution = {
                status: "NOT_EXECUTED",
                outcome: "NOT_SENT",
                reason: `not dispatched: position lock unavailable (${claim === "NO_REDIS" ? "Redis not configured" : "Redis error"})`,
                mode: null,
                orderRef: null,
                at: new Date(deps.now()).toISOString(),
              };
              try {
                await deps.sendText(`⚠️ *APPROVED BUT NOT EXECUTED* · \`${fusedVerdict.grade}\` · Trade ID \`${tradeId}\`\n• *Reason:* ${fusedVerdict.execution.reason}`);
              } catch (e) {}
            } else {
              fusedVerdict.execution = await runBridgeDispatch({
                redis,
                config: bridgeConfig,
                fused: fusedVerdict,
                activeData,
                activeTtl,
                deps,
                requestStartMs,
              });
            }
          }
        }
      }
    }

    // 5. Persist Fused Signal to Upstash Redis (Daily List + Master Archive)
    const signalKey = `nifty:tv:signals:${istDate}`;
    const archiveKey = "nifty:tv:signals:master_archive";
    if (redis) {
      try {
        await Promise.all([
          redis.lpush(signalKey, JSON.stringify(fusedVerdict)),
          redis.ltrim(signalKey, 0, 99),
          redis.lpush(archiveKey, JSON.stringify(fusedVerdict)),
          redis.ltrim(archiveKey, 0, 999), // Keep up to 1,000 historical signals forever
          redis.set("nifty:tv:latest_signal", JSON.stringify(fusedVerdict), { ex: 86400 }),
        ]);
      } catch (e) {
        await redisRestSet("nifty:tv:latest_signal", fusedVerdict, 86400);
      }
    } else {
      await redisRestSet("nifty:tv:latest_signal", fusedVerdict, 86400);
    }

    // 6. Fire Telegram Notification (with the open overnight carry, if any, for visibility only).
    if (isActionable) {
      const openCarry = await readOpenCarry(redis);
      if (openCarry) fusedVerdict.openCarry = openCarry;
    }
    await sendTelegramAlert(fusedVerdict);

    // Scorecard (measurement only): the signal as received and decided, after every decision above.
    if (isActionable) {
      await scRecord(redis, buildSignalEvent(fusedVerdict, deps.now()));
    }

    // 7. Scanner-blind watchdog (live market hours only; deduped once per outage).
    if (isLiveMarket === null) {
      try {
        isLiveMarket = await deps.isLiveMarket();
      } catch (e) {
        isLiveMarket = false;
      }
    }
    const watchdog = await runWebhookWatchdog({
      redis,
      // Actionable alerts only ever read nifty:flow:latest; for others the snapshot may be the
      // un-stamped session payload, so let the watchdog re-read nifty:flow:latest itself.
      snapshotAt: Number(liveScanner?.snapshotAt) > 0 ? liveScanner.snapshotAt : (isActionable ? null : undefined),
      isLiveMarket,
      lastError: refreshInfo?.attempted && !refreshInfo.ok ? refreshInfo.error : null,
      deps,
    });

    return res.status(200).json({
      ok: true,
      decision: fusedVerdict.decision,
      recommendedLots: fusedVerdict.recommendedLots,
      fusedVerdict,
      watchdog: watchdog.status,
    });
  } catch (err) {
    console.error("[tv-webhook] Error processing TradingView alert:", err);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
}
