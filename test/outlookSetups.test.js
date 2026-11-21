import test from "node:test";
import assert from "node:assert/strict";
import { bs, pickStrike, computeSetups, evaluateSetupOutcome, tallySetups, getSetupConfig } from "../src/outlookSetups.js";
import { computeWeeklyOutlook, computeInvalidationLadder, sessionsBetween, chooseHorizon, getOutlookConfig } from "../src/weeklyOutlook.js";
import { chooseSetupExpiry, parseIndexQuote, reconcileSpotWithQuote, summariseChain, dteFromExpiry } from "../src/swingSummary.js";
import { createSwingHandler } from "../api/swing.js";

const CFG = getOutlookConfig({});
const SCFG = getSetupConfig({});

// ── trading sessions to expiry ─────────────────────────────────────────────────────────────────
test("sessionsBetween counts weekday sessions after the recorded day, and the closed days", () => {
  assert.deepEqual(sessionsBetween("2026-11-20", "2026-11-23"), { sessions: 1, closedDays: 2, calendarDays: 3 }, "Fri → Mon");
  assert.deepEqual(sessionsBetween("2026-11-20", "2026-12-01"), { sessions: 7, closedDays: 4, calendarDays: 11 });
  assert.deepEqual(sessionsBetween("2026-11-23", "2026-11-23"), { sessions: 0, closedDays: 0, calendarDays: 0 });
  assert.equal(sessionsBetween("bad", "2026-11-23"), null);
  assert.equal(sessionsBetween("2026-11-20", "2028-01-01"), null, "more than 400 days");
});

test("20-Nov-2026 case: the Monday 23-Nov weekly (1 session left) is not the weekly horizon; the 1-Dec weekly is", () => {
  const near = { expiry: "23-Nov-2026", dte: 3, spot: 25800.6, straddle: 235.4, callWall: 26000, putWall: 25000 };
  const next = { expiry: "01-Dec-2026", dte: 11, spot: 25800.6, straddle: 516.15, callWall: 26000, putWall: 25000 };
  const h = chooseHorizon({ date: "2026-11-20", chains: { near, nextWeekly: next } }, CFG);
  assert.equal(h.expiry, "01-Dec-2026");
  assert.equal(h.sessionsLeft, 7);
  assert.match(h.basis, /1 trading session left/);
});

// ── volatility (v2) ────────────────────────────────────────────────────────────────────────────
function volDays({ ranges, straddle, expiry, lastDate = "2026-11-20" }) {
  const dates = ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"];
  return dates.map((date, i) => ({
    date, source: "capture",
    spot: { open: 25500, high: 25500 + ranges[i] / 2, low: 25500 - ranges[i] / 2, close: 25500 },
    fut: { open: 25500, high: 25500, low: 25500, close: 25510, oiOpen: 2e5, oiClose: 2e5 },
    chains: { near: date === lastDate ? { expiry, spot: 25500, straddle, dte: 11, callWall: 26000, putWall: 25000, pcr: 1 } : null },
  }));
}

test("volatility v2: implied range a session ≈ 2 × straddle / √(sessions + 0.25 × closed days)", () => {
  // the real 20-Nov inputs on the 1-Dec weekly: 516 over 7 sessions + 4 closed days → ~365 vs 289 realised
  const o = computeWeeklyOutlook({ days: volDays({ ranges: [156.5, 221.75, 237.75, 393.85, 436.35], straddle: 516.15, expiry: "01-Dec-2026" }), config: CFG });
  const v = o.groups.volatility;
  assert.equal(v.inputs.sessionsLeft, 7);
  assert.equal(v.inputs.closedDaysLeft, 4);
  assert.equal(v.inputs.timeUnits, 8);
  assert.ok(Math.abs(v.inputs.impliedRangePerSession - (2 * 516.15) / Math.sqrt(8)) < 0.01);
  assert.equal(v.state, "NORMAL", "v1 called this EXPANDING (it compared 136 with 289)");
  // rich premium: same straddle, quiet market
  assert.equal(computeWeeklyOutlook({ days: volDays({ ranges: [150, 150, 150, 150, 150], straddle: 516.15, expiry: "01-Dec-2026" }), config: CFG }).groups.volatility.state, "COMPRESSED");
  // cheap premium: the market moves far more than the straddle implies
  assert.equal(computeWeeklyOutlook({ days: volDays({ ranges: [600, 650, 600, 700, 650], straddle: 516.15, expiry: "01-Dec-2026" }), config: CFG }).groups.volatility.state, "EXPANDING");
});

