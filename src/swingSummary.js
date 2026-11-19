/**
 * Daily swing summary (SHADOW — display and measurement only).
 *
 * One compact document per weekday session, written near the close (15:20–15:40 IST) by the
 * refresh core: spot / futures OHLC from the real ticks, a summary of the near, next-weekly and
 * monthly option chains (ATM straddle, expected range, OI walls, PCR) and the near-expiry intraday
 * writing. Nothing in the live decision path reads these documents; they feed the Weekly Outlook
 * (src/weeklyOutlook.js) shown by GET /api/swing. See docs/weekly-outlook.md.
 *
 * Every function here is pure (or takes its I/O as injected deps) and never throws.
 */
import { isSpotFrozenAt } from "./flowCalc.js";
import { firstLiveIndex } from "./sessionOpen.js";
import { profileFromTicks, profileFromSeries } from "./volumeProfile.js";

const hhmmOf = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
import { keys as scKeys, isSessionDayDoc } from "./scorecard.js";
import { computeWeeklyOutlook, getOutlookConfig, expiryToIso } from "./weeklyOutlook.js";

export const SWING_SUMMARY_VERSION = 1;
export const SWING_CAPTURE_END_MINS = 940; // 15:40 IST, last F&O minute
export const SWING_PARTIAL_COVERAGE_PCT = 50; // a captured day below this tick coverage is partial
// With at least this many live ticks (isLiveTick !== false), OHLC/OI use live ticks only, so
// gap-bridging (interpolated) ticks synced back by a browser cannot set a high or low.
export const SWING_MIN_LIVE_TICKS = 30;

export const swingKeys = {
  day: (d) => `nifty:swing:day:${d}`,
  outlook: (d) => `nifty:swing:outlook:${d}`,
  lock: "nifty:swing:capture_lock",
};

