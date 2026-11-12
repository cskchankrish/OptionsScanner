/**
 * Turn Tracker (Part 4 + owner addition) on 12-Nov-2026 data and synthetic series.
 * Fixture: test/fixtures/nifty-oi-2026-11-12.json — a tick every minute 09:15–11:38, sparse after.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

for (const k of ["TURN_NOISE_PCT", "TURN_OI_NOISE_PCT", "TURN_OPTIONS_MIN_NET", "REVERSAL_MIN_MOVE_PCT", "REVERSAL_MIN_OI_PCT", "REVERSAL_MIN_ELAPSED_MIN"]) delete process.env[k];

const tt = await import("../src/turnTracker.js");
const { pickSessionFuturesAnchor } = await import("../api/nifty-oi.js");
const { fuseChartWithOptionChain } = await import("../api/tv-webhook.js");

const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/nifty-oi-2026-11-12.json", import.meta.url), "utf8"));
const TL = FX.intradayTimeline;
const MORNING = TL.filter((p) => p.minutes <= 698);
const hm = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const at = (t) => TL.find((p) => p.time === t);

/** Linear, gap-free series between two readings (one tick per minute). */
function linear(a, b) {
  const out = [];
  for (let m = a.minutes; m <= b.minutes; m++) {
    const f = (m - a.minutes) / (b.minutes - a.minutes);
    const v = (k) => a[k] + (b[k] - a[k]) * f;
    const put = Math.round(v("put"));
    const call = Math.round(v("call"));
    out.push({ time: hm(m), minutes: m, futPrice: Number(v("fut").toFixed(2)), spot: Number((v("fut") - 40).toFixed(2)), futCombinedOI: Math.round(v("oi")), putWriting: put, callWriting: call, netDiff: put - call, isLiveTick: true });
  }
  return out;
}

// ── today's numbers ──

test("12-Nov numbers (10:03 → 12:33, gap-free): CONFIRMED BEARISH with both legs quoted", () => {
  const tl = linear(
    { minutes: 603, fut: 25412, oi: 202123, put: 322643, call: 84223 },
    { minutes: 753, fut: 25255.7, oi: 206000, put: 337928, call: 244435 },
  );
  const t = tt.computeTurnTracker({ timeline: tl });
  assert.equal(t.status, "OK");
  assert.equal(t.stage, "CONFIRMED");
  assert.equal(t.direction, "BEARISH");
  assert.deepEqual([t.reference.kind, t.reference.time, t.reference.price], ["high", "10:03", 25412]);
  assert.equal(t.futuresLeg.movePts, -156.3);
  assert.equal(t.futuresLeg.oiChange, 3877);
  assert.ok(Math.abs(t.futuresLeg.oiPct - 1.918) < 0.01);
  assert.equal(t.futuresLeg.quadrant, "SHORT_BUILDUP");
  assert.equal(t.optionsLeg.callLegDelta, 160212);
  assert.equal(t.optionsLeg.putLegDelta, 15285);
  assert.equal(t.optionsLeg.driver, "WRITING");
  assert.equal(t.optionsLeg.dominantLeg, "CALL");
  assert.equal(t.optionsLeg.deltaPcrAtExtreme, 3.83);
  assert.equal(t.optionsLeg.deltaPcrNow, 1.38);
  assert.match(t.message, /CONFIRMED BEARISH — since 10:03 high at 25412: futures 25255\.7 \(-156\.3 pts, -0\.61%\), OI \+1\.92%/);
  assert.match(t.message, /Information only — not a trade signal and not sent to the Algo/);
  assert.equal(t.displayOnly, true);
});

test("replay of the real gap-free morning (09:15–11:38): first EARLY / LIKELY TURN / CONFIRMED", () => {
  const r = tt.replayFirstStages(MORNING, { from: 555, to: 698 });
  assert.deepEqual(r.insufficientAt, [], "the morning is fully covered");
  assert.deepEqual(r.first["EARLY:BULLISH"], { time: "09:18", since: "09:16 low 25189", price: 25250.7 });
  assert.equal(r.first["LIKELY_TURN:BULLISH"].time, "09:22");
  assert.equal(r.first["CONFIRMED:BULLISH"].time, "09:36");
  assert.deepEqual(r.first["EARLY:BEARISH"], { time: "10:37", since: "10:04 high 25413", price: 25370 });
  assert.equal(r.first["LIKELY_TURN:BEARISH"], undefined, "by 11:38 the options leg had not turned (net −18.4k < 20k)");
  assert.equal(r.first["CONFIRMED:BEARISH"], undefined);
  const at1138 = tt.computeTurnTracker({ timeline: MORNING });
  assert.equal(at1138.stage, "EARLY");
  assert.equal(at1138.direction, "BEARISH");
  assert.match(at1138.reason, /price -0\.29% off the high with OI \+0\.54% — options not yet confirming/);
});

