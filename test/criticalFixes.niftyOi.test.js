/**
 * Items 1, 3 and 5 for api/nifty-oi.js: live timeline recording, request auth,
 * and the server futures quadrant. Clock and NSE are mocked; Redis is disabled.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

// Make sure this process never talks to a real Redis / Telegram.
for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
]) delete process.env[k];

const mod = await import("../api/nifty-oi.js");
const handler = mod.default;

const SECRET = "oi-test-secret";
// Wednesday 11-Nov-2026 10:00 IST (04:30 UTC) — live market hours.
const LIVE_10AM = Date.UTC(2026, 10, 11, 4, 30, 0);

function chainRows(spot, putScale) {
  const rows = [];
  for (let k = spot - 500; k <= spot + 500; k += 50) {
    rows.push({
      strikePrice: k,
      PE: { changeinOpenInterest: k <= spot ? Math.round(4000 * putScale) : 500, openInterest: 50000 },
      CE: { changeinOpenInterest: k >= spot ? 3000 : 400, openInterest: 50000 },
    });
  }
  return rows;
}

function fakeNseFetch(calls) {
  return async (url) => {
    const u = String(url);
    calls.push(u);
    const json = (obj, headers = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json", ...headers } });
    if (u === "https://www.nseindia.com/option-chain") return new Response("ok", { status: 200, headers: { "set-cookie": "nsit=abc; Path=/" } });
    if (u.includes("option-chain-contract-info")) return json({ expiryDates: ["17-Nov-2026", "24-Nov-2026", "01-Dec-2026", "29-Dec-2026"] });
    if (u.includes("option-chain-v3")) {
      const isNext = u.includes("24-Nov-2026");
      const data = chainRows(25000, isNext ? 3 : 1);
      return json({ records: { underlyingValue: 25000, timestamp: "11-Nov-2026 10:00:00", data }, filtered: { data } });
    }
    if (u.includes("liveEquity-derivatives")) {
      return json({
        data: [
          { underlying: "NIFTY", instrumentType: "FUTIDX", expiryDate: "24-Nov-2026", lastPrice: 25100, change: 60, pChange: 0.24, openInterest: 210000, changeinOpenInterest: 6000, underlyingValue: 25000 },
          { underlying: "NIFTY", instrumentType: "FUTIDX", expiryDate: "29-Dec-2026", lastPrice: 25250, change: 55, pChange: 0.22, openInterest: 40000, changeinOpenInterest: 900, underlyingValue: 25000 },
        ],
      });
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  };
}

function mockRes() {
  return {
    statusCode: 200,
    body: null,
    setHeader() { return this; },
    status(c) { this.statusCode = c; return this; },
    json(d) { this.body = d; return this; },
    end() { return this; },
  };
}

async function call(query = {}, extra = {}) {
  const res = mockRes();
  await handler({ method: "GET", query, headers: {}, ...extra }, res);
  return res;
}

function withLiveMarket(fn) {
  return async () => {
    const realFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = fakeNseFetch(calls);
    mock.timers.enable({ apis: ["Date"], now: LIVE_10AM });
    mod.__resetSessionStateForTests();
    try {
      await fn(calls);
    } finally {
      mock.timers.reset();
      globalThis.fetch = realFetch;
      mod.__resetSessionStateForTests();
    }
  };
}

// ── Item 1: live timeline ──

test("item1: first near-expiry poll of the session records a real tick into empty history", withLiveMarket(async () => {
  assert.equal(mod.__getIntradayHistoryForTests().length, 0);
  const res = await call();
  assert.equal(res.statusCode, 200);
  const p = res.body;
  assert.equal(p.isLive, true);
  assert.equal(p.expiryDate, p.rollover.nearExpiry);

  const hist = mod.__getIntradayHistoryForTests();
  assert.equal(hist.length, 1, "first tick must be recorded");
  assert.equal(hist[0].isLiveTick, true);
  assert.equal(hist[0].time, "10:00");
  assert.equal(hist[0].putWriting, p.totalPutWriting);

  assert.equal(p.intradayTimeline.length, 1);
  assert.ok(p.intradayTimeline.every(pt => pt.isLiveTick === true), "no synthetic ticks in response");

  // With < 3 real ticks the EOD closing-flow audit must hold neutral (AWAITING_DATA), not score synthetic flow.
  const statuses = (p.eodDecision.audit || []).map(a => a.status);
  assert.ok(statuses.includes("AWAITING_DATA"), `audit statuses: ${statuses.join(",")}`);
}));

test("item1: non-near expiry request sees only a copy of real history and never mutates it", withLiveMarket(async () => {
  // Seed one real tick via the near path.
  await call();
  const before = JSON.parse(JSON.stringify(mod.__getIntradayHistoryForTests()));
  assert.equal(before.length, 1);

  const res = await call({ expiry: "next" });
  assert.equal(res.statusCode, 200);
  const p = res.body;
  assert.equal(p.expiryDate, p.rollover.nextExpiry);
  assert.notEqual(p.totalPutWriting, before[0].putWriting, "next-expiry chain differs from near");

  const after = mod.__getIntradayHistoryForTests();
  assert.deepEqual(after, before, "intradayHistory must not change on a non-near request");
  assert.deepEqual(p.intradayTimeline, before, "timeline is the real near history, not synthetic");
  assert.ok(p.intradayTimeline.every(pt => pt.isLiveTick === true));

  // The returned copy is detached from module state.
  p.intradayTimeline.push({ time: "10:01" });
  p.intradayTimeline[0].putWriting = -1;
  assert.deepEqual(mod.__getIntradayHistoryForTests(), before);
}));

test("item1: non-near expiry with empty history gets an empty timeline (no synthetic ticks)", withLiveMarket(async () => {
  const res = await call({ expiry: "next" });
  const p = res.body;
  assert.deepEqual(p.intradayTimeline, []);
  assert.equal(mod.__getIntradayHistoryForTests().length, 0);
  const statuses = (p.eodDecision.audit || []).map(a => a.status);
  assert.ok(statuses.includes("AWAITING_DATA"));
  assert.equal(p.smartMoney.macroTurn?.detected ?? false, false, "macro-turn detector must not fire on no data");
}));

// ── Item 5: server futures quadrant is published ──

test("item5: payload futures.quadrant and tick futQuadrant come from evaluateSmartMoneyFusion", withLiveMarket(async () => {
  const p = (await call()).body;
  const q = p.fusion.quadrantInfo.quadrant;
  assert.ok(q && q !== "UNAVAILABLE", `quadrant ${q}`);
  assert.equal(p.futures.quadrant, q);
  assert.equal(p.intradayTimeline[0].futQuadrant, q);
  assert.equal(p.swingRadar.futuresBuildup, q);
}));

// ── Item 3: nifty-oi mutations require the secret ──

function withSecret(value, fn) {
  return async () => {
    const prev = process.env.TV_WEBHOOK_SECRET;
    if (value === undefined) delete process.env.TV_WEBHOOK_SECRET;
    else process.env.TV_WEBHOOK_SECRET = value;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET;
      else process.env.TV_WEBHOOK_SECRET = prev;
    }
  };
}

const tick = (time, minutes) => ({ time, minutes, putWriting: 1000, callWriting: 500, netDiff: 500, spot: 25000, isLiveTick: true });

for (const body of [
  { timeline: [tick("09:20", 560)] },
  { timeline: [tick("09:20", 560)], replaceTimeline: true },
  { action: "sync_eod_history", history: [] },
]) {
  test(`item3: nifty-oi POST ${Object.keys(body).join("+")} — 503 unconfigured, 401 unauthenticated`, withLiveMarket(async () => {
    await withSecret(undefined, async () => {
      const res = mockRes();
      await handler({ method: "POST", query: {}, headers: {}, body: JSON.stringify(body) }, res);
      assert.equal(res.statusCode, 503);
    })();
    await withSecret("CHANGE_ME", async () => {
      const res = mockRes();
      await handler({ method: "POST", query: {}, headers: {}, body: JSON.stringify({ ...body, secret: "CHANGE_ME" }) }, res);
      assert.equal(res.statusCode, 503);
    })();
    await withSecret(SECRET, async () => {
      const res = mockRes();
      await handler({ method: "POST", query: {}, headers: {}, body: JSON.stringify(body) }, res);
      assert.equal(res.statusCode, 401);
      const res2 = mockRes();
      await handler({ method: "POST", query: { key: "bad" }, headers: {}, body: JSON.stringify(body) }, res2);
      assert.equal(res2.statusCode, 401);
    })();
    assert.equal(mod.__getIntradayHistoryForTests().length, 0, "history untouched by rejected sync");
  }));
}

test("item3: nifty-oi POST timeline sync works with the x-webhook-secret header", withLiveMarket(withSecret(SECRET, async () => {
  const res = mockRes();
  await handler({ method: "POST", query: {}, headers: { "x-webhook-secret": SECRET }, body: JSON.stringify({ timeline: [tick("09:20", 560)] }) }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.count, 1);
  assert.equal(mod.__getIntradayHistoryForTests().length, 1);
})));

test("item3: force=true and test=eod_alert require the secret", withLiveMarket(async () => {
  await withSecret(undefined, async () => {
    assert.equal((await call({ force: "true" })).statusCode, 503);
    assert.equal((await call({ test: "eod_alert" })).statusCode, 503);
  })();
  await withSecret(SECRET, async () => {
    assert.equal((await call({ force: "true" })).statusCode, 401);
    assert.equal((await call({ test: "eod_alert", key: "nope" })).statusCode, 401);
    const ok = await call({ force: "true", key: SECRET });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.isLive, true);
  })();
}));

test("item3: plain GET poll stays open without a secret", withLiveMarket(withSecret(undefined, async () => {
  const res = await call();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.isLive, true);
})));
