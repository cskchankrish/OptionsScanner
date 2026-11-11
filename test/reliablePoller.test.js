/**
 * Reliable poller (phase 1): webhook self-refresh, authenticated /api/poll with QStash
 * signatures, and the scanner-blind watchdog. All I/O is injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_BLIND_ALERT_SEC",
  "FLOW_REFRESH_TIMEOUT_MS", "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");
const { createPollHandler, HEARTBEAT_KEY } = await import("../api/poll.js");
const { checkFlowWatchdog, BLIND_KEY, getSessionOpenMs } = await import("../src/flowWatchdog.js");
const { verifyQstashSignature, signQstashForTesting } = await import("../src/qstashVerify.js");

const SECRET = "poller-test-secret";
const QKEY = "sig_current_test_key";
const QKEY_NEXT = "sig_next_test_key";
const POLL_URL = "https://niftyninjaa.vercel.app/api/poll";
// Wednesday 11-Nov-2026 11:00 IST (05:30 UTC): live session, well past the open grace window.
const T_LIVE = Date.UTC(2026, 10, 11, 5, 30, 0);

function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const lists = {};
  return {
    store,
    lists,
    async get(k) { return store[k] ?? null; },
    async set(k, v, opts = {}) {
      if (opts.nx && k in store) return null;
      store[k] = v;
      return "OK";
    },
    async del(k) { if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
}

function mockReqRes({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  const req = { method, body: typeof body === "string" ? body : JSON.stringify(body), query, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { this.body = d; return this; },
    send(d) { this.body = d; return this; },
    end() { return this; },
  };
  return { req, res };
}

const synergyBearAlert = (extra = {}) => ({
  secret: SECRET,
  sym: "NSE:NIFTY",
  tf: "15",
  dir: "SHORT",
  grade: "SYNERGY_BEAR",
  close: 24960,
  sl: 25025,
  cappedSl: 25025,
  rDist: 65,
  t1Dist: 65,
  t2Dist: 130,
  futQuad: "SHORT_BUILDUP",
  ...extra,
});

const bearSnapshot = (snapshotAt, overrides = {}) => ({
  snapshotAt,
  snapshotSource: "poller",
  corridor: { deltaPCR: 0.6, floorStrike: 24700, roofStrike: 25200 },
  futures: { quadrant: "SHORT_BUILDUP" },
  smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" },
  ...overrides,
});

/** Runs a webhook test with secret + fake Redis + injected deps, always cleaning up. */
function webhookCase({ initial = {}, live = true, refresh, env = {} }, fn) {
  return async () => {
    const prev = { TV_WEBHOOK_SECRET: process.env.TV_WEBHOOK_SECRET };
    process.env.TV_WEBHOOK_SECRET = SECRET;
    for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = createFakeRedis(initial);
    const sent = [];
    const refreshCalls = [];
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => live,
      refresh: async (opts) => {
        refreshCalls.push(opts);
        return refresh ? refresh(redis, opts) : { ok: false, stage: "nse", error: "no refresh configured" };
      },
      sendText: async (t) => { sent.push(t); return true; },
    });
    try {
      await fn({ redis, sent, refreshCalls });
    } finally {
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

async function postAlert(alert = synergyBearAlert()) {
  const { req, res } = mockReqRes({ body: alert });
  await webhook.default(req, res);
  return res;
}

// ── Webhook self-refresh ──

test("webhook: stale snapshot -> on-demand refresh succeeds -> signal validated, not vetoed", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  refresh: async (redis) => {
    redis.store["nifty:flow:latest"] = JSON.stringify(bearSnapshot(Date.now() - 1000, { snapshotSource: "webhook-refresh" }));
    return { ok: true, persisted: true };
  },
}, async ({ refreshCalls }) => {
  const res = await postAlert();
  assert.equal(res.statusCode, 200);
  assert.equal(refreshCalls.length, 1, "exactly one refresh");
  assert.ok(Number.isFinite(refreshCalls[0].deadlineMs), "refresh receives a deadline");
  assert.notEqual(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  const v = res.body.fusedVerdict;
  assert.equal(v.snapshotRefresh.attempted, true);
  assert.equal(v.snapshotRefresh.ok, true);
  assert.match(v.snapshotProvenance, /^on-demand refresh \(this alert\) · age \d+s$/);
}));

