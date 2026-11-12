/**
 * Collector alerts (12-Nov-2026): the per-minute poller stopped at 11:38 and nothing alerted,
 * because the blind watchdog only runs when a poll arrives and browser refreshes kept the
 * snapshot fresh. Two checks, both DI'd and never throwing:
 *
 *  1. alertNewGaps — once a refresh closes a hole of ≥ DQ_GAP_ALERT_MIN minutes in today's
 *     timeline, send ONE Telegram per gap ("scanner missed ticks hh:mm–hh:mm; history-based
 *     panels are marked"). Atomic SET NX per gap, released if the send fails.
 *  2. checkPollerHeartbeat — run on refreshes that did NOT come from the poller (browser,
 *     webhook): if the poller's last success (nifty:poller:last_ok) is older than
 *     POLLER_DOWN_ALERT_SEC during the live session, send ONE "poller down" alert per outage
 *     (SET NX on POLLER_DOWN_KEY). The poll handler deletes the key on its next success and the
 *     caller whose DEL removed it sends "poller recovered" (see notePollerSuccess).
 */
import { DQ_GAP_ALERT_MIN, hhmm } from "./dataQuality.js";
import { getSessionOpenMs } from "./flowWatchdog.js";

export const POLLER_DOWN_KEY = "nifty:watchdog:poller_down";
export const gapAlertKey = (date, fromMins) => `nifty:dq:gap_alert:${date}:${hhmm(fromMins)}`;
const DAY_SEC = 86400;

export function getPollerDownAlertSec(env = process.env) {
  const v = Number(env.POLLER_DOWN_ALERT_SEC);
  return Number.isFinite(v) && v > 0 ? v : 180;
}

/**
 * @param {{ dataQuality: object, istDateStr: string, deps: { setNx, del, send } }} p
 *   dataQuality must carry `_gapMins` (from computeDataQuality).
 * @returns {Promise<string[]>} gaps alerted ("hh:mm–hh:mm")
 */
export async function alertNewGaps({ dataQuality, istDateStr, deps }) {
  const sent = [];
  try {
    const gaps = (dataQuality?._gapMins || []).filter((g) => g.minutes >= DQ_GAP_ALERT_MIN && !g.ongoing);
    for (const g of gaps) {
      const key = gapAlertKey(istDateStr, g.fromMins);
      let claimed = false;
      try {
        claimed = await deps.setNx(key, { at: Date.now(), to: hhmm(g.toMins) }, 2 * DAY_SEC);
      } catch (e) {
        return sent; // no dedupe possible: stay quiet
      }
      if (!claimed) continue;
      const text = [
        `⚠️ *Scanner missed ticks ${hhmm(g.fromMins)}–${hhmm(g.toMins)} IST* (${g.minutes} min without a reading)`,
        `• History-based panels (30-min radar, closing flow, rolling quadrant, reversal) are marked "not enough data" for windows that include this gap.`,
        `• Coverage today: ${dataQuality.coveragePct ?? "?"}% (${dataQuality.ticksToday ?? "?"}/${dataQuality.expectedTicks ?? "?"} ticks).`,
      ].join("\n");
      let ok = false;
      try { ok = await deps.send(text); } catch (e) { ok = false; }
      if (!ok) {
        try { await deps.del(key); } catch (e) { /* best effort */ }
        continue;
      }
      sent.push(`${hhmm(g.fromMins)}–${hhmm(g.toMins)}`);
    }
  } catch (e) {
    /* never throw */
  }
  return sent;
}

function fmtAge(sec) {
  if (!Number.isFinite(sec)) return "unknown";
  return sec < 120 ? `${Math.round(sec)}s` : `${Math.round(sec / 60)}m`;
}

/**
 * @param {{ nowMs: number, isLiveMarket: boolean, trigger: string, thresholdSec?: number,
 *   deps: { getHeartbeat: () => Promise<{at:string, source?:string}|null>, setNx, send, del } }} p
 */
export async function checkPollerHeartbeat({ nowMs, isLiveMarket, trigger, thresholdSec = getPollerDownAlertSec(), deps }) {
  try {
    if (!isLiveMarket) return { status: "OUTSIDE_SESSION", sent: false };
    let hb = null;
    try { hb = await deps.getHeartbeat(); } catch (e) { return { status: "HEARTBEAT_READ_ERROR", sent: false }; }
    const at = hb?.at ? Date.parse(hb.at) : NaN;
    const rawAgeSec = Number.isFinite(at) ? Math.max(0, (nowMs - at) / 1000) : Infinity;
    const sinceOpenSec = Math.max(0, (nowMs - getSessionOpenMs(nowMs)) / 1000);
    const ageSec = Math.min(rawAgeSec, sinceOpenSec);
    if (ageSec <= thresholdSec) return { status: "POLLER_OK", sent: false, ageSec: rawAgeSec };
    let claimed = false;
    try {
      claimed = await deps.setNx(POLLER_DOWN_KEY, { since: new Date(nowMs).toISOString(), lastOk: hb?.at ?? null, trigger }, DAY_SEC);
    } catch (e) {
      return { status: "CLAIM_ERROR", sent: false };
    }
    if (!claimed) return { status: "POLLER_DOWN_ALREADY_ALERTED", sent: false, ageSec: rawAgeSec };
    const text = [
      `🛑 *POLLER DOWN* · no successful /api/poll for ${Number.isFinite(rawAgeSec) ? fmtAge(rawAgeSec) : "the whole session"} (threshold ${thresholdSec}s)`,
      `• *Last poller success:* ${hb?.at ?? "none"}${hb?.source ? ` (source ${hb.source})` : ""}`,
      `• *Noticed by:* ${trigger} refresh — the scanner only updates when someone opens it, so history-based panels will show gaps.`,
      `• Check the VM poller / QStash schedule.`,
    ].join("\n");
    let ok = false;
    try { ok = await deps.send(text); } catch (e) { ok = false; }
    if (!ok) {
      try { await deps.del(POLLER_DOWN_KEY); } catch (e) { /* best effort */ }
      return { status: "POLLER_DOWN_SEND_FAILED_RELEASED", sent: false };
    }
    return { status: "POLLER_DOWN_ALERTED", sent: true, ageSec: rawAgeSec };
  } catch (e) {
    return { status: "ERROR", sent: false, error: e?.message };
  }
}

/** Called by the poll handler after a successful poll: one "recovered" alert per outage. */
export async function notePollerSuccess({ source, deps }) {
  try {
    const removed = Number(await deps.del(POLLER_DOWN_KEY)) || 0;
    if (removed < 1) return { status: "OK", sent: false };
    const ok = await deps.send(`✅ *POLLER RECOVERED* · /api/poll succeeded again (source ${source}).`);
    return { status: "RECOVERED", sent: Boolean(ok) };
  } catch (e) {
    return { status: "ERROR", sent: false };
  }
}
