/**
 * Market calendar: weekends are closed unless the IST date is in the Muhurat date list.
 * Regression for Sunday 2026-11-15 (an ordinary Sunday treated as a Muhurat session: one tick,
 * "missed ticks" Telegram, and lazily finalised empty scorecard days for 14/15-Nov).
 * All I/O is injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "MUHURAT_DATES", "SCORECARD_ENABLED",
  "QSTASH_CURRENT_SIGNING_KEY", "QSTASH_NEXT_SIGNING_KEY", "FLOW_BLIND_ALERT_SEC",
]) delete process.env[k];

const cal = await import("../src/marketCalendar.js");
const { getMarketSessionInfo, calculateEODDecision } = await import("../api/nifty-oi.js");
const { createPollHandler } = await import("../api/poll.js");
const { createCollectorStatusHandler, isLiveAt } = await import("../api/collector-status.js");
const { getSessionOpenMs } = await import("../src/flowWatchdog.js");
const sc = await import("../src/scorecard.js");
const { createScorecardHandler } = await import("../api/scorecard.js");

const SECRET = "calendar-test-secret";
/** Epoch ms of an IST wall-clock time. */
const ist = (date, hhmm) => Date.parse(`${date}T${hhmm}:00+05:30`);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const tick = (m, fut = 25000) => ({ minutes: m, time: hm(m), futPrice: fut, spot: fut - 40, futCombinedOI: 200000, putWriting: 300000, callWriting: 300000, netDiff: 0, isLiveTick: true });

