/**
 * Shadow Bear Trap / Bull Trap rules (src/trapShadow.js) and their scorecard section TRAP_SHADOW.
 * Measurement only: these tests also prove the shadow "base" condition cannot drift from the live
 * fusion rule, and that the evaluator is safe on recorded sessions. No network, prints nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "SCORECARD_ENABLED", "SCORECARD_BAND_PCT", "FLOW_BRIDGE_ENABLED",
  "TRAP_SHADOW_ENABLED",
]) delete process.env[k];

const ts = await import("../src/trapShadow.js");
const sc = await import("../src/scorecard.js");
const { evaluateSmartMoneyFusion } = await import("../src/smartMoneyFusion.js");
const { buildScorecardReading, scorecardSettings } = await import("../api/nifty-oi.js");

const { evaluateShadowTraps, getTrapShadowConfig, TRAP_SHADOW_DEFAULTS } = ts;
const NAMES = ["strength", "recent", "relative", "proximity", "stalled"];

// ── Scenario builder ─────────────────────────────────────────────────────────
// side +1 = bear trap (bullish), −1 = bull trap (bearish). One tick per minute 660..700 (now = 700).
// Defaults pass all five conditions:
//   strength: ΔPCR 1.5 / 0.6 with one-sided totals
//   recent:   the defended leg's writing grows by 50,000 over the last 30 min (|net| ≥ 28k / 26k)
//   relative: futures combined OI falls 5,000 → ratio 10
//   proximity: spot 60 points from the strike
//   stalled:  extreme 10 min old at 690, price 20 points off it (≈0.08%)
function scenario(side, o = {}) {
  const now = 700;
  const writingGain = o.writingGain ?? 50000;
  const oiChange = o.oiChange ?? -5000;
  const extremeAt = o.extremeAt ?? 690;
  const startPrice = side > 0 ? 25100 : 25000;
  const extreme = startPrice - side * 50;
  const current = o.current ?? extreme + side * 20;
  const ticks = [];
  for (let m = 660; m <= now; m++) {
    if (o.skip && o.skip.includes(m)) continue;
    const g = m <= 670 ? 0 : (writingGain * (m - 670)) / 30;
    const price = m <= extremeAt
      ? startPrice + ((extreme - startPrice) * (m - 660)) / Math.max(1, extremeAt - 660)
      : extreme + ((current - extreme) * (m - extremeAt)) / Math.max(1, now - extremeAt);
    const oi = m <= 670 ? 200000 : 200000 + (oiChange * (m - 670)) / 30;
    ticks.push({
      minutes: m, spot: price - 20, futPrice: Math.round(price * 100) / 100, futCombinedOI: Math.round(oi),
      putWriting: side > 0 ? 250000 + g : 200000, callWriting: side > 0 ? 200000 : 250000 + g,
    });
  }
  const strike = side > 0 ? 25000 : 25100;
  const spot = o.spot ?? (side > 0 ? strike + 60 : strike - 60);
  return {
    quadrant: "quadrant" in o ? o.quadrant : side > 0 ? "LONG_UNWINDING" : "SHORT_COVERING",
    optionsMetrics: o.optionsMetrics ?? (side > 0
      ? { deltaPcr: o.deltaPcr ?? 1.5, totalPutWriting: 300000, totalCallWriting: 200000, floorPutWritingBlitz: false, roofCallWritingBlitz: false }
      : { deltaPcr: o.deltaPcr ?? 0.6, totalPutWriting: 200000, totalCallWriting: 300000, floorPutWritingBlitz: false, roofCallWritingBlitz: false }),
    spot,
    floorStrike: "floorStrike" in o ? o.floorStrike : side > 0 ? strike : 24900,
    roofStrike: "roofStrike" in o ? o.roofStrike : side > 0 ? 25200 : strike,
    timeline: o.timeline ?? ticks,
    nowMins: now,
  };
}
const sideKey = (side) => (side > 0 ? "bearTrap" : "bullTrap");

for (const side of [+1, -1]) {
  const label = side > 0 ? "bear trap" : "bull trap";
  const k = sideKey(side);

  test(`${label}: passes all five conditions → base and strict`, () => {
    const r = evaluateShadowTraps(scenario(side))[k];
    assert.equal(r.base, true);
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.unverified, []);
    assert.equal(r.strict, true);
    assert.equal(r.direction, side > 0 ? "BULLISH" : "BEARISH");
    // raw values recorded
    assert.equal(r.conditions.recent.netChange, side * 50000);
    assert.equal(r.conditions.relative.futOiChange, -5000);
    assert.equal(r.conditions.relative.ratio, 10);
    assert.equal(r.conditions.proximity.distancePts, 60);
    assert.equal(r.conditions.stalled.extremeAt, 690);
    assert.equal(r.conditions.stalled.extremeAgeMin, 10);
    assert.ok(r.conditions.stalled.bouncePct > 0.07);
  });

  const single = {
    // base stays true (1.32 ≥ 1.30 / 0.73 ≤ 0.75) but misses the 1.35 / 0.70 strength bar
    strength: { deltaPcr: side > 0 ? 1.32 : 0.73 },
    // only 20,000 net change; relative still 20,000 / 5,000 = 4
    recent: { writingGain: 20000 },
    // futures OI change 20,000 → ratio 2.5
    relative: { oiChange: -20000 },
    // 100 points away from the strike
    proximity: { spot: side > 0 ? 25100 : 25000 },
    // still making new extremes: extreme is the current tick
    stalled: { extremeAt: 700, current: (side > 0 ? 25100 : 25000) - side * 50 },
  };
  for (const name of NAMES) {
    test(`${label}: only "${name}" fails`, () => {
      const r = evaluateShadowTraps(scenario(side, single[name]))[k];
      assert.equal(r.base, true);
      assert.deepEqual(r.failed, [name]);
      assert.deepEqual(r.unverified, []);
      assert.equal(r.strict, false);
    });
  }

  test(`${label}: proximity allows a break of up to 25 points, not more`, () => {
    const strike = side > 0 ? 25000 : 25100;
    assert.equal(evaluateShadowTraps(scenario(side, { spot: strike - side * 25 }))[k].conditions.proximity.pass, true);
    assert.equal(evaluateShadowTraps(scenario(side, { spot: strike - side * 26 }))[k].conditions.proximity.pass, false);
    assert.equal(evaluateShadowTraps(scenario(side, { spot: strike + side * 75 }))[k].conditions.proximity.pass, true);
  });

  test(`${label}: missing strike → proximity unverified, strict false`, () => {
    const r = evaluateShadowTraps(scenario(side, side > 0 ? { floorStrike: null } : { roofStrike: 0 }))[k];
    assert.deepEqual(r.unverified, ["proximity"]);
    assert.deepEqual(r.failed, []);
    assert.equal(r.conditions.proximity.pass, null);
    assert.equal(r.base, true);
    assert.equal(r.strict, false);
  });

  test(`${label}: gappy window → unverified, strict false`, () => {
    const skip = [683, 684, 685, 686, 687, 688];
    const r = evaluateShadowTraps(scenario(side, { skip }))[k];
    assert.deepEqual(r.unverified, ["recent", "relative", "stalled"]);
    assert.equal(r.strict, false);
    // no tick near the start of the 30-min window (first tick at 676)
    const late = scenario(side);
    late.timeline = late.timeline.filter((p) => p.minutes >= 676);
    const r2 = evaluateShadowTraps(late)[k];
    assert.ok(r2.unverified.includes("recent") && r2.unverified.includes("relative"));
    assert.equal(r2.conditions.stalled.pass, true); // its own 20-min window is covered
    assert.equal(r2.strict, false);
    // stale: last tick 6 min before now
    const stale = scenario(side);
    stale.timeline = stale.timeline.filter((p) => p.minutes <= 694);
    assert.deepEqual(evaluateShadowTraps(stale)[k].unverified, ["recent", "relative", "stalled"]);
    // synthetic ticks are not data
    const syn = scenario(side);
    syn.timeline = syn.timeline.map((p) => (p.minutes >= 683 && p.minutes <= 688 ? { ...p, synthetic: true } : p));
    assert.deepEqual(evaluateShadowTraps(syn)[k].unverified, ["recent", "relative", "stalled"]);
  });

  test(`${label}: base false ⇒ strict false regardless of conditions`, () => {
    for (const quadrant of ["LONG_BUILDUP", "SHORT_BUILDUP", "NEUTRAL_CHOP", side > 0 ? "SHORT_COVERING" : "LONG_UNWINDING", null]) {
      const r = evaluateShadowTraps(scenario(side, { quadrant }))[k];
      assert.equal(r.base, false);
      assert.deepEqual(r.failed, []); // every condition passed…
      assert.equal(r.strict, false); // …but base is false
    }
  });
}

test("partial / garbage input never throws and stays well-formed", () => {
  const inputs = [
    undefined, {}, { timeline: null }, { timeline: [null, 1, "x", { minutes: "a" }] }, { optionsMetrics: { deltaPcr: "abc" } },
    { quadrant: "LONG_UNWINDING", timeline: [{ minutes: 700 }], nowMins: 700 }, { nowMins: NaN, timeline: [{ minutes: 600, futPrice: 1 }] },
  ];
  for (const inp of inputs) {
    const r = evaluateShadowTraps(inp);
    for (const k of ["bearTrap", "bullTrap"]) {
      assert.equal(typeof r[k].base, "boolean");
      assert.equal(r[k].strict, false);
      assert.deepEqual(Object.keys(r[k].conditions), NAMES);
    }
  }
});

test("kill switch and env overrides", () => {
  assert.equal(getTrapShadowConfig({}).enabled, true);
  assert.equal(getTrapShadowConfig({ TRAP_SHADOW_ENABLED: "false" }).enabled, false);
  assert.equal(getTrapShadowConfig({ TRAP_SHADOW_ENABLED: "0" }).enabled, false);
  assert.equal(getTrapShadowConfig({ TRAP_SHADOW_ENABLED: "true" }).enabled, true);
  const disabled = getTrapShadowConfig({ TRAP_SHADOW_ENABLED: "False" });
  assert.equal(evaluateShadowTraps({ ...scenario(+1), config: disabled }), null);
  const c = getTrapShadowConfig({ TRAP_SHADOW_MIN_RELATIVE_RATIO: "20", TRAP_SHADOW_BULL_MAX_NET_CHANGE: "-30000", TRAP_SHADOW_BEAR_MIN_NET_CHANGE: "abc", TRAP_SHADOW_REARM_MIN: "15" });
  assert.equal(c.minRelativeRatio, 20);
  assert.equal(c.bullMaxNetChange, -30000);
  assert.equal(c.bearMinNetChange, TRAP_SHADOW_DEFAULTS.bearMinNetChange);
  assert.equal(c.rearmMin, 15);
  assert.equal(getTrapShadowConfig({ TRAP_SHADOW_BULL_MAX_NET_CHANGE: "5000" }).bullMaxNetChange, -26000); // wrong sign ignored
  const r = evaluateShadowTraps({ ...scenario(+1), config: c }).bearTrap;
  assert.deepEqual(r.failed, ["relative"]);
  // the captured state is unaffected when the reading carries no shadow result
  const out = sc.captureEvents(null, { t: 0, minutes: 700, futPrice: 25000, spot: 24980, trapShadow: null });
  assert.equal(out.events.length, 0);
  assert.equal(out.state.trapShadow, undefined);
});

// ── base cannot drift from the live rule ─────────────────────────────────────
// evaluateFusionScenario checks, in order: BULLISH_SYNERGY (LONG_BUILDUP only), BEARISH_SYNERGY
// (SHORT_BUILDUP only), BULL_TRAP (SHORT_COVERING), BEAR_TRAP (LONG_UNWINDING). The synergy
// branches require a different quadrant from either trap, and the two trap quadrants differ from
// each other, so an earlier branch can never pre-empt a trap: the live label is BEAR_TRAP exactly
// when quadrant = LONG_UNWINDING and isFloorPutBlitz, and BULL_TRAP exactly when quadrant =
// SHORT_COVERING and isRoofCallBlitz. The grid below still runs every quadrant (synergy included,
// with bullish/bearish basis) through the real evaluateSmartMoneyFusion and demands equality.
test("base equals the live fusion rule over a grid of quadrants × ΔPCR × blitz flags", () => {
  const fms = [
    null, // UNAVAILABLE
    { priceChangePct: 0.01, combinedOiChangePct: 0.01, priceChange: 2 }, // NEUTRAL_CHOP
    { priceChangePct: 0.5, combinedOiChangePct: 1, priceChange: 120 }, // LONG_BUILDUP
    { priceChangePct: -0.5, combinedOiChangePct: 1, priceChange: -120 }, // SHORT_BUILDUP
    { priceChangePct: 0.5, combinedOiChangePct: -1, priceChange: 120 }, // SHORT_COVERING
    { priceChangePct: -0.5, combinedOiChangePct: -1, priceChange: -120 }, // LONG_UNWINDING
  ];
  const bases = [{ adjustedBasisSpread: 10, rawBasis: 40, intradayBasisDelta: 6 }, { adjustedBasisSpread: -20, rawBasis: -5, intradayBasisDelta: -8 }];
  const dpcrs = [undefined, null, "abc", 0, 0.5, 0.69, 0.7, 0.71, 0.749, 0.75, 0.751, 0.9, 1, 1.29, 1.299, 1.3, 1.301, 1.35, 1.6, 2.5];
  const totals = [[300000, 200000], [200000, 300000], [0, 0]];
  const pcrs = [1.0, 0.5, 1.7];
  let n = 0;
  const seen = new Set();
  for (const fm0 of fms) for (const basis of bases) for (const deltaPcr of dpcrs) for (const floorPutWritingBlitz of [false, true]) for (const roofCallWritingBlitz of [false, true]) for (const [p, c] of totals) for (const pcr of pcrs) {
    const fm = fm0 ? { ...fm0, ...basis } : null;
    const om = { pcr, totalPutWriting: p, totalCallWriting: c, floorPutWritingBlitz, roofCallWritingBlitz };
    if (deltaPcr !== undefined) om.deltaPcr = deltaPcr;
    const live = evaluateSmartMoneyFusion(fm, om, { mode: "day" });
    const shadow = evaluateShadowTraps({ quadrant: live.quadrantInfo.quadrant, optionsMetrics: om, spot: 25000, floorStrike: 24900, roofStrike: 25100, timeline: [], nowMins: 700 });
    assert.equal(shadow.bearTrap.base, live.scenarioId === "BEAR_TRAP", JSON.stringify({ q: live.quadrantInfo.quadrant, om }));
    assert.equal(shadow.bullTrap.base, live.scenarioId === "BULL_TRAP", JSON.stringify({ q: live.quadrantInfo.quadrant, om }));
    seen.add(live.scenarioId);
    n++;
  }
  assert.ok(n > 5000);
  for (const id of ["BULLISH_SYNERGY", "BEARISH_SYNERGY", "BULL_TRAP", "BEAR_TRAP", "MIXED_FLOW"]) assert.ok(seen.has(id), `grid reaches ${id}`);
  // also with no options metrics at all (live defaults ΔPCR to 1.0)
  for (const fm of fms) {
    const live = evaluateSmartMoneyFusion(fm, null, { mode: "day" });
    const shadow = evaluateShadowTraps({ quadrant: live.quadrantInfo.quadrant, optionsMetrics: null });
    assert.equal(shadow.bearTrap.base, live.scenarioId === "BEAR_TRAP");
    assert.equal(shadow.bullTrap.base, live.scenarioId === "BULL_TRAP");
  }
});

// ── scorecard capture ────────────────────────────────────────────────────────
const side = (base, strict, dir) => ({ base, strict, conditions: {}, failed: strict ? [] : ["recent"], unverified: [], direction: dir });
const shadowReading = (m, { bb = false, bs = false, ub = false, us = false, rearmMin } = {}) => ({
  t: m * 60000, minutes: m, futPrice: 25000, spot: 24980, dq: { state: "OK", coveragePct: 100 },
  fusion: { quadrant: null, scenario: null }, turn: null, radar: null, eod: null,
  trapShadow: { enabled: true, minutes: m, quadrant: "LONG_UNWINDING", deltaPcr: 1.4, spot: 24980, floorStrike: 24950, roofStrike: 25100, ...(rearmMin ? { rearmMin } : {}), bearTrap: side(bb, bs, "BULLISH"), bullTrap: side(ub, us, "BEARISH") },
});
// Feeds readings through captureEvents with the same JSON round trip the store does.
function run(readings, prev = null) {
  let state = prev;
  const events = [];
  for (const r of readings) {
    const out = sc.captureEvents(state, r);
    events.push(...out.events);
    state = JSON.parse(JSON.stringify(out.state));
  }
  return { events, state };
}

test("capture: rising edge emits once; holding true emits nothing more", () => {
  const { events } = run([shadowReading(670), shadowReading(671, { bb: true }), shadowReading(672, { bb: true }), shadowReading(673, { bb: true })]);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.section, "TRAP_SHADOW");
  assert.equal(e.type, "BEAR_TRAP_BASE");
  assert.equal(e.direction, "BULLISH");
  assert.equal(e.minutes, 671);
  assert.equal(e.data.variant, "BEAR_TRAP_BASE");
  assert.equal(e.data.quadrant, "LONG_UNWINDING");
  assert.equal(e.data.deltaPcr, 1.4);
  assert.equal(e.data.floorStrike, 24950);
  assert.deepEqual(e.data.failed, ["recent"]);
});

test("capture: flicker within 10 minutes does not re-emit (13-Nov 11:12 / 11:15 / 11:20 pattern)", () => {
  const seq = [];
  for (let m = 672; m <= 685; m++) seq.push(shadowReading(m, { bb: m === 672 || m === 675 || m === 680 }));
  assert.equal(run(seq).events.length, 1);
});

test("capture: re-arms after 10 false minutes", () => {
  const seq = [shadowReading(600, { ub: true })];
  for (let m = 601; m <= 610; m++) seq.push(shadowReading(m)); // false 601..610: 9 minutes
  seq.push(shadowReading(611, { ub: true })); // not yet re-armed
  assert.equal(run(seq).events.length, 1);
  const seq2 = [shadowReading(600, { ub: true })];
  for (let m = 601; m <= 611; m++) seq2.push(shadowReading(m)); // false 601..611: 10 minutes
  seq2.push(shadowReading(612, { ub: true }));
  const { events } = run(seq2);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((e) => [e.type, e.direction, e.minutes]), [["BULL_TRAP_BASE", "BEARISH", 600], ["BULL_TRAP_BASE", "BEARISH", 612]]);
  assert.equal(events[0].data.roofStrike, 25100);
  // a configurable re-arm period travels with the reading
  const seq3 = [shadowReading(600, { ub: true, rearmMin: 3 }), shadowReading(601, { rearmMin: 3 }), shadowReading(604, { rearmMin: 3 }), shadowReading(605, { ub: true, rearmMin: 3 })];
  assert.equal(run(seq3).events.length, 2);
});

test("capture: BASE and STRICT in the same minute both recorded with distinct ids", () => {
  const { events, state } = run([shadowReading(700, { bb: true, bs: true, ub: true, us: true })]);
  assert.deepEqual(events.map((e) => e.type).sort(), ["BEAR_TRAP_BASE", "BEAR_TRAP_STRICT", "BULL_TRAP_BASE", "BULL_TRAP_STRICT"]);
  assert.equal(new Set(events.map((e) => e.id)).size, 4);
  assert.deepEqual(Object.keys(state.trapShadow).sort(), ["BEAR_TRAP_BASE", "BEAR_TRAP_STRICT", "BULL_TRAP_BASE", "BULL_TRAP_STRICT"]);
});

test("capture: state survives the JSON round trip and old states without the key", () => {
  const legacy = { fusionQuadrant: "LONG_BUILDUP", fusionScenario: null, turn: {}, radarKeys: [], eod: { lastSlot: null, lastCategory: null, last: null } };
  const a = run([shadowReading(600, { bs: true }), shadowReading(601)], legacy);
  assert.equal(a.events.filter((e) => e.section === "TRAP_SHADOW").length, 1);
  const frozen = JSON.parse(JSON.stringify(a.state));
  // continue from the stored (round-tripped) state: still disarmed (true again at 605 restarts the false count), re-arms at 616
  const b = run([shadowReading(605, { bs: true }), shadowReading(606), shadowReading(616), shadowReading(617, { bs: true })], frozen);
  assert.deepEqual(b.events.map((e) => e.minutes), [617]);
  assert.deepEqual(JSON.parse(JSON.stringify(b.state)), b.state);
});

test("TRAP_SHADOW events are measured with the directional rule", () => {
  const ticks = [];
  for (let m = 600; m <= 680; m++) ticks.push({ minutes: m, futPrice: 25000 + (m - 600) * 2, spot: 24980, futCombinedOI: 200000, putWriting: 0, callWriting: 0 });
  const series = sc.compactSeries(ticks);
  const [e] = run([shadowReading(600, { bb: true })]).events;
  e.futPrice = 25000;
  const out = sc.measureEvent(e, series, sc.getScorecardConfig({}));
  assert.equal(out.status, "MEASURED");
  assert.equal(out.hit, true);
  const [e2] = run([shadowReading(600, { ub: true })]).events;
  e2.futPrice = 25000;
  assert.equal(sc.measureEvent(e2, series, sc.getScorecardConfig({})).hit, false);
  assert.match(sc.HIT_RULES.TRAP_SHADOW, /Directional/);
});

// ── aggregate ────────────────────────────────────────────────────────────────
test("aggregate: byVariant counts and hit rates; documents without the section still aggregate", () => {
  const mk = (id, type, hit) => ({ ev: { id, section: "TRAP_SHADOW", type, minutes: 600, direction: "BULLISH", data: {} }, out: hit === null ? { status: "UNMEASURABLE", reason: "gap" } : { status: "MEASURED", hit, horizons: {}, excursion60: { status: "OK", mfePts: 10, maePts: -5 } } });
  const items = [mk("a", "BEAR_TRAP_BASE", true), mk("b", "BEAR_TRAP_BASE", false), mk("c", "BEAR_TRAP_BASE", null), mk("d", "BEAR_TRAP_STRICT", true), mk("e", "BULL_TRAP_BASE", false)];
  const day = { date: "2026-11-16", events: items.map((x) => x.ev), outcomes: Object.fromEntries(items.map((x) => [x.ev.id, x.out])) };
  const legacy = { date: "2026-11-13", events: [{ id: "f", section: "FUSION", type: "SCENARIO_CHANGE", direction: "BULLISH", minutes: 600, data: {} }], outcomes: { f: { status: "MEASURED", hit: true, horizons: {} } } };
  const empty = { date: "2026-11-12" };
  const agg = sc.aggregate([day, legacy, empty], { minSample: 30 });
  const s = agg.sections.TRAP_SHADOW;
  assert.equal(s.events, 5);
  assert.equal(s.measurable, 4);
  assert.match(s.rule, /Directional/);
  const v = s.byVariant;
  assert.deepEqual(Object.keys(v), ["BEAR_TRAP_BASE", "BEAR_TRAP_STRICT", "BULL_TRAP_BASE", "BULL_TRAP_STRICT"]);
  assert.deepEqual([v.BEAR_TRAP_BASE.events, v.BEAR_TRAP_BASE.measurable, v.BEAR_TRAP_BASE.hits, v.BEAR_TRAP_BASE.hitRate, v.BEAR_TRAP_BASE.excludedUnmeasurable], [3, 2, 1, 0.5, 1]);
  assert.deepEqual([v.BEAR_TRAP_STRICT.measurable, v.BEAR_TRAP_STRICT.hitRate], [1, 1]);
  assert.deepEqual([v.BULL_TRAP_BASE.hits, v.BULL_TRAP_BASE.hitRate], [0, 0]);
  assert.equal(v.BULL_TRAP_STRICT.events, 0);
  assert.equal(v.BULL_TRAP_STRICT.hitRate, null);
  assert.equal(v.BEAR_TRAP_BASE.tooFewToJudge, true);
  assert.ok(v.BEAR_TRAP_BASE.wilson95.lo < 0.5 && v.BEAR_TRAP_BASE.wilson95.hi > 0.5);
  assert.equal(agg.sections.FUSION.events, 1);
  // only old documents: the section is present and empty, no error
  const old = sc.aggregate([legacy, empty]);
  assert.equal(old.sections.TRAP_SHADOW.events, 0);
  assert.equal(old.sections.TRAP_SHADOW.byVariant.BEAR_TRAP_STRICT.events, 0);
  // rolling CSV carries one row per variant
  const csv = sc.aggregateToCsv(agg);
  for (const k of Object.keys(v)) assert.ok(csv.includes(`TRAP_SHADOW,variant:${k},`));
});

test("wiring: scorecard reading carries the shadow result; settings snapshot includes its config", () => {
  const shadow = evaluateShadowTraps(scenario(+1));
  const r = buildScorecardReading({ nowMs: 0, minutes: 700, futuresMetrics: null, spot: 25060, dataQuality: null, fusion: null, turnTracker: null, macroTurn: null, eodDecision: null, trapShadow: shadow });
  assert.equal(r.trapShadow, shadow);
  assert.equal(buildScorecardReading({ nowMs: 0, minutes: 700, spot: 1 }).trapShadow, null);
  const st = scorecardSettings({ TRAP_SHADOW_MIN_RELATIVE_RATIO: "4" });
  assert.equal(st.trapShadow.minRelativeRatio, 4);
  assert.equal(st.trapShadow.recentWindowMin, 30);
  assert.equal(st.envOverrides.TRAP_SHADOW_MIN_RELATIVE_RATIO, "4");
  const compact = ts.compactTrapShadow(shadow);
  assert.deepEqual(Object.keys(compact.bearTrap), ["base", "strict", "failed", "unverified", "direction"]);
});

// ── non-interference on recorded sessions ────────────────────────────────────
for (const day of ["11", "12"]) {
  test(`fixture 2026-11-${day}: evaluator runs minute by minute without throwing, output well-formed`, () => {
    const fx = JSON.parse(readFileSync(new URL(`./fixtures/nifty-oi-2026-11-${day}.json`, import.meta.url), "utf8"));
    const tl = fx.intradayTimeline;
    assert.ok(Array.isArray(tl) && tl.length > 50);
    let state = null;
    for (let i = 0; i < tl.length; i++) {
      const p = tl[i];
      const put = Number(p.putWriting);
      const call = Number(p.callWriting);
      const r = evaluateShadowTraps({
        quadrant: p.futQuadrant || null,
        optionsMetrics: { deltaPcr: call > 0 ? put / call : undefined, totalPutWriting: put, totalCallWriting: call },
        spot: p.spot,
        floorStrike: p.floor ?? fx.floor,
        roofStrike: p.roof ?? fx.roof,
        timeline: tl.slice(0, i + 1),
        nowMins: p.minutes,
      });
      assert.ok(r && r.enabled === true);
      for (const k of ["bearTrap", "bullTrap"]) {
        const x = r[k];
        assert.equal(typeof x.base, "boolean");
        assert.equal(typeof x.strict, "boolean");
        if (x.strict) assert.equal(x.base, true);
        assert.deepEqual(Object.keys(x.conditions), NAMES);
        for (const n of NAMES) assert.ok([true, false, null].includes(x.conditions[n].pass));
        assert.deepEqual([...x.failed, ...x.unverified].sort(), NAMES.filter((n) => x.conditions[n].pass !== true).sort());
      }
      const out = sc.captureEvents(state, { t: p.minutes * 60000, minutes: p.minutes, futPrice: p.futPrice, spot: p.spot, dq: { state: "OK" }, trapShadow: r });
      for (const e of out.events) assert.equal(e.section, "TRAP_SHADOW");
      state = JSON.parse(JSON.stringify(out.state));
    }
  });
}
