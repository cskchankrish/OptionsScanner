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
import { authorizeRequest } from "../src/webhookAuth.js";
import {
  SPOT_FREEZE_START_MINS,
  SPOT_FREEZE_END_MINS,
  FNO_CLOSE_MINS,
  CLOSING_AUCTION_NOTE,
  isSpotFrozenAt,
  spotWindowTouchesAuction,
  decomposeWritingDelta,
  classifyIntradayFuturesQuadrant,
  getFusionQuadrantMode,
} from "../src/flowCalc.js";

let cache = {
  data: null,
  timestamp: 0,
};

let cacheByExpiry = new Map();
let lastKnownExpiryDates = [
  "09-Nov-2026",
  "17-Nov-2026",
  "23-Nov-2026",
  "01-Dec-2026",
  "08-Dec-2026"
];

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

// ── Generic Upstash REST helpers (used by the EOD radar dispatcher) ──
// Upstash REST accepts a JSON command array POSTed to the base URL.
export async function redisRestCommand(args) {
  if (!REDIS_URL || !REDIS_TOKEN) throw new Error("Redis not configured");
  const res = await fetch(REDIS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${REDIS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(2500),
  });
  if (!res.ok) throw new Error(`Redis command failed: HTTP ${res.status}`);
  const json = await res.json();
  if (json && json.error) throw new Error(`Redis command error: ${json.error}`);
  return json ? json.result : null;
}

export async function redisRestGet(key) {
  try {
    const result = await redisRestCommand(["GET", key]);
    if (result === null || result === undefined) return null;
    try {
      return typeof result === "string" ? JSON.parse(result) : result;
    } catch (e) {
      return result;
    }
  } catch (e) {
    return null;
  }
}

export async function redisRestSet(key, value, exSeconds = 86400) {
  try {
    const body = typeof value === "string" ? value : JSON.stringify(value);
    const result = await redisRestCommand(["SET", key, body, "EX", String(exSeconds)]);
    return result === "OK";
  } catch (e) {
    return false;
  }
}

/** Atomic claim: SET key value NX EX ttl. Returns true only for the single caller that created the key. */
export async function redisRestSetNx(key, value, exSeconds = 86400) {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const result = await redisRestCommand(["SET", key, body, "NX", "EX", String(exSeconds)]);
  return result === "OK";
}

export async function redisRestDel(key) {
  try {
    await redisRestCommand(["DEL", key]);
    return true;
  } catch (e) {
    return false;
  }
}

// ── EOD carry radar schedule ──
// Scheduled alerts run 14:15–15:38 IST: 15-minute slots 14:15, 14:30, 14:45, 15:00, then
// 5-minute slots 15:05 … 15:35 (15:35 = last scheduled update before the 15:40 close).
export const EOD_WINDOW_START_MINS = 855; // 14:15 IST
export const EOD_WINDOW_END_MINS = 938; // 15:38 IST
export const EOD_FIVE_MIN_SLOTS_FROM = 905; // 15:05 IST
export const EOD_LAST_SLOT_MINS = 935; // 15:35 IST

/** Slot start (IST minutes) for a minute inside the EOD window, or null outside it. */
export function getEodSlotMinutes(istMinutes) {
  if (!Number.isFinite(istMinutes)) return null;
  if (istMinutes < EOD_WINDOW_START_MINS || istMinutes > EOD_WINDOW_END_MINS) return null;
  if (istMinutes < EOD_FIVE_MIN_SLOTS_FROM) return Math.floor(istMinutes / 15) * 15;
  return Math.min(EOD_LAST_SLOT_MINS, Math.floor(istMinutes / 5) * 5);
}

function minsToHHMM(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
}

/**
 * Carry category of an eodDecision, keyed on `bias` as set by calculateEODDecision:
 * "BULLISH" (verdict "CARRY NIFTY CE (BTST)") → BTST, "BEARISH" ("CARRY NIFTY PE (STBT)") → STBT,
 * anything else ("NEUTRAL", verdict "EXIT TO CASH / DO NOT CARRY") → NO_CARRY.
 */
export function getEodCarryCategory(eodDecision) {
  const bias = eodDecision?.bias;
  if (bias === "BULLISH") return "BTST";
  if (bias === "BEARISH") return "STBT";
  return "NO_CARRY";
}

export function getEodFlipMinGapSeconds() {
  const v = Number(process.env.EOD_FLIP_MIN_GAP_SECONDS);
  return Number.isFinite(v) && v > 0 ? v : 120;
}

/**
 * BTST/STBT carry radar dispatcher (scheduled slots + immediate flip alerts).
 *
 * Slots: atomic SET NX claim on `nifty:eod_slot_dispatched:<date>:<HH:MM>` BEFORE sending,
 * released on send failure so a later poll in the same slot can retry.
 *
 * Flips: when the carry category (see getEodCarryCategory) differs from the category of the
 * last EOD message actually sent today (`nifty:eod_last_sent:<date>`, written only after a
 * successful send), an alert is sent immediately. Concurrency: atomic claim on
 * `nifty:eod_flip_claim:<date>:<FROM>-<TO>:<bucket>` (bucket = flip-gap-sized time bucket),
 * released on failure. Throttle: at most one flip alert per EOD_FLIP_MIN_GAP_SECONDS (default
 * 120s); because the throttle is purely time-since-last-flip, a flip is never held back longer
 * than that gap (plus one poll interval). If a slot is also due, ONE merged message is sent.
 *
 * Without Redis (or if a claim errors) nothing is sent, except for the explicit authenticated
 * `test=eod_alert` path which bypasses dedupe.
 */
export async function dispatchEodRadarAlert({
  istMinutes,
  istDateStr,
  isEodTest = false,
  eodDecision,
  spot,
  floorStrike,
  roofStrike,
  deps = {},
}) {
  const hasRedis = deps.hasRedis !== undefined ? deps.hasRedis : Boolean(REDIS_URL && REDIS_TOKEN);
  const setNx = deps.setNx || redisRestSetNx;
  const set = deps.set || redisRestSet;
  const get = deps.get || redisRestGet;
  const del = deps.del || redisRestDel;
  const nowMs = deps.now ? deps.now() : Date.now();
  const flipGapSec = deps.flipGapSeconds || getEodFlipMinGapSeconds();
  const flipClaimTtl = Math.max(60, Math.ceil(flipGapSec * 2));
  const sendAlert = deps.sendAlert || (async (...args) => {
    const { sendTelegramEODAlert } = await import("./tv-webhook.js");
    return sendTelegramEODAlert(...args);
  });

  if (isEodTest) {
    const slotTimeStr = "15:15";
    const sent = await sendAlert(eodDecision, spot, floorStrike, roofStrike, slotTimeStr);
    return { status: "TEST_SENT", sent: Boolean(sent), slotTimeStr };
  }

  const slotMins = getEodSlotMinutes(istMinutes);
  if (slotMins === null) return { status: "OUTSIDE_WINDOW", sent: false };
  const slotTimeStr = minsToHHMM(slotMins);
  const nowTimeStr = minsToHHMM(Math.floor(istMinutes));
  const slotKey = `nifty:eod_slot_dispatched:${istDateStr}:${slotTimeStr}`;
  const lastSentKey = `nifty:eod_last_sent:${istDateStr}`;

  if (!hasRedis) return { status: "NO_REDIS_SKIPPED", sent: false, slotTimeStr };

  const category = getEodCarryCategory(eodDecision);
  let lastSent = null;
  try {
    lastSent = await get(lastSentKey);
  } catch (e) {
    lastSent = null;
  }
  if (lastSent && typeof lastSent !== "object") lastSent = null;
  const flipDue = Boolean(lastSent && lastSent.category && lastSent.category !== category);

  // 1. Flip claim first, so the poll that owns the flip also owns any slot due right now
  //    (one merged message instead of a flip + a slot from two concurrent polls).
  let flipKey = null;
  let flipThrottled = false;
  if (flipDue) {
    const lastFlipMs = lastSent.lastFlipAt ? Date.parse(lastSent.lastFlipAt) : NaN;
    flipThrottled = Number.isFinite(lastFlipMs) && nowMs - lastFlipMs < flipGapSec * 1000;
    if (!flipThrottled) {
      const bucket = Math.floor(nowMs / (flipGapSec * 1000));
      const candidate = `nifty:eod_flip_claim:${istDateStr}:${lastSent.category}-${category}:${bucket}`;
      let flipClaimed = false;
      try {
        flipClaimed = await setNx(candidate, { claimedAt: new Date(nowMs).toISOString(), state: "SENDING" }, flipClaimTtl);
      } catch (e) {
        console.error("EOD flip dedupe claim failed; not sending:", e.message);
        return { status: "CLAIM_ERROR", sent: false, slotTimeStr };
      }
      // Another poll owns this flip (and will also take any due slot): stay quiet.
      if (!flipClaimed) return { status: "FLIP_ALREADY_CLAIMED", sent: false, slotTimeStr, flip: true };
      flipKey = candidate;
    }
  }

  // 2. Slot claim.
  let slotClaimed = false;
  try {
    slotClaimed = await setNx(slotKey, { claimedAt: new Date(nowMs).toISOString(), state: "SENDING" }, 86400);
  } catch (e) {
    console.error("EOD radar dedupe claim failed; not sending:", e.message);
    if (flipKey) await del(flipKey);
    return { status: "CLAIM_ERROR", sent: false, slotTimeStr };
  }

  if (!flipKey && !slotClaimed) {
    return { status: flipThrottled ? "FLIP_THROTTLED" : "ALREADY_CLAIMED", sent: false, slotTimeStr, flip: flipDue };
  }

  // Whenever the category changed and we send at all, the message is flip-labelled
  // (a throttled flip may still ride along with a due slot: still one message).
  const isFlipMessage = flipDue;
  const opts = {
    isScheduledSlot: slotClaimed,
    isLastScheduled: slotClaimed && slotMins === EOD_LAST_SLOT_MINS,
    flip: isFlipMessage
      ? {
          fromCategory: lastSent.category,
          toCategory: category,
          fromScore: lastSent.score,
          toScore: eodDecision?.score,
          fromVerdict: lastSent.verdict,
          fromTime: lastSent.time,
          toTime: nowTimeStr,
        }
      : null,
  };
  const msgTimeStr = slotClaimed ? slotTimeStr : nowTimeStr;

  let sent = false;
  try {
    sent = await sendAlert(eodDecision, spot, floorStrike, roofStrike, msgTimeStr, opts);
  } catch (e) {
    console.error("EOD radar send failed:", e.message);
    sent = false;
  }

  if (!sent) {
    if (slotClaimed) await del(slotKey);
    if (flipKey) await del(flipKey);
    return { status: "SEND_FAILED_RELEASED", sent: false, slotTimeStr, flip: isFlipMessage };
  }

  const sentAtIso = new Date(nowMs).toISOString();
  if (slotClaimed) await set(slotKey, { sentAt: sentAtIso, state: "SENT", flip: isFlipMessage }, 86400);
  if (flipKey) await set(flipKey, { sentAt: sentAtIso, state: "SENT" }, flipClaimTtl);
  await set(lastSentKey, {
    category,
    score: eodDecision?.score ?? null,
    verdict: eodDecision?.verdict ?? null,
    time: nowTimeStr,
    sentAt: sentAtIso,
    kind: slotClaimed ? (isFlipMessage ? "SLOT_FLIP" : "SLOT") : "FLIP",
    lastFlipAt: isFlipMessage ? sentAtIso : (lastSent?.lastFlipAt || null),
  }, 86400);

  const status = slotClaimed ? (isFlipMessage ? "SENT_SLOT_WITH_FLIP" : "SENT") : "FLIP_SENT";
  return { status, sent: true, slotTimeStr, flip: isFlipMessage, category };
}

