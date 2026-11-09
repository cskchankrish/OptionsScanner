import {
  CANONICAL_EOD_SEED_HISTORY,
  normalizeDateToIso,
  formatIsoToDisplayDate,
} from "../src/eodTrackRecord.js";
import {
  parseNseFuturesPayload,
  classifyFuturesQuadrant,
  evaluateSmartMoneyFusion,
} from "../src/smartMoneyFusion.js";

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

export const DEFAULT_EOD_SEED_HISTORY = CANONICAL_EOD_SEED_HISTORY;

export function getActiveExpiryDate(contractExpiry) {
  if (contractExpiry && typeof contractExpiry === "string" && contractExpiry.trim().length > 0) {
    const trimmed = contractExpiry.trim();
    const expDate = new Date(trimmed);
    const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    if (!isNaN(expDate.getTime()) && expDate >= new Date(nowIst.getFullYear(), nowIst.getMonth(), nowIst.getDate() - 1)) {
      return trimmed;
    }
  }

  // NSE Special Holiday / Diwali Schedule (Diwali Muhurat week special Monday 09-Nov-2026 expiry)
  const istDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const year = istDate.getFullYear();
  const month = istDate.getMonth(); // 10 = Nov
  const date = istDate.getDate();
  const mins = istDate.getHours() * 60 + istDate.getMinutes();

  if (year === 2026 && month === 10) {
    if (date <= 9 && (date < 9 || mins <= 930)) {
      return "09-Nov-2026";
    }
  }

  // Standard upcoming Thursday in IST
  const day = istDate.getDay(); // 0 = Sun, 4 = Thu
  let daysUntilThu = (4 - day + 7) % 7;
  if (day === 4 && mins > 930) {
    daysUntilThu = 7;
  }
  const expiryDate = new Date(istDate.getTime() + daysUntilThu * 86400000);
  const d = String(expiryDate.getDate()).padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = monthNames[expiryDate.getMonth()];
  const y = expiryDate.getFullYear();
  return `${d}-${m}-${y}`;
}

export function getMarketSessionInfo() {
  const day = getISTDayOfWeek(); // 0 = Sun, 1..5 = Mon..Fri, 6 = Sat
  const mins = getISTMinutes();
  const isSunday = (day === 0);
  const isSaturday = (day === 6);
  const isWeekday = (day >= 1 && day <= 5);

  let isLiveMarket = false;
  let isPostMarketSettled = false;
  let isPreMarket = false;
  let tradingWindow = "";
  let nextOpenDescription = "";

  if (isSunday) {
    // Sunday Diwali Muhurat Window: 14:00 opens, 14:20 - 15:20 trading, 16:00 close
    isLiveMarket = (mins >= 840 && mins <= 960);
    isPostMarketSettled = (mins > 960);
    isPreMarket = (mins < 840);
    tradingWindow = "14:20 - 15:20 IST";
    nextOpenDescription = mins < 840 ? "Opens Today 14:00 IST (Trading 14:20 - 15:20)" : "Monday 09:15 IST";
  } else if (isSaturday) {
    isLiveMarket = false;
    isPostMarketSettled = true; // Reviewing Friday's settled session
    isPreMarket = false;
    tradingWindow = "Closed (Weekend)";
    nextOpenDescription = "🪔 Diwali Muhurat Tomorrow (Sunday) 14:00 - 16:00 IST";
  } else {
    // Weekday (Mon - Fri)
    isLiveMarket = (mins >= 555 && mins <= 940);
    isPostMarketSettled = (mins > 940);
    isPreMarket = (mins < 555);
    tradingWindow = "09:15 - 15:30 IST";
    nextOpenDescription = mins < 555 ? "Opens Today 09:15 IST" : "Next Trading Day 09:15 IST";
  }

  return {
    isSunday,
    isSaturday,
    isWeekday,
    isLiveMarket,
    isPostMarketSettled,
    isPreMarket,
    tradingWindow,
    nextOpenDescription,
  };
}

export async function getRedisSessionPayload() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/nifty_latest_session_payload_v2`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    console.warn("Redis session payload fetch error:", e.message);
    return null;
  }
}

export async function saveRedisSessionPayload(payload) {
  if (!REDIS_URL || !REDIS_TOKEN || !payload) return false;
  try {
    const bridgeSnapshot = {
      ...payload,
      corridor: {
        deltaPCR: payload.deltaPcr,
        floorStrike: payload.floor,
        roofStrike: payload.roof,
        totalPutWriting: payload.totalPutWriting,
        totalCallWriting: payload.totalCallWriting,
        strikes: payload.strikes,
      },
      smartMoneyFusion: {
        primaryScenario: payload.fusion?.scenarioId,
        actionTag: payload.fusion?.eodCarryVeto,
        scoreBoost: payload.fusion?.scoreBoost,
        headline: payload.fusion?.headline,
      },
    };

    const p1 = fetch(`${REDIS_URL}/set/nifty_latest_session_payload_v2?ex=1209600`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });

    const p2 = fetch(`${REDIS_URL}/set/nifty:flow:latest?ex=86400`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(bridgeSnapshot),
      signal: AbortSignal.timeout(2500),
    });

    await Promise.allSettled([p1, p2]);
    return true;
  } catch (e) {
    console.warn("Redis session payload save error:", e.message);
    return false;
  }
}

export async function getRedisEodHistory() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/nifty_eod_history_v3`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    console.warn("Redis EOD history fetch error:", e.message);
    return null;
  }
}