// ── ladder order + volume reference (20-Nov-2026) ──────────────────────────────────────────────
const bar = (date, open, high, low, close) => ({ date, spot: { open, high, low, close }, fut: { open, high, low, close: close - 30, oiChangePct: 0 } });
const PROFILE_20 = { bin: 25, bins: { 25150: 1e6, 25200: 1.5e6, 25225: 2.5e6, 25250: 1e6, 25400: 1e6, 25500: 1e6, 25700: 1e6, 25800: 1e6 }, vol: 1e7, pv: 25402.52 * 1e7 };
function nov20({ low20 = 25368, nearPut = { strike: 25700, oi: 112157 } } = {}) {
  const near = { expiry: "01-Dec-2026", dte: 11, spot: 25800.6, atm: 25800, straddle: 235.4, expectedRange: { low: 25565.2, high: 26036 }, callWall: 26000, putWall: 25000, pcr: 1.65, nearCallWall: { strike: 26000, oi: 218157 }, nearPutWall: nearPut };
  return [
    bar("2026-11-16", 25206.15, 25329.4, 25172.9, 25291.1),
    bar("2026-11-17", 25277.3, 25499.05, 25277.3, 25387.4),
    bar("2026-11-18", 25323.15, 25383.35, 25145.6, 25227.95),
    bar("2026-11-19", 25186.8, 25514.3, 25120.45, 25514.3),
    { ...bar("2026-11-20", 25368, 25804.35, low20, 25800.6), chains: { near }, volProfile: PROFILE_20 },
  ];
}

test("ladder: a warning never sits beyond step 2 (v1 put 25225 below the 25368 invalidation on 20-Nov)", () => {
  const ds = nov20({ nearPut: null });
  const l = computeInvalidationLadder({ ds, last: ds[4], chain: ds[4].chains.near, regime: "TREND_UP" });
  const [dn] = l.ladders;
  const byKey = Object.fromEntries(dn.steps.map((s) => [s.key, s]));
  assert.equal(byKey.INVALIDATED.value, 25368);
  if (byKey.WARNING) assert.ok(byKey.WARNING.value > byKey.INVALIDATED.zone.high, "warning comes first, above step 2");
  assert.equal(byKey.WARNING.value, 25402.52, "the VWAP (nearer of POC / VWAP) is between the close and step 2");
  // the volume reference is always kept, with the owner's wording
  assert.equal(l.volumeReference.poc, 25225);
  assert.match(l.volumeReference.text, /^1-session volume point of control 25,225 · 1-session volume-weighted average 25,403$/);
  assert.ok(l.volumeReference.closeVsVwap > 398 && l.volumeReference.closeVsVwap < 399);
});

test("ladder: with the official 25345 low the VWAP is still a valid warning; when nothing fits, a note says why", () => {
  const ds = nov20({ low20: 25345.2, nearPut: null });
  const l = computeInvalidationLadder({ ds, last: ds[4], chain: ds[4].chains.near, regime: "TREND_UP" });
  const keys = l.ladders[0].steps.map((s) => s.key);
  assert.deepEqual(keys, ["WARNING", "INVALIDATED", "FLIPPED"]);
  const vals = l.ladders[0].steps.map((s) => s.value);
  assert.ok(vals[0] > vals[1] && vals[1] > vals[2], "strictly ordered away from the close");
  // volume centre entirely beyond step 2 → no warning step, a note, and the reference stays
  const far = nov20({ low20: 25500, nearPut: null });
  far[4].volProfile = { bin: 25, bins: { 25200: 3e6, 25225: 5e6 }, vol: 8e6, pv: 25215 * 8e6 };
  const l2 = computeInvalidationLadder({ ds: far, last: far[4], chain: far[4].chains.near, regime: "TREND_UP" });
  assert.equal(l2.ladders[0].steps.find((s) => s.key === "WARNING"), undefined);
  assert.match(l2.ladders[0].warningNote, /beyond step 2/);
  assert.ok(l2.volumeReference.text.includes("25,225"));
});