test("real captured ticks after 11:38: CONFIRMED BEARISH at 11:43 (4-min hole tolerated), then 'not enough data since 10:04'", () => {
  const r = tt.replayFirstStages(TL, { from: 555, to: 940 });
  assert.equal(r.first["CONFIRMED:BEARISH"].time, "11:43");
  assert.ok(r.insufficientAt.includes("11:53"));
  const t = tt.computeTurnTracker({ timeline: TL, nowMins: 753 });
  assert.equal(t.status, "INSUFFICIENT_DATA");
  assert.equal(t.stage, null, "never a stage across a gap");
  assert.match(t.message, /not enough data since 10:04 — not enough data for the window since the 10:04 high \(10:04–12:33\) \(\d+ of 150 expected ticks; gap \d\d:\d\d–\d\d:\d\d\)\. No stage shown\./);
});

test("Part 2.1 regression on the real capture: the 09:15 tick has no futures price; the anchor is the first valid tick", () => {
  assert.ok(!(Number(TL[0].futPrice) > 0));
  assert.ok(TL[0].futBasis < -25000, "the basis measured from 0 that produced Δ 25302");
  const a = pickSessionFuturesAnchor({ timeline: TL });
  assert.notEqual(a.time, "09:15");
  assert.ok(Math.abs(a.rawBasis) < 200);
});

// ── stage transitions (synthetic) ──

function walk(points) {
  // points: [{m, fut, oi, put, call}] → gap-free series through each point
  let out = [];
  for (let i = 1; i < points.length; i++) {
    const seg = linear(points[i - 1].minutes ? points[i - 1] : { ...points[i - 1], minutes: points[i - 1].m }, points[i].minutes ? points[i] : { ...points[i], minutes: points[i].m });
    out = out.concat(i === 1 ? seg : seg.slice(1));
  }
  return out;
}
const P = (m, fut, oi, put, call) => ({ minutes: m, fut, oi, put, call });

test("stage transitions from a high: NO TURN → EARLY (options first) → LIKELY TURN → CONFIRMED", () => {
  const tl = walk([
    P(600, 25000, 200000, 300000, 300000), // high at 10:00
    P(605, 24995, 200050, 300000, 300000), // still within noise, nothing moving
    P(615, 24990, 200100, 300000, 330000), // call writing +30k, price within 0.15% → EARLY (options)
    P(625, 24950, 200500, 300000, 345000), // −0.20%, OI +0.25%, options turned → LIKELY TURN
    P(640, 24900, 201200, 300000, 380000), // −0.40%, OI +0.60%, 40 min → CONFIRMED
  ]);
  const stageAt = (m) => tt.computeTurnTracker({ timeline: tl, nowMins: m });
  assert.equal(stageAt(605).stage, "NO_TURN");
  const early = stageAt(615);
  assert.equal(early.stage, "EARLY");
  assert.equal(early.direction, "BEARISH");
  assert.match(early.reason, /call writing rising \(WRITING-driven\), net -30\.0k, while price is still within 0\.15% of the high/);
  const likely = stageAt(625);
  assert.equal(likely.stage, "LIKELY_TURN");
  assert.match(likely.reason, /below full threshold — price -0\.20% \(needs −0\.35%\), OI \+0\.25% \(needs \+0\.5%\)/);
  assert.equal(stageAt(640).stage, "CONFIRMED");
});

test("EARLY from the futures leg alone: price off the high on rising OI, options not confirming", () => {
  const tl = walk([P(600, 25000, 200000, 300000, 300000), P(630, 24950, 200400, 310000, 305000)]);
  const t = tt.computeTurnTracker({ timeline: tl });
  assert.equal(t.stage, "EARLY");
  assert.match(t.reason, /price -0\.20% off the high with OI \+0\.20% — options not yet confirming/);
});

test("mirror: BULLISH stages from the low; CONFIRMED needs elapsed time", () => {
  const tl = walk([P(600, 25000, 200000, 300000, 300000), P(612, 25100, 201200, 340000, 300000)]);
  const fast = tt.computeTurnTracker({ timeline: tl });
  assert.equal(fast.direction, "BULLISH");
  assert.equal(fast.stage, "LIKELY_TURN", "+0.40% / +0.60% / put writing, but only 12 min");
  assert.match(fast.reason, /12 min \(needs 20\)/);
  const slow = walk([P(600, 25000, 200000, 300000, 300000), P(630, 25100, 201200, 340000, 300000)]);
  assert.equal(tt.computeTurnTracker({ timeline: slow }).stage, "CONFIRMED");
});

