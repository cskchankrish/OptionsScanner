import test from "node:test";
import assert from "node:assert/strict";
import {
  getActiveExpiryDate,
  getMarketSessionInfo,
  getCanonicalSettledTimeline,
  calculateEODDecision,
} from "../api/nifty-oi.js";

test("getActiveExpiryDate returns active November weekly expiry and rejects expired October dates", () => {
  // If an expired past date is passed (e.g. 27-Oct-2026), it must roll to the active upcoming Diwali week Monday expiry
  const expiredAttempt = getActiveExpiryDate("27-Oct-2026");
  assert.equal(expiredAttempt, "09-Nov-2026", "Must roll expired October dates to active 09-Nov-2026 expiry");

  // If no argument is passed on Saturday 07-Nov-2026, it must return 09-Nov-2026
  const activeNow = getActiveExpiryDate();
  assert.equal(activeNow, "09-Nov-2026");

  // If a valid future expiry is passed, it preserves it
  const validFuture = getActiveExpiryDate("26-Nov-2026");
  assert.equal(validFuture, "26-Nov-2026");
});

test("getMarketSessionInfo identifies Saturday weekend and schedules next open for Sunday Diwali Muhurat", () => {
  const sessionInfo = getMarketSessionInfo();
  // Today is Saturday Nov 7
  if (sessionInfo.isSaturday) {
    assert.equal(sessionInfo.isLiveMarket, false);
    assert.equal(sessionInfo.isPostMarketSettled, true);
    assert.ok(sessionInfo.nextOpenDescription.includes("Diwali Muhurat"));
  }
});

test("getCanonicalSettledTimeline provides verified closing window (14:15 to 15:30) with +1.0L closing flow", () => {
  const timeline = getCanonicalSettledTimeline(279500, 157500, 25030.35);
  assert.ok(Array.isArray(timeline));
  assert.ok(timeline.length >= 10);

  const p1415 = timeline.find(pt => pt.time === "14:15");
  const p1530 = timeline.find(pt => pt.time === "15:30");
  assert.ok(p1415, "14:15 anchor tick must be present");
  assert.ok(p1530, "15:30 closing tick must be present");

  const closingHourDelta = p1530.netDiff - p1415.netDiff;
  assert.equal(closingHourDelta, 100000, "Must reflect +1.0L lots institutional closing flow");

  // Verify that calculateEODDecision on Saturday passes with verified settled data (PCR 1.66)
  const result = calculateEODDecision({
    spot: 25030.35,
    floorStrike: 25000,
    roofStrike: 25200,
    totPutWriting: 279500,
    totCallWriting: 157500,
    pcr: 1.66,
    deltaPcr: 1.58,
    timeline,
    dayOfWeek: 6, // Saturday
    nowMins: 676, // 11:16 AM
    fusion: { verdict: "HIGH_CONVICTION_BTST", scoreBoost: 2 },
  });

  assert.equal(result.isClosingDataValid, true);
  assert.ok(result.statusLabel.includes("WEEKEND CLOSED · PREVIOUS SESSION SETTLED"));
  assert.equal(result.verdict, "CARRY NIFTY CE (BTST)");
  assert.ok(result.audit.some(a => a.label.includes("Closing Hour Flow") && a.impact.includes("+3 pts")));
  assert.ok(result.pcrWarning.includes("HISTORICAL PEAK OVERBOUGHT"));
});
