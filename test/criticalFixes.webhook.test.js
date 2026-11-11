import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  fuseChartWithOptionChain,
  setRedisClientForTesting,
  getFlowMaxAgeSec,
} from "../api/tv-webhook.js";
import { secretsMatch, authorizeRequest } from "../src/webhookAuth.js";

const SECRET = "test-secret-123";

// Never let these tests talk to Telegram.
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_CHAT_ID;

function createFakeRedis(initial = {}) {
  const store = { ...initial };
  const lists = {};
  return {
    store,
    lists,
    async get(k) { return store[k] ?? null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { (lists[k] ||= []).unshift(v); return lists[k].length; },
    async ltrim() { return "OK"; },
    async lrange(k) { return lists[k] || []; },
  };
}

function mockReqRes({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  const req = { method, body: typeof body === "string" ? body : JSON.stringify(body), query, headers };
  const res = {
    statusCode: 200,
    body: null,
    status(c) { this.statusCode = c; return this; },
    setHeader() { return this; },
    json(d) { this.body = d; return this; },
    send(d) { this.body = d; return this; },
    end() { return this; },
  };
  return { req, res };
}

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
      setRedisClientForTesting(null);
    }
  };
}

const synergyBearAlert = (extra = {}) => ({
  secret: SECRET,
  sym: "NSE:NIFTY",
  tf: "15",
  dir: "SHORT",
  grade: "SYNERGY_BEAR",
  close: 24960,
  sl: 25025,
  cappedSl: 25025,
  rDist: 65,
  t1Dist: 65,
  t2Dist: 130,
  futQuad: "SHORT_BUILDUP",
  ...extra,
});

const freshBearSnapshot = (overrides = {}) => ({
  snapshotAt: Date.now() - 30_000,
  corridor: { deltaPCR: 0.6, floorStrike: 24700, roofStrike: 25200 },
  futures: { quadrant: "SHORT_BUILDUP" },
  smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" },
  ...overrides,
});

// ── Item 3: fail-closed authentication ──

test("auth: secretsMatch is exact and rejects empty/missing values", () => {
  assert.equal(secretsMatch("abc", "abc"), true);
  assert.equal(secretsMatch("abd", "abc"), false);
  assert.equal(secretsMatch("abcd", "abc"), false);
  assert.equal(secretsMatch("", "abc"), false);
  assert.equal(secretsMatch(undefined, "abc"), false);
});

test("auth: authorizeRequest accepts header, key query or body secret", withSecret(SECRET, async () => {
  assert.equal(authorizeRequest({ headers: { "x-webhook-secret": SECRET }, query: {} }).ok, true);
  assert.equal(authorizeRequest({ headers: { "X-Webhook-Secret": SECRET }, query: {} }).ok, true);
  assert.equal(authorizeRequest({ headers: {}, query: { key: SECRET } }).ok, true);
  assert.equal(authorizeRequest({ headers: {}, query: {} }, { secret: SECRET }).ok, true);
  const bad = authorizeRequest({ headers: {}, query: { key: "nope" } });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.ok(!JSON.stringify(bad).includes(SECRET), "must never echo the secret");
}));

for (const unset of [undefined, "", "CHANGE_ME"]) {
  test(`webhook POST returns 503 and processes nothing when TV_WEBHOOK_SECRET=${JSON.stringify(unset)}`, withSecret(unset, async () => {
    const redis = createFakeRedis({ "nifty:flow:latest": freshBearSnapshot() });
    setRedisClientForTesting(redis);
    const { req, res } = mockReqRes({ body: synergyBearAlert({ secret: "anything" }) });
    await handler(req, res);
    assert.equal(res.statusCode, 503);
    assert.equal(redis.store["nifty:tv:active_trade"], undefined, "no trade opened");
    assert.equal(redis.store["nifty:tv:latest_signal"], undefined, "nothing logged");
    assert.deepEqual(redis.lists, {}, "nothing archived");
  }));
}

test("webhook POST with wrong secret returns 401 and processes nothing", withSecret(SECRET, async () => {
  const redis = createFakeRedis({ "nifty:flow:latest": freshBearSnapshot() });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: synergyBearAlert({ secret: "wrong" }) });
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined);
  assert.deepEqual(redis.lists, {});
}));

