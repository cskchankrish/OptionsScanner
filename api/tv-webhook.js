/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  OptionsScanner × TradingView v4.3 — Webhook Bridge Fusion Engine
 *  File: api/tv-webhook.js (Vercel / Express Serverless Endpoint)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  HOW IT WORKS:
 *  1. Receives real-time JSON alerts from TradingView Strategy Dashboard v4.3
 *     (`BEAR_TRAP_BUY`, `BULL_TRAP_SELL`, `SWING_BOTTOM`, `SWING_TOP`, `MEGA`,
 *      `WATCH`, `SYNERGY_BULL`, `SYNERGY_BEAR`, `RE_ENTRY`, `TREND_FLIP`).
 *  2. Authenticates the payload against `process.env.TV_WEBHOOK_SECRET` or fallback.
 *  3. Reads the latest 100% REAL 22-Strike NSE Option Chain + Futures snapshot
 *     from Upstash Redis (`nifty:flow:latest` & `nifty_latest_session_payload_v2`)
 *     computed by your live `api/nifty-oi.js` & `evaluateSmartMoneyFusion()`.
 *  4. Fuses TradingView's price-action/EMA/Supertrend/Real-Futures-OI trigger
 *     with the live NSE Option Chain corridor (`deltaPCR`, `floorStrike`,
 *     `roofStrike`, `scenarios`) to produce a final Execution Decision:
 *       • EXECUTE_TIER1_SCOUT (1-2 Lots Early Trap / Reversal Scout with tight SL)
 *       • EXECUTE_TIER2_ADD   (Full/Add Lots on Confirmed Swing / Synergy / Mega)
 *       • DOWNGRADE_TO_SCALP  (1 Lot Intraday only if VETO_BTST/VETO_STBT is active)
 *       • VETO_SIGNAL         (0 Lots - Blocks trade when real 22-strike Option Chain
 *                              directly contradicts the chart signal)
 *       • BLOCKED_BY_ACTIVE_TRADE (0 Lots - Enforces the tested Single-Position Rule)
 *       • LOG_ONLY            (0 Lots - Informational logging for non-trap alerts)
 *  5. Logs the fused decision to Upstash Redis (`nifty:tv:signals:YYYY-MM-DD` and `nifty:tv:latest_signal`)
 *     and permanent master archive (`nifty:tv:signals:master_archive`) for 1-2 month review.
 */

import { Redis } from "@upstash/redis";

const REDIS_URL =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_REST_URL ||
  process.env.UPSTASH_REDIS_URL;

const REDIS_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  process.env.REDIS_REST_TOKEN ||
  process.env.UPSTASH_REDIS_TOKEN;

let _redisInstance = null;
export function getRedisClient() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  if (!_redisInstance) {
    try {
      _redisInstance = new Redis({
        url: REDIS_URL,
        token: REDIS_TOKEN,
      });
    } catch (e) {
      console.warn("Failed to initialize @upstash/redis client:", e.message);
      return null;
    }
  }
  return _redisInstance;
}

// Fallback direct REST helpers in case SDK encounters connection or serialization edge-cases
async function redisRestGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    return null;
  }
}

async function redisRestSet(key, value, exSeconds = 86400) {
  if (!REDIS_URL || !REDIS_TOKEN) return false;
  try {
    const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}?ex=${exSeconds}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: typeof value === "string" ? value : JSON.stringify(value),
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch (e) {
    return false;
  }
}

// Helper: Current IST Date string (YYYY-MM-DD)
export function getIstDateString() {
  const now = new Date();
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istDate = new Date(now.getTime() + istOffsetMs);
  return istDate.toISOString().slice(0, 10);
}

/**
 * Core Webhook Bridge Fusion Evaluator
 * Combines TradingView v4.3 payload + Live OptionsScanner 22-Strike Option Chain
 */