test("both extremes active → the more recent one is shown", () => {
  // low at 10:00, rally to a high at 10:30, then a dip with call writing
  const tl = walk([
    P(600, 25000, 200000, 300000, 300000),
    P(630, 25120, 201000, 340000, 300000),
    P(650, 25070, 201400, 340000, 330000),
  ]);
  const t = tt.computeTurnTracker({ timeline: tl });
  assert.equal(t.reference.kind, "high");
  assert.equal(t.reference.time, "10:30");
  assert.equal(t.direction, "BEARISH");
  assert.ok(t.sides.bullish.stageRank > 0, "the low also had a stage, but it is older");
});

test("no stage across a gap, in the auction window, or for options across the 15:30 print", () => {
  const holed = walk([P(600, 25000, 200000, 300000, 300000), P(640, 24900, 201200, 300000, 380000)]).filter((p) => p.minutes < 615 || p.minutes > 625);
  const g = tt.computeTurnTracker({ timeline: holed });
  assert.equal(g.status, "INSUFFICIENT_DATA");
  assert.equal(g.stage, null);
  assert.match(g.message, /not enough data since 10:00/);
  const auction = walk([P(880, 25000, 200000, 300000, 300000), P(920, 24900, 201200, 300000, 380000)]);
  assert.equal(tt.computeTurnTracker({ timeline: auction }).status, "AUCTION_WINDOW");
  const straddle = walk([P(900, 25000, 200000, 300000, 300000), P(935, 24900, 201200, 300000, 380000)]);
  const s = tt.computeTurnTracker({ timeline: straddle });
  assert.equal(s.optionsLeg.comparable, false);
  assert.equal(s.stage, "EARLY", "futures leg only — options are not compared across the auction print");
});

test("floor/roof migration since the extreme is reported when ticks carry levels", () => {
  const tl = walk([P(600, 25000, 200000, 300000, 300000), P(640, 24900, 201200, 300000, 380000)])
    .map((p) => ({ ...p, floor: p.minutes < 620 ? 24900 : 24800, roof: p.minutes < 630 ? 25100 : 25000 }));
  const t = tt.computeTurnTracker({ timeline: tl });
  assert.deepEqual(t.optionsLeg.floor, { from: 24900, to: 24800, moved: -100 });
  assert.deepEqual(t.optionsLeg.roof, { from: 25100, to: 25000, moved: -100 });
});

test("thresholds are named and env-overridable", () => {
  assert.deepEqual(tt.getTurnConfig({}), { noisePct: 0.15, oiNoisePct: 0.1, optionsMinNet: 20000, minMovePct: 0.35, minOiPct: 0.5, minElapsedMin: 20 });
  const c = tt.getTurnConfig({ TURN_NOISE_PCT: "0.2", REVERSAL_MIN_MOVE_PCT: "0.5" });
  assert.equal(c.noisePct, 0.2);
  assert.equal(c.minMovePct, 0.5);
});

// ── alerts ──
function kv() {
  const store = {};
  const sent = [];
  return {
    store, sent,
    deps: {
      get: async (k) => store[k] ?? null,
      set: async (k, v) => { store[k] = v; return true; },
      setNx: async (k, v) => { await new Promise((r) => setImmediate(r)); if (k in store) return false; store[k] = v; return true; },
      del: async (k) => { delete store[k]; return 1; },
      send: async (t) => { sent.push(t); return true; },
    },
  };
}

test("Telegram on entering LIKELY TURN and again on CONFIRMED, once each per extreme (concurrent-safe)", async () => {
  const tl = walk([P(600, 25000, 200000, 300000, 300000), P(615, 24990, 200100, 300000, 330000), P(625, 24950, 200500, 300000, 345000), P(640, 24900, 201200, 300000, 380000)]);
  const s = kv();
  const early = tt.computeTurnTracker({ timeline: tl, nowMins: 615 });
  assert.equal((await tt.dispatchTurnAlert({ tracker: early, istDateStr: "2026-11-12", deps: s.deps })).status, "NO_ALERT_STAGE");
  const likely = tt.computeTurnTracker({ timeline: tl, nowMins: 625 });
  const r1 = await Promise.all([1, 2, 3].map(() => tt.dispatchTurnAlert({ tracker: likely, istDateStr: "2026-11-12", deps: s.deps })));
  assert.equal(r1.filter((x) => x.sent).length, 1);
  const likely2 = tt.computeTurnTracker({ timeline: tl, nowMins: 630 });
  assert.equal((await tt.dispatchTurnAlert({ tracker: likely2, istDateStr: "2026-11-12", deps: s.deps })).sent, false);
  const conf = tt.computeTurnTracker({ timeline: tl, nowMins: 640 });
  assert.equal((await tt.dispatchTurnAlert({ tracker: conf, istDateStr: "2026-11-12", deps: s.deps })).sent, true);
  assert.equal(s.sent.length, 2);
  assert.match(s.sent[0], /TURN TRACKER · LIKELY TURN BEARISH/);
  assert.match(s.sent[1], /TURN TRACKER · CONFIRMED BEARISH/);
  for (const text of s.sent) {
    assert.match(text, /Since:\* 10:00 high at `25000`/);
    assert.match(text, /Futures leg:\*/);
    assert.match(text, /Options leg:\* call writing \+/);
    assert.match(text, /Information only — not a trade signal and not sent to the Algo/);
  }
});