test("ladder: the near-money wall is the warning when the volume centre lies beyond step 2", () => {
  const far = nov20({ low20: 25500, nearPut: { strike: 25700, oi: 112157 } });
  far[4].volProfile = { bin: 25, bins: { 25200: 3e6, 25225: 5e6 }, vol: 8e6, pv: 25215 * 8e6 };
  const l = computeInvalidationLadder({ ds: far, last: far[4], chain: far[4].chains.near, regime: "TREND_UP" });
  const w = l.ladders[0].steps[0];
  assert.equal(w.key, "WARNING");
  assert.equal(w.value, 25700);
  assert.ok(w.components.some((c) => c.type === "NEAR_PUT_WALL"));
});

// ── official index OHLC ────────────────────────────────────────────────────────────────────────
test("index quote: parsed tolerantly and applied when it agrees with the ticks (20-Nov low 25368 → 25345.2)", () => {
  const q = parseIndexQuote({ data: [{ index: "NIFTY BANK", high: 1, low: 1 }, { index: "NIFTY 50", open: 25368, high: 25808.8, low: 25345.2, last: 25800.6 }] });
  assert.deepEqual(q, { open: 25368, high: 25808.8, low: 25345.2, last: 25800.6 });
  assert.deepEqual(parseIndexQuote({ data: [{ indexSymbol: "NIFTY 50", openPrice: "25,368", dayHigh: "25,808.80", dayLow: "25,345.20", lastPrice: "25,800.60" }] }), q);
  assert.equal(parseIndexQuote({ data: [] }), null);
  assert.equal(parseIndexQuote(null), null);
  const notes = [];
  const spot = reconcileSpotWithQuote({ open: 25368, high: 25804.35, low: 25368, close: 25800.6 }, q, notes);
  assert.equal(spot.low, 25345.2);
  assert.equal(spot.high, 25808.8);
  assert.equal(spot.close, 25800.6, "close stays the tick close");
  assert.equal(spot.source, "nse-index-quote");
  assert.deepEqual(spot.ticks, { open: 25368, high: 25804.35, low: 25368 });
  assert.ok(notes.some((n) => /NSE index quote/.test(n)));
});

test("index quote: rejected when it disagrees with the ticks (wrong index, stale day)", () => {
  const ticks = { open: 25368, high: 25804.35, low: 25368, close: 25800.6 };
  const n1 = [];
  assert.deepEqual(reconcileSpotWithQuote(ticks, { open: 1, high: 25700, low: 25300, last: 25600 }, n1), ticks, "high below the tick high");
  assert.ok(n1.some((n) => /disagrees/.test(n)));
  assert.deepEqual(reconcileSpotWithQuote(ticks, { open: 25000, high: 25900, low: 25300, last: 25100 }, []), ticks, "last far from the close");
  assert.deepEqual(reconcileSpotWithQuote(ticks, null, []), ticks, "no quote → ticks unchanged");
});

// ── setup expiry and strike list ───────────────────────────────────────────────────────────────
test("setup expiry: the first monthly with ≥ 45 days (late November → January)", () => {
  const list = ["23-Nov-2026", "01-Dec-2026", "08-Dec-2026", "15-Dec-2026", "22-Dec-2026", "29-Dec-2026", "25-Jan-2027", "23-Feb-2027", "30-Mar-2027"];
  const now = Date.parse("2026-11-20T15:35:00+05:30");
  const dteOf = (e) => dteFromExpiry(e, now);
  assert.equal(chooseSetupExpiry(list, dteOf, 45), "25-Jan-2027", "29-Dec (39 days) is too close");
  assert.equal(chooseSetupExpiry(list, dteOf, 30), "29-Dec-2026");
  assert.equal(chooseSetupExpiry(["23-Nov-2026"], dteOf, 45), null);
  assert.equal(chooseSetupExpiry(null, dteOf, 45), null);
});

