# Smart Money Futures + Options Fusion Engine — Builder Specification

## 1. Architecture Overview

This specification defines the production implementation for the **Institutional Fusion Engine** in `OptionsScanner`. The system ingests two concurrent NSE real-time streams, evaluates them inside a deterministic **Smart Money Fusion Matrix**, and outputs an **Actionable EOD & Intraday Verdict**.

```
+-----------------------------------------------------------------------------------+
|                                   DATA SOURCES                                    |
|  [Nifty Futures Stream: Price + Basis + ΔOI]   [Option Chain: ΔOI + Corridor PCR] |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          v
+-----------------------------------------------------------------------------------+
|                           INSTITUTIONAL FUSION ENGINE                             |
|                            [Smart Money Fusion Matrix]                            |
|                                         |                                         |
|    +------------------+-----------------+-----------------+------------------+    |
|    v                  v                                   v                  v    |
| [Bullish Synergy]  [Bearish Synergy]                [🚨 Bull Trap]    [🟢 Bear Trap]|
| Long Buildup +     Short Buildup +                  Price Up on       Price Down  |
| Heavy Put Writing  Heavy Call Writing               Short-Covering +  on Long     |
|                                                     Call Blitz @ Roof Unwinding + |
|                                                                       Put Blitz   |
|                                                                       @ Floor     |
+----+------------------+-----------------------------------+------------------+----+
     |                  |                                   |                  |
     v                  v                                   v                  v
+-----------------------------------------------------------------------------------+
|                              ACTIONABLE EOD VERDICT                               |
| [High-Conviction]  [High-Conviction]                [Veto Longs /     [Veto Shorts|
| [     BTST      ]  [     STBT      ]                Short w/ Tight SL] / Buy Dips]|
+-----------------------------------------------------------------------------------+
```

---

## 2. Required Plan Changes & Edge-Case Fixes (CRITICAL)

Before implementing the Futures + Options Fusion logic in `api/nifty-oi.js` and the frontend UI, the builder **must** incorporate the following 6 production engineering fixes:

### Fix 1: Rollover Distortion Guard (Near + Next Month Aggregation)
* **The Bug:** During expiry week ($\text{DTE} \le 4$ trading days before the monthly futures expiry), institutions roll positions from the **Current Month (Near)** contract to the **Next Month** contract. Current-month OI naturally drops ($\Delta\text{OI} < 0$), which falsely triggers `LONG_UNWINDING` or `SHORT_COVERING` all day.
* **The Fix:** Parse both the Current Month (`futRows[0]`) and Next Month (`futRows[1]`) contracts from `/api/liveEquity-derivatives?index=nse50_fut`.
  * Always compute **Combined Futures OI** and **Combined Futures $\Delta\text{OI}$**:
    $$\text{OI}_{\text{combined}} = \text{OI}_{\text{near}} + \text{OI}_{\text{next}}$$
    $$\Delta\text{OI}_{\text{combined}} = \Delta\text{OI}_{\text{near}} + \Delta\text{OI}_{\text{next}}$$
  * Use the **Near Month** contract for LTP and Basis ($\text{Fut}_{\text{LTP}} - \text{Spot}$) until expiry day 15:00 IST, but classify the 4-Quadrant buildup using $\Delta\text{OI}_{\text{combined}}$.

### Fix 2: Dynamic Cost-of-Carry Fair Basis vs. Static Basis Thresholds
* **The Bug:** Using a static rule like *"Basis > +40 pts = Bullish"* or *"Basis < -10 pts = Bearish"* fails across the monthly expiry cycle. At 25 Days to Expiry ($\text{DTE} = 25$) with an annualized risk-free rate $r \approx 6.8\%$, normal fair-value cost-of-carry on Nifty $25,000$ is already $+116\text{ pts}$. On expiry Thursday ($\text{DTE} = 0$), fair basis is $0\text{ pts}$.
* **The Fix:** Calculate **Theoretical Fair Basis** and **Adjusted Basis Spread** (plus **Intraday Basis Momentum**):
  $$\text{Fair Basis} = \text{Spot} \times \left(\frac{0.068 \times \max(0, \text{DTE})}{365}\right)$$
  $$\text{Basis}_{\text{raw}} = \text{Fut}_{\text{LTP}} - \text{Spot}$$
  $$\text{Basis}_{\text{spread}} = \text{Basis}_{\text{raw}} - \text{Fair Basis}$$
  $$\Delta\text{Basis}_{\text{intraday}} = \text{Basis}_{\text{raw}} - \text{Basis}_{09:20\text{ IST}}$$
  * **Bullish Basis Expansion:** $\text{Basis}_{\text{spread}} > +12\text{ pts}$ OR $\Delta\text{Basis}_{\text{intraday}} > +8\text{ pts}$
  * **Bearish BasisBackwardation / Collapse:** $\text{Basis}_{\text{raw}} < -5\text{ pts}$ OR $\text{Basis}_{\text{spread}} < -15\text{ pts}$ OR $\Delta\text{Basis}_{\text{intraday}} < -8\text{ pts}$

