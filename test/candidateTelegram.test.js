/**
 * Shadow candidate verdict Telegram (CANDIDATE_TELEGRAM_ENABLED) and the "Candidates" block of the
 * daily scorecard Telegram. Proves the message per category, exactly-once delivery, the switch,
 * failure isolation, the send's place after the record and off the response path, and that a
 * candidate still places no order, takes no lock and leaves a simultaneous real signal identical.
 * All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_MAX_AGE_SEC", "FLOW_REFRESH_TIMEOUT_MS",
  "FLOW_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET", "FLOW_BRIDGE_DECISIONS", "FLOW_BRIDGE_TIMEOUT_MS",
  "CANDIDATE_SHADOW_ENABLED", "CANDIDATE_TELEGRAM_ENABLED", "SCORECARD_ENABLED", "TV_ACK_DEADLINE_MS",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");
const cs = await import("../src/candidateShadow.js");
const sc = await import("../src/scorecard.js");

const SECRET = "cand-tg-test-secret";
const BRIDGE_ON = { FLOW_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://algo.example.test/flow", FLOW_BRIDGE_SECRET: "cand-tg-hmac" };
const TG_ON = { TELEGRAM_BOT_TOKEN: "test-bot-token", TELEGRAM_CHAT_ID: "123" };
const ACTIVE = "nifty:tv:active_trade";
const LATEST = "nifty:tv:latest_signal";
const ARCHIVE = "nifty:tv:signals:master_archive";
const SHADOW_HEAD = "🧪 *SHADOW CANDIDATE*";

const tick = () => new Promise((r) => setImmediate(r));

function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const ttl = {};
  const lists = {};
  const calls = [];
  return {
    store, ttl, lists, calls,
    async get(k) { calls.push(["get", k]); await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) {
      calls.push(["set", k]);
      await tick();
      if (opts.nx && k in store) return null; // check-and-set runs synchronously: atomic, like Redis
      store[k] = v;
      ttl[k] = opts.ex ?? null;
      return "OK";
    },
    async del(k) { calls.push(["del", k]); await tick(); if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { calls.push(["lpush", k]); (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim(k, a, b) { lists[k] = (lists[k] || []).slice(a, b + 1); return "OK"; },
    async lrange(k, a = 0, b = -1) { const l = lists[k] || []; return b === -1 ? l.slice(a) : l.slice(a, b + 1); },
    async expire(k, s) { ttl[k] = s; return 1; },
  };
}

function mockReqRes({ method = "POST", body = {} } = {}) {
  const req = { method, body: JSON.stringify(body), query: {}, headers: {} };
  const res = {
    statusCode: 200, body: null, writtenAt: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { this.body = d; this.writtenAt = performance.now(); return this; },
    send(d) { this.body = d; this.writtenAt = performance.now(); return this; },
    end() { return this; },
  };
  return { req, res };
}

const alert = (grade, dir, extra = {}) => ({
  secret: SECRET, sym: "NSE:NIFTY", tf: "15", dir, grade, close: 24960,
  sl: dir === "LONG" ? 24895 : 25025, cappedSl: dir === "LONG" ? 24895 : 25025, rDist: 65, t1Dist: 65, t2Dist: 130,
  futQuad: dir === "LONG" ? "LONG_BUILDUP" : "SHORT_BUILDUP",
  ...extra,
});

const snapOf = (pcr, quad, o = {}) => ({ snapshotAt: Date.now() - 20_000, snapshotSource: "poller", corridor: { deltaPCR: pcr, floorStrike: 24900, roofStrike: 25400 }, futures: { quadrant: quad }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" }, ...o });
const confirmSnap = () => snapOf(1.4, "LONG_BUILDUP");   // SYNERGY_BULL → EXECUTE_HIGH_CONVICTION_SYNERGY
const unconfirmSnap = () => snapOf(1.0, "LONG_BUILDUP"); // SYNERGY_BULL → EXECUTE_MODERATE_SYNERGY
const rejectSnap = () => snapOf(0.6, "SHORT_BUILDUP");   // SYNERGY_BULL → VETO_DIVERGENT_SYNERGY

let idSeq = 0;
/**
 * Webhook case with every outbound path stubbed and counted.
 * tg: "ok" | "fail" (sendText → false) | "throw" | "hang" (resolves only via release()).
 */