test("webhook: stale snapshot -> refresh fails -> VETO_STALE_OPTION_CHAIN with refresh-attempted text", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  refresh: async () => ({ ok: false, stage: "nse", error: "v3 option chain failed: status 403" }),
}, async ({ redis, refreshCalls }) => {
  const res = await postAlert();
  assert.equal(res.statusCode, 200);
  assert.equal(refreshCalls.length, 1);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.equal(res.body.recommendedLots, 0);
  const r = res.body.fusedVerdict.reasoning;
  assert.match(r, /stale \(age 165\d+s > max 900s\)/);
  assert.match(r, /On-demand refresh attempted \(\d+ms\) and failed: v3 option chain failed: status 403\./);
  assert.match(res.body.fusedVerdict.snapshotProvenance, /^poller · age 165\ds · on-demand refresh failed/);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined, "no trade opened");
}));

test("webhook: stale snapshot -> refresh times out -> veto mentions the timeout", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  env: { FLOW_REFRESH_TIMEOUT_MS: "1000" },
  refresh: () => new Promise(() => {}), // never settles
}, async ({ refreshCalls }) => {
  const started = Date.now();
  const res = await postAlert();
  const took = Date.now() - started;
  assert.equal(refreshCalls.length, 1);
  assert.ok(took >= 950 && took < 4000, `bounded by the timeout (took ${took}ms)`);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.match(res.body.fusedVerdict.reasoning, /On-demand refresh attempted \(\d+ms\) and failed: refresh timed out after 1000ms\./);
}));

test("webhook: missing snapshot -> refresh throws -> veto (fail closed)", webhookCase({
  refresh: async () => { throw new Error("boom"); },
}, async ({ refreshCalls }) => {
  const res = await postAlert();
  assert.equal(refreshCalls.length, 1);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.match(res.body.fusedVerdict.reasoning, /missing\)\. 0 Lots\. On-demand refresh attempted .* failed: boom\./);
}));

test("webhook: refresh reports ok but re-read is still stale -> veto says so", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  refresh: async () => ({ ok: true }),
}, async () => {
  const res = await postAlert();
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.match(res.body.fusedVerdict.reasoning, /re-read snapshot is still not fresh/);
}));

test("webhook: fresh snapshot -> no refresh call, provenance recorded", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 42_000)) },
}, async ({ refreshCalls }) => {
  const res = await postAlert();
  assert.equal(refreshCalls.length, 0);
  assert.notEqual(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.match(res.body.fusedVerdict.snapshotProvenance, /^poller · age 4\ds$/);
  assert.equal(res.body.fusedVerdict.snapshotRefresh, undefined);
}));

test("webhook: outside live market hours -> no refresh attempted, veto says why", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  live: false,
  refresh: async () => ({ ok: true }),
}, async ({ refreshCalls, sent }) => {
  const res = await postAlert();
  assert.equal(refreshCalls.length, 0);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.match(res.body.fusedVerdict.reasoning, /No on-demand refresh attempted \(outside live market hours\)\./);
  assert.equal(sent.length, 0, "watchdog is silent outside the session");
}));

test("webhook: non-actionable alert never triggers a refresh", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  refresh: async () => ({ ok: true }),
}, async ({ refreshCalls }) => {
  const res = await postAlert(synergyBearAlert({ grade: "MEGA" }));
  assert.equal(res.body.decision, "LOG_ONLY");
  assert.equal(refreshCalls.length, 0);
}));

test("webhook: failed refresh during live hours fires the scanner-blind watchdog once", webhookCase({
  initial: { "nifty:flow:latest": JSON.stringify(bearSnapshot(Date.now() - 1651_000)) },
  refresh: async () => ({ ok: false, stage: "nse", error: "NSE 503" }),
}, async ({ redis, sent }) => {
  // Watchdog grace at session open would hide this outside 09:18–15:40 IST; only assert when it applies.
  const sinceOpenSec = (Date.now() - getSessionOpenMs(Date.now())) / 1000;
  const res1 = await postAlert();
  const res2 = await postAlert();
  if (sinceOpenSec > 180) {
    assert.equal(res1.body.watchdog, "BLIND_ALERTED");
    assert.equal(res2.body.watchdog, "BLIND_ALREADY_ALERTED");
    assert.equal(sent.length, 1);
    assert.match(sent[0], /SCANNER BLIND/);
    assert.match(sent[0], /NSE 503/);
    assert.ok(redis.store[BLIND_KEY]);
  } else {
    assert.equal(sent.length, 0);
  }
}));