### Fix 3: Lot-Size & Unit Agnostic Normalization
* **The Bug:** NSE's JSON fields (`openInterest`, `changeinOpenInterest`, `pchangeinOpenInterest`) can report either contracts (lots) or raw quantity depending on the endpoint version, and NSE lot sizes change periodically (e.g., 50 vs 75). Hardcoding a lot multiplier or fixed lot threshold (like `+50,000 lots`) will break when NSE adjusts lot sizes or when comparing early-morning vs late-afternoon volume.
* **The Fix:**
  * Use percentage OI change (`futOiChangePct`) directly from NSE's `pchangeinOpenInterest` (or compute $\frac{\Delta\text{OI}_{\text{combined}}}{\text{OI}_{\text{combined}} - \Delta\text{OI}_{\text{combined}}} \times 100$).
  * For Options writing blitz detection at Floor/Roof strikes, evaluate **both** relative dominance ($\text{Put }\Delta\text{OI} / \text{Call }\Delta\text{OI}$ ratio $\ge 1.50$ or $\le 0.67$) and strike concentration ($\ge 25\%$ of total corridor $\Delta\text{OI}$ sitting on the Floor Support or Roof Resistance strike).

### Fix 4: Deadband / Noise Filter on the 4-Quadrant Matrix
* **The Bug:** A minor $+2\text{ pt}$ tick in Futures LTP or a $+0.05\%$ tick in OI will cause the UI badge to whipsaw between `LONG_BUILDUP`, `SHORT_COVERING`, and `SHORT_BUILDUP` every 60 seconds.
* **The Fix:** Introduce a 5th state — `NEUTRAL_CHOP` — using strict deadband thresholds:
  * **Price Deadband:** $|\Delta\text{Price}_{\text{fut}}| < 0.08\%$ of Spot (approx. $\pm 20\text{ pts}$ on Nifty $25,000$)
  * **OI Deadband:** $|\Delta\text{OI}\%_{\text{combined}}| < 0.25\%$
  * If either price change or OI change falls inside the deadband, classify the Futures quadrant as `NEUTRAL_CHOP` so downstream trap/synergy rules do not fire on noise.

### Fix 5: Single-Session Parallel Fetch & Graceful Degradation in `api/nifty-oi.js`
* **The Bug:** Creating a second NSE cookie handshake or awaiting `/api/liveEquity-derivatives?index=nse50_fut` sequentially after `/api/option-chain-indices?symbol=NIFTY` risks hitting Vercel's 10-second Hobby serverless timeout. Furthermore, if the NSE futures endpoint throttles (HTTP 403/429), the entire Option Chain response could fail.
* **The Fix:**
  * Reuse the **same NSE session cookie header** already established in `api/nifty-oi.js`.
  * Fetch Option Chain and Nifty Futures concurrently via `Promise.allSettled([fetchOptionChain(), fetchNiftyFutures()])`.
  * If `fetchNiftyFutures()` fails or times out (set a strict `4500ms` `AbortController` timeout), fall back to the last cached Upstash Redis futures snapshot (`nifty_futures_latest_v1`) and set `futuresData.isStale = true` without failing the `/api/nifty-oi` response.

### Fix 6: Decouple EOD Participant CSV (`fao_participant_oi.csv`) from Intraday Polling
* **The Bug:** NSE publishes `fao_participant_oi.csv` only once per day around 18:30–19:00 IST. Polling it inside the 1-minute intraday loop wastes bandwidth and returns 404s all day.
* **The Fix:** Keep `fao_participant_oi.csv` out of the 1-minute live polling loop. If implemented, store it in a separate Upstash Redis key (`nifty_fii_participant_eod_v1`) with a 12-hour TTL that is only queried lazily after 18:35 IST.

---

