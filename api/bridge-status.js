/**
 * Bridge status readout: GET /api/bridge-status
 *
 * Lets the owner verify the Vercel-side bridge settings and the Algo link without waiting for a
 * live signal. Read-only: it never dispatches a FLOW_ENTRY, never touches nifty:tv:active_trade
 * and never sends Telegram.
 *
 *   1. Config check (values are never returned or logged).
 *   2. One signed FLOW_PING to <origin of FLOW_BRIDGE_URL>/flow-ping, bounded at 4s.
 *
 * At most one real ping per 60s (atomic Redis SET NX; in-memory fallback without Redis). Inside
 * the window the last result is served with `cached: true`. An authenticated caller (webhook
 * secret via authorizeRequest) gets the detail and may pass `fresh=1` to bypass the cache.
 *
 * States: OFF, MISCONFIGURED, UNREACHABLE, ALGO_OUTDATED, SIGNATURE_REJECTED, ALGO_REJECTED,
 *         ALGO_BRIDGE_OFF, OK.
 */
import { authorizeRequest, extractRequestSecret } from "../src/webhookAuth.js";
import { inspectFlowBridgeConfig, pingAlgo, PING_TIMEOUT_MS } from "../src/flowBridge.js";
import { getCarryConfig, describeCarryConfig, summarizeCarry, isCarryOpen, CARRY_ACTIVE_KEY } from "../src/carryBridge.js";

export const STATUS_LOCK_KEY = "nifty:bridge:status:lock";
export const STATUS_CACHE_KEY = "nifty:bridge:status:last";
export const PING_WINDOW_SEC = 60;
const CACHE_TTL_SEC = 3600;

// In-memory fallback guard (per warm instance) when Redis is unavailable.
const memory = { lastPingAt: 0, last: null };
/** Test hook. */
export function resetBridgeStatusMemoryForTesting() {
  memory.lastPingAt = 0;
  memory.last = null;
}

async function defaultDeps() {
  const { redisRestGet, redisRestSet, redisRestSetNx } = await import("./nifty-oi.js");
  return {
    now: () => Date.now(),
    env: () => process.env,
    fetchImpl: (...a) => globalThis.fetch(...a),
    // setNx throws when Redis is not configured / unreachable => in-memory fallback.
    setNx: (k, v, ttl) => redisRestSetNx(k, v, ttl),
    get: (k) => redisRestGet(k),
    set: (k, v, ttl) => redisRestSet(k, v, ttl),
    getCarry: () => redisRestGet(CARRY_ACTIVE_KEY),
  };
}

/** Removes the bridge secret and full URL from any string before it can leave the function. */
function scrub(value, env) {
  const secrets = [env.FLOW_BRIDGE_SECRET, env.FLOW_BRIDGE_URL, env.TV_WEBHOOK_SECRET]
    .filter((s) => typeof s === "string" && s.length >= 4);
  const walk = (v) => {
    if (typeof v === "string") {
      let s = v;
      for (const sec of secrets) s = s.split(sec).join("[redacted]");
      return s;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value);
}

export function createBridgeStatusHandler(overrides = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method Not Allowed. Use GET." });

    const deps = { ...(await defaultDeps()), ...overrides };
    const env = deps.env();

    // A presented-but-wrong credential is an error (helps spot typos); none at all = public view.
    const presented = extractRequestSecret(req) !== null;
    const auth = presented ? authorizeRequest(req) : { ok: false };
    if (presented && !auth.ok) return res.status(auth.status).json({ ok: false, error: auth.error });
    const authed = auth.ok === true;
    const fresh = authed && String(req.query?.fresh ?? "") === "1";

    const cfg = inspectFlowBridgeConfig(env);
    const configDetail = {
      enabledFlag: cfg.enabledFlag,
      urlPresent: cfg.urlPresent,
      urlValid: cfg.urlValid,
      secretPresent: cfg.secretPresent,
      problems: cfg.problems,
      target: cfg.target, // scheme + host only
      decisions: cfg.decisions,
      dispatchTimeoutMs: cfg.dispatchTimeoutMs,
      fillWaitSec: cfg.fillWaitSec,
    };

    const carryCfg = getCarryConfig(env);
    let openCarry = null;
    if (authed) {
      try {
        const t = await deps.getCarry();
        openCarry = isCarryOpen(t) ? summarizeCarry(t) : null;
      } catch (e) {
        openCarry = null;
      }
    }

    const respond = (result, cached) => {
      const body = { ok: result.state === "OK", state: result.state, checkedAt: result.checkedAt, cached, carryEnabled: carryCfg.enabled };
      if (authed) {
        body.detail = {
          config: configDetail,
          ping: result.ping || null,
          algo: result.algo || null,
          reason: result.reason ?? null,
          guard: result.guard || null,
          carry: { settings: describeCarryConfig(carryCfg), openCarry },
        };
      }
      return res.status(200).json(scrub(body, env));
    };

    // Config-only states need no ping (and no rate guard).
    if (!cfg.enabledFlag) return respond({ state: "OFF", checkedAt: new Date(deps.now()).toISOString() }, false);
    if (cfg.problems.length) return respond({ state: "MISCONFIGURED", checkedAt: new Date(deps.now()).toISOString() }, false);

    // Rate guard: one real ping per PING_WINDOW_SEC.
    let guard = "redis";
    let mayPing = fresh;
    if (!fresh) {
      try {
        mayPing = await deps.setNx(STATUS_LOCK_KEY, String(deps.now()), PING_WINDOW_SEC);
      } catch (e) {
        guard = "memory";
        mayPing = deps.now() - memory.lastPingAt >= PING_WINDOW_SEC * 1000;
      }
    }
    if (!mayPing) {
      let cachedResult = null;
      if (guard === "redis") {
        try { cachedResult = await deps.get(STATUS_CACHE_KEY); } catch (e) { cachedResult = null; }
        if (typeof cachedResult === "string") { try { cachedResult = JSON.parse(cachedResult); } catch (e) { cachedResult = null; } }
      } else {
        cachedResult = memory.last;
      }
      if (cachedResult?.state) return respond(cachedResult, true);
      // A ping is in flight (or its result was lost): do not start another one.
      return res.status(429).json({ ok: false, state: null, checkedAt: new Date(deps.now()).toISOString(), cached: false, error: "status check already running; retry in a minute" });
    }

    const p = await pingAlgo({
      pingUrl: cfg.pingUrl,
      secret: env.FLOW_BRIDGE_SECRET,
      fetchImpl: deps.fetchImpl,
      nowMs: deps.now(),
      timeoutMs: PING_TIMEOUT_MS,
    });
    const result = scrub({
      state: p.state,
      checkedAt: new Date(deps.now()).toISOString(),
      ping: { httpStatus: p.httpStatus, latencyMs: p.latencyMs, error: p.error },
      algo: p.algo,
      reason: p.reason,
      guard: fresh ? "bypassed (fresh=1)" : guard,
    }, env);

    memory.lastPingAt = deps.now();
    memory.last = result;
    try {
      await deps.set(STATUS_CACHE_KEY, JSON.stringify(result), CACHE_TTL_SEC);
      // fresh=1 restarts the window so a forced check is not followed by another public ping.
      if (fresh) await deps.set(STATUS_LOCK_KEY, String(deps.now()), PING_WINDOW_SEC);
    } catch (e) {
      // memory fallback already holds it
    }
    return respond(result, false);
  };
}

export default createBridgeStatusHandler();