test("setup chain summary keeps a compact strike list near spot", () => {
  const rows = [];
  for (let k = 22000; k <= 29000; k += 100) rows.push({ strikePrice: k, CE: { lastPrice: Math.max(1, 25800 - k + 300), openInterest: 100, impliedVolatility: 15 }, PE: { lastPrice: Math.max(1, k - 25800 + 300), openInterest: 100, impliedVolatility: 16 } });
  const c = summariseChain({ rows, spot: 25800, expiry: "25-Jan-2027", dte: 66, withStrikes: true });
  assert.ok(c.strikes.length > 0 && c.strikes.length <= 90);
  assert.ok(c.strikes.every((x) => Math.abs(x.k - 25800) <= 0.12 * 25800));
  assert.deepEqual(Object.keys(c.strikes[0]).sort(), ["ce", "ceIv", "ceOi", "k", "pe", "peIv", "peOi"]);
  assert.equal(summariseChain({ rows, spot: 25800, expiry: "25-Jan-2027", dte: 66 }).strikes, undefined);
});

// ── Black–Scholes and strike choice ────────────────────────────────────────────────────────────
test("Black–Scholes: put–call parity, delta signs, ATM delta about 0.5", () => {
  const S = 25800, K = 26000, T = 66 / 365, iv = 0.15, r = 0.065;
  const c = bs({ type: "CE", S, K, tYears: T, iv, r });
  const p = bs({ type: "PE", S, K, tYears: T, iv, r });
  assert.ok(Math.abs(c.price - p.price - (S - K * Math.exp(-r * T))) < 0.01, "parity");
  assert.ok(c.delta > 0 && c.delta < 1 && p.delta < 0 && p.delta > -1);
  assert.ok(Math.abs(c.delta - p.delta - 1) < 1e-9);
  assert.ok(Math.abs(bs({ type: "CE", S, K: S, tYears: T, iv, r: 0 }).delta - 0.5) < 0.02);
  assert.equal(bs({ type: "CE", S, K, tYears: T, iv: 0 }), null);
});

function janChain(spot = 25800, iv = 15) {
  const strikes = [];
  for (let k = 23500; k <= 28500; k += 100) {
    const ce = bs({ type: "CE", S: spot, K: k, tYears: 66 / 365, iv: iv / 100, r: 0.065 }).price;
    const pe = bs({ type: "PE", S: spot, K: k, tYears: 66 / 365, iv: iv / 100, r: 0.065 }).price;
    strikes.push({ k, ce: Math.round(ce * 10) / 10, pe: Math.round(pe * 10) / 10, ceIv: iv, peIv: iv, ceOi: 1000, peOi: 1000 });
  }
  return { expiry: "25-Jan-2027", dte: 66, spot, atmIv: { ce: iv, pe: iv }, callWall: 27000, putWall: 25000, strikes };
}

test("strike choice: OTM, nearest the 0.375 target delta, inside the band", () => {
  const ce = pickStrike({ setupChain: janChain(), type: "CE", cfg: SCFG });
  const pe = pickStrike({ setupChain: janChain(), type: "PE", cfg: SCFG });
  assert.ok(ce.strike > 25800 && Math.abs(ce.delta - 0.375) < 0.05);
  assert.ok(pe.strike < 25800 && Math.abs(Math.abs(pe.delta) - 0.375) < 0.05);
  assert.equal(pickStrike({ setupChain: { ...janChain(), strikes: [] }, type: "CE", cfg: SCFG }), null);
});

// ── setups ─────────────────────────────────────────────────────────────────────────────────────
function setupInputs({ close = 25720, regime = "RANGE", nearPut = { strike: 25700, oi: 112157 }, nearCall = { strike: 26000, oi: 218157 } } = {}) {
  const chain = { expiry: "01-Dec-2026", straddle: 235.4, spot: close, expectedRange: { low: close - 235.4, high: close + 235.4 }, callWall: 26000, putWall: 25000, nearPutWall: nearPut, nearCallWall: nearCall };
  const levels = {
    prevDayLow: 25345.2, prevDayHigh: 25808.8, prevDayDate: "2026-11-20", prevWeekLow: 25104.8, prevWeekHigh: 25808.8,
    ladder: { inputs: { swingLow: { value: 25104.8, date: "2026-11-19" }, swingHigh: { value: 25499.05, date: "2026-11-17" } }, volumeReference: { poc: 25225, vwap: 25402.52, val: 25162.5, vah: 25487.5, sessions: 5 } },
  };
  return { regime, last: { date: "2026-11-20", spot: { close, high: close + 20, low: close - 20 } }, chain, setupChain: janChain(close), levels, volatility: { available: true, state: "NORMAL" }, cfg: SCFG };
}

