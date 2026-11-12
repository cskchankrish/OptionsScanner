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
const telegramTexts = [];
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
    try { telegramTexts.push(JSON.parse(init.body).text); } catch (e) { telegramTexts.push(""); }
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
  telegramTexts.length = 0;
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

  // Later poll in the same slot (15:00 slot now covers 15:00–15:04): still deduped. Next slot: sends again.
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 904 })).status, "ALREADY_CLAIMED");
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 905 })).status, "SENT");
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

test("item6: outside 14:15–15:38 nothing is sent", async () => {
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 840 })).status, "OUTSIDE_WINDOW");
  assert.equal((await mod.dispatchEodRadarAlert({ ...base, istMinutes: 939 })).status, "OUTSIDE_WINDOW");
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
    // Exactly one EOD radar message. Since 12-Nov the same refresh may also send collector alerts:
    // this session has a single tick at 15:00 (a 09:15–15:00 hole) and no poller heartbeat, so one
    // "missed ticks" and one "poller down" alert are expected — each exactly once.
    const eodTexts = telegramTexts.filter(t => /EOD CARRY|CARRY DIRECTIVE/.test(t));
    assert.equal(eodTexts.length, 1, `expected one EOD alert, errors: ${errors.join(" | ")}`);
    assert.equal(telegramTexts.filter(t => /Scanner missed ticks/.test(t)).length, 1);
    assert.equal(telegramTexts.filter(t => /POLLER DOWN/.test(t)).length, 1);
    assert.equal(telegramSends, 3);
    assert.ok(!errors.some(e => /ReferenceError|is not defined/.test(e)), errors.join(" | "));
    assert.ok(store.has("nifty:eod_slot_dispatched:2026-11-11:15:00"));
  } finally {
    console.error = origError;
    mock.timers.reset();
    mod.__resetSessionStateForTests();
  }
});

// ── Phase 2: 15:38 window, 5-minute closing slots and flip alerts ──

const bull = { verdict: "CARRY NIFTY CE (BTST)", bias: "BULLISH", conviction: 84, sizing: "75% Normal Size", score: 3, action: "hold CE" };
const bear = { verdict: "CARRY NIFTY PE (STBT)", bias: "BEARISH", conviction: 88, sizing: "75% Normal Size", score: -4, action: "hold PE" };
const flat = { verdict: "EXIT TO CASH / DO NOT CARRY", bias: "NEUTRAL", conviction: 80, sizing: "0% (Cash Only)", score: 1, action: "cash" };
const LAST_KEY = "nifty:eod_last_sent:2026-11-11";
// 11-Nov-2026 IST minute m → epoch ms (IST = UTC+5:30)
const atIst = (m, sec = 0) => Date.UTC(2026, 10, 11, 0, 0, 0) + (m - 330) * 60000 + sec * 1000;
const d = (m, eodDecision, sec = 0, extraDeps = {}) =>
  mod.dispatchEodRadarAlert({ ...base, eodDecision, istMinutes: m, deps: { now: () => atIst(m, sec), ...extraDeps } });
const lastSent = () => (store.has(LAST_KEY) ? JSON.parse(store.get(LAST_KEY)) : null);

test("phase2: slot mapping — 15-min slots to 15:00, then 5-min slots 15:05…15:35, window 14:15–15:38", () => {
  const cases = [[854, null], [855, 855], [869, 855], [870, 870], [899, 885], [900, 900], [904, 900], [905, 905], [909, 905], [910, 910], [934, 930], [935, 935], [938, 935], [939, null], [940, null]];
  for (const [m, slot] of cases) assert.equal(mod.getEodSlotMinutes(m), slot, `minute ${m}`);
});

test("phase2: carry category is keyed on eodDecision.bias (BULLISH/BEARISH/NEUTRAL)", () => {
  assert.equal(mod.getEodCarryCategory(bull), "BTST");
  assert.equal(mod.getEodCarryCategory(bear), "STBT");
  assert.equal(mod.getEodCarryCategory(flat), "NO_CARRY");
  assert.equal(mod.getEodCarryCategory(null), "NO_CARRY");
});

test("phase2: slot boundaries — 15:00 is a 15-min slot, 15:05…15:35 fire once, 15:36–15:38 deduped, 14:14/15:39 outside", async () => {
  assert.equal((await d(854, bull)).status, "OUTSIDE_WINDOW");
  assert.equal((await d(900, bull)).status, "SENT");
  for (const m of [901, 902, 903, 904]) assert.equal((await d(m, bull)).status, "ALREADY_CLAIMED", `minute ${m}`);
  const fired = [];
  for (let m = 905; m <= 938; m++) {
    const r = await d(m, bull);
    if (r.status === "SENT") fired.push(r.slotTimeStr);
    else assert.equal(r.status, "ALREADY_CLAIMED", `minute ${m}`);
  }
  assert.deepEqual(fired, ["15:05", "15:10", "15:15", "15:20", "15:25", "15:30", "15:35"]);
  assert.equal((await d(939, bull)).status, "OUTSIDE_WINDOW");
  assert.equal(telegramSends, 8);
  const last = telegramTexts[telegramTexts.length - 1];
  assert.match(last, /LAST SCHEDULED UPDATE BEFORE 15:40 CLOSE/);
  assert.match(last, /LAST SCHEDULED UPDATE before the 15:40 IST close/);
  assert.doesNotMatch(telegramTexts[0], /LAST SCHEDULED/);
});