function hookCase({ env = {}, initial = {}, snap, tg = "ok", waitUntil = null } = {}, fn) {
  return async () => {
    const allEnv = { TV_WEBHOOK_SECRET: SECRET, ...TG_ON, ...env };
    const prev = {};
    for (const [k, v] of Object.entries(allEnv)) { prev[k] = process.env[k]; process.env[k] = v; }
    const redis = createFakeRedis({ ...(snap ? { "nifty:flow:latest": JSON.stringify(snap) } : {}), ...initial });
    const sent = [];
    const attempts = [];
    const bridgeCalls = [];
    const fetchCalls = [];
    let release = () => {};
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => { fetchCalls.push({ url: String(url), init }); return new Response("{}", { status: 200 }); };
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => true,
      refresh: async () => ({ ok: false, stage: "nse", error: "no refresh in tests" }),
      sendText: async (t) => {
        attempts.push({ text: t, at: performance.now(), candList: candList(redis).length, scEvents: scEvents(redis).length });
        if (tg === "throw") throw new Error("telegram exploded");
        if (tg === "fail") return false;
        if (tg === "hang") await new Promise((r) => { release = r; });
        sent.push(t);
        return true;
      },
      bridgeFetch: async (url, init) => { bridgeCalls.push({ url, init }); return new Response(JSON.stringify({ status: "accepted", reason: null, mode: "dry_run", orderRef: "ORD-1" }), { status: 200 }); },
      newTradeId: () => `ft-ctg-${++idSeq}`,
      ...(waitUntil ? { getWaitUntil: async () => waitUntil } : {}),
    });
    try {
      await fn({ redis, sent, attempts, bridgeCalls, fetchCalls, release: () => release() });
    } finally {
      globalThis.fetch = origFetch;
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
  await webhook.default(req, res);
  return res;
}
const today = () => webhook.getIstDateString();
const candList = (redis) => (redis.lists[cs.candidateListKey(today())] || []).map((x) => JSON.parse(x));
const scEvents = (redis) => Object.entries(redis.lists).filter(([k]) => k.startsWith("nifty:sc:events:")).flatMap(([, l]) => l.map((x) => (typeof x === "string" ? JSON.parse(x) : x)));
const dedupeKeys = (redis) => Object.keys(redis.store).filter((k) => k.startsWith(cs.CANDIDATE_TG_DEDUPE_PREFIX));

function assertNoOrderNoLock({ redis, bridgeCalls }) {
  assert.equal(bridgeCalls.length, 0, "no Algo dispatch");
  assert.equal(redis.store[ACTIVE], undefined, "no position lock");
  assert.equal(redis.calls.some(([, k]) => k === ACTIVE), false, "active-trade key never touched");
  assert.equal(redis.store[LATEST], undefined, "latest_signal untouched");
  assert.equal(redis.lists[`nifty:tv:signals:${today()}`], undefined, "daily signals list untouched");
  assert.equal(redis.lists[ARCHIVE], undefined, "master archive untouched");
}

// ─────────────────────────────────────────────────────────────────────────────
//  Message per category (pure formatter)
// ─────────────────────────────────────────────────────────────────────────────

// The first real candidate recorded in production (from the task brief), reasoning shortened.
const REAL_REC = {
  t: Date.parse("2026-11-17T05:12:05Z"), istTime: "10:42:05 am", chartTime: "10:42:05 am",
  grade: "SYNERGY_BULL_CAND", realGrade: "SYNERGY_BULL", direction: "LONG",
  entry: 25372.6, sl: 25289.97, t1: 25499.46, t2: 25606.03, category: "CONFIRMED",
  realDecision: "EXECUTE_HIGH_CONVICTION_SYNERGY", realReasoning: "HIGH CONVICTION BULL SYNERGY VERIFIED: put_writing *blitz* [x]",
  deltaPcr: 2.04, serverFutQuad: "LONG_BUILDUP", chartFutQuad: "LONG_BUILDUP", floor: 25300, roof: 25400, snapshotAgeSec: 18, shadowOnly: true,
};

const EXPECTED_FIRST_LINES = {
  CONFIRMED: "🧪 *SHADOW CANDIDATE* · CONFIRMED · `SYNERGY_BULL` (LONG) — no order placed",
  UNCONFIRMED: "🧪 *SHADOW CANDIDATE* · UNCONFIRMED · `SYNERGY_BULL` (LONG) — no order placed",
  REJECTED: "🧪 *SHADOW CANDIDATE* · REJECTED · `SYNERGY_BULL` (LONG) — no order placed",
  UNVERIFIABLE: "🧪 *SHADOW CANDIDATE* · UNVERIFIABLE · `SYNERGY_BULL` (LONG) — no order placed",
};