test("webhook POST exit grade (STOP_LOSS_HIT) without secret cannot close the active trade", withSecret(SECRET, async () => {
  const active = { active: true, grade: "SYNERGY_BEAR", direction: "SHORT", entryPrice: 24960 };
  const redis = createFakeRedis({ "nifty:tv:active_trade": JSON.stringify(active) });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: { grade: "STOP_LOSS_HIT", close: 25025 } });
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.ok(redis.store["nifty:tv:active_trade"], "active trade must survive");
}));

const mutatingGets = [
  { close_trade: "1" },
  { action: "close_trade" },
  { test: "telegram" },
  { test: "eod" },
  { send_eod: "1" },
  { spot: "25000" },
  { spot: "25000", high: "25100", low: "24900" },
];

for (const query of mutatingGets) {
  test(`webhook GET ${JSON.stringify(query)} is rejected without secret (401) and with no configured secret (503)`, withSecret(SECRET, async () => {
    const active = { active: true, grade: "SYNERGY_BEAR", direction: "SHORT", entryPrice: 24960, stopLoss: 25025, target1Price: 24895, target2Price: 24830 };
    const redis = createFakeRedis({ "nifty:tv:active_trade": JSON.stringify(active) });
    setRedisClientForTesting(redis);

    const { req, res } = mockReqRes({ method: "GET", query: { ...query } });
    await handler(req, res);
    assert.equal(res.statusCode, 401);
    assert.ok(redis.store["nifty:tv:active_trade"], "state untouched");

    const { req: r2, res: s2 } = mockReqRes({ method: "GET", query: { ...query, key: "wrong" } });
    await handler(r2, s2);
    assert.equal(s2.statusCode, 401);

    delete process.env.TV_WEBHOOK_SECRET;
    const { req: r3, res: s3 } = mockReqRes({ method: "GET", query: { ...query, key: SECRET } });
    await handler(r3, s3);
    assert.equal(s3.statusCode, 503);
    assert.ok(redis.store["nifty:tv:active_trade"], "state untouched");
  }));
}

test("webhook GET close_trade succeeds with x-webhook-secret header", withSecret(SECRET, async () => {
  const active = { active: true, grade: "SYNERGY_BEAR", direction: "SHORT", entryPrice: 24960 };
  const redis = createFakeRedis({ "nifty:tv:active_trade": JSON.stringify(active) });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ method: "GET", query: { close_trade: "1" }, headers: { "x-webhook-secret": SECRET } });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined, "trade closed");
}));

test("webhook plain read GETs stay open without a secret (status, latest, archive, csv)", withSecret(undefined, async () => {
  setRedisClientForTesting(createFakeRedis());
  for (const query of [{}, { action: "status" }, { archive: "1" }, { export: "csv" }]) {
    const { req, res } = mockReqRes({ method: "GET", query });
    await handler(req, res);
    assert.equal(res.statusCode, 200, `GET ${JSON.stringify(query)} must stay open`);
  }
}));

// ── Item 4: stale / missing snapshot vetoes ──

test("webhook: actionable grade with NO snapshot => VETO_STALE_OPTION_CHAIN, 0 lots, no trade", withSecret(SECRET, async () => {
  // Only the 14-day session payload exists — it must NOT be used for actionable grades.
  const redis = createFakeRedis({
    nifty_latest_session_payload_v2: JSON.stringify({ deltaPcr: 0.5, floor: 24700, roof: 25200, snapshotAt: Date.now() }),
  });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: synergyBearAlert() });
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.equal(res.body.recommendedLots, 0);
  assert.match(res.body.fusedVerdict.reasoning, /Snapshot age: unknown/);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined);
}));

test("webhook: snapshot without snapshotAt => VETO_STALE_OPTION_CHAIN", withSecret(SECRET, async () => {
  const snap = freshBearSnapshot();
  delete snap.snapshotAt;
  const redis = createFakeRedis({ "nifty:flow:latest": JSON.stringify(snap) });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: synergyBearAlert() });
  await handler(req, res);
  assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
  assert.equal(res.body.recommendedLots, 0);
  assert.match(res.body.fusedVerdict.reasoning, /age: unknown/i);
  assert.equal(redis.store["nifty:tv:active_trade"], undefined);
}));