test("phase2: two concurrent polls in a 5-minute slot send exactly one message", async () => {
  const [a, b] = await Promise.all([d(921, bull), d(922, bull)]);
  assert.equal(telegramSends, 1);
  assert.deepEqual([a.status, b.status].sort(), ["ALREADY_CLAIMED", "SENT"]);
  assert.equal(a.slotTimeStr, "15:20");
});

test("phase2: last-sent state records category, score and time after a successful send", async () => {
  await d(905, bull);
  const s = lastSent();
  assert.equal(s.category, "BTST");
  assert.equal(s.score, 3);
  assert.equal(s.time, "15:05");
  assert.equal(s.kind, "SLOT");
});

test("phase2: a flip mid-slot is sent immediately, shows previous → new with scores, and is distinct from a slot update", async () => {
  await d(905, bull);
  assert.equal(telegramSends, 1);
  // 15:07 is inside the already-sent 15:05 slot; decision flips to STBT.
  const r = await d(907, bear, 20);
  assert.equal(r.status, "FLIP_SENT");
  assert.equal(telegramSends, 2);
  const txt = telegramTexts[1];
  assert.match(txt, /EOD CARRY DECISION FLIP \(15:07 IST\) · BTST \(BUY CE\) → STBT \(BUY PE\)/);
  assert.match(txt, /Score `\+3`, sent 15:05 IST\) → `STBT \(BUY PE\)` \(Score `-4`\)/);
  assert.match(txt, /Immediate flip alert/);
  assert.match(txt, /CARRY NIFTY PE \(STBT\)/, "existing body still present");
  assert.doesNotMatch(telegramTexts[0], /FLIP/);
  const s = lastSent();
  assert.equal(s.category, "STBT");
  assert.equal(s.score, -4);
  assert.equal(s.kind, "FLIP");
  // Same decision again on the next poll: nothing new.
  assert.equal((await d(908, bear)).status, "ALREADY_CLAIMED");
  assert.equal(telegramSends, 2);
});

test("phase2: concurrent polls seeing the same flip send exactly one flip alert", async () => {
  await d(905, bull);
  const rs = await Promise.all([d(907, bear, 1), d(907, bear, 2), d(907, bear, 3)]);
  assert.equal(telegramSends, 2);
  assert.equal(rs.filter(r => r.status === "FLIP_SENT").length, 1);
  assert.equal(rs.filter(r => r.status === "FLIP_ALREADY_CLAIMED").length, 2);
});

test("phase2: flips are throttled to one per 2 minutes, and a held flip is sent once the gap passes", async () => {
  await d(905, bull);
  assert.equal((await d(906, bear, 0)).status, "FLIP_SENT"); // flip at 15:06:00
  // Flip back to BTST 60s later, still inside the 2-minute gap and inside the 15:05 slot.
  assert.equal((await d(907, bull, 0)).status, "FLIP_THROTTLED");
  assert.equal((await d(907, bull, 59)).status, "FLIP_THROTTLED");
  assert.equal(telegramSends, 2);
  assert.equal(lastSent().category, "STBT", "throttled flip must not change last-sent state");
  // 15:08:01 = 121s after the last flip: sent now, never held longer than the gap.
  const r = await d(908, bull, 1);
  assert.equal(r.status, "FLIP_SENT");
  assert.equal(telegramSends, 3);
  assert.match(telegramTexts[2], /STBT \(BUY PE\) → BTST \(BUY CE\)/);
});

test("phase2: flip gap is env-overridable via EOD_FLIP_MIN_GAP_SECONDS", async () => {
  const prev = process.env.EOD_FLIP_MIN_GAP_SECONDS;
  process.env.EOD_FLIP_MIN_GAP_SECONDS = "30";
  try {
    assert.equal(mod.getEodFlipMinGapSeconds(), 30);
    await d(905, bull);
    assert.equal((await d(906, bear, 0)).status, "FLIP_SENT");
    assert.equal((await d(906, bull, 20)).status, "FLIP_THROTTLED");
    assert.equal((await d(906, bull, 31)).status, "FLIP_SENT");
  } finally {
    if (prev === undefined) delete process.env.EOD_FLIP_MIN_GAP_SECONDS;
    else process.env.EOD_FLIP_MIN_GAP_SECONDS = prev;
  }
  assert.equal(mod.getEodFlipMinGapSeconds(), 120);
});

