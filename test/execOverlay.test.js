import test from "node:test";
import assert from "node:assert/strict";
import { overlayExecutionUpdates, EXEC_UPDATE_PREFIX, BRIDGE_FAILED_PREFIX } from "../api/tv-webhook.js";

// 17-Nov 11:00 SYNERGY_BULL: dispatched (ACCEPTED), then the Algo reported ENTRY_FAILED (premium
// cap) — but the day's signal list kept showing "ACCEPTED". The list is now read with the latest
// Algo entry report applied.

function fakeRedis(initial = {}) {
  const m = new Map(Object.entries(initial).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return { get: async (k) => (m.has(k) ? m.get(k) : null), set: async (k, v) => { m.set(k, v); return "OK"; } };
}
const sig = (tradeId, status) => ({ grade: "SYNERGY_BULL", decision: "EXECUTE_HIGH_CONVICTION_SYNERGY", tradeId, execution: { status, mode: "live" } });

test("ACCEPTED record shows the Algo's later ENTRY_FAILED", async () => {
  const redis = fakeRedis({ [EXEC_UPDATE_PREFIX + "ft-1"]: { status: "NOT_EXECUTED", outcome: "ENTRY_FAILED", reason: "premium cap", at: "x" } });
  const [r] = await overlayExecutionUpdates(redis, [sig("ft-1", "ACCEPTED")]);
  assert.equal(r.execution.status, "NOT_EXECUTED");
  assert.equal(r.execution.reason, "premium cap");
  assert.equal(r.execution.dispatchStatus, "ACCEPTED");
});

test("ENTRY_FILLED update shows FILLED with contract and fill", async () => {
  const redis = fakeRedis({ [EXEC_UPDATE_PREFIX + "ft-2"]: { status: "FILLED", contract: "NIFTY-Nov2026-25400-CE", optionFill: 291.9 } });
  const [r] = await overlayExecutionUpdates(redis, [sig("ft-2", "ACCEPTED")]);
  assert.equal(r.execution.status, "FILLED");
  assert.equal(r.execution.optionFill, 291.9);
});

test("entries reported before the key existed fall back to the ENTRY_FAILED marker", async () => {
  const redis = fakeRedis({ [BRIDGE_FAILED_PREFIX + "ft-3"]: { reason: "premium cap (old)", at: "y" } });
  const [r] = await overlayExecutionUpdates(redis, [sig("ft-3", "ACCEPTED")]);
  assert.equal(r.execution.status, "NOT_EXECUTED");
  assert.equal(r.execution.reason, "premium cap (old)");
});

test("final statuses, records without a trade id and missing updates are left unchanged", async () => {
  const redis = fakeRedis({ [EXEC_UPDATE_PREFIX + "ft-4"]: { status: "FILLED" } });
  const input = [sig("ft-4", "NOT_EXECUTED"), { grade: "VBO_BREAK", decision: "LOG_ONLY" }, sig("ft-5", "ACCEPTED")];
  const out = await overlayExecutionUpdates(redis, input);
  assert.deepEqual(out, input);
});

test("a failing store never throws and leaves records as dispatched", async () => {
  const redis = { get: async () => { throw new Error("redis down"); } };
  const input = [sig("ft-6", "ACCEPTED")];
  assert.deepEqual(await overlayExecutionUpdates(redis, input), input);
  assert.deepEqual(await overlayExecutionUpdates(null, input), input);
});
