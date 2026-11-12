/**
 * Smart Money Futures + Options Fusion Engine
 * Implements:
 * 1. Rollover-safe Near + Next Month Futures Aggregation
 * 2. Theoretical Fair Basis & Cost-of-Carry Spread Calculation
 * 3. 5-State Deadband-Filtered Futures Quadrant Classifier
 * 4. Deterministic Smart Money Fusion Matrix (Synergy, Bull Trap, Bear Trap)
 */

export const ANNUALIZED_RISK_FREE_RATE = 0.068; // 6.8% RBI Repo / T-Bill benchmark
export const PRICE_DEADBAND_PCT = 0.08;        // ~20 pts on Nifty 25,000
export const OI_DEADBAND_PCT = 0.25;           // 0.25% OI fluctuation threshold

import { getFusionQuadrantMode } from "./flowCalc.js";

/**
 * Extracts and normalizes Nifty Futures contracts from NSE liveEquity-derivatives payload.
 * Filters for Instrument: FUTIDX / Symbol: NIFTY and sorts by expiryDate ascending.
 * Rollover Guard: Aggregates Near Month (futRows[0]) and Next Month (futRows[1]).
 */
export function parseNseFuturesPayload(
  rawJson,
  spotPriceFallback = 0,
  openBasisBaseline = null,
  openOiBaseline = null,
  openPriceBaseline = null
) {
  const rows = Array.isArray(rawJson?.data) ? rawJson.data : [];
  const niftyFutRows = rows
    .filter((r) => {
      const symbol = String(r.underlying || r.symbol || "").toUpperCase();
      const instrument = String(r.instrumentType || r.instrument || "").toUpperCase();
      return (symbol === "NIFTY" || symbol.includes("NIFTY 50")) && (!instrument || instrument.includes("FUT"));
    })
    .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime());

  if (niftyFutRows.length === 0) {
    return null;
  }

  const near = niftyFutRows[0];
  const next = niftyFutRows[1] || null;

  const lastPrice = Number(near.lastPrice ?? near.ltp ?? 0);
  // A futures row without a traded price is not futures data (12-Nov: a 0 price made the basis
  // −25,000 and poisoned the day's "since open" baseline).
  if (!(lastPrice > 0)) return null;
  const spotPrice = Number(near.underlyingValue ?? spotPriceFallback ?? 0);
  let priceChange = Number(near.change ?? near.ptsChange ?? 0);
  let priceChangePct = Number(near.pChange ?? (spotPrice > 0 ? (priceChange / spotPrice) * 100 : 0));
  // Reference of the day-level price change (shown with quadrantDay): NSE's change vs the
  // previous close, unless the session-open move is larger (override below).
  let priceChangeBase = "PREV_CLOSE";

  // If opening price baseline is available and intraday session moved while NSE change relative to prev close is flat
  if (openPriceBaseline !== null && Number.isFinite(Number(openPriceBaseline)) && Number(openPriceBaseline) > 0) {
    const sessionPts = Number((lastPrice - Number(openPriceBaseline)).toFixed(2));
    const sessionPct = Number(((sessionPts / Number(openPriceBaseline)) * 100).toFixed(2));
    if (Math.abs(sessionPts) > Math.abs(priceChange) || Math.abs(priceChange) < 5) {
      priceChange = sessionPts;
      priceChangePct = sessionPct;
      priceChangeBase = "SESSION_OPEN";
    }
  }

  // Rollover-safe Combined OI (Near + Next Month)
  const nearOI = Number(near.openInterest ?? 0);
  let nearChgOI = Number(near.changeinOpenInterest ?? 0);
  const nextOI = Number(next?.openInterest ?? 0);
  let nextChgOI = Number(next?.changeinOpenInterest ?? 0);

  const combinedOI = nearOI + nextOI;
  let combinedChgOI = nearChgOI + nextChgOI;

  // NSE live derivatives endpoint omits 'changeinOpenInterest'.
  // If combinedChgOI is 0 and we have a session opening baseline, compute true intraday delta:
  if (combinedChgOI === 0 && openOiBaseline !== null && Number.isFinite(Number(openOiBaseline)) && Number(openOiBaseline) > 0) {
    combinedChgOI = combinedOI - Number(openOiBaseline);
    nearChgOI = combinedChgOI; // allocate net intraday flow
  }

  const baseCombinedOI = Math.max(1, (openOiBaseline && Number(openOiBaseline) > 0) ? Number(openOiBaseline) : (combinedOI - combinedChgOI));
  const combinedOiChangePct = Number(((combinedChgOI / baseCombinedOI) * 100).toFixed(2));

  // Days to Expiry (DTE) & Fair-Value Basis Calculation
  const expiryMs = new Date(near.expiryDate).getTime();
  const nowMs = Date.now();
  const dte = Number.isFinite(expiryMs)
    ? Math.max(0, Math.ceil((expiryMs - nowMs) / (1000 * 60 * 60 * 24)))
    : 7;

  const rawBasis = Number((lastPrice - spotPrice).toFixed(2));
  const fairBasis = Number((spotPrice * ((ANNUALIZED_RISK_FREE_RATE * dte) / 365)).toFixed(2));
  const adjustedBasisSpread = Number((rawBasis - fairBasis).toFixed(2));
  // Since-open basis change: null ("unavailable") without a valid session anchor or spot —
  // never a number measured from zero.
  const intradayBasisDelta =
    openBasisBaseline !== null && openBasisBaseline !== undefined && Number.isFinite(Number(openBasisBaseline)) && spotPrice > 0
      ? Number((rawBasis - Number(openBasisBaseline)).toFixed(2))
      : null;

  return {
    contract: near.identifier || near.contract || `NIFTY ${near.expiryDate || "NEAR"}`,
    expiryDate: near.expiryDate || null,
    dte,
    lastPrice,
    spotPrice,
    priceChange: Number(priceChange.toFixed(2)),
    priceChangePct: Number(priceChangePct.toFixed(2)),
    priceChangeBase,
    nearOI,
    nearChgOI,
    nextOI,
    nextChgOI,
    combinedOI,
    combinedChgOI,
    combinedOiChangePct,
    rawBasis,
    fairBasis,
    adjustedBasisSpread,
    intradayBasisDelta,
    volume: Number(near.totalTradedVolume ?? near.volume ?? 0),
  };
}

