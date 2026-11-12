/**
 * 12-Nov-2026 data-quality work (Part 1): coverage maths, per-window gating, collector alerts,
 * multi-poller /api/poll, /api/collector-status, carry refusal on UNVERIFIED groups.
 * All I/O injected — no network.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "POLL_MIN_INTERVAL_SEC", "POLLER_DOWN_ALERT_SEC",
]) delete process.env[k];

const dq = await import("../src/dataQuality.js");
const alerts = await import("../src/collectorAlerts.js");
const { calculateEODDecision, detectMacroTurn, describeFloorRoofShift } = await import("../api/nifty-oi.js");
const { createPollHandler, POLL_FAILURES_KEY, POLL_SUCCESSES_KEY, sourceOkKey, sourceFailKey } = await import("../api/poll.js");
const { createCollectorStatusHandler } = await import("../api/collector-status.js");
const carry = await import("../src/carryBridge.js");

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const tick = (m, o = {}) => ({ minutes: m, time: hm(m), netDiff: 0, putWriting: 300000, callWriting: 300000, spot: 25000, futPrice: 25050, futCombinedOI: 200000, isLiveTick: true, ...o });
const range = (a, b, o) => { const out = []; for (let m = a; m <= b; m++) out.push(tick(m, typeof o === "function" ? o(m) : o)); return out; };
// 12-Nov IST minute → epoch ms
const at = (m) => Date.UTC(2026, 10, 12, 0, 0, 0) + (m - 330) * 60000;
const mkRes = () => ({ statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, setHeader() { return this; }, json(d) { this.body = d; return this; }, end() { return this; } });

// ── Coverage maths ──

test("windowCoverage: a gap-free window is ok; a hole gives the exact 'not enough data' sentence", () => {
  const full = dq.windowCoverage(range(840, 870), 840, 870, { label: "the 30-min radar window 14:00-14:30" });
  assert.equal(full.ok, true);
  assert.equal(full.observed, 31);
  assert.equal(full.text, null);
  const holed = dq.windowCoverage([...range(840, 850), ...range(861, 870)], 840, 870, { label: "the 30-min radar window 14:00-14:30" });
  assert.equal(holed.ok, false);
  assert.equal(holed.text, "not enough data for the 30-min radar window 14:00-14:30 (21 of 31 expected ticks; gap 14:10–14:21)");
  assert.equal(holed.maxGapMin, 11);
});

test("windowCoverage: up to three consecutive missed ticks are tolerated; four are not; edges count", () => {
  const three = range(840, 870).filter((p) => ![850, 851, 852].includes(p.minutes));
  assert.equal(dq.windowCoverage(three, 840, 870).ok, true);
  const four = range(840, 870).filter((p) => ![850, 851, 852, 853].includes(p.minutes));
  assert.equal(dq.windowCoverage(four, 840, 870).ok, false);
  const lateStart = range(846, 870); // nothing in 14:00–14:05
  const r = dq.windowCoverage(lateStart, 840, 870, { label: "w" });
  assert.equal(r.ok, false);
  assert.match(r.text, /gap 14:00–14:06/);
  assert.equal(dq.windowCoverage([], 840, 870, { label: "w" }).text, "not enough data for w (0 of 31 expected ticks; gap 14:00–14:30)");
});

test("computeDataQuality: OK, GAPS (listed ≥3 min), STALE, BUILDING, ongoing gap, synthetic ticks ignored", () => {
  const okDq = dq.computeDataQuality({ timeline: range(555, 700), nowMins: 700, snapshotAgeSec: 10 });
  assert.equal(okDq.state, "OK");
  assert.equal(okDq.coveragePct, 100);
  assert.match(okDq.summary, /complete since 09:15/);

  // 12-Nov shape: every minute to 11:38, then sparse browser ticks.
  const tl = [...range(555, 698), tick(712), tick(726), tick(741), tick(742)];
  const g = dq.computeDataQuality({ timeline: tl, nowMins: 760, snapshotAgeSec: 30 });
  assert.equal(g.state, "GAPS");
  assert.deepEqual(g.gaps.map((x) => `${x.from}–${x.to}`), ["11:38–11:52", "11:52–12:06", "12:06–12:21", "12:22–now"]);
  assert.equal(g.gaps.at(-1).ongoing, true);
  assert.equal(g.maxGapMin, 18);
  assert.equal(g.windows.last30.ok, false);

  assert.equal(dq.computeDataQuality({ timeline: range(555, 700), nowMins: 700, snapshotAgeSec: 400 }).state, "STALE");
  assert.equal(dq.computeDataQuality({ timeline: range(555, 558), nowMins: 558, snapshotAgeSec: 5 }).state, "BUILDING");
  assert.equal(dq.computeDataQuality({ timeline: [], nowMins: 500 }).state, "BUILDING");

  const synthetic = range(555, 700, { synthetic: true });
  assert.equal(dq.computeDataQuality({ timeline: synthetic, nowMins: 700, isLive: false }).ticksToday, 0);
});

test("mergeTimelines: union by minute, preferred side wins on the same minute", () => {
  const m = dq.mergeTimelines([tick(556, { spot: 1 }), tick(558)], [tick(555), tick(556, { spot: 2 }), tick(557)]);
  assert.deepEqual(m.map((p) => p.minutes), [555, 556, 557, 558]);
  assert.equal(m[1].spot, 1);
});

// ── Per-window gating ──

test("30-min radar: refuses to read across a hole and says which window and gap", () => {
  const ticks = [...range(820, 840), ...range(852, 870)];
  const r = detectMacroTurn({ timeline: ticks, spot: 25000, floorStrike: 24900, roofStrike: 25100 });
  assert.equal(r.status, "INSUFFICIENT_DATA");
  assert.equal(r.isTriggered, false);
  assert.match(r.message, /not enough data for the 30-min radar window 14:00-14:30 \(\d+ of 31 expected ticks; gap 14:00–14:12\)/);
});

const eodArgs = (timeline, extra = {}) => ({
  spot: 24500, floorStrike: 24400, roofStrike: 24650, totPutWriting: 200000, totCallWriting: 200000,
  pcr: 1.0, deltaPcr: 1.0, timeline, dayOfWeek: 3, nowMins: 930,
  futuresQuadrant: { quadrant: "NEUTRAL_CHOP" }, futuresMetrics: { rawBasis: 5 }, ...extra,
});
const closingTicks = (holeFrom = null, holeTo = null) => range(855, 930, (m) => {
  const call = 300000 + (m - 855) * 1500; // fresh call writing: −112.5k net by 15:30
  return { putWriting: 300000, callWriting: call, netDiff: 300000 - call };
}).filter((p) => holeFrom === null || p.minutes < holeFrom || p.minutes > holeTo);

test("EOD: gap-free closing window is scored; a 10-minute hole makes group B UNVERIFIED (0 pts) with a caveat", () => {
  const ok = calculateEODDecision(eodArgs(closingTicks()));
  assert.equal(ok.groups.B.unverified, false);
  assert.equal(ok.groups.B.contribution, -3);
  assert.deepEqual(ok.unverifiedGroups, []);
  assert.equal(ok.dataQualityCaveat, null);

  const gap = calculateEODDecision(eodArgs(closingTicks(880, 889)));
  const b = gap.audit.find((a) => a.label === "Closing Hour Flow (14:15+)");
  assert.equal(b.status, "UNVERIFIED");
  assert.match(b.detail, /not enough data for the closing-flow window 14:15–15:30 \(66 of 76 expected ticks; gap 14:39–14:50\)/);
  assert.equal(gap.groups.B.contribution, 0);
  assert.deepEqual(gap.unverifiedGroups, ["B"]);
  assert.match(gap.dataQualityCaveat, /^⚠️ Data caveat: Group B closing flow: not enough data/);
  assert.match(gap.action, /^⚠️ Data caveat/);
  assert.equal(gap.isClosingDataValid, false, "no last-hour delta, no late veto");
  assert.equal(gap.audit.find((a) => a.isGroupSummary && a.group === "B").status, "UNVERIFIED");
});

test("EOD: before the closing window activates group B is pending, not UNVERIFIED", () => {
  const r = calculateEODDecision(eodArgs(range(800, 860), { nowMins: 860 }));
  assert.equal(r.groups.B.unverified, false);
  assert.equal(r.groups.B.pending, true);
});

test("EOD: stale or missing futures make group C UNVERIFIED (0 pts)", () => {
  const stale = calculateEODDecision(eodArgs(closingTicks(), { futuresQuadrant: { quadrant: "SHORT_BUILDUP" }, futuresMetrics: { isStale: true, rawBasis: 5 } }));
  assert.equal(stale.groups.C.unverified, true);
  assert.equal(stale.groups.C.contribution, 0);
  assert.match(stale.audit.find((a) => a.label === "Futures Quadrant & Basis").detail, /UNVERIFIED — futures snapshot is stale/);
  const fresh = calculateEODDecision(eodArgs(closingTicks(), { futuresQuadrant: { quadrant: "SHORT_BUILDUP" }, futuresMetrics: { rawBasis: 5 } }));
  assert.equal(fresh.groups.C.unverified, false);
  assert.equal(fresh.groups.C.contribution, -1);
});

test("floor/roof migration: compared across a data gap is labelled, with no fake first-reading migration", () => {
  const first = describeFloorRoofShift({ previous: { floor: null, roof: null, atMins: null }, nowMins: 600, floor: 25000, roof: 25300 });
  assert.match(first.floorShift, /no earlier reading to compare/);
  const cont = describeFloorRoofShift({ previous: { floor: 24900, roof: 25300, atMins: 599 }, nowMins: 600, floor: 25000, roof: 25300 });
  assert.equal(cont.floorShift, "Floor moved from 24900 to 25000");
  assert.equal(cont.coverage.ok, true);
  const gap = describeFloorRoofShift({ previous: { floor: 24900, roof: 25300, atMins: 698 }, nowMins: 741, floor: 25000, roof: 25300 });
  assert.match(gap.floorShift, /compared with the 11:38 reading, 43 min earlier \(data gap; not a continuous migration\)/);
  assert.equal(gap.coverage.ok, false);
});

// ── Collector alerts ──

function alertDeps() {
  const store = {};
  const sent = [];
  return {
    store, sent,
    deps: {
      setNx: async (k, v) => { if (k in store) return false; store[k] = v; return true; },
      del: async (k) => { if (k in store) { delete store[k]; return 1; } return 0; },
      send: async (t) => { sent.push(t); return true; },
      getHeartbeat: async () => store.hb ?? null,
    },
  };
}

test("gap alert: one Telegram per closed gap ≥5 min, deduped; short and ongoing gaps ignored; released on send failure", async () => {
  const d = dq.computeDataQuality({ timeline: [...range(555, 698), tick(712), tick(714), tick(716), ...range(720, 725)], nowMins: 760, snapshotAgeSec: 0 });
  const a = alertDeps();
  const sent1 = await alerts.alertNewGaps({ dataQuality: d, istDateStr: "2026-11-12", deps: a.deps });
  assert.deepEqual(sent1, ["11:38–11:52"], "only the 14-min gap; 2- and 4-min holes and the ongoing tail are ignored");
  assert.match(a.sent[0], /Scanner missed ticks 11:38–11:52 IST/);
  assert.match(a.sent[0], /History-based panels/);
  assert.deepEqual(await alerts.alertNewGaps({ dataQuality: d, istDateStr: "2026-11-12", deps: a.deps }), []);
  assert.equal(a.sent.length, 1);

  const b = alertDeps();
  b.deps.send = async () => false;
  await alerts.alertNewGaps({ dataQuality: d, istDateStr: "2026-11-12", deps: b.deps });
  assert.deepEqual(Object.keys(b.store), [], "claim released so a later refresh retries");
});

test("poller heartbeat: browser refresh notices a dead poller once; recovers once on the next poll", async () => {
  const a = alertDeps();
  a.store.hb = { at: new Date(at(698)).toISOString(), source: "qstash" };
  const r1 = await alerts.checkPollerHeartbeat({ nowMs: at(741), isLiveMarket: true, trigger: "browser", deps: a.deps });
  assert.equal(r1.status, "POLLER_DOWN_ALERTED");
  assert.match(a.sent[0], /POLLER DOWN/);
  assert.match(a.sent[0], /browser refresh/);
  const r2 = await alerts.checkPollerHeartbeat({ nowMs: at(745), isLiveMarket: true, trigger: "webhook-refresh", deps: a.deps });
  assert.equal(r2.status, "POLLER_DOWN_ALREADY_ALERTED");
  assert.equal(a.sent.length, 1);
  const rec = await alerts.notePollerSuccess({ source: "vm", deps: a.deps });
  assert.equal(rec.status, "RECOVERED");
  assert.match(a.sent[1], /POLLER RECOVERED/);
  assert.equal((await alerts.notePollerSuccess({ source: "vm", deps: a.deps })).sent, false);

  const fresh = alertDeps();
  fresh.store.hb = { at: new Date(at(740)).toISOString() };
  assert.equal((await alerts.checkPollerHeartbeat({ nowMs: at(741), isLiveMarket: true, trigger: "browser", deps: fresh.deps })).status, "POLLER_OK");
  assert.equal((await alerts.checkPollerHeartbeat({ nowMs: at(741), isLiveMarket: false, trigger: "browser", deps: fresh.deps })).status, "OUTSIDE_SESSION");
  const open = alertDeps(); // 09:16, no heartbeat yet today: session-open grace
  assert.equal((await alerts.checkPollerHeartbeat({ nowMs: at(556), isLiveMarket: true, trigger: "browser", deps: open.deps })).status, "POLLER_OK");
});

// ── /api/poll with several pollers ──

const SECRET = "dq-test-secret";
function pollHarness({ snapshotAgeSec = 600, refreshResult } = {}) {
  const st = { refreshes: 0, events: [], sources: {}, sent: [], kv: {}, heartbeats: [] };
  const nowMs = at(700);
  const handler = createPollHandler({
    now: () => nowMs,
    getMarketSessionInfo: () => ({ isLiveMarket: true }),
    refresh: async () => {
      st.refreshes++;
      return refreshResult || { ok: true, snapshotAt: nowMs, ticks: 140, payload: { spotPrice: 25000, dataQuality: { state: "OK" } } };
    },
    getFlowSnapshot: async () => ({ snapshotAt: nowMs - snapshotAgeSec * 1000, snapshotSource: "poller", dataQuality: { state: "GAPS" } }),
    setHeartbeat: async (v) => { st.heartbeats.push(v); return true; },
    setNx: async (k, v) => { if (k in st.kv) return false; st.kv[k] = v; return true; },
    del: async (k) => { if (k in st.kv) { delete st.kv[k]; return 1; } return 0; },
    sendText: async (t) => { st.sent.push(t); return true; },
    qstashKeys: () => [],
    pushEvent: async (key, v) => { st.events.push({ key, v }); },
    setSourceStatus: async (key, v) => { st.sources[key] = v; },
  });
  const call = async (source) => {
    const res = mkRes();
    await handler({ method: "POST", headers: { "x-webhook-secret": SECRET, ...(source ? { "x-poll-source": source } : {}) }, body: undefined, query: {} }, res);
    return res;
  };
  return { st, call };
}
function withSecret(fn) {
  return async () => {
    const prev = process.env.TV_WEBHOOK_SECRET;
    process.env.TV_WEBHOOK_SECRET = SECRET;
    try { await fn(); } finally { if (prev === undefined) delete process.env.TV_WEBHOOK_SECRET; else process.env.TV_WEBHOOK_SECRET = prev; }
  };
}

test("poll: a snapshot younger than POLL_MIN_INTERVAL_SEC → FRESH_ENOUGH, no NSE call, success recorded for the source", withSecret(async () => {
  const h = pollHarness({ snapshotAgeSec: 8 });
  const r = await h.call("vm");
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.status, "FRESH_ENOUGH");
  assert.equal(r.body.ageSec, 8);
  assert.deepEqual(r.body.dataQuality, { state: "GAPS" });
  assert.equal(h.st.refreshes, 0, "no NSE refresh");
  assert.equal(h.st.events[0].key, POLL_SUCCESSES_KEY);
  assert.equal(h.st.events[0].v.status, "FRESH_ENOUGH");
  assert.equal(h.st.sources[sourceOkKey("vm")].source, "vm");
  assert.equal(h.st.heartbeats.length, 1);
}));

test("poll: an older snapshot → real refresh; success timing listed; dataQuality returned", withSecret(async () => {
  const h = pollHarness({ snapshotAgeSec: 45 });
  const r = await h.call("github-actions");
  assert.equal(r.body.status, "LIVE_POLL_SUCCESS");
  assert.deepEqual(r.body.dataQuality, { state: "OK" });
  assert.equal(h.st.refreshes, 1);
  assert.equal(h.st.events[0].v.status, "LIVE_POLL_SUCCESS");
  assert.ok(Number.isFinite(h.st.events[0].v.durationMs));
  assert.ok(h.st.sources[sourceOkKey("github-actions")]);
}));

test("poll: a failure is listed with time, source, HTTP status, stage, error and duration; env overrides the interval", withSecret(async () => {
  const h = pollHarness({ snapshotAgeSec: 45, refreshResult: { ok: false, stage: "nse", error: "v3 option chain failed: status 403" } });
  const r = await h.call(undefined);
  assert.equal(r.statusCode, 502);
  const ev = h.st.events.find((e) => e.key === POLL_FAILURES_KEY).v;
  assert.equal(ev.source, "secret");
  assert.equal(ev.httpStatus, 502);
  assert.equal(ev.stage, "nse");
  assert.match(ev.error, /403/);
  assert.ok(Number.isFinite(ev.durationMs));
  assert.ok(h.st.sources[sourceFailKey("secret")]);

  process.env.POLL_MIN_INTERVAL_SEC = "60";
  try {
    const h2 = pollHarness({ snapshotAgeSec: 45 });
    assert.equal((await h2.call("qstash")).body.status, "FRESH_ENOUGH");
  } finally {
    delete process.env.POLL_MIN_INTERVAL_SEC;
  }
}));

test("poll: a success after a poller-down alert sends one 'poller recovered'", withSecret(async () => {
  const h = pollHarness({ snapshotAgeSec: 45 });
  h.st.kv[alerts.POLLER_DOWN_KEY] = { since: "x" };
  await h.call("vm");
  assert.equal(h.st.sent.filter((t) => /POLLER RECOVERED/.test(t)).length, 1);
  await h.call("vm");
  assert.equal(h.st.sent.filter((t) => /POLLER RECOVERED/.test(t)).length, 1);
}));

// ── /api/collector-status ──

function statusHarness({ nowMins = 760, snapshotMins = 742, timeline } = {}) {
  const kv = {
    "nifty:flow:latest": { snapshotAt: at(snapshotMins), snapshotSource: "browser", intradayTimeline: timeline ?? [...range(555, 698), tick(712), tick(726), tick(741), tick(742)] },
    [sourceOkKey("qstash")]: { at: new Date(at(698)).toISOString(), source: "qstash", status: "LIVE_POLL_SUCCESS" },
    [sourceFailKey("qstash")]: { at: new Date(at(699)).toISOString(), source: "qstash", httpStatus: 502, error: "timeout" },
    "nifty:poller:last_ok": { at: new Date(at(698)).toISOString() },
  };
  const lists = {
    [POLL_FAILURES_KEY]: [{ at: new Date(at(699)).toISOString(), source: "qstash", httpStatus: 502, stage: "nse", error: "timeout", durationMs: 12000 }],
    [POLL_SUCCESSES_KEY]: [{ at: new Date(at(698)).toISOString(), source: "qstash", status: "LIVE_POLL_SUCCESS", durationMs: 2100 }],
  };
  const handler = createCollectorStatusHandler({
    now: () => at(nowMins),
    get: async (k) => kv[k] ?? null,
    lrange: async (k) => lists[k] || [],
  });
  return async (query = {}) => {
    const res = mkRes();
    await handler({ method: "GET", query, headers: {} }, res);
    return res;
  };
}

test("collector-status: public view is the coarse summary only, with the ongoing gap and per-source ages", async () => {
  const r = await statusHarness()();
  assert.deepEqual(Object.keys(r.body).sort(), ["coveragePct", "expectedTicks", "gaps", "lastOkBySource", "lastTickTime", "maxGapMin", "snapshotAgeSec", "state", "ticksToday"].sort());
  assert.equal(r.body.state, "STALE", "18-minute-old snapshot during the session");
  assert.equal(r.body.lastTickTime, "12:22");
  assert.equal(r.body.snapshotAgeSec, 1080);
  assert.deepEqual(r.body.gaps.at(-1), { from: "12:22", to: "now", minutes: 18 });
  assert.equal(r.body.lastOkBySource.qstash, 3720);
  assert.equal(r.body.lastOkBySource.vm, null);
  assert.ok(!JSON.stringify(r.body).includes("timeout"), "no error text in the public view");
});

test("collector-status: authenticated view adds failures, success timings, sources, heartbeat", withSecret(async () => {
  const r = await statusHarness()({ key: SECRET });
  assert.equal(r.body.detail.failures[0].httpStatus, 502);
  assert.equal(r.body.detail.successes[0].durationMs, 2100);
  assert.equal(r.body.detail.sources.qstash.lastFailure.error, "timeout");
  assert.ok(r.body.detail.heartbeat);
  const bad = await statusHarness()({ key: "wrong" });
  assert.equal(bad.statusCode, 401);
}));

test("collector-status: a snapshot from an earlier day says nothing about today", async () => {
  const handler = statusHarness({ nowMins: 600, snapshotMins: 600 - 24 * 60 });
  const r = await handler();
  assert.equal(r.body.ticksToday, 0);
  assert.notEqual(r.body.state, "OK");
});

// ── Carry refuses on UNVERIFIED groups ──

test("carry: refuses to dispatch when any scored EOD group is UNVERIFIED, and says why at 15:38", async () => {
  const store = {};
  const sent = [];
  const tickStore = {
    async get(k) { return store[k] === undefined ? null : JSON.parse(JSON.stringify(store[k])); },
    async set(k, v) { store[k] = JSON.parse(JSON.stringify(v)); return "OK"; },
    async setNx(k, v) { if (k in store) return false; store[k] = v; return true; },
    async del(k) { delete store[k]; return 1; },
    async lpush() { return 1; },
    async ltrim() { return "OK"; },
  };
  let nowMs = 0;
  const deps = {
    env: () => ({ CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://algo.example.test/x", FLOW_BRIDGE_SECRET: "k" }),
    now: () => nowMs,
    fetchImpl: async () => { throw new Error("must not dispatch"); },
    sendText: async (t) => { sent.push(t); return true; },
    newId: () => "ct-x",
  };
  const decision = { bias: "BEARISH", score: -4, agreement: { value: 75 }, stopLoss: 24100, unverifiedGroups: ["B"], dataQualityCaveat: "⚠️ Data caveat: Group B closing flow: not enough data for the closing-flow window 14:15–15:33 (40 of 79 expected ticks; gap 14:40–15:02) — scored 0 (UNVERIFIED)" };
  for (const m of [931, 932, 933]) {
    nowMs = at(m);
    const r = await carry.runCarryDispatch({ istMinutes: m, istDateStr: "2026-11-12", dayOfWeek: 4, eodDecision: decision, spot: 24000, dataTimestamp: "12-Nov-2026 15:30:00", store: tickStore, deps });
    assert.equal(r.status, "BLOCKED");
    assert.match(r.reason, /EOD group\(s\) B UNVERIFIED \(not enough data\)/);
  }
  nowMs = at(938);
  await carry.runCarryDispatch({ istMinutes: 938, istDateStr: "2026-11-12", dayOfWeek: 4, eodDecision: decision, spot: 24000, dataTimestamp: "12-Nov-2026 15:30:00", store: tickStore, deps });
  assert.match(sent.at(-1), /Carry: nothing sent today.*UNVERIFIED/);
});