function withEnv(vars, fn) {
  const prev = {};
  for (const k of Object.keys(vars)) prev[k] = process.env[k];
  Object.assign(process.env, vars);
  try { return fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// ── calendar ──

test("calendar: Muhurat Sunday, ordinary weekend days and a weekday", () => {
  assert.equal(cal.getSessionKindForDate("2026-11-08"), "MUHURAT");
  assert.equal(cal.getSessionKindForDate("2026-11-15"), "CLOSED");
  assert.equal(cal.getSessionKindForDate("2026-11-14"), "CLOSED");
  assert.equal(cal.getSessionKindForDate("2026-11-13"), "WEEKDAY");
  assert.equal(cal.getSessionKind(ist("2026-11-15", "15:43")), "CLOSED");
  assert.equal(cal.getSessionKind(ist("2026-11-08", "14:30")), "MUHURAT");
  assert.equal(cal.isMuhuratDate("2026-11-08"), true);
  assert.equal(cal.isMuhuratDate("2026-11-15"), false);
  assert.equal(cal.isMuhuratTomorrow(ist("2026-11-07", "11:00")), true);
  assert.equal(cal.isMuhuratTomorrow(ist("2026-11-14", "11:00")), false);
  assert.deepEqual(cal.istParts(ist("2026-11-15", "15:43")), { date: "2026-11-15", minutes: 943, dow: 0 });
  // Calendar-gated day of week: 0 only on the Muhurat day, 6 on any closed weekend day.
  assert.equal(cal.getSessionDayOfWeek(ist("2026-11-08", "14:30")), 0);
  assert.equal(cal.getSessionDayOfWeek(ist("2026-11-15", "14:30")), 6);
  assert.equal(cal.getSessionDayOfWeek(ist("2026-11-14", "14:30")), 6);
  assert.equal(cal.getSessionDayOfWeek(ist("2026-11-13", "10:00")), 5);
});

test("calendar: MUHURAT_DATES adds dates; malformed entries are ignored", () => {
  withEnv({ MUHURAT_DATES: " 2027-10-31 ,bad,2026-02-30,2026-11-22x,, 2026/11/29 " }, () => {
    assert.equal(cal.getSessionKindForDate("2027-10-31"), "MUHURAT"); // a Sunday
    assert.equal(cal.getSessionKindForDate("2026-11-08"), "MUHURAT", "default date kept");
    assert.equal(cal.getSessionKindForDate("2026-11-22"), "CLOSED");
    assert.equal(cal.getSessionKindForDate("2026-11-29"), "CLOSED");
    assert.deepEqual(cal.getMuhuratDates(), ["2026-11-08", "2027-10-31"]);
  });
  assert.equal(cal.getSessionKindForDate("2027-10-31"), "CLOSED", "env removed → back to the default list");
  assert.deepEqual(cal.parseMuhuratDates(undefined), []);
});

// ── getMarketSessionInfo ──

test("getMarketSessionInfo: ordinary Sunday 2026-11-15 is a closed weekend day (14:30 and 15:43)", () => {
  for (const t of ["14:30", "15:43"]) {
    const s = getMarketSessionInfo(ist("2026-11-15", t));
    assert.equal(s.isLiveMarket, false, t);
    assert.equal(s.isPostMarketSettled, true);
    assert.equal(s.isSunday, false, "isSunday means 'the Muhurat session'");
    assert.equal(s.isSaturday, true, "isSaturday means 'weekend closed'");
    assert.equal(s.isMuhuratSession, false);
    assert.equal(s.isWeekendClosed, true);
    assert.equal(s.sessionKind, "CLOSED");
    assert.equal(s.tradingWindow, "Closed (Weekend)");
    assert.equal(s.nextOpenDescription, "Monday 09:15 IST");
  }
});

test("getMarketSessionInfo: Muhurat Sunday 2026-11-08 keeps the 14:00–16:00 session", () => {
  const live = getMarketSessionInfo(ist("2026-11-08", "14:30"));
  assert.equal(live.isLiveMarket, true);
  assert.equal(live.isSunday, true);
  assert.equal(live.isMuhuratSession, true);
  assert.equal(live.tradingWindow, "14:20 - 15:20 IST");
  const pre = getMarketSessionInfo(ist("2026-11-08", "13:00"));
  assert.equal(pre.isLiveMarket, false);
  assert.equal(pre.isPreMarket, true);
  assert.equal(pre.nextOpenDescription, "Opens Today 14:00 IST (Trading 14:20 - 15:20)");
  const after = getMarketSessionInfo(ist("2026-11-08", "16:30"));
  assert.equal(after.isLiveMarket, false);
  assert.equal(after.isPostMarketSettled, true);
});

test("getMarketSessionInfo: Friday 10:00 is live; Saturday wording mentions Muhurat only on its eve", () => {
  const fri = getMarketSessionInfo(ist("2026-11-13", "10:00"));
  assert.equal(fri.isLiveMarket, true);
  assert.equal(fri.isWeekday, true);
  assert.equal(fri.tradingWindow, "09:15 - 15:40 IST");
  assert.equal(fri.isSunday, false);
  assert.equal(fri.isSaturday, false);

  const sat = getMarketSessionInfo(ist("2026-11-14", "11:00"));
  assert.equal(sat.isLiveMarket, false);
  assert.equal(sat.isSaturday, true);
  assert.equal(sat.nextOpenDescription, "Monday 09:15 IST");
  assert.ok(!/Diwali|Muhurat/.test(sat.nextOpenDescription));

  const eve = getMarketSessionInfo(ist("2026-11-07", "11:00"));
  assert.equal(eve.isMuhuratTomorrow, true);
  assert.match(eve.nextOpenDescription, /Diwali Muhurat Tomorrow/);
});

test("calculateEODDecision: weekend-closed label has Diwali text only when tomorrow is a Muhurat date", () => {
  const base = { spot: 25000, floorStrike: 24900, roofStrike: 25100, totPutWriting: 200000, totCallWriting: 200000, pcr: 1, deltaPcr: 1, timeline: [], nowMins: 900 };
  const sunday = calculateEODDecision({ ...base, dayOfWeek: cal.getSessionDayOfWeek(ist("2026-11-15", "15:00")), muhuratTomorrow: false });
  assert.match(sunday.statusLabel, /^WEEKEND CLOSED · PREVIOUS SESSION SETTLED/);
  assert.ok(!/Diwali|Muhurat/.test(sunday.statusLabel));
  assert.equal(sunday.isSunday, false);
  assert.ok(!sunday.audit.some((a) => /Muhurat/.test(a.label)), "no Muhurat audit labels on an ordinary Sunday");
  const eve = calculateEODDecision({ ...base, dayOfWeek: 6, muhuratTomorrow: true });
  assert.match(eve.statusLabel, /Diwali Muhurat Tomorrow/);
  const muhurat = calculateEODDecision({ ...base, dayOfWeek: cal.getSessionDayOfWeek(ist("2026-11-08", "15:00")) });
  assert.equal(muhurat.isSunday, true);
  assert.match(muhurat.statusLabel, /DIWALI MUHURAT/);
});

// ── /api/poll ──

function pollHarness(nowMs) {
  const state = { refreshCalls: 0, sent: [], heartbeats: 0 };
  const handler = createPollHandler({
    now: () => nowMs,
    getMarketSessionInfo, // the real calendar-gated function, evaluated at deps.now()
    refresh: async (opts) => { state.refreshCalls++; return { ok: true, persisted: true, snapshotAt: opts.now, ticks: 1, payload: { spotPrice: 25000 } }; },
    getFlowSnapshot: async () => ({ snapshotAt: nowMs - 600_000 }),
    setHeartbeat: async () => { state.heartbeats++; return true; },
    setNx: async () => true,
    del: async () => 0,
    sendText: async (t) => { state.sent.push(t); return true; },
    qstashKeys: () => [],
    pushEvent: async () => {},
    setSourceStatus: async () => {},
  });
  return { handler, state };
}
async function callPoll(handler) {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; } };
  await handler({ method: "POST", headers: { "x-webhook-secret": SECRET, "x-poll-source": "github-actions" }, body: {}, query: {} }, res);
  return res;
}

