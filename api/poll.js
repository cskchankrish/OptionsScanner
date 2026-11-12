/**
 * Authenticated option-chain poller: GET/POST /api/poll
 *
 * Auth (either):
 *   - the webhook secret via authorizeRequest (`x-webhook-secret` header preferred; `key` query works
 *     but puts the secret in URLs/logs, so schedulers should use the header), or
 *   - an Upstash QStash `Upstash-Signature` JWT verified with QSTASH_CURRENT_SIGNING_KEY /
 *     QSTASH_NEXT_SIGNING_KEY (no secret in the URL).
 *
 * Behaviour:
 *   - Outside the live session (getMarketSessionInfo().isLiveMarket: Mon–Fri 09:15–15:40 IST,
 *     Sunday Muhurat 14:00–16:00 IST) → 200 { ok: true, status: "MARKET_CLOSED" }, no NSE call.
 *   - Otherwise always runs the shared refresh core (no 5s memory cache), awaits the Redis
 *     `nifty:flow:latest` write, then:
 *       200 { ok: true, status: "LIVE_POLL_SUCCESS", snapshotAt, ageSec, ticks, ... } and writes the
 *           heartbeat `nifty:poller:last_ok`;
 *       502 { ok: false, status: "NSE_FETCH_FAILED" } when NSE fetch/compute fails;
 *       503 { ok: false, status: "REDIS_WRITE_FAILED" } when the snapshot write fails.
 *   - Every live-session call (success or failure) runs the scanner-blind watchdog.
 *   - Several pollers (VM `x-poll-source: vm`, QStash, GitHub cron): if a live snapshot younger than
 *     POLL_MIN_INTERVAL_SEC (default 20) already exists, return 200 { status: "FRESH_ENOUGH" }
 *     without calling NSE, so three pollers do not triple the NSE load.
 *   - Collector bookkeeping (read by GET /api/collector-status): per-source last success / failure
 *     (`nifty:poller:src_ok:<source>`, `nifty:poller:src_fail:<source>`) and capped lists of the last
 *     100 failures and 100 successes (`nifty:poller:failures`, `nifty:poller:successes`).
 */
import { authorizeRequest } from "../src/webhookAuth.js";
import { verifyQstashSignature, getQstashSigningKeys } from "../src/qstashVerify.js";
import { checkFlowWatchdog } from "../src/flowWatchdog.js";
import {
  refreshLiveSnapshot,
  getMarketSessionInfo,
  redisRestGet,
  redisRestSet,
  redisRestSetNx,
  redisRestCommand,
} from "./nifty-oi.js";
import { sendTelegramText } from "./tv-webhook.js";
import { notePollerSuccess } from "../src/collectorAlerts.js";

export const HEARTBEAT_KEY = "nifty:poller:last_ok";
const HEARTBEAT_TTL_SEC = 7 * 86400;
// Vercel maxDuration is 15s; keep ~3s for heartbeat + watchdog + response.
const POLL_REFRESH_BUDGET_MS = 12000;

export const POLL_SOURCES = ["vm", "qstash", "github-actions", "secret"];
export const POLL_FAILURES_KEY = "nifty:poller:failures";
export const POLL_SUCCESSES_KEY = "nifty:poller:successes";
export const POLL_EVENTS_CAP = 100;
export const sourceOkKey = (src) => `nifty:poller:src_ok:${src}`;
export const sourceFailKey = (src) => `nifty:poller:src_fail:${src}`;
const SOURCE_TTL_SEC = 14 * 86400;

