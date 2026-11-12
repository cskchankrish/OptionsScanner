/** Guards against test files that exist but are never run by `npm test`. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

test("every test/*.test.js file is listed in the npm test script", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const script = pkg.scripts.test;
  const files = readdirSync(new URL(".", import.meta.url)).filter((f) => f.endsWith(".test.js"));
  const missing = files.filter((f) => !script.split(/\s+/).includes(`test/${f}`));
  assert.deepEqual(missing, [], `add to package.json "test": ${missing.join(", ")}`);
});