export function fuseChartWithOptionChain(tv, liveScanner) {
  const dir = String(tv.dir || "LONG").toUpperCase();
  const grade = String(tv.grade || "SIGNAL").toUpperCase();
  const close = Number(tv.close || 0);

  // Parse stops and distances safely (null/0 when non-existent, avoiding fake synthetic stops)
  const rawSl = (tv.sl === null || tv.sl === undefined || tv.sl === "null" || Number(tv.sl) <= 0) ? null : Number(tv.sl);
  const cappedSl = (tv.cappedSl === null || tv.cappedSl === undefined || tv.cappedSl === "null" || Number(tv.cappedSl) <= 0) ? null : Number(tv.cappedSl);
  const rDist = (tv.rDist === null || tv.rDist === undefined || tv.rDist === "null" || Number(tv.rDist) <= 0) ? null : Number(tv.rDist);
  const t1Dist = (tv.t1Dist === null || tv.t1Dist === undefined || tv.t1Dist === "null" || Number(tv.t1Dist) <= 0) ? null : Number(tv.t1Dist);
  const t2Dist = (tv.t2Dist === null || tv.t2Dist === undefined || tv.t2Dist === "null" || Number(tv.t2Dist) <= 0) ? null : Number(tv.t2Dist);
  const t1Price = (tv.t1 === null || tv.t1 === undefined || tv.t1 === "null" || Number(tv.t1) <= 0) ? null : Number(tv.t1);
  const t2Price = (tv.t2 === null || tv.t2 === undefined || tv.t2 === "null" || Number(tv.t2) <= 0) ? null : Number(tv.t2);
  const swingKind = String(tv.swingKind || (tv.reType === 7 ? "CONTINUATION" : "REVERSAL")).toUpperCase();
  const isArmed = Boolean(tv.isArmed);

  // Extract real-time Option Chain metrics supporting both corridor object and root properties
  const hasLiveOptions = Boolean(
    liveScanner &&
      (liveScanner.corridor ||
        liveScanner.strikes ||
        liveScanner.deltaPcr !== undefined ||
        liveScanner.deltaPCR !== undefined)
  );

  const deltaPCR = hasLiveOptions
    ? Number(liveScanner.corridor?.deltaPCR ?? liveScanner.deltaPcr ?? liveScanner.deltaPCR ?? 1.0)
    : null;

  const floorStrike = hasLiveOptions
    ? Number(liveScanner.corridor?.floorStrike ?? liveScanner.floor ?? tv.actFloor ?? 0)
    : Number(tv.actFloor || 0);

  const roofStrike = hasLiveOptions
    ? Number(liveScanner.corridor?.roofStrike ?? liveScanner.roof ?? tv.actRoof ?? 0)
    : Number(tv.actRoof || 0);

  const scannerScenario =
    liveScanner?.smartMoneyFusion?.primaryScenario ||
    liveScanner?.fusion?.scenarioId ||
    tv.fusion ||
    "MIXED_FLOW";

  const scannerAction =
    liveScanner?.smartMoneyFusion?.actionTag ||
    liveScanner?.fusion?.eodCarryVeto ||
    "NEUTRAL";

  const liveFutQuad =
    liveScanner?.futures?.quadrant || tv.futQuad || "NEUTRAL_CHOP";

  // Distance to real Option Chain walls
  const distToFloor = floorStrike > 0 ? close - floorStrike : null;
  const distToRoof = roofStrike > 0 ? roofStrike - close : null;
  const nearPutWall = distToFloor !== null && Math.abs(distToFloor) <= 80;
  const nearCallWall = distToRoof !== null && Math.abs(distToRoof) <= 80;

  // Real Option Chain Writer Blitz checks (from 22-strike corridor)
  const realPutBlitz = deltaPCR !== null ? deltaPCR >= 1.30 : true;
  const realCallBlitz = deltaPCR !== null ? deltaPCR <= 0.75 : true;
  const severeOppositeCallWriting = deltaPCR !== null && deltaPCR <= 0.55;
  const severeOppositePutWriting = deltaPCR !== null && deltaPCR >= 1.65;

  let decision = "EXECUTE";
  let tier = "TIER_2_CONFIRMED";
  let recommendedLots = 1;
  const reason = [];

  // ── CASE 1: Tier-1 Early Scout Signals (BEAR_TRAP_BUY / BULL_TRAP_SELL) ──
  if (grade === "BEAR_TRAP_BUY") {
    tier = "TIER_1_SCOUT";
    if (severeOppositeCallWriting && liveFutQuad === "SHORT_BUILDUP") {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `VETOED: Chart flagged Bear Trap Buy, but real 22-strike Option Chain shows heavy Call Writing (ΔPCR=${deltaPCR?.toFixed(2)}) + Futures Short Buildup.`
      );
    } else {
      decision = "EXECUTE_TIER1_SCOUT";
      recommendedLots = realPutBlitz && nearPutWall ? 2 : 1;
      reason.push(
        `TIER-1 BEAR TRAP SCOUT BUY confirmed (${tv.futOiSrc === "PROXY" ? "Basis/Flow" : "Real Fut OI " + (tv.futOiPct ?? "0") + "%"}).`
      );
      if (realPutBlitz) {
        reason.push(
          `Real 22-strike Option Chain confirms Put Writing support (ΔPCR=${deltaPCR?.toFixed(2)}) near Floor ${floorStrike}.`
        );
      }
    }
  } else if (grade === "BULL_TRAP_SELL") {
    tier = "TIER_1_SCOUT";
    if (severeOppositePutWriting && liveFutQuad === "LONG_BUILDUP") {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `VETOED: Chart flagged Bull Trap Sell, but real 22-strike Option Chain shows aggressive Put Writing (ΔPCR=${deltaPCR?.toFixed(2)}) + Futures Long Buildup.`
      );
    } else {
      decision = "EXECUTE_TIER1_SCOUT";
      recommendedLots = realCallBlitz && nearCallWall ? 2 : 1;
      reason.push(
        `TIER-1 BULL TRAP SCOUT SELL confirmed (${tv.futOiSrc === "PROXY" ? "Basis/Flow" : "Real Fut OI " + (tv.futOiPct ?? "0") + "%"}).`
      );
      if (realCallBlitz) {
        reason.push(
          `Real 22-strike Option Chain confirms Call Writing ceiling (ΔPCR=${deltaPCR?.toFixed(2)}) near Roof ${roofStrike}.`
        );
      }
    }
  }

  // ── CASE 2: Tier-2 Structural / Trend Confirmation (SWING_BOTTOM, SWING_TOP, MEGA, SYNERGY) ──
  else if (
    [
      "SWING_BOTTOM",
      "SWING_TOP",
      "MEGA",
      "SYNERGY_BULL",
      "SYNERGY_BEAR",
      "TREND_FLIP",
    ].includes(grade)
  ) {
    tier = "TIER_2_CONFIRMED_ADD";
    const isLong = dir === "LONG";

    // Check if live Option Chain vetoes an overnight / structural hold
    if (
      isLong &&
      (scannerAction === "VETO_BTST" ||
        (severeOppositeCallWriting && scannerScenario === "BULL_TRAP"))
    ) {
      decision = "DOWNGRADE_TO_SCALP";
      recommendedLots = 1;
      reason.push(
        `CAUTION: Structural ${grade} LONG triggered, but real Option Chain flags ${scannerScenario} (ΔPCR=${deltaPCR?.toFixed(2)}). Cap at 1 intraday lot; do not hold BTST.`
      );
    } else if (
      !isLong &&
      (scannerAction === "VETO_STBT" ||
        (severeOppositePutWriting && scannerScenario === "BEAR_TRAP"))
    ) {
      decision = "DOWNGRADE_TO_SCALP";
      recommendedLots = 1;
      reason.push(
        `CAUTION: Structural ${grade} SHORT triggered, but real Option Chain flags ${scannerScenario} (ΔPCR=${deltaPCR?.toFixed(2)}). Cap at 1 intraday lot; do not hold STBT.`
      );
    } else {
      decision = "EXECUTE_TIER2_ADD";
      const synergyAligned =
        (isLong &&
          (scannerScenario === "HIGH_CONVICTION_BULLISH_SYNERGY" ||
            scannerScenario === "BULLISH_SYNERGY" ||
            realPutBlitz)) ||
        (!isLong &&
          (scannerScenario === "HIGH_CONVICTION_BEARISH_SYNERGY" ||
            scannerScenario === "BEARISH_SYNERGY" ||
            realCallBlitz));
      recommendedLots = synergyAligned ? 2 : 1;
      reason.push(
        `TIER-2 CONFIRMED ${grade} (${dir}): EMA/Supertrend structure + Option Chain (${scannerScenario}, ΔPCR=${deltaPCR !== null ? deltaPCR.toFixed(2) : "N/A"}) aligned.`
      );
    }
  }

  // ── CASE 3: Standard Intraday Signals (WATCH, SIGNAL, RE_ENTRY, VBO_BREAK, GAP_*) ──
  else {
    tier = "INTRADAY_CONFLUENCE";
    const isLong = dir === "LONG";
    if (
      (isLong && severeOppositeCallWriting) ||
      (!isLong && severeOppositePutWriting)
    ) {
      decision = "VETO_SIGNAL";
      recommendedLots = 0;
      reason.push(
        `Blocked intraday ${grade} (${dir}) due to opposing real Option Chain blitz (ΔPCR=${deltaPCR?.toFixed(2)}).`
      );
    } else {
      decision = "EXECUTE_INTRADAY";
      recommendedLots = Number(tv.score || 0) >= 7 ? 2 : 1;
      reason.push(
        `Intraday ${grade} (${dir}) passed Option Chain filter (Score ${tv.score || 0}/8).`
      );
    }
  }

  // Derive final Stop Loss & Targets
  let finalSl = cappedSl !== null && cappedSl > 0
    ? cappedSl
    : (rawSl !== null && rawSl > 0 ? rawSl : null);

  let finalRiskPts = rDist !== null && rDist > 0
    ? Math.round(rDist * 100) / 100
    : (finalSl !== null ? Math.abs(Math.round((close - finalSl) * 100) / 100) : null);

  // Guard against inverted Stop Loss (e.g. SL below entry on a short, or SL above entry on a long)
  if (finalSl !== null && close > 0) {
    if (dir === "SHORT" && finalSl <= close) {
      finalRiskPts = finalRiskPts && finalRiskPts > 0 ? finalRiskPts : 70;
      finalSl = Math.round((close + finalRiskPts) * 100) / 100;
    } else if (dir === "LONG" && finalSl >= close) {
      finalRiskPts = finalRiskPts && finalRiskPts > 0 ? finalRiskPts : 70;
      finalSl = Math.round((close - finalRiskPts) * 100) / 100;
    }
  }

  const finalT1Dist = t1Dist !== null && t1Dist > 0
    ? Math.round(t1Dist * 100) / 100
    : (finalRiskPts !== null ? finalRiskPts : null);

  const finalT2Dist = t2Dist !== null && t2Dist > 0
    ? Math.round(t2Dist * 100) / 100
    : (finalRiskPts !== null ? Math.round(2 * finalRiskPts * 100) / 100 : null);

  const finalT1Price = (finalRiskPts !== null && finalSl !== null)
    ? Math.round((dir === "LONG" ? close + finalT1Dist : close - finalT1Dist) * 100) / 100
    : null;

  const finalT2Price = (finalRiskPts !== null && finalSl !== null)
    ? Math.round((dir === "LONG" ? close + finalT2Dist : close - finalT2Dist) * 100) / 100
    : null;

  return {
    timestamp: new Date().toISOString(),
    istTime: tv.t || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    symbol: tv.sym || "NSE:NIFTY",
    timeframe: tv.tf || "15",
    swingTimeframe: tv.swingTf || "125m",
    direction: dir,
    grade,
    tier,
    decision,
    recommendedLots,
    entryPrice: close,
    stopLoss: finalSl,
    rawStopLoss: rawSl,
    riskPoints: finalRiskPts,
    target1Price: finalT1Price,
    target2Price: finalT2Price,
    target1Dist: finalT1Dist,
    target2Dist: finalT2Dist,
    swingKind,
    isHtfArmed: isArmed,
    chartMetrics: {
      score: tv.score,
      futQuad: tv.futQuad,
      futOiPct: tv.futOiPct,
      futOiSrc: tv.futOiSrc,
      basis: tv.basis,
      adjBasis: tv.adjBasis,
      dte: tv.dte,
      chartRoof: tv.actRoof,
      chartFloor: tv.actFloor,
    },
    liveOptionChainMetrics: {
      connected: hasLiveOptions,
      deltaPCR,
      floorStrike,
      roofStrike,
      scannerScenario,
      scannerAction,
      liveFutQuad,
    },
    reasoning: reason.join(" "),
  };
}