// ── Watchdog unit tests ──

function watchdogDeps() {
  const store = {};
  const sent = [];
  return {
    store,
    sent,
    deps: {
      setNx: async (k, v) => { if (k in store) return false; store[k] = v; return true; },
      del: async (k) => { if (k in store) { delete store[k]; return 1; } return 0; },
      send: async (t) => { sent.push(t); return true; },
    },
  };
}

test("watchdog: fires once per outage and sends recovery once", async () => {
  const { store, sent, deps } = watchdogDeps();
  const staleAt = T_LIVE - 600_000;
  const r1 = await checkFlowWatchdog({ snapshotAt: staleAt, isLiveMarket: true, nowMs: T_LIVE, deps });
  const r2 = await checkFlowWatchdog({ snapshotAt: staleAt, isLiveMarket: true, nowMs: T_LIVE + 60_000, deps });
  const r3 = await checkFlowWatchdog({ snapshotAt: null, isLiveMarket: true, nowMs: T_LIVE + 120_000, deps });
  assert.deepEqual([r1.status, r2.status, r3.status], ["BLIND_ALERTED", "BLIND_ALREADY_ALERTED", "BLIND_ALREADY_ALERTED"]);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /SCANNER BLIND/);
  assert.ok(store[BLIND_KEY]);

  const fresh = T_LIVE + 170_000;
  const r4 = await checkFlowWatchdog({ snapshotAt: fresh, isLiveMarket: true, nowMs: fresh + 5_000, deps });
  const r5 = await checkFlowWatchdog({ snapshotAt: fresh, isLiveMarket: true, nowMs: fresh + 65_000, deps });
  assert.deepEqual([r4.status, r5.status], ["RECOVERED", "FRESH"]);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /SCANNER RECOVERED/);
  assert.equal(store[BLIND_KEY], undefined);

  // A second outage alerts again.
  const r6 = await checkFlowWatchdog({ snapshotAt: fresh, isLiveMarket: true, nowMs: fresh + 400_000, deps });
  assert.equal(r6.status, "BLIND_ALERTED");
  assert.equal(sent.length, 3);
});

test("watchdog: threshold honours FLOW_BLIND_ALERT_SEC (default 180)", async () => {
  const { sent, deps } = watchdogDeps();
  assert.equal((await checkFlowWatchdog({ snapshotAt: T_LIVE - 170_000, isLiveMarket: true, nowMs: T_LIVE, deps })).status, "FRESH");
  process.env.FLOW_BLIND_ALERT_SEC = "120";
  try {
    assert.equal((await checkFlowWatchdog({ snapshotAt: T_LIVE - 170_000, isLiveMarket: true, nowMs: T_LIVE, deps })).status, "BLIND_ALERTED");
  } finally {
    delete process.env.FLOW_BLIND_ALERT_SEC;
  }
  assert.equal(sent.length, 1);
});

test("watchdog: silent outside the session and during the session-open grace window", async () => {
  const { sent, deps } = watchdogDeps();
  const r1 = await checkFlowWatchdog({ snapshotAt: T_LIVE - 86_400_000, isLiveMarket: false, nowMs: T_LIVE, deps });
  assert.equal(r1.status, "OUTSIDE_SESSION");
  // 09:16 IST with yesterday's snapshot: only 60s since open < 180s threshold.
  const t0916 = Date.UTC(2026, 10, 11, 3, 46, 0);
  const r2 = await checkFlowWatchdog({ snapshotAt: t0916 - 86_400_000, isLiveMarket: true, nowMs: t0916, deps });
  assert.equal(r2.status, "SESSION_OPEN_GRACE");
  // 09:19 IST, still nothing fresh: now it alerts.
  const r3 = await checkFlowWatchdog({ snapshotAt: t0916 - 86_400_000, isLiveMarket: true, nowMs: t0916 + 180_000, deps });
  assert.equal(r3.status, "BLIND_ALERTED");
  assert.equal(sent.length, 1);
});

