/**
 * Flow calculation helpers shared by api/nifty-oi.js and src/smartMoneyFusion.js.
 *
 * 1. NSE closing-auction awareness for the NIFTY spot index.
 * 2. Two-leg decomposition of a change in the corridor writing difference (netDiff).
 * 3. Intraday (rolling-window) futures quadrant built from the per-minute timeline.
 *
 * Pure functions only: no I/O, no Date.now(), safe to import from the browser bundle.
 */

// ── 1. Closing auction ────────────────────────────────────────────────────────
// NSE's Closing Auction Session (live since Aug 2026): the NIFTY 50 *spot index* stops
// updating at 15:15 IST and the auction close is published at ~15:30 IST. Index futures
// and options keep trading until 15:40. So between 15:15 and 15:30 the spot value is a
// stale print, and the first value after 15:30 is a jump to the auction close — neither is
// a price path. Minutes are IST minutes since midnight (915 = 15:15, 930 = 15:30).
export const SPOT_FREEZE_START_MINS = 915;
export const SPOT_FREEZE_END_MINS = 930;
export const FNO_CLOSE_MINS = 940; // 15:40 IST: index futures/options stop trading

/** True when the spot index is frozen for the closing auction at this minute. */
export function isSpotFrozenAt(minutes) {
  const m = Number(minutes);
  return Number.isFinite(m) && m >= SPOT_FREEZE_START_MINS && m < SPOT_FREEZE_END_MINS;
}

/**
 * True when a spot move measured from startMins to endMins is contaminated by the
 * closing auction: the window overlaps the frozen interval or straddles the 15:30 jump.
 * A window that merely ends at 15:15 (the last real print) is clean.
 */
export function spotWindowTouchesAuction(startMins, endMins) {
  const s = Number(startMins);
  const e = Number(endMins);
  if (!Number.isFinite(s) || !Number.isFinite(e)) return false;
  return s < SPOT_FREEZE_END_MINS && e > SPOT_FREEZE_START_MINS;
}

export const CLOSING_AUCTION_NOTE = "spot frozen 15:15–15:30 IST for the NSE closing auction";

// ── 2. Writing-delta decomposition ────────────────────────────────────────────
// The corridor "writing" totals (tick.putWriting / tick.callWriting) are SUMS OF POSITIVE
// per-strike change-in-OI over the strikes within ±550 pts of spot (see refreshLiveSnapshot).
// What a FALL in such a total can mean:
//   • OI that had been added today at those strikes is being closed (writers buying back,
//     i.e. "unwinding"), or a strike's day change turned from positive to ≤ 0;
//   • the ±550 strike window re-centred because spot moved, so strikes with large positive
//     change dropped out of the sum (a composition change, not a flow) — notably at the
//     15:30 closing-auction print, when spot jumps without any trading in between.
// What it CANNOT mean: fresh writing on that same side. And neither leg separates who
// closed (writer vs buyer) — an OI fall needs both sides of a contract to close.
// So a fall in put "writing" is reported as "put OI being closed / support withdrawn",
// never as call writing, even though it lowers netDiff (= put − call) exactly the same way.

/** Share of the absolute net move one leg must contribute to "drive" the flow. 60% means the
 * driving leg supplies at least 3/2 of the other leg's contribution when both push the same
 * way (60/40), so a near-even split (e.g. 55/45) is reported as MIXED instead of being
 * attributed to one side. When the legs oppose each other the dominant leg's share exceeds
 * 100% and it always qualifies. */
export const LEG_DOMINANCE_SHARE = 0.6;