test("poll: ordinary Sunday 15:43 IST → MARKET_CLOSED, no refresh, no Telegram, no heartbeat", async () => {
  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try {
    for (const t of ["14:30", "15:43"]) {
      const { handler, state } = pollHarness(ist("2026-11-15", t));
      const res = await callPoll(handler);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.status, "MARKET_CLOSED", t);
      assert.equal(res.body.nextOpen, "Monday 09:15 IST");
      assert.equal(state.refreshCalls, 0);
      assert.equal(state.sent.length, 0);
      assert.equal(state.heartbeats, 0);
    }
    // The genuine Muhurat session still polls.
    const { handler, state } = pollHarness(ist("2026-11-08", "14:30"));
    const res = await callPoll(handler);
    assert.equal(res.body.status, "LIVE_POLL_SUCCESS");
    assert.equal(state.refreshCalls, 1);
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
});

// ── collector-status, watchdog session open ──

test("collector-status: ordinary Sunday is not live and invents no gaps; Muhurat Sunday is live from 14:00", async () => {
  assert.equal(isLiveAt(cal.istParts(ist("2026-11-15", "14:30"))), false);
  assert.equal(isLiveAt(cal.istParts(ist("2026-11-08", "14:30"))), true);
  assert.equal(isLiveAt(cal.istParts(ist("2026-11-13", "10:00"))), true);
  assert.equal(isLiveAt(cal.istParts(ist("2026-11-14", "10:00"))), false);

  const prev = process.env.TV_WEBHOOK_SECRET;
  process.env.TV_WEBHOOK_SECRET = SECRET;
  try {
    const run = async (nowMs, snap) => {
      const h = createCollectorStatusHandler({ now: () => nowMs, get: async (k) => (k === "nifty:flow:latest" ? snap : null), lrange: async () => [] });
      const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
      await h({ method: "GET", query: {}, headers: { "x-webhook-secret": SECRET } }, res);
      return res.body;
    };
    // The 15:43 junk tick of 15-Nov is in the snapshot: still closed, no gaps, nothing expected.
    const sunNow = ist("2026-11-15", "15:45");
    const sun = await run(sunNow, { snapshotAt: ist("2026-11-15", "15:43"), intradayTimeline: [tick(943)] });
    assert.equal(sun.detail.isLiveSession, false);
    assert.equal(sun.state, "CLOSED");
    assert.deepEqual(sun.gaps, []);
    assert.equal(sun.expectedTicks, 0);
    assert.ok(!JSON.stringify(sun).includes("14:00"));

    const muhNow = ist("2026-11-08", "14:30");
    const muh = await run(muhNow, { snapshotAt: muhNow - 5000, intradayTimeline: Array.from({ length: 31 }, (_, i) => tick(840 + i)) });
    assert.equal(muh.detail.isLiveSession, true);
    assert.match(muh.detail.summary, /since 14:00/);
  } finally {
    if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev;
  }
});