test("watchdog: a failed send releases the claim so a later check can retry; claim errors stay quiet", async () => {
  const { store, sent, deps } = watchdogDeps();
  let fail = true;
  const flaky = { ...deps, send: async (t) => { if (fail) return false; sent.push(t); return true; } };
  const r1 = await checkFlowWatchdog({ snapshotAt: null, isLiveMarket: true, nowMs: T_LIVE, deps: flaky });
  assert.equal(r1.status, "BLIND_SEND_FAILED_RELEASED");
  assert.equal(store[BLIND_KEY], undefined);
  fail = false;
  const r2 = await checkFlowWatchdog({ snapshotAt: null, isLiveMarket: true, nowMs: T_LIVE + 60_000, deps: flaky });
  assert.equal(r2.status, "BLIND_ALERTED");
  assert.equal(sent.length, 1);

  const broken = { ...deps, setNx: async () => { throw new Error("redis down"); } };
  const r3 = await checkFlowWatchdog({ snapshotAt: null, isLiveMarket: true, nowMs: T_LIVE, deps: broken });
  assert.equal(r3.status, "CLAIM_ERROR");
  assert.equal(sent.length, 1);
});

test("getSessionOpenMs: weekday 09:15 IST, Sunday 14:00 IST", () => {
  assert.equal(getSessionOpenMs(T_LIVE), Date.UTC(2026, 10, 11, 3, 45, 0));
  const sunday = Date.UTC(2026, 10, 8, 9, 0, 0); // Sun 8-Nov-2026 14:30 IST
  assert.equal(getSessionOpenMs(sunday), Date.UTC(2026, 10, 8, 8, 30, 0));
});

// ── QStash signature ──

test("qstash: verifies signatures from current or next key; rejects tampering", () => {
  const nowSec = Math.floor(T_LIVE / 1000);
  const keys = [QKEY, QKEY_NEXT];
  const sig = signQstashForTesting({ key: QKEY, url: POLL_URL, nowSec });
  assert.equal(verifyQstashSignature({ signature: sig, body: "", keys, nowSec, expectedPath: "/api/poll" }).ok, true);
  const sigNext = signQstashForTesting({ key: QKEY_NEXT, url: POLL_URL, nowSec });
  assert.equal(verifyQstashSignature({ signature: sigNext, body: "", keys, nowSec, expectedPath: "/api/poll" }).ok, true);

  const wrongKey = signQstashForTesting({ key: "other", url: POLL_URL, nowSec });
  assert.equal(verifyQstashSignature({ signature: wrongKey, body: "", keys, nowSec }).error, "invalid signature");
  assert.equal(verifyQstashSignature({ signature: sig, body: "tampered", keys, nowSec }).error, "body hash mismatch");
  assert.equal(verifyQstashSignature({ signature: sig, body: "", keys, nowSec: nowSec + 3600 }).error, "signature expired");
  const otherDest = signQstashForTesting({ key: QKEY, url: "https://niftyninjaa.vercel.app/api/tv-webhook", nowSec });
  assert.equal(verifyQstashSignature({ signature: otherDest, body: "", keys, nowSec, expectedPath: "/api/poll" }).error, "signature destination mismatch");
  const badIss = signQstashForTesting({ key: QKEY, url: POLL_URL, nowSec, iss: "Someone" });
  assert.equal(verifyQstashSignature({ signature: badIss, body: "", keys, nowSec }).error, "invalid issuer");
  assert.equal(verifyQstashSignature({ signature: "a.b", body: "", keys, nowSec }).error, "malformed signature");
  assert.equal(verifyQstashSignature({ signature: sig, body: "", keys: [], nowSec }).ok, false);
});

// ── /api/poll ──