// ── Test hooks for module-level session state ──
export function __getIntradayHistoryForTests() {
  return intradayHistory;
}
export function __resetSessionStateForTests() {
  intradayHistory = [];
  sessionDate = "";
  cache = { data: null, timestamp: 0 };
  cacheByExpiry = new Map();
}

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

export function isTodayExpiryDate(expiryStr, currentDate = new Date()) {
  if (!expiryStr || typeof expiryStr !== "string") return false;
  const istDate = new Date(currentDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const d = String(istDate.getDate()).padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = monthNames[istDate.getMonth()];
  const y = istDate.getFullYear();
  const todayStr = `${d}-${m}-${y}`;
  return expiryStr.trim().toLowerCase() === todayStr.toLowerCase();
}

export function getActiveMonthlyExpiry(expiryDates = [], currentDate = new Date()) {
  if (!Array.isArray(expiryDates) || expiryDates.length === 0) return "";
  const istDate = new Date(currentDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dayOfMonth = istDate.getDate();
  const currentMonthIdx = istDate.getMonth();
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  
  // Rule: If <= 15th, use current month's monthly expiry. If > 15th, roll to next month's monthly expiry
  let targetMonthName = monthNames[currentMonthIdx];
  if (dayOfMonth > 15) {
    targetMonthName = monthNames[(currentMonthIdx + 1) % 12];
  }
  const matching = expiryDates.filter(e => typeof e === "string" && e.includes(`-${targetMonthName}-`));
  if (matching.length > 0) return matching[matching.length - 1];
  return expiryDates[expiryDates.length > 2 ? 2 : expiryDates.length - 1] || expiryDates[0] || "";
}

export function calculateDte(expiryDateStr, currentDate = new Date()) {
  if (!expiryDateStr || typeof expiryDateStr !== "string") return 0;
  const parts = expiryDateStr.split("-");
  if (parts.length < 3) return 0;
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mIdx = monthNames.indexOf(parts[1]);
  if (mIdx === -1) return 0;
  const exp = new Date(Number(parts[2]), mIdx, Number(parts[0]), 15, 30, 0);
  const now = new Date(currentDate.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const diffMs = exp.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
}

export function extractOptionChainMetrics(records = [], spot = 25000) {
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

    if (strike <= spot && pDoi > maxPutDoi) {
      maxPutDoi = pDoi;
      floorStrike = strike;
    }

    if (strike >= spot && cDoi > maxCallDoi) {
      maxCallDoi = cDoi;
      roofStrike = strike;
    }
  }

  const deltaPcr = calculateDeltaPcr(totPutWriting, totCallWriting);
  const pcr = Number((totPutOI / (totCallOI || 1)).toFixed(2));

  return {
    totPutWriting,
    totCallWriting,
    totPutOI,
    totCallOI,
    floorStrike,
    roofStrike,
    deltaPcr,
    pcr,
  };
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
    tradingWindow = "09:15 - 15:40 IST";
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

/**
 * @param {object} payload
 * @param {{ snapshotAt?: number, source?: string }} [opts] snapshotAt (epoch ms) must only be
 *   supplied by the live NSE fetch path; it is what the webhook uses to reject stale snapshots.
 *   source (browser|cron|poller|webhook-refresh) is stamped as `snapshotSource` for provenance.
 * @returns {Promise<{ ok: boolean, error: string|null }>} ok reflects the `nifty:flow:latest` write.
 */
export async function saveRedisSessionPayloadDetailed(payload, opts = {}) {
  if (!REDIS_URL || !REDIS_TOKEN) return { ok: false, error: "Redis not configured" };
  if (!payload) return { ok: false, error: "No payload to persist" };
  try {
    const { snapshotAt: _ignoredSnapshotAt, snapshotSource: _ignoredSource, ...payloadWithoutStamp } = payload;
    const bridgeSnapshot = {
      ...payloadWithoutStamp,
      ...(Number.isFinite(opts.snapshotAt) && opts.snapshotAt > 0 ? { snapshotAt: opts.snapshotAt } : {}),
      ...(typeof opts.source === "string" && opts.source ? { snapshotSource: opts.source } : {}),
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

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    const describe = (r) => {
      if (r.status !== "fulfilled") return r.reason?.message || String(r.reason);
      if (!r.value.ok) return `HTTP ${r.value.status}`;
      return null;
    };
    const sessionErr = describe(r1);
    if (sessionErr) console.warn("Redis session payload (v2) write failed:", sessionErr);
    // nifty:flow:latest is what the webhook verifies against, so it decides success.
    const flowErr = describe(r2);
    if (flowErr) return { ok: false, error: `Redis write of nifty:flow:latest failed: ${flowErr}` };
    return { ok: true, error: null };
  } catch (e) {
    console.warn("Redis session payload save error:", e.message);
    return { ok: false, error: `Redis write failed: ${e.message}` };
  }
}

/**
 * @param {object} payload
 * @param {{ snapshotAt?: number, source?: string }} [opts]
 * @returns {Promise<boolean>} true only when the `nifty:flow:latest` write succeeded.
 */
export async function saveRedisSessionPayload(payload, opts = {}) {
  const r = await saveRedisSessionPayloadDetailed(payload, opts);
  return r.ok;
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

export async function getRedisFuturesBaseline(dateStr) {
  if (!REDIS_URL || !REDIS_TOKEN || !dateStr) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/nifty_fut_base_${encodeURIComponent(dateStr)}`, {
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

export async function saveRedisFuturesBaseline(dateStr, baselineData) {
  if (!REDIS_URL || !REDIS_TOKEN || !dateStr || !baselineData) return false;
  try {
    await fetch(`${REDIS_URL}/set/nifty_fut_base_${encodeURIComponent(dateStr)}?ex=1209600`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(baselineData),
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
    futQuadrantSource: futuresMetrics.quadrantSource || undefined,
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
      ...(isSpotFrozenAt(capMins) && !isSunday ? { spotFrozen: true } : {}),
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
    if (isSpotFrozenAt(capMins) && !isSunday) last.spotFrozen = true;
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

// Minimum live ticks inside EACH 15-minute candle before the macro engine may declare a turn.
// The poller targets one tick a minute; 3 ticks = at least one print per ~5 minutes, enough to
// show the move is not a single print while tolerating normal feed gaps. On 11-Nov the
// 15:30–15:45 candle had a single tick (15:36) and must not produce a verdict.
export const MACRO_MIN_TICKS_PER_CANDLE = 3;
// Start/end anchor ticks must sit within this many minutes of the candle boundary.
const MACRO_ANCHOR_TOLERANCE_MINS = 5;

function fmtPts(n) {
  return `${n >= 0 ? "+" : ""}${Number(n).toFixed(1)}`;
}

/**
 * 30-minute macro turn engine (2 × 15-minute clock candles).
 * - Candles never end after the current tick or after the 15:40 F&O close.
 * - Each candle needs ≥ MACRO_MIN_TICKS_PER_CANDLE live ticks.
 * - If the 30-minute window touches the 15:15–15:30 closing-auction freeze (or straddles the
 *   15:30 auction print), price is measured with FUTURES (futPrice) instead of spot; if
 *   futures ticks are missing, no turn is declared.
 * - A trap is declared only when the opposing writing flow is WRITING-driven (call writing up
 *   for a bull trap, put writing up for a bear trap). Unwinding-driven or mixed flow is
 *   described honestly and does not trigger.
 */
export function detectMacroTurn({ timeline = [], spot, floorStrike, roofStrike }) {
  const ticks = (Array.isArray(timeline) ? timeline : [])
    .filter(pt => pt && Number.isFinite(Number(pt.minutes)))
    .slice()
    .sort((a, b) => a.minutes - b.minutes);
  if (ticks.length < 12) {
    return {
      isTriggered: false,
      status: "BUILDING",
      message: "● 30-Min Macro Engine: Collecting 2x 15-minute candle history...",
    };
  }

  const tNow = ticks[ticks.length - 1];
  const nowMins = Math.min(tNow.minutes || 0, FNO_CLOSE_MINS);

  const currentSlotStart = Math.floor(nowMins / 15) * 15;
  const minsIntoSlot = nowMins - currentSlotStart;

  let c1Start, c1End, c2Start, c2End;
  if (minsIntoSlot < 3) {
    // Use the two previously completed candles.
    c2Start = currentSlotStart - 15;
    c2End = currentSlotStart;
    c1Start = c2Start - 15;
    c1End = c2Start;
  } else {
    // C1 = prior completed candle; C2 = the forming candle, which ends at the current tick.
    c1Start = currentSlotStart - 15;
    c1End = currentSlotStart;
    c2Start = currentSlotStart;
    c2End = currentSlotStart + 15;
  }
  // Never build a candle that ends after the current tick or after the 15:40 close.
  c2End = Math.min(c2End, nowMins, FNO_CLOSE_MINS);

  const c1Label = `C1 (${toClockTimeStr(c1Start)}-${toClockTimeStr(c1End)})`;
  const c2Label = `C2 (${toClockTimeStr(c2Start)}-${toClockTimeStr(c2End)})`;
  const windowStr = `${toClockTimeStr(c1Start)}-${toClockTimeStr(c2End)}`;

  const touchesAuction = spotWindowTouchesAuction(c1Start, c2End);
  const priceKey = touchesAuction ? "futPrice" : "spot";
  const priceName = touchesAuction ? "Futures" : "Spot";
  const auctionNote = touchesAuction ? ` (${CLOSING_AUCTION_NOTE}; price measured on NIFTY futures)` : "";

  const hasPrice = pt => Number(pt?.[priceKey]) > 0;
  const anchorAtOrBefore = (m) => {
    let best = null;
    for (const pt of ticks) {
      if (pt.minutes <= m && hasPrice(pt)) best = pt;
    }
    return best && m - best.minutes <= MACRO_ANCHOR_TOLERANCE_MINS ? best : null;
  };
  const liveTicksIn = (s, e) => ticks.filter(pt => pt.minutes > s && pt.minutes <= e && pt.isLiveTick !== false && hasPrice(pt)).length;

  const p0 = anchorAtOrBefore(c1Start);
  const p1 = anchorAtOrBefore(c1End);
  const p2 = anchorAtOrBefore(c2End);
  const c1Ticks = liveTicksIn(c1Start, c1End);
  const c2Ticks = liveTicksIn(c2Start, c2End);

  const insufficient = [];
  if (!p0 || !p1 || !p2) insufficient.push(`missing ${priceName.toLowerCase()} anchor tick within ${MACRO_ANCHOR_TOLERANCE_MINS}m of a candle boundary`);
  if (c1Ticks < MACRO_MIN_TICKS_PER_CANDLE) insufficient.push(`${c1Label} has ${c1Ticks} live tick(s)`);
  if (c2Ticks < MACRO_MIN_TICKS_PER_CANDLE) insufficient.push(`${c2Label} has ${c2Ticks} live tick(s)`);
  if (insufficient.length > 0) {
    return {
      isTriggered: false,
      status: "INSUFFICIENT_TICKS",
      priceSource: touchesAuction ? "FUTURES" : "SPOT",
      message: `● 30-Min Macro Engine (${windowStr}): no turn declared — ${insufficient.join("; ")} (need ≥${MACRO_MIN_TICKS_PER_CANDLE} per candle)${auctionNote}.`,
    };
  }

  const c1PriceDelta = p1[priceKey] - p0[priceKey];
  const c2PriceDelta = p2[priceKey] - p1[priceKey];
  const totalPriceDelta = p2[priceKey] - p0[priceKey];

  const c1Flow = decomposeWritingDelta(p0, p1);
  const c2Flow = decomposeWritingDelta(p1, p2);
  const totalFlow = decomposeWritingDelta(p0, p2);
  const c1NetDelta = c1Flow.netDelta;
  const c2NetDelta = c2Flow.netDelta;
  const totalNetDelta = totalFlow.netDelta;

  const candleText = (label, d, f) =>
    `${label}: ${priceName} ${fmtPts(d)} pts | Net ${formatLots(f.netDelta)} (P ${formatLots(f.putLegDelta)} / C ${formatLots(f.callLegDelta)})`;
  const candle1 = candleText(c1Label, c1PriceDelta, c1Flow);
  const candle2 = candleText(c2Label, c2PriceDelta, c2Flow);
  const legsSummary = `put writing ${formatLots(totalFlow.putLegDelta)}, call writing ${formatLots(totalFlow.callLegDelta)}`;
  const base = {
    priceSource: touchesAuction ? "FUTURES" : "SPOT",
    window: windowStr,
    candle1,
    candle2,
    flow: {
      netDelta: Math.round(totalNetDelta),
      putLegDelta: totalFlow.putLegDelta,
      callLegDelta: totalFlow.callLegDelta,
      driver: totalFlow.driver,
      dominantLeg: totalFlow.dominantLeg,
      dominantShare: totalFlow.dominantShare,
    },
    totalPriceDelta: Number(totalPriceDelta.toFixed(1)),
    totalNetDelta: Math.round(totalNetDelta),
    // kept for older readers of this object
    totalSpotDelta: touchesAuction ? null : Number(totalPriceDelta.toFixed(1)),
  };

  const bullCriteria = totalPriceDelta >= 22 && totalNetDelta <= -26000 && (c1NetDelta < -7000 || c2NetDelta < -14000);
  const bearCriteria = totalPriceDelta <= -22 && totalNetDelta >= 28000 && (c1NetDelta > 7000 || c2NetDelta > 14000);

  // Bull trap requires CALL WRITING to drive the bearish flow.
  if (bullCriteria && totalFlow.driver === "WRITING" && totalFlow.dominantLeg === "CALL") {
    const targetDrop = Math.max(50, Math.min(100, Math.round(spot - floorStrike)));
    const targetPrice = Math.round(spot - targetDrop);
    const invPrice = Math.round(Math.max(p2[priceKey], p1[priceKey], p0[priceKey]) + 15);
    return {
      ...base,
      isTriggered: true,
      type: "BULL_TRAP_REVERSAL",
      direction: "BEARISH_TURN",
      title: `🚨 30-MIN MACRO BULL TRAP CONFIRMED (${windowStr})`,
      action: `High-Probability 50–100 pt Reversal Down. Call writers sold into the 30m rally (${legsSummary}).`,
      targetMove: `50–80 pts (Target: ~${targetPrice})`,
      invalidation: `Above ${invPrice} (30m ${priceName.toLowerCase()} high + 15 pts)`,
      summary: `30m Total (${windowStr}): ${priceName} ${fmtPts(totalPriceDelta)} pts, Net Writing Delta ${formatLots(totalNetDelta)} (${legsSummary})`,
      message: `🚨 30-MIN MACRO BULL TRAP (${windowStr}): ${priceName} pushed ${fmtPts(totalPriceDelta)} pts while call writing rose (${legsSummary}; net ${formatLots(totalNetDelta)}). High-probability 50–80 pt drop toward ~${targetPrice}. Invalidation: Above ${invPrice}.${auctionNote}`,
    };
  }

  // Bear trap requires PUT WRITING to drive the bullish flow.
  if (bearCriteria && totalFlow.driver === "WRITING" && totalFlow.dominantLeg === "PUT") {
    const targetBounce = Math.max(50, Math.min(100, Math.round(roofStrike - spot)));
    const targetPrice = Math.round(spot + targetBounce);
    const invPrice = Math.round(Math.min(p2[priceKey], p1[priceKey], p0[priceKey]) - 15);
    return {
      ...base,
      isTriggered: true,
      type: "BEAR_TRAP_REVERSAL",
      direction: "BULLISH_TURN",
      title: `🟢 30-MIN MACRO BEAR TRAP / ABSORPTION CONFIRMED (${windowStr})`,
      action: `High-Probability 50–100 pt Reversal Up. Put writers absorbed the 30m dip (${legsSummary}).`,
      targetMove: `50–80 pts (Target: ~${targetPrice})`,
      invalidation: `Below ${invPrice} (30m ${priceName.toLowerCase()} low - 15 pts)`,
      summary: `30m Total (${windowStr}): ${priceName} ${fmtPts(totalPriceDelta)} pts, Net Writing Delta ${formatLots(totalNetDelta)} (${legsSummary})`,
      message: `🟢 30-MIN MACRO BEAR TRAP (${windowStr}): ${priceName} dipped ${fmtPts(totalPriceDelta)} pts while put writing rose (${legsSummary}; net ${formatLots(totalNetDelta)}). High-probability 50–80 pt bounce toward ~${targetPrice}. Invalidation: Below ${invPrice}.${auctionNote}`,
    };
  }

  if (bullCriteria || bearCriteria) {
    // The net numbers diverge from price, but the flow is not fresh writing on the opposing side.
    const dirWord = bullCriteria ? "rose" : "fell";
    return {
      ...base,
      isTriggered: false,
      type: totalFlow.driver === "UNWINDING" ? "UNWINDING_DIVERGENCE" : "MIXED_DIVERGENCE",
      direction: bullCriteria ? "BEARISH_LEAN" : "BULLISH_LEAN",
      message: `● 30-Min Divergence, not a trap (${windowStr}): ${priceName} ${dirWord} ${fmtPts(totalPriceDelta)} pts with net writing ${formatLots(totalNetDelta)}, but the flow is ${totalFlow.driver === "UNWINDING" ? "UNWINDING-driven" : totalFlow.driver.toLowerCase()} — ${totalFlow.wording}.${auctionNote}`,
    };
  }

  return {
    ...base,
    isTriggered: false,
    type: "IN_SYNC",
    message: `● 30-Min Flow (${windowStr}): ${priceName} ${fmtPts(totalPriceDelta)} pts | Net Delta ${formatLots(totalNetDelta)} — ${totalFlow.driver === "FLAT" ? "flat" : `${totalFlow.driver.toLowerCase()}-driven`}: ${totalFlow.wording}. No trap / divergence trigger.${auctionNote}`,
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

// ── EOD carry decision: three independent evidence groups ──
// A · Options positioning level (full-day writing ratio, PCR/ΔPCR, spot vs walls). The full-day
//     writing ratio IS ΔPCR (calculateDeltaPcr = put writing / call writing) and the walls come
//     from the same per-strike ΔOI, so these are one source and the group is capped at ±2.
// B · Closing options flow (14:15+ change in netDiff, decomposed into put/call legs): ±3.
// C · Futures (quadrant used by fusion + basis): ±2.
// The fusion scenario adds NO points (its quadrant is scored in C and its options leg in A);
// its trap vetoes stay as guardrails that can only block the opposite carry. The 30-min macro
// turn adds no points either: after 14:15 its window lies inside group B's window, so the same
// closing delta would be counted twice.
// Old scale: fusion ±1 + full-day ±2 + closing ±3 + PCR ±1 + levels ±1 = ±8, carry at ±3 (±4 Fri).
// New scale: A ±2 + B ±3 + C ±2 = ±7. The carry thresholds stay ±3 (±4 Friday): every old
// path to ±3 that did not rely on double counting still reaches it (e.g. B blitz alone = 3,
// or A 2 + B 1), so the intent "≥3 net points of evidence" is unchanged.
export const EOD_GROUP_CAPS = { A: 2, B: 3, C: 2 };
// Agreement score caps by number of independent groups agreeing with a carry verdict.
// One group can be wrong for one reason (60); each further independent confirmation adds 15;
// never above 90 because these are hand-set rules, not a calibrated hit rate.
export const EOD_AGREEMENT_CAPS = { 0: 30, 1: 60, 2: 75, 3: 90 };
export const EOD_AGREEMENT_LABEL = "Agreement score (rule-based, not a probability)";
const OPPOSING_GROUP_PENALTY = 10;

const clampAbs = (v, cap) => Math.max(-cap, Math.min(cap, v));
const signedPts = (v) => `${v > 0 ? "+" : ""}${v} pt${Math.abs(v) === 1 ? "" : "s"}`;

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
  targetContract = null,
  isRollover = false,
  futuresQuadrant = null,
  futuresMetrics = null,
  macroTurn = null,
}) {
  const audit = [];
  const detailAudit = [];

  // Expiry Day Rollover Protocol Audit
  if (isRollover && targetContract) {
    audit.push({
      label: "Expiry Day Rollover Protocol",
      group: "INFO",
      status: "NEXT_WEEK_EVALUATED",
      detail: `Expiry Day active. Evaluated Next Week contract (${targetContract}) for overnight carry instead of expiring 0DTE contracts.`,
      impact: "Active",
    });
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
  // The weekday spot index is frozen 15:15–15:30 for the NSE closing auction.
  const spotFrozenNow = !isSunday && isSpotFrozenAt(nowMins);

  // ═════════════ GROUP A · Options positioning level ═════════════
  let rawA = 0;

  // A1. Full Day Writing Ratio
  let fullDayPts = 0;
  let fullDayStatus = "NEUTRAL";
  let fullDayDetail = "Balanced / non-directional writing";
  if (totPutWriting > 1.35 * totCallWriting) {
    fullDayPts = 2;
    fullDayStatus = "BULLISH";
    fullDayDetail = `Put writing dominates full day (${formatLots(totPutWriting)} P vs ${formatLots(totCallWriting)} C)`;
  } else if (totCallWriting > 1.35 * totPutWriting) {
    fullDayPts = -2;
    fullDayStatus = "BEARISH";
    fullDayDetail = `Call writing dominates full day (${formatLots(totCallWriting)} C vs ${formatLots(totPutWriting)} P)`;
  }
  rawA += fullDayPts;
  detailAudit.push({
    label: "Full Day Writing",
    group: "A",
    status: fullDayStatus,
    detail: fullDayDetail,
    impact: fullDayPts > 0 ? "+2 pts" : fullDayPts < 0 ? "-2 pts" : "0 pts",
  });

  // A2. PCR & Delta PCR with 2-Tier 5-Year Historical Boundary Guardrails
  let pcrPts = 0;
  let pcrStatus = "NEUTRAL";
  let pcrDetail = `PCR ${Number(pcr).toFixed(2)} · ΔPCR ${Number(deltaPcr).toFixed(2)}`;
  let pcrWarning = null;

  const numPcr = Number(pcr);
  const numDelta = Number(deltaPcr);

  if (numPcr >= 1.65) {
    pcrPts = -1; // Active contrarian penalty
    pcrStatus = "HISTORICAL_PEAK_OVERBOUGHT";
    pcrWarning = `🚨 HISTORICAL PEAK OVERBOUGHT (PCR ${numPcr.toFixed(2)} ≥ 1.65 — 5-Yr Extreme Exhaustion)`;
    pcrDetail = `5-Year Historical Extreme (98th %ile). Severe put-writing crowding (>165 Puts / 100 Calls). Statistically precedes violent downward mean-reversion within 24-48h. Penalty (-1 pt) applied.`;
  } else if (numPcr >= 1.40) {
    pcrStatus = "EXTREME_OVERBOUGHT";
    pcrWarning = `⚠️ OVERBOUGHT EXTENSION / EXTREME OVERBOUGHT (PCR ${numPcr.toFixed(2)} ≥ 1.40)`;
    pcrDetail = `Overbought territory (${numPcr.toFixed(2)}). Put underwriting saturated. Bullish points frozen (0 pts) to prevent chasing extended tops.`;
  } else if (numPcr <= 0.52) {
    pcrPts = 1; // Active contrarian bounce bonus
    pcrStatus = "HISTORICAL_CAPITULATION_FLOOR";
    pcrWarning = `🚀 HISTORICAL CAPITULATION FLOOR (PCR ${numPcr.toFixed(2)} ≤ 0.52 — 5-Yr Contrarian Bounce Zone)`;
    pcrDetail = `5-Year Historical Panic Floor (<2nd %ile). Severe call-writing crowding (>190 Calls / 100 Puts). Statistically precedes violent short-covering squeezes (+150-300 pts). Contrarian bonus (+1 pt) applied.`;
  } else if (numPcr <= 0.65) {
    pcrStatus = "EXTREME_OVERSOLD";
    pcrWarning = `⚠️ OVERSOLD EXTENSION / DEEPLY OVERSOLD (PCR ${numPcr.toFixed(2)} ≤ 0.65)`;
    pcrDetail = `Deeply oversold (${numPcr.toFixed(2)}). Call underwriting saturated. Bearish points frozen (0 pts) to prevent shorting into support.`;
  } else if ((numDelta >= 1.25 && numPcr >= 0.98) || (numPcr >= 1.15 && numDelta >= 1.10) || (totCallWriting <= 0 && totPutWriting > 20000)) {
    pcrPts = 1;
    pcrStatus = "BULLISH";
    pcrDetail = `Bullish PCR expansion (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Healthy put writing without overbought crowding`;
  } else if ((numDelta <= 0.80 && numPcr <= 1.02) || (numPcr <= 0.88 && numDelta <= 0.90) || (totPutWriting <= 0 && totCallWriting > 20000)) {
    pcrPts = -1;
    pcrStatus = "BEARISH";
    pcrDetail = `Bearish PCR compression (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Healthy call writing without oversold exhaustion`;
  } else {
    pcrStatus = "NEUTRAL";
    pcrDetail = `Balanced PCR structure (PCR ${numPcr.toFixed(2)}, ΔPCR ${numDelta.toFixed(2)}) — Non-directional options OI`;
  }
  rawA += pcrPts;

  detailAudit.push({
    label: "PCR Structure",
    group: "A",
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

  // A3. Spot Price vs Floor / Roof (a level, not a price path)
  let levelPts = 0;
  let levelStatus = "NEUTRAL";
  let levelDetail = `Spot ${Number(spot).toFixed(0)} between ${floorStrike} and ${roofStrike}`;
  if (spot >= floorStrike + 30 && spot <= roofStrike - 15) {
    levelPts = 1;
    levelStatus = "BULLISH";
    levelDetail = `Spot holding firmly above Floor support (${floorStrike})`;
  } else if (spot <= floorStrike + 15) {
    levelPts = -1;
    levelStatus = "BEARISH";
    levelDetail = `Spot breaking down near Floor support (${floorStrike})`;
  } else if (spot >= roofStrike - 10) {
    levelPts = -1;
    levelStatus = "BEARISH";
    levelDetail = `Spot pinned at Roof resistance (${roofStrike})`;
  }
  if (spotFrozenNow) levelDetail += ` [${CLOSING_AUCTION_NOTE}: last pre-auction spot]`;
  rawA += levelPts;
  detailAudit.push({
    label: "Spot vs Levels",
    group: "A",
    status: levelStatus,
    detail: levelDetail,
    impact: levelPts > 0 ? "+1 pt" : levelPts < 0 ? "-1 pt" : "0 pts",
  });
  const groupA = clampAbs(rawA, EOD_GROUP_CAPS.A);

  // ═════════════ GROUP B · Closing options flow ═════════════
  // Tiers on |Δ netDiff| since 14:15: ≥75k → 3, ≥30k → 2, ≥10k → 1. Full weight only when the
  // move is WRITING-driven (opposing-side writing up). UNWINDING-driven, MIXED or leg-less
  // flow is one tier lower and never labelled a blitz.
  const validTimeline = (Array.isArray(timeline) ? timeline : []).filter(
    pt => pt && Number.isFinite(pt.minutes) && pt.minutes >= openMins && pt.minutes <= closeMins && Number.isFinite(pt.netDiff)
  );

  let isClosingDataValid = false;
  let p1415 = null;
  let pClose = null;
  let lastHourNetDelta = 0;
  let closingFlow = null;
  let groupB = 0;
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
        closingFlow = decomposeWritingDelta(p1415, pClose);
        lastHourNetDelta = closingFlow.netDelta;
        const windowStr = `(${p1415.time || flowAnchorStr} to ${pClose.time || closeTimeStr})`;
        const absNet = Math.abs(lastHourNetDelta);
        const fullTier = absNet >= 75000 ? 3 : absNet >= 30000 ? 2 : absNet >= 10000 ? 1 : 0;
        const isWriting = closingFlow.driver === "WRITING";
        const tier = isWriting ? fullTier : Math.max(0, fullTier - 1);
        const sign = lastHourNetDelta > 0 ? 1 : -1;
        groupB = fullTier === 0 ? 0 : sign * tier;
        const legs = `P ${formatLots(closingFlow.putLegDelta)} / C ${formatLots(closingFlow.callLegDelta)}`;
        const netTxt = `net ${formatLots(lastHourNetDelta)}`;

        if (fullTier === 0) {
          closingFlowDetail = `Closing flow steady (${netTxt}, ${closingFlow.legsText} ${windowStr})`;
        } else if (isWriting) {
          if (sign > 0) {
            closingFlowStatus = fullTier === 3 ? "INSTITUTIONAL_PUT_BLITZ" : fullTier === 2 ? "BULLISH" : "MILD_BULLISH";
            closingFlowDetail = `${fullTier === 3 ? "Massive late Put writing" : fullTier === 2 ? "Strong late Put writing" : "Moderate late Put addition"} — WRITING-driven (${netTxt}: ${closingFlow.legsText} ${windowStr}).${fullTier === 3 ? " Aggressive institutional floor defense." : ""}`;
          } else {
            closingFlowStatus = fullTier === 3 ? "INSTITUTIONAL_CALL_BLITZ" : fullTier === 2 ? "BEARISH" : "MILD_BEARISH";
            closingFlowDetail = `${fullTier === 3 ? "Massive late Call writing" : fullTier === 2 ? "Heavy late Call writing" : "Moderate late Call addition"} — WRITING-driven (${netTxt}: ${closingFlow.legsText} ${windowStr}).${fullTier === 3 ? " Aggressive institutional ceiling." : ""}`;
          }
        } else if (closingFlow.driver === "UNWINDING") {
          closingFlowStatus = sign > 0 ? "BULLISH_CALL_UNWINDING" : "BEARISH_PUT_UNWINDING";
          closingFlowDetail = sign > 0
            ? `Call writers closing / resistance withdrawn — UNWINDING-driven, not fresh put writing (${netTxt}: ${closingFlow.legsText} ${windowStr}). Weighted one tier lower.`
            : `Put writers closing / support withdrawn — UNWINDING-driven, not fresh call writing (${netTxt}: ${closingFlow.legsText} ${windowStr}). Weighted one tier lower.`;
        } else if (closingFlow.driver === "MIXED") {
          closingFlowStatus = sign > 0 ? "MIXED_BULLISH" : "MIXED_BEARISH";
          closingFlowDetail = `Mixed closing flow (${netTxt}: ${closingFlow.legsText} ${windowStr}) — neither leg dominates. Weighted one tier lower.`;
        } else {
          closingFlowStatus = sign > 0 ? "BULLISH_UNCONFIRMED" : "BEARISH_UNCONFIRMED";
          closingFlowDetail = `Closing flow ${netTxt} ${windowStr}; put/call legs unavailable, driver unknown. Weighted one tier lower.`;
        }
        closingImpact = groupB === 0 ? "0 pts" : `${signedPts(groupB)}${closingFlowStatus.includes("BLITZ") ? " (Institutional Blitz)" : ""}${!isWriting && fullTier > 0 ? ` (${legs}, one tier lower)` : ""}`;
      }
    }
  } else {
    closingFlowStatus = "AWAITING_DATA";
    closingFlowDetail = "Data Integrity Notice: Insufficient intraday timeline ticks (< 3). Scoring held neutral.";
    closingImpact = "0 pts (Data Pending)";
  }

  detailAudit.push({
    label: flowLabel,
    group: "B",
    status: closingFlowStatus,
    detail: closingFlowDetail,
    impact: closingImpact,
    flow: closingFlow ? {
      netDelta: closingFlow.netDelta,
      putLegDelta: closingFlow.putLegDelta,
      callLegDelta: closingFlow.callLegDelta,
      driver: closingFlow.driver,
      dominantLeg: closingFlow.dominantLeg,
      dominantShare: closingFlow.dominantShare,
    } : null,
  });

  if (macroTurn && macroTurn.message) {
    detailAudit.push({
      label: "30-Min Macro Turn",
      group: "INFO",
      status: macroTurn.type || macroTurn.status || "INFO",
      detail: `${macroTurn.message} Not scored: its window overlaps the ${flowAnchorStr}+ closing window already scored in Group B (same closing delta counted once).`,
      impact: "0 pts (counted in Group B)",
    });
  }

  // ═════════════ GROUP C · Futures (quadrant + basis) ═════════════
  const quadInfo = futuresQuadrant || fusion?.quadrantInfo || null;
  const quadrant = quadInfo?.quadrant || "UNAVAILABLE";
  const quadSource = quadInfo?.sourceLabel || fusion?.quadrantSourceLabel || null;
  let quadPts = 0;
  if (quadrant === "LONG_BUILDUP") quadPts = 1;
  else if (quadrant === "SHORT_BUILDUP") quadPts = -1;
  const quadDir = ["LONG_BUILDUP", "SHORT_COVERING"].includes(quadrant) ? 1
    : ["SHORT_BUILDUP", "LONG_UNWINDING"].includes(quadrant) ? -1 : 0;

  let basisPts = 0;
  let basisDetail = "basis unavailable";
  if (futuresMetrics && Number.isFinite(Number(futuresMetrics.rawBasis))) {
    if (spotFrozenNow) {
      basisDetail = `basis not scored (${CLOSING_AUCTION_NOTE}; futures − frozen spot is not a basis)`;
    } else {
      const adj = Number(futuresMetrics.adjustedBasisSpread ?? 0);
      const intra = Number(futuresMetrics.intradayBasisDelta ?? 0);
      const raw = Number(futuresMetrics.rawBasis ?? 0);
      const basisBull = adj >= -5 || intra >= 5;
      const basisBear = raw < 0 || adj <= -10 || intra <= -5;
      const basisDir = basisBull && !basisBear ? 1 : basisBear && !basisBull ? -1 : 0;
      basisPts = quadDir !== 0 && basisDir === quadDir ? basisDir : 0;
      basisDetail = `basis raw ${raw}, adj ${adj}, Δ ${intra} → ${basisDir > 0 ? "bullish" : basisDir < 0 ? "bearish" : "mixed"}${basisPts !== 0 ? " (confirms quadrant)" : quadDir !== 0 && basisDir !== 0 ? " (contradicts quadrant, 0 pts)" : ""}`;
    }
  }
  const groupC = clampAbs(quadPts + basisPts, EOD_GROUP_CAPS.C);
  detailAudit.push({
    label: "Futures Quadrant & Basis",
    group: "C",
    status: quadrant,
    detail: `Quadrant ${quadrant.replace(/_/g, " ")}${quadSource ? ` [${quadSource}]` : ""}: ${signedPts(quadPts)}; ${basisDetail}${basisPts ? `: ${signedPts(basisPts)}` : ""}.`,
    impact: groupC === 0 ? "0 pts" : signedPts(groupC),
  });

  // ═════════════ Guardrails (no points) ═════════════
  let score = groupA + groupB + groupC;

  let lateVetoWarning = null;
  // A late blitz veto needs WRITING-driven flow on the opposing side (fresh calls / fresh puts).
  const isLateCallBlitz = isClosingDataValid && lastHourNetDelta <= -50000 &&
    closingFlow?.driver === "WRITING" && closingFlow?.dominantLeg === "CALL";
  const isLatePutBlitz = isClosingDataValid && lastHourNetDelta >= 50000 &&
    closingFlow?.driver === "WRITING" && closingFlow?.dominantLeg === "PUT";

  const slShort = roofStrike && Number(roofStrike) > Number(spot) ? Number(roofStrike) : Math.round(Number(spot) + 35);
  const targetShort = floorStrike && Number(floorStrike) < Number(spot) ? Number(floorStrike) : Math.round(Number(spot) - 70);

  const slLong = floorStrike && Number(floorStrike) < Number(spot) ? Number(floorStrike) : Math.round(Number(spot) - 35);
  const targetLong = roofStrike && Number(roofStrike) > Number(spot) ? Number(roofStrike) : Math.round(Number(spot) + 70);

  const vetoAnchorTime = p1415?.time || flowAnchorStr;
  const guardAudit = [];

  if (isLateCallBlitz) {
    score = Math.min(1, score);
    const callLots = formatLotsAbs(lastHourNetDelta);
    lateVetoWarning = `⚠️ LATE CALL BLITZ VETO: Heavy Call writing (${callLots} lots net; ${closingFlow.legsText}) entered after ${vetoAnchorTime}. BTST strictly forbidden. Short / STBT PE carry with Strict SL at ${slShort} (Roof Resistance). Target: Morning gap-down toward Floor (${targetShort}).`;
    guardAudit.push({
      label: isSunday ? "Muhurat Institutional Veto Guardrail" : "14:15+ Institutional Veto Guardrail",
      group: "GUARD",
      status: "BEARISH_VETO",
      detail: lateVetoWarning,
      impact: `VETO BTST · Short SL: ${slShort}`,
    });
  } else if (isLatePutBlitz) {
    score = Math.max(-1, score);
    const putLots = formatLotsAbs(lastHourNetDelta);
    lateVetoWarning = `⚠️ LATE PUT UNDERWRITING VETO: Heavy Put writing (${putLots} lots net; ${closingFlow.legsText}) entered after ${vetoAnchorTime}. STBT strictly forbidden. Long / BTST CE carry with Strict SL at ${slLong} (Floor Support). Target: Morning gap-up toward Roof (${targetLong}).`;
    guardAudit.push({
      label: isSunday ? "Muhurat Institutional Veto Guardrail" : "14:15+ Institutional Veto Guardrail",
      group: "GUARD",
      status: "BULLISH_VETO",
      detail: lateVetoWarning,
      impact: `VETO STBT · Long SL: ${slLong}`,
    });
  }

  // Smart Money Futures Fusion: veto guardrail / information only — no points.
  let fusionVetoWarning = null;
  if (fusion?.eodCarryVeto === "VETO_BTST") {
    score = Math.min(1, score);
    fusionVetoWarning = `🚨 FUSION BULL TRAP VETO: ${fusion.headline}. BTST strictly forbidden. ${fusion.rationale}`;
    guardAudit.push({
      label: "Smart Money Futures Fusion",
      group: "GUARD",
      status: "BEARISH_VETO",
      impact: "VETO BTST (Bull Trap)",
      detail: fusionVetoWarning,
    });
  } else if (fusion?.eodCarryVeto === "VETO_STBT") {
    score = Math.max(-1, score);
    fusionVetoWarning = `🟢 FUSION BEAR TRAP VETO: ${fusion.headline}. STBT strictly forbidden. ${fusion.rationale}`;
    guardAudit.push({
      label: "Smart Money Futures Fusion",
      group: "GUARD",
      status: "BULLISH_VETO",
      impact: "VETO STBT (Bear Trap)",
      detail: fusionVetoWarning,
    });
  } else if (fusion) {
    guardAudit.push({
      label: "Smart Money Futures Fusion",
      group: "INFO",
      status: fusion.scenarioId,
      impact: "0 pts (scored via Groups A and C)",
      detail: `${fusion.badge}: ${fusion.headline}. ${fusion.rationale}`,
    });
  }

  const groups = {
    A: { id: "A", name: "Options positioning (PCR / ΔPCR / walls)", contribution: groupA, raw: rawA, cap: EOD_GROUP_CAPS.A },
    B: { id: "B", name: `Closing options flow (${flowAnchorStr}+)`, contribution: groupB, raw: groupB, cap: EOD_GROUP_CAPS.B, driver: closingFlow?.driver || null },
    C: { id: "C", name: "Futures (quadrant + basis)", contribution: groupC, raw: quadPts + basisPts, cap: EOD_GROUP_CAPS.C, quadrant, quadrantSource: quadSource },
  };
  const groupSummary = (g, parts) => ({
    label: `Group ${g.id} · ${g.name}`,
    group: g.id,
    isGroupSummary: true,
    status: g.contribution > 0 ? "BULLISH" : g.contribution < 0 ? "BEARISH" : "NEUTRAL",
    contribution: g.contribution,
    detail: parts,
    impact: `${g.contribution === 0 ? "0 pts" : signedPts(g.contribution)} (cap ±${g.cap})`,
  });
  audit.push(
    groupSummary(groups.A, `Full-day writing ${signedPts(fullDayPts)}, PCR ${signedPts(pcrPts)}, walls ${signedPts(levelPts)} → raw ${signedPts(rawA)}${rawA !== groupA ? `, capped to ${signedPts(groupA)} (writing ratio and ΔPCR are the same ratio)` : ""}.`),
    groupSummary(groups.B, closingFlowDetail),
    groupSummary(groups.C, `Quadrant ${quadrant.replace(/_/g, " ")}${quadSource ? ` [${quadSource}]` : ""} ${signedPts(quadPts)}; ${basisDetail}.`),
    ...detailAudit,
    ...guardAudit,
  );

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

  let verdict;
  let bias;
  let sizing;
  let action;
  const thresh = isFriday ? 4 : 3;

  if (score >= thresh) {
    verdict = "CARRY NIFTY CE (BTST)";
    bias = "BULLISH";
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = `Favorable for holding overnight Nifty CE. Smart money has underwritten downside risk. Target: Morning gap-up continuation toward ${roofStrike}. Strict SL: Close below Floor Support (${slLong}).`;
    if (pcrWarning) {
      action += ` [${pcrWarning}: Tighten stop at ${slLong} due to extreme PCR stretch].`;
    }
  } else if (score <= -thresh) {
    verdict = "CARRY NIFTY PE (STBT)";
    bias = "BEARISH";
    sizing = isFriday ? "50% Size (Weekend Risk Control)" : "75% Normal Size";
    action = closingFlow?.driver === "UNWINDING" && groupB < 0
      ? `Favorable for holding overnight Nifty PE. Put support was withdrawn into the close (not fresh call writing). Target: Morning gap-down slippage toward ${floorStrike}. Strict SL: Close above Roof Resistance (${slShort}).`
      : `Favorable for holding overnight Nifty PE. Smart money heavily capped resistance. Target: Morning gap-down slippage toward ${floorStrike}. Strict SL: Close above Roof Resistance (${slShort}).`;
    if (pcrWarning) {
      action += ` [${pcrWarning}: Tighten stop at ${slShort} due to oversold squeeze risk].`;
    }
  } else {
    verdict = "EXIT TO CASH / DO NOT CARRY";
    bias = "NEUTRAL";
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

  // Agreement score (replaces the old "conviction %" = 72 + 4×|score|, which was not a probability).
  const groupList = [groups.A, groups.B, groups.C];
  let conviction;
  let agreeing = [];
  let opposing = [];
  if (bias !== "NEUTRAL") {
    const dir = bias === "BULLISH" ? 1 : -1;
    agreeing = groupList.filter(g => Math.sign(g.contribution) === dir);
    opposing = groupList.filter(g => Math.sign(g.contribution) === -dir);
    const strength = agreeing.length
      ? agreeing.reduce((s, g) => s + Math.abs(g.contribution) / g.cap, 0) / agreeing.length
      : 0;
    const cap = EOD_AGREEMENT_CAPS[agreeing.length];
    conviction = Math.max(0, Math.round(cap * (0.5 + 0.5 * strength)) - OPPOSING_GROUP_PENALTY * opposing.length);
  } else {
    // No carry: how many groups support standing aside (zero, or against the net lean).
    const lean = Math.sign(groupA + groupB + groupC);
    agreeing = groupList.filter(g => g.contribution === 0 || lean === 0 || Math.sign(g.contribution) === -lean);
    opposing = groupList.filter(g => !agreeing.includes(g));
    conviction = EOD_AGREEMENT_CAPS[agreeing.length];
  }
  const agreement = {
    kind: "RULE_BASED_AGREEMENT",
    isProbability: false,
    label: EOD_AGREEMENT_LABEL,
    value: conviction,
    cap: EOD_AGREEMENT_CAPS[agreeing.length],
    groupsAgreeing: agreeing.map(g => g.id),
    groupsOpposing: opposing.map(g => g.id),
    verdictSide: bias === "NEUTRAL" ? "STAND_ASIDE" : bias,
  };

  return {
    verdict,
    bias,
    conviction,
    convictionLabel: EOD_AGREEMENT_LABEL,
    agreement,
    sizing,
    action,
    stopLoss: (bias === "BEARISH" || isLateCallBlitz || fusion?.eodCarryVeto === "VETO_BTST") ? slShort : (bias === "BULLISH" || isLatePutBlitz || fusion?.eodCarryVeto === "VETO_STBT") ? slLong : null,
    target: (bias === "BEARISH" || isLateCallBlitz || fusion?.eodCarryVeto === "VETO_BTST") ? targetShort : (bias === "BULLISH" || isLatePutBlitz || fusion?.eodCarryVeto === "VETO_STBT") ? targetLong : null,
    score,
    groups,
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
    closingFlow: closingFlow ? {
      netDelta: closingFlow.netDelta,
      putLegDelta: closingFlow.putLegDelta,
      callLegDelta: closingFlow.callLegDelta,
      driver: closingFlow.driver,
      dominantLeg: closingFlow.dominantLeg,
      dominantShare: closingFlow.dominantShare,
      wording: closingFlow.wording,
    } : null,
    fusion,
    targetContract: targetContract || null,
    isRollover: Boolean(isRollover),
  };
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-webhook-secret");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const today = getISTDateStr();
  const now = Date.now();

  // Handle client-to-server sync via POST (e.g. mobile or desktop sharing gathered 1-min ticks or EOD history)
  // Requires the webhook secret (fail closed: 503 if unconfigured, 401 if missing/wrong).
  if (req.method === "POST") {
    let body = null;
    try {
      body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch (e) {
      body = null;
    }
    const auth = authorizeRequest(req, body);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }
    try {
      if (!body || typeof body !== "object") throw new Error("Invalid sync payload");
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

  // `force=true` (bypass market-hours/caches) and `test=eod_alert` (sends Telegram) require the secret.
  if (req.query?.force === "true" || req.query?.test === "eod_alert") {
    const auth = authorizeRequest(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }
  }

  const sessionInfo = getMarketSessionInfo();
  const force = req.query?.force === "true";
  const isCronRequest = req.query?.cron === "true" ||
                        req.query?.cron === "1" ||
                        req.query?.compact === "true" ||
                        /cron|uptime|ping|curl/i.test(req.headers?.["user-agent"] || "");

  const queryExpiry = req.query?.expiry ? String(req.query.expiry).trim().toLowerCase() : null;
  const isSpecificExpiry = Boolean(queryExpiry && queryExpiry !== "auto");

  // 1. Outside live market hours (Weekends, Evenings, Nights, Pre-market)
  // If specific expiry is NOT requested, serve the settled session state without querying NSE (which is closed)
  if (!sessionInfo.isLiveMarket && !force && !isSpecificExpiry) {
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "MARKET_CLOSED_SETTLED",
        timestamp: getISTTimeStr(),
        nextOpen: sessionInfo.nextOpenDescription
      });
    }
    const nearCached = cacheByExpiry.get("near") || cacheByExpiry.get("default") || (cache.data?.expiryDate ? cache : null);
    if (nearCached && (nearCached.data.isSettledSession || now - nearCached.timestamp < 3600000)) {
      return res.status(200).json({
        ...nearCached.data,
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
        cacheByExpiry.set("near", { data: enriched, timestamp: now });
        cacheByExpiry.set("default", { data: enriched, timestamp: now });
        return res.status(200).json(enriched);
      }
    }

    const fallbackPayload = getFallbackData();
    cache = { data: fallbackPayload, timestamp: now };
    cacheByExpiry.set("near", { data: fallbackPayload, timestamp: now });
    cacheByExpiry.set("default", { data: fallbackPayload, timestamp: now });
    return res.status(200).json(fallbackPayload);
  }

  // Outside live market hours with a specific expiry requested: serve from cache if available (valid for 1 hr)
  if (!sessionInfo.isLiveMarket && !force && isSpecificExpiry) {
    const cached = cacheByExpiry.get(queryExpiry);
    if (cached && (cached.data.isSettledSession || now - cached.timestamp < 3600000)) {
      return res.status(200).json({
        ...cached.data,
        isLive: false,
        isSettledSession: true,
        fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
      });
    }
  }

  // 2. During Live Market Hours: serve memory cache if fresh (< 5 seconds) for this specific expiry
  const cacheKey = queryExpiry || "near";
  const cachedForExpiry = cacheByExpiry.get(cacheKey) || (queryExpiry ? null : (cache.data ? cache : null));
  if (!force && cachedForExpiry?.data && cachedForExpiry.data.isLive && (now - cachedForExpiry.timestamp < 5000)) {
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "CACHED_FRESH",
        timestamp: cachedForExpiry.data.timestamp,
        spot: cachedForExpiry.data.spotPrice
      });
    }
    return res.status(200).json(cachedForExpiry.data);
  }

  // Live fetch → compute → payload → persist runs through the shared refresh core.
  // The browser path keeps the fire-and-forget Redis write so response latency is unchanged.
  const refresh = await refreshLiveSnapshot({
    now,
    sessionInfo,
    queryExpiry,
    rolloverRequested: req.query?.rollover === "true",
    isEodTest: req.query?.test === "eod_alert", // authorised above
    awaitPersist: false,
    source: isCronRequest ? "cron" : "browser",
  });
  if (refresh.ok) {
    const payload = refresh.payload;
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
  }
  {
    const err = refresh.errorObject || new Error(refresh.error);
    console.error("NSE Live fetch error, falling back to cached state:", err);
    if (isCronRequest) {
      return res.status(200).json({
        ok: true,
        cron: true,
        status: "FALLBACK_CACHED",
        spot: cache.data?.spotPrice || 25030.35
      });
    }

    if (isSpecificExpiry) {
      const cachedExpiry = cacheByExpiry.get(queryExpiry);
      if (cachedExpiry) {
        return res.status(200).json({
          ...cachedExpiry.data,
          isLive: false,
          isSettledSession: true,
          fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
        });
      }
    }

    if (!isSpecificExpiry && cache.data) {
      return res.status(200).json({
        ...cache.data,
        isLive: false,
        isSettledSession: true,
        fallbackNotice: `Market Closed · Displaying last settled trading session (Preserved until ${sessionInfo.nextOpenDescription})`,
      });
    }

    if (!isSpecificExpiry && REDIS_URL) {
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
    const fallbackPayload = getFallbackData(queryExpiry);
    return res.status(200).json(fallbackPayload);
  }
}

/**
 * Shared live refresh core: NSE fetch → compute → payload → in-memory cache → Redis snapshot.
 * Used by the browser handler (awaitPersist=false, unchanged fire-and-forget write), the
 * authenticated poller and the webhook's on-demand refresh (awaitPersist=true: the
 * `nifty:flow:latest` write is awaited and a failure is reported, never swallowed).
 *
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms used for cache timestamps and snapshotAt
 * @param {object} [opts.sessionInfo] getMarketSessionInfo() result
 * @param {string|null} [opts.queryExpiry] lower-cased expiry selector (null = default selection)
 * @param {boolean} [opts.rolloverRequested] mirrors `?rollover=true`
 * @param {boolean} [opts.isEodTest] mirrors the authorised `?test=eod_alert`
 * @param {boolean} [opts.awaitPersist] await the Redis snapshot write and fail on error
 * @param {string} [opts.source] provenance stamped on the snapshot (browser|cron|poller|webhook-refresh)
 * @param {number|null} [opts.deadlineMs] absolute epoch-ms deadline; NSE fetch timeouts shrink to fit
 * @returns {Promise<{ ok: boolean, payload?: object, error?: string, stage?: "nse"|"redis",
 *   persisted?: boolean|null, snapshotAt?: number, ticks?: number, targetExpiry?: string, nearExpiry?: string }>}
 */
export async function refreshLiveSnapshot({
  now = Date.now(),
  sessionInfo = getMarketSessionInfo(),
  queryExpiry = null,
  rolloverRequested = false,
  isEodTest = false,
  awaitPersist = false,
  source = "browser",
  deadlineMs = null,
} = {}) {
  const today = getISTDateStr();
  // Keep ~2.5s for the awaited Redis write when a deadline is set.
  const fetchDeadline = Number.isFinite(deadlineMs) ? deadlineMs - (awaitPersist ? 2500 : 0) : null;
  const fetchSignal = (ms) => {
    if (fetchDeadline === null) return AbortSignal.timeout(ms);
    const remaining = fetchDeadline - Date.now();
    if (remaining <= 0) throw new Error("refresh deadline exceeded before NSE fetch");
    return AbortSignal.timeout(Math.max(200, Math.min(ms, remaining)));
  };

  let payload = null;
  let targetExpiry = null;
  let nearExpiry = null;
  try {
    // Preload history from Redis if memory is empty
    await syncRedisHistory(today);

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept": "*/*",
      "Referer": "https://www.nseindia.com/option-chain",
    };

    // 1. Session warmup with 6.5s timeout (resilient against busy closing NSE traffic)
    const warmup = await fetch("https://www.nseindia.com/option-chain", {
      headers,
      signal: fetchSignal(6500),
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
    let expiryDates = lastKnownExpiryDates;
    try {
      const contractRes = await fetch("https://www.nseindia.com/api/option-chain-contract-info?symbol=NIFTY", {
        headers: sessionHeaders,
        signal: fetchSignal(6500),
      });
      if (contractRes.ok) {
        const contractData = await contractRes.json();
        if (Array.isArray(contractData.expiryDates) && contractData.expiryDates.length > 0) {
          expiryDates = contractData.expiryDates;
          lastKnownExpiryDates = expiryDates;
        }
      }
    } catch (e) {
      console.warn("Contract info fetch warning, using last known expiry dates:", e.message);
    }

    const activeWeekly = getActiveExpiryDate();
    nearExpiry = getActiveExpiryDate(expiryDates[0]) || activeWeekly;
    const nextExpiry = expiryDates.find(e => {
      const d = new Date(e);
      const nd = new Date(nearExpiry);
      return !isNaN(d.getTime()) && d > nd;
    }) || expiryDates[1] || "";
    const monthlyExpiry = getActiveMonthlyExpiry(expiryDates);
    const isExpiryDay = isTodayExpiryDate(nearExpiry);
    const currentMinutes = getISTMinutes();
    const isAfternoonRollover = (isExpiryDay && nextExpiry && (currentMinutes >= 840 || rolloverRequested));

    targetExpiry = nearExpiry;
    if (queryExpiry === "next" && nextExpiry) {
      targetExpiry = nextExpiry;
    } else if (queryExpiry === "today" || queryExpiry === "near") {
      targetExpiry = nearExpiry;
    } else if (queryExpiry === "monthly" && monthlyExpiry) {
      targetExpiry = monthlyExpiry;
    } else if (queryExpiry && expiryDates.some(e => e.toLowerCase() === queryExpiry)) {
      targetExpiry = expiryDates.find(e => e.toLowerCase() === queryExpiry);
    } else if (isAfternoonRollover && nextExpiry) {
      // Default to next week's expiry on expiry day afternoon (after 14:00 IST)
      targetExpiry = nextExpiry;
    }

    // 3. Fetch v3 option chain AND Nifty Futures concurrently via Promise.allSettled
    const v3Url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(targetExpiry)}`;
    const futUrl = "https://www.nseindia.com/api/liveEquity-derivatives?index=nse50_fut";

    const fetchPromises = [
      fetch(v3Url, { headers: sessionHeaders, signal: fetchSignal(6500) }),
      fetch(futUrl, { headers: sessionHeaders, signal: fetchSignal(4500) }),
    ];

    const shouldFetchSecondaryChain = isAfternoonRollover && targetExpiry === nearExpiry && nextExpiry;
    if (shouldFetchSecondaryChain) {
      const nextV3Url = `https://www.nseindia.com/api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=${encodeURIComponent(nextExpiry)}`;
      fetchPromises.push(fetch(nextV3Url, { headers: sessionHeaders, signal: fetchSignal(6500) }));
    }

    const settledResults = await Promise.allSettled(fetchPromises);
    const v3Settled = settledResults[0];
    const futSettled = settledResults[1];
    const nextSettled = shouldFetchSecondaryChain ? settledResults[2] : null;

    if (v3Settled.status !== "fulfilled" || !v3Settled.value.ok) {
      throw new Error(`v3 option chain failed: status ${v3Settled.status === "fulfilled" ? v3Settled.value.status : v3Settled.reason?.message}`);
    }
    const v3Data = await v3Settled.value.json();

    const spot = Number(v3Data.records?.underlyingValue) || 25030.35;
    const records = v3Data.filtered?.data || v3Data.records?.data || [];
    const expiryDate = getActiveExpiryDate(targetExpiry);
    const timestampStr = v3Data.records?.timestamp || new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });

    // Parse Next Expiry metrics if fetched during Expiry Day Rollover
    let nextMetrics = null;
    if (nextSettled && nextSettled.status === "fulfilled" && nextSettled.value.ok) {
      try {
        const nextV3Data = await nextSettled.value.json();
        const nextRows = nextV3Data.filtered?.data || nextV3Data.records?.data || [];
        nextMetrics = extractOptionChainMetrics(nextRows, spot);
        nextMetrics.expiry = nextExpiry;
      } catch (e) {
        console.warn("Next expiry chain parse warning:", e.message);
      }
    }

    // Parse Nifty Futures with Rollover Protection & Graceful Degradation
    let futuresMetrics = null;
    const openTick = Array.isArray(intradayHistory) && intradayHistory.length > 0 ? intradayHistory[0] : null;
    let openOiBaseline = openTick?.futCombinedOI || null;
    let openBasisBaseline = openTick?.futBasis || null;
    let openPriceBaseline = openTick?.futPrice || null;

    if (!openOiBaseline && REDIS_URL) {
      const cachedBase = await getRedisFuturesBaseline(today);
      if (cachedBase) {
        openOiBaseline = cachedBase.openOI;
        openBasisBaseline = cachedBase.openBasis;
        openPriceBaseline = cachedBase.openPrice;
      }
    }

    if (futSettled.status === "fulfilled" && futSettled.value.ok) {
      try {
        const rawFutJson = await futSettled.value.json();
        futuresMetrics = parseNseFuturesPayload(
          rawFutJson,
          spot,
          openBasisBaseline,
          openOiBaseline,
          openPriceBaseline
        );
        if (futuresMetrics && REDIS_URL) {
          saveRedisFuturesSnapshot(futuresMetrics).catch(() => {});
          if (!openOiBaseline && futuresMetrics.combinedOI > 0) {
            saveRedisFuturesBaseline(today, {
              openOI: futuresMetrics.combinedOI,
              openBasis: futuresMetrics.rawBasis,
              openPrice: futuresMetrics.lastPrice,
              timestamp: Date.now(),
            }).catch(() => {});
          }
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

    // Baseline fallback patch: Ensure combinedChgOI is computed even if cached snapshot had 0 delta
    if (futuresMetrics && (!futuresMetrics.combinedChgOI || futuresMetrics.combinedChgOI === 0)) {
      const baseOI = openOiBaseline || openTick?.futCombinedOI;
      if (baseOI && futuresMetrics.combinedOI > 0) {
        const delta = futuresMetrics.combinedOI - Number(baseOI);
        const deltaPct = Number(((delta / Number(baseOI)) * 100).toFixed(2));
        futuresMetrics.combinedChgOI = delta;
        futuresMetrics.combinedOiChangePct = deltaPct;
        futuresMetrics.nearChgOI = delta;
        const basePrice = openPriceBaseline || openTick?.futPrice;
        if (basePrice && futuresMetrics.lastPrice) {
          const sessionPts = Number((futuresMetrics.lastPrice - Number(basePrice)).toFixed(2));
          const sessionPct = Number(((sessionPts / Number(basePrice)) * 100).toFixed(2));
          if (Math.abs(sessionPts) > Math.abs(futuresMetrics.priceChange || 0) || Math.abs(futuresMetrics.priceChange || 0) < 5) {
            futuresMetrics.priceChange = sessionPts;
            futuresMetrics.priceChangePct = sessionPct;
          }
        }
        if (REDIS_URL) {
          saveRedisFuturesSnapshot(futuresMetrics).catch(() => {});
        }
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

    // Rolling-window (default 30m) futures quadrant from the stored per-minute ticks plus the
    // current reading (the current tick is appended to the timeline only after this point).
    const sessionCloseMins = sessionInfo.isSunday ? 960 : 940;
    const currentTickMins = Math.min(getISTMinutes(), sessionCloseMins);
    const intradayQuadrant = futuresMetrics && !futuresMetrics.isStale
      ? classifyIntradayFuturesQuadrant(intradayHistory, {
          current: {
            minutes: currentTickMins,
            time: toClockTimeStr(currentTickMins),
            futPrice: Number(futuresMetrics.lastPrice),
            futCombinedOI: Number(futuresMetrics.combinedOI),
          },
        })
      : null;
    const fusion = evaluateSmartMoneyFusion(futuresMetrics, optionsMetrics, {
      intradayQuadrant,
      mode: getFusionQuadrantMode(),
    });
    // Publish the quadrant fusion actually used (intraday when available, else day) so timeline
    // ticks (futQuadrant), futures.quadrant and the webhook's futures veto agree, and expose both.
    if (futuresMetrics && fusion?.quadrantInfo?.quadrant) {
      futuresMetrics.quadrant = fusion.quadrantInfo.quadrant;
      futuresMetrics.quadrantSource = fusion.quadrantSource;
      futuresMetrics.quadrantSourceLabel = fusion.quadrantSourceLabel;
      futuresMetrics.quadrantSourceReason = fusion.quadrantSourceReason;
      futuresMetrics.quadrantDay = fusion.quadrantDay;
      futuresMetrics.quadrantIntraday = fusion.quadrantIntraday;
    }
    // A floor/roof "shift" right after the 15:30 auction print is the corridor re-centring on
    // the auction close, not price action; say so.
    const prevTickMins = intradayHistory.length ? intradayHistory[intradayHistory.length - 1].minutes : null;
    if (!sessionInfo.isSunday && prevTickMins !== null && prevTickMins < SPOT_FREEZE_END_MINS && currentTickMins >= SPOT_FREEZE_END_MINS) {
      const note = " (reference moved with the 15:30 closing-auction print — not a price move)";
      if (floorShift.startsWith("Floor moved")) floorShift += note;
      if (roofShift.startsWith("Roof moved")) roofShift += note;
    }

    // Near expiry: always record the tick (buildTimeline appends the first tick of the
    // session even when history is empty). Any other expiry: read-only copy of the real
    // near-expiry history (possibly empty) — never synthetic ticks, never a mutation.
    const timeline = (targetExpiry === nearExpiry)
      ? buildTimeline(totPutWriting, totCallWriting, spot, futuresMetrics)
      : (Array.isArray(intradayHistory) ? intradayHistory.map(pt => ({ ...pt })) : []);

    // Compute Smart Money / Institutional Analysis
    const smartMoney = analyzeSmartMoney({
      strikes,
      spot,
      floorStrike,
      roofStrike,
      intradayHistory: timeline,
    });

    const isTargetRollover = Boolean(isExpiryDay && targetExpiry === nextExpiry);
    const isEvaluatingNextExpiry = Boolean(isTargetRollover || (isAfternoonRollover && nextMetrics));
    const eodDecision = calculateEODDecision({
      spot,
      floorStrike: (isAfternoonRollover && nextMetrics) ? nextMetrics.floorStrike : floorStrike,
      roofStrike: (isAfternoonRollover && nextMetrics) ? nextMetrics.roofStrike : roofStrike,
      totPutWriting: (isAfternoonRollover && nextMetrics) ? nextMetrics.totPutWriting : totPutWriting,
      totCallWriting: (isAfternoonRollover && nextMetrics) ? nextMetrics.totCallWriting : totCallWriting,
      pcr: (isAfternoonRollover && nextMetrics) ? nextMetrics.pcr : pcr,
      deltaPcr: (isAfternoonRollover && nextMetrics) ? nextMetrics.deltaPcr : deltaPcr,
      timeline,
      dayOfWeek: getISTDayOfWeek(),
      nowMins: getISTMinutes(),
      fusion,
      targetContract: targetExpiry,
      isRollover: Boolean(isTargetRollover || isAfternoonRollover),
      futuresQuadrant: fusion?.quadrantInfo || null,
      futuresMetrics,
      macroTurn: smartMoney.macroTurn,
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

    // Automatic BTST / STBT Carry Radar + flip alerts (14:15 to 15:38 IST; see dispatchEodRadarAlert)
    const istMinutes = getISTMinutes();
    const istDateStr = getISTIsoDateStr();
    try {
      await dispatchEodRadarAlert({
        istMinutes,
        istDateStr,
        isEodTest,
        eodDecision,
        spot,
        floorStrike,
        roofStrike,
      });
    } catch (err) {
      console.error("Error dispatching 15-minute EOD radar alert:", err);
    }

    payload = {
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
      rollover: {
        isExpiryDay,
        nearExpiry,
        nextExpiry,
        monthlyExpiry,
        activeContract: targetExpiry,
        isAfternoonRollover,
        isEvaluatingNextExpiry,
        nextExpiryMetrics: nextMetrics || null,
      },
      swingRadar: {
        monthlyExpiry,
        dte: calculateDte(monthlyExpiry),
        underlyingSpot: spot,
        // T+2 swing context keeps the day-level quadrant (vs previous close / session open).
        futuresBuildup: futuresMetrics?.quadrantDay?.quadrant || futuresMetrics?.quadrant || "NEUTRAL",
        futuresBasis: futuresMetrics?.rawBasis || 0,
        adjustedBasisSpread: futuresMetrics?.adjustedBasisSpread || 0,
        protocol: "Monthly Expiry (<=15th: current month, >15th: next month) · T+2 Holding Window",
        executionVehicle: ((futuresMetrics?.quadrantDay?.quadrant || futuresMetrics?.quadrant) === "LONG_BUILDUP" || eodDecision.bias === "BULLISH")
          ? "BULL_CALL_SPREAD (+ATM CE / -OTM CE) [Zero Theta Burn & Gap-Protection]"
          : ((futuresMetrics?.quadrantDay?.quadrant || futuresMetrics?.quadrant) === "SHORT_BUILDUP" || eodDecision.bias === "BEARISH")
          ? "BEAR_PUT_SPREAD (+ATM PE / -OTM PE) [Zero Theta Burn & Gap-Protection]"
          : "NEUTRAL_WAIT_FOR_125M_BREAK",
        timeHorizon: "T+2 Days (6 to 7 bars of 125m)",
        riskWarning: "Strictly avoid naked OTM option buying overnight due to binary gap risk. Spreads or Deep ITM (Delta >= 0.70) are mandatory.",
      },
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

    cacheByExpiry.set(targetExpiry.toLowerCase(), { data: payload, timestamp: now });
    if (queryExpiry) {
      cacheByExpiry.set(queryExpiry, { data: payload, timestamp: now });
    }
    if (targetExpiry === nearExpiry) {
      cacheByExpiry.set("near", { data: payload, timestamp: now });
      cacheByExpiry.set("default", { data: payload, timestamp: now });
      cache = { data: payload, timestamp: now };
    }
  } catch (err) {
    return { ok: false, stage: "nse", error: err?.message || String(err), errorObject: err };
  }

  const ticks = Array.isArray(intradayHistory) ? intradayHistory.length : 0;
  const base = { payload, ticks, targetExpiry, nearExpiry };
  if (targetExpiry !== nearExpiry) {
    // Unchanged rule: only the near-expiry payload is written to the shared snapshot.
    return { ok: true, ...base, persisted: false, persistSkippedReason: "NON_NEAR_EXPIRY_TARGET" };
  }
  if (!REDIS_URL || !REDIS_TOKEN) {
    if (awaitPersist) return { ok: false, stage: "redis", error: "Redis not configured; snapshot not persisted", ...base };
    return { ok: true, ...base, persisted: false };
  }
  if (!awaitPersist) {
    // snapshotAt marks this as a live NSE fetch; the webhook rejects snapshots older than FLOW_MAX_AGE_SEC.
    saveRedisSessionPayload(payload, { snapshotAt: now, source }).catch(() => {});
    return { ok: true, ...base, persisted: null, snapshotAt: now };
  }
  const write = await saveRedisSessionPayloadDetailed(payload, { snapshotAt: now, source });
  if (!write.ok) return { ok: false, stage: "redis", error: write.error, ...base };
  return { ok: true, ...base, persisted: true, snapshotAt: now };
}

export function getFallbackExpirySchedule() {
  const nearExpiry = getActiveExpiryDate();
  if (Array.isArray(lastKnownExpiryDates) && lastKnownExpiryDates.length >= 2) {
    const near = lastKnownExpiryDates[0] || nearExpiry;
    const next = lastKnownExpiryDates[1] || "17-Nov-2026";
    const monthly = getActiveMonthlyExpiry(lastKnownExpiryDates) || "26-Nov-2026";
    return { nearExpiry: near, nextExpiry: next, monthlyExpiry: monthly };
  }
  const istDate = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const nearDateObj = new Date(nearExpiry);
  let nextDateObj = !isNaN(nearDateObj.getTime())
    ? new Date(nearDateObj.getTime() + 7 * 86400000)
    : new Date(istDate.getTime() + 7 * 86400000);
  const d = String(nextDateObj.getDate()).padStart(2, "0");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const m = monthNames[nextDateObj.getMonth()];
  const y = nextDateObj.getFullYear();
  const nextExpiry = `${d}-${m}-${y}`;
  const monthlyExpiry = getActiveMonthlyExpiry([nearExpiry, nextExpiry, "26-Nov-2026"]) || "26-Nov-2026";
  return { nearExpiry, nextExpiry, monthlyExpiry };
}

function getFallbackData(requestedExpiry = null) {
  const spot = 25030.35;
  const { nearExpiry, nextExpiry, monthlyExpiry } = getFallbackExpirySchedule();

  let targetExpiry = nearExpiry;
  const reqLower = requestedExpiry ? String(requestedExpiry).trim().toLowerCase() : null;
  if (reqLower === "next") {
    targetExpiry = nextExpiry;
  } else if (reqLower === "monthly") {
    targetExpiry = monthlyExpiry;
  } else if (reqLower === "near" || reqLower === "today") {
    targetExpiry = nearExpiry;
  } else if (requestedExpiry && typeof requestedExpiry === "string" && reqLower !== "auto") {
    targetExpiry = requestedExpiry;
  }

  const expiryDate = targetExpiry;
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
    rollover: {
      isExpiryDay: isTodayExpiryDate(nearExpiry),
      nearExpiry,
      nextExpiry,
      monthlyExpiry,
      activeContract: targetExpiry,
      isAfternoonRollover: false,
      isEvaluatingNextExpiry: Boolean(targetExpiry === nextExpiry),
      nextExpiryMetrics: null,
    },
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