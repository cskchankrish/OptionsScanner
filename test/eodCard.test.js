/**
 * EOD verdict card (12-Nov Part 3): headline, score vs threshold, three evidence rows, stop,
 * contract, carry automation status, data row; the same wording in the EOD Telegram header.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of ["CARRY_BRIDGE_ENABLED", "FLOW_BRIDGE_URL", "FLOW_BRIDGE_SECRET"]) delete process.env[k];

const { calculateEODDecision } = await import("../api/nifty-oi.js");
const { formatEodCardLines } = await import("../src/eodCard.js");
const { sendTelegramEODAlert } = await import("../api/tv-webhook.js");
const carry = await import("../src/carryBridge.js");

const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const closing = (putEnd, callEnd, skip = []) => {
  const out = [];
  for (let m = 855; m <= 930; m++) {
    if (skip.includes(m)) continue;
    const f = (m - 855) / 75;
    const put = 300000 + (putEnd - 300000) * f;
    const call = 300000 + (callEnd - 300000) * f;
    out.push({ minutes: m, time: hm(m), putWriting: put, callWriting: call, netDiff: put - call, isLiveTick: true });
  }
  return out;
};
const base = {
  spot: 24637, floorStrike: 24400, roofStrike: 24650, totPutWriting: 200000, totCallWriting: 200000, pcr: 1, deltaPcr: 1,
  dayOfWeek: 3, nowMins: 930, targetContract: "17-Nov-2026", futuresQuadrant: { quadrant: "NEUTRAL_CHOP" }, futuresMetrics: { rawBasis: 5 },
};
const words = (s) => s.trim().split(/\s+/).length;

test("STBT card: three-word headline, score vs threshold, agreement labelled, three rows, stop and contract", () => {
  const r = calculateEODDecision({ ...base, timeline: closing(300000, 400000) });
  const c = r.card;
  assert.equal(c.headline, "STBT · BUY PE");
  assert.equal(c.scoreLine, "Score −3 · needs ≤ −3 for STBT");
  assert.match(c.agreementLine, /^Agreement \d+\/100 — rule agreement, not a probability$/);
  assert.deepEqual(c.rows.map((x) => [x.group, x.label, x.contributionText]), [["A", "Options positioning", "0"], ["B", "Closing flow", "−3"], ["C", "Futures", "0"]]);
  assert.equal(c.rows[1].reason, "Fresh call writing since 14:15 (net -1.0L)");
  assert.equal(c.rows[0].reason, "Balanced writing; PCR neutral; spot mid-range");
  assert.equal(c.rows[2].reason, "Futures flat; basis neutral");
  for (const row of c.rows) assert.ok(words(row.reason) <= 12, row.reason);
  assert.equal(c.stop, 24650);
  assert.equal(c.contract, "17-Nov-2026");
  assert.equal(c.color, "#ef4444");
});

test("BTST card and NO CARRY card (no agreement figure, distance to thresholds, no stop)", () => {
  const btst = calculateEODDecision({ ...base, timeline: closing(400000, 300000) }).card;
  assert.equal(btst.headline, "BTST · BUY CE");
  assert.equal(btst.scoreLine, "Score +3 · needs ≥ +3 for BTST");
  assert.equal(btst.rows[1].reason, "Fresh put writing since 14:15 (net +1.0L)");
  const flat = calculateEODDecision({ ...base, timeline: closing(300000, 300000) }).card;
  assert.equal(flat.headline, "NO CARRY");
  assert.equal(flat.scoreLine, "Score 0 · 3 pts short of BTST (≥ +3) · 3 pts short of STBT (≤ −3)");
  assert.equal(flat.agreementLine, null);
  assert.equal(flat.stop, null);
  assert.equal(flat.rows[1].reason, "No meaningful closing flow (net 0)");
});

test("UNVERIFIED and pending rows say so in plain words", () => {
  const holed = calculateEODDecision({ ...base, timeline: closing(300000, 400000, [880, 881, 882, 883, 884, 885, 886, 887, 888, 889]) }).card;
  assert.equal(holed.rows[1].unverified, true);
  assert.equal(holed.rows[1].reason, "Not enough data (gap 14:39–14:50)");
  assert.match(holed.caveat, /^⚠️ Data caveat/);
  const stale = calculateEODDecision({ ...base, timeline: closing(300000, 300000), futuresMetrics: { isStale: true } }).card;
  assert.equal(stale.rows[2].unverified, true);
  assert.equal(stale.rows[2].reason, "Futures data stale or missing");
  const early = calculateEODDecision({ ...base, nowMins: 860, timeline: closing(300000, 300000).filter((p) => p.minutes <= 860) }).card;
  assert.equal(early.rows[1].pending, true);
  assert.equal(early.rows[1].reason, "Pending — window from 14:15 scores after 14:30");
});

test("Telegram EOD message starts with the same card block before the existing detail", async () => {
  const prev = { fetch: globalThis.fetch, t: process.env.TELEGRAM_BOT_TOKEN, c: process.env.TELEGRAM_CHAT_ID };
  const texts = [];
  process.env.TELEGRAM_BOT_TOKEN = "x";
  process.env.TELEGRAM_CHAT_ID = "y";
  globalThis.fetch = async (u, init) => { texts.push(JSON.parse(init.body).text); return new Response("{}", { status: 200 }); };
  try {
    const r = calculateEODDecision({ ...base, timeline: closing(300000, 400000) });
    r.card.automation = { state: "WAITING", text: "Waiting for 15:31" };
    r.card.dataLine = "NSE data 12-Nov-2026 15:15:00 · coverage 100% since 09:15";
    await sendTelegramEODAlert(r, 24637, 24400, 24650, "15:15");
    const lines = texts[0].split("\n");
    assert.equal(lines[0], "*STBT · BUY PE*");
    assert.match(lines[1], /^• Score −3 · needs ≤ −3 for STBT · Agreement \d+\/100 — rule agreement, not a probability$/);
    assert.equal(lines[2], "  A Options positioning: `0` — Balanced writing; PCR neutral; spot mid-range");
    assert.equal(lines[3], "  B Closing flow: `−3` — Fresh call writing since 14:15 (net -1.0L)");
    assert.equal(lines[4], "  C Futures: `0` — Futures flat; basis neutral");
    assert.equal(lines[5], "• *Stop:* `24650` · *Contract:* 17-Nov-2026");
    assert.equal(lines[6], "• *Carry automation:* Waiting for 15:31");
    assert.equal(lines[7], "• *Data:* NSE data 12-Nov-2026 15:15:00 · coverage 100% since 09:15");
    assert.ok(texts[0].indexOf("OFFICIAL EOD CARRY DIRECTIVE") > texts[0].indexOf("Carry automation"), "card first, existing detail after");
    assert.deepEqual(formatEodCardLines(r.card), lines.slice(0, 8));
  } finally {
    globalThis.fetch = prev.fetch;
    if (prev.t === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prev.t;
    if (prev.c === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prev.c;
  }
});

// ── carry automation status in plain words ──

const ON = carry.getCarryConfig({ CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://a.test/x", FLOW_BRIDGE_SECRET: "s" });
const D = (o) => carry.describeCarryAutomation({ cfg: ON, nowMins: 900, date: "2026-11-12", ...o });

test("automation status: off / waiting / watching / not sent / sent / unknown / filled / not executed / exited", () => {
  assert.equal(carry.describeCarryAutomation({ cfg: carry.getCarryConfig({}), nowMins: 900 }).text, "Carry automation off");
  assert.equal(D({}).text, "Waiting for 15:31");
  assert.equal(D({ lastHistory: { type: "CARRY_EXIT", date: "2026-11-11", pnlInr: 2142.5, pnlKnown: true } }).text, "Waiting for 15:31 · last carry (2026-11-11) exited +₹2,142.50");
  assert.equal(D({ nowMins: 933, block: { reason: "agreement 60 < 65" } }).text, "Watching 15:31–15:37: agreement 60 < 65");
  assert.equal(D({ nowMins: 939, block: { reason: "EOD verdict is NO_CARRY" } }).text, "Not sent: EOD verdict is NO_CARRY");
  assert.equal(D({ nowMins: 939 }).text, "Not sent: no poll ran inside 15:31–15:37");
  const active = (status, extra = {}) => ({ id: "ct-1", verdict: "STBT", execution: { status, ...extra } });
  assert.equal(D({ active: active("ACCEPTED") }).text, "Instruction sent (STBT) — awaiting fill (id ct-1)");
  assert.equal(D({ active: active("PENDING") }).text, "Instruction sent (STBT) — awaiting Algo reply (id ct-1)");
  assert.equal(D({ active: active("UNKNOWN") }).text, "Instruction sent — outcome UNKNOWN, check the broker (id ct-1)");
  assert.equal(D({ active: active("FILLED", { contract: "NIFTY17NOV2624600PE", optionFill: 101.6 }) }).text, "Filled: STBT NIFTY17NOV2624600PE @ 101.6 (id ct-1)");
  assert.equal(D({ claim: { id: "ct-1" }, lastHistory: { id: "ct-1", type: "CARRY_NOT_EXECUTED", execution: { reason: "holding limit" } } }).text, "Not executed: holding limit");
  assert.equal(D({ claim: { id: "ct-1" }, lastHistory: { id: "ct-1", type: "CARRY_EXIT", pnlInr: -520.5 } }).text, "Exited: -₹520.50");
});

test("readCarryAutomation reads claim, open carry, last block and last history entry", async () => {
  const kv = {
    [carry.carryClaimKey("2026-11-12")]: { id: "ct-9" },
    [carry.CARRY_ACTIVE_KEY]: { id: "ct-9", verdict: "BTST", execution: { status: "ACCEPTED" } },
  };
  const store = { get: async (k) => kv[k] ?? null, lrange: async () => [] };
  const env = { CARRY_BRIDGE_ENABLED: "true", FLOW_BRIDGE_URL: "https://a.test/x", FLOW_BRIDGE_SECRET: "s" };
  const r = await carry.readCarryAutomation({ store, env, nowMins: 933, date: "2026-11-12" });
  assert.equal(r.text, "Instruction sent (BTST) — awaiting fill (id ct-9)");
  assert.equal((await carry.readCarryAutomation({ store: null, env: {}, nowMins: 933, date: "2026-11-12" })).text, "Carry automation off");
});