const posNum = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** "HH:MM" → minutes after midnight, or the default. */
export function parseHhmm(raw, d) {
  const m = String(raw ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return d;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return d;
  return h * 60 + mi;
}

export function getSwingConfig(env = process.env) {
  const e = env || {};
  return {
    enabled: String(e.SWING_ENABLED ?? "true").trim().toLowerCase() !== "false",
    captureStartMins: parseHhmm(e.SWING_CAPTURE_START, 920), // 15:20 IST
    captureEndMins: SWING_CAPTURE_END_MINS,
    captureEverySec: Math.round(posNum(e.SWING_CAPTURE_EVERY_SEC, 300)),
    retentionDays: Math.round(posNum(e.SWING_RETENTION_DAYS, 400)),
    fetchTimeoutMs: Math.round(posNum(e.SWING_FETCH_TIMEOUT_MS, 3500)),
    minBudgetMs: Math.round(posNum(e.SWING_MIN_BUDGET_MS, 4500)),
    maxCaptureMs: Math.round(posNum(e.SWING_MAX_CAPTURE_MS, 5000)),
    lookbackDays: Math.round(posNum(e.SWING_OUTLOOK_LOOKBACK_DAYS, 21)),
    minLiveTicks: Math.round(posNum(e.SWING_MIN_LIVE_TICKS, SWING_MIN_LIVE_TICKS)),
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const finite = (v) => v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));

export { expiryToIso };

/**
 * Same semantics as calculateDte in api/nifty-oi.js (calendar days to 15:30 IST on the expiry
 * date, rounded up, never negative), from an explicit epoch ms. Used only when dte is not passed in.
 */
export function dteFromExpiry(expiry, nowMs = Date.now()) {
  const iso = expiryToIso(expiry);
  if (!iso || !Number.isFinite(Number(nowMs))) return 0;
  const expMs = Date.parse(`${iso}T15:30:00+05:30`);
  return Math.max(0, Math.ceil((expMs - Number(nowMs)) / 86400000));
}

/**
 * Summary of one NSE option chain. rows: [{ strikePrice, CE: {...}, PE: {...} }].
 * Returns null (never throws) when there is no usable ATM pair.
 */
export function summariseChain({ rows, spot, expiry = null, nowMs = Date.now(), dte = null } = {}) {
  try {
    const s = Number(spot);
    if (!Array.isArray(rows) || !rows.length || !(s > 0)) return null;
    const notes = [];
    const clean = rows
      .filter((r) => r && finite(r.strikePrice) && Number(r.strikePrice) > 0)
      .map((r) => ({
        strike: Number(r.strikePrice),
        ceLtp: Number(r.CE?.lastPrice) || 0,
        peLtp: Number(r.PE?.lastPrice) || 0,
        ceOi: Number(r.CE?.openInterest) || 0,
        peOi: Number(r.PE?.openInterest) || 0,
        ceIv: Number(r.CE?.impliedVolatility) || null,
        peIv: Number(r.PE?.impliedVolatility) || null,
      }));
    if (!clean.length) return null;
    const priced = clean.filter((r) => r.ceLtp > 0 && r.peLtp > 0);
    if (!priced.length) return null;
    let atm = priced[0];
    for (const r of priced) if (Math.abs(r.strike - s) < Math.abs(atm.strike - s)) atm = r;
    const nearest = clean.reduce((a, r) => (Math.abs(r.strike - s) < Math.abs(a.strike - s) ? r : a), clean[0]);
    if (nearest.strike !== atm.strike) notes.push(`strike ${nearest.strike} nearest to spot has an unpriced leg; ATM taken as ${atm.strike}`);
    const straddle = r2(atm.ceLtp + atm.peLtp);
    const topCall = clean.filter((r) => r.ceOi > 0).sort((a, b) => b.ceOi - a.ceOi || a.strike - b.strike).slice(0, 3).map((r) => ({ strike: r.strike, oi: r.ceOi }));
    const topPut = clean.filter((r) => r.peOi > 0).sort((a, b) => b.peOi - a.peOi || a.strike - b.strike).slice(0, 3).map((r) => ({ strike: r.strike, oi: r.peOi }));
    if (!topCall.length) notes.push("no call open interest in the chain");
    if (!topPut.length) notes.push("no put open interest in the chain");
    // Near-money walls (owner 2026-11-19): the largest call OI ABOVE spot and the largest put OI
    // BELOW spot within the expected range (spot ± straddle). The whole-chain walls sit on far
    // round strikes (26000 / 24000 on 18-Nov) that collect hedges and are useless as nearby levels.
    const inRange = (r) => r.strike >= s - straddle && r.strike <= s + straddle;
    const nc = clean.filter((r) => r.strike > s && inRange(r) && r.ceOi > 0).sort((a, b) => b.ceOi - a.ceOi || a.strike - b.strike)[0] || null;
    const np = clean.filter((r) => r.strike < s && inRange(r) && r.peOi > 0).sort((a, b) => b.peOi - a.peOi || b.strike - a.strike)[0] || null;
    const totCallOI = clean.reduce((a, r) => a + r.ceOi, 0);
    const totPutOI = clean.reduce((a, r) => a + r.peOi, 0);
    const d = finite(dte) ? Number(dte) : dteFromExpiry(expiry, nowMs);
    return {
      expiry: expiry || null,
      spot: r2(s),
      atm: atm.strike,
      ceLtp: atm.ceLtp,
      peLtp: atm.peLtp,
      atmIv: atm.ceIv || atm.peIv ? { ce: atm.ceIv, pe: atm.peIv } : null,
      straddle,
      expectedRange: { low: r2(s - straddle), high: r2(s + straddle) },
      topCallOi: topCall,
      topPutOi: topPut,
      callWall: topCall[0]?.strike ?? null,
      putWall: topPut[0]?.strike ?? null,
      nearCallWall: nc ? { strike: nc.strike, oi: nc.ceOi } : null,
      nearPutWall: np ? { strike: np.strike, oi: np.peOi } : null,
      totCallOI,
      totPutOI,
      pcr: totCallOI > 0 ? r2(totPutOI / totCallOI) : null,
      dte: d,
      strikeCount: clean.length,
      partial: notes.length > 0,
      notes,
    };
  } catch (e) {
    return null;
  }
}

const validTicks = (timeline) =>
  (Array.isArray(timeline) ? timeline : [])
    .filter((p) => p && typeof p === "object" && p.synthetic !== true && finite(p.minutes))
    .slice()
    .sort((a, b) => Number(a.minutes) - Number(b.minutes));

/** OHLC + OI from ticks. Pure. */
function ohlcFromTicks(ticks, notes) {
  const spotTicks = ticks.filter((p) => Number(p.spot) > 0);
  let spot = null;
  if (spotTicks.length) {
    const hl = spotTicks.filter((p) => p.spotFrozen !== true);
    const hlSrc = hl.length ? hl : spotTicks;
    spot = {
      open: r2(Number(spotTicks[0].spot)),
      high: r2(Math.max(...hlSrc.map((p) => Number(p.spot)))),
      low: r2(Math.min(...hlSrc.map((p) => Number(p.spot)))),
      close: r2(Number(spotTicks[spotTicks.length - 1].spot)),
    };
  } else {
    notes.push("no spot ticks");
  }
  const futAll = ticks.filter((p) => Number(p.futPrice) > 0);
  let fut = null;
  if (futAll.length) {
    // Same first-live-tick rule as the scorecard and the EOD anchor (src/sessionOpen.js): skip the
    // opening carry-over quotes the feed repeats from the previous session. (Was a fixed 09:17 cut,
    // which on 17-Nov dropped the real 09:16 open and disagreed with the other panels by 26 points.)
    const live = firstLiveIndex({
      m: futAll.map((p) => Number(p.minutes)),
      f: futAll.map((p) => Number(p.futPrice)),
      o: futAll.map((p) => Number(p.futCombinedOI) || null),
      v: futAll.map((p) => Number(p.futVolume) || null),
    });
    const startIdx = live.index > 0 ? live.index : 0;
    const src = futAll.slice(startIdx);
    const startMins = Number(src[0].minutes);
    if (startIdx > 0) notes.push(`futures open/high/low/OI-open from ${hhmmOf(startMins)}: ${startIdx} opening carry-over quote(s) skipped (${live.reason})`);
    else notes.push(`futures open from the first tick (${hhmmOf(startMins)}): ${live.reason}`);
    const oiTicks = ticks.filter((p) => Number(p.futCombinedOI) > 0);
    const oiFrom = oiTicks.filter((p) => Number(p.minutes) >= startMins);
    const oiSrc = oiFrom.length ? oiFrom : oiTicks;
    const oiOpen = oiSrc.length ? Number(oiSrc[0].futCombinedOI) : null;
    const oiClose = oiTicks.length ? Number(oiTicks[oiTicks.length - 1].futCombinedOI) : null;
    // Live ticks only: a carry-over quote carries the PREVIOUS session's cumulative volume.
    const vols = src.map((p) => Number(p.futVolume)).filter((v) => v > 0);
    fut = {
      open: r2(Number(src[0].futPrice)),
      high: r2(Math.max(...src.map((p) => Number(p.futPrice)))),
      low: r2(Math.min(...src.map((p) => Number(p.futPrice)))),
      close: r2(Number(futAll[futAll.length - 1].futPrice)),
      oiOpen,
      oiClose,
      oiChangePct: oiOpen > 0 && oiClose > 0 ? r2(((oiClose - oiOpen) / oiOpen) * 100) : null,
      volume: vols.length ? Math.max(...vols) : null,
    };
  } else {
    notes.push("no futures ticks");
  }
  return { spot, fut };
}

/**
 * The day's swing summary from the timeline and the chain summaries (each a summariseChain result
 * or null). nearIntraday (optional) carries the near-expiry floor/roof/writing at capture time;
 * without it the last tick's values are used.
 */
export function buildDailySummary({ date, timeline = [], futuresMetrics = null, near = null, nextWeekly = null, monthly = null, nearIntraday = null, dataQuality = null, nowMs = Date.now(), notes: extraNotes = [], minLiveTicks = SWING_MIN_LIVE_TICKS } = {}) {
  const notes = [];
  try {
    const ticks = validTicks(timeline);
    const live = ticks.filter((p) => p.isLiveTick !== false);
    const minLive = Number(minLiveTicks) > 0 ? Number(minLiveTicks) : SWING_MIN_LIVE_TICKS;
    const useLive = live.length >= minLive;
    const ohlcTicks = useLive ? live : ticks;
    const nonLiveExcluded = useLive ? ticks.length - live.length : 0;
    if (useLive && nonLiveExcluded > 0) notes.push(`${nonLiveExcluded} non-live (gap-bridging) tick(s) excluded from OHLC/OI`);
    if (!useLive && ticks.length) notes.push(`only ${live.length} live tick(s) (< ${minLive}); OHLC/OI from all ${ticks.length} non-synthetic ticks, including non-live ones`);
    const { spot, fut } = ohlcFromTicks(ohlcTicks, notes);
    if (fut && futuresMetrics && !futuresMetrics.isStale && futuresMetrics.expiryDate) fut.expiry = futuresMetrics.expiryDate;
    if (!fut && futuresMetrics && !futuresMetrics.isStale && Number(futuresMetrics.lastPrice) > 0) {
      notes.push("futures close from the live quote only (no futures ticks)");
    }
    const last = ticks[ticks.length - 1] || {};
    const ni = nearIntraday || {};
    const pick = (a, b) => (finite(a) ? Number(a) : finite(b) ? Number(b) : null);
    const nearIntradayOut = {
      floor: pick(ni.floor, last.floor),
      roof: pick(ni.roof, last.roof),
      pcr: pick(ni.pcr, null),
      deltaPcr: pick(ni.deltaPcr, null),
      totalPutWriting: pick(ni.totalPutWriting, last.putWriting),
      totalCallWriting: pick(ni.totalCallWriting, last.callWriting),
    };
    if (!near) notes.push("near-expiry chain summary unavailable");
    if (!nextWeekly) notes.push("next-weekly chain not captured");
    if (!monthly) notes.push("monthly chain not captured");
    for (const n of Array.isArray(extraNotes) ? extraNotes : []) if (n) notes.push(String(n));
    const coveragePct = finite(dataQuality?.coveragePct) ? Number(dataQuality.coveragePct) : null;
    const partial = !spot || !fut || !near || (coveragePct !== null && coveragePct < SWING_PARTIAL_COVERAGE_PCT);
    return {
      v: SWING_SUMMARY_VERSION,
      date: date || null,
      source: "capture",
      capturedAt: Number.isFinite(Number(nowMs)) ? new Date(Number(nowMs)).toISOString() : null,
      ticks: ticks.length,
      ticksUsed: ohlcTicks.length,
      nonLiveExcluded,
      liveOnly: useLive,
      spot,
      fut,
      chains: { near: near || null, nextWeekly: nextWeekly || null, monthly: monthly || null },
      nearIntraday: nearIntradayOut,
      volProfile: profileFromTicks(ohlcTicks), // volume at price (src/volumeProfile.js)
      coveragePct,
      partial,
      notes,
    };
  } catch (e) {
    return { v: SWING_SUMMARY_VERSION, date: date || null, source: "capture", capturedAt: null, ticks: 0, spot: null, fut: null, chains: { near: null, nextWeekly: null, monthly: null }, nearIntraday: null, coveragePct: null, partial: true, notes: [`summary failed: ${e?.message || e}`] };
  }
}

/**
 * A partial summary (no chains) from a scorecard day document's compact series
 * ({ m, s, f, o, v, p, c }). Computed on read; never written. Returns null when unusable.
 */
export function summaryFromScorecardDoc(doc) {
  try {
    const s = doc?.series;
    if (!doc?.date || !s || !Array.isArray(s.m) || !s.m.length) return null;
    const at = (arr, i) => (Array.isArray(arr) ? arr[i] : null);
    const timeline = s.m.map((m, i) => ({
      minutes: m,
      spot: at(s.s, i),
      futPrice: at(s.f, i),
      futCombinedOI: at(s.o, i),
      futVolume: at(s.v, i),
      putWriting: at(s.p, i),
      callWriting: at(s.c, i),
      ...(isSpotFrozenAt(m) ? { spotFrozen: true } : {}),
    }));
    const notes = [];
    const ticks = validTicks(timeline);
    const { spot, fut } = ohlcFromTicks(ticks, notes);
    if (!spot && !fut) return null;
    const last = ticks[ticks.length - 1] || {};
    notes.push("derived from the scorecard series (no option-chain data); spot high/low skip 15:15–15:30");
    return {
      v: SWING_SUMMARY_VERSION,
      date: doc.date,
      source: "scorecard-series",
      capturedAt: null,
      ticks: ticks.length,
      spot,
      fut,
      chains: { near: null, nextWeekly: null, monthly: null },
      nearIntraday: {
        floor: null, roof: null, pcr: null, deltaPcr: null,
        totalPutWriting: finite(last.putWriting) ? Number(last.putWriting) : null,
        totalCallWriting: finite(last.callWriting) ? Number(last.callWriting) : null,
      },
      volProfile: profileFromSeries(s),
      coveragePct: finite(doc.dataQuality?.coveragePct) ? Number(doc.dataQuality.coveragePct) : null,
      partial: true,
      notes,
    };
  } catch (e) {
    return null;
  }
}

/** Calendar dates (ISO) from `today` back n days, newest first. */
export function lastDates(today, n) {
  const out = [];
  const t0 = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(t0)) return out;
  for (let i = 0; i < n; i++) out.push(new Date(t0 - i * 86400000).toISOString().slice(0, 10));
  return out;
}

