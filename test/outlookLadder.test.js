import test from "node:test";
import assert from "node:assert/strict";
import { profileFromSeries, profileFromTicks, combineProfiles } from "../src/volumeProfile.js";
import { computeInvalidationLadder, computeWeeklyOutlook, ladderBreaches, evaluateOutlookOutcome } from "../src/weeklyOutlook.js";
import { summariseChain, buildDailySummary } from "../src/swingSummary.js";
import { createSwingHandler } from "../api/swing.js";

// ── volume profile ─────────────────────────────────────────────────────────────────────────────
test("volume profile: per-minute futures volume at spot price; resets and the auction freeze are skipped", () => {
  const p = profileFromSeries({
    m: [555, 556, 557, 558, 916, 931, 932],
    s: [25200, 25210, 25230, 25240, 25300, 25260, 25260],
    v: [5000000, 1000, 3000, 4000, 9000, 9500, 10500], // 09:15 carries yesterday's cumulative volume
  });
  // 09:16 is the volume reset (not counted), 15:16 is inside the auction freeze (skipped):
  // counted = 2000 (09:17 @ 25230) + 1000 (09:18 @ 25240) + 500 (15:31) + 1000 (15:32)
  assert.equal(p.vol, 4500);
  assert.equal(p.bins[25225], 2000);
  assert.equal(p.bins[25250], 1000 + 500 + 1000);
  assert.equal(profileFromTicks([{ minutes: 600, spot: 25000, futVolume: 1 }]), null, "no volume → null");
});

test("combined profile: point of control, 70% value area grown from it, VWAP", () => {
  const a = { bin: 25, bins: { 25200: 100, 25225: 400, 25250: 300, 25275: 100, 25300: 100 }, vol: 1000, pv: 25240 * 1000 };
  const c = combineProfiles([a]);
  assert.equal(c.poc, 25225);
  assert.equal(c.val, 25212.5);
  assert.equal(c.vah, 25262.5);
  assert.equal(c.vwap, 25240);
  assert.equal(combineProfiles([]), null);
});

// ── near-money walls in the chain summary ──────────────────────────────────────────────────────
test("chain summary records the largest call OI above and put OI below spot within the expected range", () => {
  const rows = [
    { strikePrice: 24000, CE: { lastPrice: 1300, openInterest: 100 }, PE: { lastPrice: 5, openInterest: 900000 } },
    { strikePrice: 25000, CE: { lastPrice: 300, openInterest: 50000 }, PE: { lastPrice: 70, openInterest: 217201 } },
    { strikePrice: 25200, CE: { lastPrice: 200, openInterest: 111887 }, PE: { lastPrice: 150, openInterest: 197447 } },
    { strikePrice: 25300, CE: { lastPrice: 150, openInterest: 152300 }, PE: { lastPrice: 170, openInterest: 128553 } },
    { strikePrice: 25500, CE: { lastPrice: 80, openInterest: 189266 }, PE: { lastPrice: 300, openInterest: 64892 } },
    { strikePrice: 26000, CE: { lastPrice: 10, openInterest: 950000 }, PE: { lastPrice: 700, openInterest: 100 } },
  ];
  const c = summariseChain({ rows, spot: 25283, expiry: "23-Nov-2026", dte: 4 });
  assert.equal(c.callWall, 26000, "whole-chain wall unchanged");
  assert.equal(c.putWall, 24000);
  assert.ok(c.straddle > 0);
  assert.deepEqual(c.nearCallWall, { strike: 25500, oi: 189266 }, "the far 26000 is outside the expected range");
  assert.deepEqual(c.nearPutWall, { strike: 25000, oi: 217201 });
});

// ── the ladder on the real 12–18 Nov closes ────────────────────────────────────────────────────
const bar = (date, open, high, low, close) => ({ date, spot: { open, high, low, close }, fut: { open, high, low, close: close + 20, oiChangePct: 0 } });
const PROFILE = { bin: 25, bins: { 25100: 2e5, 25150: 3e5, 25200: 6e5, 25225: 9e5, 25250: 7e5, 25275: 5e5, 25300: 3e5, 25350: 2e5, 25375: 1e5 }, vol: 3.8e6, pv: 25271.83 * 3.8e6 };
function days(withWalls = false) {
  const near = { expiry: "23-Nov-2026", dte: 5, spot: 25227.95, atm: 25250, straddle: 327.15, expectedRange: { low: 24900.8, high: 25555.1 }, callWall: 26000, putWall: 24000, pcr: 0.86,
    ...(withWalls ? { nearCallWall: { strike: 25500, oi: 189266 }, nearPutWall: { strike: 25000, oi: 217201 } } : {}) };
  return [
    bar("2026-11-12", 25213.5, 25374.15, 25192.3, 25299.35),
    bar("2026-11-13", 25209.85, 25241.4, 25056.45, 25144.3),
    bar("2026-11-16", 25206.15, 25329.4, 25172.9, 25291.1),
    bar("2026-11-17", 25277.3, 25499.05, 25277.3, 25387.4),
    { ...bar("2026-11-18", 25323.15, 25383.35, 25145.6, 25227.95), chains: { near }, volProfile: PROFILE },
  ];
}