/** Minimum age (s) of the existing live snapshot before a poll calls NSE again. */
export function getPollMinIntervalSec(env = process.env) {
  const v = Number(env.POLL_MIN_INTERVAL_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 20;
}

/** Known sources keep their name; anything else is bucketed as "secret" (authenticated caller). */
export function normalizePollSource(src) {
  return POLL_SOURCES.includes(src) ? src : "secret";
}

function readHeader(headers, name) {
  if (!headers) return undefined;
  const lower = name.toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === lower) {
      const v = headers[k];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

/**
 * Best-effort raw body for the QStash body-hash check. Vercel's Node helpers may already have
 * parsed the body; schedules should send an EMPTY body, which hashes identically either way.
 */
export function getRawBody(req) {
  const b = req?.body;
  if (b === undefined || b === null) return "";
  if (typeof b === "string" || Buffer.isBuffer(b)) return b;
  if (typeof b === "object" && Object.keys(b).length === 0) return "";
  return JSON.stringify(b);
}

function defaultDeps() {
  return {
    now: () => Date.now(),
    getMarketSessionInfo,
    refresh: (opts) => refreshLiveSnapshot(opts),
    getFlowSnapshot: () => redisRestGet("nifty:flow:latest"),
    setHeartbeat: (value) => redisRestSet(HEARTBEAT_KEY, value, HEARTBEAT_TTL_SEC),
    setNx: (k, v, ttl) => redisRestSetNx(k, v, ttl),
    del: async (k) => Number(await redisRestCommand(["DEL", k])) || 0,
    sendText: sendTelegramText,
    qstashKeys: () => getQstashSigningKeys(),
    // Collector bookkeeping (never allowed to fail a poll).
    pushEvent: async (key, value) => {
      await redisRestCommand(["LPUSH", key, JSON.stringify(value)]);
      await redisRestCommand(["LTRIM", key, "0", String(POLL_EVENTS_CAP - 1)]);
    },
    setSourceStatus: (key, value) => redisRestSet(key, value, SOURCE_TTL_SEC),
  };
}

export function createPollHandler(overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };

  const runWatchdog = (snapshotAt, isLiveMarket, lastError) =>
    checkFlowWatchdog({
      snapshotAt,
      isLiveMarket,
      nowMs: deps.now(),
      trigger: "poll",
      lastError,
      deps: { setNx: deps.setNx, del: deps.del, send: deps.sendText },
    });

  return async function pollHandler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method Not Allowed. Use GET or POST." });
    }

    // ── Auth: webhook secret, or a valid QStash signature ──
    let parsedBody = null;
    if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) parsedBody = req.body;
    const secretAuth = authorizeRequest(req, parsedBody);
    let authSource = null;
    if (secretAuth.ok) {
      const declared = String(readHeader(req.headers, "x-poll-source") || "");
      authSource = /^[a-z0-9-]{1,32}$/i.test(declared) ? declared : "secret";
    } else {
      const signature = readHeader(req.headers, "upstash-signature");
      if (signature) {
        const v = verifyQstashSignature({
          signature,
          body: getRawBody(req),
          keys: deps.qstashKeys(),
          nowSec: Math.floor(deps.now() / 1000),
          expectedPath: "/api/poll",
        });
        if (!v.ok) return res.status(401).json({ ok: false, error: `QStash signature rejected: ${v.error}` });
        authSource = "qstash";
      } else {
        return res.status(secretAuth.status).json({ ok: false, error: secretAuth.error });
      }
    }

    const sessionInfo = deps.getMarketSessionInfo();
    if (!sessionInfo.isLiveMarket) {
      return res.status(200).json({
        ok: true,
        status: "MARKET_CLOSED",
        nextOpen: sessionInfo.nextOpenDescription,
        source: authSource,
      });
    }

    const bucket = normalizePollSource(authSource);
    const record = async (ok, rec) => {
      const value = { at: new Date(deps.now()).toISOString(), source: bucket, declaredSource: authSource, ...rec };
      try { await deps.pushEvent?.(ok ? POLL_SUCCESSES_KEY : POLL_FAILURES_KEY, value); } catch (e) { /* bookkeeping only */ }
      try { await deps.setSourceStatus?.(ok ? sourceOkKey(bucket) : sourceFailKey(bucket), value); } catch (e) { /* bookkeeping only */ }
    };

    // Several pollers: skip NSE when a fresh enough live snapshot already exists.
    const started = deps.now();
    const minIntervalSec = getPollMinIntervalSec();
    let existing = null;
    try {
      existing = await deps.getFlowSnapshot();
    } catch (e) {
      existing = null;
    }
    const existingAt = Number(existing?.snapshotAt);
    const existingAgeSec = Number.isFinite(existingAt) && existingAt > 0 ? (started - existingAt) / 1000 : null;
    if (minIntervalSec > 0 && existingAgeSec !== null && existingAgeSec >= 0 && existingAgeSec < minIntervalSec) {
      const nowIso = new Date(deps.now()).toISOString();
      try { await deps.setHeartbeat({ at: nowIso, snapshotAt: new Date(existingAt).toISOString(), source: authSource, status: "FRESH_ENOUGH" }); } catch (e) { /* ignore */ }
      await record(true, { status: "FRESH_ENOUGH", httpStatus: 200, durationMs: deps.now() - started, ageSec: Math.round(existingAgeSec) });
      await notePollerSuccess({ source: authSource, deps: { del: deps.del, send: deps.sendText } });
      const watchdog = await runWatchdog(existingAt, true, null);
      return res.status(200).json({
        ok: true,
        status: "FRESH_ENOUGH",
        ageSec: Math.round(existingAgeSec),
        minIntervalSec,
        snapshotAt: new Date(existingAt).toISOString(),
        snapshotSource: existing?.snapshotSource ?? null,
        source: authSource,
        dataQuality: existing?.dataQuality ?? null,
        watchdog: watchdog.status,
      });
    }

    let result;
    try {
      result = await deps.refresh({
        now: started,
        sessionInfo,
        queryExpiry: "near",
        awaitPersist: true,
        source: "poller",
        deadlineMs: started + POLL_REFRESH_BUDGET_MS,
      });
    } catch (e) {
      result = { ok: false, stage: "nse", error: e?.message || String(e) };
    }

    if (!result?.ok) {
      const isRedis = result?.stage === "redis";
      let lastSnapshotAt = null;
      try {
        lastSnapshotAt = (await deps.getFlowSnapshot())?.snapshotAt ?? null;
      } catch (e) {
        lastSnapshotAt = null;
      }
      const watchdog = await runWatchdog(lastSnapshotAt, true, result?.error || "refresh failed");
      await record(false, {
        status: isRedis ? "REDIS_WRITE_FAILED" : "NSE_FETCH_FAILED",
        httpStatus: isRedis ? 503 : 502,
        stage: result?.stage || "nse",
        error: String(result?.error || "refresh failed").slice(0, 300),
        durationMs: deps.now() - started,
      });
      return res.status(isRedis ? 503 : 502).json({
        ok: false,
        status: isRedis ? "REDIS_WRITE_FAILED" : "NSE_FETCH_FAILED",
        error: result?.error || "refresh failed",
        lastSnapshotAt: lastSnapshotAt ? new Date(lastSnapshotAt).toISOString() : null,
        source: authSource,
        watchdog: watchdog.status,
      });
    }

    const snapshotAt = result.snapshotAt;
    const nowIso = new Date(deps.now()).toISOString();
    let heartbeat = false;
    try {
      heartbeat = Boolean(
        await deps.setHeartbeat({ at: nowIso, snapshotAt: new Date(snapshotAt).toISOString(), source: authSource })
      );
    } catch (e) {
      heartbeat = false;
    }
    const watchdog = await runWatchdog(snapshotAt, true, null);
    await record(true, { status: "LIVE_POLL_SUCCESS", httpStatus: 200, durationMs: deps.now() - started, ticks: result.ticks ?? null });
    await notePollerSuccess({ source: authSource, deps: { del: deps.del, send: deps.sendText } });

    return res.status(200).json({
      ok: true,
      status: "LIVE_POLL_SUCCESS",
      snapshotAt: new Date(snapshotAt).toISOString(),
      ageSec: Math.max(0, Math.round((deps.now() - snapshotAt) / 1000)),
      ticks: result.ticks ?? null,
      spot: result.payload?.spotPrice ?? null,
      expiry: result.targetExpiry ?? null,
      durationMs: deps.now() - started,
      heartbeat,
      source: authSource,
      watchdog: watchdog.status,
      dataQuality: result.payload?.dataQuality ?? null,
    });
  };
}

export default createPollHandler();
