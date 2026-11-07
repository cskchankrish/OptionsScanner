import test from "node:test";
import assert from "node:assert/strict";
import {
  parseNseFuturesPayload,
  classifyFuturesQuadrant,
  evaluateSmartMoneyFusion,
  ANNUALIZED_RISK_FREE_RATE,
  PRICE_DEADBAND_PCT,
  OI_DEADBAND_PCT
} from "../src/smartMoneyFusion.js";

test("1. Rollover Aggregation Test: sums OI and changeInOI across Near and Next month contracts", () => {
  // During expiry week, near month OI sheds -35,000 as positions roll to next month (+42,000)
  // Overall institutional flow is actually +7,000 Net Long addition, NOT Long Unwinding!
  const mockPayload = {
    data: [
      {
        underlying: "NIFTY",
        instrumentType: "FUTIDX",
        identifier: "FUTIDXNIFTY28-NOV-2026XX0.00",
        expiryDate: "2026-11-28",
        lastPrice: 25100,
        change: 120,
        pChange: 0.48,
        openInterest: 150000,
        changeinOpenInterest: -35000, // Near month unwinds
        underlyingValue: 25050,
        totalTradedVolume: 5000000
      },
      {
        underlying: "NIFTY",
        instrumentType: "FUTIDX",
        identifier: "FUTIDXNIFTY31-DEC-2026XX0.00",
        expiryDate: "2026-12-31",
        lastPrice: 25220,
        change: 125,
        pChange: 0.50,
        openInterest: 60000,
        changeinOpenInterest: 42000, // Next month absorbs rollover + fresh addition
        underlyingValue: 25050,
        totalTradedVolume: 1000000
      }
    ]
  };

  const metrics = parseNseFuturesPayload(mockPayload, 25050);
  assert.ok(metrics, "Must successfully parse payload");

  // Verify Combined Metrics
  assert.equal(metrics.nearOI, 150000);
  assert.equal(metrics.nextOI, 60000);
  assert.equal(metrics.combinedOI, 210000); // 150k + 60k

  assert.equal(metrics.nearChgOI, -35000);
  assert.equal(metrics.nextChgOI, 42000);
  assert.equal(metrics.combinedChgOI, 7000); // Net positive (+7k), protecting against false unwinding!

  assert.ok(metrics.combinedOiChangePct > 0, "Combined change in OI must be positive");
  assert.equal(metrics.lastPrice, 25100, "Uses Near month contract for LTP");
  assert.equal(metrics.rawBasis, 50.00, "25100 - 25050 = 50 pts");
});