test("setups: calls near the 25700 put wall trigger in a RANGE when R:R ≥ 1.5; puts wait below the 26000 call wall", () => {
  const s = computeSetups(setupInputs());
  assert.equal(s.call.status, "IN_ZONE");
  assert.equal(s.call.zone.low, 25700);
  assert.equal(s.call.stop.value, 25499.05, "next structure past the zone: the 17-Nov swing high / VAH region");
  assert.equal(s.call.target.value, 26000);
  assert.ok(s.call.rr >= 1.25);
  assert.equal(s.call.triggered, s.call.rr >= 1.5);
  assert.equal(s.call.option.expiry, "25-Jan-2027");
  assert.equal(s.call.option.type, "CE");
  assert.ok(s.call.option.estAtTarget > s.call.option.estAtEntry && s.call.option.estAtStop < s.call.option.estAtEntry);
  assert.equal(s.put.status, "WAITING");
  assert.equal(s.put.zone.low, 26000);
  assert.equal(s.put.target.value, 25700);
});

test("setups: a setup with R:R ≥ 1.5 inside the zone triggers", () => {
  // close 25710 at the 25700 wall, stop 25499 (211 pts), T1 26100 (390 pts) → 1.85
  const s = computeSetups(setupInputs({ close: 25710, nearCall: { strike: 26100, oi: 200000 } }));
  assert.equal(s.call.status, "IN_ZONE");
  assert.equal(s.call.rr, 1.85);
  assert.equal(s.call.triggered, true);
  assert.equal(s.call.option.estAtEntry, s.call.option.ltp, "in the zone: the recorded premium is the entry");
});

test("setups: a wall on the wrong side of the close is a BROKEN zone, not missing data", () => {
  const s = computeSetups(setupInputs({ close: 25600, nearPut: { strike: 25700, oi: 112157 } }));
  assert.equal(s.call.status, "BROKEN");
  assert.equal(s.call.triggered, false);
  assert.match(s.call.reasons.join(" "), /already below the put wall 25,700/);
});

test("ladder: with no step 2 (close at the session low) the warning is bounded by step 3", () => {
  const ds = nov20({ nearPut: null });
  ds[4] = { ...ds[4], spot: { open: 25400, high: 25450, low: 25300, close: 25300 } };
  ds[4].volProfile = { bin: 25, bins: { 25025: 5e6, 25100: 3e6 }, vol: 8e6, pv: 25100 * 8e6 };
  const l = computeInvalidationLadder({ ds, last: ds[4], chain: { ...ds[4].chains.near, spot: 25300 }, regime: "TREND_UP" });
  const steps = l.ladders[0].steps;
  assert.equal(steps.find((x) => x.key === "INVALIDATED"), undefined);
  const vals = steps.map((x) => x.value);
  for (let i = 1; i < vals.length; i++) assert.ok(vals[i] < vals[i - 1], `ordered: ${JSON.stringify(steps.map((x) => [x.key, x.value]))}`);
  if (!steps.some((x) => x.key === "WARNING")) assert.match(l.ladders[0].warningNote, /beyond step 3/);
});

test("index quote: accepted on a sparse-tick day although its range is far wider than the ticks'", () => {
  const notes = [];
  const out = reconcileSpotWithQuote({ open: 25500, high: 25510, low: 25490, close: 25500 }, { open: 25400, high: 25600, low: 25350, last: 25502 }, notes);
  assert.equal(out.source, "nse-index-quote");
  assert.equal(out.low, 25350);
  // but a last outside the quote's own range is rejected
  const t = { open: 25500, high: 25510, low: 25490, close: 25500 };
  assert.deepEqual(reconcileSpotWithQuote(t, { open: 25400, high: 25600, low: 25350, last: 25650 }, []), t);
});