/**
 * Reads swing day summaries (and optionally stored outlook snapshots) for the given dates; dates
 * without a swing summary but with a scorecard day document get summaryFromScorecardDoc (computed,
 * not written). Read-only. Returns { days (ascending), outlooks: [{date, outlook}] }.
 */
export async function loadSwingHistory({ mget, dates = [], includeOutlooks = false }) {
  const ds = [...new Set(dates.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d))))].sort();
  if (!ds.length || typeof mget !== "function") return { days: [], outlooks: [] };
  const dayKeys = ds.map(swingKeys.day);
  const outKeys = includeOutlooks ? ds.map(swingKeys.outlook) : [];
  let vals = [];
  try {
    vals = (await mget([...dayKeys, ...outKeys])) || [];
  } catch (e) {
    vals = [];
  }
  const byDate = new Map();
  ds.forEach((d, i) => {
    const v = vals[i];
    if (v && typeof v === "object" && v.date === d) byDate.set(d, v);
  });
  const missing = ds.filter((d) => !byDate.has(d));
  if (missing.length) {
    let docs = [];
    try {
      docs = (await mget(missing.map((d) => scKeys.day(d)))) || [];
    } catch (e) {
      docs = [];
    }
    missing.forEach((d, i) => {
      const doc = docs[i];
      if (doc && doc.date === d && isSessionDayDoc(doc)) {
        const s = summaryFromScorecardDoc(doc);
        if (s) byDate.set(d, s);
      }
    });
  }
  const outlooks = [];
  if (includeOutlooks) {
    ds.forEach((d, i) => {
      const o = vals[dayKeys.length + i];
      if (o && typeof o === "object" && o.regime) outlooks.push({ date: d, outlook: o });
    });
  }
  return { days: ds.filter((d) => byDate.has(d)).map((d) => byDate.get(d)), outlooks };
}