function fmtLots(n) {
  if (n == null || !Number.isFinite(Number(n))) return "0";
  const v = Number(n);
  const abs = Math.abs(v);
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${Math.round(abs)}`;
}

function hasLegs(pt) {
  return pt && Number.isFinite(Number(pt.putWriting)) && Number.isFinite(Number(pt.callWriting)) &&
    pt.putWriting !== null && pt.callWriting !== null;
}

/**
 * Decompose the netDiff change between two ticks into its put and call legs.
 * @returns {{ netDelta, putLegDelta, callLegDelta, direction: "BULLISH"|"BEARISH"|"FLAT",
 *   driver: "WRITING"|"UNWINDING"|"MIXED"|"UNKNOWN"|"FLAT", dominantLeg: "PUT"|"CALL"|null,
 *   dominantShare: number|null, legsText: string, wording: string }}
 */
export function decomposeWritingDelta(fromPt, toPt, { flatBelow = 1000 } = {}) {
  const netDelta = Number(toPt?.netDiff ?? 0) - Number(fromPt?.netDiff ?? 0);
  const direction = Math.abs(netDelta) < flatBelow ? "FLAT" : netDelta > 0 ? "BULLISH" : "BEARISH";

  if (!hasLegs(fromPt) || !hasLegs(toPt)) {
    return {
      netDelta,
      putLegDelta: null,
      callLegDelta: null,
      direction,
      driver: direction === "FLAT" ? "FLAT" : "UNKNOWN",
      dominantLeg: null,
      dominantShare: null,
      legsText: "legs unavailable",
      wording: direction === "FLAT"
        ? "net writing flat"
        : `net ${fmtLots(netDelta)} (put/call legs unavailable — driver unknown)`,
    };
  }

  const putLegDelta = Number(toPt.putWriting) - Number(fromPt.putWriting);
  const callLegDelta = Number(toPt.callWriting) - Number(fromPt.callWriting);
  const legsText = `put writing ${fmtLots(putLegDelta)} (${fmtLots(fromPt.putWriting)}→${fmtLots(toPt.putWriting)}), call writing ${fmtLots(callLegDelta)} (${fmtLots(fromPt.callWriting)}→${fmtLots(toPt.callWriting)})`;

  if (direction === "FLAT") {
    return { netDelta, putLegDelta, callLegDelta, direction, driver: "FLAT", dominantLeg: null, dominantShare: null, legsText, wording: `net writing flat (${legsText})` };
  }

  // Signed contribution of each leg to netDiff (= put − call).
  const putContribution = putLegDelta;
  const callContribution = -callLegDelta;
  const absNet = Math.abs(netDelta);
  const sign = Math.sign(netDelta);
  const putShare = (putContribution * sign) / absNet;
  const callShare = (callContribution * sign) / absNet;

  let dominantLeg = null;
  let dominantShare = null;
  if (putShare >= LEG_DOMINANCE_SHARE && putShare >= callShare) {
    dominantLeg = "PUT";
    dominantShare = putShare;
  } else if (callShare >= LEG_DOMINANCE_SHARE) {
    dominantLeg = "CALL";
    dominantShare = callShare;
  }

  let driver = "MIXED";
  let wording;
  if (dominantLeg === "PUT") {
    driver = putLegDelta > 0 ? "WRITING" : "UNWINDING";
    wording = driver === "WRITING"
      ? `put writers adding / support being built (${legsText})`
      : `put writers closing / support withdrawn (${legsText})`;
  } else if (dominantLeg === "CALL") {
    driver = callLegDelta > 0 ? "WRITING" : "UNWINDING";
    wording = driver === "WRITING"
      ? `call writers adding / resistance being built (${legsText})`
      : `call writers closing / resistance withdrawn (${legsText})`;
  } else {
    wording = `mixed flow — neither leg ≥${Math.round(LEG_DOMINANCE_SHARE * 100)}% of the net move (${legsText})`;
  }

  return {
    netDelta,
    putLegDelta,
    callLegDelta,
    direction,
    driver,
    dominantLeg,
    dominantShare: dominantShare === null ? null : Number(dominantShare.toFixed(2)),
    legsText,
    wording,
  };
}

// ── 3. Intraday futures quadrant ──────────────────────────────────────────────
const envOf = (name) => {
  try {
    return typeof process !== "undefined" && process?.env ? process.env[name] : undefined;
  } catch {
    return undefined;
  }
};

export function getIntradayQuadrantWindowMins() {
  const v = Number(envOf("FUSION_INTRADAY_WINDOW_MINS"));
  return Number.isFinite(v) && v >= 5 && v <= 180 ? Math.round(v) : 30;
}

/** "intraday" (default) or "day": which quadrant drives fusion and the webhook. */
export function getFusionQuadrantMode() {
  const v = String(envOf("FUSION_QUADRANT_MODE") || "").trim().toLowerCase();
  return v === "day" ? "day" : "intraday";
}

// Deadbands for the rolling window. The day-level classifier uses 0.08% price / 0.25% OI.
// Price: kept at 0.08% (~20 pts on NIFTY 25,000). Pure √time scaling of the day band to
// 30 of 375 minutes would give ~0.02% (~6 pts), but on this feed one-minute futures LTP
// prints jitter by 10–30 pts (11-Nov: 25401 → 25434 within a minute), so anything under
// ~20 pts is print noise, not a move.
// OI: 0.10% (~210 contracts on a ~212k combined OI). √(30/375) × 0.25% ≈ 0.07%; rounded up
// to 0.10% to stay above the one-minute reporting jitter of combined OI (~0.05%), while a
// real 30-minute build-up/unwind on 11-Nov moved OI by 0.5–1.8%.
export const INTRADAY_PRICE_DEADBAND_PCT = 0.08;
export const INTRADAY_OI_DEADBAND_PCT = 0.10;
// The window needs at least this many futures ticks after its base, and the base may sit at
// most this many minutes before the nominal window start (feed gaps happen at midday).
export const INTRADAY_MIN_TICKS = 3;
export const INTRADAY_MAX_BASE_SLACK_MINS = 15;

const QUADRANT_META = {
  NEUTRAL_CHOP: { label: "NEUTRAL / CONSOLIDATION", bias: "NEUTRAL", color: "#94a3b8" },
  LONG_BUILDUP: { label: "LONG BUILDUP 🟢", bias: "BULLISH", color: "#22c55e", description: "Fresh institutional buyers paying the ask; leveraged long addition." },
  SHORT_BUILDUP: { label: "SHORT BUILDUP 🔴", bias: "BEARISH", color: "#ef4444", description: "Fresh institutional sellers hitting the bid; leveraged short addition." },
  SHORT_COVERING: { label: "SHORT COVERING 🚀", bias: "BULLISH_WEAK", color: "#38bdf8", description: "Price rising on falling OI; trapped shorts covering without fresh long addition." },
  LONG_UNWINDING: { label: "LONG UNWINDING ⚠️", bias: "BEARISH_WEAK", color: "#f59e0b", description: "Price falling on falling OI; existing longs booking profits or capitulating." },
};

/** Same 5-state rule as classifyFuturesQuadrant, parameterised by deadbands. */
export function quadrantFromChanges(priceChangePct, oiChangePct, priceDeadbandPct, oiDeadbandPct) {
  if (Math.abs(priceChangePct) < priceDeadbandPct || Math.abs(oiChangePct) < oiDeadbandPct) return "NEUTRAL_CHOP";
  if (priceChangePct > 0 && oiChangePct > 0) return "LONG_BUILDUP";
  if (priceChangePct < 0 && oiChangePct > 0) return "SHORT_BUILDUP";
  if (priceChangePct > 0 && oiChangePct < 0) return "SHORT_COVERING";
  return "LONG_UNWINDING";
}

function hasFut(pt) {
  return pt && Number(pt.futPrice) > 0 && Number(pt.futCombinedOI) > 0 && Number.isFinite(Number(pt.minutes));
}

function hhmm(m) {
  const h = Math.floor(m / 60);
  const mn = Math.round(m % 60);
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

/**
 * Rolling-window futures quadrant from timeline ticks carrying futPrice + futCombinedOI.
 * `current` (optional) is the not-yet-appended live reading { minutes, futPrice, futCombinedOI };
 * it replaces any tick at the same or a later minute.
 */
export function classifyIntradayFuturesQuadrant(ticks = [], {
  current = null,
  windowMins = getIntradayQuadrantWindowMins(),
  minTicks = INTRADAY_MIN_TICKS,
  maxBaseSlackMins = INTRADAY_MAX_BASE_SLACK_MINS,
  priceDeadbandPct = INTRADAY_PRICE_DEADBAND_PCT,
  oiDeadbandPct = INTRADAY_OI_DEADBAND_PCT,
} = {}) {
  let pts = (Array.isArray(ticks) ? ticks : []).filter(hasFut).filter(p => p.isLiveTick !== false);
  if (hasFut(current)) {
    pts = pts.filter(p => Number(p.minutes) < Number(current.minutes));
    pts.push({ ...current, isLiveTick: true });
  }
  pts.sort((a, b) => a.minutes - b.minutes);

  const unavailable = (reason) => ({
    available: false,
    quadrant: "UNAVAILABLE",
    label: "Intraday quadrant unavailable",
    bias: "NEUTRAL",
    color: "#9ca3af",
    windowMins,
    reason,
    description: `Intraday ${windowMins}m futures quadrant unavailable: ${reason}.`,
  });

  if (pts.length === 0) return unavailable("no futures ticks");
  const end = pts[pts.length - 1];
  const nominalStart = end.minutes - windowMins;
  const base = [...pts].reverse().find(p => p.minutes <= nominalStart);
  if (!base) return unavailable(`timeline does not yet span ${windowMins} minutes`);
  if (nominalStart - base.minutes > maxBaseSlackMins) {
    return unavailable(`no futures tick within ${maxBaseSlackMins}m before ${hhmm(nominalStart)}`);
  }
  const inWindow = pts.filter(p => p.minutes > base.minutes && p.minutes <= end.minutes);
  if (inWindow.length < minTicks) {
    return unavailable(`only ${inWindow.length} futures tick(s) in the window (< ${minTicks})`);
  }

  const priceChange = Number((end.futPrice - base.futPrice).toFixed(2));
  const priceChangePct = Number(((priceChange / base.futPrice) * 100).toFixed(3));
  const oiChange = Number(end.futCombinedOI) - Number(base.futCombinedOI);
  const oiChangePct = Number(((oiChange / Number(base.futCombinedOI)) * 100).toFixed(3));
  const quadrant = quadrantFromChanges(priceChangePct, oiChangePct, priceDeadbandPct, oiDeadbandPct);
  const meta = QUADRANT_META[quadrant];
  const span = `${hhmm(base.minutes)}→${hhmm(end.minutes)}`;
  return {
    available: true,
    quadrant,
    label: meta.label,
    bias: meta.bias,
    color: meta.color,
    windowMins,
    window: span,
    base: { time: base.time || hhmm(base.minutes), minutes: base.minutes, futPrice: base.futPrice, futCombinedOI: base.futCombinedOI },
    end: { time: end.time || hhmm(end.minutes), minutes: end.minutes, futPrice: end.futPrice, futCombinedOI: end.futCombinedOI },
    priceChange,
    priceChangePct,
    oiChange,
    oiChangePct,
    ticksInWindow: inWindow.length,
    deadbands: { pricePct: priceDeadbandPct, oiPct: oiDeadbandPct },
    description: quadrant === "NEUTRAL_CHOP"
      ? `Futures ${span}: ${priceChange >= 0 ? "+" : ""}${priceChange} pts, OI ${oiChangePct >= 0 ? "+" : ""}${oiChangePct}% — inside the ${windowMins}m noise deadband.`
      : `Futures ${span}: ${priceChange >= 0 ? "+" : ""}${priceChange} pts, OI ${oiChange >= 0 ? "+" : ""}${oiChange} (${oiChangePct >= 0 ? "+" : ""}${oiChangePct}%). ${meta.description}`,
  };
}
