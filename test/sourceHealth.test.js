import test from "node:test";
import assert from "node:assert/strict";

import { hasSourceError, isTradableSourceRow } from "../src/sourceHealth.js";

test("rejects malformed Edge responses and formula errors", () => {
  const edgeRow = {
    "NSE Symbol": "LT",
    "Buy Above": "",
    "Sell Below": "",
    "Weekly Pivot": "Unexpected token 'E', \"Edge: Too \"... is not valid JSON",
  };
  assert.equal(hasSourceError(edgeRow), true);
  assert.equal(isTradableSourceRow(edgeRow), false);
  assert.equal(hasSourceError({ "Confluence": "#VALUE!" }), true);
});

test("requires usable positive trade levels", () => {
  assert.equal(isTradableSourceRow({
    "NSE Symbol": "RELIANCE",
    "Buy Above": 1412,
    "Sell Below": 1388,
  }), true);
  assert.equal(isTradableSourceRow({
    "NSE Symbol": "RELIANCE",
    "Buy Above": 0,
    "Sell Below": 1388,
  }), false);
});