/**
 * "Should the swing summary be captured on this refresh?" Pure.
 * Returns { capture, fetchExtras, reason, remainingMs }.
 */
export function shouldCaptureSwing({ cfg, sessionKind, isLiveMarket, istMinutes, targetExpiry, nearExpiry, isEodTest = false, hasRedis, source = null, nowMs = Date.now(), deadlineMs = null } = {}) {
  const no = (reason) => ({ capture: false, fetchExtras: false, reason, remainingMs: null });
  if (!cfg || !cfg.enabled) return no("disabled");
  if (!hasRedis) return no("no-redis");
  if (isEodTest) return no("eod-test");
  // The TradingView webhook refreshes the snapshot before an order decision: never add work there.
  if (source === "webhook-refresh") return no("webhook-path");
  if (sessionKind !== "WEEKDAY" || !isLiveMarket) return no("not-a-live-weekday-session");
  if (!targetExpiry || targetExpiry !== nearExpiry) return no("non-near-target");
  const m = Number(istMinutes);
  if (!Number.isFinite(m) || m < cfg.captureStartMins || m > cfg.captureEndMins) return no("outside-window");
  if (Number.isFinite(deadlineMs)) {
    const remainingMs = deadlineMs - nowMs;
    if (remainingMs <= 0) return no("deadline-passed");
    return { capture: true, fetchExtras: remainingMs >= cfg.minBudgetMs, reason: remainingMs >= cfg.minBudgetMs ? "ok" : "low-budget-near-chain-only", remainingMs };
  }
  return { capture: true, fetchExtras: true, reason: "ok", remainingMs: null };
}

