import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL", "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) delete process.env[k];

const { evaluateDayOverrides, aggregateOverrides, formatOverrideLines, normaliseOutsideTrade, minutesOf } = await import("../src/overrideCost.js");
const sc = await import("../src/scorecard.js");
const { createScorecardHandler } = await import("../api/scorecard.js");

// Futures rise 1 point a minute from 25220 at 09:45 (spot = futures − 20).
function series() {
  const m = [], f = [], s = [], v = [];
  for (let x = 555; x <= 936; x++) { m.push(x); const fut = 25220 + (x - 585); f.push(fut); s.push(fut - 20); v.push(1000 * (x - 554)); }
  return { m, f, s, v };
}
const signal = { id: "SIGNAL:BEAR_TRAP_BUY:585:1", time: "09:45", minutes: 585, section: "SIGNAL", type: "BEAR_TRAP_BUY", direction: "BULLISH", spot: 25200,
  data: { grade: "BEAR_TRAP_BUY", category: "APPROVED", tradeId: "ft-1", entry: 25200, sl: 25100, t1: 25300, t2: 25400 } };
const close = (extra = {}) => ({ id: "TRADE:FLOW:ft-1:MANUAL_CLOSE", time: "09:47", minutes: 587, section: "TRADE", type: "FLOW", direction: "BULLISH", spot: 25202,
  data: { kind: "FLOW", tradeId: "ft-1", exitGrade: "MANUAL_CLOSE", entry: 25200, exitPrice: 25202, pnlInr: 500.5, pnlKnown: true, accounts: 2, ...extra } });
const doc = (events) => ({ date: "2026-11-19", series: series(), events });
const OUT = [{ direction: "SHORT", entryTime: "14:00", exitTime: "15:10", pnlInr: -3200, instrument: "25400 PE", note: "rejection candle" }];

test("manual close: scored against the same position left to the Algo's rules", () => {
  const r = evaluateDayOverrides(doc([signal, close()]), [], { authed: true });
  const [x] = r.rows;
  assert.equal(x.kind, "MANUAL_CLOSE");
  assert.equal(x.status, "MEASURED");
  assert.equal(x.you.pts, 2);
  assert.equal(x.system.reason, "T2");
  assert.equal(x.system.exit, "13:05");
  assert.equal(x.system.pts, 200);
  assert.equal(x.costPts, 198, "system minus you");
  assert.equal(x.minutesEarly, 198);
  assert.equal(x.qty, 130, "2 accounts × 65 when the Algo sent no quantity");
  assert.equal(x.costInrEst, 12870, "198 × 130 × 0.5");
  assert.equal(x.youInr, 500.5);
  assert.equal(x.systemInrEst, 13371);
  assert.equal(r.totals.manualClosePts, 198);
});

test("quantity sent by the Algo is used; a close converted to the carry is not an override", () => {
  assert.equal(evaluateDayOverrides(doc([signal, close({ qty: 65 })]), [], { authed: true }).rows[0].costInrEst, 6435);
  assert.equal(evaluateDayOverrides(doc([signal, close({ closeReason: "converted to carry" })])).rows.length, 0);
  const carry = { ...close(), id: "TRADE:CARRY:ft-1:X", data: { kind: "CARRY", tradeId: "ft-1", exitGrade: "CARRY_EXIT" } };
  assert.equal(evaluateDayOverrides(doc([signal, close(), carry])).rows.length, 0);
  // Algo exits by its own rules are not overrides
  assert.equal(evaluateDayOverrides(doc([signal, close({ exitGrade: "TARGET_2_HIT" })])).rows.length, 0);
});

test("outside trade: the system's answer is no trade; against the last signal is flagged", () => {
  const r = evaluateDayOverrides(doc([signal, close()]), OUT, { authed: true });
  const o = r.rows.find((x) => x.kind === "OUTSIDE");
  assert.equal(o.againstSystem, true);
  assert.equal(o.lastSignal, "09:45 BEAR_TRAP_BUY BULLISH");
  assert.equal(o.futPts, -70);
  assert.equal(o.costInr, 3200);
  assert.equal(r.totals.outsideInr, 3200);
  assert.equal(r.totals.totalInrEst, 12870 + 3200);
});

test("public view: points only, no rupees anywhere", () => {
  const r = evaluateDayOverrides(doc([signal, close()]), OUT, { authed: false });
  const json = JSON.stringify(r);
  assert.ok(!/Inr/.test(json), json);
  assert.equal(r.rows[0].costPts, 198);
});

