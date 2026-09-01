import test from "node:test";
import assert from "node:assert/strict";

import { compareStocks } from "../src/stockSort.js";

const stock = (sym, { score, rank, tier, trend, insideDay = false, insideVal = false }) => ({
  sym,
  score,
  signals: { insideDay, insideVal },
  conviction: { rank, tier, trend },
});

test("smart priority puts triggered strong stocks above higher setup scores", () => {
  const triggeredTrend = stock("TRIGGER", {
    score:30, rank:180, tier:"B", trend:24, insideDay:true,
  });
  const highSetup = stock("SETUP", {
    score:150, rank:10, tier:"A", trend:25,
  });

  assert.deepEqual([highSetup, triggeredTrend].sort(compareStocks).map(s => s.sym), ["TRIGGER", "SETUP"]);
});

test("smart priority uses tier, trend, rank, and setup as ordered tie breakers", () => {
  const tierA = stock("A", { score:30, rank:200, tier:"A", trend:21, insideVal:true });
  const tierB = stock("B", { score:80, rank:20, tier:"B", trend:25, insideVal:true });
  assert.equal(compareStocks(tierA, tierB), -1);
});

test("explicit sort modes remain available", () => {
  const a = stock("A", { score:40, rank:10, tier:"A", trend:15 });
  const b = stock("B", { score:90, rank:100, tier:"B", trend:24 });
  assert.deepEqual([a, b].sort((x, y) => compareStocks(x, y, "rank")).map(s => s.sym), ["A", "B"]);
  assert.deepEqual([a, b].sort((x, y) => compareStocks(x, y, "trend")).map(s => s.sym), ["B", "A"]);
  assert.deepEqual([a, b].sort((x, y) => compareStocks(x, y, "setup")).map(s => s.sym), ["B", "A"]);
});