/**
 * Plans which extra chains to fetch. Pure. Returns
 * { nextWeekly: { expiry, action: "fetch"|"reuse-prefetched"|"skip", note }, monthly: {...} }.
 */
export function planExtraChains({ nearExpiry, nextExpiry, monthlyExpiry, hasPrefetchedNext = false, fetchExtras = true }) {
  const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());
  const plan = {};
  if (!nextExpiry || same(nextExpiry, nearExpiry)) plan.nextWeekly = { expiry: nextExpiry || null, action: "skip", note: "no next-weekly expiry distinct from the near expiry" };
  else if (hasPrefetchedNext) plan.nextWeekly = { expiry: nextExpiry, action: "reuse-prefetched", note: null };
  else if (!fetchExtras) plan.nextWeekly = { expiry: nextExpiry, action: "skip", note: "next-weekly chain skipped: not enough time left in this refresh" };
  else plan.nextWeekly = { expiry: nextExpiry, action: "fetch", note: null };
  if (!monthlyExpiry) plan.monthly = { expiry: null, action: "skip", note: "no monthly expiry known" };
  else if (same(monthlyExpiry, nearExpiry)) plan.monthly = { expiry: monthlyExpiry, action: "same-as-near", note: "monthly expiry is the near expiry" };
  else if (same(monthlyExpiry, nextExpiry)) plan.monthly = { expiry: monthlyExpiry, action: "same-as-next", note: "monthly expiry is the next-weekly expiry" };
  else if (!fetchExtras) plan.monthly = { expiry: monthlyExpiry, action: "skip", note: "monthly chain skipped: not enough time left in this refresh" };
  else plan.monthly = { expiry: monthlyExpiry, action: "fetch", note: null };
  return plan;
}