/** Legacy-Markdown sanity: outside code spans, `_` `[` `]` never appear and `*` is balanced. */
function assertMarkdownSafe(text) {
  const outside = text.replace(/`[^`\n]*`/g, "");
  assert.equal(/[_[\]]/.test(outside), false, `no stray _ [ ] outside code: ${outside}`);
  assert.equal((outside.match(/\*/g) || []).length % 2, 0, "balanced *");
  assert.equal((text.match(/`/g) || []).length % 2, 0, "balanced `");
}

test("message: CONFIRMED (the real recorded candidate) — first line, every field, closing line", () => {
  const txt = cs.formatCandidateTelegram(REAL_REC, { snapshotSource: "poller", maxAgeSec: 900 });
  const lines = txt.split("\n");
  assert.equal(lines[0], EXPECTED_FIRST_LINES.CONFIRMED);
  assert.ok(txt.includes("`SYNERGY_BULL_CAND`") && txt.includes("chart time 10:42:05 am"));
  assert.ok(txt.includes("entry 25372.6 · stop 25289.97 · T1 25499.46 · T2 25606.03"));
  assert.ok(txt.includes("Confirmed — the real option chain would have approved it: `EXECUTE_HIGH_CONVICTION_SYNERGY`."));
  assert.ok(txt.includes("ΔPCR 2.04 · floor 25300 · roof 25400"));
  assert.ok(txt.includes("scanner LONG BUILDUP · chart LONG BUILDUP"));
  assert.ok(txt.includes("*Snapshot:* poller, 18s old"));
  assert.equal(lines.at(-1), "Shadow only: not sent to the Algo; outcome will appear in the scorecard.");
  assert.ok(!/EXECUTE_TIER|BUY CE|BUY PE|lots?\b/i.test(lines[0]), "first line cannot be read as a trade");
  assertMarkdownSafe(txt);
});

test("message: UNCONFIRMED says what was missing from the stored reasoning", () => {
  const rec = { ...REAL_REC, category: "UNCONFIRMED", realDecision: "EXECUTE_MODERATE_SYNERGY", realReasoning: "MODERATE BULL SYNERGY: Option Chain is neutral/mixed (ΔPCR=1.00). Sized to 1 Lot." };
  const txt = cs.formatCandidateTelegram(rec, { snapshotSource: "poller" });
  assert.equal(txt.split("\n")[0], EXPECTED_FIRST_LINES.UNCONFIRMED);
  assert.ok(txt.includes("Unconfirmed — today's rules would let it through as `EXECUTE_MODERATE_SYNERGY`, but the option chain did not positively back it. Missing: MODERATE BULL SYNERGY: Option Chain is neutral/mixed (ΔPCR=1.00)."));
  assertMarkdownSafe(txt);
});

test("message: REJECTED names the veto and why", () => {
  const rec = { ...REAL_REC, category: "REJECTED", realDecision: "VETO_DIVERGENT_SYNERGY", realReasoning: "VETOED: chain shows Call_Writing resistance (ΔPCR=0.60)" };
  const txt = cs.formatCandidateTelegram(rec, {});
  assert.equal(txt.split("\n")[0], EXPECTED_FIRST_LINES.REJECTED);
  assert.ok(txt.includes("Rejected — the real option chain vetoes it: `VETO_DIVERGENT_SYNERGY`. Why: VETOED: chain shows Call Writing resistance"));
  assertMarkdownSafe(txt);
});

test("message: UNVERIFIABLE says plainly it could not judge — missing, stale, no ΔPCR", () => {
  const missing = cs.formatCandidateTelegram({ ...REAL_REC, category: "UNVERIFIABLE", snapshotAgeSec: null, deltaPcr: null }, { maxAgeSec: 900 });
  assert.equal(missing.split("\n")[0], EXPECTED_FIRST_LINES.UNVERIFIABLE);
  assert.ok(missing.includes("Could not judge — no live option-chain snapshot was available, so no verdict was possible"));
  assert.ok(missing.includes("*Snapshot:* none (missing)"));
  const stale = cs.formatCandidateTelegram({ ...REAL_REC, category: "UNVERIFIABLE", snapshotAgeSec: 2000 }, { snapshotSource: "poller", maxAgeSec: 900 });
  assert.ok(stale.includes("Could not judge — the option-chain snapshot was 2000s old (limit 900s)"));
  assert.ok(stale.includes("poller, 2000s old"));
  const noPcr = cs.formatCandidateTelegram({ ...REAL_REC, category: "UNVERIFIABLE", snapshotAgeSec: 30, deltaPcr: null }, { maxAgeSec: 900 });
  assert.ok(noPcr.includes("Could not judge — the snapshot had no ΔPCR"));
  assert.ok(noPcr.includes("ΔPCR —"));
  for (const t of [missing, stale, noPcr]) assertMarkdownSafe(t);
});

