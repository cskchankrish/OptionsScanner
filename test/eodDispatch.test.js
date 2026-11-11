/**
 * Item 6: EOD radar Telegram dispatch. Runs the real Upstash REST helpers against an
 * in-memory fake Redis (via a mocked fetch) and a fake Telegram endpoint.
 * Env is set BEFORE importing the module because REDIS_URL is read at load time.
 */
import test, { mock } from "node:test";
import assert from "node:assert/strict";

process.env.UPSTASH_REDIS_REST_URL = "https://fake-redis.invalid";
process.env.UPSTASH_REDIS_REST_TOKEN = "fake-token";
process.env.TELEGRAM_BOT_TOKEN = "fake-bot";
process.env.TELEGRAM_CHAT_ID = "fake-chat";
for (const k of ["KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL"]) delete process.env[k];

const store = new Map();
let telegramSends = 0;
let telegramOk = true;
let nseCalls = 0;

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });
}

async function fakeRedisCommand(args) {
  const [cmd, ...rest] = args.map(a => (typeof a === "string" ? a : String(a)));
  const C = cmd.toUpperCase();
  // Yield so concurrent callers genuinely interleave.
  await new Promise(r => setImmediate(r));
  if (C === "GET") return store.has(rest[0]) ? store.get(rest[0]) : null;
  if (C === "SET") {
    const [key, value, ...opts] = rest;
    const nx = opts.some(o => o.toUpperCase() === "NX");
    if (nx && store.has(key)) return null;
    store.set(key, value);
    return "OK";
  }
  if (C === "DEL") return store.delete(rest[0]) ? 1 : 0;
  return null;
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://fake-redis.invalid")) {
    if (u === "https://fake-redis.invalid" || u === "https://fake-redis.invalid/") {
      const body = JSON.parse(init.body);
      // @upstash/redis SDK may send a pipeline (array of arrays)
      if (Array.isArray(body[0])) {
        const out = [];
        for (const c of body) out.push({ result: await fakeRedisCommand(c) });
        return json(out);
      }
      return json({ result: await fakeRedisCommand(body) });
    }
    return json({ result: null }); // legacy /get/... /set/... paths used elsewhere
  }
  if (u.startsWith("https://api.telegram.org/")) {
    telegramSends++;
    return telegramOk ? json({ ok: true }) : json({ ok: false }, 500);
  }
  if (u.startsWith("https://www.nseindia.com/")) {
    nseCalls++;
    if (u === "https://www.nseindia.com/option-chain") return new Response("ok", { headers: { "set-cookie": "a=b; Path=/" } });
    if (u.includes("contract-info")) return json({ expiryDates: ["17-Nov-2026", "24-Nov-2026", "01-Dec-2026"] });
    if (u.includes("option-chain-v3")) {
      const data = [];
      for (let k = 24500; k <= 25500; k += 50) {
        data.push({ strikePrice: k, PE: { changeinOpenInterest: 3000, openInterest: 40000 }, CE: { changeinOpenInterest: 2000, openInterest: 40000 } });
      }
      return json({ records: { underlyingValue: 25000, data }, filtered: { data } });
    }
    if (u.includes("liveEquity-derivatives")) return json({ data: [] });
  }
  throw new Error(`Unexpected fetch in test: ${u}`);
};
test.after(() => { globalThis.fetch = realFetch; });

const mod = await import("../api/nifty-oi.js");

const decision = { verdict: "BTST (BUY CE)", bias: "BULLISH", conviction: 70, sizing: "50%", score: 3 };
const base = { istDateStr: "2026-11-11", eodDecision: decision, spot: 25000, floorStrike: 24900, roofStrike: 25200 };

test.beforeEach(() => {
  store.clear();
  telegramSends = 0;
  telegramOk = true;
});

test("item6: redisRestGet / redisRestSet are defined and round-trip through Upstash REST", async () => {
  assert.equal(typeof mod.redisRestGet, "function");
  assert.equal(typeof mod.redisRestSet, "function");
  assert.equal(await mod.redisRestSet("k1", { a: 1 }, 60), true);
  assert.deepEqual(await mod.redisRestGet("k1"), { a: 1 });
  assert.equal(await mod.redisRestSetNx("k1", "x", 60), false);
  assert.equal(await mod.redisRestSetNx("k2", "x", 60), true);
});

test("item6: two concurrent dispatches in the same 15-min slot send exactly one Telegram alert", async () => {
  const [a, b] = await Promise.all([
    mod.dispatchEodRadarAlert({ ...base, istMinutes: 902 }),
    mod.dispatchEodRadarAlert({ ...base, istMinutes: 903 }),
  ]);
  assert.equal(telegramSends, 1);
  assert.deepEqual([a.status, b.status].sort(), ["ALREADY_CLAIMED", "SENT"]);
  assert.equal(a.slotTimeStr, "15:00");
  const saved = JSON.parse(store.get("nifty:eod_slot_dispatched:2026-11-11:15:00"));
  assert.equal(saved.state, "SENT");

  // Later poll in the same slot: still deduped. Next slot: sends again.
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 914 })).status, "ALREADY_CLAIMED");
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 915 })).status, "SENT");
  assert.equal(telegramSends, 2);
});

test("item6: failed send releases the slot claim so a later poll can retry", async () => {
  telegramOk = false;
  const r1 = await mod.dispatchEodRadarAlert({ ...base, istMinutes: 870 });
  assert.equal(r1.status, "SEND_FAILED_RELEASED");
  assert.equal(store.has("nifty:eod_slot_dispatched:2026-11-11:14:30"), false);
  telegramOk = true;
  const before = telegramSends;
  const r2 = await mod.dispatchEodRadarAlert({ ...base, istMinutes: 871 });
  assert.equal(r2.status, "SENT");
  assert.equal(telegramSends, before + 1);
});

test("item6: outside 14:15–15:30 nothing is sent", async () => {
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 840 })).status, "OUTSIDE_WINDOW");
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 931 })).status, "OUTSIDE_WINDOW");
  assert.equal(telegramSends, 0);
});

test("item6: full handler path at 15:00 IST dispatches once across concurrent polls (no ReferenceError)", async () => {
  // Wednesday 11-Nov-2026 15:00 IST = 09:30 UTC
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 11, 9, 30, 0) });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => { errors.push(a.map(String).join(" ")); };
  try {
    mod.__resetSessionStateForTests();
    const mk = () => ({ statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(d) { this.body = d; return this; } });
    const r1 = mk();
    const r2 = mk();
    await Promise.all([
      mod.default({ method: "GET", query: {}, headers: {} }, r1),
      mod.default({ method: "GET", query: {}, headers: {} }, r2),
    ]);
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.body.isLive, true, "live path must run (not fallback)");
    assert.equal(telegramSends, 1, `expected one EOD alert, errors: ${errors.join(" | ")}`);
    assert.ok(!errors.some(e => /ReferenceError|is not defined/.test(e)), errors.join(" | "));
    assert.ok(store.has("nifty:eod_slot_dispatched:2026-11-11:15:00"));
  } finally {
    console.error = origError;
    mock.timers.reset();
    mod.__resetSessionStateForTests();
  }
});
