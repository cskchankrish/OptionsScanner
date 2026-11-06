import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeDateToIso,
  formatIsoToDisplayDate,
  CANONICAL_EOD_SEED_HISTORY,
  mergeEodHistory
} from "../src/eodTrackRecord.js";

test("normalizeDateToIso standardizes all date formats to YYYY-MM-DD", () => {
  assert.equal(normalizeDateToIso("05-Nov-2026"), "2026-11-05");
  assert.equal(normalizeDateToIso("04-11-2026"), "2026-11-04");
  assert.equal(normalizeDateToIso("4/11/2026"), "2026-11-04");
  assert.equal(normalizeDateToIso("2026-11-04"), "2026-11-04");
  assert.equal(normalizeDateToIso("eod_2026-11-04"), "2026-11-04");
  assert.equal(normalizeDateToIso("eod_04-11-2026"), "2026-11-04");
  assert.equal(normalizeDateToIso("31-Oct-2026"), "2026-10-31");
  assert.equal(normalizeDateToIso("31-10-2026"), "2026-10-31");
});

test("formatIsoToDisplayDate formats YYYY-MM-DD to DD-MMM-YYYY", () => {
  assert.equal(formatIsoToDisplayDate("2026-11-05"), "05-Nov-2026");
  assert.equal(formatIsoToDisplayDate("2026-11-04"), "04-Nov-2026");
  assert.equal(formatIsoToDisplayDate("2026-10-31"), "31-Oct-2026");
});

test("CANONICAL_EOD_SEED_HISTORY contains 05-Nov-2026 and has zero duplicates", () => {
  const nov5 = CANONICAL_EOD_SEED_HISTORY.find(h => h.date === "05-Nov-2026" || h.isoDate === "2026-11-05");
  assert.ok(nov5, "05-Nov-2026 must be present in canonical seed history");
  assert.equal(nov5.verdict, "CARRY NIFTY CE (BTST)");
  assert.equal(nov5.outcome, "WIN");

  // Verify uniqueness of all sessions
  const isoDates = CANONICAL_EOD_SEED_HISTORY.map(h => h.isoDate);
  const uniqueIsoDates = new Set(isoDates);
  assert.equal(isoDates.length, uniqueIsoDates.size, "Seed history must have no duplicate dates");
});

test("mergeEodHistory completely eliminates duplicates from mixed date formats", () => {
  const localHistoryWithDmy = [
    { id: "eod_04-11-2026", date: "04-11-2026", verdict: "CARRY NIFTY CE (BTST)", outcome: "WIN" },
    { id: "eod_03-11-2026", date: "03-11-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
    { id: "eod_31-10-2026", date: "31-10-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
  ];

  const serverHistoryWithNamedMonth = [
    { id: "eod_2026-11-05", date: "05-Nov-2026", verdict: "CARRY NIFTY CE (BTST)", outcome: "WIN" },
    { id: "eod_2026-11-04", date: "04-Nov-2026", verdict: "CARRY NIFTY CE (BTST)", outcome: "WIN" },
    { id: "eod_2026-11-03", date: "03-Nov-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
  ];

  const merged = mergeEodHistory(localHistoryWithDmy, serverHistoryWithNamedMonth);

  // Exactly 4 unique sessions: 05-Nov, 04-Nov, 03-Nov, 31-Oct
  assert.equal(merged.length, 4, `Expected 4 deduplicated sessions, got ${merged.length}`);

  // Chronological ordering check
  assert.equal(merged[0].date, "05-Nov-2026");
  assert.equal(merged[1].date, "04-Nov-2026");
  assert.equal(merged[2].date, "03-Nov-2026");
  assert.equal(merged[3].date, "31-Oct-2026");

  // Clean uniform IDs and dates
  for (const item of merged) {
    assert.match(item.id, /^eod_\d{4}-\d{2}-\d{2}$/);
    assert.match(item.date, /^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
  }
});
