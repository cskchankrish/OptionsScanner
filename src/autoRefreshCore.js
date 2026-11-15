/**
 * Pure scheduling decisions for the dashboard auto-refresh (src/useAutoRefresh.js).
 *
 * The schedule is driven by wall-clock time: a refresh is due when Date.now() >= nextDueAt.
 * Browsers throttle or suspend timers in background tabs and on a locked phone, so a tick
 * counter stalls; comparing timestamps does not. No React, no DOM: unit-tested with node:test.
 */

/** Epoch ms of the next refresh, `intervalMs` after `fromMs`. */
export function computeNextDueAt(fromMs, intervalMs) {
  return Number(fromMs) + Math.max(0, Number(intervalMs) || 0);
}

/** Whole seconds until nextDueAt (rounded up), never negative; 0 when nothing is scheduled. */
export function computeRemainingSec(nextDueAt, nowMs) {
  if (nextDueAt === null || nextDueAt === undefined || !Number.isFinite(Number(nextDueAt))) return 0;
  return Math.max(0, Math.ceil((Number(nextDueAt) - Number(nowMs)) / 1000));
}

/** In-flight guard: a new refresh may start only when none is running. */
export function canStartRefresh(inFlight) {
  return !inFlight;
}

/** True when the scheduled refresh is due now (auto-refresh enabled, nothing in flight). */
export function isRefreshDue({ enabled, nextDueAt, nowMs, inFlight = false }) {
  if (!enabled || !canStartRefresh(inFlight)) return false;
  if (nextDueAt === null || nextDueAt === undefined) return false;
  return Number(nowMs) >= Number(nextDueAt);
}

/**
 * On a resume event (tab visible again, window focus, back online, bfcache restore): refresh at
 * once when the last successful refresh is at least one interval old (or there never was one).
 */
export function shouldRefreshOnResume({ enabled, lastSuccessAt, intervalMs, nowMs, inFlight = false }) {
  if (!enabled || !canStartRefresh(inFlight)) return false;
  if (lastSuccessAt === null || lastSuccessAt === undefined) return true;
  return Number(nowMs) - Number(lastSuccessAt) >= Number(intervalMs);
}

/**
 * What to do when the "auto-refresh active" flag changes (e.g. the market session opens/closes).
 * prev === null is the first evaluation after mount: nothing to do (the page loads on mount).
 * Returns "refresh-now" (became active), "final-refresh" (became inactive: one last refresh
 * shortly after so the settled numbers are shown) or "none".
 */
export function enabledTransitionAction(prevEnabled, enabled) {
  if (prevEnabled === null || prevEnabled === undefined) return "none";
  if (!prevEnabled && enabled) return "refresh-now";
  if (prevEnabled && !enabled) return "final-refresh";
  return "none";
}

/** "45s", "4m 05s", "2h 03m". */
export function formatAge(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** HH:MM:SS in IST for an epoch-ms instant. */
export function formatIstClock(ms) {
  return new Date(Number(ms) + 330 * 60000).toISOString().slice(11, 19);
}

/**
 * Data freshness for display. `live` = market session active (stale/failed states are flagged
 * only then). lastError = { message, at } of the most recent failed attempt, or null.
 * level: "pending" (no data yet), "fresh", "stale" (amber: no successful refresh for more than
 * twice the interval) or "error" (red: the last attempt failed).
 */
export function getFreshnessState({ nowMs, lastSuccessAt, lastError, intervalMs, live }) {
  const hasSuccess = lastSuccessAt !== null && lastSuccessAt !== undefined;
  const ageSec = hasSuccess ? Math.max(0, Math.floor((Number(nowMs) - Number(lastSuccessAt)) / 1000)) : null;
  const failed = Boolean(lastError) && (!hasSuccess || Number(lastError.at) >= Number(lastSuccessAt));
  const tooOld = hasSuccess && Number(nowMs) - Number(lastSuccessAt) > 2 * Number(intervalMs);
  const reasons = [];
  if (live && failed) reasons.push(`last refresh failed${lastError?.message ? ` (${lastError.message})` : ""}`);
  if (live && tooOld) reasons.push(`no successful update for ${formatAge(ageSec)}`);
  let level = "fresh";
  if (live && failed) level = "error";
  else if (live && tooOld) level = "stale";
  else if (!hasSuccess) level = "pending";
  return {
    level,
    ageSec,
    updatedAtIst: hasSuccess ? formatIstClock(lastSuccessAt) : null,
    failed,
    tooOld,
    reason: reasons.join(" · "),
  };
}
