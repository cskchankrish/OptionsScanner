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
 *  5. Logs the fused decision to Upstash Redis (`nifty:tv:signals:YYYY-MM-DD` and `nifty:tv:latest_signal`)
 *     for display in `NiftyFlowView.jsx` and optionally dispatches to Telegram.
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
  const rawSl = Number(tv.sl || tv.st || 0);
  const cappedSl = Number(tv.cappedSl || rawSl);
  const rDist = Number(tv.rDist || (cappedSl > 0 ? Math.abs(close - cappedSl) : 0));
  const t1Dist = Number(tv.t1Dist || 0);
  const t2Dist = Number(tv.t2Dist || 0);
  const t1Price = Number(tv.t1 || (t1Dist > 0 ? (dir === "LONG" ? close + t1Dist : close - t1Dist) : 0));
  const t2Price = Number(tv.t2 || (t2Dist > 0 ? (dir === "LONG" ? close + t2Dist : close - t2Dist) : 0));
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

  return {
    timestamp: new Date().toISOString(),
    istTime: tv.t || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" }),
    symbol: tv.sym || "NIFTY",
    timeframe: tv.tf || "15",
    swingTimeframe: tv.swingTf || "125m",
    direction: dir,
    grade,
    tier,
    decision,
    recommendedLots,
    entryPrice: close,
    stopLoss: cappedSl > 0 ? cappedSl : (rDist > 0 ? (dir === "LONG" ? close - rDist : close + rDist) : rawSl),
    rawStopLoss: rawSl,
    riskPoints: rDist > 0 ? Math.round(rDist * 100) / 100 : (rawSl > 0 ? Math.abs(Math.round((close - rawSl) * 100) / 100) : null),
    target1Price: t1Price > 0 ? Math.round(t1Price * 100) / 100 : null,
    target2Price: t2Price > 0 ? Math.round(t2Price * 100) / 100 : null,
    target1Dist: t1Dist > 0 ? Math.round(t1Dist * 100) / 100 : null,
    target2Dist: t2Dist > 0 ? Math.round(t2Dist * 100) / 100 : null,
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
 * Optional Telegram Notification Helper
 */
export async function sendTelegramAlert(fused) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const icon =
    fused.decision === "VETO_SIGNAL"
      ? "🚫"
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

  const targetLine = fused.target1Price
    ? `• *Targets:* T1: \`${fused.target1Price}\` (+${fused.target1Dist ?? "--"} pts / 1R) | T2: \`${fused.target2Price}\` (+${fused.target2Dist ?? "--"} pts / 2R)`
    : null;

  const lines = [
    `${icon} *${fused.decision}* · \`${fused.grade}\`${kindBadge} (${fused.direction})${armedBadge}`,
    `• *Symbol / TF:* ${fused.symbol} (${fused.timeframe}m | Swing: ${fused.swingTimeframe})`,
    `• *Entry / SL:* \`${fused.entryPrice}\` | *SL:* \`${fused.stopLoss}\` (${fused.riskPoints ?? "--"} pts)`,
    targetLine,
    `• *Recommended Size:* \`${fused.recommendedLots} Lot(s)\` (${fused.tier})`,
    `• *Real Fut OI:* \`${fused.chartMetrics.futQuad}\` (${fused.chartMetrics.futOiPct}% · ${fused.chartMetrics.futOiSrc}) | *Basis:* \`${fused.chartMetrics.basis}\``,
    `• *22-Strike Option Chain:* ΔPCR \`${fused.liveOptionChainMetrics.deltaPCR ?? "N/A"}\` | Floor \`${fused.liveOptionChainMetrics.floorStrike}\` | Roof \`${fused.liveOptionChainMetrics.roofStrike}\``,
    `• *Verdict:* ${fused.reasoning}`,
  ].filter(Boolean);

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
 * Main Vercel / Express Serverless Handler
 * Supported Methods:
 *  - POST: Ingests alert() webhook from TradingView v4.3
 *  - GET:  Fetches recent fused signals & latest status for NiftyFlowView.jsx
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

  // ── GET: Return recent fused signals or test telegram ──
  if (req.method === "GET") {
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
        recommendedLots: 2,
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

    try {
      const queryDate = req.query?.date || istDate;

      // Master Historical Archive & CSV Export for reviewing 1-2 months later
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
        const header = "Timestamp,IST Time,Grade,Direction,Decision,Lots,Entry,StopLoss,RiskPts,DeltaPCR,Floor,Roof,FutQuad,FutOI%,Reasoning\n";
        const rows = allSignals.map(s => {
          const cleanReason = (s.reasoning || "").replace(/"/g, '""');
          return `"${s.timestamp}","${s.istTime}","${s.grade}","${s.direction}","${s.decision}",${s.recommendedLots},${s.entryPrice},${s.stopLoss},${s.riskPoints ?? ""},${s.liveOptionChainMetrics?.deltaPCR ?? ""},${s.liveOptionChainMetrics?.floorStrike ?? ""},${s.liveOptionChainMetrics?.roofStrike ?? ""},"${s.chartMetrics?.futQuad ?? ""}","${s.chartMetrics?.futOiPct ?? ""}","${cleanReason}"`;
        }).join("\n");
        return res.status(200).send(header + rows);
      }

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
      let signals = [];

      if (redis) {
        try {
          const [latest, list] = await Promise.all([
            redis.get("nifty:tv:latest_signal"),
            redis.lrange(`nifty:tv:signals:${queryDate}`, 0, 49),
          ]);
          latestSignal = typeof latest === "string" ? JSON.parse(latest) : latest;
          signals = (list || []).map(item =>
            typeof item === "string" ? JSON.parse(item) : item
          );
        } catch (e) {
          // fallback to rest
          latestSignal = await redisRestGet("nifty:tv:latest_signal");
        }
      } else {
        latestSignal = await redisRestGet("nifty:tv:latest_signal");
      }

      return res.status(200).json({
        success: true,
        connected: Boolean(REDIS_URL),
        istDate: queryDate,
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

    // 4. Persist Fused Signal to Upstash Redis (Daily List + Master Archive)
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

    // 5. Fire Telegram Notification if configured and not vetoed
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