test("bearish view on 18-Nov: warning at the volume centre, invalidated above the 18-Nov high, flipped above the 17-Nov swing high", () => {
  const ds = days(true);
  const l = computeInvalidationLadder({ ds, last: ds[ds.length - 1], chain: ds[4].chains.near, regime: "TREND_DOWN" });
  assert.equal(l.view, "BEARISH");
  const [up] = l.ladders;
  assert.equal(up.side, "above");
  const byKey = Object.fromEntries(up.steps.map((s) => [s.key, s]));
  assert.equal(byKey.WARNING.value, 25271.83);
  assert.equal(byKey.INVALIDATED.value, 25383.35);
  assert.ok(byKey.INVALIDATED.components.some((c) => c.type === "PREV_DAY_HIGH"));
  assert.equal(byKey.FLIPPED.zone.low, 25499.05);
  assert.equal(byKey.FLIPPED.value, 25500, "merged with the 25500 near-money call wall");
  assert.ok(byKey.FLIPPED.components.some((c) => c.type === "NEAR_CALL_WALL"));
  assert.ok(byKey.WARNING.value < byKey.INVALIDATED.value && byKey.INVALIDATED.value < byKey.FLIPPED.value);
  assert.equal(byKey.FLIPPED.distance, 272.05);
});

test("the outlook's invalidation now comes from the ladder, not the 26000 call wall", () => {
  const o = computeWeeklyOutlook({ days: days(true) });
  if (o.regime === "TREND_DOWN") {
    assert.equal(o.levels.invalidation.source, "ladder");
    assert.equal(o.levels.invalidation.value, 25383.35);
    assert.doesNotMatch(o.headline, /26000/);
  }
  assert.equal(o.levels.callWall, 26000, "the whole-chain wall is still reported, as information");
  assert.ok(o.levels.ladder, "a ladder for every non-insufficient regime");
});

test("bullish mirror and range (both sides); no recorded swing → the expected-range edge", () => {
  const ds = days(true);
  const last = ds[4], chain = last.chains.near;
  const bull = computeInvalidationLadder({ ds, last, chain, regime: "TREND_UP" });
  assert.equal(bull.view, "BULLISH");
  const dn = bull.ladders[0];
  assert.equal(dn.side, "below");
  assert.ok(dn.steps.every((s) => s.value < 25227.95));
  const rng = computeInvalidationLadder({ ds, last, chain, regime: "RANGE" });
  assert.deepEqual(rng.ladders.map((l) => l.side), ["above", "below"]);
  // only two sessions: no confirmed swing → FLIPPED falls back to the NEARER of the near-money call
  // wall (25500) and the expected-range high (25555); without the wall, the range edge
  const two = ds.slice(3);
  const l2 = computeInvalidationLadder({ ds: two, last: two[1], chain, regime: "TREND_DOWN" });
  const f = l2.ladders[0].steps.find((s) => s.key === "FLIPPED");
  assert.equal(f.components[0].type, "NEAR_CALL_WALL");
  assert.equal(f.value, 25500);
  const l3 = computeInvalidationLadder({ ds: two, last: two[1], chain: { ...chain, nearCallWall: null }, regime: "TREND_DOWN" });
  assert.ok(l3.ladders[0].steps.find((s) => s.key === "FLIPPED").components.some((c) => c.type === "EXPECTED_RANGE"));
  assert.equal(computeInvalidationLadder({ ds, last, chain, regime: "INSUFFICIENT_DATA" }), null);
});

test("breaches: the first later daily close beyond each step, within the horizon", () => {
  const ds = days(true);
  const l = computeInvalidationLadder({ ds, last: ds[4], chain: ds[4].chains.near, regime: "TREND_DOWN" });
  const later = [bar("2026-11-19", 25186, 25300, 25120, 25290), bar("2026-11-20", 25290, 25420, 25280, 25400)];
  const b = ladderBreaches(l, later)[0].steps;
  assert.equal(b.find((x) => x.key === "WARNING").breachedOn, "2026-11-19");
  assert.equal(b.find((x) => x.key === "INVALIDATED").breachedOn, "2026-11-20");
  assert.equal(b.find((x) => x.key === "FLIPPED").breachedOn, null);
  const out = evaluateOutlookOutcome({ outlook: { asOf: "2026-11-18", regime: "TREND_DOWN", reference: { spotClose: 25227.95 }, horizon: { expiry: "23-Nov-2026" }, levels: { ladder: l } }, laterDays: later });
  assert.equal(out.status, "PENDING");
  assert.equal(out.ladderBreaches[0].steps.find((x) => x.key === "INVALIDATED").breachedOn, "2026-11-20");
});

test("daily capture stores a volume profile", () => {
  const timeline = [];
  for (let m = 555; m <= 600; m++) timeline.push({ minutes: m, spot: 25200 + (m - 555), futPrice: 25220 + (m - 555), futCombinedOI: 200000, futVolume: 10000 * (m - 554), isLiveTick: true });
  const s = buildDailySummary({ date: "2026-11-19", timeline, minLiveTicks: 10 });
  assert.ok(s.volProfile && s.volProfile.vol > 0);
});

test("swing API: days captured before the profile existed get one from the scorecard series", async () => {
  const d18 = { ...bar("2026-11-18", 25323.15, 25383.35, 25145.6, 25227.95), v: 1, source: "capture", chains: { near: null, nextWeekly: null, monthly: null } };
  const series = { m: [600, 601, 602], s: [25220, 25230, 25240], v: [1000, 3000, 6000], f: [25240, 25250, 25260] };
  const store = { "nifty:swing:day:2026-11-18": d18, "nifty:sc:day:2026-11-18": { date: "2026-11-18", series, events: [{ id: "x" }] } };
  const handler = createSwingHandler({ now: () => Date.parse("2026-11-19T10:00:00Z"), mget: async (ks) => ks.map((k) => store[k] ?? null), env: () => ({}) });
  let out = null;
  const res = { setHeader() {}, status() { return this; }, json(b) { out = b; return this; }, end() { return this; } };
  await handler({ method: "GET", query: { days: "5" } }, res);
  assert.equal(out.ok, true);
  assert.ok(out.outlook);
});
