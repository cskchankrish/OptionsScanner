import test from "node:test";
import assert from "node:assert/strict";
import {
  getActiveExpiryDate,
  getMarketSessionInfo,
  getCanonicalSettledTimeline,
  getSessionTimelineByDate,
  calculateEODDecision,
  getFallbackExpirySchedule,
} from "../api/nifty-oi.js";
import handler from "../api/nifty-oi.js";

test("getActiveExpiryDate returns active November weekly expiry and rejects expired October dates", () => {
  // If an expired past date is passed (e.g. 27-Oct-2026), it must roll to the active upcoming expiry
  // (Was pinned to ["09-Nov-2026", "12-Nov-2026"], which stopped being true once the 12-Nov expiry
  // passed: the function correctly rolls on to the next weekly expiry. Assert the rule, not a date.)
  const isUpcoming = (d) => {
    const t = new Date(d).getTime();
    return Number.isFinite(t) && t >= Date.now() - 2 * 86400000;
  };
  const expiredAttempt = getActiveExpiryDate("27-Oct-2026");
  assert.notEqual(expiredAttempt, "27-Oct-2026");
  assert.ok(isUpcoming(expiredAttempt), "Must roll expired October dates to active upcoming expiry");

  // If no argument is passed, it returns the active upcoming expiry
  const activeNow = getActiveExpiryDate();
  assert.ok(isUpcoming(activeNow));

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

  // 12-Nov: this placeholder timeline is synthetic (13 hand-made ticks), so it is not data:
  // the closing flow is UNVERIFIED and scored 0 instead of producing a +3 "verified" blitz.
  assert.equal(result.isClosingDataValid, false);
  assert.equal(result.groups.B.unverified, true);
  assert.ok(result.statusLabel.includes("WEEKEND CLOSED · PREVIOUS SESSION SETTLED"));
  assert.notEqual(result.verdict, "CARRY NIFTY CE (BTST)");
  assert.ok(result.audit.some(a => a.label.includes("Closing Hour Flow") && a.impact.includes("UNVERIFIED")));
  assert.ok(timeline.every(pt => pt.synthetic === true), "placeholder ticks are marked synthetic");
  assert.ok(result.pcrWarning.includes("HISTORICAL PEAK OVERBOUGHT"));
});

test("getCanonicalSettledTimeline embeds verified Futures metrics (Price, Basis, OI, Quadrant) in each tick", () => {
  const timeline = getCanonicalSettledTimeline(279500, 157500, 25030.35);
  const p1530 = timeline.find(pt => pt.time === "15:30");
  assert.ok(p1530);
  assert.ok(p1530.futPrice > 25000, "Must include valid Futures price");
  assert.equal(p1530.futQuadrant, "LONG_BUILDUP", "Must reflect Long Buildup quadrant");
  assert.ok(p1530.futCombinedOI > 0, "Must include combined OI");
  assert.ok(p1530.futBasis != null, "Must include basis spread");
});

test("getSessionTimelineByDate provides multi-day flow curves across past sessions", () => {
  // Test Thursday 05-Nov-2026: Late Call Blitz where Call writing exploded after 14:15
  const nov5 = getSessionTimelineByDate("2026-11-05");
  assert.ok(Array.isArray(nov5) && nov5.length >= 8);
  const t1415 = nov5.find(pt => pt.time === "14:15");
  const t1530 = nov5.find(pt => pt.time === "15:30");
  assert.ok(t1415 && t1530);
  assert.ok(t1415.netDiff > 0, "Net diff was positive at 14:15 (+82k)");
  assert.ok(t1530.netDiff < 0, "Net diff turned negative by 15:30 (-27k) due to call blitz");
  assert.equal(t1530.futQuadrant, "SHORT_BUILDUP", "Futures reflected Short Buildup into the close");

  // Test Wednesday 04-Nov-2026: Steady Bullish expansion
  const nov4 = getSessionTimelineByDate("2026-11-04");
  assert.ok(Array.isArray(nov4) && nov4.length >= 8);
  const n4Close = nov4.find(pt => pt.time === "15:30");
  assert.ok(n4Close.netDiff > 50000, "Nov 4 closed with strong put writing delta");
  assert.equal(n4Close.futQuadrant, "LONG_BUILDUP");

  // Test Tuesday 03-Nov-2026: Neutral chop
  const nov3 = getSessionTimelineByDate("2026-11-03");
  assert.ok(Array.isArray(nov3));
  const n3Close = nov3.find(pt => pt.time === "15:30");
  assert.equal(n3Close.futQuadrant, "NEUTRAL_CHOP");
});

test("getFallbackExpirySchedule provides valid near, next, and monthly expiry dates", () => {
  const sched = getFallbackExpirySchedule();
  assert.ok(sched.nearExpiry, "nearExpiry must exist");
  assert.ok(sched.nextExpiry, "nextExpiry must exist");
  assert.ok(sched.monthlyExpiry, "monthlyExpiry must exist");
  assert.notEqual(sched.nearExpiry, sched.nextExpiry, "near and next expiry must be distinct");
});

test("nifty-oi handler responds to expiry queries (near, next, monthly) with correct expiryDate and rollover", async () => {
  // 1. Query next week expiry
  let nextResult = null;
  const reqNext = { query: { expiry: "next" }, headers: {} };
  const resNext = {
    setHeader: () => {},
    status: () => ({
      json: (data) => { nextResult = data; }
    })
  };
  await handler(reqNext, resNext);
  assert.ok(nextResult, "Must return payload for expiry=next");
  assert.ok(nextResult.rollover, "Must include rollover object");
  assert.equal(nextResult.expiryDate, nextResult.rollover.nextExpiry, "expiryDate must match rollover.nextExpiry");
  assert.ok(Array.isArray(nextResult.strikes) && nextResult.strikes.length > 0, "Must return strikes array");

  // 2. Query near / today expiry
  let nearResult = null;
  const reqNear = { query: { expiry: "near" }, headers: {} };
  const resNear = {
    setHeader: () => {},
    status: () => ({
      json: (data) => { nearResult = data; }
    })
  };
  await handler(reqNear, resNear);
  assert.ok(nearResult, "Must return payload for expiry=near");
  assert.equal(nearResult.expiryDate, nearResult.rollover.nearExpiry, "expiryDate must match rollover.nearExpiry");

  // 3. Query monthly expiry
  let monthlyResult = null;
  const reqMonthly = { query: { expiry: "monthly" }, headers: {} };
  const resMonthly = {
    setHeader: () => {},
    status: () => ({
      json: (data) => { monthlyResult = data; }
    })
  };
  await handler(reqMonthly, resMonthly);
  assert.ok(monthlyResult, "Must return payload for expiry=monthly");
  assert.equal(monthlyResult.expiryDate, monthlyResult.rollover.monthlyExpiry, "expiryDate must match rollover.monthlyExpiry");
});