test("setups: the regime blocks the side that fights it; INSUFFICIENT_DATA blocks both", () => {
  const up = computeSetups(setupInputs({ regime: "TREND_UP" }));
  assert.equal(up.call.allowed, true);
  assert.equal(up.put.allowed, false);
  assert.equal(up.put.status, "BLOCKED");
  assert.equal(up.put.triggered, false);
  const dn = computeSetups(setupInputs({ regime: "BREAK_RISK_DOWN" }));
  assert.equal(dn.call.status, "BLOCKED");
  const none = computeSetups(setupInputs({ regime: "INSUFFICIENT_DATA" }));
  assert.equal(none.call.allowed || none.put.allowed, false);
});

test("setups: no near-money wall → no zone (a previous-day extreme is not support); T1 falls back to the NEARER of wall / range edge", () => {
  const s = computeSetups(setupInputs({ nearPut: null, nearCall: null }));
  assert.equal(s.call.status, "NO_DATA");
  assert.equal(s.call.triggered, false);
  assert.match(s.call.reasons.join(" "), /No near-money put OI wall/);
  // only the opposite near wall missing: T1 = min distance of the 26000 whole-chain wall and the 25955 range edge
  const s2 = computeSetups(setupInputs({ nearCall: null }));
  assert.equal(s2.call.target.value, 25720 + 235.4);
  assert.match(s2.call.target.note, /expected-range high/);
});

test("setups: no setup chain yet → the option line says so; rich premium is flagged", () => {
  const inp = setupInputs();
  const s = computeSetups({ ...inp, setupChain: null, volatility: { available: true, state: "COMPRESSED" } });
  assert.equal(s.call.option, null);
  assert.match(s.call.reasons.join(" "), /recorded from the next daily capture/);
  assert.equal(s.premium.rich, true);
});

// ── outcomes ───────────────────────────────────────────────────────────────────────────────────
const later = (rows) => rows.map(([date, high, low, close, cePx]) => ({ date, spot: { high, low, close }, chains: cePx ? { setup: { expiry: "25-Jan-2027", strikes: [{ k: 26500, ce: cePx, pe: 300 }] } } : {} }));
const trig = { triggered: true, type: "CE", target: { value: 26000 }, stop: { value: 25499.05 }, option: { expiry: "25-Jan-2027", strike: 26500, type: "CE", ltp: 400 } };

test("setup outcome: T1 touched by a later high → TARGET, with the real recorded option price", () => {
  const o = evaluateSetupOutcome({ setup: trig, asOf: "2026-11-20", laterDays: later([["2026-11-23", 25850, 25700, 25820, 430], ["2026-11-24", 26010, 25800, 25950, 520]]) });
  assert.equal(o.status, "TARGET");
  assert.equal(o.exitDate, "2026-11-24");
  assert.equal(o.optionExit, 520);
  assert.equal(o.optionPnlPct, 30);
});

test("setup outcome: a daily close past the stop → STOP; both on one day → STOP; nothing → OPEN then EXPIRED", () => {
  assert.equal(evaluateSetupOutcome({ setup: trig, asOf: "2026-11-20", laterDays: later([["2026-11-23", 25600, 25400, 25450]]) }).status, "STOP");
  assert.equal(evaluateSetupOutcome({ setup: trig, asOf: "2026-11-20", laterDays: later([["2026-11-23", 26050, 25400, 25450]]) }).status, "STOP", "conservative");
  assert.equal(evaluateSetupOutcome({ setup: trig, asOf: "2026-11-20", laterDays: later([["2026-11-23", 25800, 25600, 25700]]) }).status, "OPEN");
  const many = Array.from({ length: 16 }, (_, i) => [`2026-12-${String(i + 1).padStart(2, "0")}`, 25800, 25600, 25700]);
  assert.equal(evaluateSetupOutcome({ setup: trig, asOf: "2026-11-20", laterDays: later(many) }).status, "EXPIRED");
  assert.equal(evaluateSetupOutcome({ setup: { ...trig, triggered: false }, asOf: "2026-11-20", laterDays: [] }).status, "NOT_TRIGGERED");
});