test("webhook: snapshot older than FLOW_MAX_AGE_SEC => VETO_STALE_OPTION_CHAIN with age in reasoning", withSecret(SECRET, async () => {
  const prev = process.env.FLOW_MAX_AGE_SEC;
  process.env.FLOW_MAX_AGE_SEC = "300";
  try {
    const redis = createFakeRedis({ "nifty:flow:latest": freshBearSnapshot({ snapshotAt: Date.now() - 600_000 }) });
    setRedisClientForTesting(redis);
    const { req, res } = mockReqRes({ body: synergyBearAlert() });
    await handler(req, res);
    assert.equal(res.body.decision, "VETO_STALE_OPTION_CHAIN");
    assert.equal(res.body.recommendedLots, 0);
    assert.match(res.body.fusedVerdict.reasoning, /age 600s > max 300s/);
    assert.equal(res.body.fusedVerdict.liveOptionChainMetrics.snapshotAgeSec, 600);
    assert.equal(redis.store["nifty:tv:active_trade"], undefined);
  } finally {
    if (prev === undefined) delete process.env.FLOW_MAX_AGE_SEC;
    else process.env.FLOW_MAX_AGE_SEC = prev;
  }
}));

test("webhook: FLOW_MAX_AGE_SEC defaults to 900", () => {
  const prev = process.env.FLOW_MAX_AGE_SEC;
  delete process.env.FLOW_MAX_AGE_SEC;
  assert.equal(getFlowMaxAgeSec(), 900);
  if (prev !== undefined) process.env.FLOW_MAX_AGE_SEC = prev;
});

test("webhook: fresh snapshot executes SYNERGY_BEAR, opens trade and reports snapshot age", withSecret(SECRET, async () => {
  const redis = createFakeRedis({ "nifty:flow:latest": JSON.stringify(freshBearSnapshot()) });
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: synergyBearAlert() });
  await handler(req, res);
  assert.equal(res.body.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(res.body.recommendedLots, 2);
  const age = res.body.fusedVerdict.liveOptionChainMetrics.snapshotAgeSec;
  assert.ok(age >= 29 && age <= 35, `age ${age}`);
  assert.ok(redis.store["nifty:tv:active_trade"], "trade opened");
}));

test("webhook: non-actionable grade is still logged (LOG_ONLY) without a snapshot", withSecret(SECRET, async () => {
  const redis = createFakeRedis();
  setRedisClientForTesting(redis);
  const { req, res } = mockReqRes({ body: { secret: SECRET, grade: "MEGA", dir: "LONG", close: 25000 } });
  await handler(req, res);
  assert.equal(res.body.decision, "LOG_ONLY");
}));

// ── Item 4: null ΔPCR must not fail open ──

test("fuse: null ΔPCR gives false blitz flags and never claims option-chain confirmation", () => {
  for (const grade of ["BEAR_TRAP_BUY", "BULL_TRAP_SELL", "SYNERGY_BULL", "SYNERGY_BEAR", "SWING_BOTTOM", "SIGNAL"]) {
    const dir = ["BULL_TRAP_SELL", "SYNERGY_BEAR"].includes(grade) ? "SHORT" : "LONG";
    const fused = fuseChartWithOptionChain(
      { grade, dir, close: 25000, actFloor: 24990, actRoof: 25010, fusion: "HIGH_CONVICTION_BULLISH_SYNERGY", futQuad: "LONG_BUILDUP" },
      null
    );
    const m = fused.liveOptionChainMetrics;
    assert.equal(m.deltaPCR, null, grade);
    assert.equal(m.realPutBlitz, false, grade);
    assert.equal(m.realCallBlitz, false, grade);
    assert.doesNotMatch(fused.reasoning, /confirms|VERIFIED|passed Option Chain filter|\) aligned/, `${grade}: ${fused.reasoning}`);
    if (["BEAR_TRAP_BUY", "BULL_TRAP_SELL", "SYNERGY_BULL", "SYNERGY_BEAR"].includes(grade)) {
      assert.ok(fused.recommendedLots <= 1, `${grade} must not size up without data`);
    }
  }
});

test("fuse: snapshot with corridor but missing deltaPCR is treated as null (not 1.0)", () => {
  const fused = fuseChartWithOptionChain(
    { grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000 },
    { corridor: { floorStrike: 24990, roofStrike: 25300 }, futures: { quadrant: "LONG_BUILDUP" } }
  );
  assert.equal(fused.liveOptionChainMetrics.deltaPCR, null);
  assert.equal(fused.liveOptionChainMetrics.realPutBlitz, false);
  assert.equal(fused.recommendedLots, 1);
});

