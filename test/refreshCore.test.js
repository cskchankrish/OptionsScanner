/**
 * Shared refresh core (refreshLiveSnapshot) against a fake NSE and a fake Upstash REST endpoint.
 * The clock and fetch are mocked; nothing leaves the process.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
]) delete process.env[k];
const FAKE_REDIS = "https://fake-redis.invalid";
process.env.UPSTASH_REDIS_REST_URL = FAKE_REDIS;
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";

const mod = await import("../api/nifty-oi.js");

// Wednesday 11-Nov-2026 10:00 IST (04:30 UTC) — live market hours, not an expiry day.
const LIVE_10AM = Date.UTC(2026, 10, 11, 4, 30, 0);

function chainRows(spot) {
  const rows = [];
  for (let k = spot - 500; k <= spot + 500; k += 50) {
    rows.push({
      strikePrice: k,
      PE: { changeinOpenInterest: k <= spot ? 4000 : 500, openInterest: 50000 },
      CE: { changeinOpenInterest: k >= spot ? 3000 : 400, openInterest: 50000 },
    });
  }
  return rows;
}

function makeFetch({ nseFails = false, flowWriteStatus = 200 } = {}) {
  const writes = {};
  const fn = async (url, init = {}) => {
    const u = String(url);
    const json = (obj, status = 200, headers = {}) =>
      new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
    if (u.startsWith(FAKE_REDIS)) {
      const m = u.match(/\/set\/([^?]+)/);
      if (m) {
        const key = decodeURIComponent(m[1]);
        if (key === "nifty:flow:latest" && flowWriteStatus !== 200) return json({ error: "boom" }, flowWriteStatus);
        writes[key] = init.body;
        return json({ result: "OK" });
      }
      return json({ result: null }); // every GET / command: empty
    }
    if (u === "https://www.nseindia.com/option-chain") return new Response("ok", { status: 200, headers: { "set-cookie": "nsit=abc; Path=/" } });
    if (u.includes("option-chain-contract-info")) return json({ expiryDates: ["17-Nov-2026", "24-Nov-2026", "01-Dec-2026", "29-Dec-2026"] });
    if (u.includes("option-chain-v3")) {
      if (nseFails) return json({}, 403);
      const data = chainRows(25000);
      return json({ records: { underlyingValue: 25000, timestamp: "11-Nov-2026 10:00:00", data }, filtered: { data } });
    }
    if (u.includes("liveEquity-derivatives")) return json({ data: [] });
    return json({ result: null });
  };
  return { fn, writes };
}

function withEnv(opts, body) {
  return async () => {
    const realFetch = globalThis.fetch;
    const f = makeFetch(opts);
    globalThis.fetch = f.fn;
    mock.timers.enable({ apis: ["Date"], now: LIVE_10AM });
    mod.__resetSessionStateForTests();
    try {
      await body(f.writes);
    } finally {
      mock.timers.reset();
      globalThis.fetch = realFetch;
      mod.__resetSessionStateForTests();
    }
  };
}

test("refresh core: awaited persist writes nifty:flow:latest with snapshotAt + source", withEnv({}, async (writes) => {
  const r = await mod.refreshLiveSnapshot({ queryExpiry: "near", awaitPersist: true, source: "poller", deadlineMs: Date.now() + 12000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.persisted, true);
  assert.equal(r.snapshotAt, LIVE_10AM);
  assert.equal(r.targetExpiry, r.nearExpiry);
  assert.ok(r.ticks >= 1);
  const flow = JSON.parse(writes["nifty:flow:latest"]);
  assert.equal(flow.snapshotAt, LIVE_10AM);
  assert.equal(flow.snapshotSource, "poller");
  assert.equal(flow.corridor.floorStrike, r.payload.floor);
}));

test("refresh core: failed nifty:flow:latest write is reported (stage redis), not swallowed", withEnv({ flowWriteStatus: 500 }, async () => {
  const r = await mod.refreshLiveSnapshot({ queryExpiry: "near", awaitPersist: true, source: "poller" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "redis");
  assert.match(r.error, /nifty:flow:latest failed: HTTP 500/);
}));

test("refresh core: NSE chain failure is stage nse", withEnv({ nseFails: true }, async () => {
  const r = await mod.refreshLiveSnapshot({ queryExpiry: "near", awaitPersist: true, source: "poller" });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "nse");
  assert.match(r.error, /v3 option chain failed: status 403/);
}));

test("refresh core: an already-passed deadline fails fast without calling NSE", withEnv({}, async () => {
  const r = await mod.refreshLiveSnapshot({ awaitPersist: true, deadlineMs: Date.now() - 1 });
  assert.equal(r.ok, false);
  assert.equal(r.stage, "nse");
  assert.match(r.error, /deadline exceeded/);
}));

test("browser handler is unchanged: live payload returned even when the Redis write fails", withEnv({ flowWriteStatus: 500 }, async () => {
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; }, status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await mod.default({ method: "GET", query: {}, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isLive, true);
  assert.equal(res.body.success, true);
  assert.ok(Array.isArray(res.body.strikes) && res.body.strikes.length > 0);
}));

test("legacy ?cron=1 still answers 200 LIVE_POLL_SUCCESS / FALLBACK_CACHED as before", withEnv({ nseFails: true }, async () => {
  const res = {
    statusCode: 200, body: null,
    setHeader() { return this; }, status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; }, end() { return this; },
  };
  await mod.default({ method: "GET", query: { cron: "1" }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, "FALLBACK_CACHED");
}));