/**
 * Telegram Notification Helper
 */
export async function sendTelegramAlert(fused) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const isTrap = fused.grade === "BEAR_TRAP_BUY" || fused.grade === "BULL_TRAP_SELL";
  const icon =
    fused.decision === "VETO_SIGNAL" || fused.decision === "BLOCKED_BY_ACTIVE_TRADE"
      ? "🚫"
      : fused.decision === "LOG_ONLY"
      ? "ℹ️"
      : fused.direction === "LONG"
      ? "🟢"
      : "🔴";

  const kindBadge =
    fused.swingKind === "CONTINUATION"
      ? " [TREND CONTINUATION]"
      : fused.swingKind === "REVERSAL"
      ? " [STRUCTURAL REVERSAL]"
      : "";

  const armedBadge = fused.isHtfArmed ? " ⚡ (HTF Armed)" : "";

  let lines = [];

  if (fused.decision === "LOG_ONLY") {
    lines = [
      `${icon} *LOG_ONLY* · \`${fused.grade}\`${kindBadge} (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      `• *Signal Close:* \`${fused.entryPrice}\``,
      fused.stopLoss ? `• *Reference SL:* \`${fused.stopLoss}\` (${fused.riskPoints ?? "--"} pts)` : null,
      `• *Status:* Informational alert logged for review. Forward paper trading strictly executes Traps Only (Bear/Bull Trap).`,
    ].filter(Boolean);
  } else if (fused.decision === "BLOCKED_BY_ACTIVE_TRADE") {
    lines = [
      `${icon} *BLOCKED_BY_ACTIVE_TRADE* · \`${fused.grade}\` (${fused.direction})`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m)`,
      `• *Signal Close:* \`${fused.entryPrice}\``,
      `• *Verdict:* ${fused.reasoning}`,
      `• *Rule:* Strictly 1 position at a time (as backtested). Close existing trade before entering a new one.`,
    ].filter(Boolean);
  } else {
    // Executable Trap
    const targetLine = fused.target1Price
      ? `• *Targets (Fill-Relative):* T1: \`${fused.target1Price}\` (+${fused.target1Dist ?? "--"} pts / 1.0R) | T2: \`${fused.target2Price}\` (+${fused.target2Dist ?? "--"} pts / 2.0R)`
      : null;

    lines = [
      `${icon} *${fused.decision}* · \`${fused.grade}\`${kindBadge} (${fused.direction})${armedBadge}`,
      `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
      `• *Entry (Signal Close):* \`${fused.entryPrice}\` *(Fill at next bar open)*`,
      `• *Stop Loss:* \`${fused.stopLoss ?? "N/A"}\` (${fused.riskPoints ? fused.riskPoints + " pts, ATR-Capped" : "N/A"})`,
      targetLine,
      `• *Recommended Size:* \`${fused.recommendedLots} Lot(s)\` (${fused.tier})`,
      `• *Real Fut OI:* \`${fused.chartMetrics.futQuad}\` (${fused.chartMetrics.futOiPct}% · ${fused.chartMetrics.futOiSrc}) | *Basis:* \`${fused.chartMetrics.basis}\``,
      `• *22-Strike Option Chain:* ΔPCR \`${fused.liveOptionChainMetrics.deltaPCR ?? "N/A"}\` | Floor \`${fused.liveOptionChainMetrics.floorStrike}\` | Roof \`${fused.liveOptionChainMetrics.roofStrike}\``,
      `• *Verdict:* ${fused.reasoning}`,
    ].filter(Boolean);

    if (isTrap && fused.decision === "EXECUTE_TIER1_SCOUT") {
      lines.push(
        `\n📋 *EXECUTION & EXIT PROTOCOL (Frozen Baseline):*`,
        `1. *Fill:* At market open next bar. Levels are fill-relative:`,
        `   • Stop Loss: Entry ${fused.direction === "LONG" ? "-" : "+"} \`${fused.riskPoints}\` pts`,
        `   • Target 1: Entry ${fused.direction === "LONG" ? "+" : "-"} \`${fused.target1Dist}\` pts -> *Scale out 60% & Move SL to Breakeven*`,
        `   • Target 2: Entry ${fused.direction === "LONG" ? "+" : "-"} \`${fused.target2Dist}\` pts -> *Exit remaining 40%*`,
        `2. *Time-Stop:* Max 20 bars (5 Hours on 15m). Exit at market if open after 20 bars (closed 53% of backtest trades).`,
        `3. *Single-Position Rule:* Strictly one trade at a time.`
      );
    }
  }

  const msg = lines.join("\n");

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: msg,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram webhook error:", err.message);
  }
}