## 3. Backend Implementation Specification (`api/nifty-oi.js`)

### 3.1 NSE Futures Endpoint & Parser
* **Endpoint URL:** `https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_fut`
* **Required Headers:** Identical to the Option Chain request (`User-Agent`, `Accept: application/json`, `Referer: https://www.nseindia.com/market-data/live-equity-market`, `Cookie: <nse_session_cookies>`).

```javascript
/**
 * Extracts and normalizes Nifty Futures contracts from NSE liveEquity-derivatives payload.
 * Filters for Instrument: FUTIDX / Symbol: NIFTY and sorts by expiryDate ascending.
 */
export function parseNseFuturesPayload(rawJson, spotPriceFallback = 0, openBasisBaseline = null) {
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
  const spotPrice = Number(near.underlyingValue ?? spotPriceFallback ?? 0);
  const priceChange = Number(near.change ?? near.ptsChange ?? 0);
  const priceChangePct = Number(near.pChange ?? (spotPrice > 0 ? (priceChange / spotPrice) * 100 : 0));

  // Rollover-safe Combined OI (Near + Next Month)
  const nearOI = Number(near.openInterest ?? 0);
  const nearChgOI = Number(near.changeinOpenInterest ?? 0);
  const nextOI = Number(next?.openInterest ?? 0);
  const nextChgOI = Number(next?.changeinOpenInterest ?? 0);

  const combinedOI = nearOI + nextOI;
  const combinedChgOI = nearChgOI + nextChgOI;
  const baseCombinedOI = Math.max(1, combinedOI - combinedChgOI);
  const combinedOiChangePct = Number(((combinedChgOI / baseCombinedOI) * 100).toFixed(2));

  // Days to Expiry (DTE) & Fair-Value Basis Calculation
  const expiryMs = new Date(near.expiryDate).getTime();
  const nowMs = Date.now();
  const dte = Number.isFinite(expiryMs)
    ? Math.max(0, Math.ceil((expiryMs - nowMs) / (1000 * 60 * 60 * 24)))
    : 7;

  const rawBasis = Number((lastPrice - spotPrice).toFixed(2));
  const fairBasis = Number((spotPrice * ((0.068 * dte) / 365)).toFixed(2));
  const adjustedBasisSpread = Number((rawBasis - fairBasis).toFixed(2));
  const intradayBasisDelta =
    openBasisBaseline !== null && Number.isFinite(Number(openBasisBaseline))
      ? Number((rawBasis - Number(openBasisBaseline)).toFixed(2))
      : 0;

  return {
    contract: near.identifier || near.contract || `NIFTY ${near.expiryDate || "NEAR"}`,
    expiryDate: near.expiryDate || null,
    dte,
    lastPrice,
    spotPrice,
    priceChange: Number(priceChange.toFixed(2)),
    priceChangePct: Number(priceChangePct.toFixed(2)),
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
```

---

### 3.2 Deterministic 5-State Futures Quadrant Classifier

```javascript
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
    };
  }

  const { priceChangePct, combinedOiChangePct, priceChange } = futuresMetrics;
  const PRICE_DEADBAND_PCT = 0.08;
  const OI_DEADBAND_PCT = 0.25;

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
```

---

### 3.3 Smart Money Fusion Matrix (4 Scenarios + Neutral Fallback)

This function implements the exact 4-branch decision tree from the architecture diagram, combining `futuresMetrics` with Option Chain corridor metrics (`deltaPcr`, `totalPutWriting`, `totalCallWriting`, `roofCallWritingBlitz`, `floorPutWritingBlitz`):

```javascript
/**
 * Evaluates the Institutional Fusion Engine Matrix.
 * Maps Futures Quadrant + Basis + Options Corridor Writing into the 4 High-Probability Scenarios.
 */
export function evaluateSmartMoneyFusion(futuresMetrics, optionsMetrics) {
  const quadrantInfo = classifyFuturesQuadrant(futuresMetrics);
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
  };
}
```

---

## 4. Integration with EOD Overnight Carry Engine (`eodDecision`)

Update the EOD Overnight Carry decision logic in `api/nifty-oi.js` (and unit tests in `test/eodDecision.test.js`) so the **Actionable EOD Verdict** layer enforces Trap Vetoes:

1. **Veto BTST on Bull Trap (`eodCarryVeto === "VETO_BTST"`)**:
   * If the 4-Pillar Options score suggests `BTST`, but `fusion.scenarioId === "BULL_TRAP"` (or Futures is in `SHORT_BUILDUP` with collapsing basis during the 15:00–15:30 IST window), **downgrade the EOD signal to `CASH / NO CARRY`** and log `"Vetoed by Futures Bull Trap / Short Buildup"` in the audit trail.
2. **Veto STBT on Bear Trap (`eodCarryVeto === "VETO_STBT"`)**:
   * If the 4-Pillar Options score suggests `STBT`, but `fusion.scenarioId === "BEAR_TRAP"` (or Futures is in `LONG_BUILDUP` during 15:00–15:30 IST), **downgrade the EOD signal to `CASH / NO CARRY`** and log `"Vetoed by Futures Bear Trap / Dip Absorption"` in the audit trail.
3. **5th Confluence Pillar in `EodTrackRecordSection.jsx`**:
   * Append `{ name: "Smart Money Futures Fusion", status: fusion.badge, detail: fusion.actionableVerdict }` to `eodDecision.pillars`.

---

## 5. Frontend UI Specification (`OptionChainPanel.jsx` / `NiftyFlowView.jsx`)

Add a dedicated **"⚡ Smart Money Futures & Options Fusion"** strip immediately below the Spot/PCR KPI cards in `OptionChainPanel.jsx` (or `NiftyFlowView.jsx`) displaying 4 compact cells:

1. **Nifty Futures LTP & Basis**:
   * Shows `Fut: 25,008.0` and `Basis: -22.35 pts (Discount)` or `+35.20 pts (Adj Spread: +4.1 pts)`
   * Color-coded green when `rawBasis >= 0` and `adjustedBasisSpread >= -5`, red when in discount (`rawBasis < 0`).
2. **Futures 4-Quadrant Buildup (Near + Next Combined)**:
   * Shows badge (`LONG BUILDUP 🟢`, `SHORT BUILDUP 🔴`, `SHORT COVERING 🚀`, `LONG UNWINDING ⚠️`, or `NEUTRAL / CONSOLIDATION`)
   * Subtext: `Combined ΔOI: +12,450 (+2.14%) | DTE: 19d`
3. **Smart Money Fusion Matrix Scenario**:
   * Shows `fusion.badge` (`🟢 BULLISH SYNERGY`, `🔴 BEARISH SYNERGY`, `🚨 BULL TRAP DETECTED`, `🟢 BEAR TRAP`)
   * Subtext: `fusion.headline`
4. **Actionable EOD / Intraday Verdict**:
   * Shows `fusion.actionableVerdict` (`High-Conviction BTST`, `High-Conviction STBT`, `Veto Longs / Short with Strict SL`, `Veto Shorts / Buy Dips at Support`)
   * Tooltip or sub-line with `fusion.rationale`.

---

## 6. Required Unit Tests (`test/smartMoneyFusion.test.js`)

The builder must add `test/smartMoneyFusion.test.js` and verify `npm test && npm run build` passes with at least these 6 test cases:
1. **Rollover Aggregation Test**: Verifies `parseNseFuturesPayload` sums `openInterest` and `changeinOpenInterest` across Near and Next month contracts so expiry-week rollovers do not falsify $\Delta\text{OI}\%$.
2. **Fair-Value Basis Test**: Verifies `adjustedBasisSpread` accurately subtracts theoretical cost-of-carry ($\text{Spot} \times 0.068 \times \text{DTE} / 365$) from `rawBasis`.
3. **Deadband Noise Filter Test**: Verifies $|\Delta\text{Price}\%| < 0.08\%$ or $|\Delta\text{OI}\%| < 0.25\%$ returns `NEUTRAL_CHOP`.
4. **Bullish & Bearish Synergy Tests**: Verifies `LONG_BUILDUP` + $\Delta\text{PCR} \ge 1.35$ outputs `BULLISH_SYNERGY` (`High-Conviction BTST`) and `SHORT_BUILDUP` + $\Delta\text{PCR} \le 0.70$ outputs `BEARISH_SYNERGY` (`High-Conviction STBT`).
5. **Bull Trap Veto Test**: Verifies `SHORT_COVERING` + Call writing blitz at Roof outputs `BULL_TRAP` with `eodCarryVeto: "VETO_BTST"`.
6. **Bear Trap Veto Test**: Verifies `LONG_UNWINDING` + Put writing blitz at Floor outputs `BEAR_TRAP` with `eodCarryVeto: "VETO_STBT"`.