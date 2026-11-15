/**
 * TradingView ack deadline: a slow Pine-alert pipeline is acknowledged early (200
 * ACCEPTED_PROCESSING) only when a working waitUntil keeps the pipeline alive; the pipeline itself
 * runs unchanged to completion. All I/O is injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_REFRESH_TIMEOUT_MS",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS",
  "TV_ACK_DEADLINE_MS",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");

const SECRET = "ack-test-webhook-secret";
const KEY = "nifty:tv:active_trade";
const BRIDGE_ON = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://algo.example.test/flow", FLOW_BRIDGE_SECRET: "ack-test-hmac" };
const TG = { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "test-chat" };
const SLOW_MS = 900;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const ttl = {};
  const lists = {};
  const r = {
    store, ttl, lists,
    delayMs: 0,
    async pause() { await tick(); if (r.delayMs) await sleep(r.delayMs); },
    async get(k) { await r.pause(); return store[k] ?? null; },
    async set(k, v, opts = {}) {
      await r.pause();
      if (opts.nx && k in store) return null;
      store[k] = v;
      ttl[k] = opts.ex ?? null;
      return "OK";
    },
    async del(k) { await r.pause(); if (k in store) { delete store[k]; delete ttl[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
  return r;
}

/** Express-like response: a second write throws, as "headers already sent" would. */
function mockReqRes({ method = "POST", body = {}, query = {} } = {}) {
  const req = { method, body: JSON.stringify(body), query, headers: {} };
  const res = {
    statusCode: 200,
    body: null,
    writes: 0,
    headersSent: false,
    status(c) { if (!this.headersSent) this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { return this._write(d); },
    send(d) { return this._write(d); },
    end() { return this._write(undefined); },
    _write(d) {
      if (this.headersSent) throw new Error("ERR_HTTP_HEADERS_SENT: Cannot set headers after they are sent");
      this.headersSent = true;
      this.writes += 1;
      this.body = d;
      return this;
    },
  };
  return { req, res };
}

const bullAlert = (extra = {}) => ({
  secret: SECRET, sym: "NSE:NIFTY", tf: "15", dir: "LONG", grade: "SYNERGY_BULL",
  close: 25060, sl: 24995, cappedSl: 24995, rDist: 65, t1Dist: 65, t2Dist: 130,
  actRoof: 25300, actFloor: 25000, ...extra,
});
// Put blitz + long build-up => EXECUTE_HIGH_CONVICTION_SYNERGY (dispatched by the bridge allow-list).
const snapshot = () => ({
  snapshotAt: Date.now() - 20_000,
  snapshotSource: "poller",
  corridor: { deltaPCR: 1.42, floorStrike: 25000, roofStrike: 25300 },
  futures: { quadrant: "LONG_BUILDUP" },
  smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BULLISH_SYNERGY", actionTag: "NEUTRAL" },
});
const ACCEPT_BODY = JSON.stringify({ status: "accepted", reason: null, mode: "dry_run", orderRef: "ORD-1" });
const accept = () => new Response(ACCEPT_BODY, { status: 200, headers: { "content-type": "application/json" } });

let idSeq = 0;

/**
 * Case runner. waitUntil: "available" (records promises), "none" (null) or "throws".
 * algoDelayMs slows the Algo dispatch; tgDelayMs slows the signal Telegram (global fetch stub).
 */
function ackCase({ env = {}, initial = {}, waitUntil = "available", algoDelayMs = 0, tgDelayMs = 0, sendTextDelayMs = 0, onTelegram = null, nowHook = null } = {}, fn) {
  return async () => {
    const allEnv = { TV_WEBHOOK_SECRET: SECRET, ...BRIDGE_ON, ...TG, ...env };
    const prev = {};
    for (const [k, v] of Object.entries(allEnv)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = createFakeRedis({ "nifty:flow:latest": JSON.stringify(snapshot()), ...initial });
    const sent = [];
    const calls = [];
    const telegram = [];
    const handed = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      if (!String(url).startsWith("https://api.telegram.org/")) throw new Error(`unexpected network call in test: ${url}`);
      if (tgDelayMs) await sleep(tgDelayMs);
      telegram.push({ url: String(url), body: init?.body });
      if (onTelegram) onTelegram();
      return new Response("{}", { status: 200 });
    };
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => (nowHook ? nowHook() : Date.now()),
      isLiveMarket: async () => false,
      refresh: async () => ({ ok: false, stage: "nse", error: "no refresh in tests" }),
      sendText: async (t) => { if (sendTextDelayMs) await sleep(sendTextDelayMs); sent.push(t); return true; },
      bridgeFetch: async (url, init) => { calls.push({ url, init }); if (algoDelayMs) await sleep(algoDelayMs); return accept(); },
      newTradeId: () => `ft-ack-${++idSeq}`,
      getWaitUntil: async () =>
        waitUntil === "available" ? (p) => { handed.push(p); }
        : waitUntil === "throws" ? () => { throw new Error("no context"); }
        : null,
    });
    try {
      await fn({ redis, sent, calls, telegram, handed });
    } finally {
      // Let any still-running background pipeline finish before restoring the globals it uses.
      await Promise.allSettled(handed);
      globalThis.fetch = realFetch;
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      for (const [k, v] of Object.entries(prev)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  };
}

async function post(body) {
  const { req, res } = mockReqRes({ body });
  const t0 = Date.now();
  await webhook.default(req, res);
  res.elapsedMs = Date.now() - t0;
  return res;
}
async function get(query) {
  const { req, res } = mockReqRes({ method: "GET", query: { key: SECRET, ...query } });
  await webhook.default(req, res);
  return res;
}
const stored = (redis) => (redis.store[KEY] ? JSON.parse(redis.store[KEY]) : null);
const dailySignals = (redis) => Object.entries(redis.lists).filter(([k]) => /^nifty:tv:signals:\d{4}-\d{2}-\d{2}$/.test(k)).flatMap(([, v]) => v.map((s) => JSON.parse(s)));
const FULL_KEYS = ["ok", "decision", "recommendedLots", "fusedVerdict", "watchdog"];

/** Captures console.error/console.log and unhandled rejections for the duration of fn. */
async function capture(fn) {
  const errors = [];
  const logs = [];
  const rejections = [];
  const origErr = console.error;
  const origLog = console.log;
  const onRej = (r) => rejections.push(r);
  console.error = (...a) => { errors.push(a.map((x) => (x instanceof Error ? x.message : String(x))).join(" ")); };
  console.log = (...a) => { logs.push(a.map(String).join(" ")); };
  process.on("unhandledRejection", onRej);
  try {
    await fn();
    await sleep(50);
  } finally {
    console.error = origErr;
    console.log = origLog;
    process.off("unhandledRejection", onRej);
  }
  return { errors, logs, rejections };
}

// ── Config ──

test("TV_ACK_DEADLINE_MS: default 2000, clamped 500..2800, 0 disables", () => {
  assert.equal(webhook.getTvAckDeadlineMs({}), 2000);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "" }), 2000);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "abc" }), 2000);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "0" }), 0);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "100" }), 500);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "1500" }), 1500);
  assert.equal(webhook.getTvAckDeadlineMs({ TV_ACK_DEADLINE_MS: "9000" }), 2800);
});