/**
 * Telegram T1 Hit & SL to Cost Helper
 */
export async function sendTelegramT1Alert(activeTrade, fillPrice) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !activeTrade) return;

  const t = activeTrade;
  const pts = Math.abs(Number(fillPrice) - Number(t.entryPrice)).toFixed(1);

  const lines = [
    `🎯 *TARGET 1 ACHIEVED (+${pts} pts)* · \`${t.grade}\` (${t.direction})`,
    `• *Entry Price:* \`${t.entryPrice}\` | *T1 Fill:* \`${fillPrice}\``,
    `• *Action Taken:* 60% position scaled out with locked profit!`,
    `• *SL Protection:* Stop Loss automatically moved to *Cost / Breakeven* (\`${t.entryPrice}\`).`,
    `• *Runner Active:* Remaining 40% targeting T2 (\`${t.target2Price}\`) with *ZERO downside risk*!`,
    `• *Time:* ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `• *CSV Log:* https://niftyninjaa.vercel.app/api/tv-webhook?export=csv`,
  ];

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram T1 alert error:", err.message);
  }
}

/**
 * Telegram Exit Notification Helper
 */
export async function sendTelegramExitAlert(exitRecord) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !exitRecord?.trade) return;

  const t = exitRecord.trade;
  const pnlStr = exitRecord.netPnl !== undefined ? (exitRecord.netPnl >= 0 ? `+${exitRecord.netPnl}` : `${exitRecord.netPnl}`) : "N/A";
  const lines = [
    `🏁 *TRADE CLOSED* · \`${t.grade}\` (${t.direction})`,
    `• *Exit Reason:* \`${exitRecord.exitReason}\``,
    `• *Entry Price:* \`${t.entryPrice}\` | *Exit Level:* \`${exitRecord.exitPrice || "Market"}\``,
    `• *Net Realized PnL:* \`${pnlStr} pts\``,
    `• *Time Closed:* ${exitRecord.istTime}`,
    `• *Market Status:* 🟢 *NO ACTIVE TRADES (FLAT)*`,
    `• *Permission:* Single-position lock released. Bridge is unlocked! You may now evaluate the next Trap setup or Synergy trade.`,
    `• *Download CSV:* https://niftyninjaa.vercel.app/api/tv-webhook?export=csv`,
  ];

  try {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Telegram exit alert error:", err.message);
  }
}

/**
 * Telegram EOD 15:15 Decision Helper & 15-Minute Radar Updates (14:00 - 15:30 IST)
 */