test("2. Fair-Value Basis Test: accurately computes theoretical cost-of-carry and adjusted basis spread", () => {
  const spot = 25000;
  // Let's test with a simulated contract with 20 DTE
  // Fair Basis = 25000 * (0.068 * 20 / 365) = 93.15 pts
  const fixedNow = Date.now();
  const futureExpiry = new Date(fixedNow + 20 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const mockPayload = {
    data: [
      {
        underlying: "NIFTY",
        instrumentType: "FUTIDX",
        expiryDate: futureExpiry,
        lastPrice: 25110, // Raw Basis = +110
        change: 50,
        pChange: 0.2,
        openInterest: 100000,
        changeinOpenInterest: 2000,
        underlyingValue: spot
      }
    ]
  };

  const metrics = parseNseFuturesPayload(mockPayload, spot);
  assert.equal(metrics.rawBasis, 110.00);
  assert.ok(metrics.dte >= 19 && metrics.dte <= 21);

  // Fair Basis should be approx ~93 pts
  assert.ok(metrics.fairBasis > 85 && metrics.fairBasis < 100);
  // Adjusted Basis Spread should be approx +110 - ~93 = ~+17 pts (Bullish Premium)
  assert.ok(metrics.adjustedBasisSpread > 10 && metrics.adjustedBasisSpread < 25);
});

test("3. Deadband Noise Filter Test: classifies minor price or OI fluctuations as NEUTRAL_CHOP", () => {
  // Case A: Price moved only +5 pts on Nifty 25,000 (+0.02% < 0.08% deadband)
  const deadbandPrice = classifyFuturesQuadrant({
    priceChangePct: 0.03, // inside 0.08% deadband
    combinedOiChangePct: 2.5,
    priceChange: 7.5
  });
  assert.equal(deadbandPrice.quadrant, "NEUTRAL_CHOP");
  assert.equal(deadbandPrice.bias, "NEUTRAL");

  // Case B: Price moved +100 pts (+0.40%), but OI moved only +0.10% (< 0.25% deadband)
  const deadbandOI = classifyFuturesQuadrant({
    priceChangePct: 0.40,
    combinedOiChangePct: 0.12, // inside 0.25% deadband
    priceChange: 100
  });
  assert.equal(deadbandOI.quadrant, "NEUTRAL_CHOP");
  assert.equal(deadbandOI.bias, "NEUTRAL");

  // Case C: Real trend outside deadbands (Price +0.65%, OI +3.2%) -> LONG BUILDUP
  const activeTrend = classifyFuturesQuadrant({
    priceChangePct: 0.65,
    combinedOiChangePct: 3.2,
    priceChange: 160
  });
  assert.equal(activeTrend.quadrant, "LONG_BUILDUP");
  assert.equal(activeTrend.bias, "BULLISH");
});

test("4. Bullish & Bearish Synergy Tests: verifies High-Conviction BTST and STBT", () => {
  // Case A: Bullish Synergy
  const bullFut = {
    priceChangePct: 0.75,
    combinedOiChangePct: 2.8,
    priceChange: 180,
    rawBasis: 35,
    adjustedBasisSpread: 8,
    intradayBasisDelta: 12
  };
  const bullOpt = {
    deltaPcr: 1.55,
    pcr: 1.25,
    totalPutWriting: 300000,
    totalCallWriting: 120000
  };
  const bullFusion = evaluateSmartMoneyFusion(bullFut, bullOpt);
  assert.equal(bullFusion.scenarioId, "BULLISH_SYNERGY");
  assert.equal(bullFusion.actionableVerdict, "High-Conviction BTST");
  assert.equal(bullFusion.scoreBoost, 1);
  assert.equal(bullFusion.eodCarryVeto, null);

  // Case B: Bearish Synergy
  const bearFut = {
    priceChangePct: -0.80,
    combinedOiChangePct: 3.5,
    priceChange: -195,
    rawBasis: -15, // Discount
    adjustedBasisSpread: -35,
    intradayBasisDelta: -18
  };
  const bearOpt = {
    deltaPcr: 0.55,
    pcr: 0.82,
    totalPutWriting: 90000,
    totalCallWriting: 280000
  };
  const bearFusion = evaluateSmartMoneyFusion(bearFut, bearOpt);
  assert.equal(bearFusion.scenarioId, "BEARISH_SYNERGY");
  assert.equal(bearFusion.actionableVerdict, "High-Conviction STBT");
  assert.equal(bearFusion.scoreBoost, -1);
  assert.equal(bearFusion.eodCarryVeto, null);
});

test("5. Bull Trap Veto Test: Short-Covering in Futures + Roof Call Writing Blitz triggers VETO_BTST", () => {
  // Price is rising (+0.55%), but Futures OI is dropping (-2.1%) -> SHORT COVERING ONLY
  const trapFut = {
    priceChangePct: 0.55,
    combinedOiChangePct: -2.1,
    priceChange: 135,
    rawBasis: 10,
    adjustedBasisSpread: -5
  };
  // Meanwhile, Options show heavy Call writing at Roof (deltaPcr 0.65)
  const trapOpt = {
    deltaPcr: 0.65,
    pcr: 1.10,
    totalPutWriting: 80000,
    totalCallWriting: 220000,
    roofCallWritingBlitz: true
  };

  const fusion = evaluateSmartMoneyFusion(trapFut, trapOpt);
  assert.equal(fusion.scenarioId, "BULL_TRAP");
  assert.ok(fusion.badge.includes("BULL TRAP DETECTED"));
  assert.equal(fusion.eodCarryVeto, "VETO_BTST", "Must enforce VETO_BTST");
  assert.equal(fusion.scoreBoost, -1);
  assert.ok(fusion.actionableVerdict.includes("Veto Longs / Short with Strict SL"));
});

test("6. Bear Trap Veto Test: Long-Unwinding in Futures + Floor Put Writing Blitz triggers VETO_STBT", () => {
  // Price is dropping (-0.60%), but Futures OI is dropping (-2.8%) -> LONG UNWINDING (No aggressive shorts)
  const dipFut = {
    priceChangePct: -0.60,
    combinedOiChangePct: -2.8,
    priceChange: -150,
    rawBasis: 5,
    adjustedBasisSpread: -10
  };
  // Meanwhile, Options show aggressive Put underwriting at Floor Support (deltaPcr 1.45)
  const dipOpt = {
    deltaPcr: 1.45,
    pcr: 0.95,
    totalPutWriting: 250000,
    totalCallWriting: 100000,
    floorPutWritingBlitz: true
  };

  const fusion = evaluateSmartMoneyFusion(dipFut, dipOpt);
  assert.equal(fusion.scenarioId, "BEAR_TRAP");
  assert.ok(fusion.badge.includes("BEAR TRAP"));
  assert.equal(fusion.eodCarryVeto, "VETO_STBT", "Must enforce VETO_STBT");
  assert.equal(fusion.scoreBoost, 1);
  assert.ok(fusion.actionableVerdict.includes("Veto Shorts / Buy Dips at Support"));
});
