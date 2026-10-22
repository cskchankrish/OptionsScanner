import test from "node:test";
import assert from "node:assert/strict";

import { hasConvictionMetrics, readConvictionMetrics } from "../src/convictionMetrics.js";

test("reads the namespaced sheet columns including spurt flow", () => {
  const metrics = readConvictionMetrics({
    "Conviction Rank": 12,
    "Conviction Tier": "a",
    "Conviction RS": "8",
    "Conviction Volume": 13,
    "Conviction Trend": 22,
    "Conviction Base": 61,
    "Spurt Flow": "ACCUMULATION",
    "Spurt RVOL": "4.6",
    "Spurt Value Cr": "458.0",
  });

  assert.deepEqual(metrics, {
    rank: 12,
    tier: "A",
    rs: 8,
    volume: 13,
    trend: 22,
    base: 61,
    flow: "ACCUMULATION",
    spurtRvol: 4.6,
    spurtValCr: 458.0,
  });
  assert.equal(hasConvictionMetrics(metrics), true);
});

test("keeps zero scores and treats blank cells as unavailable", () => {
  assert.deepEqual(readConvictionMetrics({
    "Conviction Rank": "",
    "Conviction Tier": "Unknown",
    "Conviction RS": 0,
    "Conviction Volume": null,
    "Conviction Trend": undefined,
    "Conviction Base": "not a number",
    "Spurt Flow": "",
    "Spurt RVOL": null,
    "Spurt Value Cr": undefined,
  }), {
    rank: null,
    tier: null,
    rs: 0,
    volume: null,
    trend: null,
    base: null,
    flow: null,
    spurtRvol: null,
    spurtValCr: null,
  });
  assert.equal(hasConvictionMetrics(readConvictionMetrics({})), false);
});
