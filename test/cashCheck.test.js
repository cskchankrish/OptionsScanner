import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePendingEodRows,
  cashCheckDatesNeeded,
  cashCheckFromOpen,
  computeEodTrackStats,
  EOD_CASH_CHECK,
} from "../src/eodTrackRecord.js";

// A NO CARRY row used to keep "Next Open: —" forever: only carry rows were resolved from the next
// session. Now the next open is recorded and the day is checked: correct when the open is within
// ±0.35% of the carry spot.

const cashRow = (isoDate, entrySpot) => ({
  id: `eod_${isoDate}`, isoDate, date: isoDate, verdict: "EXIT TO CASH / DO NOT CARRY", bias: "NEUTRAL",
  score: 0, outcome: "PRESERVED_CASH", entrySpot, nextDayOpen: null, gapPts: null, source: "recorded", provisional: false,
});
const tick = (minutes, spot) => ({ time: `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`, minutes, spot, isLiveTick: true });
const tuesdayOpen = [tick(555, 25277.3), tick(556, 25312), tick(557, 25329.85)];

test("cashCheckFromOpen: band edges and direction", () => {
  assert.equal(cashCheckFromOpen(25000, 25087).check, EOD_CASH_CHECK.CORRECT); // +0.348%
  assert.equal(cashCheckFromOpen(25000, 25090).check, EOD_CASH_CHECK.MISSED_UP); // +0.36%
  assert.equal(cashCheckFromOpen(25000, 24910).check, EOD_CASH_CHECK.MISSED_DOWN);
  assert.equal(cashCheckFromOpen(0, 25000), null);
});

test("Monday 16-Nov no-carry: Tuesday's open fills Next Open and the check (correct)", () => {
  const [row] = resolvePendingEodRows([cashRow("2026-11-16", 25291.1)], { todayIso: "2026-11-17", todayTimeline: tuesdayOpen });
  assert.equal(row.outcome, "PRESERVED_CASH", "a cash day is never turned into a win/loss");
  assert.equal(row.nextDayOpen, 25277.3);
  assert.equal(row.openGapPts, -13.8);
  assert.equal(row.cashCheck, EOD_CASH_CHECK.CORRECT);
  assert.equal(row.gapPts, null, "gapPts stays carry-only (net points never include cash days)");
  assert.match(row.notes, /No carry\. Next open 25277\.3 \(-13\.8 pts/);
});

test("today's own no-carry row waits for the next session", () => {
  const r = cashRow("2026-11-17", 25387.4);
  const [row] = resolvePendingEodRows([r], { todayIso: "2026-11-17", todayTimeline: tuesdayOpen });
  assert.equal(row.nextDayOpen, null);
  assert.equal(row.cashCheck, undefined);
});

test("past no-carry row: next session's timeline supplied → checked; empty → open not recorded; not read → retried", () => {
  const friday = cashRow("2026-11-13", 25144.3);
  const monday = [tick(555, 25206.15), tick(556, 25210)];
  assert.deepEqual(cashCheckDatesNeeded([friday], "2026-11-17"), ["2026-11-16"]);

  const [checked] = resolvePendingEodRows([friday], { todayIso: "2026-11-17", timelinesByDate: { "2026-11-16": monday } });
  assert.equal(checked.nextDayOpen, 25206.15);
  assert.equal(checked.cashCheck, EOD_CASH_CHECK.CORRECT); // +0.246%

  const [missing] = resolvePendingEodRows([friday], { todayIso: "2026-11-17", timelinesByDate: { "2026-11-16": [] } });
  assert.equal(missing.cashCheck, EOD_CASH_CHECK.OPEN_NOT_RECORDED);
  assert.equal(missing.outcome, "PRESERVED_CASH");

  const [retry] = resolvePendingEodRows([friday], { todayIso: "2026-11-17", timelinesByDate: null });
  assert.equal(retry.cashCheck, undefined, "a timeline that was not read leaves the row for a later refresh");
  assert.deepEqual(cashCheckDatesNeeded([checked], "2026-11-17"), [], "checked rows need no further reads");
});

test("carry rows are resolved exactly as before", () => {
  const carry = { ...cashRow("2026-11-16", 25291.1), verdict: "CARRY NIFTY CE (BTST)", bias: "BULLISH", outcome: "PENDING" };
  const [row] = resolvePendingEodRows([carry], { todayIso: "2026-11-17", todayTimeline: tuesdayOpen });
  assert.equal(row.outcome, "LOSS");
  assert.equal(row.gapPts, -13.8);
  assert.equal(row.cashCheck, undefined);
});

test("stats: no-carry accuracy counted separately; carry win rate and net points untouched", () => {
  const rows = resolvePendingEodRows(
    [cashRow("2026-11-16", 25291.1), { ...cashRow("2026-11-13", 25144.3), cashCheck: "MISSED_UP" }],
    { todayIso: "2026-11-17", todayTimeline: tuesdayOpen },
  );
  const s = computeEodTrackStats(rows).live;
  assert.equal(s.cashDays, 2);
  assert.equal(s.cashChecked, 2);
  assert.equal(s.cashCorrect, 1);
  assert.equal(s.resolved, 0);
  assert.equal(s.netPts, 0);
});