test("flow watchdog: session open is 09:15 on an ordinary Sunday and 14:00 on the Muhurat date", () => {
  assert.equal(getSessionOpenMs(ist("2026-11-15", "15:43")), ist("2026-11-15", "09:15"));
  assert.equal(getSessionOpenMs(ist("2026-11-08", "14:30")), ist("2026-11-08", "14:00"));
  assert.equal(getSessionOpenMs(ist("2026-11-13", "10:00")), ist("2026-11-13", "09:15"));
});

// ── scorecard ──

function fakeStore() {
  const kv = {};
  const lists = {};
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  const writes = [];
  return {
    kv, lists, writes,
    get: async (k) => (k in kv ? clone(kv[k]) : null),
    set: async (k, v) => { writes.push(k); kv[k] = clone(v); return "OK"; },
    setNx: async (k, v) => { if (k in kv) return false; kv[k] = clone(v); return true; },
    del: async (k) => { delete kv[k]; delete lists[k]; return 1; },
    rpush: async (k, v) => { (lists[k] ||= []).push(clone(v)); return lists[k].length; },
    ltrim: async () => "OK",
    lrange: async (k) => clone(lists[k] || []),
    expire: async () => 1,
    incr: async (k, by = 1) => { kv[k] = (Number(kv[k]) || 0) + by; return kv[k]; },
    mget: async (ks) => ks.map((k) => (k in kv ? clone(kv[k]) : null)),
  };
}

test("scorecard finaliseDay: no ticks and no events → NO_SESSION, nothing stored, no Telegram, lock released", async () => {
  const sent = [];
  const deps = { getTimeline: async () => [], settings: {}, send: async (t) => { sent.push(t); return true; }, now: () => 0 };
  // A weekday with nothing recorded (exchange holiday).
  const store = fakeStore();
  const r = await sc.finaliseDay({ store, date: "2026-11-24", deps });
  assert.equal(r.status, "NO_SESSION");
  assert.equal(store.kv[sc.keys.day("2026-11-24")], undefined);
  assert.equal(store.kv[sc.keys.finLock("2026-11-24")], undefined, "finalise lock released");
  assert.equal(store.writes.length, 0);
  // Closed weekend days, even with a stray tick.
  for (const date of ["2026-11-14", "2026-11-15"]) {
    const s = fakeStore();
    const w = await sc.finaliseDay({ store: s, date, deps: { ...deps, getTimeline: async () => [tick(943)] } });
    assert.equal(w.status, "NO_SESSION", date);
    assert.equal(s.writes.length, 0);
  }
  assert.equal(sent.length, 0);
  // A real day is still finalised.
  const real = fakeStore();
  const ok = await sc.finaliseDay({ store: real, date: "2026-11-13", deps: { ...deps, getTimeline: async () => [tick(600), tick(601)] } });
  assert.equal(ok.status, "FINALISED");
  assert.equal(sent.length, 1);
});