test("setup tally: consecutive days of the same setup count once", () => {
  const s = { triggered: true, option: { expiry: "25-Jan-2027", strike: 26500 }, zone: { low: 25700 } };
  const past = [
    { date: "2026-11-20", setups: { call: s }, setupOutcomes: { call: { status: "TARGET", optionPnlPct: 30 } } },
    { date: "2026-11-23", setups: { call: s }, setupOutcomes: { call: { status: "TARGET", optionPnlPct: 20 } } },
    { date: "2026-11-24", setups: { call: { ...s, triggered: false } } },
    { date: "2026-11-25", setups: { call: s }, setupOutcomes: { call: { status: "STOP", optionPnlPct: -40 } } },
  ];
  const t = tallySetups(past);
  assert.equal(t.call.n, 2);
  assert.equal(t.call.target, 1);
  assert.equal(t.call.stop, 1);
  assert.equal(t.call.avgOptionPnlPct, -5);
  assert.equal(t.put.n, 0);
});

// ── API ────────────────────────────────────────────────────────────────────────────────────────
test("GET /api/swing: v2 snapshots carry setups and measured setup outcomes; the tally counts them", async () => {
  const snap = { regime: "RANGE", asOf: "2026-11-20", reference: { spotClose: 25720 }, expectedRange: { low: 25484, high: 25955, expiry: "01-Dec-2026" }, horizon: { expiry: "01-Dec-2026" }, setups: { call: trig, put: null, setupExpiry: "25-Jan-2027" } };
  const store = new Map([
    ["nifty:swing:day:2026-11-20", { date: "2026-11-20", spot: { open: 25700, high: 25740, low: 25700, close: 25720 }, chains: {} }],
    ["nifty:swing:outlook:2026-11-20", snap],
    ["nifty:swing:day:2026-11-23", { date: "2026-11-23", spot: { open: 25720, high: 26010, low: 25700, close: 25990 }, chains: { setup: { expiry: "25-Jan-2027", strikes: [{ k: 26500, ce: 500, pe: 300 }] } } }],
  ]);
  const handler = createSwingHandler({ now: () => Date.parse("2026-11-23T16:00:00+05:30"), mget: async (ks) => ks.map((k) => store.get(k) ?? null), env: () => ({}) });
  let body = null;
  const res = { setHeader() {}, status() { return this; }, json(b) { body = b; return this; }, end() { return this; } };
  await handler({ method: "GET", query: { days: "5" } }, res);
  assert.equal(body.ok, true, body.error);
  const p = body.pastOutlooks.find((x) => x.date === "2026-11-20");
  assert.equal(p.setupOutcomes.call.status, "TARGET");
  assert.equal(p.setupOutcomes.call.optionPnlPct, 25);
  assert.equal(body.tally.setups.call.n, 1);
  assert.equal(body.tally.setups.call.target, 1);
  assert.ok(body.outlook.setups, "the live outlook carries setups");
});

test("ladder step 3 without a swing: the nearer of the near-money wall and the range edge (20-Nov: 26000, not 26317)", () => {
  const ds = nov20({ nearPut: null });
  const near = { ...ds[4].chains.near, straddle: 516.15, expectedRange: { low: 25284.45, high: 26316.75 }, nearCallWall: { strike: 26000, oi: 72677 } };
  ds[4] = { ...ds[4], chains: { near } };
  const l = computeInvalidationLadder({ ds, last: ds[4], chain: near, regime: "RANGE" });
  const up = l.ladders.find((x) => x.side === "above");
  const flip = up.steps.find((s) => s.key === "FLIPPED");
  assert.equal(flip.value, 26000);
  assert.equal(flip.components[0].type, "NEAR_CALL_WALL");
  assert.match(flip.basis, /no recorded swing beyond step 2/);
  // wall missing → the range edge, as before
  const l2 = computeInvalidationLadder({ ds, last: ds[4], chain: { ...near, nearCallWall: null }, regime: "RANGE" });
  assert.equal(l2.ladders.find((x) => x.side === "above").steps.find((s) => s.key === "FLIPPED").value, 26316.75);
});