/**
 * Classifies Futures flow into 5 states using deadband noise filters.
 * Deadbands: |priceChangePct| < 0.08% (~20 pts on Nifty 25k) OR |combinedOiChangePct| < 0.25%
 */
export function classifyFuturesQuadrant(futuresMetrics) {
  if (!futuresMetrics) {
    return {
      quadrant: "UNAVAILABLE",
      label: "Futures Data Unavailable",
      bias: "NEUTRAL",
      color: "#9ca3af",
      description: "Nifty Futures feed unavailable or awaiting market open.",
    };
  }

  const { priceChangePct, combinedOiChangePct, priceChange } = futuresMetrics;

  if (
    Math.abs(priceChangePct) < PRICE_DEADBAND_PCT ||
    Math.abs(combinedOiChangePct) < OI_DEADBAND_PCT
  ) {
    return {
      quadrant: "NEUTRAL_CHOP",
      label: "NEUTRAL / CONSOLIDATION",
      bias: "NEUTRAL",
      color: "#94a3b8",
      description: `Price (${priceChange >= 0 ? "+" : ""}${priceChange} pts) or OI (${combinedOiChangePct}%) inside noise deadband.`,
    };
  }

  if (priceChangePct >= PRICE_DEADBAND_PCT && combinedOiChangePct >= OI_DEADBAND_PCT) {
    return {
      quadrant: "LONG_BUILDUP",
      label: "LONG BUILDUP 🟢",
      bias: "BULLISH",
      color: "#22c55e",
      description: "Fresh institutional buyers paying the ask; leveraged long addition.",
    };
  }

  if (priceChangePct <= -PRICE_DEADBAND_PCT && combinedOiChangePct >= OI_DEADBAND_PCT) {
    return {
      quadrant: "SHORT_BUILDUP",
      label: "SHORT BUILDUP 🔴",
      bias: "BEARISH",
      color: "#ef4444",
      description: "Fresh institutional sellers hitting the bid; leveraged short addition.",
    };
  }

  if (priceChangePct >= PRICE_DEADBAND_PCT && combinedOiChangePct <= -OI_DEADBAND_PCT) {
    return {
      quadrant: "SHORT_COVERING",
      label: "SHORT COVERING 🚀",
      bias: "BULLISH_WEAK",
      color: "#38bdf8",
      description: "Price rising on falling OI; trapped shorts covering without fresh long addition.",
    };
  }

  return {
    quadrant: "LONG_UNWINDING",
    label: "LONG UNWINDING ⚠️",
    bias: "BEARISH_WEAK",
    color: "#f59e0b",
    description: "Price falling on falling OI; existing longs booking profits or capitulating.",
  };
}