/**
 * Captures the day's summary and the outlook snapshot. All I/O injected:
 * deps = { claimLock(key, ttlSec) → bool, fetchChain(expiry, timeoutMs) → { rows, spot }, set(key, value, ttlSec),
 *          mget(keys) → values, now() → ms, dteOf(expiry) → number }.
 * ctx = { date, spot, nearExpiry, nextExpiry, monthlyExpiry, nearRows, prefetchedNextRows, timeline,
 *         futuresMetrics, dataQuality, nearIntraday }.
 * Never throws; returns { status, wroteDay, wroteOutlook, notes }.
 */
export async function runSwingCapture({ cfg, ctx, deps, fetchExtras = true, env = process.env }) {
  const notes = [];
  try {
    const claimed = await deps.claimLock(swingKeys.lock, cfg.captureEverySec);
    if (!claimed) return { status: "THROTTLED", wroteDay: false, wroteOutlook: false, notes };
    const now = () => (typeof deps.now === "function" ? deps.now() : Date.now());
    const dteOf = (exp) => {
      try {
        return typeof deps.dteOf === "function" ? deps.dteOf(exp) : dteFromExpiry(exp, now());
      } catch (e) {
        return dteFromExpiry(exp, now());
      }
    };
    const near = summariseChain({ rows: ctx.nearRows, spot: ctx.spot, expiry: ctx.nearExpiry, nowMs: now(), dte: dteOf(ctx.nearExpiry) });
    const plan = planExtraChains({
      nearExpiry: ctx.nearExpiry,
      nextExpiry: ctx.nextExpiry,
      monthlyExpiry: ctx.monthlyExpiry,
      hasPrefetchedNext: Array.isArray(ctx.prefetchedNextRows) && ctx.prefetchedNextRows.length > 0,
      fetchExtras,
    });
    const fetchOne = async (expiry) => {
      const r = await deps.fetchChain(expiry, cfg.fetchTimeoutMs);
      return summariseChain({ rows: r?.rows, spot: Number(r?.spot) > 0 ? r.spot : ctx.spot, expiry, nowMs: now(), dte: dteOf(expiry) });
    };
    const jobs = {};
    if (plan.nextWeekly.action === "fetch") jobs.nextWeekly = fetchOne(plan.nextWeekly.expiry);
    if (plan.monthly.action === "fetch") jobs.monthly = fetchOne(plan.monthly.expiry);
    const names = Object.keys(jobs);
    const settled = await Promise.allSettled(names.map((n) => jobs[n]));
    const got = {};
    names.forEach((n, i) => {
      const s = settled[i];
      if (s.status === "fulfilled" && s.value) got[n] = s.value;
      else notes.push(`${n} chain (${plan[n].expiry}) fetch failed: ${s.status === "rejected" ? s.reason?.message || s.reason : "no usable ATM pair"}`);
    });
    let nextWeekly = got.nextWeekly || null;
    if (plan.nextWeekly.action === "reuse-prefetched") {
      nextWeekly = summariseChain({ rows: ctx.prefetchedNextRows, spot: ctx.spot, expiry: plan.nextWeekly.expiry, nowMs: now(), dte: dteOf(plan.nextWeekly.expiry) });
      notes.push("next-weekly chain reused from the expiry-day rollover fetch");
    }
    let monthly = got.monthly || null;
    if (plan.monthly.action === "same-as-near") monthly = near;
    if (plan.monthly.action === "same-as-next") monthly = nextWeekly;
    for (const k of ["nextWeekly", "monthly"]) if (plan[k].note) notes.push(plan[k].note);

    const summary = buildDailySummary({
      date: ctx.date,
      timeline: ctx.timeline,
      futuresMetrics: ctx.futuresMetrics,
      near,
      nextWeekly,
      monthly,
      nearIntraday: ctx.nearIntraday,
      dataQuality: ctx.dataQuality,
      nowMs: now(),
      notes,
      minLiveTicks: cfg.minLiveTicks,
    });
    const ttl = cfg.retentionDays * 86400;
    const prevDates = lastDates(ctx.date, cfg.lookbackDays).filter((d) => d !== ctx.date);
    const [wroteDay, hist] = await Promise.all([
      Promise.resolve(deps.set(swingKeys.day(ctx.date), summary, ttl)).then((r) => r !== false).catch(() => false),
      loadSwingHistory({ mget: deps.mget, dates: prevDates }).catch(() => ({ days: [] })),
    ]);
    let wroteOutlook = false;
    try {
      const outlook = computeWeeklyOutlook({ days: [...hist.days, summary], config: getOutlookConfig(env) });
      outlook.capturedAt = summary.capturedAt;
      wroteOutlook = (await deps.set(swingKeys.outlook(ctx.date), outlook, ttl)) !== false;
    } catch (e) {
      notes.push(`outlook snapshot failed: ${e?.message || e}`);
    }
    return { status: "CAPTURED", wroteDay, wroteOutlook, partial: summary.partial, notes };
  } catch (e) {
    return { status: "ERROR", wroteDay: false, wroteOutlook: false, notes: [...notes, String(e?.message || e)] };
  }
}