function pollCase(overrides = {}, fn) {
  return async () => {
    const prev = process.env.TV_WEBHOOK_SECRET;
    process.env.TV_WEBHOOK_SECRET = SECRET;
    const state = {
      refreshCalls: [],
      heartbeats: [],
      sent: [],
      blindStore: {},
      flowSnapshot: { snapshotAt: T_LIVE - 1_200_000 },
    };
    const deps = {
      now: () => T_LIVE,
      getMarketSessionInfo: () => ({ isLiveMarket: true, nextOpenDescription: "Next Trading Day 09:15 IST" }),
      refresh: async (opts) => {
        state.refreshCalls.push(opts);
        return { ok: true, persisted: true, snapshotAt: opts.now, ticks: 37, payload: { spotPrice: 25012.4 }, targetExpiry: "17-Nov-2026" };
      },
      getFlowSnapshot: async () => state.flowSnapshot,
      setHeartbeat: async (v) => { state.heartbeats.push(v); return true; },
      setNx: async (k, v) => { if (k in state.blindStore) return false; state.blindStore[k] = v; return true; },
      del: async (k) => { if (k in state.blindStore) { delete state.blindStore[k]; return 1; } return 0; },
      sendText: async (t) => { state.sent.push(t); return true; },
      qstashKeys: () => [QKEY, QKEY_NEXT],
      ...overrides,
    };
    try {
      await fn(createPollHandler(deps), state);
    } finally {
      if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET;
      else process.env.TV_WEBHOOK_SECRET = prev;
    }
  };
}

async function callPoll(handler, { method = "POST", headers = {}, body, query = {} } = {}) {
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { this.body = d; return this; },
  };
  await handler({ method, headers, body, query }, res);
  return res;
}

test("poll: 401 without secret or signature, 401 with wrong secret; nothing refreshed", pollCase({}, async (handler, state) => {
  assert.equal((await callPoll(handler)).statusCode, 401);
  assert.equal((await callPoll(handler, { headers: { "x-webhook-secret": "nope" } })).statusCode, 401);
  assert.equal(state.refreshCalls.length, 0);
}));

test("poll: 503 when TV_WEBHOOK_SECRET is unconfigured and no signature is sent", pollCase({}, async (handler) => {
  delete process.env.TV_WEBHOOK_SECRET;
  const res = await callPoll(handler, { headers: { "x-webhook-secret": "x" } });
  assert.equal(res.statusCode, 503);
}));

test("poll: valid QStash signature (empty body) is accepted without the secret", pollCase({}, async (handler, state) => {
  const sig = signQstashForTesting({ key: QKEY, url: POLL_URL, nowSec: Math.floor(T_LIVE / 1000) });
  const res = await callPoll(handler, { headers: { "Upstash-Signature": sig }, body: undefined });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.source, "qstash");
  assert.equal(state.refreshCalls.length, 1);
  assert.equal(state.heartbeats[0].source, "qstash");
}));

test("poll: invalid QStash signature is rejected with 401", pollCase({}, async (handler, state) => {
  const sig = signQstashForTesting({ key: "attacker-key", url: POLL_URL, nowSec: Math.floor(T_LIVE / 1000) });
  const res = await callPoll(handler, { headers: { "upstash-signature": sig } });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /QStash signature rejected: invalid signature/);
  const expired = signQstashForTesting({ key: QKEY, url: POLL_URL, nowSec: Math.floor(T_LIVE / 1000) - 3600 });
  assert.equal((await callPoll(handler, { headers: { "upstash-signature": expired } })).statusCode, 401);
  assert.equal(state.refreshCalls.length, 0);
}));

