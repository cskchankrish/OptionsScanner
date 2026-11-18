import test from "node:test";
import assert from "node:assert/strict";
import { formatSignalStamp } from "../src/signalStamp.js";

test("receive time in IST from the ISO timestamp", () => {
  // 17-Nov 05:50:08 UTC = 11:20:08 IST (the 11:20 BEAR_TRAP_BUY).
  assert.equal(formatSignalStamp({ timestamp: "2026-11-17T05:50:08.777Z", istTime: "2026-11-17T11:20" }), "17-Nov-2026 · 11:20:08 IST");
});

test("crosses midnight correctly (UTC evening is the next IST date)", () => {
  assert.equal(formatSignalStamp({ timestamp: "2026-11-17T19:00:00Z" }), "18-Nov-2026 · 00:30:00 IST");
});

test("falls back to the chart bar time; null when nothing usable", () => {
  assert.equal(formatSignalStamp({ istTime: "2026-11-18T09:45" }), "18-Nov-2026 · 09:45 IST");
  assert.equal(formatSignalStamp({ istTime: "10:00:23 am" }), null);
  assert.equal(formatSignalStamp(null), null);
  assert.equal(formatSignalStamp({ timestamp: "garbage" }), null);
});
