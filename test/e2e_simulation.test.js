import test from "node:test";
import assert from "node:assert/strict";
import handler, {
  fuseChartWithOptionChain,
  evaluateActiveTradeLifecycle,
  sendTelegramAlert,
} from "../api/tv-webhook.js";

function createMockReqRes({ method = "POST", body = {}, query = {}, headers = {} } = {}) {
  const req = {
    method,
    body: typeof body === "string" ? body : JSON.stringify(body),
    query,
    headers,
  };

  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    send(data) {
      this.body = data;
      return this;
    },
    end() {
      return this;
    },
  };

  return { req, res };
}

test("E2E Simulation: Wednesday 09:30 AM - 15m SYNERGY_BEAR with Real Call Blitz approves 2 Lots", () => {
  const tvAlert15m = {
    sym: "NSE:NIFTY",
    tf: "15",
    swingTf: "125m",
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 24960, // Below 25000 floor breakdown
    sl: 25025,
    cappedSl: 25025,
    rDist: 65,
    t1Dist: 65,
    t2Dist: 130,
    t1: 24895,
    t2: 24830,
    actRoof: 25200,
    actFloor: 25000,
    futQuad: "SHORT_BUILDUP",
  };

  const liveWednesdayScanner = {
    corridor: {
      deltaPCR: 0.58, // Institutional Call Writing Blitz
      floorStrike: 25000,
      roofStrike: 25200,
    },
    smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BEARISH_SYNERGY" },
    futures: { quadrant: "SHORT_BUILDUP" },
  };

  const verdict = fuseChartWithOptionChain(tvAlert15m, liveWednesdayScanner);
  assert.equal(verdict.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(verdict.recommendedLots, 2);
  assert.equal(verdict.tier, "HIGH_CONVICTION_SYNERGY");
  assert.equal(verdict.timeframe, "15");
  assert.equal(verdict.stopLoss, 25025);
  assert.equal(verdict.target1Price, 24895);
  assert.equal(verdict.target2Price, 24830);
  assert.match(verdict.reasoning, /HIGH CONVICTION BEAR SYNERGY VERIFIED/);
});

test("E2E Simulation: Wednesday 09:30 AM - 15m SYNERGY_BEAR VETOED if Put writers defend 25,000", () => {
  const tvAlert15m = {
    sym: "NSE:NIFTY",
    tf: "15",
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 25020, // Bouncing at floor
    sl: 25085,
    cappedSl: 25085,
    rDist: 65,
    actFloor: 25000,
  };

  const defendingFloorScanner = {
    corridor: {
      deltaPCR: 1.12, // Put writers defending
      floorStrike: 25000,
      roofStrike: 25200,
    },
    futures: { quadrant: "LONG_UNWINDING" },
  };

  const verdict = fuseChartWithOptionChain(tvAlert15m, defendingFloorScanner);
  assert.equal(verdict.decision, "VETO_DIVERGENT_SYNERGY");
  assert.equal(verdict.recommendedLots, 0);
  assert.match(verdict.reasoning, /VETOED.*Floor defense near 25000/);
});

test("E2E Simulation: Wednesday 11:20 AM - 125m SYNERGY_BEAR with Call Blitz confirms 2 Lots & HTF Hold", () => {
  const tvAlert125m = {
    sym: "NSE:NIFTY",
    tf: "125",
    swingTf: "125m",
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 24920,
    sl: 25075,
    cappedSl: 25075,
    rDist: 155,
    t1Dist: 155,
    t2Dist: 310,
    t1: 24765,
    t2: 24610,
    actRoof: 25200,
    actFloor: 25000,
    futQuad: "SHORT_BUILDUP",
  };

  const confirmed125mScanner = {
    corridor: {
      deltaPCR: 0.60,
      floorStrike: 25000,
      roofStrike: 25200,
    },
    smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BEARISH_SYNERGY" },
    futures: { quadrant: "SHORT_BUILDUP" },
  };

  const verdict = fuseChartWithOptionChain(tvAlert125m, confirmed125mScanner);
  assert.equal(verdict.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(verdict.recommendedLots, 2);
  assert.equal(verdict.timeframe, "125");
  assert.equal(verdict.stopLoss, 25075);
  assert.equal(verdict.target1Price, 24765);
  assert.equal(verdict.target2Price, 24610);
  assert.equal(verdict.riskPoints, 155);
});

test("E2E Simulation: Wednesday 11:20 AM - 125m SYNERGY_BEAR with SL 25,236 VETOED when Option Chain has Put Support (Monday Scenario)", () => {
  const tvAlert125mNov9 = {
    sym: "NSE:NIFTY",
    tf: "125",
    swingTf: "125m",
    dir: "SHORT",
    grade: "SYNERGY_BEAR",
    close: 25082,
    sl: 25236, // Monday candle stop loss!
    cappedSl: 25236,
    rDist: 154,
    actFloor: 25000,
    actRoof: 25200,
  };

  const liveOptionChainNov9 = {
    corridor: {
      deltaPCR: 1.07, // Real option chain was neutral/put bias, NOT call blitz!
      floorStrike: 25000,
      roofStrike: 25200,
    },
    futures: { quadrant: "LONG_UNWINDING" },
  };

  const verdict = fuseChartWithOptionChain(tvAlert125mNov9, liveOptionChainNov9);
  assert.equal(verdict.decision, "VETO_DIVERGENT_SYNERGY");
  assert.equal(verdict.recommendedLots, 0);
  assert.match(verdict.reasoning, /VETOED.*Floor defense near 25000/);
});

test("E2E Simulation: Wednesday 11:20 AM - 125m SYNERGY_BULL approves 2 Lots when Put Blitz verifies", () => {
  const tvAlert125mBull = {
    sym: "NSE:NIFTY",
    tf: "125",
    swingTf: "125m",
    dir: "LONG",
    grade: "SYNERGY_BULL",
    close: 25180,
    sl: 25040,
    cappedSl: 25040,
    rDist: 140,
    t1Dist: 140,
    t2Dist: 280,
    t1: 25320,
    t2: 25460,
    actFloor: 25000,
    actRoof: 25400,
  };

  const liveOptionChainBull = {
    corridor: {
      deltaPCR: 1.45, // Heavy Put Writing Blitz
      floorStrike: 25000,
      roofStrike: 25400,
    },
    smartMoneyFusion: { primaryScenario: "HIGH_CONVICTION_BULLISH_SYNERGY" },
    futures: { quadrant: "LONG_BUILDUP" },
  };

  const verdict = fuseChartWithOptionChain(tvAlert125mBull, liveOptionChainBull);
  assert.equal(verdict.decision, "EXECUTE_HIGH_CONVICTION_SYNERGY");
  assert.equal(verdict.recommendedLots, 2);
  assert.equal(verdict.timeframe, "125");
  assert.equal(verdict.stopLoss, 25040);
  assert.equal(verdict.target1Price, 25320);
  assert.equal(verdict.target2Price, 25460);
});

test("E2E Simulation: Trade Lifecycle - 125m Swing Trade executes T1, moves SL to cost, and exits at T2", async () => {
  const swingTrade = {
    active: true,
    grade: "SYNERGY_BEAR",
    direction: "SHORT",
    timeframe: "125",
    entryPrice: 24920,
    stopLoss: 25075,
    riskPoints: 155,
    target1Price: 24765,
    target2Price: 24610,
    target1Dist: 155,
    target2Dist: 310,
    hitT1: false,
  };

  let store = { "nifty:tv:active_trade": JSON.stringify(swingTrade) };
  let list = [];
  const mockRedis = {
    async get(k) { return store[k] || null; },
    async set(k, v) { store[k] = v; return "OK"; },
    async del(k) { delete store[k]; return 1; },
    async lpush(k, v) { list.unshift(v); return list.length; },
  };

  // 1. Price drops to 24750 (breaks below T1 of 24765)
  const resT1 = await evaluateActiveTradeLifecycle(24750, 24920, 24750, mockRedis);
  assert.equal(resT1?.event, "TARGET_1_HIT");
  assert.equal(resT1?.activeTrade.hitT1, true);
  assert.equal(resT1?.activeTrade.stopLoss, 24920); // Moved to cost!
  assert.equal(resT1?.activeTrade.slAtCost, true);

  // 2. Next bar drops to 24600 (hits T2 of 24610)
  const resT2 = await evaluateActiveTradeLifecycle(24600, 24750, 24590, mockRedis);
  assert.equal(resT2?.event, "TARGET_2_HIT");
  assert.equal(resT2?.exitRecord.exitReason, "TARGET_2_HIT");
  assert.equal(resT2?.exitRecord.exitPrice, 24610);
  assert.ok(resT2?.exitRecord.netPnl > 200); // 155*0.6 + 310*0.4 - 4 = ~213 pts net profit!
  assert.equal(store["nifty:tv:active_trade"], undefined); // Position closed cleanly!
});

test("E2E Simulation: HTTP Handler rejects unauthorized or invalid requests gracefully", async () => {
  // Test invalid method
  const { req: getReq, res: getRes } = createMockReqRes({ method: "PUT" });
  await handler(getReq, getRes);
  assert.equal(getRes.statusCode, 405);
  assert.match(getRes.body.error, /Method Not Allowed/);

  // Test status endpoint
  const { req: statusReq, res: statusRes } = createMockReqRes({ method: "GET", query: { action: "status" } });
  await handler(statusReq, statusRes);
  assert.equal(statusRes.statusCode, 200);
  assert.equal(statusRes.body.success, true);
  assert.equal(statusRes.body.status, "FLAT_NO_ACTIVE_TRADES");
});