test("poll: success -> 200 with snapshot fields, awaited persist requested, heartbeat written", pollCase({}, async (handler, state) => {
  const res = await callPoll(handler, { method: "GET", headers: { "x-webhook-secret": SECRET, "x-poll-source": "github-actions" } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, "LIVE_POLL_SUCCESS");
  assert.equal(res.body.snapshotAt, new Date(T_LIVE).toISOString());
  assert.equal(res.body.ageSec, 0);
  assert.equal(res.body.ticks, 37);
  assert.equal(res.body.source, "github-actions");

  const opts = state.refreshCalls[0];
  assert.equal(opts.awaitPersist, true, "Redis write must be awaited");
  assert.equal(opts.source, "poller");
  assert.equal(opts.queryExpiry, "near");
  assert.ok(opts.deadlineMs > T_LIVE && opts.deadlineMs <= T_LIVE + 13_000);

  assert.equal(state.heartbeats.length, 1);
  assert.equal(state.heartbeats[0].at, new Date(T_LIVE).toISOString());
  assert.equal(state.heartbeats[0].source, "github-actions");
  assert.equal(HEARTBEAT_KEY, "nifty:poller:last_ok");
}));

test("poll: NSE failure -> 502 (never 200), no heartbeat, watchdog alerts", pollCase({
  refresh: async () => ({ ok: false, stage: "nse", error: "v3 option chain failed: status 401" }),
}, async (handler, state) => {
  const res = await callPoll(handler, { headers: { "x-webhook-secret": SECRET } });
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.status, "NSE_FETCH_FAILED");
  assert.match(res.body.error, /status 401/);
  assert.equal(state.heartbeats.length, 0);
  assert.equal(res.body.watchdog, "BLIND_ALERTED");
  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0], /status 401/);
}));

test("poll: Redis write failure -> 503 (never 200), no heartbeat", pollCase({
  refresh: async () => ({ ok: false, stage: "redis", error: "Redis write of nifty:flow:latest failed: HTTP 500" }),
}, async (handler, state) => {
  state.flowSnapshot = { snapshotAt: T_LIVE - 60_000 };
  const res = await callPoll(handler, { headers: { "x-webhook-secret": SECRET } });
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, "REDIS_WRITE_FAILED");
  assert.equal(state.heartbeats.length, 0);
  assert.equal(res.body.watchdog, "FRESH", "last good snapshot is only 60s old");
}));

test("poll: refresh that throws is a 502, not a crash", pollCase({
  refresh: async () => { throw new Error("socket hang up"); },
}, async (handler) => {
  const res = await callPoll(handler, { headers: { "x-webhook-secret": SECRET } });
  assert.equal(res.statusCode, 502);
  assert.match(res.body.error, /socket hang up/);
}));

test("poll: outside the session -> 200 MARKET_CLOSED without refreshing or alerting", pollCase({
  getMarketSessionInfo: () => ({ isLiveMarket: false, nextOpenDescription: "Next Trading Day 09:15 IST" }),
}, async (handler, state) => {
  const res = await callPoll(handler, { headers: { "x-webhook-secret": SECRET } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "MARKET_CLOSED");
  assert.equal(state.refreshCalls.length, 0);
  assert.equal(state.sent.length, 0);
}));

test("poll: outage then recovery sends exactly one blind and one recovered alert", pollCase({}, async (handler, state) => {
  let failing = true;
  const h = createPollHandler({
    now: () => T_LIVE,
    getMarketSessionInfo: () => ({ isLiveMarket: true }),
    refresh: async (opts) => (failing ? { ok: false, stage: "nse", error: "down" } : { ok: true, snapshotAt: opts.now, ticks: 1, payload: {} }),
    getFlowSnapshot: async () => state.flowSnapshot,
    setHeartbeat: async () => true,
    setNx: async (k, v) => { if (k in state.blindStore) return false; state.blindStore[k] = v; return true; },
    del: async (k) => { if (k in state.blindStore) { delete state.blindStore[k]; return 1; } return 0; },
    sendText: async (t) => { state.sent.push(t); return true; },
    qstashKeys: () => [],
  });
  const auth = { headers: { "x-webhook-secret": SECRET } };
  assert.equal((await callPoll(h, auth)).statusCode, 502);
  assert.equal((await callPoll(h, auth)).statusCode, 502);
  failing = false;
  assert.equal((await callPoll(h, auth)).body.watchdog, "RECOVERED");
  assert.equal((await callPoll(h, auth)).body.watchdog, "FRESH");
  assert.equal(state.sent.length, 2);
  assert.match(state.sent[0], /SCANNER BLIND/);
  assert.match(state.sent[1], /SCANNER RECOVERED/);
}));

test("poll: rejects other HTTP methods", pollCase({}, async (handler) => {
  assert.equal((await callPoll(handler, { method: "DELETE", headers: { "x-webhook-secret": SECRET } })).statusCode, 405);
}));