test("message: every category classifyCandidate can produce has a dedicated verdict line", () => {
  for (const c of cs.CANDIDATE_CATEGORIES) {
    const line = cs.describeCandidateCategory({ ...REAL_REC, category: c });
    assert.ok(/^(Confirmed|Unconfirmed|Rejected|Could not judge) — /.test(line), `${c}: ${line}`);
  }
  // An unknown future category still produces a safe, clearly-shadow message.
  const txt = cs.formatCandidateTelegram({ ...REAL_REC, category: "SOMETHING_NEW" });
  assert.ok(txt.startsWith(`${SHADOW_HEAD} · SOMETHING NEW · `));
  assertMarkdownSafe(txt);
});

test("message: trap grades and SHORT direction in the first line", () => {
  const rec = { ...REAL_REC, grade: "BULL_TRAP_SELL_CAND", realGrade: "BULL_TRAP_SELL", direction: "SHORT", realDecision: "EXECUTE_TIER1_SCOUT" };
  assert.equal(cs.formatCandidateTelegram(rec).split("\n")[0], "🧪 *SHADOW CANDIDATE* · CONFIRMED · `BULL_TRAP_SELL` (SHORT) — no order placed");
});

// ─────────────────────────────────────────────────────────────────────────────
//  Handler: one message per category, after the record, never an order
// ─────────────────────────────────────────────────────────────────────────────

