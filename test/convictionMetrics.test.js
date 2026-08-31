import test from "node:test";
import assert from "node:assert/strict";

import { hasConvictionMetrics, readConvictionMetrics } from "../src/convictionMetrics.js";

test("reads the five namespaced sheet columns", () => {
  const metrics = readConvictionMetrics({
    "Conviction Rank": 12,
    "Conviction RS": "8",
    "Conviction Volume": 13,
    "Conviction Trend": 22,
    "Conviction Base": 61,
  });

  assert.deepEqual(metrics, { rank: 12, rs: 8, volume: 13, trend: 22, base: 61 });
  assert.equal(hasConvictionMetrics(metrics), true);
});

test("keeps zero scores and treats blank cells as unavailable", () => {
  assert.deepEqual(readConvictionMetrics({
    "Conviction Rank": "",
    "Conviction RS": 0,
    "Conviction Volume": null,
    "Conviction Trend": undefined,
    "Conviction Base": "not a number",
  }), { rank: null, rs: 0, volume: null, trend: null, base: null });
  assert.equal(hasConvictionMetrics(readConvictionMetrics({})), false);
});