/**
 * Evaluates the Institutional Fusion Engine Matrix.
 * Maps Futures Quadrant + Basis + Options Corridor Writing into the 4 High-Probability Scenarios:
 * 1. Bullish Synergy: Long Buildup + Heavy Put Writing + Healthy Basis -> High-Conviction BTST
 * 2. Bearish Synergy: Short Buildup + Heavy Call Writing + Collapsing Basis -> High-Conviction STBT
 * 3. Bull Trap: Price Up on Short-Covering + Call Blitz at Roof -> Veto Longs / Short with Tight SL
 * 4. Bear Trap: Price Down on Long Unwinding + Put Blitz at Floor -> Veto Shorts / Buy Dips at Support
 */
/**
 * Picks the quadrant that drives fusion (and, via futures.quadrant, the webhook):
 * the day-level quadrant (vs previous close / session open) by default; the rolling intraday
 * window only when FUSION_QUADRANT_MODE=intraday is set AND the window is available. In day
 * mode the intraday quadrant is returned as information only (quadrantIntradayInformational).
 */
export function selectFusionQuadrant(futuresMetrics, intradayQuadrant = null, mode = getFusionQuadrantMode()) {
  const day = classifyFuturesQuadrant(futuresMetrics);
  const dayBase = futuresMetrics?.priceChangeBase === "SESSION_OPEN" ? "session open" : "previous close";
  const quadrantDay = {
    ...day,
    window: "DAY",
    base: futuresMetrics ? dayBase : null,
    priceChange: futuresMetrics?.priceChange ?? null,
    priceChangePct: futuresMetrics?.priceChangePct ?? null,
    oiChangePct: futuresMetrics?.combinedOiChangePct ?? null,
  };
  const intradayOk = Boolean(intradayQuadrant?.available) && futuresMetrics && !futuresMetrics.isStale;
  if (mode !== "day" && intradayOk) {
    const sourceLabel = `${intradayQuadrant.windowMins}m intraday ${intradayQuadrant.window}`;
    return {
      quadrantInfo: { ...intradayQuadrant, source: "INTRADAY", sourceLabel },
      quadrantSource: "INTRADAY",
      quadrantSourceLabel: sourceLabel,
      quadrantSourceReason: `FUSION_QUADRANT_MODE=${mode}; ${intradayQuadrant.windowMins}m window available`,
      quadrantDay,
      quadrantIntraday: intradayQuadrant,
    };
  }
  const reason = mode === "day"
    ? "default whole-day quadrant (FUSION_QUADRANT_MODE=intraday opts in to the rolling window)"
    : `intraday window unavailable (${intradayQuadrant?.reason || (futuresMetrics?.isStale ? "futures snapshot stale" : "not computed")})`;
  const sourceLabel = futuresMetrics ? `day vs ${dayBase}` : "day (futures unavailable)";
  return {
    quadrantInfo: { ...quadrantDay, source: "DAY", sourceLabel },
    quadrantSource: "DAY",
    quadrantSourceLabel: sourceLabel,
    quadrantSourceReason: reason,
    quadrantDay,
    quadrantIntraday: intradayQuadrant || null,
    // In day mode the rolling window is shown for information only and drives nothing.
    quadrantIntradayInformational: true,
    quadrantIntradayInfoLabel: intradayQuadrant?.available
      ? `last ${intradayQuadrant.windowMins} min, informational: ${intradayQuadrant.quadrant} (${intradayQuadrant.window})`
      : null,
  };
}

export function evaluateSmartMoneyFusion(futuresMetrics, optionsMetrics, opts = {}) {
  const selection = selectFusionQuadrant(futuresMetrics, opts.intradayQuadrant ?? null, opts.mode ?? getFusionQuadrantMode());
  const scenario = evaluateFusionScenario(futuresMetrics, optionsMetrics, selection.quadrantInfo);
  const tag = ` [quadrant: ${selection.quadrantSourceLabel}]`;
  return {
    ...scenario,
    headline: `${scenario.headline}${tag}`,
    quadrantSource: selection.quadrantSource,
    quadrantSourceLabel: selection.quadrantSourceLabel,
    quadrantSourceReason: selection.quadrantSourceReason,
    quadrantDay: selection.quadrantDay,
    quadrantIntraday: selection.quadrantIntraday,
    quadrantIntradayInformational: Boolean(selection.quadrantIntradayInformational),
    quadrantIntradayInfoLabel: selection.quadrantIntradayInfoLabel || null,
  };
}