test("scorecard API: ?date=2026-11-14 → noSession, no write, no Telegram; aggregate ignores empty / weekend docs", async () => {
  const store = fakeStore();
  const sent = [];
  // Junk documents written by the old lazy finalisation of 14/15-Nov.
  const junk = (date, ticks) => ({ v: 1, date, finalisedAt: "2026-11-15T10:00:00.000Z", series: { m: ticks ? [943] : [] }, events: [], outcomes: {}, eodFinal: null, dataQuality: { state: "BUILDING", coveragePct: 0, ticksToday: ticks, expectedTicks: 386, gaps: [] } });
  store.kv[sc.keys.day("2026-11-14")] = junk("2026-11-14", 0);
  store.kv[sc.keys.day("2026-11-15")] = junk("2026-11-15", 1);
  // Real days: a normal one, a backfilled one, and a low-coverage one with ticks but no events.
  const e = { id: "A", t: 0, minutes: 600, time: "10:00", section: "TURN", type: "EARLY", direction: "BULLISH", futPrice: 25000, data: {}, dq: { ok: true } };
  store.kv[sc.keys.day("2026-11-13")] = { v: 1, date: "2026-11-13", finalisedAt: "x", series: { m: [600] }, events: [e], outcomes: { A: { status: "MEASURED", hit: true } }, dataQuality: { state: "OK", coveragePct: 100 } };
  store.kv[sc.keys.day("2026-11-12")] = { v: 1, date: "2026-11-12", finalisedAt: "x", backfilled: true, series: { m: [600] }, events: [e], outcomes: {}, dataQuality: null };
  store.kv[sc.keys.day("2026-11-11")] = { v: 1, date: "2026-11-11", finalisedAt: "x", series: { m: [600, 601] }, events: [], outcomes: {}, dataQuality: { state: "GAPS", coveragePct: 1, ticksToday: 2 } };
  const writesBefore = store.writes.length;

  const h = createScorecardHandler({ store, now: () => ist("2026-11-15", "17:00"), getTimeline: async () => [], settings: () => ({}), send: async (t) => { sent.push(t); return true; } });
  const call = async (query) => {
    const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, send(d) { this.body = d; return this; }, end() { return this; } };
    await h({ method: "GET", query, headers: {} }, res);
    return res;
  };

  for (const date of ["2026-11-14", "2026-11-15"]) {
    const r = await call({ date });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.noSession, true, date);
    assert.equal(r.body.persisted, false);
    assert.deepEqual(r.body.events, []);
  }
  // A weekend date with no stored document is not finalised either.
  const fresh = fakeStore();
  const h2 = createScorecardHandler({ store: fresh, now: () => ist("2026-11-15", "17:00"), getTimeline: async () => [tick(943)], settings: () => ({}), send: async (t) => { sent.push(t); return true; } });
  const res2 = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } };
  await h2({ method: "GET", query: { date: "2026-11-15" }, headers: {} }, res2);
  assert.equal(res2.body.noSession, true);
  assert.equal(fresh.writes.length, 0);
  // A past weekday with no ticks and no events (holiday): noSession, nothing written.
  const hol = await call({ date: "2026-11-10" });
  assert.equal(hol.body.noSession, true);

  assert.equal(store.writes.length, writesBefore, "no document written");
  assert.equal(sent.length, 0, "no Telegram");

  const agg = await call({ days: "7" });
  assert.equal(agg.body.sessions, 3);
  assert.equal(agg.body.backfilledSessions, 1);
  assert.deepEqual(agg.body.datesWithData.map((d) => d.date), ["2026-11-13", "2026-11-12", "2026-11-11"]);
  assert.equal(sc.isEmptyDayDoc(junk("2026-11-14", 0)), true);
  assert.equal(sc.isSessionDayDoc(store.kv[sc.keys.day("2026-11-11")]), true, "low-coverage real session counts");
});
