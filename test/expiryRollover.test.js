import test from "node:test";
import assert from "node:assert/strict";
import { calculateEODDecision } from "../api/nifty-oi.js";

// 17-Nov-2026 (weekly expiry). Between 14:00 and 15:40 the EXPIRING contract's corridor writing
// collapsed into settlement (puts 21.1L → 6.0L, calls 16.4L → 5.0L), which the closing flow read
// as "put writers closing / support withdrawn" (−2). The next-week (23-Nov) chain is what an
// overnight carry would trade, so on the expiry-day afternoon the closing flow must be scored on it.

const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const lerp = (a, b, f) => a + (b - a) * f;

/** One tick per minute 14:00–15:40. `next(f)` returns the next-chain legs (or null) at fraction f. */
function expiryDay({ next = null, nextFrom = 840 } = {}) {
  const out = [];
  for (let m = 840; m <= 940; m++) {
    const f = (m - 840) / 100;
    const put = Math.round(lerp(2113043, 604643, f));
    const call = Math.round(lerp(1635579, 495744, f));
    const pt = { time: hhmm(m), minutes: m, putWriting: put, callWriting: call, netDiff: put - call, spot: 25400, isLiveTick: true, futPrice: 25420, futCombinedOI: 212000 };
    if (next && m >= nextFrom) {
      const n = next(f);
      if (n) Object.assign(pt, { nextPutWriting: n.put, nextCallWriting: n.call, nextExpiry: "23-Nov-2026" });
    }
    out.push(pt);
  }
  return out;
}

const BASE = {
  spot: 25387.4,
  floorStrike: 25100,
  roofStrike: 25500,
  totPutWriting: 280710,
  totCallWriting: 243730,
  pcr: 1.01,
  deltaPcr: 1.15,
  dayOfWeek: 2,
  nowMins: 940,
  targetContract: "23-Nov-2026",
  isRollover: true,
  futuresQuadrant: { quadrant: "NEUTRAL_CHOP" },
  futuresMetrics: { rawBasis: 20 },
};
const groupB = (r) => r.groups?.B ?? r.card?.rows?.find((x) => x.group === "B");

test("without the rollover the expiring contract's settlement unwind is scored (the 17-Nov fault)", () => {
  const r = calculateEODDecision({ ...BASE, timeline: expiryDay() });
  assert.equal(groupB(r).contribution, -2, "documents the old behaviour this fix removes");
});

test("expiry-day rollover: a flat next-week chain scores 0, whatever the expiring chain does", () => {
  const r = calculateEODDecision({
    ...BASE,
    timeline: expiryDay({ next: () => ({ put: 280000, call: 243000 }) }),
    expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: true },
  });
  const b = groupB(r);
  assert.equal(b.contribution, 0);
  assert.equal(b.unverified, false);
  assert.equal(b.chainExpiry, "23-Nov-2026");
  const row = r.audit.find((a) => a.group === "B" && /Closing/.test(a.label) && !a.isGroupSummary) || r.audit.find((a) => a.group === "B");
  assert.match(row.detail, /next expiry 23-Nov-2026 chain/);
  assert.notEqual(r.verdict, "CARRY NIFTY PE (STBT)");
});

test("expiry-day rollover: fresh call writing on the next-week chain is scored as bearish writing", () => {
  const r = calculateEODDecision({
    ...BASE,
    timeline: expiryDay({ next: (f) => ({ put: 280000, call: Math.round(240000 + 90000 * f) }) }),
    expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: true },
  });
  const b = groupB(r);
  assert.equal(b.contribution, -3, "≥75k net, WRITING-driven → full tier");
  assert.equal(b.driver, "WRITING");
});

test("expiry-day rollover with no next-week series recorded: closing flow UNVERIFIED, never the expiring chain", () => {
  const r = calculateEODDecision({
    ...BASE,
    timeline: expiryDay(),
    expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: false },
  });
  const b = groupB(r);
  assert.equal(b.contribution, 0);
  assert.equal(b.unverified, true);
  assert.ok(r.unverifiedGroups.includes("B"), "carry dispatch refuses while a scored group is UNVERIFIED");
  const cardRow = r.card.rows.find((x) => x.group === "B");
  assert.match(cardRow.reason, /Expiry day: 23-Nov-2026 closing flow not recorded/);
});

test("expiry-day rollover: next-week series starting after the 14:15 anchor is a gap, not a reading", () => {
  const r = calculateEODDecision({
    ...BASE,
    timeline: expiryDay({ next: (f) => ({ put: 280000, call: Math.round(240000 + 90000 * f) }), nextFrom: 900 }),
    expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: true },
  });
  const b = groupB(r);
  assert.equal(b.contribution, 0);
  assert.equal(b.unverified, true);
});

test("ticks carrying a different next expiry are ignored", () => {
  const tl = expiryDay({ next: () => ({ put: 280000, call: 243000 }) }).map((pt) => ({ ...pt, nextExpiry: "30-Nov-2026" }));
  const r = calculateEODDecision({ ...BASE, timeline: tl, expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: true } });
  assert.equal(groupB(r).unverified, true);
});

test("card names the carry contract as an expiry-day rollover", () => {
  const r = calculateEODDecision({
    ...BASE,
    timeline: expiryDay({ next: () => ({ put: 280000, call: 243000 }) }),
    expiryRollover: { expiry: "23-Nov-2026", nextChainAvailable: true },
  });
  assert.equal(r.card.contract, "23-Nov-2026 (expiry-day rollover)");
  assert.ok(r.audit.find((a) => a.label === "Expiry Day Rollover Protocol").detail.includes("23-Nov-2026"));
});