test("a new extreme within the min-move of an alerted one does not re-alert; a failed send releases the claim", async () => {
  const s = kv();
  const base = tt.computeTurnTracker({ timeline: walk([P(600, 25000, 200000, 300000, 300000), P(640, 24900, 201200, 300000, 380000)]) });
  assert.equal((await tt.dispatchTurnAlert({ tracker: base, istDateStr: "d", deps: s.deps })).sent, true);
  const near = JSON.parse(JSON.stringify(base));
  near.reference = { ...near.reference, minutes: 650, time: "10:50", price: 25020 };
  assert.equal((await tt.dispatchTurnAlert({ tracker: near, istDateStr: "d", deps: s.deps })).status, "ALREADY_ALERTED_NEAR_EXTREME");
  const far = JSON.parse(JSON.stringify(base));
  far.reference = { ...far.reference, minutes: 700, time: "11:40", price: 25120 };
  assert.equal((await tt.dispatchTurnAlert({ tracker: far, istDateStr: "d", deps: s.deps })).sent, true);

  const f = kv();
  f.deps.send = async () => false;
  assert.equal((await tt.dispatchTurnAlert({ tracker: base, istDateStr: "d", deps: f.deps })).status, "SEND_FAILED_RELEASED");
  assert.deepEqual(Object.keys(f.store), []);
});

// ── display only: nothing downstream changes ──

test("display only: webhook decisions are identical with and without a CONFIRMED turnTracker in the snapshot", () => {
  const tracker = tt.computeTurnTracker({ timeline: linear(
    { minutes: 603, fut: 25412, oi: 202123, put: 322643, call: 84223 },
    { minutes: 753, fut: 25255.7, oi: 206000, put: 337928, call: 244435 },
  ) });
  assert.equal(tracker.stage, "CONFIRMED");
  const snapshot = {
    snapshotAt: Date.now() - 10_000,
    corridor: { deltaPCR: FX.deltaPcr, floorStrike: FX.floor, roofStrike: FX.roof },
    futures: FX.futures,
    fusion: FX.fusion,
    smartMoneyFusion: { primaryScenario: FX.fusion?.scenarioId || "MIXED_FLOW", actionTag: "NEUTRAL" },
  };
  const alerts = [
    { grade: "BEAR_TRAP_BUY", dir: "LONG", close: 25255.7, sl: 25190, t1Dist: 65, t2Dist: 130 },
    { grade: "BULL_TRAP_SELL", dir: "SHORT", close: 25255.7, sl: 25320, t1Dist: 65, t2Dist: 130 },
    { grade: "SYNERGY_BULL", dir: "LONG", close: 25255.7, sl: 25190 },
    { grade: "SYNERGY_BEAR", dir: "SHORT", close: 25255.7, sl: 25320 },
    { grade: "SWING_TOP", dir: "SHORT", close: 25255.7 },
  ];
  const now = Date.now();
  for (const a of alerts) {
    const without = fuseChartWithOptionChain(a, snapshot, now);
    const withTracker = fuseChartWithOptionChain(a, { ...snapshot, turnTracker: tracker }, now);
    for (const k of ["decision", "recommendedLots", "tier", "stopLoss", "target1Price", "target2Price", "reasoning"]) {
      assert.deepEqual(withTracker[k], without[k], `${a.grade}: ${k}`);
    }
    assert.deepEqual(withTracker.liveOptionChainMetrics, without.liveOptionChainMetrics);
  }
  const src = fs.readFileSync(new URL("../api/tv-webhook.js", import.meta.url), "utf8");
  assert.doesNotMatch(src, /turnTracker/, "the webhook never reads the tracker");
  for (const f of ["../src/carryBridge.js", "../src/smartMoneyFusion.js", "../src/flowBridge.js"]) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, import.meta.url), "utf8"), /turnTracker|computeTurnTracker/, f);
  }
  assert.doesNotMatch(fs.readFileSync(new URL("../src/turnTracker.js", import.meta.url), "utf8"), /from "\.\/flowBridge|from "\.\/carryBridge/, "no path to the Algo");
});