test("phase2: flip + slot due on the same poll (even concurrently) → exactly one merged message", async () => {
  await d(905, bull);
  const rs = await Promise.all([d(910, bear, 5), d(910, bear, 6)]);
  assert.equal(telegramSends, 2, "one slot at 15:05 + one merged message at 15:10");
  assert.deepEqual(rs.map(r => r.status).sort(), ["FLIP_ALREADY_CLAIMED", "SENT_SLOT_WITH_FLIP"]);
  const txt = telegramTexts[1];
  assert.match(txt, /EOD CARRY DECISION FLIP .*BTST \(BUY CE\) → STBT \(BUY PE\)/);
  assert.match(txt, /EOD CARRY RADAR \(15:10 IST UPDATE\)/);
  assert.equal(JSON.parse(store.get("nifty:eod_slot_dispatched:2026-11-11:15:10")).state, "SENT");
  assert.equal(lastSent().kind, "SLOT_FLIP");
  // The rest of the 15:10 slot stays quiet.
  assert.equal((await d(912, bear)).status, "ALREADY_CLAIMED");
  assert.equal(telegramSends, 2);
});

test("phase2: a throttled flip that coincides with a new slot rides along in that one slot message", async () => {
  await d(905, bull);
  assert.equal((await d(909, bear, 0)).status, "FLIP_SENT"); // 15:09:00
  const r = await d(910, bull, 0); // 15:10:00, 60s later: throttled as a flip, but the slot is due
  assert.equal(r.status, "SENT_SLOT_WITH_FLIP");
  assert.equal(telegramSends, 3);
  assert.equal(lastSent().category, "BTST");
});

test("phase2: when a flip send fails, last-sent state is untouched and both claims are released", async () => {
  await d(905, bull);
  const before = store.get(LAST_KEY);
  telegramOk = false;
  const r1 = await d(907, bear);
  assert.equal(r1.status, "SEND_FAILED_RELEASED");
  assert.equal(store.get(LAST_KEY), before);
  assert.equal([...store.keys()].some(k => k.startsWith("nifty:eod_flip_claim:")), false);
  const r2 = await d(910, bear);
  assert.equal(r2.status, "SEND_FAILED_RELEASED");
  assert.equal(store.has("nifty:eod_slot_dispatched:2026-11-11:15:10"), false);
  assert.equal(store.get(LAST_KEY), before);
  telegramOk = true;
  assert.equal((await d(910, bear, 30)).status, "SENT_SLOT_WITH_FLIP");
  assert.equal(lastSent().category, "STBT");
});

test("phase2: no Redis → nothing sent, flips included", async () => {
  const deps = { hasRedis: false, sendAlert: async () => { throw new Error("must not send"); } };
  for (const m of [855, 900, 907, 935, 938]) {
    const r = await mod.dispatchEodRadarAlert({ ...base, eodDecision: bear, istMinutes: m, deps });
    assert.equal(r.status, "NO_REDIS_SKIPPED");
  }
  assert.equal(telegramSends, 0);
});

test("phase2: dispatcher test=eod_alert path bypasses window and dedupe, writes no state", async () => {
  const r = await mod.dispatchEodRadarAlert({ ...base, eodDecision: bull, istMinutes: 700, isEodTest: true });
  assert.equal(r.status, "TEST_SENT");
  assert.equal(r.sent, true);
  assert.equal(telegramSends, 1);
  assert.match(telegramTexts[0], /OFFICIAL EOD CARRY DIRECTIVE · BTST/);
  assert.equal(store.size, 0);
});

test("phase2: authenticated handler ?test=eod_alert still sends the EOD alert", async () => {
  mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 10, 11, 9, 30, 0) }); // 15:00 IST Wed
  const prevSecret = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = "eod-test-secret";
  try {
    mod.__resetSessionStateForTests();
    const mk = () => ({ statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(x) { this.body = x; return this; } });
    const denied = mk();
    await mod.default({ method: "GET", query: { test: "eod_alert", key: "nope" }, headers: {} }, denied);
    assert.equal(denied.statusCode, 401);
    assert.equal(telegramSends, 0);
    const res = mk();
    await mod.default({ method: "GET", query: { test: "eod_alert", key: "eod-test-secret" }, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(telegramSends, 1);
    assert.match(telegramTexts[0], /OFFICIAL EOD CARRY DIRECTIVE/);
    assert.equal(store.has("nifty:eod_slot_dispatched:2026-11-11:15:00"), false, "test path bypasses slot dedupe");
  } finally {
    if (prevSecret === undefined) delete process.env.TV_WEBHOOK_SECRET;
    else process.env.TV_WEBHOOK_SECRET = prevSecret;
    mock.timers.reset();
    mod.__resetSessionStateForTests();
  }
});
