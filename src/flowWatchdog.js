/**
 * Scanner-blind watchdog.
 *
 * Called on every poll and every webhook call. During live market hours, if the last good
 * option-chain snapshot (`nifty:flow:latest`.snapshotAt) is older than FLOW_BLIND_ALERT_SEC
 * (default 180s), exactly one "scanner blind" Telegram alert is sent per outage. Dedupe is an
 * atomic SET NX on BLIND_KEY taken BEFORE sending; if the send fails the claim is released so a
 * later check can retry. When a fresh snapshot is seen again, the caller whose DEL actually
 * removed BLIND_KEY (DEL returns 1 for exactly one caller) sends a single "recovered" alert.
 *
 * Grace at session open: age is measured from max(snapshotAt, today's session open), so the
 * previous day's snapshot does not raise an alert in the first FLOW_BLIND_ALERT_SEC of a session.
 *
 * All I/O is injected; this module never throws to its caller.
 */

export const BLIND_KEY = "nifty:watchdog:blind";
const BLIND_KEY_TTL_SEC = 86400;
const IST_OFFSET_MIN = 330;

export function getFlowBlindAlertSec() {
  const v = Number(process.env.FLOW_BLIND_ALERT_SEC);
  return Number.isFinite(v) && v > 0 ? v : 180;
}

/** Epoch ms of today's session open in IST (Sun 14:00 Muhurat, otherwise 09:15). */
export function getSessionOpenMs(nowMs) {
  const istMs = nowMs + IST_OFFSET_MIN * 60000;
  const ist = new Date(istMs);
  const openMins = ist.getUTCDay() === 0 ? 840 : 555;
  const istMidnight = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  return istMidnight + openMins * 60000 - IST_OFFSET_MIN * 60000;
}

function fmtAge(sec) {
  if (!Number.isFinite(sec)) return "unknown";
  if (sec < 120) return `${Math.round(sec)}s`;
  return `${Math.round(sec / 60)}m`;
}

/**
 * @param {object} args
 * @param {number|null} args.snapshotAt epoch ms of the last good snapshot (null if unknown/missing)
 * @param {boolean} args.isLiveMarket
 * @param {number} [args.nowMs]
 * @param {string} [args.trigger] "poll" | "webhook" (for the alert text)
 * @param {string|null} [args.lastError] reason the current refresh/poll failed, if any
 * @param {number} [args.thresholdSec]
 * @param {{ setNx: Function, del: Function, send: Function }} args.deps
 *   setNx(key, value, ttlSec) -> boolean (throws on Redis error)
 *   del(key) -> number of keys removed
 *   send(text) -> boolean
 */
export async function checkFlowWatchdog({
  snapshotAt,
  isLiveMarket,
  nowMs = Date.now(),
  trigger = "poll",
  lastError = null,
  thresholdSec = getFlowBlindAlertSec(),
  deps,
}) {
  try {
    if (!isLiveMarket) return { status: "OUTSIDE_SESSION", sent: false };
    const at = Number(snapshotAt);
    const hasSnapshot = Number.isFinite(at) && at > 0;
    const rawAgeSec = hasSnapshot ? Math.max(0, (nowMs - at) / 1000) : Infinity;
    const sinceOpenSec = Math.max(0, (nowMs - getSessionOpenMs(nowMs)) / 1000);
    const ageSec = Math.min(rawAgeSec, sinceOpenSec);

    if (ageSec > thresholdSec) {
      let claimed = false;
      try {
        claimed = await deps.setNx(
          BLIND_KEY,
          { since: new Date(nowMs).toISOString(), snapshotAt: hasSnapshot ? at : null, trigger },
          BLIND_KEY_TTL_SEC
        );
      } catch (e) {
        // Without the dedupe key we cannot guarantee once-per-outage, so stay quiet.
        return { status: "CLAIM_ERROR", sent: false, ageSec: rawAgeSec, error: e?.message };
      }
      if (!claimed) return { status: "BLIND_ALREADY_ALERTED", sent: false, ageSec: rawAgeSec };
      const text = [
        `🛑 *SCANNER BLIND* · option-chain snapshot is ${hasSnapshot ? fmtAge(rawAgeSec) : "missing"} old (threshold ${thresholdSec}s)`,
        `• *Last good snapshot:* ${hasSnapshot ? new Date(at).toISOString() : "none"}`,
        `• *Detected by:* ${trigger}`,
        lastError ? `• *Last error:* ${String(lastError).slice(0, 300)}` : null,
        `• *Effect:* actionable TradingView signals will be vetoed as stale until the poller recovers.`,
      ].filter(Boolean).join("\n");
      let sent = false;
      try {
        sent = await deps.send(text);
      } catch (e) {
        sent = false;
      }
      if (!sent) {
        try { await deps.del(BLIND_KEY); } catch (e) { /* best effort */ }
        return { status: "BLIND_SEND_FAILED_RELEASED", sent: false, ageSec: rawAgeSec };
      }
      return { status: "BLIND_ALERTED", sent: true, ageSec: rawAgeSec };
    }

    // Inside the session-open grace window without a genuinely fresh snapshot: neither alert nor recover.
    if (rawAgeSec > thresholdSec) return { status: "SESSION_OPEN_GRACE", sent: false, ageSec: rawAgeSec };

    // Fresh: if an outage was flagged, exactly one caller removes the key and reports recovery.
    let removed = 0;
    try {
      removed = Number(await deps.del(BLIND_KEY)) || 0;
    } catch (e) {
      return { status: "FRESH", sent: false, ageSec: rawAgeSec };
    }
    if (removed < 1) return { status: "FRESH", sent: false, ageSec: rawAgeSec };
    const text = [
      `✅ *SCANNER RECOVERED* · fresh option-chain snapshot (age ${fmtAge(rawAgeSec)})`,
      `• *Snapshot time:* ${new Date(at).toISOString()}`,
      `• *Detected by:* ${trigger}`,
    ].join("\n");
    let sent = false;
    try {
      sent = await deps.send(text);
    } catch (e) {
      sent = false;
    }
    return { status: "RECOVERED", sent: Boolean(sent), ageSec: rawAgeSec };
  } catch (e) {
    return { status: "WATCHDOG_ERROR", sent: false, error: e?.message };
  }
}