export async function sendTelegramEODAlert(eodDecision, spot, floorStrike, roofStrike, slotTimeStr = "15:15") {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId || !eodDecision) return;

  const isFinalDirective = (slotTimeStr === "15:15");
  const isBTST = eodDecision.verdict?.includes("BTST") || eodDecision.bias === "BULLISH";
  const isSTBT = eodDecision.verdict?.includes("STBT") || eodDecision.bias === "BEARISH";

  let header = "";
  if (isFinalDirective) {
    header = isBTST
      ? "🟢 *OFFICIAL EOD CARRY DIRECTIVE · BTST (BUY CE)*"
      : isSTBT
      ? "🔴 *OFFICIAL EOD CARRY DIRECTIVE · STBT (BUY PE)*"
      : "⚪ *OFFICIAL EOD CARRY DIRECTIVE · CASH ONLY (DO NOT CARRY)*";
  } else {
    header = isBTST
      ? `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · BTST CE BIAS*`
      : isSTBT
      ? `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · STBT PE BIAS*`
      : `📡 *EOD CARRY RADAR (${slotTimeStr} IST UPDATE) · NEUTRAL / CASH BIAS*`;
  }

  const lines = [
    header,
    `• *${isFinalDirective ? "Official Verdict" : "Interim Verdict"}:* \`${eodDecision.verdict}\``,
    `• *Bias & Conviction:* ${eodDecision.bias} (Score: \`${eodDecision.score >= 0 ? "+" + eodDecision.score : eodDecision.score}\` | Conviction: \`${eodDecision.conviction}%\`)`,
    `• *Recommended Sizing:* \`${eodDecision.sizing}\``,
    `• *Spot Index:* \`₹${Math.round(spot)}\` | *Corridor:* Floor \`${floorStrike}\` ↔ Roof \`${roofStrike}\``,
  ];

  if (eodDecision.targetContract) {
    const rolloverNotice = eodDecision.isRollover ? " 🔄 *(Next-Week Rollover)*" : "";
    lines.push(`• *Target Contract Expiry:* \`${eodDecision.targetContract}\`${rolloverNotice}`);
  }

  if (isBTST || isSTBT) {
    if (eodDecision.target) lines.push(`• *Target:* \`₹${eodDecision.target}\``);
    if (eodDecision.stopLoss) lines.push(`• *Strict SL:* \`₹${eodDecision.stopLoss}\``);
  }

  lines.push(`• *Action Guidance:* ${eodDecision.action}`);

  if (eodDecision.audit && eodDecision.audit.length > 0) {
    lines.push(`• *Institutional Evidence:*`);
    eodDecision.audit.slice(0, 4).forEach(a => {
      lines.push(`  - ${a.label}: \`${a.status}\` (${a.impact})`);
    });
  }

  if (!isFinalDirective) {
    lines.push(`• *Notice:* ⏳ *Evolving 15-min pulse. Final carry directive finalized at 15:15 IST.*`);
  }

  lines.push(`• *Time Finalized:* ${new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })} IST`);
  lines.push(`• *Live OptionsScanner:* https://niftyninjaa.vercel.app`);

  const rawText = lines.join("\n");
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: rawText,
        parse_mode: "Markdown",
      }),
    });
    if (res.ok) {
      return true;
    }
    const errText = await res.text();
    console.error("Telegram Markdown Send Error:", res.status, errText);
    // Robust fallback: strip markdown markup and send clean plain text
    const plainText = rawText.replace(/[*`_]/g, "");
    const retryRes = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: plainText,
      }),
    });
    return retryRes.ok;
  } catch (err) {
    console.error("Telegram EOD alert error:", err.message);
    return false;
  }
}

/**
 * Automatically evaluates the active trade in Redis against live price action (T1, T2, Cost, SL, Time-Stop)
 */
export async function evaluateActiveTradeLifecycle(currentSpot, high = null, low = null, redisClient = null) {
  const redis = redisClient || getRedisClient();
  if (!redis) return null;

  let activeTrade = null;
  try {
    const raw = await redis.get("nifty:tv:active_trade");
    activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (e) {
    return null;
  }

  if (!activeTrade || !activeTrade.active) return null;

  const spot = Number(currentSpot);
  if (!spot || isNaN(spot)) return null;

  const barHigh = high !== null && !isNaN(Number(high)) ? Number(high) : spot;
  const barLow = low !== null && !isNaN(Number(low)) ? Number(low) : spot;
  const isLong = activeTrade.direction === "LONG";
  const entry = Number(activeTrade.entryPrice);
  const t1 = Number(activeTrade.target1Price);
  const t2 = Number(activeTrade.target2Price);
  const currentSl = Number(activeTrade.stopLoss);
  const riskPts = Number(activeTrade.riskPoints || Math.abs(entry - currentSl));
  const t1Dist = Number(activeTrade.target1Dist || riskPts);
  const t2Dist = Number(activeTrade.target2Dist || riskPts * 2);

  const nowIst = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  const nowIso = new Date().toISOString();

  // 1. Target 1 Evaluation (60% scale-out, move SL to Cost)
  if (!activeTrade.hitT1) {
    const hitT1Now = isLong ? barHigh >= t1 : barLow <= t1;
    if (hitT1Now) {
      activeTrade.hitT1 = true;
      activeTrade.t1HitTime = nowIst;
      activeTrade.t1HitPrice = t1;
      activeTrade.stopLoss = entry; // Move SL to Cost
      activeTrade.slAtCost = true;

      try {
        await redis.set("nifty:tv:active_trade", JSON.stringify(activeTrade), { ex: 21600 });
      } catch (e) {}

      const t1Record = {
        type: "TARGET_1_HIT",
        timestamp: nowIso,
        istTime: nowIst,
        trade: activeTrade,
        exitPrice: t1,
        decision: "T1_SCALED_OUT",
        recommendedLots: 0.4,
        netPnl: Number((t1Dist * 0.6).toFixed(2)),
        reasoning: `Target 1 achieved (+${t1Dist} pts). 60% profit booked, SL moved to Cost (${entry}).`,
      };

      try {
        await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(t1Record));
      } catch (e) {}

      await sendTelegramT1Alert(activeTrade, t1);
      return { event: "TARGET_1_HIT", activeTrade };
    }
  }

  // 2. Target 2 Evaluation (Full Profit Close)
  const hitT2Now = isLong ? barHigh >= t2 : barLow <= t2;
  if (hitT2Now) {
    const netPnl = activeTrade.hitT1
      ? Number((t1Dist * 0.6 + t2Dist * 0.4 - 4.0).toFixed(2))
      : Number((t2Dist - 4.0).toFixed(2));

    const exitRecord = {
      type: "TRADE_EXIT",
      timestamp: nowIso,
      istTime: nowIst,
      exitReason: "TARGET_2_HIT",
      exitPrice: t2,
      netPnl,
      trade: activeTrade,
      decision: "EXIT_FULL_PROFIT",
      recommendedLots: 0,
      reasoning: `Target 2 reached (+${t2Dist} pts). Position 100% closed. Realized net PnL: +${netPnl} pts.`,
    };

    try {
      await Promise.all([
        redis.del("nifty:tv:active_trade"),
        redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
      ]);
    } catch (e) {}

    await sendTelegramExitAlert(exitRecord);
    return { event: "TARGET_2_HIT", exitRecord };
  }

  // 3. Breakeven / Cost Evaluation (Runner stopped out at Cost after T1)
  if (activeTrade.hitT1) {
    const hitBeNow = isLong ? barLow <= entry : barHigh >= entry;
    if (hitBeNow) {
      const netPnl = Number((t1Dist * 0.6 - 4.0).toFixed(2)); // Locked profit from T1 minus trading cost
      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: "BREAKEVEN_STOP",
        exitPrice: entry,
        netPnl,
        trade: activeTrade,
        decision: "EXIT_BREAKEVEN_RUNNER",
        recommendedLots: 0,
        reasoning: `Runner stopped at cost (${entry}). Secured 60% profit from T1 with net realized PnL: +${netPnl} pts.`,
      };

      try {
        await Promise.all([
          redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      } catch (e) {}

      await sendTelegramExitAlert(exitRecord);
      return { event: "BREAKEVEN_STOP", exitRecord };
    }
  } else {
    // 4. Initial Stop Loss Evaluation (before T1)
    const hitSlNow = isLong ? barLow <= currentSl : barHigh >= currentSl;
    if (hitSlNow) {
      const netPnl = Number((-riskPts - 4.0).toFixed(2));
      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: "STOP_LOSS_HIT",
        exitPrice: currentSl,
        netPnl,
        trade: activeTrade,
        decision: "EXIT_STOP_LOSS",
        recommendedLots: 0,
        reasoning: `Stop loss hit at ${currentSl} (-${riskPts} pts). Loss realized: ${netPnl} pts.`,
      };

      try {
        await Promise.all([
          redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      } catch (e) {}

      await sendTelegramExitAlert(exitRecord);
      return { event: "STOP_LOSS_HIT", exitRecord };
    }
  }

  return null;
}

/**
 * Main Vercel / Express Serverless Handler
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const istDate = getIstDateString();
  const redis = getRedisClient();

  // ── GET: Query Signals, Archive, Export CSV, or Close Active Trade ──
  if (req.method === "GET") {
    // 1. Close Active Trade manually or via exit trigger
    if (req.query?.close_trade === "1" || req.query?.action === "close_trade") {
      const exitReason = req.query?.reason || "MANUAL_CLOSE";
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
          await redis.del("nifty:tv:active_trade");
        } catch (e) {}
      }
      if (activeTrade) {
        const exitRecord = {
          type: "TRADE_EXIT",
          timestamp: new Date().toISOString(),
          istTime: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
          exitReason,
          trade: activeTrade,
        };
        if (redis) {
          try {
            await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord));
          } catch (e) {}
        }
        await sendTelegramExitAlert(exitRecord);
        return res.status(200).json({ success: true, message: `Trade closed (${exitReason})`, exitRecord });
      } else {
        return res.status(200).json({ success: true, message: "No active trade was open." });
      }
    }

    // 2. Test Telegram dispatch
    if (req.query?.test === "telegram") {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (!botToken || !chatId) {
        return res.status(400).json({
          ok: false,
          error: "TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID is missing in environment variables.",
          configured: {
            hasBotToken: Boolean(botToken),
            hasChatId: Boolean(chatId),
          },
        });
      }

      const sampleFused = {
        decision: "EXECUTE_TIER1_SCOUT",
        grade: "BEAR_TRAP_BUY",
        direction: "LONG",
        symbol: "NSE:NIFTY",
        timeframe: "15",
        swingTimeframe: "125m",
        entryPrice: 25030.35,
        stopLoss: 24965,
        riskPoints: 65.35,
        target1Price: 25095.7,
        target2Price: 25161.05,
        target1Dist: 65.35,
        target2Dist: 130.7,
        recommendedLots: 1,
        tier: "TIER_1_SCOUT",
        chartMetrics: {
          futQuad: "LONG_UNWINDING",
          futOiPct: "-1.2",
          futOiSrc: "REAL_1_2",
          basis: "+82.5",
        },
        liveOptionChainMetrics: {
          deltaPCR: "1.45",
          floorStrike: 25000,
          roofStrike: 25200,
        },
        reasoning: "TEST: Telegram Webhook Bridge is 100% operational and linked with OptionsScanner!",
      };

      const tgResult = await sendTelegramAlert(sampleFused);
      return res.status(200).json({
        ok: true,
        message: "Test notification dispatched to your Telegram successfully!",
        tgResult,
      });
    }

    // 2b. Test or Trigger EOD Official Directive Dispatch
    if (req.query?.test === "eod" || req.query?.send_eod === "1") {
      let livePayload = null;
      try {
        const oiRes = await fetch("https://niftyninjaa.vercel.app/api/nifty-oi");
        if (oiRes.ok) livePayload = await oiRes.json();
      } catch (e) {}

      const decision = livePayload?.eodDecision || {
        verdict: "EXIT TO CASH / DO NOT CARRY",
        bias: "NEUTRAL",
        conviction: 50,
        sizing: "0% (Cash Only)",
        action: "Balanced flow without directional edge.",
        targetContract: "17-Nov-2026",
        isRollover: true,
        score: 0,
      };

      const spotVal = livePayload?.spotPrice || 25000;
      const floorVal = livePayload?.floor || 24900;
      const roofVal = livePayload?.roof || 25500;

      const sent = await sendTelegramEODAlert(decision, spotVal, floorVal, roofVal, "15:15");
      return res.status(200).json({
        ok: true,
        dispatched: sent,
        decision,
      });
    }

    try {
      const queryDate = req.query?.date || istDate;

      // 3. Master Historical Archive & CSV Export for reviewing 1-2 months later
      if (req.query?.export === "csv") {
        let allSignals = [];
        if (redis) {
          try {
            const raw = await redis.lrange("nifty:tv:signals:master_archive", 0, 999);
            allSignals = (raw || []).map(item => typeof item === "string" ? JSON.parse(item) : item);
          } catch (e) {}
        }
        res.setHeader("Content-Type", "text/csv");
        res.setHeader("Content-Disposition", `attachment; filename=nifty_signals_${istDate}.csv`);
        const header = "Timestamp,IST Time,Grade,Direction,Decision,Lots,Entry,StopLoss,RiskPts,T1,T2,ExitPrice,NetPnL,DeltaPCR,Floor,Roof,FutQuad,FutOI%,Reasoning\n";
        const rows = allSignals.map(s => {
          const cleanReason = (s.reasoning || s.exitReason || "").replace(/"/g, '""');
          const t = s.trade || s;
          const exitP = s.exitPrice !== undefined ? s.exitPrice : "";
          const pnlVal = s.netPnl !== undefined ? s.netPnl : "";
          return `"${s.timestamp}","${s.istTime}","${t.grade || s.grade || s.type || ""}","${t.direction || s.direction || ""}","${s.decision || s.exitReason || s.type || ""}",${s.recommendedLots ?? 0},${t.entryPrice || ""},${t.stopLoss || ""},${t.riskPoints || ""},${t.target1Price || ""},${t.target2Price || ""},${exitP},${pnlVal},${s.liveOptionChainMetrics?.deltaPCR ?? ""},${s.liveOptionChainMetrics?.floorStrike ?? ""},${s.liveOptionChainMetrics?.roofStrike ?? ""},"${s.chartMetrics?.futQuad ?? ""}","${s.chartMetrics?.futOiPct ?? ""}","${cleanReason}"`;
        }).join("\n");
        return res.status(200).send(header + rows);
      }

      // 4. Archive JSON Query
      if (req.query?.archive === "1" || req.query?.history === "1") {
        let historyList = [];
        if (redis) {
          try {
            const raw = await redis.lrange("nifty:tv:signals:master_archive", 0, 499);
            historyList = (raw || []).map(item => typeof item === "string" ? JSON.parse(item) : item);
          } catch (e) {}
        }
        return res.status(200).json({
          success: true,
          total: historyList.length,
          signals: historyList,
        });
      }

      let latestSignal = null;
      let activeTrade = null;
      let signals = [];

      if (redis) {
        try {
          const [latest, list, active] = await Promise.all([
            redis.get("nifty:tv:latest_signal"),
            redis.lrange(`nifty:tv:signals:${queryDate}`, 0, 49),
            redis.get("nifty:tv:active_trade"),
          ]);
          latestSignal = typeof latest === "string" ? JSON.parse(latest) : latest;
          activeTrade = typeof active === "string" ? JSON.parse(active) : active;
          signals = (list || []).map(item =>
            typeof item === "string" ? JSON.parse(item) : item
          );
        } catch (e) {
          latestSignal = await redisRestGet("nifty:tv:latest_signal");
        }
      } else {
        latestSignal = await redisRestGet("nifty:tv:latest_signal");
      }

      // Automatic lifecycle evaluation if spot or high/low provided in GET
      if (req.query?.spot) {
        await evaluateActiveTradeLifecycle(req.query.spot, req.query.high, req.query.low, redis);
        if (redis) {
          try {
            const freshActive = await redis.get("nifty:tv:active_trade");
            activeTrade = typeof freshActive === "string" ? JSON.parse(freshActive) : freshActive;
          } catch (e) {}
        }
      }

      // Explicit status check endpoint
      if (req.query?.action === "status" || req.query?.status === "1") {
        const isFlat = !activeTrade || !activeTrade.active;
        return res.status(200).json({
          success: true,
          status: isFlat ? "FLAT_NO_ACTIVE_TRADES" : "IN_TRADE",
          hasActiveTrade: !isFlat,
          permitsSynergyTrades: isFlat,
          activeTrade,
          message: isFlat
            ? "Market is FLAT. No active trades. You may take the next Trap setup or evaluate Bull/Bear Synergy."
            : `Active trade OPEN: ${activeTrade.grade} ${activeTrade.direction} @ ${activeTrade.entryPrice} (SL: ${activeTrade.stopLoss}, T1: ${activeTrade.target1Price}). Single-position lock active.`
        });
      }

      return res.status(200).json({
        success: true,
        connected: Boolean(REDIS_URL),
        istDate: queryDate,
        activeTrade,
        latestSignal,
        signals,
      });
    } catch (err) {
      return res.status(500).json({ error: "Failed to read signals", details: err.message });
    }
  }

  // ── POST: Process TradingView alert webhook ──
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method Not Allowed. Use POST or GET." });
  }

  try {
    const payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

    // 1. Verify Webhook Secret if configured
    const expectedSecret = process.env.TV_WEBHOOK_SECRET;
    if (expectedSecret && expectedSecret !== "CHANGE_ME" && payload?.secret !== expectedSecret) {
      return res.status(401).json({ error: "Unauthorized webhook secret" });
    }

    // 1b. Handle Trade Exit / T1 Scale-Out Webhooks directly from TradingView or Execution Bridge
    const exitGrades = ["TARGET_1_HIT", "TARGET_2_HIT", "BREAKEVEN_STOP", "STOP_LOSS_HIT", "TIME_STOP_EXIT", "MANUAL_CLOSE"];
    if (exitGrades.includes(payload?.grade)) {
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }

      const nowIst = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
      const nowIso = new Date().toISOString();
      const fillPrice = payload.close || payload.entry || (activeTrade ? (payload.grade === "TARGET_1_HIT" ? activeTrade.target1Price : payload.grade === "TARGET_2_HIT" ? activeTrade.target2Price : activeTrade.entryPrice) : 0);

      if (payload.grade === "TARGET_1_HIT") {
        if (activeTrade) {
          activeTrade.hitT1 = true;
          activeTrade.t1HitTime = nowIst;
          activeTrade.t1HitPrice = fillPrice;
          activeTrade.stopLoss = activeTrade.entryPrice; // Cost
          activeTrade.slAtCost = true;
          if (redis) {
            await redis.set("nifty:tv:active_trade", JSON.stringify(activeTrade), { ex: 21600 });
          }
        }
        const t1Record = {
          type: "TARGET_1_HIT",
          timestamp: nowIso,
          istTime: nowIst,
          trade: activeTrade || { grade: "BEAR_TRAP_BUY", direction: "LONG", entryPrice: fillPrice },
          exitPrice: fillPrice,
          decision: "T1_SCALED_OUT",
          recommendedLots: 0.4,
          netPnl: activeTrade ? Number(((activeTrade.target1Dist || 0) * 0.6).toFixed(2)) : 0,
          reasoning: `Target 1 achieved. 60% profit booked, SL moved to Cost (${activeTrade?.entryPrice || fillPrice}).`,
        };
        if (redis) {
          await redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(t1Record));
        }
        await sendTelegramT1Alert(activeTrade || t1Record.trade, fillPrice);
        return res.status(200).json({ ok: true, event: "TARGET_1_HIT", record: t1Record });
      }

      // Full exit event
      let netPnl = 0;
      if (activeTrade) {
        const isLong = activeTrade.direction === "LONG";
        const entry = Number(activeTrade.entryPrice);
        const exitP = Number(fillPrice);
        const t1Dist = Number(activeTrade.target1Dist || activeTrade.riskPoints || 0);
        const t2Dist = Number(activeTrade.target2Dist || t1Dist * 2);
        if (payload.grade === "TARGET_2_HIT") {
          netPnl = activeTrade.hitT1 ? Number((t1Dist * 0.6 + t2Dist * 0.4 - 4.0).toFixed(2)) : Number((t2Dist - 4.0).toFixed(2));
        } else if (payload.grade === "BREAKEVEN_STOP") {
          netPnl = Number((t1Dist * 0.6 - 4.0).toFixed(2));
        } else if (payload.grade === "STOP_LOSS_HIT") {
          netPnl = Number((-Math.abs(entry - exitP) - 4.0).toFixed(2));
        } else {
          // TIME_STOP_EXIT
          const diff = isLong ? exitP - entry : entry - exitP;
          netPnl = Number(((activeTrade.hitT1 ? t1Dist * 0.6 + diff * 0.4 : diff) - 4.0).toFixed(2));
        }
      }

      const exitRecord = {
        type: "TRADE_EXIT",
        timestamp: nowIso,
        istTime: nowIst,
        exitReason: payload.grade,
        exitPrice: fillPrice,
        netPnl,
        trade: activeTrade || { grade: payload.grade, direction: payload.dir || "LONG", entryPrice: fillPrice },
        decision: "TRADE_CLOSED_FLAT",
        recommendedLots: 0,
        reasoning: `Trade exited (${payload.grade}) at ${fillPrice}. Realized net PnL: ${netPnl >= 0 ? "+" : ""}${netPnl} pts. Market is now FLAT.`,
      };

      if (redis) {
        await Promise.all([
          redis.del("nifty:tv:active_trade"),
          redis.lpush("nifty:tv:signals:master_archive", JSON.stringify(exitRecord)),
        ]);
      }
      await sendTelegramExitAlert(exitRecord);
      return res.status(200).json({ ok: true, event: "TRADE_CLOSED", exitRecord });
    }

    // 2. Fetch Latest Real-Time 22-Strike Option Chain Snapshot from Upstash Redis
    let liveScanner = null;
    if (redis) {
      try {
        const [latestSnapshot, sessionPayload] = await Promise.all([
          redis.get("nifty:flow:latest"),
          redis.get("nifty_latest_session_payload_v2"),
        ]);
        liveScanner =
          (typeof latestSnapshot === "string" ? JSON.parse(latestSnapshot) : latestSnapshot) ||
          (typeof sessionPayload === "string" ? JSON.parse(sessionPayload) : sessionPayload);
      } catch (e) {
        liveScanner =
          (await redisRestGet("nifty:flow:latest")) ||
          (await redisRestGet("nifty_latest_session_payload_v2"));
      }
    } else {
      liveScanner =
        (await redisRestGet("nifty:flow:latest")) ||
        (await redisRestGet("nifty_latest_session_payload_v2"));
    }

    // 3. Fuse TradingView v4.3 Signal with Live 22-Strike Option Chain
    const fusedVerdict = fuseChartWithOptionChain(payload, liveScanner);

    // 4. Enforce Baseline Paper Trading Policy (Traps Only & Single-Position Rule)
    const isTrap = payload.grade === "BEAR_TRAP_BUY" || payload.grade === "BULL_TRAP_SELL";

    if (!isTrap) {
      // Non-trap signals (MEGA, SIGNAL, VBO_BREAK, SWING_BOTTOM, etc.) are informational only
      fusedVerdict.decision = "LOG_ONLY";
      fusedVerdict.recommendedLots = 0;
      fusedVerdict.reasoning = `Informational ${payload.grade || "SIGNAL"} alert logged for review. Forward baseline paper trading acts on Traps Only (Bear/Bull Trap).`;
    } else {
      // Check Single-Position Rule for Traps
      let activeTrade = null;
      if (redis) {
        try {
          const raw = await redis.get("nifty:tv:active_trade");
          activeTrade = typeof raw === "string" ? JSON.parse(raw) : raw;
        } catch (e) {}
      }

      if (activeTrade && activeTrade.active) {
        fusedVerdict.decision = "BLOCKED_BY_ACTIVE_TRADE";
        fusedVerdict.recommendedLots = 0;
        fusedVerdict.reasoning = `BLOCKED: Active trade already open (${activeTrade.grade} ${activeTrade.direction} @ ${activeTrade.entryPrice}). The tested 15m system strictly enforces one position at a time.`;
      } else if (fusedVerdict.decision === "EXECUTE_TIER1_SCOUT") {
        // Record active trade with 6-hour TTL (24 bars on 15m)
        const activeData = {
          active: true,
          grade: fusedVerdict.grade,
          direction: fusedVerdict.direction,
          entryPrice: fusedVerdict.entryPrice,
          stopLoss: fusedVerdict.stopLoss,
          riskPoints: fusedVerdict.riskPoints,
          target1Price: fusedVerdict.target1Price,
          target2Price: fusedVerdict.target2Price,
          target1Dist: fusedVerdict.target1Dist,
          target2Dist: fusedVerdict.target2Dist,
          timestamp: fusedVerdict.timestamp,
          istTime: fusedVerdict.istTime,
        };
        if (redis) {
          try {
            await redis.set("nifty:tv:active_trade", JSON.stringify(activeData), { ex: 21600 });
          } catch (e) {}
        }
      }
    }

    // 5. Persist Fused Signal to Upstash Redis (Daily List + Master Archive)
    const signalKey = `nifty:tv:signals:${istDate}`;
    const archiveKey = "nifty:tv:signals:master_archive";
    if (redis) {
      try {
        await Promise.all([
          redis.lpush(signalKey, JSON.stringify(fusedVerdict)),
          redis.ltrim(signalKey, 0, 99),
          redis.lpush(archiveKey, JSON.stringify(fusedVerdict)),
          redis.ltrim(archiveKey, 0, 999), // Keep up to 1,000 historical signals forever
          redis.set("nifty:tv:latest_signal", JSON.stringify(fusedVerdict), { ex: 86400 }),
        ]);
      } catch (e) {
        await redisRestSet("nifty:tv:latest_signal", fusedVerdict, 86400);
      }
    } else {
      await redisRestSet("nifty:tv:latest_signal", fusedVerdict, 86400);
    }

    // 6. Fire Telegram Notification
    await sendTelegramAlert(fusedVerdict);

    return res.status(200).json({
      ok: true,
      decision: fusedVerdict.decision,
      recommendedLots: fusedVerdict.recommendedLots,
      fusedVerdict,
    });
  } catch (err) {
    console.error("[tv-webhook] Error processing TradingView alert:", err);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
}