for (const [name, snap, cat] of [
  ["CONFIRMED", confirmSnap, "CONFIRMED"],
  ["UNCONFIRMED", unconfirmSnap, "UNCONFIRMED"],
  ["REJECTED", rejectSnap, "REJECTED"],
  ["UNVERIFIABLE (missing snapshot)", null, "UNVERIFIABLE"],
  ["UNVERIFIABLE (stale snapshot)", () => snapOf(1.4, "LONG_BUILDUP", { snapshotAt: Date.now() - 2_000_000 }), "UNVERIFIABLE"],
]) {
  test(`handler ${name}: one shadow message, sent after the record and scorecard event, no order/lock`, hookCase({ env: BRIDGE_ON, snap: snap ? snap() : null }, async (ctx) => {
    const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.event, "CANDIDATE_SHADOW");
    assert.equal(res.body.category, cat);
    assert.equal(ctx.sent.length, 1, "exactly one Telegram");
    assert.equal(ctx.sent[0].split("\n")[0], EXPECTED_FIRST_LINES[cat]);
    assert.equal(ctx.attempts[0].candList, 1, "record already stored when the send started");
    assert.equal(ctx.attempts[0].scEvents, 1, "scorecard event already recorded when the send started");
    assert.ok(ctx.attempts[0].at >= res.writtenAt, "send started after the response was written");
    assert.equal(ctx.fetchCalls.length, 0, "no other Telegram sender / network call");
    assertNoOrderNoLock(ctx);
    assert.equal(dedupeKeys(ctx.redis).length, 1);
    assert.equal(ctx.redis.ttl[dedupeKeys(ctx.redis)[0]], cs.CANDIDATE_TG_DEDUPE_TTL_SEC);
    if (name.includes("missing")) assert.ok(ctx.sent[0].includes("no live option-chain snapshot was available"));
    if (name.includes("stale")) assert.ok(/snapshot was \d+s old \(limit 900s\)/.test(ctx.sent[0]));
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exactly once
// ─────────────────────────────────────────────────────────────────────────────

test("dedupe: concurrent identical deliveries send exactly one message (records are unchanged: both stored as today)", hookCase({ snap: confirmSnap() }, async (ctx) => {
  const [a, b, c] = await Promise.all([1, 2, 3].map(() => post(alert("SYNERGY_BULL_CAND", "LONG"))));
  for (const r of [a, b, c]) assert.equal(r.body.event, "CANDIDATE_SHADOW");
  assert.equal(ctx.sent.length, 1);
  assert.equal(ctx.attempts.length, 1, "the losers never even attempt a send");
  assert.equal(dedupeKeys(ctx.redis).length, 1);
  assert.equal(candList(ctx.redis).length, 3, "recording behaviour unchanged");
}));

test("dedupe: a later re-delivery sends nothing; a new bar (different close) and another grade each send once", hookCase({ snap: confirmSnap() }, async (ctx) => {
  await post(alert("SYNERGY_BULL_CAND", "LONG"));
  await post(alert("SYNERGY_BULL_CAND", "LONG"));
  assert.equal(ctx.sent.length, 1);
  await post(alert("SYNERGY_BULL_CAND", "LONG", { close: 24990 }));
  assert.equal(ctx.sent.length, 2);
  await post(alert("BEAR_TRAP_BUY_CAND", "LONG"));
  assert.equal(ctx.sent.length, 3);
}));

test("dedupe key: grade + chart time when the payload carries t; bar-field digest otherwise; date-scoped", () => {
  const k1 = cs.candidateTelegramDedupeKey({ istDate: "2026-11-17", grade: "synergy_bull_cand", payload: { t: "10:45" } });
  assert.equal(k1, "nifty:tv:candidate_tg:2026-11-17:SYNERGY_BULL_CAND:t=10:45");
  const p = alert("SYNERGY_BULL_CAND", "LONG");
  const k2 = cs.candidateTelegramDedupeKey({ istDate: "2026-11-17", grade: p.grade, payload: p });
  assert.equal(k2, cs.candidateTelegramDedupeKey({ istDate: "2026-11-17", grade: p.grade, payload: { ...p, secret: "other", score: 99 } }), "non-bar fields do not matter");
  assert.notEqual(k2, cs.candidateTelegramDedupeKey({ istDate: "2026-11-17", grade: p.grade, payload: { ...p, close: 24961 } }));
  assert.notEqual(k2, cs.candidateTelegramDedupeKey({ istDate: "2026-11-18", grade: p.grade, payload: p }));
  assert.notEqual(k2, cs.candidateTelegramDedupeKey({ istDate: "2026-11-17", grade: "SYNERGY_BEAR_CAND", payload: p }));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Switch
// ─────────────────────────────────────────────────────────────────────────────

test("isCandidateTelegramEnabled defaults on; false/0 turn it off", () => {
  assert.equal(cs.isCandidateTelegramEnabled({}), true);
  assert.equal(cs.isCandidateTelegramEnabled({ CANDIDATE_TELEGRAM_ENABLED: "true" }), true);
  for (const v of ["false", "0", "FALSE", " 0 "]) assert.equal(cs.isCandidateTelegramEnabled({ CANDIDATE_TELEGRAM_ENABLED: v }), false);
});

for (const v of ["false", "0"]) {
  test(`switch CANDIDATE_TELEGRAM_ENABLED=${v}: no message, no dedupe key, same response and same Redis calls as before`, async () => {
    let offCalls = null;
    let offBody = null;
    await hookCase({ env: { ...BRIDGE_ON, CANDIDATE_TELEGRAM_ENABLED: v }, snap: confirmSnap() }, async (ctx) => {
      const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
      offBody = res.body;
      offCalls = ctx.redis.calls.map((c) => c.join(" "));
      assert.equal(ctx.attempts.length, 0);
      assert.equal(dedupeKeys(ctx.redis).length, 0);
      assert.equal(ctx.redis.calls.some(([, k]) => String(k).startsWith(cs.CANDIDATE_TG_DEDUPE_PREFIX)), false);
      assertNoOrderNoLock(ctx);
    })();
    await hookCase({ env: BRIDGE_ON, snap: confirmSnap() }, async (ctx) => {
      const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
      assert.deepEqual(res.body, offBody, "response identical with the switch on and off");
      const onCalls = ctx.redis.calls.map((c) => c.join(" "));
      const norm = (l) => l.map((c) => c.replace(/:\d{10,}$/, ":<ms>")); // scorecard event ids carry the receipt ms
      assert.deepEqual(norm(onCalls.filter((c) => !c.includes(cs.CANDIDATE_TG_DEDUPE_PREFIX))), norm(offCalls), "only the dedupe claim is added when on");
      assert.equal(onCalls.filter((c) => c.includes(cs.CANDIDATE_TG_DEDUPE_PREFIX)).length, 1);
    })();
  });
}

test("switch off: the daily scorecard Telegram has no Candidates block", async () => {
  const doc = candidateDayDoc();
  assert.ok(!sc.formatDailyTelegram(doc, { candidates: false }).includes("Candidates"));
  const r = await finaliseWith(doc, { CANDIDATE_TELEGRAM_ENABLED: "false" });
  assert.equal(r.sent.length, 1);
  assert.ok(!r.sent[0].includes("Candidates"));
});

// ─────────────────────────────────────────────────────────────────────────────
//  Failure isolation
// ─────────────────────────────────────────────────────────────────────────────

for (const mode of ["fail", "throw"]) {
  test(`send ${mode}: response, stored verdict and scorecard event unchanged; claim kept, no retry on re-delivery`, async () => {
    let okRecord = null;
    await hookCase({ snap: confirmSnap() }, async (ctx) => {
      await post(alert("SYNERGY_BULL_CAND", "LONG"));
      okRecord = candList(ctx.redis)[0];
    })();
    await hookCase({ snap: confirmSnap(), tg: mode }, async (ctx) => {
      const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.event, "CANDIDATE_SHADOW");
      assert.equal(res.body.category, "CONFIRMED");
      const rec = candList(ctx.redis)[0];
      const strip = ({ t, timestamp, istTime, chartTime, snapshotAgeSec, ...r }) => r;
      assert.deepEqual(strip(rec), strip(okRecord), "stored verdict identical");
      assert.equal(scEvents(ctx.redis).length, 1);
      assert.equal(ctx.attempts.length, 1);
      await post(alert("SYNERGY_BULL_CAND", "LONG"));
      assert.equal(ctx.attempts.length, 1, "no retry");
      assertNoOrderNoLock(ctx);
    })();
  });
}

test("notifyCandidateVerdict: hung send times out (never throws); no store / failing claim skip the send", async () => {
  const rec = { ...REAL_REC };
  const hang = { sendText: () => new Promise(() => {}) };
  assert.equal(await webhook.notifyCandidateVerdict({ redis: createFakeRedis(), record: rec, payload: {}, istDate: "2026-11-17", deps: hang, timeoutMs: 30 }), "TIMEOUT");
  const calls = [];
  const deps = { sendText: async (t) => { calls.push(t); return true; } };
  assert.equal(await webhook.notifyCandidateVerdict({ redis: null, record: rec, payload: {}, istDate: "2026-11-17", deps }), "NO_STORE");
  const badRedis = { set: async () => { throw new Error("redis down"); } };
  assert.equal(await webhook.notifyCandidateVerdict({ redis: badRedis, record: rec, payload: {}, istDate: "2026-11-17", deps }), "CLAIM_FAILED");
  assert.equal(calls.length, 0);
  const r = createFakeRedis();
  assert.equal(await webhook.notifyCandidateVerdict({ redis: r, record: rec, payload: {}, istDate: "2026-11-17", deps }), "SENT");
  assert.equal(await webhook.notifyCandidateVerdict({ redis: r, record: rec, payload: {}, istDate: "2026-11-17", deps }), "DUPLICATE");
  assert.equal(calls.length, 1);
});

test("with a Vercel waitUntil: the send is registered there and the response is written while Telegram is still pending", async () => {
  const handed = [];
  await hookCase({ snap: confirmSnap(), tg: "hang", waitUntil: (p) => handed.push(p) }, async (ctx) => {
    const res = await post(alert("SYNERGY_BULL_CAND", "LONG"));
    assert.equal(res.body.event, "CANDIDATE_SHADOW", "answered");
    assert.equal(handed.length, 1, "send handed to waitUntil");
    await tick(); await tick(); await tick();
    assert.equal(ctx.attempts.length, 1, "send in flight");
    assert.equal(ctx.sent.length, 0, "…and still pending after the handler returned");
    ctx.release();
    assert.equal(await handed[0], "SENT");
    assert.equal(ctx.sent.length, 1);
  })();
});

// ─────────────────────────────────────────────────────────────────────────────
//  A simultaneous real signal is identical with the Telegram on, off and failing
// ─────────────────────────────────────────────────────────────────────────────

function realSummary(res, ctx) {
  const t = JSON.parse(ctx.redis.store[ACTIVE]);
  const fv = res.body.fusedVerdict;
  return {
    status: res.statusCode,
    decision: res.body.decision,
    recommendedLots: res.body.recommendedLots,
    verdict: { grade: fv.grade, direction: fv.direction, decision: fv.decision, entry: fv.entryPrice, sl: fv.stopLoss, t1: fv.target1Price, t2: fv.target2Price, reasoning: fv.reasoning },
    dispatches: ctx.bridgeCalls.length,
    dispatchedGrade: JSON.parse(ctx.bridgeCalls[0].init.body).grade,
    lock: { active: t.active, grade: t.grade, direction: t.direction, entryPrice: t.entryPrice, stopLoss: t.stopLoss, status: t.execution?.status },
    signalsListed: ctx.redis.lists[`nifty:tv:signals:${today()}`].length,
    archived: ctx.redis.lists[ARCHIVE].length,
    latestGrade: JSON.parse(ctx.redis.store[LATEST]).grade ?? null,
  };
}

test("real SYNERGY_BULL arriving together with a candidate: decision, order, lock and logs identical — Telegram on / off / failing / throwing", async () => {
  let baseline = null;
  await hookCase({ env: BRIDGE_ON, snap: confirmSnap() }, async (ctx) => {
    const r = await post(alert("SYNERGY_BULL", "LONG"));
    baseline = realSummary(r, ctx);
  })();
  assert.equal(baseline.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(baseline.dispatches, 1);

  for (const [label, env, tg, expectShadow] of [
    ["on", {}, "ok", 1],
    ["off", { CANDIDATE_TELEGRAM_ENABLED: "false" }, "ok", 0],
    ["failing", {}, "fail", 0],
    ["throwing", {}, "throw", 0],
  ]) {
    await hookCase({ env: { ...BRIDGE_ON, ...env }, snap: confirmSnap(), tg }, async (ctx) => {
      const [c, r] = await Promise.all([post(alert("SYNERGY_BULL_CAND", "LONG")), post(alert("SYNERGY_BULL", "LONG"))]);
      assert.equal(c.body.event, "CANDIDATE_SHADOW", label);
      assert.deepEqual(realSummary(r, ctx), baseline, `real signal identical (${label})`);
      const shadow = ctx.sent.filter((t) => t.startsWith(SHADOW_HEAD));
      assert.equal(shadow.length, expectShadow, `shadow messages (${label})`);
      assert.equal(ctx.bridgeCalls.every((b) => JSON.parse(b.init.body).grade === "SYNERGY_BULL"), true, "only the real grade was dispatched");
      assert.equal(candList(ctx.redis).length, 1);
    })();
  }
});

for (const [label, env, tg] of [["on", {}, "ok"], ["off", { CANDIDATE_TELEGRAM_ENABLED: "0" }, "ok"], ["failing", {}, "fail"]]) {
  test(`candidate alone with Telegram ${label}: no order, no lock, nothing in the live signal log`, hookCase({ env: { ...BRIDGE_ON, ...env }, snap: confirmSnap(), tg }, async (ctx) => {
    await post(alert("SYNERGY_BULL_CAND", "LONG"));
    await post(alert("BULL_TRAP_SELL_CAND", "SHORT"));
    assertNoOrderNoLock(ctx);
    assert.equal(ctx.fetchCalls.length, 0);
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Scorecard daily Telegram: "Candidates" block
// ─────────────────────────────────────────────────────────────────────────────

function candEvent(grade, dir, minutes, category, k) {
  const ev = sc.buildCandidateEvent({ grade, realGrade: cs.realGradeFor(grade), direction: dir, entry: 25000, sl: 24950, t1: 25080, t2: 25160, category, realDecision: "X" }, Date.parse("2026-11-13T03:45:00Z") + (minutes - 555) * 60000 + k);
  return ev;
}
function candidateDayDoc() {
  const evs = [
    candEvent("SYNERGY_BULL_CAND", "LONG", 600, "CONFIRMED", 1),
    candEvent("SYNERGY_BEAR_CAND", "SHORT", 640, "UNCONFIRMED", 2),
    candEvent("BEAR_TRAP_BUY_CAND", "LONG", 700, "REJECTED", 3),
    candEvent("BULL_TRAP_SELL_CAND", "SHORT", 760, "UNVERIFIABLE", 4),
  ];
  const outs = [
    { status: "MEASURED", first: "T1", at: "10:31", hit: true },
    { status: "MEASURED", first: "STOP", at: "11:02", hit: false },
    { status: "MEASURED", first: "NEITHER", at: null, hit: false },
    { status: "UNMEASURABLE", reason: "no futures/spot tick at the signal time" },
  ];
  return {
    date: "2026-11-13", dataQuality: { state: "OK", coveragePct: 100 },
    events: evs, outcomes: Object.fromEntries(evs.map((e, i) => [e.id, outs[i]])),
  };
}

test("scorecard line per outcome: T1 first / stop first / neither by the close / unmeasurable / not measured", () => {
  const doc = candidateDayDoc();
  const [a, b, c, d] = doc.events;
  assert.equal(cs.formatCandidateOutcomeLine(a, doc.outcomes[a.id]), "  – 10:00 `SYNERGY_BULL_CAND` LONG · CONFIRMED → T1 first (10:31)");
  assert.equal(cs.formatCandidateOutcomeLine(b, doc.outcomes[b.id]), "  – 10:40 `SYNERGY_BEAR_CAND` SHORT · UNCONFIRMED → stop first (11:02)");
  assert.equal(cs.formatCandidateOutcomeLine(c, doc.outcomes[c.id]), "  – 11:40 `BEAR_TRAP_BUY_CAND` LONG · REJECTED → neither by the close");
  assert.equal(cs.formatCandidateOutcomeLine(d, doc.outcomes[d.id]), "  – 12:40 `BULL_TRAP_SELL_CAND` SHORT · UNVERIFIABLE → unmeasurable: no futures/spot tick at the signal time");
  assert.equal(cs.formatCandidateOutcomeLine(a, undefined), "  – 10:00 `SYNERGY_BULL_CAND` LONG · CONFIRMED → not measured yet");
});

test("daily scorecard Telegram: Candidates heading + one line each, appended after the unchanged sections", () => {
  const doc = candidateDayDoc();
  const base = { ...doc, events: [], outcomes: {} };
  const txt = sc.formatDailyTelegram(doc);
  const lines = txt.split("\n");
  assert.equal(lines.slice(0, 2).join("\n"), sc.formatDailyTelegram(base));
  assert.equal(lines[2], "• *Candidates* (shadow, no orders): 4");
  assert.equal(lines.length, 7);
  assert.ok(lines[3].includes("T1 first") && lines[4].includes("stop first") && lines[5].includes("neither by the close") && lines[6].includes("unmeasurable"));
  assert.ok(!txt.includes("*Unmeasurable:*"), "candidates still never count in the Unmeasurable line");
  assertMarkdownSafe(txt);
});

test("daily scorecard Telegram: candidate lines capped, chronological", () => {
  const evs = Array.from({ length: 30 }, (_, i) => candEvent("SYNERGY_BULL_CAND", "LONG", 600 + i, "CONFIRMED", 30 - i));
  const doc = { date: "2026-11-13", dataQuality: { state: "OK", coveragePct: 100 }, events: [...evs].reverse(), outcomes: {} };
  const lines = sc.formatDailyTelegram(doc).split("\n").filter((l) => l.startsWith("  – "));
  assert.equal(lines.length, sc.SC_TG_MAX_CANDIDATE_LINES + 1);
  assert.ok(lines[0].startsWith("  – 10:00 "));
  assert.equal(lines.at(-1), "  – … 5 more (see the Scorecard tab)");
});

/** Runs finaliseDay with an in-memory store holding the doc's events; returns what was sent. */
async function finaliseWith(doc, env = {}) {
  const kv = {};
  const lists = { [sc.keys.events(doc.date)]: doc.events };
  const store = {
    async get(k) { return kv[k] ?? null; },
    async set(k, v) { kv[k] = v; return "OK"; },
    async setNx(k, v) { if (k in kv) return false; kv[k] = v; return true; },
    async del(k) { delete kv[k]; return 1; },
    async lrange(k) { return lists[k] || []; },
  };
  const ticks = [];
  for (let m = 555; m <= 940; m++) ticks.push({ t: Date.parse("2026-11-13T03:45:00Z") + (m - 555) * 60000, spot: 25000, futPrice: 25050 });
  const sent = [];
  const r = await sc.finaliseDay({
    store, date: doc.date, env,
    deps: { getTimeline: async () => ticks, settings: {}, now: () => Date.parse("2026-11-13T10:30:00Z"), send: async (t) => { sent.push(t); return true; } },
  });
  return { r, sent };
}

test("finaliseDay sends the Candidates block (outcomes computed by the unchanged SIGNAL rule) when the switch is on", async () => {
  const doc = candidateDayDoc();
  const { r, sent } = await finaliseWith(doc, {});
  assert.equal(r.status, "FINALISED", JSON.stringify(r));
  assert.equal(sent.length, 1);
  assert.ok(sent[0].includes("• *Candidates* (shadow, no orders): 4"));
  for (const ev of doc.events) {
    const out = r.doc.outcomes[ev.id];
    assert.deepEqual(out, sc.measureEvent(ev, r.doc.series), "outcome is exactly the scorecard's own measurement");
    assert.ok(sent[0].includes(cs.formatCandidateOutcomeLine(ev, out)));
  }
});

test("settings snapshot whitelists CANDIDATE_TELEGRAM_ENABLED", () => {
  assert.equal(sc.settingsSnapshot({ env: { CANDIDATE_TELEGRAM_ENABLED: "false" } }).envOverrides.CANDIDATE_TELEGRAM_ENABLED, "false");
});
