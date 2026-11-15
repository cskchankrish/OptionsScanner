/**
 * Dashboard auto-refresh: pure scheduling decisions (src/autoRefreshCore.js) and the
 * "is the market session live now" calendar helper (src/marketCalendar.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  canStartRefresh,
  computeNextDueAt,
  computeRemainingSec,
  enabledTransitionAction,
  formatAge,
  formatIstClock,
  getFreshnessState,
  isRefreshDue,
  shouldRefreshOnResume,
} from "../src/autoRefreshCore.js";
import { isSessionLiveNow } from "../src/marketCalendar.js";

delete process.env.MUHURAT_DATES;

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 13, 5, 0, 0); // Fri 2026-11-13 10:30 IST

/** Epoch ms for an IST wall-clock time. */
const ist = (date, hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return Date.parse(`${date}T00:00:00Z`) + (h * 60 + m) * MIN - 330 * MIN;
};

test("due / not due", () => {
  const next = computeNextDueAt(T0, 60_000);
  assert.equal(next, T0 + 60_000);
  assert.equal(isRefreshDue({ enabled: true, nextDueAt: next, nowMs: T0 + 59_999 }), false);
  assert.equal(isRefreshDue({ enabled: true, nextDueAt: next, nowMs: T0 + 60_000 }), true);
  assert.equal(isRefreshDue({ enabled: true, nextDueAt: next, nowMs: T0 + 3_600_000 }), true, "long overdue is still due");
  assert.equal(isRefreshDue({ enabled: false, nextDueAt: next, nowMs: T0 + 60_000 }), false, "disabled never due");
  assert.equal(isRefreshDue({ enabled: true, nextDueAt: null, nowMs: T0 }), false, "nothing scheduled");
});

test("remaining seconds: rounded up, never negative", () => {
  assert.equal(computeRemainingSec(T0 + 60_000, T0), 60);
  assert.equal(computeRemainingSec(T0 + 60_000, T0 + 500), 60);
  assert.equal(computeRemainingSec(T0 + 60_000, T0 + 59_001), 1);
  assert.equal(computeRemainingSec(T0 + 60_000, T0 + 60_000), 0);
  assert.equal(computeRemainingSec(T0 + 60_000, T0 + 10 * 60_000), 0, "suspended past due => 0, not negative");
  assert.equal(computeRemainingSec(null, T0), 0);
});

test("resume after a long suspension triggers an immediate refresh; fresh data does not", () => {
  const lastSuccessAt = T0;
  // Phone locked for 25 minutes.
  assert.equal(shouldRefreshOnResume({ enabled: true, lastSuccessAt, intervalMs: 60_000, nowMs: T0 + 25 * MIN }), true);
  // Exactly one interval old counts as due.
  assert.equal(shouldRefreshOnResume({ enabled: true, lastSuccessAt, intervalMs: 60_000, nowMs: T0 + 60_000 }), true);
  // Tab switched away for 10 s: data is fresh, no refresh.
  assert.equal(shouldRefreshOnResume({ enabled: true, lastSuccessAt, intervalMs: 60_000, nowMs: T0 + 10_000 }), false);
  // Never refreshed yet: refresh.
  assert.equal(shouldRefreshOnResume({ enabled: true, lastSuccessAt: null, intervalMs: 60_000, nowMs: T0 }), true);
  // Market closed (auto-refresh disabled): no refresh on resume.
  assert.equal(shouldRefreshOnResume({ enabled: false, lastSuccessAt, intervalMs: 60_000, nowMs: T0 + 25 * MIN }), false);
});

test("in-flight guard: no new refresh while one is running", () => {
  assert.equal(canStartRefresh(false), true);
  assert.equal(canStartRefresh(true), false);
  assert.equal(isRefreshDue({ enabled: true, nextDueAt: T0, nowMs: T0 + 1000, inFlight: true }), false);
  assert.equal(shouldRefreshOnResume({ enabled: true, lastSuccessAt: T0, intervalMs: 60_000, nowMs: T0 + 25 * MIN, inFlight: true }), false);
});

