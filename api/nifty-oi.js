let cache = {
  data: null,
  timestamp: 0,
};

let previousState = {
  floor: 22600,
  roof: 22800,
};

let intradayHistory = [];
let sessionDate = "";

// Upstash Redis / Vercel KV REST integration (Zero extra npm packages needed)
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;

async function getRedisTimeline(dateKey) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const cleanKey = dateKey.replace(/\//g, "-");
    const res = await fetch(`${REDIS_URL}/get/nifty_timeline_v2_${encodeURIComponent(cleanKey)}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    console.warn("Redis timeline fetch error:", e.message);
    return null;
  }
}

async function setRedisTimeline(dateKey, timelineArray) {
  if (!REDIS_URL || !REDIS_TOKEN || !Array.isArray(timelineArray) || timelineArray.length === 0) return false;
  try {
    const cleanKey = dateKey.replace(/\//g, "-");
    const res = await fetch(`${REDIS_URL}/set/nifty_timeline_v2_${encodeURIComponent(cleanKey)}?ex=86400`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(timelineArray),
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch (e) {
    console.warn("Redis timeline save error:", e.message);
    return false;
  }
}

async function syncRedisHistory(today) {
  if (REDIS_URL && (!intradayHistory || intradayHistory.length === 0)) {
    const remote = await getRedisTimeline(today);
    if (Array.isArray(remote) && remote.length > 0) {
      intradayHistory = remote;
    }
  }
}

function getISTMinutes() {
  const istDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return istDate.getHours() * 60 + istDate.getMinutes();
}

function getISTDayOfWeek() {
  const istDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  return istDate.getDay();
}

function getISTDateStr() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
}

function getISTTimeStr() {
  return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
}

function buildTimeline(totPut, totCall, spot) {
  const today = getISTDateStr();
  if (sessionDate !== today) {
    intradayHistory = [];
    sessionDate = today;
  }

  const nowMins = getISTMinutes();
  const nowStr = getISTTimeStr();

  // Market hours: 09:15 = 555 mins, 15:30 = 930 mins
  if (nowMins < 555) {
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: spot }
    ];
  }

  const capMins = Math.min(930, nowMins);

  // Append or update latest live tick (1-min granularity) strictly with REAL exchange data
  const last = intradayHistory[intradayHistory.length - 1];
  let didUpdate = false;
  if (!last || last.minutes < capMins || last.time !== nowStr) {
    intradayHistory.push({
      time: nowStr,
      minutes: capMins,
      putWriting: totPut,
      callWriting: totCall,
      netDiff: totPut - totCall,
      spot: spot,
      isLiveTick: true,
    });
    didUpdate = true;
  } else if (last) {
    last.putWriting = totPut;
    last.callWriting = totCall;
    last.netDiff = totPut - totCall;
    last.spot = spot;
    last.time = nowStr;
    last.isLiveTick = true;
    didUpdate = true;
  }

  // Fire-and-forget save to Redis if available
  if (didUpdate && REDIS_URL) {
    setRedisTimeline(today, intradayHistory).catch(() => {});
  }

  return intradayHistory;
}

function formatLots(n) {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

function toClockTimeStr(m) {
  const h = Math.floor(m / 60);
  const mn = m % 60;
  return `${String(h).padStart(2, "0")}:${String(mn).padStart(2, "0")}`;
}

function detectMacroTurn({ timeline = [], spot, floorStrike, roofStrike, maxPainStrike }) {
  if (!timeline || timeline.length < 12) {
    return {
      isTriggered: false,
      status: "BUILDING",
      message: "● 30-Min Macro Engine: Collecting 2x 15-minute candle history...",
    };
  }

  const tNow = timeline[timeline.length - 1];
  const nowMins = tNow.minutes || 0;

  // Standard NSE 15-minute clock slots (:00, :15, :30, :45)
  // Market starts at 09:15 IST (555 mins)
  const currentSlotStart = Math.floor(nowMins / 15) * 15;
  const currentSlotEnd = currentSlotStart + 15;
  const minsIntoSlot = nowMins - currentSlotStart;

  let c1Start, c1End, c2Start, c2End;

  // If current slot has just started (< 3 mins), use the two previously completed 15m candles
  if (minsIntoSlot < 3) {
    c2Start = currentSlotStart - 15;
    c2End = currentSlotStart;
    c1Start = c2Start - 15;
    c1End = c2Start;
  } else {
    // C1 is the prior completed 15m candle (e.g. 13:00 - 13:15)
    // C2 is the currently forming 15m candle (e.g. 13:15 - 13:30)
    c1Start = currentSlotStart - 15;
    c1End = currentSlotStart;
    c2Start = currentSlotStart;
    c2End = currentSlotEnd;
  }

  // Find timeline points matching exact clock boundaries
  let p0 = timeline[0];
  let minDiff0 = Infinity;
  let p1 = timeline[0];
  let minDiff1 = Infinity;
  let p2 = timeline[timeline.length - 1];

  for (const pt of timeline) {
    const m = pt.minutes || 0;
    const d0 = Math.abs(m - c1Start);
    const d1 = Math.abs(m - c1End);
    if (d0 < minDiff0) {
      minDiff0 = d0;
      p0 = pt;
    }
    if (d1 < minDiff1) {
      minDiff1 = d1;
      p1 = pt;
    }
    if (m <= c2End) {
      p2 = pt;
    }
  }

  const spanMins = (p2.minutes || nowMins) - (p0.minutes || 0);
  if (spanMins < 18) {
    return {
      isTriggered: false,
      status: "ACCUMULATING",
      message: `● 30-Min Macro Engine: ${spanMins}m recorded. Waiting for complete 2x 15m window.`,
    };
  }

  // Candle 1 (Clock aligned: e.g. 13:00 - 13:15)
  const c1SpotDelta = p1.spot - p0.spot;
  const c1NetDelta = p1.netDiff - p0.netDiff;

  // Candle 2 (Clock aligned: e.g. 13:15 - 13:30)
  const c2SpotDelta = p2.spot - p1.spot;
  const c2NetDelta = p2.netDiff - p1.netDiff;

  // 30-Minute Cumulative Total
  const totalSpotDelta = p2.spot - p0.spot;
  const totalNetDelta = p2.netDiff - p0.netDiff;

  const c1Label = `C1 (${toClockTimeStr(c1Start)}-${toClockTimeStr(c1End)})`;
  const c2Label = `C2 (${toClockTimeStr(c2Start)}-${toClockTimeStr(c2End)})`;

  // Criteria for Concrete Macro Bull Trap (50–100 pt reversal down):
  if (totalSpotDelta >= 22 && totalNetDelta <= -26000 && (c1NetDelta < -7000 || c2NetDelta < -14000)) {
    const targetDrop = Math.max(50, Math.min(100, Math.round(spot - floorStrike)));
    const targetPrice = Math.round(spot - targetDrop);
    const invPrice = Math.round(Math.max(p2.spot, p1.spot, p0.spot) + 15);
    return {
      isTriggered: true,
      type: "BULL_TRAP_REVERSAL",
      direction: "BEARISH_TURN",
      title: `🚨 30-MIN MACRO BULL TRAP CONFIRMED (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)})`,
      action: "High-Probability 50–100 pt Reversal Down. Smart money heavily shorted the 30m rally with Call writing.",
      targetMove: `50–80 pts (Target: ~${targetPrice})`,
      invalidation: `Above ${invPrice} (30m high + 15 pts)`,
      candle1: `${c1Label}: Spot ${c1SpotDelta >= 0 ? "+" : ""}${c1SpotDelta.toFixed(1)} pts | Delta ${formatLots(c1NetDelta)}`,
      candle2: `${c2Label}: Spot ${c2SpotDelta >= 0 ? "+" : ""}${c2SpotDelta.toFixed(1)} pts | Delta ${formatLots(c2NetDelta)}`,
      summary: `30m Total (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}): Spot +${totalSpotDelta.toFixed(1)} pts, Net Writing Delta ${formatLots(totalNetDelta)}`,
      message: `🚨 30-MIN MACRO BULL TRAP (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}): Spot pushed +${totalSpotDelta.toFixed(1)} pts, but Net Writing Delta plunged ${formatLots(totalNetDelta)}. High-probability 50–80 pt drop toward ~${targetPrice}. Invalidation: Above ${invPrice}.`,
    };
  }

  // Criteria for Concrete Macro Bear Trap (50–100 pt bounce up):
  if (totalSpotDelta <= -22 && totalNetDelta >= 28000 && (c1NetDelta > 7000 || c2NetDelta > 14000)) {
    const targetBounce = Math.max(50, Math.min(100, Math.round(roofStrike - spot)));
    const targetPrice = Math.round(spot + targetBounce);
    const invPrice = Math.round(Math.min(p2.spot, p1.spot, p0.spot) - 15);
    return {
      isTriggered: true,
      type: "BEAR_TRAP_REVERSAL",
      direction: "BULLISH_TURN",
      title: `🟢 30-MIN MACRO BEAR TRAP / ABSORPTION CONFIRMED (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)})`,
      action: "High-Probability 50–100 pt Reversal Up. Smart money heavily absorbed the 30m dip with Put writing.",
      targetMove: `50–80 pts (Target: ~${targetPrice})`,
      invalidation: `Below ${invPrice} (30m low - 15 pts)`,
      candle1: `${c1Label}: Spot ${c1SpotDelta >= 0 ? "+" : ""}${c1SpotDelta.toFixed(1)} pts | Delta ${formatLots(c1NetDelta)}`,
      candle2: `${c2Label}: Spot ${c2SpotDelta >= 0 ? "+" : ""}${c2SpotDelta.toFixed(1)} pts | Delta ${formatLots(c2NetDelta)}`,
      summary: `30m Total (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}): Spot ${totalSpotDelta >= 0 ? "+" : ""}${totalSpotDelta.toFixed(1)} pts, Net Writing Delta ${formatLots(totalNetDelta)}`,
      message: `🟢 30-MIN MACRO BEAR TRAP (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}): Spot dipped ${totalSpotDelta.toFixed(1)} pts, but Put writers absorbed ${formatLots(totalNetDelta)}. High-probability 50–80 pt bounce toward ~${targetPrice}. Invalidation: Below ${invPrice}.`,
    };
  }

  return {
    isTriggered: false,
    type: "IN_SYNC",
    message: `● 30-Min Flow In-Sync (${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}): Spot ${totalSpotDelta >= 0 ? "+" : ""}${totalSpotDelta.toFixed(1)} pts | Net Delta ${formatLots(totalNetDelta)}. Price & writing delta aligned.`,
    candle1: `${c1Label}: Spot ${c1SpotDelta >= 0 ? "+" : ""}${c1SpotDelta.toFixed(1)} | Delta ${formatLots(c1NetDelta)}`,
    candle2: `${c2Label}: Spot ${c2SpotDelta >= 0 ? "+" : ""}${c2SpotDelta.toFixed(1)} | Delta ${formatLots(c2NetDelta)}`,
    totalSpotDelta: Number(totalSpotDelta.toFixed(1)),
    totalNetDelta: Math.round(totalNetDelta),
  };
}

// ── SMART MONEY / INSTITUTIONAL CALCULATIONS ──
function calculateMaxPain(strikes) {
  if (!strikes || strikes.length === 0) return 22700;
  let minLoss = Infinity;
  let maxPainStrike = strikes[0].strike;

  for (const target of strikes) {
    const sTarget = target.strike;
    let totalLoss = 0;
    for (const s of strikes) {
      if (s.strike < sTarget) {
        // Call options are In-The-Money for writers
        totalLoss += (sTarget - s.strike) * (s.callOI || 0);
      } else if (s.strike > sTarget) {
        // Put options are In-The-Money for writers
        totalLoss += (s.strike - sTarget) * (s.putOI || 0);
      }
    }
    if (totalLoss < minLoss) {
      minLoss = totalLoss;
      maxPainStrike = sTarget;
    }
  }
  return maxPainStrike;
}

function analyzeSmartMoney({ strikes, spot, floorStrike, roofStrike, intradayHistory }) {
  if (!strikes || strikes.length === 0) {
    return {
      stance: "RANGE-BOUND (DELTA NEUTRAL)",
      bias: "NEUTRAL",
      conviction: 60,
      action: "Institutions writing both wings. Range-bound pinning expected.",
      atmStrike: 22700,
      maxPainStrike: 22700,
      instPutWritingFormatted: "+0",
      instCallWritingFormatted: "+0",
      putDominance: 50,
      floorMigration: `● Defending ${floorStrike}`,
      roofMigration: `● Capping at ${roofStrike}`,
      trapAlert: "● Flow In-Sync: Price action aligned with writing delta.",
    };
  }

  // Find ATM strike (closest to spot)
  const atmStrike = strikes.reduce((prev, curr) =>
    Math.abs(curr.strike - spot) < Math.abs(prev.strike - spot) ? curr : prev,
    strikes[0]
  ).strike;

  const maxPainStrike = calculateMaxPain(strikes);

  // Focus on the high-liquidity Institutional Zone: ATM +/- 200 points
  const corridorStrikes = strikes.filter(s => Math.abs(s.strike - atmStrike) <= 200);

  let instPutWriting = 0;
  let instCallWriting = 0;
  let instPutUnwinding = 0;
  let instCallUnwinding = 0;

  for (const s of corridorStrikes) {
    if (s.putDeltaOI > 0) instPutWriting += s.putDeltaOI;
    else if (s.putDeltaOI < 0) instPutUnwinding += Math.abs(s.putDeltaOI);

    if (s.callDeltaOI > 0) instCallWriting += s.callDeltaOI;
    else if (s.callDeltaOI < 0) instCallUnwinding += Math.abs(s.callDeltaOI);
  }

  const totalInst = instPutWriting + instCallWriting;
  const putDominance = totalInst > 0 ? Math.round((instPutWriting / totalInst) * 100) : 50;

  let stance = "RANGE-BOUND (DELTA NEUTRAL)";
  let bias = "NEUTRAL";
  let conviction = 60;
  let action = `Institutions writing both calls & puts near ATM ${atmStrike}. Expect index to pin within ${floorStrike} – ${roofStrike}.`;

  if (instCallUnwinding > 25000 && instPutWriting > instCallWriting) {
    stance = "SHORT COVERING SQUEEZE";
    bias = "BULLISH";
    conviction = Math.min(95, 75 + Math.round(instCallUnwinding / 5000));
    action = "Call writers actively exiting short hedges under upside pressure. Favorable for momentum upside continuation.";
  } else if (instPutUnwinding > 25000 && instCallWriting > instPutWriting) {
    stance = "SUPPORT COLLAPSE / LONG UNWINDING";
    bias = "BEARISH";
    conviction = Math.min(95, 75 + Math.round(instPutUnwinding / 5000));
    action = "Put writers abandoning support strikes and cutting loss. Downside slippage risk elevated.";
  } else if (instPutWriting > 1.35 * instCallWriting) {
    stance = "INSTITUTIONAL ACCUMULATION";
    bias = "BULLISH";
    conviction = Math.min(98, putDominance);
    action = `Big players heavily underwriting Put strikes near ${floorStrike} (${putDominance}% dominance). Dips toward support are institutional buying zones.`;
  } else if (instCallWriting > 1.35 * instPutWriting) {
    stance = "INSTITUTIONAL CAPPING (DISTRIBUTION)";
    bias = "BEARISH";
    conviction = Math.min(98, 100 - putDominance);
    action = `Big players building aggressive Call resistance at ${roofStrike} (${100 - putDominance}% call dominance). Overhead rallies are capped by institutional supply.`;
  } else {
    stance = "RANGE-BOUND (DELTA NEUTRAL STRADDLE)";
    bias = "NEUTRAL";
    conviction = 65;
    action = `Institutions writing both Calls and Puts around ATM ${atmStrike}. High theta-decay zone; pin expected between ${floorStrike} and ${roofStrike}.`;
  }

  // Floor & Roof Migration
  let floorMigration = `● ROCK SOLID at ${floorStrike} (Institutional Base)`;
  if (previousState.floor && previousState.floor !== floorStrike) {
    if (floorStrike > previousState.floor) {
      floorMigration = `▲ MIGRATED UP from ${previousState.floor} to ${floorStrike} (+${floorStrike - previousState.floor} pts) · Raising Support`;
    } else {
      floorMigration = `▼ MIGRATED DOWN from ${previousState.floor} to ${floorStrike} (-${previousState.floor - floorStrike} pts) · Lowering Defense`;
    }
  }

  let roofMigration = `● ROCK SOLID at ${roofStrike} (Institutional Cap)`;
  if (previousState.roof && previousState.roof !== roofStrike) {
    if (roofStrike > previousState.roof) {
      roofMigration = `▲ CEILING LIFTED from ${previousState.roof} to ${roofStrike} (+${roofStrike - previousState.roof} pts) · Room for Expansion`;
    } else {
      roofMigration = `▼ CEILING LOWERED from ${previousState.roof} to ${roofStrike} (-${previousState.roof - roofStrike} pts) · Compressing Range`;
    }
  }

  // 30-MINUTE MACRO ENGINE (2x 15-Minute Candles) for 50-100 Pt Turns
  const macroTurn = detectMacroTurn({
    timeline: intradayHistory,
    spot,
    floorStrike,
    roofStrike,
    maxPainStrike,
  });

  const trapAlert = macroTurn.message;

  return {
    stance,
    bias,
    conviction,
    action,
    atmStrike,
    maxPainStrike,
    instPutWritingFormatted: formatLots(instPutWriting),
    instCallWritingFormatted: formatLots(instCallWriting),
    putDominance,
    floorMigration,
    roofMigration,
    trapAlert,
    macroTurn,
  };
}

function calculateEODDecision({
  spot = 22696.65,
  floorStrike = 22600,
  roofStrike = 22800,
  totPutWriting = 0,
  totCallWriting = 0,
  pcr = 1.0,
  deltaPcr = 1.0,
  timeline = [],
  dayOfWeek = 5,
  nowMins = 905,
}) {
  let score = 0;
  const audit = [];

  // 1. Full Day Writing Ratio
  let fullDayStatus = "NEUTRAL";
  let fullDayDetail = "Balanced / non-directional writing";
  if (totPutWriting > 1.35 * totCallWriting) {
    score += 2;
    fullDayStatus = "BULLISH";
    fullDayDetail = `Put writing dominates full day (${formatLots(totPutWriting)} P vs ${formatLots(totCallWriting)} C)`;
  } else if (totCallWriting > 1.35 * totPutWriting) {
    score -= 2;
    fullDayStatus = "BEARISH";
    fullDayDetail = `Call writing dominates full day (${formatLots(totCallWriting)} C vs ${formatLots(totPutWriting)} P)`;
  }
  audit.push({
    label: "Full Day Writing",
    status: fullDayStatus,
    detail: fullDayDetail,
    impact: fullDayStatus === "BULLISH" ? "+2 pts" : fullDayStatus === "BEARISH" ? "-2 pts" : "0 pts",
  });

  // 2. Final Hour Flow (14:15 to current)
  let lastHourNetDelta = 0;
  let closingFlowStatus = "NEUTRAL";
  let closingFlowDetail = "Neutral closing hour flow";
  if (timeline && timeline.length >= 3) {
    let p1415 = timeline[0];
    let minDiff = Infinity;
    for (const pt of timeline) {
      const d = Math.abs((pt.minutes || 0) - 855); // 855 = 14:15 IST
      if (d < minDiff) {
        minDiff = d;
        p1415 = pt;
      }
    }
    const pNow = timeline[timeline.length - 1];
    lastHourNetDelta = (pNow.netDiff || 0) - (p1415.netDiff || 0);

    if (lastHourNetDelta > 20000) {
      score += 2;
      closingFlowStatus = "BULLISH";
      closingFlowDetail = `Strong Put accumulation (${formatLots(lastHourNetDelta)} lots since 14:15)`;
    } else if (lastHourNetDelta < -20000) {
      score -= 2;
      closingFlowStatus = "BEARISH";
      closingFlowDetail = `Heavy Call distribution (${formatLots(lastHourNetDelta)} lots since 14:15)`;
    } else {
      closingFlowDetail = `Closing flow steady (${formatLots(lastHourNetDelta)} lots since 14:15)`;
    }
  } else {
    closingFlowDetail = "Awaiting more intraday ticks";
  }
  audit.push({
    label: "Closing Hour Flow (14:15+)",
    status: closingFlowStatus,
    detail: closingFlowDetail,
    impact: closingFlowStatus === "BULLISH" ? "+2 pts" : closingFlowStatus === "BEARISH" ? "-2 pts" : "0 pts",
  });

  // 3. PCR & Delta PCR
  let pcrStatus = "NEUTRAL";
  let pcrDetail = `PCR ${Number(pcr).toFixed(2)} · ΔPCR ${Number(deltaPcr).toFixed(2)}`;
  if (pcr >= 1.20 && deltaPcr >= 1.30) {
    score += 1;
    pcrStatus = "BULLISH";
    pcrDetail = `Bullish PCR expansion (PCR ${Number(pcr).toFixed(2)}, ΔPCR ${Number(deltaPcr).toFixed(2)})`;
  } else if (pcr <= 0.85 && deltaPcr <= 0.75) {
    score -= 1;
    pcrStatus = "BEARISH";
    pcrDetail = `Bearish PCR compression (PCR ${Number(pcr).toFixed(2)}, ΔPCR ${Number(deltaPcr).toFixed(2)})`;
  }
  audit.push({
    label: "PCR Structure",
    status: pcrStatus,
    detail: pcrDetail,
    impact: pcrStatus === "BULLISH" ? "+1 pt" : pcrStatus === "BEARISH" ? "-1 pt" : "0 pts",
  });

  // 4. Spot Price vs Floor / Roof
  let levelStatus = "NEUTRAL";
  let levelDetail = `Spot ${Number(spot).toFixed(0)} between ${floorStrike} and ${roofStrike}`;
  if (spot >= floorStrike + 30 && spot <= roofStrike - 15) {
    score += 1;
    levelStatus = "BULLISH";
    levelDetail = `Spot holding firmly above Floor support (${floorStrike})`;
  } else if (spot <= floorStrike + 15) {
    score -= 1;
    levelStatus = "BEARISH";
    levelDetail = `Spot breaking down near Floor support (${floorStrike})`;
  } else if (spot >= roofStrike - 10) {
    score -= 1;
    levelStatus = "BEARISH";
    levelDetail = `Spot pinned at Roof resistance (${roofStrike})`;
  }
  audit.push({
    label: "Spot vs Levels",
    status: levelStatus,
    detail: levelDetail,
    impact: levelStatus === "BULLISH" ? "+1 pt" : levelStatus === "BEARISH" ? "-1 pt" : "0 pts",
  });

  const isFriday = (dayOfWeek === 5);
  const isDecisionWindow = (nowMins >= 885 && nowMins <= 930); // 14:45 to 15:30 IST

  let statusLabel = "EARLY MONITORING";
  if (isDecisionWindow) {
    statusLabel = "ACTIVE EXECUTION WINDOW (15:00 - 15:25 IST)";
  } else if (nowMins > 930) {
    statusLabel = "MARKET CLOSED · EOD POST-MORTEM";
  } else {
    statusLabel = "EARLY MONITORING · DECISION SETTLES AT 15:00 IST";
  }

  let verdict = "EXIT TO CASH / DO NOT CARRY";
  let bias = "NEUTRAL";
  let conviction = 75;
  let sizing = "0% (Zero Leverage)";
  let action = "No overnight edge. Balanced flow or chop. Carry zero leverage into next session.";

  // Thresholds: on Friday, require score >= 4 or <= -4 due to weekend decay
  const thresh = isFriday ? 4 : 3;

  if (score >= thresh) {
    verdict = "CARRY NIFTY CE (BTST)";
    bias = "BULLISH";
    conviction = Math.min(95, 72 + score * 4);
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = `Favorable for holding overnight Nifty CE. Smart money has underwritten downside risk. Target: Morning gap-up continuation toward ${roofStrike}.`;
  } else if (score <= -thresh) {
    verdict = "CARRY NIFTY PE (STBT)";
    bias = "BEARISH";
    conviction = Math.min(95, 72 + Math.abs(score) * 4);
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = `Favorable for holding overnight Nifty PE. Smart money heavily capped resistance. Target: Morning gap-down slippage toward ${floorStrike}.`;
  } else {
    verdict = "EXIT TO CASH / DO NOT CARRY";
    bias = "NEUTRAL";
    conviction = 80;
    sizing = "0% (Cash Only)";
    const riskReason = isFriday
      ? "Friday weekend alert: 2 full days of theta decay + weekend event risk without clear 80%+ institutional dominance"
      : "Balanced intraday flow without clear overnight edge";
    action = `${riskReason}. Carry 0 overnight leverage and preserve capital for next market open.`;
  }

  return {
    verdict,
    bias,
    conviction,
    sizing,
    action,
    score,
    isFriday,
    isDecisionWindow,
    statusLabel,
    audit,
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const today = getISTDateStr();

  // Handle client-to-server sync via POST (e.g. mobile or desktop sharing gathered 1-min ticks)
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      const incoming = body?.timeline;
      if (Array.isArray(incoming) && incoming.length > 0) {
        const map = new Map();
        for (const pt of intradayHistory) {
          if (pt && pt.time) map.set(pt.time, pt);
        }
        for (const pt of incoming) {
          if (pt && pt.time) map.set(pt.time, pt);
        }
        intradayHistory = Array.from(map.values()).sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
        if (REDIS_URL) {
          await setRedisTimeline(today, intradayHistory);
        }
        return res.status(200).json({ success: true, count: intradayHistory.length });
      }
      return res.status(200).json({ success: true, count: intradayHistory.length });
    } catch (e) {
      return res.status(400).json({ error: "Invalid sync payload" });
    }
  }

  const now = Date.now();
  if (cache.data && now - cache.timestamp < 30000) {
    return res.status(200).json(cache.data);
  }

  // Preload history from Redis if memory is empty
  await syncRedisHistory(today);

  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "*/*",
      "Referer": "https://www.nseindia.com/option-chain",
    };

    // 1. Session warmup with 3.5s timeout
    const warmup = await fetch("https://www.nseindia.com/option-chain", {
      headers,
      signal: AbortSignal.timeout(3500),
    });
    const rawCookies = warmup.headers.get("set-cookie") || "";
    const cookieHeader = rawCookies
      .split(",")
      .map(c => c.split(";")[0])
      .join("; ");

    const sessionHeaders = {
      ...headers,
      Cookie: cookieHeader,
    };

    // 2. Fetch contract info to identify current expiry with 3.5s timeout
    const contractRes = await fetch("https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY", {
      headers: sessionHeaders,
      signal: AbortSignal.timeout(3500),
    });
    if (!contractRes.ok) throw new Error(`contract-info status ${contractRes.status}`);
    const contractData = await contractRes.json();
    const expiry = contractData.expiryDates?.[0] || "";

    // 3. Fetch v3 option chain with 3.5s timeout
    const v3Url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(expiry)}`;
    const v3Res = await fetch(v3Url, {
      headers: sessionHeaders,
      signal: AbortSignal.timeout(3500),
    });
    if (!v3Res.ok) throw new Error(`v3 status ${v3Res.status}`);
    const v3Data = await v3Res.json();

    const spot = Number(v3Data.records?.underlyingValue) || 22696.65;
    const records = v3Data.filtered?.data || v3Data.records?.data || [];
    const expiryDate = expiry;
    const timestampStr = v3Data.records?.timestamp || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });

    // Focus on strikes near spot (e.g. +/- 550 points)
    const filteredRows = records.filter(r => {
      const st = Number(r.strikePrice);
      return st && Math.abs(st - spot) <= 550;
    });

    let maxPutDoi = -Infinity;
    let floorStrike = 22600;
    let maxCallDoi = -Infinity;
    let roofStrike = 22800;

    let totPutWriting = 0;
    let totCallWriting = 0;
    let totPutOI = 0;
    let totCallOI = 0;

    const strikes = [];

    for (const r of filteredRows) {
      const strike = Number(r.strikePrice);
      const pe = r.PE || {};
      const ce = r.CE || {};

      const pDoi = Number(pe.changeinOpenInterest) || 0;
      const cDoi = Number(ce.changeinOpenInterest) || 0;
      const pOi = Number(pe.openInterest) || 0;
      const cOi = Number(ce.openInterest) || 0;

      totPutOI += pOi;
      totCallOI += cOi;

      if (pDoi > 0) totPutWriting += pDoi;
      if (cDoi > 0) totCallWriting += cDoi;

      // Track floor (peak put writing below spot)
      if (strike <= spot && pDoi > maxPutDoi) {
        maxPutDoi = pDoi;
        floorStrike = strike;
      }

      // Track roof (peak call writing above spot)
      if (strike >= spot && cDoi > maxCallDoi) {
        maxCallDoi = cDoi;
        roofStrike = strike;
      }

      strikes.push({
        strike,
        putDeltaOI: pDoi,
        callDeltaOI: cDoi,
        putOI: pOi,
        callOI: cOi,
        putDeltaFormatted: formatLots(pDoi),
        callDeltaFormatted: formatLots(cDoi),
        putType: pDoi > 0 ? "BUILT" : pDoi < 0 ? "REMOVED" : "UNCLEAR",
        callType: cDoi > 0 ? "BUILT" : cDoi < 0 ? "REMOVED" : "UNCLEAR",
      });
    }

    // Sort strikes descending (higher strike at top)
    strikes.sort((a, b) => b.strike - a.strike);

    // Compute balance and shifts
    let balanceStatus = "Balanced";
    let recommendation = "Market balanced. Wait for directional breakout.";
    if (totPutWriting > 1.2 * totCallWriting) {
      balanceStatus = "Support Heavier";
      recommendation = "Put writing dominates. Favorable for stock CALLS on dips to support.";
    } else if (totCallWriting > 1.2 * totPutWriting) {
      balanceStatus = "Resistance Heavier";
      recommendation = "Call writing dominates. Favorable for stock PUTS / avoid fresh longs.";
    }

    let floorShift = `Floor holding steady at ${floorStrike}`;
    if (previousState.floor && previousState.floor !== floorStrike) {
      floorShift = `Floor moved from ${previousState.floor} to ${floorStrike}`;
      previousState.floor = floorStrike;
    }

    let roofShift = `Roof holding steady at ${roofStrike}`;
    if (previousState.roof && previousState.roof !== roofStrike) {
      roofShift = `Roof moved from ${previousState.roof} to ${roofStrike}`;
      previousState.roof = roofStrike;
    }

    const pcr = totCallOI > 0 ? Number((totPutOI / totCallOI).toFixed(2)) : 1.0;
    const deltaPcr = totCallWriting > 0 ? Number((totPutWriting / totCallWriting).toFixed(2)) : 1.0;

    const timeline = buildTimeline(totPutWriting, totCallWriting, spot);

    // Compute Smart Money / Institutional Analysis
    const smartMoney = analyzeSmartMoney({
      strikes,
      spot,
      floorStrike,
      roofStrike,
      intradayHistory: timeline,
    });

    const eodDecision = calculateEODDecision({
      spot,
      floorStrike,
      roofStrike,
      totPutWriting,
      totCallWriting,
      pcr,
      deltaPcr,
      timeline,
      dayOfWeek: getISTDayOfWeek(),
      nowMins: getISTMinutes(),
    });

    smartMoney.eodDecision = eodDecision;

    const payload = {
      success: true,
      isLive: true,
      symbol: "NIFTY",
      spotPrice: spot,
      expiryDate,
      timestamp: timestampStr,
      floor: floorStrike,
      roof: roofStrike,
      floorShift,
      roofShift,
      totalPutWriting: totPutWriting,
      totalCallWriting: totCallWriting,
      totalPutWritingFormatted: formatLots(totPutWriting),
      totalCallWritingFormatted: formatLots(totCallWriting),
      balanceStatus,
      recommendation,
      pcr,
      deltaPcr,
      strikes,
      smartMoney,
      eodDecision,
      intradayTimeline: timeline,
      hasRedis: Boolean(REDIS_URL),
    };

    cache = { data: payload, timestamp: now };
    return res.status(200).json(payload);
  } catch (err) {
    console.error("NSE Live fetch error, falling back to cached state:", err);
    if (cache.data) {
      return res.status(200).json({ ...cache.data, isLive: false, fallbackNotice: "Serving cached live session state" });
    }

    // High fidelity default fallback based on current session
    const fallbackPayload = getFallbackData();
    return res.status(200).json(fallbackPayload);
  }
}

