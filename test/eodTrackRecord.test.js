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
  assert.equal(normalizeDateToIso("30-Oct-2026"), "2026-10-30");
  assert.equal(normalizeDateToIso("30-10-2026"), "2026-10-30");
});

test("formatIsoToDisplayDate formats YYYY-MM-DD to DD-MMM-YYYY", () => {
  assert.equal(formatIsoToDisplayDate("2026-11-05"), "05-Nov-2026");
  assert.equal(formatIsoToDisplayDate("2026-11-04"), "04-Nov-2026");
  assert.equal(formatIsoToDisplayDate("2026-10-30"), "30-Oct-2026");
});

test("CANONICAL_EOD_SEED_HISTORY contains verified 05-Nov-2026 Cash Preservation session and zero duplicates", () => {
  const nov5 = CANONICAL_EOD_SEED_HISTORY.find(h => h.date === "05-Nov-2026" || h.isoDate === "2026-11-05");
  assert.ok(nov5, "05-Nov-2026 must be present in canonical seed history");
  assert.equal(nov5.verdict, "EXIT TO CASH / DO NOT CARRY");
  assert.equal(nov5.outcome, "PRESERVED_CASH");
  assert.equal(nov5.entrySpot, 24536.60);
  assert.equal(nov5.nextDayOpen, 24538.20);
  assert.equal(nov5.gapPts, 1.60);

  // Verify uniqueness of all sessions
  const isoDates = CANONICAL_EOD_SEED_HISTORY.map(h => h.isoDate);
  const uniqueIsoDates = new Set(isoDates);
  assert.equal(isoDates.length, uniqueIsoDates.size, "Seed history must have no duplicate dates");

  // Verify all historical sessions have verified positive entrySpot and nextDayOpen (except pending latest)
  for (const h of CANONICAL_EOD_SEED_HISTORY) {
    const dt = new Date(h.isoDate + "T12:00:00Z");
    const day = dt.getDay();
    assert.ok(day >= 1 && day <= 5, `${h.isoDate} must be a weekday trading session, got day ${day}`);
    assert.ok(h.entrySpot > 20000 && h.entrySpot < 30000, `${h.isoDate} entrySpot must be authentic Nifty spot quote`);
    if (h.outcome !== "PENDING") {
      assert.ok(h.nextDayOpen > 20000 && h.nextDayOpen < 30000, `${h.isoDate} nextDayOpen must be authentic Nifty spot quote`);
    }
  }
});

test("mergeEodHistory completely eliminates duplicates from mixed date formats", () => {
  const localHistoryWithDmy = [
    { id: "eod_04-11-2026", date: "04-11-2026", verdict: "CARRY NIFTY CE (BTST)", outcome: "WIN" },
    { id: "eod_03-11-2026", date: "03-11-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
    { id: "eod_30-10-2026", date: "30-10-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
  ];

  const serverHistoryWithNamedMonth = [
    { id: "eod_2026-11-05", date: "05-Nov-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
    { id: "eod_2026-11-04", date: "04-Nov-2026", verdict: "CARRY NIFTY CE (BTST)", outcome: "WIN" },
    { id: "eod_2026-11-03", date: "03-Nov-2026", verdict: "EXIT TO CASH / DO NOT CARRY", outcome: "PRESERVED_CASH" },
  ];

  const merged = mergeEodHistory(localHistoryWithDmy, serverHistoryWithNamedMonth);

  // Exactly 4 unique sessions: 05-Nov, 04-Nov, 03-Nov, 30-Oct
  assert.equal(merged.length, 4, `Expected 4 deduplicated sessions, got ${merged.length}`);

  // Chronological ordering check
  assert.equal(merged[0].date, "05-Nov-2026");
  assert.equal(merged[1].date, "04-Nov-2026");
  assert.equal(merged[2].date, "03-Nov-2026");
  assert.equal(merged[3].date, "30-Oct-2026");

  // Clean uniform IDs and dates
  for (const item of merged) {
    assert.match(item.id, /^eod_\d{4}-\d{2}-\d{2}$/);
    assert.match(item.date, /^\d{2}-[A-Z][a-z]{2}-\d{4}$/);
  }
});