export async function saveRedisEodHistory(historyArray) {
  if (!REDIS_URL || !REDIS_TOKEN || !Array.isArray(historyArray)) return false;
  try {
    const res = await fetch(`${REDIS_URL}/set/nifty_eod_history_v3?ex=7776000`, { // 90 days retention
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(historyArray.slice(0, 60)),
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch (e) {
    console.warn("Redis EOD history save error:", e.message);
    return false;
  }
}

export async function getRedisFuturesSnapshot() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/nifty_futures_latest_v1`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    return null;
  }
}

export async function saveRedisFuturesSnapshot(futuresData) {
  if (!REDIS_URL || !REDIS_TOKEN || !futuresData) return false;
  try {
    await fetch(`${REDIS_URL}/set/nifty_futures_latest_v1?ex=86400`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(futuresData),
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch (e) {
    return false;
  }
}

export function calculateDeltaPcr(totPutWriting, totCallWriting) {
  const pWriting = Number(totPutWriting) || 0;
  const cWriting = Number(totCallWriting) || 0;
  if (cWriting > 0 && pWriting > 0) {
    return Number((pWriting / cWriting).toFixed(2));
  }
  if (cWriting <= 0 && pWriting > 0) {
    return 2.5; // Call unwinding / short-covering + active put writing: Dominant Bullish flow
  }
  if (pWriting <= 0 && cWriting > 0) {
    return 0.35; // Put unwinding + active call writing: Dominant Bearish flow
  }
  if (cWriting < 0 && pWriting < 0) {
    return cWriting !== 0 ? Number((pWriting / cWriting).toFixed(2)) : 1.0;
  }
  return 1.0;
}

export async function resolveAndSyncEodHistory({ spot, floorStrike, roofStrike, eodDecision }) {
  const todayIso = getISTIsoDateStr();
  const todayDisplayDate = formatIsoToDisplayDate(todayIso);
  const dayName = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", weekday: "long" });
  const timeStr = `${getISTTimeStr()} IST`;
  const nowMins = getISTMinutes();
  const dayOfWeek = getISTDayOfWeek();
  const isSunday = (dayOfWeek === 0);
  const openMins = isSunday ? 840 : 555;
  const closeMins = isSunday ? 960 : 940;
  const closeTimeStr = isSunday ? "16:00" : "15:40";

  let history = null;
  if (REDIS_URL) {
    history = await getRedisEodHistory();
  }
  if (!Array.isArray(history) || history.length === 0) {
    history = [...CANONICAL_EOD_SEED_HISTORY];
  }

  // 1. If previous session is PENDING and market has opened today, auto-resolve next morning open outcome
  if (nowMins >= openMins && history.length > 0) {
    for (let i = 0; i < Math.min(3, history.length); i++) {
      const item = history[i];
      const itemIso = normalizeDateToIso(item?.isoDate || item?.date || item?.id);
      if (item && item.outcome === "PENDING" && itemIso !== todayIso && spot > 0) {
        item.nextDayOpen = spot;
        const diff = Number((spot - (item.entrySpot || spot)).toFixed(1));
        if (item.bias === "BULLISH") {
          item.gapPts = diff;
          item.outcome = diff > 0 ? "WIN" : "LOSS";
          item.notes = `${diff >= 0 ? "+" : ""}${diff} pts morning gap on open`;
        } else if (item.bias === "BEARISH") {
          item.gapPts = -diff;
          item.outcome = diff < 0 ? "WIN" : "LOSS";
          item.notes = `${diff <= 0 ? "+" : ""}${-diff} pts gap-down on open`;
        } else {
          item.gapPts = 0;
          item.outcome = "PRESERVED_CASH";
          item.notes = "Avoided overnight exposure; 100% cash preserved.";
        }
      }
    }
  }

  // 2. Add or update today's EOD recommendation in history
  const existingIdx = history.findIndex(h => {
    const hIso = normalizeDateToIso(h.isoDate || h.date || h.id);
    return hIso === todayIso;
  });

  const todayEntry = {
    id: `eod_${todayIso}`,
    isoDate: todayIso,
    date: todayDisplayDate,
    dayName,
    time: timeStr,
    verdict: eodDecision.verdict,
    bias: eodDecision.bias,
    score: eodDecision.score,
    conviction: eodDecision.conviction,
    sizing: eodDecision.sizing,
    entrySpot: spot,
    nextDayOpen: existingIdx >= 0 ? history[existingIdx].nextDayOpen : null,
    gapPts: existingIdx >= 0 ? history[existingIdx].gapPts : null,
    outcome: existingIdx >= 0 && history[existingIdx].outcome !== "PENDING"
      ? history[existingIdx].outcome
      : eodDecision.bias === "NEUTRAL" ? "PRESERVED_CASH" : "PENDING",
    floor: floorStrike,
    roof: roofStrike,
    pcr: eodDecision.pcr,
    deltaPcr: eodDecision.deltaPcr,
    pcrWarning: eodDecision.pcrWarning,
    action: eodDecision.action,
    keyReasons: (eodDecision.audit || []).map(a => `${a.label} (${a.impact})`).join(" · "),
    notes: (eodDecision.isDecisionWindow || nowMins >= closeMins) ? `Decision finalized on closing settlement (${closeTimeStr} IST).` : "Intraday monitoring snapshot.",
  };

  if (existingIdx >= 0) {
    // If existing entry was already finalized in the execution window with valid closing data,
    // and current calculation has unvalidated closing data (e.g. from an ad-hoc post-market request),
    // preserve the finalized verdict and score instead of degrading to neutral/unvalidated!
    const existing = history[existingIdx];
    const existingWasFinalized = existing.notes?.includes("finalized") || (existing.outcome && existing.outcome !== "PENDING");
    if (existingWasFinalized && !eodDecision.isClosingDataValid) {
      history[existingIdx] = {
        ...existing,
        entrySpot: spot || existing.entrySpot,
        floor: floorStrike || existing.floor,
        roof: roofStrike || existing.roof,
      };
    } else {
      history[existingIdx] = { ...existing, ...todayEntry };
    }
  } else {
    history.unshift(todayEntry);
  }

  // Deduplicate by ISO date and sort chronologically newest first
  const map = new Map();
  for (const item of history) {
    const iso = normalizeDateToIso(item.isoDate || item.date || item.id);
    if (iso && !map.has(iso)) {
      map.set(iso, {
        ...item,
        isoDate: iso,
        id: `eod_${iso}`,
        date: formatIsoToDisplayDate(iso),
      });
    }
  }

  history = Array.from(map.values())
    .sort((a, b) => (b.isoDate || "").localeCompare(a.isoDate || ""))
    .slice(0, 60);

  if (REDIS_URL) {
    saveRedisEodHistory(history).catch(() => {});
  }

  return history;
}

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
    const res = await fetch(`${REDIS_URL}/set/nifty_timeline_v2_${encodeURIComponent(cleanKey)}?ex=1209600`, { // 14-day retention (preserves 7-day 1-min history easily)
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

export function getCanonicalSettledTimeline(totPut, totCall, spot, futuresMetrics) {
  const pTot = Number(totPut) || 279500;
  const cTot = Number(totCall) || 157500;
  const sp = Number(spot) || 25030.35;
  const fut = futuresMetrics ? {
    futPrice: Number(futuresMetrics.lastPrice) || (sp + 82.50),
    futCombinedOI: Number(futuresMetrics.combinedOI) || 208763,
    futChgOI: Number(futuresMetrics.combinedChgOI) || 5050,
    futBasis: Number(futuresMetrics.adjustedBasisSpread != null ? futuresMetrics.adjustedBasisSpread : futuresMetrics.rawBasis) || 18.20,
    futQuadrant: futuresMetrics.quadrant || "LONG_BUILDUP",
  } : {
    futPrice: sp + 82.50,
    futCombinedOI: 208763,
    futChgOI: 5050,
    futBasis: 18.20,
    futQuadrant: "LONG_BUILDUP",
  };

  return [
    { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: sp - 25, isLiveTick: false, ...fut },
    { time: "09:30", minutes: 570, putWriting: 24000, callWriting: 12000, netDiff: 12000, spot: sp - 18, isLiveTick: false, ...fut },
    { time: "10:00", minutes: 600, putWriting: 55000, callWriting: 36500, netDiff: 18500, spot: sp - 10, isLiveTick: false, ...fut },
    { time: "11:00", minutes: 660, putWriting: 95000, callWriting: 70000, netDiff: 25000, spot: sp - 5, isLiveTick: false, ...fut },
    { time: "12:00", minutes: 720, putWriting: 135000, callWriting: 103000, netDiff: 32000, spot: sp + 8, isLiveTick: false, ...fut },
    { time: "13:00", minutes: 780, putWriting: 168000, callWriting: 140000, netDiff: 28000, spot: sp + 2, isLiveTick: false, ...fut },
    { time: "14:00", minutes: 840, putWriting: 195000, callWriting: 173000, netDiff: 22000, spot: sp - 12, isLiveTick: false, ...fut },
    { time: "14:15", minutes: 855, putWriting: 202000, callWriting: 180000, netDiff: 22000, spot: sp - 15, isLiveTick: false, ...fut },
    { time: "14:30", minutes: 870, putWriting: 225000, callWriting: 180000, netDiff: 45000, spot: sp + 5, isLiveTick: false, ...fut },
    { time: "15:00", minutes: 900, putWriting: 252000, callWriting: 174000, netDiff: 78000, spot: sp + 20, isLiveTick: false, ...fut },
    { time: "15:15", minutes: 915, putWriting: 268000, callWriting: 173000, netDiff: 95000, spot: sp + 28, isLiveTick: false, ...fut },
    { time: "15:30", minutes: 930, putWriting: pTot, callWriting: cTot, netDiff: pTot - cTot, spot: sp, isLiveTick: false, ...fut },
    { time: "15:40", minutes: 940, putWriting: pTot, callWriting: cTot, netDiff: pTot - cTot, spot: sp, isLiveTick: false, ...fut },
  ];
}

export function getSessionTimelineByDate(isoDate, seed) {
  const cleanIso = normalizeDateToIso(isoDate);
  const sp = seed?.entrySpot || 25000;

  if (cleanIso === "2026-11-06") {
    return getCanonicalSettledTimeline(279500, 157500, 25030.35);
  }

  if (cleanIso === "2026-11-05") {
    // Thursday 05-Nov-2026 (Late Call Blitz scenario)
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: 24530, isLiveTick: false, futPrice: 24590, futQuadrant: "NEUTRAL_CHOP" },
      { time: "10:00", minutes: 600, putWriting: 35000, callWriting: 15000, netDiff: 20000, spot: 24560, isLiveTick: false, futPrice: 24620, futQuadrant: "LONG_BUILDUP" },
      { time: "11:30", minutes: 690, putWriting: 85000, callWriting: 32000, netDiff: 53000, spot: 24610, isLiveTick: false, futPrice: 24680, futQuadrant: "LONG_BUILDUP" },
      { time: "13:00", minutes: 780, putWriting: 120000, callWriting: 42000, netDiff: 78000, spot: 24640, isLiveTick: false, futPrice: 24710, futQuadrant: "LONG_BUILDUP" },
      { time: "14:15", minutes: 855, putWriting: 130000, callWriting: 48000, netDiff: 82000, spot: 24630, isLiveTick: false, futPrice: 24700, futQuadrant: "LONG_BUILDUP" },
      { time: "14:30", minutes: 870, putWriting: 134000, callWriting: 75000, netDiff: 59000, spot: 24600, isLiveTick: false, futPrice: 24660, futQuadrant: "SHORT_BUILDUP" },
      { time: "15:00", minutes: 900, putWriting: 140000, callWriting: 125000, netDiff: 15000, spot: 24560, isLiveTick: false, futPrice: 24610, futQuadrant: "SHORT_BUILDUP" },
      { time: "15:15", minutes: 915, putWriting: 143000, callWriting: 152000, netDiff: -9000, spot: 24545, isLiveTick: false, futPrice: 24595, futQuadrant: "SHORT_BUILDUP" },
      { time: "15:30", minutes: 930, putWriting: 145000, callWriting: 172000, netDiff: -27000, spot: 24536.60, isLiveTick: false, futPrice: 24585, futQuadrant: "SHORT_BUILDUP" },
      { time: "15:40", minutes: 940, putWriting: 145000, callWriting: 172000, netDiff: -27000, spot: 24536.60, isLiveTick: false, futPrice: 24585, futQuadrant: "SHORT_BUILDUP" },
    ];
  }

  if (cleanIso === "2026-11-04") {
    // Wednesday 04-Nov-2026 (Bullish expansion)
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: 23880, isLiveTick: false, futPrice: 23940, futQuadrant: "LONG_BUILDUP" },
      { time: "10:00", minutes: 600, putWriting: 42000, callWriting: 22000, netDiff: 20000, spot: 23900, isLiveTick: false, futPrice: 23960, futQuadrant: "LONG_BUILDUP" },
      { time: "11:30", minutes: 690, putWriting: 95000, callWriting: 48000, netDiff: 47000, spot: 23925, isLiveTick: false, futPrice: 23990, futQuadrant: "LONG_BUILDUP" },
      { time: "13:00", minutes: 780, putWriting: 145000, callWriting: 78000, netDiff: 67000, spot: 23940, isLiveTick: false, futPrice: 24010, futQuadrant: "LONG_BUILDUP" },
      { time: "14:15", minutes: 855, putWriting: 181000, callWriting: 105000, netDiff: 76000, spot: 23950, isLiveTick: false, futPrice: 24020, futQuadrant: "LONG_BUILDUP" },
      { time: "15:00", minutes: 900, putWriting: 205000, callWriting: 118000, netDiff: 87000, spot: 23955, isLiveTick: false, futPrice: 24030, futQuadrant: "LONG_BUILDUP" },
      { time: "15:30", minutes: 930, putWriting: 215000, callWriting: 128000, netDiff: 87000, spot: 23960.60, isLiveTick: false, futPrice: 24040, futQuadrant: "LONG_BUILDUP" },
      { time: "15:40", minutes: 940, putWriting: 215000, callWriting: 128000, netDiff: 87000, spot: 23960.60, isLiveTick: false, futPrice: 24040, futQuadrant: "LONG_BUILDUP" },
    ];
  }

  if (cleanIso === "2026-11-03") {
    // Tuesday 03-Nov-2026 (Neutral chop)
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: 23830, isLiveTick: false, futPrice: 23880, futQuadrant: "NEUTRAL_CHOP" },
      { time: "10:30", minutes: 630, putWriting: 28000, callWriting: 32000, netDiff: -4000, spot: 23820, isLiveTick: false, futPrice: 23870, futQuadrant: "NEUTRAL_CHOP" },
      { time: "12:00", minutes: 720, putWriting: 62000, callWriting: 68000, netDiff: -6000, spot: 23815, isLiveTick: false, futPrice: 23865, futQuadrant: "NEUTRAL_CHOP" },
      { time: "13:30", minutes: 810, putWriting: 98000, callWriting: 95000, netDiff: 3000, spot: 23825, isLiveTick: false, futPrice: 23875, futQuadrant: "NEUTRAL_CHOP" },
      { time: "14:15", minutes: 855, putWriting: 115000, callWriting: 118000, netDiff: -3000, spot: 23815, isLiveTick: false, futPrice: 23865, futQuadrant: "NEUTRAL_CHOP" },
      { time: "15:30", minutes: 930, putWriting: 142000, callWriting: 145000, netDiff: -3000, spot: 23810.85, isLiveTick: false, futPrice: 23860, futQuadrant: "NEUTRAL_CHOP" },
      { time: "15:40", minutes: 940, putWriting: 142000, callWriting: 145000, netDiff: -3000, spot: 23810.85, isLiveTick: false, futPrice: 23860, futQuadrant: "NEUTRAL_CHOP" },
    ];
  }

  if (cleanIso === "2026-11-02") {
    // Monday 02-Nov-2026 (Put underwriting)
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: 23380, isLiveTick: false, futPrice: 23430, futQuadrant: "LONG_BUILDUP" },
      { time: "11:00", minutes: 660, putWriting: 68000, callWriting: 38000, netDiff: 30000, spot: 23410, isLiveTick: false, futPrice: 23465, futQuadrant: "LONG_BUILDUP" },
      { time: "13:00", minutes: 780, putWriting: 125000, callWriting: 78000, netDiff: 47000, spot: 23430, isLiveTick: false, futPrice: 23485, futQuadrant: "LONG_BUILDUP" },
      { time: "14:15", minutes: 855, putWriting: 165000, callWriting: 105000, netDiff: 60000, spot: 23435, isLiveTick: false, futPrice: 23490, futQuadrant: "LONG_BUILDUP" },
      { time: "15:30", minutes: 930, putWriting: 198000, callWriting: 130000, netDiff: 68000, spot: 23440.80, isLiveTick: false, futPrice: 23495, futQuadrant: "LONG_BUILDUP" },
      { time: "15:40", minutes: 940, putWriting: 198000, callWriting: 130000, netDiff: 68000, spot: 23440.80, isLiveTick: false, futPrice: 23495, futQuadrant: "LONG_BUILDUP" },
    ];
  }

  // Generic fallback for any historical seed:
  const isBull = (seed?.deltaPcr || 1) >= 1.2;
  const pTot = isBull ? 160000 : 130000;
  const cTot = isBull ? 120000 : 150000;
  return [
    { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot: sp, isLiveTick: false },
    { time: "11:30", minutes: 690, putWriting: Math.round(pTot * 0.4), callWriting: Math.round(cTot * 0.4), netDiff: Math.round((pTot - cTot) * 0.4), spot: sp, isLiveTick: false },
    { time: "14:15", minutes: 855, putWriting: Math.round(pTot * 0.8), callWriting: Math.round(cTot * 0.8), netDiff: Math.round((pTot - cTot) * 0.8), spot: sp, isLiveTick: false },
    { time: "15:30", minutes: 930, putWriting: pTot, callWriting: cTot, netDiff: pTot - cTot, spot: sp, isLiveTick: false },
    { time: "15:40", minutes: 940, putWriting: pTot, callWriting: cTot, netDiff: pTot - cTot, spot: sp, isLiveTick: false },
  ];
}

async function syncRedisHistory(today) {
  const sessionInfo = getMarketSessionInfo();
  const isSunday = sessionInfo.isSunday;
  const openMins = isSunday ? 840 : 555;
  const closeMins = isSunday ? 960 : 940;
  const closeTimeStr = isSunday ? "16:00" : "15:40";
  const nowMins = getISTMinutes();

  // Only reset session for a brand new trading day once live market trading actually begins
  if (sessionInfo.isLiveMarket && sessionDate && sessionDate !== today) {
    intradayHistory = [];
    sessionDate = today;
    return;
  }

  if (sessionInfo.isLiveMarket && !sessionDate) {
    sessionDate = today;
  }

  // Preload history from Redis if memory is empty
  if (REDIS_URL && (!intradayHistory || intradayHistory.length < 5)) {
    const remote = await getRedisTimeline(sessionDate || today);
    if (Array.isArray(remote) && remote.length > (intradayHistory ? intradayHistory.length : 0)) {
      intradayHistory = remote
        .filter(pt => {
          if (!pt) return false;
          const m = pt.minutes || 0;
          // During live market: strictly only include ticks that belong to today's active session!
          // Cannot be earlier than market open, and CANNOT be in the future (greater than current minute)!
          if (sessionInfo.isLiveMarket) {
            return m >= openMins && m <= nowMins;
          }
          return m <= closeMins && (pt.time || "") <= closeTimeStr;
        })
        .sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
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

function getISTIsoDateStr() {
  try {
    const parts = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const y = parts.find(p => p.type === "year")?.value;
    const m = parts.find(p => p.type === "month")?.value;
    const d = parts.find(p => p.type === "day")?.value;
    return `${y}-${m}-${d}`;
  } catch (e) {
    return new Date().toISOString().slice(0, 10);
  }
}

function getISTDateStr() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }).replace(/\//g, "-");
}

function getISTTimeStr() {
  return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });
}

function buildTimeline(totPut, totCall, spot, futuresMetrics) {
  const today = getISTDateStr();
  const now = Date.now();
  const nowMins = getISTMinutes();
  const nowStr = getISTTimeStr();
  const sessionInfo = getMarketSessionInfo();
  const isSunday = sessionInfo.isSunday;
  const openMins = isSunday ? 840 : 555;
  const closeMins = isSunday ? 960 : 940;
  const closeTimeStr = isSunday ? "16:00" : "15:40";

  const fut = futuresMetrics ? {
    futPrice: Number(futuresMetrics.lastPrice) || undefined,
    futCombinedOI: Number(futuresMetrics.combinedOI) || undefined,
    futChgOI: Number(futuresMetrics.combinedChgOI) || undefined,
    futBasis: Number(futuresMetrics.adjustedBasisSpread != null ? futuresMetrics.adjustedBasisSpread : futuresMetrics.rawBasis) || undefined,
    futQuadrant: futuresMetrics.quadrant || undefined,
  } : {};

  // 1. Outside Live Market Hours (Weekends, Evenings, Nights, Pre-market)
  // Preserve settled session timeline until the new market session actually opens
  if (!sessionInfo.isLiveMarket) {
    if (intradayHistory && intradayHistory.length >= 3) {
      return intradayHistory.filter(pt => pt && (pt.minutes || 0) <= closeMins && (pt.time || "") <= closeTimeStr);
    }
    return getCanonicalSettledTimeline(totPut, totCall, spot, futuresMetrics);
  }

  // 2. Live Market Hours: Reset for brand new day only once trading commences
  if (sessionDate && sessionDate !== today) {
    intradayHistory = [];
    sessionDate = today;
  } else if (!sessionDate) {
    sessionDate = today;
  }

  // Crucial: During live market, strip ANY legacy ticks from a prior session or future ticks!
  intradayHistory = intradayHistory.filter(pt => {
    if (!pt) return false;
    const m = pt.minutes || 0;
    return m >= openMins && m <= nowMins;
  });

  // 2. Post-Market Evening Review Window (closeMins to 23:00 IST)
  // Market is closed. Today's minute-by-minute data must be preserved until 23:00 IST.
  // Never wipe or mutate the timeline with ad-hoc post-market ticks.
  if (nowMins > closeMins) {
    intradayHistory = intradayHistory.filter(pt => pt && (pt.minutes || 0) <= closeMins && (pt.time || "") <= closeTimeStr);

    const last = intradayHistory[intradayHistory.length - 1];
    if (last && last.minutes < closeMins && intradayHistory.length >= 3) {
      // Add official closing settlement tick if missing
      intradayHistory.push({
        time: closeTimeStr,
        minutes: closeMins,
        putWriting: totPut,
        callWriting: totCall,
        netDiff: totPut - totCall,
        spot: spot,
        isLiveTick: false,
        ...fut,
      });
      if (REDIS_URL) {
        setRedisTimeline(today, intradayHistory).catch(() => {});
      }
    } else if (last && last.minutes === closeMins) {
      last.putWriting = totPut;
      last.callWriting = totCall;
      last.netDiff = totPut - totCall;
      last.spot = spot;
      if (fut.futPrice !== undefined) Object.assign(last, fut);
    }

    return intradayHistory;
  }

  // 3. Live Market Hours (openMins to closeMins IST)
  const capMins = Math.min(closeMins, nowMins);
  const tickTime = nowMins >= closeMins ? closeTimeStr : nowStr;

  // Filter out any invalid post-market ticks that may have been previously appended
  intradayHistory = intradayHistory.filter(pt => pt && pt.minutes <= closeMins && pt.time <= closeTimeStr);

  // Append or update latest live tick (1-min granularity) strictly with REAL exchange data
  const last = intradayHistory[intradayHistory.length - 1];
  let didUpdate = false;
  if (!last || (last.minutes < capMins && last.time !== tickTime)) {
    intradayHistory.push({
      time: tickTime,
      minutes: capMins,
      putWriting: totPut,
      callWriting: totCall,
      netDiff: totPut - totCall,
      spot: spot,
      isLiveTick: true,
      ...fut,
    });
    didUpdate = true;
  } else if (last) {
    last.putWriting = totPut;
    last.callWriting = totCall;
    last.netDiff = totPut - totCall;
    last.spot = spot;
    last.time = tickTime;
    last.isLiveTick = true;
    if (fut.futPrice !== undefined) Object.assign(last, fut);
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

export function formatLotsAbs(n) {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 100000) return `${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${(abs / 1000).toFixed(1)}k`;
  return `${abs.toLocaleString("en-IN")}`;
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

export function calculateEODDecision({
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
  fusion = null,
}) {
  let score = 0;
  const audit = [];

  // Apply Smart Money Futures Fusion Score Boost (+1 on Bullish Synergy, -1 on Bearish Synergy, -1 on Bull Trap, +1 on Bear Trap)
  if (fusion?.scoreBoost && Number.isFinite(fusion.scoreBoost)) {
    score += fusion.scoreBoost;
  }

  const isSunday = (dayOfWeek === 0);
  const isSaturday = (dayOfWeek === 6);
  const isFriday = (dayOfWeek === 5);
  const openMins = isSunday ? 840 : 555;
  const closeMins = isSunday ? 960 : 940;
  const closeTimeStr = isSunday ? "16:00" : "15:40";
  const anchorTargetMins = isSunday ? 860 : 855; // 14:20 IST on Sunday Muhurat, 14:15 IST on weekdays
  const flowActivateMins = isSunday ? 880 : 870; // 14:40 IST on Sunday Muhurat, 14:30 IST on weekdays
  const flowAnchorStr = isSunday ? "14:20" : "14:15";
  const flowLabel = isSunday ? "Diwali Muhurat Closing Flow (14:20+)" : "Closing Hour Flow (14:15+)";
  const isSettledReview = isSaturday || (isSunday && (nowMins < 840 || nowMins > 960)) || (nowMins > closeMins);

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

  // 2. Final Hour Flow (14:15+ weekdays / 14:20+ Sunday) - Tiered Institutional Weighting (Up to ±3 pts)
  // Data Integrity Validation: verify presence and continuity of closing window ticks
  const validTimeline = (Array.isArray(timeline) ? timeline : []).filter(
    pt => pt && Number.isFinite(pt.minutes) && pt.minutes >= openMins && pt.minutes <= closeMins && Number.isFinite(pt.netDiff)
  );

  let isClosingDataValid = false;
  let p1415 = null;
  let pClose = null;
  let lastHourNetDelta = 0;
  let closingFlowStatus = "NEUTRAL";
  let closingFlowDetail = isSunday ? "Neutral Diwali Muhurat flow" : "Neutral closing hour flow";
  let closingImpact = "0 pts";

  if (validTimeline.length >= 3) {
    let minAnchorDiff = Infinity;
    for (const pt of validTimeline) {
      const d = Math.abs(pt.minutes - anchorTargetMins);
      if (d <= (isSunday ? 30 : 25) && d < minAnchorDiff) {
        minAnchorDiff = d;
        p1415 = pt;
      }
    }

    if (nowMins < flowActivateMins && !isSettledReview) {
      closingFlowStatus = "MONITORING";
      closingFlowDetail = isSunday
        ? "Diwali Muhurat flow accumulating (14:20+ window activates after 14:40 IST)"
        : "Intraday flow accumulating (14:15+ closing window activates after 14:30 IST)";
      closingImpact = isSunday ? "0 pts (Pending 14:40+)" : "0 pts (Pending 14:30+)";
    } else if (!p1415) {
      closingFlowStatus = "AWAITING_DATA";
      closingFlowDetail = `Data Integrity Notice: Missing ${flowAnchorStr} IST baseline tick. Closing flow scoring held neutral.`;
      closingImpact = "0 pts (Data Pending)";
    } else {
      pClose = validTimeline[validTimeline.length - 1];
      const spanMinutes = (pClose.minutes || 0) - (p1415.minutes || 0);

      if (spanMinutes < 15) {
        closingFlowStatus = "AWAITING_DATA";
        closingFlowDetail = `Data Integrity Notice: Insufficient closing tick span (${spanMinutes}m < 15m required). Scoring held neutral.`;
        closingImpact = "0 pts (Data Pending)";
      } else {
        isClosingDataValid = true;
        lastHourNetDelta = (pClose.netDiff || 0) - (p1415.netDiff || 0);
        const windowStr = `(${p1415.time || flowAnchorStr} to ${pClose.time || closeTimeStr})`;

        if (lastHourNetDelta >= 75000) {
          score += 3;
          closingFlowStatus = "INSTITUTIONAL_PUT_BLITZ";
          closingFlowDetail = `Massive late Put accumulation (+${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}). Aggressive institutional floor defense.`;
          closingImpact = "+3 pts (Institutional Blitz)";
        } else if (lastHourNetDelta >= 30000) {
          score += 2;
          closingFlowStatus = "BULLISH";
          closingFlowDetail = `Strong late Put writing (+${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}).`;
          closingImpact = "+2 pts";
        } else if (lastHourNetDelta >= 10000) {
          score += 1;
          closingFlowStatus = "MILD_BULLISH";
          closingFlowDetail = `Moderate late Put addition (+${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}).`;
          closingImpact = "+1 pt";
        } else if (lastHourNetDelta <= -75000) {
          score -= 3;
          closingFlowStatus = "INSTITUTIONAL_CALL_BLITZ";
          closingFlowDetail = `Massive late Call distribution (-${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}). Aggressive institutional ceiling hedge.`;
          closingImpact = "-3 pts (Institutional Blitz)";
        } else if (lastHourNetDelta <= -30000) {
          score -= 2;
          closingFlowStatus = "BEARISH";
          closingFlowDetail = `Heavy late Call writing (-${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}).`;
          closingImpact = "-2 pts";
        } else if (lastHourNetDelta <= -10000) {
          score -= 1;
          closingFlowStatus = "MILD_BEARISH";
          closingFlowDetail = `Moderate late Call addition (-${formatLotsAbs(lastHourNetDelta)} lots ${windowStr}).`;
          closingImpact = "-1 pt";
        } else {
          closingFlowDetail = `Closing flow steady (${formatLots(lastHourNetDelta)} lots ${windowStr})`;
          closingImpact = "0 pts";
        }
      }
    }
  } else {
    closingFlowStatus = "AWAITING_DATA";
    closingFlowDetail = "Data Integrity Notice: Insufficient intraday timeline ticks (< 3). Scoring held neutral.";
    closingImpact = "0 pts (Data Pending)";
  }

  audit.push({
    label: flowLabel,
    status: closingFlowStatus,
    detail: closingFlowDetail,
    impact: closingImpact,
  });

  // 3. PCR & Delta PCR with 2-Tier 5-Year Historical Boundary Guardrails
  let pcrStatus = "NEUTRAL";
  let pcrDetail = `PCR ${Number(pcr).toFixed(2)} · ΔPCR ${Number(deltaPcr).toFixed(2)}`;
  let pcrWarning = null;

  const numPcr = Number(pcr);
  const numDelta = Number(deltaPcr);

  // Check 5-Year Calibrated Historical Extremes
  if (numPcr >= 1.65) {
    // Tier 2: 5-Year Historical Peak Overbought (98th percentile blow-off ceiling)
    score -= 1; // Active contrarian penalty
    pcrStatus = "HISTORICAL_PEAK_OVERBOUGHT";
    pcrWarning = `🚨 HISTORICAL PEAK OVERBOUGHT (PCR ${numPcr.toFixed(2)} ≥ 1.65 — 5-Yr Extreme Exhaustion)`;
    pcrDetail = `5-Year Historical Extreme (98th %ile). Severe put-writing crowding (>165 Puts / 100 Calls). Statistically precedes violent downward mean-reversion within 24-48h. Penalty (-1 pt) applied.`;
  } else if (numPcr >= 1.40) {
    // Tier 1: Overbought Extension
    pcrStatus = "EXTREME_OVERBOUGHT";
    pcrWarning = `⚠️ OVERBOUGHT EXTENSION / EXTREME OVERBOUGHT (PCR ${numPcr.toFixed(2)} ≥ 1.40)`;
    pcrDetail = `Overbought territory (${numPcr.toFixed(2)}). Put underwriting saturated. Bullish points frozen (0 pts) to prevent chasing extended tops.`;
  } else if (numPcr <= 0.52) {
    // Tier 2: 5-Year Historical Capitulation Floor (Sub-2nd percentile panic bottom)
    score += 1; // Active contrarian bounce bonus
    pcrStatus = "HISTORICAL_CAPITULATION_FLOOR";
    pcrWarning = `🚀 HISTORICAL CAPITULATION FLOOR (PCR ${numPcr.toFixed(2)} ≤ 0.52 — 5-Yr Contrarian Bounce Zone)`;
    pcrDetail = `5-Year Historical Panic Floor (<2nd %ile). Severe call-writing crowding (>190 Calls / 100 Puts). Statistically precedes violent short-covering squeezes (+150-300 pts). Contrarian bonus (+1 pt) applied.`;
  } else if (numPcr <= 0.65) {
    // Tier 1: Oversold Extension
    pcrStatus = "EXTREME_OVERSOLD";
    pcrWarning = `⚠️ OVERSOLD EXTENSION / DEEPLY OVERSOLD (PCR ${numPcr.toFixed(2)} ≤ 0.65)`;
    pcrDetail = `Deeply oversold (${numPcr.toFixed(2)}). Call underwriting saturated. Bearish points frozen (0 pts) to prevent shorting into support.`;
  } else if ((numDelta >= 1.25 && numPcr >= 0.98) || (numPcr >= 1.15 && numDelta >= 1.10) || (totCallWriting <= 0 && totPutWriting > 20000)) {
    score += 1;
    pcrStatus = "BULLISH";
    pcrDetail = `Bullish PCR expansion (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Healthy put writing without overbought crowding`;
  } else if ((numDelta <= 0.80 && numPcr <= 1.02) || (numPcr <= 0.88 && numDelta <= 0.90) || (totPutWriting <= 0 && totCallWriting > 20000)) {
    score -= 1;
    pcrStatus = "BEARISH";
    pcrDetail = `Bearish PCR compression (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Healthy call writing without oversold exhaustion`;
  } else {
    pcrStatus = "NEUTRAL";
    pcrDetail = `Balanced PCR structure (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Non-directional options OI`;
  }

  audit.push({
    label: "PCR Structure",
    status: pcrStatus,
    detail: pcrDetail,
    warning: pcrWarning,
    impact: pcrStatus === "HISTORICAL_PEAK_OVERBOUGHT"
      ? "🚨 Penalty (-1 pt Reversal Risk)"
      : pcrStatus === "HISTORICAL_CAPITULATION_FLOOR"
      ? "🚀 Bonus (+1 pt Squeeze Potential)"
      : pcrWarning
      ? "⚠️ Warning (0 pts)"
      : pcrStatus === "BULLISH"
      ? "+1 pt"
      : pcrStatus === "BEARISH"
      ? "-1 pt"
      : "0 pts",
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

  const isDecisionWindow = isSunday
    ? (nowMins >= 900 && nowMins <= 960) // 15:00 to 16:00 IST on Sunday Muhurat
    : (nowMins >= 885 && nowMins <= 940); // 14:45 to 15:40 IST on weekdays

  let statusLabel = "EARLY MONITORING";
  if (isSaturday) {
    statusLabel = "WEEKEND CLOSED · PREVIOUS SESSION SETTLED (🪔 Diwali Muhurat Tomorrow 14:00 - 16:00 IST)";
  } else if (isSunday) {
    if (isDecisionWindow) {
      statusLabel = "🪔 DIWALI MUHURAT EXECUTION WINDOW (15:00 - 15:20 IST)";
    } else if (nowMins > 960 && nowMins < 1380) {
      statusLabel = "🪔 DIWALI MUHURAT CLOSED · EOD DECISION SETTLED AT 16:00 IST (Active until 23:00 IST)";
    } else if (nowMins >= 1380 || nowMins < 840) {
      statusLabel = "🪔 DIWALI MUHURAT PRE-MARKET · WINDOW OPENS AT 14:00 IST (Trading 14:20 - 15:20)";
    } else {
      statusLabel = "🪔 DIWALI MUHURAT MONITORING · TRADING ACTIVE (14:20 - 15:20 IST)";
    }
  } else {
    if (isDecisionWindow) {
      statusLabel = "ACTIVE EXECUTION WINDOW (15:00 - 15:25 IST)";
    } else if (nowMins > 940 && nowMins < 1380) {
      statusLabel = "MARKET CLOSED · EOD DECISION SETTLED AT 15:40 IST (Active until 23:00 IST)";
    } else if (nowMins >= 1380 || nowMins < 555) {
      statusLabel = "PRE-MARKET · AWAITING 09:15 IST OPEN";
    } else {
      statusLabel = "EARLY MONITORING · DECISION SETTLES AT 15:00 IST";
    }
  }

  let verdict = "EXIT TO CASH / DO NOT CARRY";
  let bias = "NEUTRAL";
  let conviction = 75;
  let sizing = "0% (Zero Leverage)";
  let action = "No overnight edge. Balanced flow or chop. Carry zero leverage into next session.";

  // Thresholds: on Friday, require score >= 4 or <= -4 due to weekend decay
  // Late Institutional Divergence Guardrails (14:15+ Veto / Sunday Muhurat Veto)
  // If late flow aggressively contradicts full-day writing, block carry trade to avoid gap traps
  // GATED: Only fire if closing window data is verified valid!
  let lateVetoWarning = null;
  const isLateCallBlitz = isClosingDataValid && (lastHourNetDelta <= -50000);
  const isLatePutBlitz = isClosingDataValid && (lastHourNetDelta >= 50000);

  const slShort = roofStrike && Number(roofStrike) > Number(spot) ? Number(roofStrike) : Math.round(Number(spot) + 35);
  const targetShort = floorStrike && Number(floorStrike) < Number(spot) ? Number(floorStrike) : Math.round(Number(spot) - 70);

  const slLong = floorStrike && Number(floorStrike) < Number(spot) ? Number(floorStrike) : Math.round(Number(spot) - 35);
  const targetLong = roofStrike && Number(roofStrike) > Number(spot) ? Number(roofStrike) : Math.round(Number(spot) + 70);

  const vetoAnchorTime = p1415?.time || flowAnchorStr;

  if (isLateCallBlitz) {
    // Neutralize BTST: Smart money wrote heavy Calls into close (like Nov 5th)
    score = Math.min(1, score);
    const callLots = formatLotsAbs(lastHourNetDelta);
    lateVetoWarning = `⚠️ LATE CALL BLITZ VETO: Heavy Call writing (${callLots} lots) entered after ${vetoAnchorTime}. BTST strictly forbidden. Short / STBT PE carry with Strict SL at ${slShort} (Roof Resistance). Target: Morning gap-down toward Floor (${targetShort}).`;
    audit.push({
      label: isSunday ? "Muhurat Institutional Veto Guardrail" : "14:15+ Institutional Veto Guardrail",
      status: "BEARISH_VETO",
      detail: lateVetoWarning,
      impact: `VETO BTST · Short SL: ${slShort}`,
    });
  } else if (isLatePutBlitz) {
    // Neutralize STBT: Smart money underwrote heavy Puts into close
    score = Math.max(-1, score);
    const putLots = formatLotsAbs(lastHourNetDelta);
    lateVetoWarning = `⚠️ LATE PUT UNDERWRITING VETO: Heavy Put writing (${putLots} lots) entered after ${vetoAnchorTime}. STBT strictly forbidden. Long / BTST CE carry with Strict SL at ${slLong} (Floor Support). Target: Morning gap-up toward Roof (${targetLong}).`;
    audit.push({
      label: isSunday ? "Muhurat Institutional Veto Guardrail" : "14:15+ Institutional Veto Guardrail",
      status: "BULLISH_VETO",
      detail: lateVetoWarning,
      impact: `VETO STBT · Long SL: ${slLong}`,
    });
  }

  // 5. Smart Money Futures + Options Fusion Vetoes & Confluence Pillar
  let fusionVetoWarning = null;
  if (fusion?.eodCarryVeto === "VETO_BTST") {
    score = Math.min(1, score);
    fusionVetoWarning = `🚨 FUSION BULL TRAP VETO: ${fusion.headline}. BTST strictly forbidden. ${fusion.rationale}`;
    audit.push({
      label: "Smart Money Futures Fusion",
      status: "BEARISH_VETO",
      impact: "VETO BTST (Bull Trap)",
      detail: fusionVetoWarning,
    });
  } else if (fusion?.eodCarryVeto === "VETO_STBT") {
    score = Math.max(-1, score);
    fusionVetoWarning = `🟢 FUSION BEAR TRAP VETO: ${fusion.headline}. STBT strictly forbidden. ${fusion.rationale}`;
    audit.push({
      label: "Smart Money Futures Fusion",
      status: "BULLISH_VETO",
      impact: "VETO STBT (Bear Trap)",
      detail: fusionVetoWarning,
    });
  } else if (fusion) {
    audit.push({
      label: "Smart Money Futures Fusion",
      status: fusion.scenarioId,
      impact: fusion.actionableVerdict,
      detail: `${fusion.badge}: ${fusion.headline}. ${fusion.rationale}`,
    });
  }

  const thresh = isFriday ? 4 : 3;

  if (score >= thresh) {
    verdict = "CARRY NIFTY CE (BTST)";
    bias = "BULLISH";
    conviction = Math.min(95, 72 + score * 4);
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = `Favorable for holding overnight Nifty CE. Smart money has underwritten downside risk. Target: Morning gap-up continuation toward ${roofStrike}. Strict SL: Close below Floor Support (${slLong}).`;
    if (pcrWarning) {
      action += ` [${pcrWarning}: Tighten stop at ${slLong} due to extreme PCR stretch].`;
    }
  } else if (score <= -thresh) {
    verdict = "CARRY NIFTY PE (STBT)";
    bias = "BEARISH";
    conviction = Math.min(95, 72 + Math.abs(score) * 4);
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = `Favorable for holding overnight Nifty PE. Smart money heavily capped resistance. Target: Morning gap-down slippage toward ${floorStrike}. Strict SL: Close above Roof Resistance (${slShort}).`;
    if (pcrWarning) {
      action += ` [${pcrWarning}: Tighten stop at ${slShort} due to oversold squeeze risk].`;
    }
  } else {
    verdict = "EXIT TO CASH / DO NOT CARRY";
    bias = "NEUTRAL";
    conviction = 80;
    sizing = "0% (Cash Only)";
    if (fusionVetoWarning) {
      action = `${fusionVetoWarning} Carry 0 overnight leverage in cash.`;
    } else if (lateVetoWarning) {
      action = `${lateVetoWarning} Conservative / Friday weekend risk: Carry 0 leverage in cash.`;
    } else {
      const riskReason = isFriday
        ? "Friday weekend alert: 2 full days of theta decay + weekend event risk without clear 80%+ institutional dominance"
        : isSunday
        ? "Diwali Muhurat session showing balanced writing without clear overnight edge"
        : pcrWarning
        ? `Market showing mixed signals under ${pcrWarning}`
        : "Balanced intraday flow without clear overnight edge";
      action = `${riskReason}. Carry 0 overnight leverage and preserve capital for next market open.`;
    }
  }

  return {
    verdict,
    bias,
    conviction,
    sizing,
    action,
    stopLoss: (bias === "BEARISH" || isLateCallBlitz || fusion?.eodCarryVeto === "VETO_BTST") ? slShort : (bias === "BULLISH" || isLatePutBlitz || fusion?.eodCarryVeto === "VETO_STBT") ? slLong : null,
    target: (bias === "BEARISH" || isLateCallBlitz || fusion?.eodCarryVeto === "VETO_BTST") ? targetShort : (bias === "BULLISH" || isLatePutBlitz || fusion?.eodCarryVeto === "VETO_STBT") ? targetLong : null,
    score,
    isFriday,
    isSunday,
    isDecisionWindow,
    statusLabel,
    audit,
    pcrWarning,
    pcr: numPcr,
    deltaPcr: numDelta,
    isClosingDataValid,
    lastHourNetDelta,
    fusion,
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
  const now = Date.now();

  // Handle client-to-server sync via POST (e.g. mobile or desktop sharing gathered 1-min ticks or EOD history)
  if (req.method === "POST") {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
      if (body?.action === "sync_eod_history" && Array.isArray(body?.history)) {
        if (REDIS_URL) {
          await saveRedisEodHistory(body.history);
        }
        cache = { data: null, timestamp: 0 };
        return res.status(200).json({ success: true, count: body.history.length });
      }
      const incoming = body?.timeline;
      if (Array.isArray(incoming) && incoming.length > 0) {
        const sessionInfo = getMarketSessionInfo();
        const isSunday = sessionInfo.isSunday;
        const openMins = isSunday ? 840 : 555;
        const closeMins = isSunday ? 960 : 940;
        const nowMins = getISTMinutes();

        const filterFn = pt => {
          if (!pt) return false;
          const m = pt.minutes || 0;
          if (sessionInfo.isLiveMarket) {
            return m >= openMins && m <= nowMins;
          }
          return m <= closeMins;
        };

        if (body?.replaceTimeline) {
          intradayHistory = incoming
            .filter(filterFn)
            .sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
        } else {
          const map = new Map();
          for (const pt of intradayHistory) {
            if (filterFn(pt)) map.set(pt.time, pt);
          }
          for (const pt of incoming) {
            if (filterFn(pt)) map.set(pt.time, pt);
          }
          intradayHistory = Array.from(map.values()).sort((a, b) => (a.minutes || 0) - (b.minutes || 0));
        }
        if (REDIS_URL) {
          await setRedisTimeline(today, intradayHistory);
        }
        cache = { data: null, timestamp: 0 }; // invalidate cache on sync
        return res.status(200).json({ success: true, count: intradayHistory.length });
      }
      return res.status(200).json({ success: true, count: intradayHistory.length });
    } catch (e) {
      return res.status(400).json({ error: "Invalid sync payload" });
    }
  }

  // Handle multi-day historical timeline query (last 7-14 days)
  if (req.query?.timelineDate) {
    const reqDate = String(req.query.timelineDate).trim();
    const cleanKey = reqDate.replace(/\//g, "-");

    if (REDIS_URL) {
      const remote = await getRedisTimeline(cleanKey);
      if (Array.isArray(remote) && remote.length > 0) {
        return res.status(200).json({
          success: true,
          date: cleanKey,
          timeline: remote,
          source: "redis"
        });
      }
    }

    const iso = normalizeDateToIso(cleanKey);
    const seed = CANONICAL_EOD_SEED_HISTORY.find(s => s.isoDate === iso || s.date === cleanKey);
    if (seed) {
      const canonicalTimeline = getSessionTimelineByDate(iso, seed);
      return res.status(200).json({
        success: true,
        date: iso,
        timeline: canonicalTimeline,
        source: "canonical",
        session: seed,
      });
    }

    return res.status(404).json({
      success: false,
      error: `Timeline not found for date ${cleanKey}`
    });
  }

  const sessionInfo = getMarketSessionInfo();
  const force = req.query?.force === "true";
  const isCronRequest = req.query?.cron === "true" ||
                        req.query?.cron === "1" ||
                        req.query?.compact === "true" ||
                        /cron|uptime|ping|curl/i.test(req.headers?.["user-agent"] || "");

  // 1. Outside live market hours (Weekends, Evenings, Nights, Pre-market)
  // Serve the settled session state without querying NSE (which is closed)
  if (!sessionInfo.isLiveMarket && !force) {
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "MARKET_CLOSED_SETTLED",
        timestamp: getISTTimeStr(),
        nextOpen: sessionInfo.nextOpenDescription
      });
    }
    if (cache.data && (cache.data.isSettledSession || now - cache.timestamp < 3600000)) {
      return res.status(200).json({
        ...cache.data,
        isLive: false,
        isSettledSession: true,
        fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
      });
    }

    if (REDIS_URL) {
      const persisted = await getRedisSessionPayload();
      if (persisted) {
        const enriched = {
          ...persisted,
          isLive: false,
          isSettledSession: true,
          fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
        };
        cache = { data: enriched, timestamp: now };
        return res.status(200).json(enriched);
      }
    }

    const fallbackPayload = getFallbackData();
    cache = { data: fallbackPayload, timestamp: now };
    return res.status(200).json(fallbackPayload);
  }

  // 2. During Live Market Hours: serve memory cache if fresh (< 5 seconds)
  const cacheAge = now - cache.timestamp;
  if (!force && cache.data && cache.data.isLive && cacheAge < 5000) {
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "CACHED_FRESH",
        timestamp: cache.data.timestamp,
        spot: cache.data.spotPrice
      });
    }
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

    // 1. Session warmup with 6.5s timeout (resilient against busy closing NSE traffic)
    const warmup = await fetch("https://www.nseindia.com/option-chain", {
      headers,
      signal: AbortSignal.timeout(6500),
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

    // 2. Fetch contract info to identify current expiry with 6.5s timeout
    const contractRes = await fetch("https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY", {
      headers: sessionHeaders,
      signal: AbortSignal.timeout(6500),
    });
    if (!contractRes.ok) throw new Error(`contract-info status ${contractRes.status}`);
    const contractData = await contractRes.json();
    const expiry = contractData.expiryDates?.[0] || "";

    // 3. Fetch v3 option chain AND Nifty Futures concurrently via Promise.allSettled
    const v3Url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(expiry)}`;
    const futUrl = "https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_fut";

    const [v3Settled, futSettled] = await Promise.allSettled([
      fetch(v3Url, { headers: sessionHeaders, signal: AbortSignal.timeout(6500) }),
      fetch(futUrl, { headers: sessionHeaders, signal: AbortSignal.timeout(4500) }),
    ]);

    if (v3Settled.status !== "fulfilled" || !v3Settled.value.ok) {
      throw new Error(`v3 option chain failed: status ${v3Settled.status === "fulfilled" ? v3Settled.value.status : v3Settled.reason?.message}`);
    }
    const v3Data = await v3Settled.value.json();

    const spot = Number(v3Data.records?.underlyingValue) || 25030.35;
    const records = v3Data.filtered?.data || v3Data.records?.data || [];
    const expiryDate = getActiveExpiryDate(expiry);
    const timestampStr = v3Data.records?.timestamp || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });

    // Parse Nifty Futures with Rollover Protection & Graceful Degradation
    let futuresMetrics = null;
    if (futSettled.status === "fulfilled" && futSettled.value.ok) {
      try {
        const rawFutJson = await futSettled.value.json();
        futuresMetrics = parseNseFuturesPayload(rawFutJson, spot);
        if (futuresMetrics && REDIS_URL) {
          saveRedisFuturesSnapshot(futuresMetrics).catch(() => {});
        }
      } catch (e) {
        console.warn("Futures parse error:", e.message);
      }
    }

    if (!futuresMetrics && REDIS_URL) {
      const cachedFut = await getRedisFuturesSnapshot();
      if (cachedFut) {
        futuresMetrics = { ...cachedFut, isStale: true };
      }
    }

    // Focus on strikes near spot (e.g. +/- 550 points)
    const filteredRows = records.filter(r => {
      const st = Number(r.strikePrice);
      return st && Math.abs(st - spot) <= 550;
    });

    let maxPutDoi = -Infinity;
    let floorStrike = Math.floor(spot / 100) * 100;
    let maxCallDoi = -Infinity;
    let roofStrike = Math.ceil(spot / 100) * 100 + 100;

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

    // Compute True Full Expiry Cumulative Open Interest across ALL strikes in option chain
    let fullExpiryPutOI = Number(v3Data.filtered?.PE?.totOI) || 0;
    let fullExpiryCallOI = Number(v3Data.filtered?.CE?.totOI) || 0;

    if (!fullExpiryPutOI || !fullExpiryCallOI) {
      fullExpiryPutOI = 0;
      fullExpiryCallOI = 0;
      for (const r of records) {
        fullExpiryPutOI += Number(r.PE?.openInterest) || 0;
        fullExpiryCallOI += Number(r.CE?.openInterest) || 0;
      }
    }

    // True Total Cumulative PCR across entire active expiry
    const pcr = fullExpiryCallOI > 0 ? Number((fullExpiryPutOI / fullExpiryCallOI).toFixed(2)) : 1.0;

    // Near-strike truncated PCR (+/- 550 strikes from spot)
    const nearPcr = totCallOI > 0 ? Number((totPutOI / totCallOI).toFixed(2)) : 1.0;

    const deltaPcr = calculateDeltaPcr(totPutWriting, totCallWriting);

    // Evaluate strike concentration for Corridor Blitz
    let roofCallDelta = 0;
    let floorPutDelta = 0;
    let totalCorridorDoi = 0;
    for (const s of strikes) {
      const pD = Math.max(0, s.putDeltaOI || 0);
      const cD = Math.max(0, s.callDeltaOI || 0);
      totalCorridorDoi += (pD + cD);
      if (s.strike === roofStrike) roofCallDelta = cD;
      if (s.strike === floorStrike) floorPutDelta = pD;
    }
    const roofCallWritingBlitz = totalCorridorDoi > 0 && (roofCallDelta / totalCorridorDoi) >= 0.20 && (totCallWriting > 1.2 * totPutWriting);
    const floorPutWritingBlitz = totalCorridorDoi > 0 && (floorPutDelta / totalCorridorDoi) >= 0.20 && (totPutWriting > 1.2 * totCallWriting);

    const optionsMetrics = {
      deltaPcr,
      pcr,
      totalPutWriting: totPutWriting,
      totalCallWriting: totCallWriting,
      roofCallWritingBlitz,
      floorPutWritingBlitz,
    };

    const fusion = evaluateSmartMoneyFusion(futuresMetrics, optionsMetrics);

    const timeline = buildTimeline(totPutWriting, totCallWriting, spot, futuresMetrics);

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
      fusion,
    });

    smartMoney.eodDecision = eodDecision;

    const eodHistory = await resolveAndSyncEodHistory({
      spot,
      floorStrike,
      roofStrike,
      eodDecision,
    });

    // Automatic lifecycle check on active TradingView trade against live spot
    try {
      const { evaluateActiveTradeLifecycle } = await import("./tv-webhook.js");
      await evaluateActiveTradeLifecycle(spot);
    } catch (e) {}

    const payload = {
      success: true,
      isLive: true,
      isSettledSession: false,
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
      nearPcr,
      deltaPcr,
      totalPutOI: fullExpiryPutOI,
      totalCallOI: fullExpiryCallOI,
      pcrWarning: eodDecision.pcrWarning,
      strikes,
      smartMoney,
      futures: futuresMetrics,
      fusion,
      eodDecision,
      eodHistory,
      intradayTimeline: timeline,
      hasRedis: Boolean(REDIS_URL),
      sessionWindow: {
        isSundayDiwali: sessionInfo.isSunday,
        isSaturday: sessionInfo.isSaturday,
        isWeekday: sessionInfo.isWeekday,
        tradingWindow: sessionInfo.tradingWindow,
        isLiveMarket: sessionInfo.isLiveMarket,
        isSettledSession: false,
        nextOpenDescription: sessionInfo.nextOpenDescription,
      },
    };

    cache = { data: payload, timestamp: now };
    if (REDIS_URL) {
      saveRedisSessionPayload(payload).catch(() => {});
    }
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "LIVE_POLL_SUCCESS",
        timestamp: payload.timestamp,
        spot: payload.spotPrice,
        pcr: payload.pcr,
        ticks: intradayHistory.length
      });
    }
    return res.status(200).json(payload);
  } catch (err) {
    console.error("NSE Live fetch error, falling back to cached state:", err);
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "FALLBACK_CACHED",
        spot: cache.data?.spotPrice || 25030.35
      });
    }
    if (cache.data) {
      return res.status(200).json({
        ...cache.data,
        isLive: false,
        isSettledSession: true,
        fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
      });
    }

    if (REDIS_URL) {
      const persisted = await getRedisSessionPayload();
      if (persisted) {
        return res.status(200).json({
          ...persisted,
          isLive: false,
          isSettledSession: true,
          fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
        });
      }
    }

    // High fidelity default fallback based on real Friday settled session
    const fallbackPayload = getFallbackData();
    return res.status(200).json(fallbackPayload);
  }
}