function evaluateFusionScenario(futuresMetrics, optionsMetrics, quadrantInfo) {
  const quadrant = quadrantInfo.quadrant;

  const deltaPcr = Number(optionsMetrics?.deltaPcr ?? 1.0);
  const pcr = Number(optionsMetrics?.pcr ?? 1.0);
  const netOiWriting =
    Number(optionsMetrics?.totalPutWriting ?? 0) -
    Number(optionsMetrics?.totalCallWriting ?? 0);

  // Strike-level blitz flags (true if Roof Call ChgOI or Floor Put ChgOI dominates corridor)
  const isPutWritingBlitz =
    deltaPcr >= 1.35 && netOiWriting > 0 && pcr < 1.65; // Excludes extreme overbought >= 1.65
  const isCallWritingBlitz =
    deltaPcr <= 0.70 && netOiWriting < 0 && pcr > 0.55; // Excludes extreme oversold <= 0.55

  const isRoofCallBlitz =
    Boolean(optionsMetrics?.roofCallWritingBlitz) || deltaPcr <= 0.75;
  const isFloorPutBlitz =
    Boolean(optionsMetrics?.floorPutWritingBlitz) || deltaPcr >= 1.30;

  const isBasisBullish =
    (futuresMetrics?.adjustedBasisSpread ?? 0) >= -5 ||
    (futuresMetrics?.intradayBasisDelta ?? 0) >= 5;
  const isBasisBearish =
    (futuresMetrics?.rawBasis ?? 0) < 0 ||
    (futuresMetrics?.adjustedBasisSpread ?? 0) <= -10 ||
    (futuresMetrics?.intradayBasisDelta ?? 0) <= -5;

  // Branch 1: Bullish Synergy -> High-Conviction BTST
  if (quadrant === "LONG_BUILDUP" && isPutWritingBlitz && isBasisBullish) {
    return {
      scenarioId: "BULLISH_SYNERGY",
      badge: "🟢 BULLISH SYNERGY",
      headline: "Long Buildup + Heavy Put Writing",
      actionableVerdict: "High-Conviction BTST",
      eodCarryVeto: null,
      scoreBoost: +1,
      color: "#22c55e",
      rationale:
        "Smart money is buying leveraged Nifty Futures while underwriting heavy Put support below spot.",
      quadrantInfo,
    };
  }

  // Branch 2: Bearish Synergy -> High-Conviction STBT
  if (quadrant === "SHORT_BUILDUP" && isCallWritingBlitz && isBasisBearish) {
    return {
      scenarioId: "BEARISH_SYNERGY",
      badge: "🔴 BEARISH SYNERGY",
      headline: "Short Buildup + Heavy Call Writing",
      actionableVerdict: "High-Conviction STBT",
      eodCarryVeto: null,
      scoreBoost: -1,
      color: "#ef4444",
      rationale:
        "Smart money is shorting Nifty Futures while capping upside with aggressive Call writing walls.",
      quadrantInfo,
    };
  }

  // Branch 3: Classic Bull Trap -> Veto Longs / Short with Strict SL
  if (quadrant === "SHORT_COVERING" && isRoofCallBlitz) {
    return {
      scenarioId: "BULL_TRAP",
      badge: "🚨 BULL TRAP DETECTED",
      headline: "Price Up on Short-Covering + Call Blitz at Roof",
      actionableVerdict: "Veto Longs / Short with Strict SL",
      eodCarryVeto: "VETO_BTST", // Blocks EOD BTST Call carry
      scoreBoost: -1,
      color: "#f59e0b",
      rationale:
        "Rally is driven only by short-covering (falling Futures OI) while institutions write massive Calls at the Roof resistance strike.",
      quadrantInfo,
    };
  }

  // Branch 4: Classic Bear Trap -> Veto Shorts / Buy Dips at Support
  if (quadrant === "LONG_UNWINDING" && isFloorPutBlitz) {
    return {
      scenarioId: "BEAR_TRAP",
      badge: "🟢 BEAR TRAP (DIP ABSORPTION)",
      headline: "Price Down on Long Unwinding + Put Blitz at Floor",
      actionableVerdict: "Veto Shorts / Buy Dips at Support",
      eodCarryVeto: "VETO_STBT", // Blocks EOD STBT Put carry
      scoreBoost: +1,
      color: "#10b981",
      rationale:
        "Drop is driven by long unwinding (no fresh aggressive shorts) while institutions absorb the dip with heavy Put writing at the Floor strike.",
      quadrantInfo,
    };
  }

  // Default / Mixed Divergence State
  return {
    scenarioId: "MIXED_FLOW",
    badge: "⚪ MIXED / DIVERGENT FLOW",
    headline: `${quadrantInfo.label} vs ΔPCR ${deltaPcr.toFixed(2)}`,
    actionableVerdict: "Wait for Alignment / Trade Light",
    eodCarryVeto: null,
    scoreBoost: 0,
    color: "#94a3b8",
    rationale:
      "Futures buildup and Options writing corridor are not in full 4-quadrant synergy or trap alignment.",
    quadrantInfo,
  };
}
