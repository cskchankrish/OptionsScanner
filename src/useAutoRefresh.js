/**
 * useAutoRefresh: keeps a view's data current without a page reload.
 *
 * - Wall-clock schedule (nextDueAt timestamp); a light 1 s ticker only recomputes the remaining
 *   seconds from Date.now() and fires the refresh once it is due, so throttled/suspended timers in
 *   background tabs cannot stall it.
 * - Refreshes at once on resume (tab visible, window focus, back online, bfcache pageshow) when
 *   the last successful refresh is at least one interval old.
 * - The latest refresh function is kept in a ref (no stale closures); an in-flight guard stops
 *   overlapping requests.
 * - `enabled` (boolean, or a function evaluated every tick) gates auto-refresh. Becoming enabled
 *   refreshes at once; becoming disabled schedules one final refresh `finalRefreshDelayMs` later
 *   (null: no final refresh).
 *
 * The refresh function may return { ok: false, error } (or throw) to report a failure.
 * Returns { remainingSec, nowMs, lastSuccessAt, lastAttemptAt, lastError, inFlight, enabled,
 * refreshNow(fn?) }. refreshNow runs fn (default: the refresh) through the same guard and
 * restarts the schedule from its completion.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  canStartRefresh,
  computeNextDueAt,
  computeRemainingSec,
  enabledTransitionAction,
  isRefreshDue,
  shouldRefreshOnResume,
} from "./autoRefreshCore.js";

export function useAutoRefresh({ refresh, intervalSec = 60, enabled = true, finalRefreshDelayMs = 20000, tickMs = 1000 }) {
  const intervalMs = Math.max(1, Number(intervalSec) || 60) * 1000;

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const enabledInputRef = useRef(enabled);
  enabledInputRef.current = enabled;
  const intervalRef = useRef(intervalMs);

  const nextDueRef = useRef(null);
  const inFlightRef = useRef(false);
  const lastSuccessRef = useRef(null);
  const prevEnabledRef = useRef(null);
  const enabledRef = useRef(false);
  const finalTimerRef = useRef(null);
  const mountedRef = useRef(false);

  const [nowMs, setNowMs] = useState(() => Date.now());
  const [remainingSec, setRemainingSec] = useState(Math.round(intervalMs / 1000));
  const [lastSuccessAt, setLastSuccessAt] = useState(null);
  const [lastAttemptAt, setLastAttemptAt] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [inFlight, setInFlight] = useState(false);
  const [enabledState, setEnabledState] = useState(false);

  const readEnabled = () => {
    const e = enabledInputRef.current;
    try {
      return typeof e === "function" ? Boolean(e()) : Boolean(e);
    } catch (err) {
      return false;
    }
  };

  const runRefresh = useCallback(async (fn) => {
    if (!canStartRefresh(inFlightRef.current)) return { ok: false, skipped: true };
    inFlightRef.current = true;
    setInFlight(true);
    let error = null;
    try {
      const target = typeof fn === "function" ? fn : refreshRef.current;
      const r = typeof target === "function" ? await target() : undefined;
      if (r && typeof r === "object" && r.ok === false) error = r.error || "refresh failed";
    } catch (e) {
      error = e?.message || String(e);
    }
    const done = Date.now();
    inFlightRef.current = false;
    nextDueRef.current = computeNextDueAt(done, intervalRef.current);
    if (!error) lastSuccessRef.current = done;
    if (mountedRef.current) {
      setInFlight(false);
      setLastAttemptAt(done);
      if (error) {
        setLastError({ message: String(error), at: done });
      } else {
        setLastSuccessAt(done);
        setLastError(null);
      }
      setNowMs(done);
      setRemainingSec(computeRemainingSec(nextDueRef.current, done));
    }
    return error ? { ok: false, error } : { ok: true };
  }, []);

  const clearFinalTimer = () => {
    if (finalTimerRef.current) {
      clearTimeout(finalTimerRef.current);
      finalTimerRef.current = null;
    }
  };

  // One evaluation: enabled transitions, due check, countdown. Called by the ticker and on changes.
  const evaluateRef = useRef(null);
  evaluateRef.current = () => {
    const now = Date.now();
    const en = readEnabled();
    const action = enabledTransitionAction(prevEnabledRef.current, en);
    prevEnabledRef.current = en;
    enabledRef.current = en;
    if (en) clearFinalTimer();
    if (action === "refresh-now") {
      runRefresh();
    } else if (action === "final-refresh" && finalRefreshDelayMs !== null) {
      clearFinalTimer();
      finalTimerRef.current = setTimeout(() => {
        finalTimerRef.current = null;
        runRefresh();
      }, finalRefreshDelayMs);
    } else if (isRefreshDue({ enabled: en, nextDueAt: nextDueRef.current, nowMs: now, inFlight: inFlightRef.current })) {
      runRefresh();
    }
    if (en && nextDueRef.current === null && !inFlightRef.current) {
      nextDueRef.current = computeNextDueAt(lastSuccessRef.current ?? now, intervalRef.current);
    }
    if (mountedRef.current) {
      setEnabledState(en);
      setNowMs(now);
      setRemainingSec(computeRemainingSec(nextDueRef.current, now));
    }
  };

  // Ticker + resume listeners (mounted once; everything they read is in refs).
  useEffect(() => {
    mountedRef.current = true;
    evaluateRef.current();
    const timer = setInterval(() => evaluateRef.current(), tickMs);

    const onResume = (ev) => {
      if (ev?.type === "visibilitychange" && typeof document !== "undefined" && document.visibilityState !== "visible") return;
      const now = Date.now();
      const en = readEnabled();
      if (shouldRefreshOnResume({ enabled: en, lastSuccessAt: lastSuccessRef.current, intervalMs: intervalRef.current, nowMs: now, inFlight: inFlightRef.current })) {
        runRefresh();
      }
      evaluateRef.current();
    };
    const hasDoc = typeof document !== "undefined";
    const hasWin = typeof window !== "undefined";
    if (hasDoc) document.addEventListener("visibilitychange", onResume);
    if (hasWin) {
      window.addEventListener("focus", onResume);
      window.addEventListener("online", onResume);
      window.addEventListener("pageshow", onResume);
    }
    return () => {
      mountedRef.current = false;
      clearInterval(timer);
      clearFinalTimer();
      if (hasDoc) document.removeEventListener("visibilitychange", onResume);
      if (hasWin) {
        window.removeEventListener("focus", onResume);
        window.removeEventListener("online", onResume);
        window.removeEventListener("pageshow", onResume);
      }
    };
  }, [tickMs, runRefresh]);

  // Interval changed (1/2/5-minute selector): restart the countdown with the new interval.
  useEffect(() => {
    if (intervalRef.current === intervalMs) return;
    intervalRef.current = intervalMs;
    const now = Date.now();
    nextDueRef.current = computeNextDueAt(now, intervalMs);
    setRemainingSec(computeRemainingSec(nextDueRef.current, now));
  }, [intervalMs]);

  // A boolean `enabled` prop change is evaluated at once (not only on the next tick).
  useEffect(() => {
    if (typeof enabled !== "function" && mountedRef.current) evaluateRef.current();
  }, [enabled]);

  const refreshNow = useCallback((fn) => runRefresh(fn), [runRefresh]);

  return {
    remainingSec,
    nowMs,
    lastSuccessAt,
    lastAttemptAt,
    lastError,
    inFlight,
    enabled: enabledState,
    intervalMs,
    refreshNow,
  };
}