test("waitUntil check: null without a Vercel request context; bound to the context when present", async () => {
  const SYM = Symbol.for("@vercel/request-context");
  const prev = globalThis[SYM];
  try {
    delete globalThis[SYM];
    assert.equal(await webhook.resolveVercelWaitUntil(), null, "no context => no early ack");
    globalThis[SYM] = { get: () => ({}) };
    assert.equal(await webhook.resolveVercelWaitUntil(), null, "context without waitUntil => no early ack");
    globalThis[SYM] = { get: () => undefined };
    assert.equal(await webhook.resolveVercelWaitUntil(), null);
    const got = [];
    globalThis[SYM] = { get: () => ({ waitUntil: (p) => got.push(p) }) };
    const wu = await webhook.resolveVercelWaitUntil();
    assert.equal(typeof wu, "function");
    const p = Promise.resolve(1);
    wu(p);
    assert.deepEqual(got, [p]);
  } finally {
    if (prev === undefined) delete globalThis[SYM];
    else globalThis[SYM] = prev;
  }
});

// ── Slow approved alert ──

test("slow approved SYNERGY_BULL with waitUntil: early ACCEPTED_PROCESSING; pipeline completes in background exactly once",
  ackCase({ env: { TV_ACK_DEADLINE_MS: "500" }, algoDelayMs: SLOW_MS }, async ({ redis, sent, calls, telegram, handed }) => {
    let res;
    const out = await capture(async () => {
      res = await post(bullAlert());
      assert.ok(res.elapsedMs < SLOW_MS, `acked before the slow dispatch finished (${res.elapsedMs}ms)`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.ok, true);
      assert.equal(res.body.status, "ACCEPTED_PROCESSING");
      assert.equal(res.body.grade, "SYNERGY_BULL");
      assert.match(res.body.tradeId, /^ft-ack-\d+$/);
      assert.ok(!JSON.stringify(res.body).includes(SECRET), "never echoes the secret");
      assert.equal(handed.length, 1, "pipeline registered with waitUntil");
      await handed[0];
    });
    // Pipeline completed: one dispatch, lock + execution, signal persisted, Telegram sent.
    assert.equal(calls.length, 1, "dispatched exactly once");
    const t = stored(redis);
    assert.equal(t.id, res.body.tradeId);
    assert.equal(t.execution.status, "ACCEPTED");
    const sig = dailySignals(redis);
    assert.equal(sig.length, 1);
    assert.equal(sig[0].decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
    assert.equal(sig[0].tradeId, t.id);
    assert.equal(sig[0].execution.status, "ACCEPTED");
    assert.ok(redis.store["nifty:tv:latest_signal"]);
    assert.equal(sent.filter((s) => /SENT TO ALGO/.test(s)).length, 1, "bridge Telegram once");
    assert.ok(telegram.length >= 1, "signal Telegram sent");
    // The late res.json was swallowed: the ack is the only write and it was not overwritten.
    assert.equal(res.writes, 1);
    assert.equal(res.body.status, "ACCEPTED_PROCESSING");
    assert.equal(out.rejections.length, 0);
    assert.equal(out.errors.length, 0, out.errors.join("\n"));
    assert.ok(out.logs.some((l) => /early ack ACCEPTED_PROCESSING after \d+ms \(grade=SYNERGY_BULL/.test(l)), "one early-ack log line");
  }));

for (const mode of ["none", "throws"]) {
  test(`slow approved SYNERGY_BULL, waitUntil ${mode === "none" ? "not available" : "registration fails"}: no early ack, full response after the pipeline`,
    ackCase({ env: { TV_ACK_DEADLINE_MS: "500" }, algoDelayMs: SLOW_MS, waitUntil: mode }, async ({ redis, calls, handed }) => {
      const out = await capture(async () => {
        const res = await post(bullAlert());
        assert.ok(res.elapsedMs >= SLOW_MS - 20, `waited for the pipeline (${res.elapsedMs}ms)`);
        assert.equal(res.statusCode, 200);
        assert.deepEqual(Object.keys(res.body), FULL_KEYS);
        assert.equal(res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
        assert.equal(res.body.fusedVerdict.execution.status, "ACCEPTED");
        assert.equal(res.writes, 1);
      });
      assert.equal(handed.length, 0);
      assert.equal(calls.length, 1);
      assert.equal(stored(redis).execution.status, "ACCEPTED");
      assert.equal(out.rejections.length, 0);
      assert.ok(!out.logs.some((l) => /early ack/.test(l)));
    }));
}

test("TV_ACK_DEADLINE_MS=0: never acks early, even with waitUntil",
  ackCase({ env: { TV_ACK_DEADLINE_MS: "0" }, algoDelayMs: SLOW_MS }, async ({ handed, calls }) => {
    const res = await post(bullAlert());
    assert.ok(res.elapsedMs >= SLOW_MS - 20);
    assert.deepEqual(Object.keys(res.body), FULL_KEYS);
    assert.equal(res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
    assert.equal(handed.length, 0);
    assert.equal(calls.length, 1);
  }));

// ── Fast alert ──

test("fast alert (finishes before the deadline): same response as with the feature off; waitUntil not used", async () => {
  const bodies = {};
  for (const deadline of ["500", "0"]) {
    await ackCase({ env: { TV_ACK_DEADLINE_MS: deadline } }, async ({ handed, calls }) => {
      const res = await post(bullAlert());
      assert.equal(res.statusCode, 200);
      assert.equal(res.writes, 1);
      assert.equal(handed.length, 0, "waitUntil not needed");
      assert.equal(calls.length, 1);
      bodies[deadline] = res.body;
    })();
  }
  assert.deepEqual(Object.keys(bodies["500"]), FULL_KEYS);
  assert.deepEqual(Object.keys(bodies["500"]), Object.keys(bodies["0"]));
  assert.equal(bodies["500"].decision, bodies["0"].decision);
  assert.equal(bodies["500"].recommendedLots, bodies["0"].recommendedLots);
  assert.equal(bodies["500"].watchdog, bodies["0"].watchdog);
  assert.deepEqual(Object.keys(bodies["500"].fusedVerdict).sort(), Object.keys(bodies["0"].fusedVerdict).sort());
});

test("fast non-actionable alert: LOG_ONLY response unchanged", ackCase({ env: { TV_ACK_DEADLINE_MS: "500" } }, async ({ handed }) => {
  const res = await post(bullAlert({ grade: "MEGA" }));
  assert.deepEqual(Object.keys(res.body), FULL_KEYS);
  assert.equal(res.body.decision, "LOG_ONLY");
  assert.equal(handed.length, 0);
}));

// ── Non-Pine paths are never early-acked ──

const ownedTrade = (status = "ACCEPTED") => ({
  active: true, id: "ft-owned-1", grade: "SYNERGY_BEAR", direction: "SHORT", timeframe: "15",
  entryPrice: 24960, stopLoss: 25025, riskPoints: 65, target1Price: 24895, target2Price: 24830,
  target1Dist: 65, target2Dist: 130, execution: { status, mode: "live", orderRef: "ORD-9" },
});

test("slow ENTRY_FILLED sync-back: answered synchronously, never early-acked",
  ackCase({ env: { TV_ACK_DEADLINE_MS: "500" }, sendTextDelayMs: SLOW_MS, initial: { [KEY]: JSON.stringify(ownedTrade("ACCEPTED")) } }, async ({ redis, handed }) => {
    const res = await post({ secret: SECRET, grade: "ENTRY_FILLED", tradeId: "ft-owned-1", source: "algo", spot: 24958, optionFill: 112.35, contract: "NIFTY17NOV2624950PE", lots: 1, mode: "live", t: 1762841000000 });
    assert.ok(res.elapsedMs >= SLOW_MS - 20);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.event, "ENTRY_FILLED");
    assert.equal(stored(redis).execution.status, "FILLED");
    assert.equal(handed.length, 0);
  }));

test("slow Algo exit sync-back (STOP_LOSS_HIT): answered synchronously, never early-acked",
  ackCase({ env: { TV_ACK_DEADLINE_MS: "500" }, tgDelayMs: SLOW_MS, initial: { [KEY]: JSON.stringify(ownedTrade("FILLED")) } }, async ({ redis, handed }) => {
    const res = await post({ secret: SECRET, grade: "STOP_LOSS_HIT", tradeId: "ft-owned-1", source: "algo", spot: 25025, optionFill: 88.5, lots: 1, mode: "live", t: 1762841000000 });
    assert.ok(res.elapsedMs >= SLOW_MS - 20);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.event, "TRADE_CLOSED");
    assert.equal(stored(redis), null);
    assert.equal(handed.length, 0);
  }));

test("slow GET close_trade: answered synchronously, never early-acked",
  ackCase({ env: { TV_ACK_DEADLINE_MS: "500" }, initial: { [KEY]: JSON.stringify(ownedTrade("FILLED")) } }, async ({ redis, handed }) => {
    redis.delayMs = 300;
    const { req, res } = mockReqRes({ method: "GET", query: { key: SECRET, close_trade: "1", tradeId: "ft-owned-1", reason: "MANUAL_CLOSE" } });
    const t0 = Date.now();
    await webhook.default(req, res);
    assert.ok(Date.now() - t0 >= 500, "slower than the deadline");
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.writes, 1);
    assert.equal(handed.length, 0);
    redis.delayMs = 0;
    assert.equal(stored(redis), null);
  }));

// ── Errors after the early ack ──

test("pipeline throws after the early ack: error logged, no unhandled rejection, ack untouched", async () => {
  let explode = false;
  await ackCase({
    env: { TV_ACK_DEADLINE_MS: "500" },
    tgDelayMs: SLOW_MS,
    onTelegram: () => { explode = true; },
    nowHook: () => { if (explode) throw new Error("boom after ack"); return Date.now(); },
  }, async ({ handed, calls, redis }) => {
    const out = await capture(async () => {
      const res = await post(bullAlert());
      assert.equal(res.body.status, "ACCEPTED_PROCESSING");
      assert.equal(handed.length, 1);
      await handed[0]; // must resolve, never reject
      assert.equal(res.writes, 1);
      assert.equal(res.body.status, "ACCEPTED_PROCESSING");
    });
    assert.equal(calls.length, 1, "dispatch still happened once before the failure");
    assert.equal(stored(redis).execution.status, "ACCEPTED");
    assert.equal(out.rejections.length, 0);
    assert.ok(out.errors.some((e) => /Error processing TradingView alert.*boom after ack/.test(e)), out.errors.join("\n"));
  })();
});

test("runWithAckDeadline: a raw rejection after the ack is logged and swallowed; before the ack it propagates", async () => {
  const handed = [];
  const out = await capture(async () => {
    const { res } = mockReqRes();
    await webhook.runWithAckDeadline({
      res,
      run: async () => { await sleep(700); throw new Error("raw failure"); },
      requestStartMs: Date.now(),
      deadlineMs: 500,
      getWaitUntil: async () => (p) => handed.push(p),
      buildAck: () => ({ grade: "SYNERGY_BULL" }),
    });
    assert.equal(res.body.status, "ACCEPTED_PROCESSING");
    await handed[0];
  });
  assert.equal(out.rejections.length, 0);
  assert.ok(out.errors.some((e) => /Pipeline error after early TradingView ack.*raw failure/.test(e)), out.errors.join("\n"));

  const { res } = mockReqRes();
  await assert.rejects(
    webhook.runWithAckDeadline({
      res,
      run: async () => { throw new Error("early failure"); },
      requestStartMs: Date.now(),
      deadlineMs: 500,
      getWaitUntil: async () => () => {},
    }),
    /early failure/,
  );
  assert.equal(res.writes, 0, "no ack for a pipeline that failed before the deadline");
});