test("session transitions: open => refresh now, close => one final refresh, first evaluation => nothing", () => {
  assert.equal(enabledTransitionAction(null, true), "none");
  assert.equal(enabledTransitionAction(null, false), "none");
  assert.equal(enabledTransitionAction(false, true), "refresh-now");
  assert.equal(enabledTransitionAction(true, false), "final-refresh");
  assert.equal(enabledTransitionAction(true, true), "none");
  assert.equal(enabledTransitionAction(false, false), "none");
});

test("freshness: fresh, stale after 2x interval, failed attempt, quiet outside market hours", () => {
  const base = { lastSuccessAt: T0, intervalMs: 60_000, live: true, lastError: null };
  const fresh = getFreshnessState({ ...base, nowMs: T0 + 30_000 });
  assert.equal(fresh.level, "fresh");
  assert.equal(fresh.ageSec, 30);
  assert.equal(fresh.updatedAtIst, "10:30:00");
  assert.equal(getFreshnessState({ ...base, nowMs: T0 + 120_000 }).level, "fresh", "exactly 2x is not yet stale");
  const stale = getFreshnessState({ ...base, nowMs: T0 + 121_000 });
  assert.equal(stale.level, "stale");
  assert.match(stale.reason, /no successful update for 2m 01s/);
  const failed = getFreshnessState({ ...base, nowMs: T0 + 70_000, lastError: { message: "HTTP 504", at: T0 + 65_000 } });
  assert.equal(failed.level, "error");
  assert.match(failed.reason, /last refresh failed \(HTTP 504\)/);
  // An error older than the last success is not the current state.
  assert.equal(getFreshnessState({ ...base, nowMs: T0 + 30_000, lastError: { message: "x", at: T0 - 1000 } }).level, "fresh");
  // Outside market hours: never flagged.
  assert.equal(getFreshnessState({ ...base, live: false, nowMs: T0 + 10 * 3_600_000, lastError: { message: "x", at: T0 + 1 } }).level, "fresh");
  assert.equal(getFreshnessState({ ...base, lastSuccessAt: null, nowMs: T0 }).level, "pending");
  assert.equal(formatAge(45), "45s");
  assert.equal(formatAge(245), "4m 05s");
  assert.equal(formatAge(7380), "2h 03m");
  assert.equal(formatIstClock(T0 + 12_345), "10:30:12");
});

test("isSessionLiveNow: weekday 09:15-15:40 IST inclusive", () => {
  const fri = "2026-11-13";
  assert.equal(isSessionLiveNow(ist(fri, "09:14")), false);
  assert.equal(isSessionLiveNow(ist(fri, "09:15")), true);
  assert.equal(isSessionLiveNow(ist(fri, "12:00")), true);
  assert.equal(isSessionLiveNow(ist(fri, "15:40")), true);
  assert.equal(isSessionLiveNow(ist(fri, "15:41")), false);
  assert.equal(isSessionLiveNow(ist("2026-11-16", "09:15")), true, "Monday");
});

test("isSessionLiveNow: ordinary weekend closed; Muhurat 2026-11-08 live 14:00-16:00 only", () => {
  assert.equal(isSessionLiveNow(ist("2026-11-15", "10:00")), false, "ordinary Sunday");
  assert.equal(isSessionLiveNow(ist("2026-11-15", "14:30")), false, "ordinary Sunday, Muhurat hours");
  assert.equal(isSessionLiveNow(ist("2026-11-14", "10:00")), false, "Saturday");
  const muhurat = "2026-11-08";
  assert.equal(isSessionLiveNow(ist(muhurat, "10:00")), false, "Muhurat Sunday morning");
  assert.equal(isSessionLiveNow(ist(muhurat, "13:59")), false);
  assert.equal(isSessionLiveNow(ist(muhurat, "14:00")), true);
  assert.equal(isSessionLiveNow(ist(muhurat, "16:00")), true);
  assert.equal(isSessionLiveNow(ist(muhurat, "16:01")), false);
});