test("unmeasurable when the signal is missing; validation of logged trades", () => {
  assert.equal(evaluateDayOverrides(doc([close()])).rows[0].status, "UNMEASURABLE");
  assert.equal(normaliseOutsideTrade({ direction: "UP", entryTime: "14:00", pnlInr: 1 }).ok, false);
  assert.equal(normaliseOutsideTrade({ direction: "SHORT", entryTime: "2pm", pnlInr: 1 }).ok, false);
  assert.equal(normaliseOutsideTrade({ direction: "SHORT", entryTime: "14:00", exitTime: "13:00", pnlInr: 1 }).ok, false);
  assert.equal(normaliseOutsideTrade({ direction: "SHORT", entryTime: "14:00" }).ok, false);
  assert.equal(normaliseOutsideTrade({ direction: "short", entryTime: "9:30", pnlInr: "-100" }).trade.entryTime, "09:30");
  assert.equal(minutesOf("15:36"), 936);
});

test("rolling running total and the Telegram lines", () => {
  const a = evaluateDayOverrides(doc([signal, close()]), OUT, { authed: true });
  const b = { ...evaluateDayOverrides({ date: "2026-11-20", series: series(), events: [] }, [], { authed: true }) };
  const agg = aggregateOverrides([b, a]);
  assert.equal(agg.sessions, 2);
  assert.equal(agg.sessionsWithOverride, 1);
  assert.equal(agg.perDay[0].date, "2026-11-19");
  assert.equal(agg.perDay[1].runningInrEst, 16070);
  assert.equal(agg.totalInrEst, 16070);
  const lines = formatOverrideLines(a).join("\n");
  assert.match(lines, /Override cost/);
  assert.match(lines, /₹16,070/);
  assert.match(lines, /against the last signal/);
  assert.deepEqual(formatOverrideLines(b), []);
  const tg = sc.formatDailyTelegram({ ...doc([signal, close()]), outcomes: {} }, { outside: OUT });
  assert.match(tg, /Override cost/);
});

test("trade events carry the quantity and the close reason", () => {
  const e = sc.buildTradeEvent({ kind: "FLOW", tradeId: "ft-9", exitGrade: "MANUAL_CLOSE", direction: "LONG", entry: 1, exitPrice: 2, pnlInr: 1, pnlKnown: true, accountsCount: 2, qty: 130, closeReason: "converted to carry", nowMs: 0 });
  assert.equal(e.data.qty, 130);
  assert.equal(e.data.closeReason, "converted to carry");
  assert.equal(sc.buildTradeEvent({ kind: "FLOW", tradeId: "x", exitGrade: "T", nowMs: 0 }).data.qty, undefined);
});

// ── API ──
function store() {
  const kv = {};
  return {
    kv,
    get: async (k) => kv[k] ?? null,
    set: async (k, v) => { kv[k] = JSON.parse(JSON.stringify(v)); return true; },
    mget: async (ks) => ks.map((k) => kv[k] ?? null),
    lrange: async () => [],
    setNx: async (k) => (kv[k] ? false : ((kv[k] = 1), true)),
    del: async (k) => { delete kv[k]; return 1; },
  };
}
const res = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } });

test("API: logging an outside trade needs the secret; the day view shows overrides (rupees only when authenticated)", async () => {
  const SECRET = "oc-secret";
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try {
    const s = store();
    s.kv[sc.keys.day("2026-11-19")] = { v: 1, date: "2026-11-19", finalisedAt: "x", ...doc([signal, close()]), outcomes: {}, dataQuality: { state: "OK", coveragePct: 100 } };
    const h = createScorecardHandler({ store: s, now: () => Date.UTC(2026, 10, 19, 12, 0), getTimeline: async () => [], settings: () => ({}), send: async () => true });
    const post = async (body, headers = {}) => { const r = res(); await h({ method: "POST", query: {}, headers, body }, r); return r; };
    assert.equal((await post({ action: "outside_trade", date: "2026-11-19", trade: OUT[0] })).statusCode, 401);
    const bad = await post({ action: "outside_trade", date: "2026-11-19", trade: { direction: "SHORT" } }, { "x-webhook-secret": SECRET });
    assert.equal(bad.statusCode, 400);
    const ok = await post({ action: "outside_trade", date: "2026-11-19", trade: OUT[0] }, { "x-webhook-secret": SECRET });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.trades.length, 1);
    const get = async (query) => { const r = res(); await h({ method: "GET", query, headers: {} }, r); return r.body; };
    const pub = await get({ date: "2026-11-19" });
    assert.equal(pub.overrides.rows.length, 2);
    assert.ok(!/Inr/.test(JSON.stringify(pub.overrides)));
    const auth = await get({ date: "2026-11-19", key: SECRET });
    assert.equal(auth.overrides.totals.totalInrEst, 16070);
    const agg = await get({ days: "5", key: SECRET });
    assert.equal(agg.overrides.totalInrEst, 16070);
    const del = await post({ action: "outside_trade_delete", date: "2026-11-19", id: ok.body.logged.id }, { "x-webhook-secret": SECRET });
    assert.equal(del.body.removed, 1);
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
});