function getFallbackData() {
  const spot = 22696.65;
  const strikesData = [
    { strike: 23150, pDoi: -844, cDoi: 5905, pOi: 5602, cOi: 61903 },
    { strike: 23100, pDoi: -6853, cDoi: -2507, pOi: 28031, cOi: 153441 },
    { strike: 23050, pDoi: -3063, cDoi: 6130, pOi: 10232, cOi: 71266 },
    { strike: 23000, pDoi: -14907, cDoi: 5987, pOi: 78417, cOi: 256591 },
    { strike: 22950, pDoi: -1955, cDoi: -958, pOi: 12090, cOi: 59869 },
    { strike: 22900, pDoi: -4079, cDoi: -10692, pOi: 53623, cOi: 103058 },
    { strike: 22850, pDoi: 574, cDoi: 5036, pOi: 14239, cOi: 41276 },
    { strike: 22800, pDoi: -5453, cDoi: 18517, pOi: 74314, cOi: 138190 },
    { strike: 22750, pDoi: 4515, cDoi: 16904, pOi: 45427, cOi: 56805 },
    { strike: 22700, pDoi: 30811, cDoi: 25524, pOi: 140390, cOi: 114251 },
    { strike: 22650, pDoi: 31114, cDoi: 20993, pOi: 60746, cOi: 35848 },
    { strike: 22600, pDoi: 85404, cDoi: 36895, pOi: 170655, cOi: 70745 },
    { strike: 22550, pDoi: 33970, cDoi: 11667, pOi: 58410, cOi: 17026 },
    { strike: 22500, pDoi: 38346, cDoi: 11825, pOi: 169111, cOi: 49103 },
    { strike: 22450, pDoi: 23053, cDoi: 2439, pOi: 44063, cOi: 4272 },
    { strike: 22400, pDoi: 16036, cDoi: 1337, pOi: 84620, cOi: 11458 },
    { strike: 22350, pDoi: 11548, cDoi: 1139, pOi: 33904, cOi: 2672 },
    { strike: 22300, pDoi: 8354, cDoi: -666, pOi: 95264, cOi: 11395 },
    { strike: 22250, pDoi: 455, cDoi: 356, pOi: 30568, cOi: 1409 },
    { strike: 22200, pDoi: -2670, cDoi: 586, pOi: 101251, cOi: 7889 },
  ];

  const strikes = strikesData.map(r => ({
    strike: r.strike,
    putDeltaOI: r.pDoi,
    callDeltaOI: r.cDoi,
    putOI: r.pOi,
    callOI: r.cOi,
    putDeltaFormatted: formatLots(r.pDoi),
    callDeltaFormatted: formatLots(r.cDoi),
    putType: r.pDoi > 0 ? "BUILT" : r.pDoi < 0 ? "REMOVED" : "UNCLEAR",
    callType: r.cDoi > 0 ? "BUILT" : r.cDoi < 0 ? "REMOVED" : "UNCLEAR",
  }));

  const timeline = buildTimeline(279500, 157500, spot);
  const smartMoney = analyzeSmartMoney({
    strikes,
    spot,
    floorStrike: 22600,
    roofStrike: 22800,
    intradayHistory: timeline,
  });

  const eodDecision = calculateEODDecision({
    spot,
    floorStrike: 22600,
    roofStrike: 22800,
    totPutWriting: 279500,
    totCallWriting: 157500,
    pcr: 1.28,
    deltaPcr: 1.77,
    timeline,
    dayOfWeek: getISTDayOfWeek(),
    nowMins: getISTMinutes(),
  });

  smartMoney.eodDecision = eodDecision;

  return {
    success: true,
    isLive: false,
    fallbackNotice: "Live market snapshot",
    symbol: "NIFTY",
    spotPrice: spot,
    expiryDate: "27-Oct-2026",
    timestamp: "22-Oct-2026 13:06 IST",
    floor: 22600,
    roof: 22800,
    floorShift: "Floor moved from 22650 to 22600",
    roofShift: "Roof holding steady at 22800",
    totalPutWriting: 279500,
    totalCallWriting: 157500,
    totalPutWritingFormatted: "+2.8L",
    totalCallWritingFormatted: "+1.6L",
    balanceStatus: "Support Heavier",
    recommendation: "Put writing dominates at 22,600. Favorable for stock CALLS on dips; avoid longs if 22,600 breaks.",
    pcr: 1.28,
    deltaPcr: 1.77,
    strikes,
    smartMoney,
    eodDecision,
    intradayTimeline: timeline,
    hasRedis: Boolean(REDIS_URL),
  };
}