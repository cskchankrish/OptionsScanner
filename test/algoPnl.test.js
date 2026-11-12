/**
 * Algo-reported rupee P&L on exits: parsing, Telegram, status GET, archive/CSV, carry history,
 * and the rule that index points are never presented as the owner's P&L for Algo-owned trades.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_BRIDGE_ENABLED", "CARRY_BRIDGE_ENABLED",
]) delete process.env[k];

const pnl = await import("../src/algoPnl.js");
const webhook = await import("../api/tv-webhook.js");
const carry = await import("../src/carryBridge.js");

const SECRET = "pnl-test-secret";
const KEY = "nifty:tv:active_trade";
const tick = () => new Promise((r) => setImmediate(r));

function fakeRedis(initial = {}) {
  const store = { ...initial };
  const lists = {};
  return {
    store, lists,
    async get(k) { await tick(); return store[k] ?? null; },
    async set(k, v, opts = {}) { await tick(); if (opts.nx && k in store) return null; store[k] = v; return "OK"; },
    async del(k) { await tick(); if (k in store) { delete store[k]; return 1; } return 0; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
}
const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } });

function hook(initial, fn) {
  return async () => {
    const prev = process.env.TV_WEBHOOK_SECRET;
    process.env.TV_WEBHOOK_SECRET = SECRET;
    const redis = fakeRedis(initial);
    const sent = [];
    webhook.setRedisClientForTesting(redis);
    webhook.setWebhookDepsForTesting({
      now: () => Date.now(),
      isLiveMarket: async () => false,
      refresh: async () => ({ ok: false }),
      sendText: async (t) => { sent.push(t); return true; },
    });
    try {
      await fn({ redis, sent });
    } finally {
      webhook.setRedisClientForTesting(null);
      webhook.setWebhookDepsForTesting(null);
      if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
    }
  };
}
async function post(body) {
  const res = mkRes();
  await webhook.default({ method: "POST", body: JSON.stringify(body), query: {}, headers: {} }, res);
  return res;
}
async function get(query) {
  const res = mkRes();
  await webhook.default({ method: "GET", body: undefined, query, headers: {} }, res);
  return res;
}

const algoTrade = (extra = {}) => JSON.stringify({
  active: true, id: "ft-real-1", grade: "BULL_TRAP_SELL", direction: "SHORT", timeframe: "15",
  entryPrice: 25010.4, stopLoss: 25080, riskPoints: 70, target1Price: 24940, target2Price: 24870,
  target1Dist: 70, target2Dist: 140, execution: { status: "FILLED", mode: "live" }, ...extra,
});
const paperTrade = () => JSON.stringify({
  active: true, id: "ft-paper-1", grade: "BULL_TRAP_SELL", direction: "SHORT", timeframe: "15",
  entryPrice: 25010.4, stopLoss: 25080, riskPoints: 70, target1Price: 24940, target2Price: 24870, target1Dist: 70, target2Dist: 140,
});
const fullFields = {
  pnlInr: 1070, pnlKnown: true, entryFill: 112.4, exitFill: 126.7, qty: 75,
  accounts: [{ account: "ACC-A", grade: "BULL_TRAP_SELL", lots: 1, qty: 75, entryFill: 112.4, exitFill: 126.7, pnlInr: 1070, exitFillSource: "broker_tradebook" }],
};
const exitBody = (extra = {}) => ({ secret: SECRET, grade: "TIME_STOP_EXIT", tradeId: "ft-real-1", source: "algo", spot: 25016.25, optionFill: 126.7, lots: 1, mode: "live", t: 1, ...extra });

// ── Parsing ──

test("parseAlgoPnl: absent fields (older Algo) -> null", () => {
  assert.equal(pnl.parseAlgoPnl({ grade: "STOP_LOSS_HIT", spot: 1 }), null);
  assert.equal(pnl.parseAlgoPnl({ accounts: [{ account: "A", pnl: 5 }] }), null, "old free-form carry accounts are not P&L fields");
});

test("parseAlgoPnl: valid fields kept", () => {
  const p = pnl.parseAlgoPnl(fullFields);
  assert.equal(p.reported, true);
  assert.deepEqual([p.pnlInr, p.pnlKnown, p.entryFill, p.exitFill, p.qty], [1070, true, 112.4, 126.7, 75]);
  assert.deepEqual(p.accounts[0], fullFields.accounts[0]);
});

test("parseAlgoPnl: malformed pieces are ignored, never fatal", () => {
  const p = pnl.parseAlgoPnl({
    pnlInr: "1070", pnlKnown: "yes", entryFill: NaN, exitFill: null, qty: "75",
    accounts: [null, 5, "x", { account: "B", lots: "1", qty: 75, entryFill: 100, exitFill: "?", pnlInr: Infinity, exitFillSource: "magic" }],
  });
  assert.equal(p.reported, false);
  assert.deepEqual([p.pnlInr, p.pnlKnown, p.entryFill, p.exitFill, p.qty], [null, null, null, null, null]);
  assert.equal(p.accounts.length, 1);
  assert.deepEqual(p.accounts[0], { account: "B", grade: null, lots: null, qty: 75, entryFill: 100, exitFill: null, pnlInr: null, exitFillSource: null });
  assert.equal(pnl.parseAlgoPnl({ pnlInr: 5, accounts: "nope" }).accounts.length, 0);
});

test("formatInr: sign and en-IN grouping", () => {
  assert.equal(pnl.formatInr(1070), "+₹1,070.00");
  assert.equal(pnl.formatInr(-123456.5), "-₹1,23,456.50");
  assert.equal(pnl.formatInr(0), "+₹0.00");
});

test("pnlContribution never mixes units", () => {
  assert.deepEqual(pnl.pnlContribution({ algoOwned: true, algoPnl: { reported: true, pnlInr: 1070, pnlKnown: true } }), { unit: "INR", value: 1070 });
  assert.deepEqual(pnl.pnlContribution({ algoOwned: true, algoPnl: { reported: true, pnlInr: 900, pnlKnown: false } }), { unit: null, value: null });
  assert.deepEqual(pnl.pnlContribution({ algoOwned: true, algoPnl: null, netPnl: -5.85 }), { unit: null, value: null });
  assert.deepEqual(pnl.pnlContribution({ algoOwned: false, netPnl: -5.85 }), { unit: "INDEX_POINTS", value: -5.85 });
});

// ── Flow exits ──

test("Algo-owned exit with ₹ fields: Telegram leads with ₹, per-account line, index move labelled not-P&L", hook({ [KEY]: algoTrade() }, async ({ redis }) => {
  const r = await post(exitBody(fullFields));
  assert.equal(r.statusCode, 200);
  const rec = r.body.exitRecord;
  assert.equal(rec.algoOwned, true);
  assert.equal(rec.pnlBasis, "ALGO_INR");
  assert.equal(rec.netPnl, null, "no points figure posing as P&L");
  assert.equal(rec.pnlInr, 1070);
  assert.equal(rec.pnlKnown, true);
  assert.equal(rec.indexMovePts, -5.85);
  const text = webhook.formatExitAlert(rec);
  const lines = text.split("\n");
  assert.match(lines[1], /Result: \+₹1,070\.00/, "₹ result is the first line after the header");
  assert.match(text, /`ACC-A`: 1 lot · 112\.4 → 126\.7 · \*\+₹1,070\.00\* · exit price from broker trade book/);
  assert.match(text, /Index move, signal entry to exit \(not your P&L\):\* `-5\.85 pts`/);
  assert.ok(!/Net Realized PnL|Paper result/.test(text));
  const archived = JSON.parse(redis.lists["nifty:tv:signals:master_archive"][0]);
  assert.equal(archived.pnlInr, 1070);
  assert.deepEqual(archived.algoPnl.accounts[0].exitFillSource, "broker_tradebook");
}));

test("Algo-owned exit with pnlKnown=false: total flagged as excluding unknown-exit accounts", hook({ [KEY]: algoTrade() }, async () => {
  const r = await post(exitBody({
    pnlInr: 640, pnlKnown: false, qty: 150,
    accounts: [
      { account: "ACC-A", lots: 1, qty: 75, entryFill: 112.4, exitFill: 120.9, pnlInr: 640, exitFillSource: "engine_order" },
      { account: "ACC-B", lots: 1, qty: 75, entryFill: 112.6, exitFill: null, pnlInr: null, exitFillSource: "unknown" },
    ],
  }));
  const text = webhook.formatExitAlert(r.body.exitRecord);
  assert.match(text, /Result: \+₹640\.00/);
  assert.match(text, /total excludes the accounts whose exit price is unknown/);
  assert.match(text, /`ACC-B`: 1 lot · 112\.6 → \? · \*₹ n\/a\* · exit price unknown/);
  assert.ok(!/ACC-A.*exit price unknown/.test(text));
}));

test("Algo-owned exit from an older Algo (no fields): '₹ P&L not reported', never points as P&L", hook({ [KEY]: algoTrade() }, async () => {
  const r = await post(exitBody());
  const rec = r.body.exitRecord;
  assert.equal(rec.algoPnl, null);
  assert.equal(rec.pnlInr, null);
  assert.equal(rec.netPnl, null);
  const text = webhook.formatExitAlert(rec);
  assert.match(text.split("\n")[1], /₹ P&L not reported by the Algo/);
  assert.ok(!/Net Realized PnL|Paper result/.test(text));
  assert.match(text, /not your P&L/);
}));

test("malformed ₹ fields never reject the exit", hook({ [KEY]: algoTrade() }, async ({ redis }) => {
  const r = await post(exitBody({ pnlInr: "lots", pnlKnown: 1, accounts: [7, null] }));
  assert.equal(r.statusCode, 200);
  assert.equal(redis.store[KEY], undefined, "trade closed");
  assert.match(webhook.formatExitAlert(r.body.exitRecord), /₹ P&L not reported by the Algo/);
}));

test("paper exit keeps the points message, relabelled 'paper result in index points'", hook({ [KEY]: paperTrade() }, async () => {
  const r = await post({ secret: SECRET, grade: "STOP_LOSS_HIT", close: 25080, ...fullFields });
  const rec = r.body.exitRecord;
  assert.equal(rec.algoOwned, false);
  assert.equal(rec.pnlBasis, "PAPER_INDEX_POINTS");
  assert.equal(rec.algoPnl, null, "₹ fields ignored on a paper trade");
  assert.equal(rec.netPnl, -73.6);
  const text = webhook.formatExitAlert(rec);
  assert.match(text, /Paper result in index points:\* `-73\.6 pts`/);
  assert.ok(!/₹/.test(text));
}));

test("paper auto-lifecycle exit is labelled paper too", async () => {
  const redis = fakeRedis({ [KEY]: paperTrade() });
  const r = await webhook.evaluateActiveTradeLifecycle(25090, 25090, 25090, redis);
  assert.equal(r.exitRecord.pnlBasis, "PAPER_INDEX_POINTS");
  assert.match(webhook.formatExitAlert(r.exitRecord), /Paper result in index points/);
  assert.equal(webhook.summarizeExitResult(JSON.parse(redis.store[webhook.LAST_EXIT_KEY])).headline, "-74 pts (paper result in index points)");
});

test("Algo-owned T1 record carries no points P&L", hook({ [KEY]: algoTrade() }, async () => {
  const r = await post(exitBody({ grade: "TARGET_1_HIT", spot: 24940 }));
  assert.equal(r.body.record.netPnl, null);
  assert.equal(r.body.record.pnlBasis, "ALGO_INR");
}));

test("status GET leads with the ₹ result of the last closed Algo trade", hook({ [KEY]: algoTrade() }, async () => {
  await post(exitBody(fullFields));
  const s = await get({ status: "1" });
  assert.equal(Object.keys(s.body)[0], "lastResult");
  const lr = s.body.lastResult;
  assert.equal(lr.headline, "+₹1,070.00");
  assert.equal(lr.basis, "ALGO_INR");
  assert.equal(lr.pnlInr, 1070);
  assert.equal(lr.pnlKnown, true);
  assert.equal(lr.paperIndexPts, null);
  assert.equal(lr.indexMovePtsNotPnl, -5.85);
  assert.equal(lr.accounts[0].account, "ACC-A");
  assert.equal(lr.tradeId, "ft-real-1");
  const plain = await get({});
  assert.equal(Object.keys(plain.body)[0], "lastResult");
}));

test("status GET: incomplete and unreported headlines", hook({ [KEY]: algoTrade() }, async ({ redis }) => {
  await post(exitBody({ pnlInr: 640, pnlKnown: false }));
  assert.match((await get({ status: "1" })).body.lastResult.headline, /^\+₹640\.00 \(incomplete/);
  redis.store[KEY] = algoTrade();
  await post(exitBody());
  assert.equal((await get({ status: "1" })).body.lastResult.headline, "₹ P&L not reported by the Algo");
}));

test("CSV: NetPnL holds paper points only; Algo rows carry PnlInr/PnlKnown/fills/accounts", hook({ [KEY]: algoTrade() }, async ({ redis }) => {
  await post(exitBody(fullFields));
  redis.store[KEY] = paperTrade();
  await post({ secret: SECRET, grade: "STOP_LOSS_HIT", close: 25080 });
  const csv = (await get({ export: "csv" })).body;
  const [header, ...rows] = csv.split("\n");
  const cols = header.split(",");
  for (const c of ["PnlBasis", "PnlInr", "PnlKnown", "EntryFill", "ExitFill", "Qty", "IndexMovePtsNotPnl", "Accounts"]) assert.ok(cols.includes(c), c);
  const algoRow = rows.find((r) => r.includes("ALGO_INR"));
  const paperRow = rows.find((r) => r.includes("PAPER_INDEX_POINTS"));
  assert.match(algoRow, /,ALGO_INR,1070,true,112\.4,126\.7,75,-5\.85,"ACC-A:1070\(broker_tradebook\)"$/);
  assert.match(algoRow, /,25016\.25,,/, "NetPnL empty right after ExitPrice for the Algo row");
  assert.match(paperRow, /,25080,-73\.6,/);
  assert.match(paperRow, /,PAPER_INDEX_POINTS,,,,,,,""$/);
}));

// ── Carry ──

const CK = carry.CARRY_ACTIVE_KEY;
const openCarry = () => JSON.stringify({
  id: "ct-9", date: "2026-11-12", verdict: "STBT", dir: "SHORT", spot: 24000, sl: 24100, lots: 1,
  execution: { status: "FILLED", contract: "NIFTY17NOV2624000PE", optionFill: 101.6 },
});
const carryExit = (extra = {}) => ({ secret: SECRET, grade: "CARRY_EXIT", tradeId: "ct-9", source: "algo", reason: "MORNING_EXIT", spot: 23890, optionFill: 130.2, lots: 1, mode: "live", t: 2, ...extra });

test("CARRY_EXIT with ₹ fields: Telegram leads with ₹; history stores pnlInr/pnlKnown", hook({ [CK]: openCarry() }, async ({ redis, sent }) => {
  const r = await post(carryExit({
    pnlInr: 2142.5, pnlKnown: true, entryFill: 101.6, exitFill: 130.2, qty: 75,
    accounts: [{ account: "ACC-A", lots: 1, qty: 75, entryFill: 101.6, exitFill: 130.2, pnlInr: 2142.5, exitFillSource: "engine_order" }],
  }));
  assert.equal(r.statusCode, 200);
  const rec = JSON.parse(redis.lists[carry.CARRY_HISTORY_KEY][0]);
  assert.equal(rec.pnlInr, 2142.5);
  assert.equal(rec.pnlKnown, true);
  assert.equal(rec.pnlBasis, "ALGO_INR");
  assert.equal(rec.indexMovePts, 110);
  const lines = sent[0].split("\n");
  assert.match(lines[1], /Result: \+₹2,142\.50/);
  assert.match(sent[0], /`ACC-A`: 1 lot · 101\.6 → 130\.2 · \*\+₹2,142\.50\*/);
  assert.match(sent[0], /Index move, reference to exit \(not your P&L\):\* `\+110 pts`/);
}));

test("CARRY_EXIT from an older Algo: '₹ P&L not reported', history pnlInr null", hook({ [CK]: openCarry() }, async ({ redis, sent }) => {
  await post(carryExit({ accounts: [{ account: "ACC-A", pnl: 9 }] }));
  const rec = JSON.parse(redis.lists[carry.CARRY_HISTORY_KEY][0]);
  assert.equal(rec.pnlInr, null);
  assert.equal(rec.pnlKnown, null);
  assert.match(sent[0].split("\n")[1], /₹ P&L not reported by the Algo/);
}));