// ── Item 5: server futures quadrant, never the chart's own ──

test("fuse: server quadrant is used; chart futQuad cannot trigger the futures veto", () => {
  const tv = { grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000, futQuad: "SHORT_BUILDUP" };
  const scanner = { corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 }, futures: { quadrant: "LONG_BUILDUP" } };
  const fused = fuseChartWithOptionChain(tv, scanner);
  assert.notEqual(fused.decision, "VETO_SIGNAL", "chart SHORT_BUILDUP must not drive the veto");
  assert.equal(fused.liveOptionChainMetrics.liveFutQuad, "LONG_BUILDUP");
  assert.equal(fused.liveOptionChainMetrics.serverFutQuad, "LONG_BUILDUP");
  assert.equal(fused.liveOptionChainMetrics.chartFutQuad, "SHORT_BUILDUP");
  assert.equal(fused.chartMetrics.chartFutQuad, "SHORT_BUILDUP");

  // Server says SHORT_BUILDUP => veto fires
  const vetoed = fuseChartWithOptionChain({ ...tv, futQuad: "LONG_BUILDUP" }, { ...scanner, futures: { quadrant: "SHORT_BUILDUP" } });
  assert.equal(vetoed.decision, "VETO_SIGNAL");
});

test("fuse: falls back to fusion.quadrantInfo.quadrant when futures.quadrant missing", () => {
  const fused = fuseChartWithOptionChain(
    { grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000, futQuad: "LONG_BUILDUP" },
    { corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 }, futures: { lastPrice: 1 }, fusion: { quadrantInfo: { quadrant: "SHORT_BUILDUP" } } }
  );
  assert.equal(fused.liveOptionChainMetrics.liveFutQuad, "SHORT_BUILDUP");
  assert.equal(fused.decision, "VETO_SIGNAL");
});

test("fuse: missing or stale server quadrant => UNAVAILABLE; chart quadrant not substituted", () => {
  const cases = [
    { corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 } },
    { corridor: { deltaPCR: 0.5, floorStrike: 24990, roofStrike: 25300 }, futures: { quadrant: "SHORT_BUILDUP", isStale: true } },
  ];
  for (const scanner of cases) {
    // Chart says SHORT_BUILDUP; old code would have vetoed this Bear Trap Buy.
    const fused = fuseChartWithOptionChain({ grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25000, futQuad: "SHORT_BUILDUP" }, scanner);
    assert.equal(fused.liveOptionChainMetrics.liveFutQuad, "UNAVAILABLE");
    assert.equal(fused.liveOptionChainMetrics.chartFutQuad, "SHORT_BUILDUP");
    assert.notEqual(fused.decision, "VETO_SIGNAL", "UNAVAILABLE must not satisfy the veto");
  }
});

test("fuse: UNAVAILABLE quadrant satisfies neither synergy veto nor confirmation", () => {
  // Neutral ΔPCR, no server scenario, no server quadrant: must be MODERATE (not verified), not vetoed by futures.
  const tv = { grade: "SYNERGY_BULL", dir: "LONG", close: 25000, futQuad: "SHORT_BUILDUP", fusion: "HIGH_CONVICTION_BULLISH_SYNERGY" };
  const scanner = { corridor: { deltaPCR: 1.1, floorStrike: 24800, roofStrike: 25400 } };
  const fused = fuseChartWithOptionChain(tv, scanner);
  assert.equal(fused.liveOptionChainMetrics.liveFutQuad, "UNAVAILABLE");
  assert.equal(fused.decision, "EXECUTE_MODERATE_SYNERGY");
  assert.equal(fused.recommendedLots, 1);

  const bear = fuseChartWithOptionChain(
    { grade: "SYNERGY_BEAR", dir: "SHORT", close: 25000, futQuad: "LONG_BUILDUP" },
    { corridor: { deltaPCR: 0.9, floorStrike: 24600, roofStrike: 25200 } }
  );
  assert.equal(bear.liveOptionChainMetrics.liveFutQuad, "UNAVAILABLE");
  assert.equal(bear.decision, "EXECUTE_MODERATE_SYNERGY");
});