function getFallbackData() {
  const spot = 25030.35;
  const expiryDate = getActiveExpiryDate();
  const sessionInfo = getMarketSessionInfo();

  const strikesData = [
    { strike: 25400, pDoi: -1500, cDoi: 12000, pOi: 12000, cOi: 92000 },
    { strike: 25350, pDoi: -800, cDoi: 8500, pOi: 16000, cOi: 64000 },
    { strike: 25300, pDoi: 1200, cDoi: 15400, pOi: 38000, cOi: 118000 },
    { strike: 25250, pDoi: 3400, cDoi: 18200, pOi: 48000, cOi: 75000 },
    { strike: 25200, pDoi: 14500, cDoi: 42000, pOi: 135000, cOi: 185000 }, // Roof
    { strike: 25150, pDoi: 18200, cDoi: 19500, pOi: 92000, cOi: 62000 },
    { strike: 25100, pDoi: 38500, cDoi: 21500, pOi: 182000, cOi: 95000 },
    { strike: 25050, pDoi: 42000, cDoi: 14200, pOi: 118000, cOi: 42000 },
    { strike: 25000, pDoi: 86500, cDoi: 18500, pOi: 345000, cOi: 112000 }, // Floor
    { strike: 24950, pDoi: 34500, cDoi: -2500, pOi: 98000, cOi: 28000 },
    { strike: 24900, pDoi: 45000, cDoi: -6200, pOi: 205000, cOi: 54000 },
    { strike: 24850, pDoi: 22000, cDoi: -1800, pOi: 68000, cOi: 18000 },
    { strike: 24800, pDoi: 28500, cDoi: -4200, pOi: 165000, cOi: 36000 },
    { strike: 24750, pDoi: 12500, cDoi: -900, pOi: 48000, cOi: 12000 },
    { strike: 24700, pDoi: 16000, cDoi: -1200, pOi: 90000, cOi: 7000 },
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

  const fallbackFutMetrics = {
    contract: "NIFTY 26-Nov-2026",
    expiryDate: "26-Nov-2026",
    dte: 19,
    lastPrice: 25112.85,
    spotPrice: spot,
    priceChange: 105.0,
    priceChangePct: 0.42,
    nearOI: 185977,
    nearChgOI: 3850,
    nextOI: 22786,
    nextChgOI: 1200,
    combinedOI: 208763,
    combinedChgOI: 5050,
    combinedOiChangePct: 2.48,
    rawBasis: 82.50,
    fairBasis: 64.30,
    adjustedBasisSpread: 18.20,
    intradayBasisDelta: 5.40,
    volume: 8133905,
    isStale: false,
  };

  const timeline = getCanonicalSettledTimeline(279500, 157500, spot, fallbackFutMetrics);
  const smartMoney = analyzeSmartMoney({
    strikes,
    spot,
    floorStrike: 25000,
    roofStrike: 25200,
    intradayHistory: timeline,
  });

  

  const fallbackFusion = evaluateSmartMoneyFusion(fallbackFutMetrics, {
    deltaPcr: 1.58,
    pcr: 1.66,
    totalPutWriting: 279500,
    totalCallWriting: 157500,
    roofCallWritingBlitz: false,
    floorPutWritingBlitz: true,
  });

  const eodDecision = calculateEODDecision({
    spot,
    floorStrike: 25000,
    roofStrike: 25200,
    totPutWriting: 279500,
    totCallWriting: 157500,
    pcr: 1.66,
    deltaPcr: 1.58,
    timeline,
    dayOfWeek: 5, // Friday settled session
    nowMins: 940, // 15:40 IST closing settlement
    fusion: fallbackFusion,
  });

  if (sessionInfo.isSaturday) {
    eodDecision.statusLabel = `WEEKEND CLOSED · PREVIOUS SESSION SETTLED (${sessionInfo.nextOpenDescription})`;
  }

  smartMoney.eodDecision = eodDecision;

  return {
    success: true,
    isLive: false,
    isSettledSession: true,
    fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
    symbol: "NIFTY",
    spotPrice: spot,
    expiryDate,
    timestamp: "06-Nov-2026 15:40 IST (Last Settled Session)",
    floor: 25000,
    roof: 25200,
    floorShift: "Floor held firmly at 25000",
    roofShift: "Roof holding steady at 25200",
    totalPutWriting: 279500,
    totalCallWriting: 157500,
    totalPutWritingFormatted: "+2.8L",
    totalCallWritingFormatted: "+1.6L",
    balanceStatus: "Support Heavier",
    recommendation: "Put writing dominates at 25,000 floor. Smart money defended 25,000. Favorable for stock CALLS on dips; strict SL: 24,950.",
    pcr: 1.66,
    nearPcr: 1.64,
    deltaPcr: 1.58,
    totalPutOI: 1660000,
    totalCallOI: 1000000,
    pcrWarning: eodDecision.pcrWarning,
    strikes,
    smartMoney,
    futures: fallbackFutMetrics,
    fusion: fallbackFusion,
    eodDecision,
    eodHistory: CANONICAL_EOD_SEED_HISTORY,
    intradayTimeline: timeline,
    hasRedis: Boolean(REDIS_URL),
    sessionWindow: {
      isSundayDiwali: sessionInfo.isSunday,
      isSaturday: sessionInfo.isSaturday,
      isWeekday: sessionInfo.isWeekday,
      tradingWindow: sessionInfo.tradingWindow,
      isLiveMarket: false,
      isSettledSession: true,
      nextOpenDescription: sessionInfo.nextOpenDescription,
    },
  };
}