/**
 * Overnight carry bridge (BTST / STBT) — scanner side.
 *
 * Near the close the scanner may instruct the Algo to place ONE overnight carry trade per IST date
 * (CARRY_ENTRY, same endpoint / headers / HMAC as FLOW_ENTRY). The carry is tracked in its own Redis
 * key (`nifty:carry:active`, no expiry while open) and never blocks intraday signal validation.
 *
 * Everything is dependency-injected through a small store adapter:
 *   store = { get(k) -> parsed|null (throws on Redis error), set(k, v, ttlSec|null), setNx(k, v, ttlSec) -> bool,
 *             del(k), lpush(k, v), ltrim(k, start, stop) }
 * and deps = { env, now, fetchImpl, sendText, newId }.
 *
 * See docs/flow-bridge.md ("Overnight carry").
 */
import { randomBytes } from "node:crypto";
import { getFlowBridgeConfig, dispatchFlowEntry, getFillWaitSec } from "./flowBridge.js";
import { parseAlgoPnl, algoPnlLines, indexMovePts } from "./algoPnl.js";

export const CARRY_ACTIVE_KEY = "nifty:carry:active";
export const CARRY_HISTORY_KEY = "nifty:carry:history";
export const carryPollsKey = (date) => `nifty:carry:polls:${date}`;
export const carryClaimKey = (date) => `nifty:carry:claim:${date}`;
export const carryBlockKey = (date) => `nifty:carry:lastblock:${date}`;
export const carryReportKey = (date) => `nifty:carry:report:${date}`;
export const carryFailedKey = (id) => `nifty:carry:failed:${id}`;
export const carryExitedKey = (id) => `nifty:carry:exited:${id}`;
export const carryStuckKey = (id) => `nifty:carry:stuck_alert:${id}`;

export const CARRY_SYNC_GRADES = ["CARRY_FILLED", "CARRY_FAILED", "CARRY_EXIT"];
export const CARRY_OWNED_STATUSES = ["PENDING", "ACCEPTED", "UNKNOWN", "FILLED"];
const CARRY_REPORTABLE = ["PENDING", "ACCEPTED", "UNKNOWN"];
const DAY_SEC = 86400;
const MARKER_TTL_SEC = 14 * DAY_SEC;

const parseHHMM = (v, dflt) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? "").trim());
  if (!m) return dflt;
  const mins = Number(m[1]) * 60 + Number(m[2]);
  return mins >= 0 && mins < 1440 ? mins : dflt;
};
const posNum = (v, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};
export const minsToHHMM = (m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function getCarryConfig(env = process.env) {
  const flow = getFlowBridgeConfig({ ...env, FLOW_BRIDGE_ENABLED: "true" }); // URL + secret presence only
  const flag = String(env.CARRY_BRIDGE_ENABLED || "").trim().toLowerCase() === "true";
  return {
    enabled: flag && flow.enabled,
    flag,
    flowConfigPresent: flow.enabled,
    url: flow.url,
    secret: flow.secret,
    timeoutMs: flow.timeoutMs,
    windowStartMins: parseHHMM(env.CARRY_WINDOW_START, 931), // 15:31 IST
    windowEndMins: parseHHMM(env.CARRY_WINDOW_END, 937), // 15:37 IST
    reportMins: parseHHMM(env.CARRY_REPORT_TIME, 938), // 15:38 IST
    requiredPolls: Math.max(1, Math.round(posNum(env.CARRY_REQUIRED_POLLS, 3))),
    minAgreement: posNum(env.CARRY_MIN_AGREEMENT, 65),
    minPollGapSec: posNum(env.CARRY_MIN_POLL_GAP_SEC, 30),
    maxAgeSec: posNum(env.FLOW_MAX_AGE_SEC, 900), // same rule as signal validation
    fillWaitSec: getFillWaitSec(env),
  };
}

/** Public-safe view of the carry settings (no URL, no secret). */
export function describeCarryConfig(cfg) {
  return {
    enabled: cfg.enabled,
    flag: cfg.flag,
    flowConfigPresent: cfg.flowConfigPresent,
    window: `${minsToHHMM(cfg.windowStartMins)}–${minsToHHMM(cfg.windowEndMins)} IST`,
    notSentReportAt: `${minsToHHMM(cfg.reportMins)} IST`,
    requiredPolls: cfg.requiredPolls,
    minAgreement: cfg.minAgreement,
    minPollGapSec: cfg.minPollGapSec,
    maxSnapshotAgeSec: cfg.maxAgeSec,
    fillWaitSec: cfg.fillWaitSec,
    dispatchTimeoutMs: cfg.timeoutMs,
  };
}

/** Same mapping the EOD flip alerts use (getEodCarryCategory). */
export function carryCategory(eodDecision) {
  if (eodDecision?.bias === "BULLISH") return "BTST";
  if (eodDecision?.bias === "BEARISH") return "STBT";
  return "NO_CARRY";
}

export function agreementValue(eodDecision) {
  const v = eodDecision?.agreement?.value ?? eodDecision?.conviction;
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
/** Parses NSE's option-chain timestamp "12-Nov-2026 15:30:00" (IST) to epoch ms, or null. */
export function parseNseTimestamp(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(s ?? "").trim());
  if (!m) return null;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return null;
  return Date.UTC(Number(m[3]), mon, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] || 0)) - 5.5 * 3600 * 1000;
}

export const newCarryId = (nowMs = Date.now()) => `ct-${nowMs}-${randomBytes(4).toString("hex")}`;

function mdSafe(v) {
  return String(v ?? "").replace(/[*_`[\]]/g, "").slice(0, 300);
}

async function say(deps, text) {
  try { await deps.sendText(text); } catch (e) { /* Telegram failures never change state */ }
}

/** Short summary of an open carry for other messages / status views. */
export function summarizeCarry(t) {
  if (!t) return null;
  return {
    id: t.id, verdict: t.verdict, dir: t.dir, status: t.execution?.status ?? null,
    spot: t.spot, sl: t.sl, contract: t.execution?.contract ?? null, optionFill: t.execution?.optionFill ?? null,
    date: t.date, sentAt: t.sentAt,
  };
}

export function isCarryOpen(t) {
  return Boolean(t && CARRY_OWNED_STATUSES.includes(t.execution?.status));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Stuck-ACCEPTED guard (one Telegram per carry id)
// ─────────────────────────────────────────────────────────────────────────────
export async function checkCarryStuck({ store, deps, cfg }) {
  try {
    const t = await store.get(CARRY_ACTIVE_KEY);
    if (!t || t.execution?.status !== "ACCEPTED") return false;
    const at = Date.parse(t.execution.at);
    const nowMs = deps.now();
    if (!Number.isFinite(at) || nowMs - at <= cfg.fillWaitSec * 1000) return false;
    if (!(await store.setNx(carryStuckKey(t.id), { at: new Date(nowMs).toISOString() }, MARKER_TTL_SEC))) return false;
    await say(deps, [
      `🚨 *NO CARRY FILL REPORT FROM ALGO — CHECK THE BROKER* 🚨`,
      `• Carry \`${t.verdict}\` (${t.dir}) · Trade ID \`${t.id}\``,
      `• Accepted ${Math.round((nowMs - at) / 1000)}s ago (limit ${cfg.fillWaitSec}s) with no CARRY\\_FILLED / CARRY\\_FAILED.`,
      `• State unchanged. This alert is sent once.`,
    ].join("\n"));
    return true;
  } catch (e) {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Dispatcher — called on every poll from the EOD radar call site
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {number} p.istMinutes  IST minutes of this poll
 * @param {string} p.istDateStr  IST date YYYY-MM-DD
 * @param {number} p.dayOfWeek   0=Sun … 6=Sat
 * @param {object} p.eodDecision this poll's EOD decision
 * @param {number|null} p.spot   NSE underlyingValue of this poll (null if NSE did not send one)
 * @param {string|null} p.dataTimestamp NSE option-chain timestamp string (raw, no fallback)
 * @param {number|null} [p.deadlineMs] absolute deadline of the enclosing request, if any
 */
export async function runCarryDispatch({ istMinutes, istDateStr, dayOfWeek, eodDecision, spot, dataTimestamp, deadlineMs = null, store, deps }) {
  const cfg = getCarryConfig(deps.env());
  if (!cfg.enabled) return { status: "DISABLED" };
  if (!store) return { status: "NO_REDIS" };

  await checkCarryStuck({ store, deps, cfg });

  const nowMs = deps.now();
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  // 15:38 "nothing was sent" report (once per date).
  if (istMinutes >= cfg.reportMins && istMinutes <= cfg.reportMins + 2) {
    if (!isWeekday) return { status: "NOT_A_SESSION" };
    try {
      if (await store.get(carryClaimKey(istDateStr))) return { status: "REPORT_NOT_NEEDED" };
      const block = await store.get(carryBlockKey(istDateStr));
      if (!(await store.setNx(carryReportKey(istDateStr), { at: new Date(nowMs).toISOString() }, 3 * DAY_SEC))) {
        return { status: "REPORT_ALREADY_SENT" };
      }
      const why = block?.reason || `no poll ran inside ${minsToHHMM(cfg.windowStartMins)}–${minsToHHMM(cfg.windowEndMins)} IST`;
      await say(deps, `🌙 *Carry: nothing sent today* (${istDateStr}) — ${mdSafe(why)}${block?.at ? ` (last check ${mdSafe(block.time)} IST)` : ""}`);
      return { status: "REPORT_SENT", reason: why };
    } catch (e) {
      return { status: "REPORT_ERROR", error: e?.message };
    }
  }

  if (istMinutes < cfg.windowStartMins || istMinutes > cfg.windowEndMins) return { status: "OUTSIDE_WINDOW" };

  const category = carryCategory(eodDecision);
  const agreement = agreementValue(eodDecision);
  const score = Number.isFinite(Number(eodDecision?.score)) ? Number(eodDecision.score) : null;
  const timeStr = minsToHHMM(Math.floor(istMinutes));

  let polls;
  try {
    // Rolling record of this date's in-window polls (polls closer than minPollGapSec replace the last one).
    polls = (await store.get(carryPollsKey(istDateStr))) || [];
    if (!Array.isArray(polls)) polls = [];
    const obs = { at: new Date(nowMs).toISOString(), time: timeStr, category, score, agreement };
    const last = polls[polls.length - 1];
    if (last && nowMs - Date.parse(last.at) < cfg.minPollGapSec * 1000) polls[polls.length - 1] = { ...obs, at: last.at };
    else polls.push(obs);
    polls = polls.slice(-10);
    await store.set(carryPollsKey(istDateStr), polls, 2 * DAY_SEC);
  } catch (e) {
    return { status: "NO_REDIS", error: e?.message };
  }

  const block = async (reason) => {
    try { await store.set(carryBlockKey(istDateStr), { reason, time: timeStr, at: new Date(nowMs).toISOString() }, 2 * DAY_SEC); } catch (e) {}
    return { status: "BLOCKED", reason };
  };

  if (!isWeekday) return block("not a regular weekday session");
  if (category !== "BTST" && category !== "STBT") return block(`EOD verdict is ${category}`);
  // Never carry on a verdict built on missing data (12-Nov data-quality rule).
  const unverified = Array.isArray(eodDecision?.unverifiedGroups) ? eodDecision.unverifiedGroups : [];
  if (unverified.length) {
    return block(`EOD group(s) ${unverified.join(", ")} UNVERIFIED (not enough data)${eodDecision.dataQualityCaveat ? ` — ${String(eodDecision.dataQualityCaveat).replace(/^⚠️ Data caveat: /, "").slice(0, 200)}` : ""}`);
  }
  const lastN = polls.slice(-cfg.requiredPolls);
  if (lastN.length < cfg.requiredPolls || !lastN.every((p) => p.category === category)) {
    return block(`${category} not stable on the last ${cfg.requiredPolls} polls (${lastN.map((p) => `${p.time} ${p.category}`).join(", ") || "none"})`);
  }
  if (agreement === null || agreement < cfg.minAgreement) return block(`agreement ${agreement ?? "n/a"} < ${cfg.minAgreement}`);
  const ref = Number(spot);
  if (!(Number.isFinite(ref) && ref > 0)) return block("no real NSE spot in this poll");
  const dataMs = parseNseTimestamp(dataTimestamp);
  if (dataMs === null) return block(`option-chain timestamp unreadable (${dataTimestamp ?? "missing"})`);
  const ageSec = Math.round((nowMs - dataMs) / 1000);
  if (ageSec > cfg.maxAgeSec || ageSec < -60) return block(`option-chain snapshot not fresh (age ${ageSec}s > ${cfg.maxAgeSec}s)`);
  const dir = category === "BTST" ? "LONG" : "SHORT";
  const sl = Number(eodDecision?.stopLoss);
  if (!(Number.isFinite(sl) && sl > 0)) return block("EOD decision has no stop level");
  if (dir === "LONG" ? !(sl < ref) : !(sl > ref)) {
    return block(`stop ${sl} is on the wrong side of reference ${ref} for ${dir}`);
  }
  let timeoutMs = cfg.timeoutMs;
  // Inside the poller the refresh core has a deadline (start + 12s; function cap 15s). Keep ~4.5s
  // after the dispatch for the outcome write, the two Telegram messages (sent in parallel, 3s
  // client timeout) and the snapshot write. If that does not fit, skip: the next poll can send.
  if (Number.isFinite(deadlineMs)) timeoutMs = Math.min(timeoutMs, deadlineMs - Date.now() - 4500);
  if (timeoutMs < 1000) return block("not enough request time left to dispatch");

  try {
    const open = await store.get(CARRY_ACTIVE_KEY);
    if (isCarryOpen(open)) return block(`previous carry ${open.id} is still open (${open.execution.status})`);
  } catch (e) {
    return block("could not read the open-carry state");
  }

  // One dispatch per IST date: claimed before sending, never released after a send attempt.
  const id = deps.newId(nowMs);
  let claimed = false;
  try {
    claimed = await store.setNx(carryClaimKey(istDateStr), { id, at: new Date(nowMs).toISOString() }, 3 * DAY_SEC);
  } catch (e) {
    return block("could not take the daily dispatch claim (Redis)");
  }
  if (!claimed) return { status: "ALREADY_DISPATCHED" };

  const entry = {
    v: 1, type: "CARRY_ENTRY", id, ts: nowMs, verdict: category, dir,
    spot: ref, sl, score, agreement, lots: 1,
  };
  const trade = {
    id, date: istDateStr, verdict: category, dir, spot: ref, sl, score, agreement, lots: 1,
    polls: lastN, sentAt: new Date(nowMs).toISOString(), sentTime: timeStr,
    execution: { status: "PENDING", at: new Date(nowMs).toISOString() },
  };
  try {
    await store.set(CARRY_ACTIVE_KEY, trade, null);
  } catch (e) {
    // The claim stays: without a recorded PENDING trade we do not send (nothing sent, day is used up).
    await say(deps, `⚠️ *Carry NOT sent* — could not record the carry trade in Redis (${istDateStr}). Trade ID \`${id}\``);
    return { status: "NOT_SENT_STATE_WRITE_FAILED" };
  }

  const d = await dispatchFlowEntry({ config: { url: cfg.url, secret: cfg.secret }, entry, fetchImpl: deps.fetchImpl, timeoutMs });
  const at = new Date(deps.now()).toISOString();
  if (d.outcome === "ACCEPTED") trade.execution = { status: "ACCEPTED", mode: d.mode, orderRef: d.orderRef, at, dispatchMs: d.durationMs };
  else if (d.outcome === "REJECTED" || d.outcome === "DUPLICATE") trade.execution = { status: "NOT_EXECUTED", outcome: d.outcome, reason: d.reason, mode: d.mode, at };
  else trade.execution = { status: "UNKNOWN", error: d.error, httpStatus: d.httpStatus, at, timeoutMs };

  try {
    if (trade.execution.status === "NOT_EXECUTED") {
      await store.del(CARRY_ACTIVE_KEY);
      await store.lpush(CARRY_HISTORY_KEY, { type: "CARRY_NOT_EXECUTED", ...trade });
    } else {
      await store.set(CARRY_ACTIVE_KEY, trade, null); // no expiry while open
    }
  } catch (e) { /* PENDING stays recorded: still owned and visible */ }

  const pollsLine = lastN.map((p) => `${p.time} ${p.category} (score ${p.score ?? "?"}, agr ${p.agreement ?? "?"})`).join(" · ");
  const conditionsMsg = [
    `🌙📤 *CARRY CONDITIONS MET · INSTRUCTION SENT* · \`${category}\` (${dir}) · 1 lot`,
    `• *Score:* \`${score ?? "?"}\` | *Agreement:* \`${agreement}\` (min ${cfg.minAgreement})`,
    `• *Polls:* ${pollsLine}`,
    `• *Reference (NSE spot at ${timeStr} IST, post-auction):* \`${ref}\` | *Stop:* \`${sl}\``,
    `• *Trade ID:* \`${id}\``,
  ].join("\n");
  const ex = trade.execution;
  let outcomeMsg;
  if (ex.status === "ACCEPTED") {
    outcomeMsg = `🌙📨 *CARRY SENT TO ALGO · AWAITING FILL* · \`${id}\` · mode \`${mdSafe(ex.mode || "?")}\` · orderRef \`${mdSafe(ex.orderRef || "none")}\``;
  } else if (ex.status === "NOT_EXECUTED") {
    outcomeMsg = `⚠️ *CARRY APPROVED BUT NOT EXECUTED* · \`${id}\` · Algo said \`${ex.outcome}\`: ${mdSafe(ex.reason || "no reason given")}`;
  } else {
    outcomeMsg = [
      `🚨🚨 *CARRY OUTCOME UNKNOWN — CHECK YOUR BROKER NOW* 🚨🚨`,
      `• \`${category}\` (${dir}) · Trade ID \`${id}\``,
      `• *Problem:* ${mdSafe(ex.error || "no response")}`,
      `• An overnight position MAY exist. The carry stays recorded and will NOT auto-clear; no other carry is sent today.`,
    ].join("\n");
  }
  // Two distinct messages, sent in parallel to bound the time spent inside the poll.
  await Promise.all([say(deps, conditionsMsg), say(deps, outcomeMsg)]);
  return { status: "DISPATCHED", outcome: d.outcome, id, entry };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Sync-back: CARRY_FILLED / CARRY_FAILED / CARRY_EXIT
// ─────────────────────────────────────────────────────────────────────────────

function fmtAccounts(accounts) {
  if (!Array.isArray(accounts) || !accounts.length) return "n/a";
  return accounts.slice(0, 10).map((a) => {
    if (!a || typeof a !== "object") return mdSafe(a);
    const parts = Object.entries(a).filter(([k]) => k !== "account").map(([k, v]) => `${k} ${typeof v === "object" ? JSON.stringify(v) : v}`);
    return `${mdSafe(a.account ?? "?")}: ${mdSafe(parts.join(", "))}`;
  }).join(" | ");
}

/**
 * Applies a carry sync-back. Returns { status, body } for the HTTP response. Never throws.
 */
export async function handleCarrySync({ payload, store, deps }) {
  const grade = payload.grade;
  const tradeId = payload.tradeId === undefined || payload.tradeId === null ? "" : String(payload.tradeId);
  const reject = (status, error, detail) => {
    console.warn(`[carry] ${grade} rejected (${status}): ${detail}`);
    return { status, body: { ok: false, error, detail } };
  };
  const dup = () => ({ status: 200, body: { ok: true, event: grade, duplicate: true, tradeId } });
  if (!tradeId) return reject(409, "TRADE_ID_REQUIRED", `${grade} must carry the tradeId from CARRY_ENTRY`);
  if (!store) return reject(503, "REDIS_UNAVAILABLE", "Redis not configured");

  let active, failed, exited;
  try {
    active = await store.get(CARRY_ACTIVE_KEY);
    failed = await store.get(carryFailedKey(tradeId));
    exited = await store.get(carryExitedKey(tradeId));
  } catch (e) {
    return reject(503, "REDIS_UNAVAILABLE", `could not read carry state: ${e?.message}`);
  }
  const nowIso = new Date(deps.now()).toISOString();
  const sync = {
    source: payload.source ?? null, tradeId, spot: payload.spot ?? null, optionFill: payload.optionFill ?? null,
    contract: payload.contract ?? null, lots: payload.lots ?? null, mode: payload.mode ?? null,
    reason: payload.reason ?? null, t: payload.t ?? null, accounts: Array.isArray(payload.accounts) ? payload.accounts : null,
    converted: typeof payload.converted === "boolean" ? payload.converted : null,
  };
  const loud = (lines) => say(deps, [`🚨🚨 *CONTRADICTORY CARRY REPORTS — CHECK YOUR BROKER NOW* 🚨🚨`, ...lines].join("\n"));

  if (!active || String(active.id || "") !== tradeId) {
    if (failed) {
      if (grade === "CARRY_FAILED") return dup();
      await loud([`• Carry \`${tradeId}\` was reported *FAILED* (released), now reported *${grade}*.`, `• The scanner is NOT tracking it. Manage it at the broker.`]);
      return reject(409, "CONTRADICTORY_REPORT", `carry ${tradeId} already failed`);
    }
    if (exited) {
      if (grade === "CARRY_EXIT" || grade === "CARRY_FILLED") return dup();
      await loud([`• Carry \`${tradeId}\` already *EXITED*, now reported *FAILED*.`]);
      return reject(409, "CONTRADICTORY_REPORT", `carry ${tradeId} already exited`);
    }
    return reject(409, "TRADE_ID_MISMATCH", active ? `tradeId ${tradeId} does not match the open carry (${active.id})` : `no open carry for tradeId ${tradeId}`);
  }

  const status = active.execution?.status;
  const head = `\`${active.verdict}\` (${active.dir}) · Trade ID \`${tradeId}\``;

  if (grade === "CARRY_FILLED") {
    if (status === "FILLED") return dup();
    if (!CARRY_REPORTABLE.includes(status)) return reject(409, "INVALID_TRANSITION", `carry ${tradeId} is ${status}`);
    const filledAtMs = Number(payload.t) > 0 ? Number(payload.t) : deps.now();
    active.execution = {
      ...active.execution, status: "FILLED", previousStatus: status, lots: sync.lots, optionFill: sync.optionFill,
      contract: sync.contract, mode: sync.mode ?? active.execution?.mode ?? null, accounts: sync.accounts,
      converted: sync.converted, filledAt: new Date(filledAtMs).toISOString(),
    };
    try {
      await store.set(CARRY_ACTIVE_KEY, active, null);
    } catch (e) {
      return reject(503, "REDIS_UNAVAILABLE", "could not record the fill");
    }
    await say(deps, [
      `🌙✅ *CARRY FILLED BY ALGO* · ${head}`,
      `• *Contract:* \`${mdSafe(sync.contract || "?")}\` | *Avg fill:* \`${mdSafe(sync.optionFill ?? "?")}\` | *Lots:* \`${mdSafe(sync.lots ?? "?")}\` | *Mode:* \`${mdSafe(sync.mode || "?")}\``,
      `• *Converted from intraday position:* ${sync.converted === true ? "YES" : sync.converted === false ? "no" : "n/a"}`,
      `• *Accounts:* ${fmtAccounts(sync.accounts)}`,
    ].join("\n"));
    return { status: 200, body: { ok: true, event: grade, tradeId, execution: active.execution } };
  }

  if (grade === "CARRY_FAILED") {
    if (status === "FILLED") {
      await loud([`• ${head}`, `• Already *FILLED* (\`${mdSafe(active.execution.contract || "?")}\`), now reported *FAILED*: ${mdSafe(sync.reason || "no reason")}`, `• State NOT changed: carry stays open.`]);
      return reject(409, "CONTRADICTORY_REPORT", `carry ${tradeId} is FILLED`);
    }
    if (!CARRY_REPORTABLE.includes(status)) return reject(409, "INVALID_TRANSITION", `carry ${tradeId} is ${status}`);
    active.execution = { ...active.execution, status: "NOT_EXECUTED", previousStatus: status, outcome: "CARRY_FAILED", reason: sync.reason, mode: sync.mode ?? active.execution?.mode ?? null, at: nowIso };
    try {
      await store.set(carryFailedKey(tradeId), { reason: sync.reason, at: nowIso }, MARKER_TTL_SEC);
      await store.del(CARRY_ACTIVE_KEY);
      await store.lpush(CARRY_HISTORY_KEY, { type: "CARRY_FAILED", ...active, sync });
      await store.ltrim(CARRY_HISTORY_KEY, 0, 199);
    } catch (e) {
      return reject(503, "REDIS_UNAVAILABLE", "could not record the failure");
    }
    await say(deps, [
      `⚠️ *CARRY APPROVED BUT NOT EXECUTED* · ${head}`,
      `• *Algo said:* \`CARRY_FAILED\`${sync.mode ? ` (mode \`${mdSafe(sync.mode)}\`)` : ""}`,
      `• *Reason:* ${mdSafe(sync.reason || "no reason given")}`,
    ].join("\n"));
    return { status: 200, body: { ok: true, event: grade, tradeId, execution: active.execution } };
  }

  // CARRY_EXIT — accepted from any open state (the Algo exiting it proves it held it).
  // The Algo's ₹ figures are the only P&L; the index move is context only.
  const algoPnl = parseAlgoPnl(payload);
  const move = indexMovePts(active.dir, active.spot, sync.spot);
  const record = {
    type: "CARRY_EXIT",
    id: tradeId, date: active.date, verdict: active.verdict, dir: active.dir, lots: active.lots,
    pnlBasis: "ALGO_INR",
    pnlInr: algoPnl?.reported ? algoPnl.pnlInr : null,
    pnlKnown: algoPnl ? algoPnl.pnlKnown : null,
    algoPnl,
    indexMovePts: move,
    entry: { spotRef: active.spot, sl: active.sl, score: active.score, agreement: active.agreement, sentAt: active.sentAt,
      contract: active.execution?.contract ?? null, optionFill: active.execution?.optionFill ?? null,
      filledAt: active.execution?.filledAt ?? null, converted: active.execution?.converted ?? null, statusBeforeExit: status },
    exit: { reason: sync.reason, spot: sync.spot, optionFill: sync.optionFill, lots: sync.lots, mode: sync.mode,
      t: sync.t, at: nowIso, accounts: sync.accounts },
  };
  try {
    await store.set(carryExitedKey(tradeId), { at: nowIso, reason: sync.reason }, MARKER_TTL_SEC);
    await store.del(CARRY_ACTIVE_KEY);
    await store.lpush(CARRY_HISTORY_KEY, record);
    await store.ltrim(CARRY_HISTORY_KEY, 0, 199);
  } catch (e) {
    return reject(503, "REDIS_UNAVAILABLE", "could not record the exit");
  }
  await say(deps, [
    `🌅🏁 *CARRY EXITED* · ${head}`,
    ...algoPnlLines(algoPnl),
    `• *Reason:* \`${mdSafe(sync.reason || "?")}\` | *Spot:* \`${mdSafe(sync.spot ?? "?")}\` | *Exit fill:* \`${mdSafe(sync.optionFill ?? "?")}\` | *Mode:* \`${mdSafe(sync.mode || "?")}\``,
    `• *Entry:* \`${mdSafe(record.entry.contract || "?")}\` @ \`${mdSafe(record.entry.optionFill ?? "?")}\` (ref spot \`${active.spot}\`, stop \`${active.sl}\`)`,
    // Older Algo builds: show the free-form account list as before.
    algoPnl?.accounts?.length ? null : `• *Accounts (as reported):* ${fmtAccounts(sync.accounts)}`,
    move !== null ? `• *Index move, reference to exit (not your P&L):* \`${move >= 0 ? "+" : ""}${move} pts\`` : null,
  ].filter(Boolean).join("\n"));
  return { status: 200, body: { ok: true, event: grade, tradeId, record } };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Carry automation status in plain words (EOD verdict card / EOD Telegram header)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {{ cfg, nowMins, date, claim, active, block, lastHistory }} s  (all read-only state)
 * @returns {{ state: string, text: string }}
 */
export function describeCarryAutomation({ cfg, nowMins, date, claim = null, active = null, block = null, lastHistory = null }) {
  if (!cfg?.enabled) return { state: "OFF", text: "Carry automation off" };
  const inr = (v) => (Number.isFinite(Number(v)) ? `${Number(v) < 0 ? "-" : "+"}₹${Math.abs(Number(v)).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null);
  if (isCarryOpen(active)) {
    const ex = active.execution;
    if (ex.status === "FILLED") return { state: "FILLED", text: `Filled: ${active.verdict} ${ex.contract || ""}${ex.optionFill != null ? ` @ ${ex.optionFill}` : ""} (id ${active.id})`.replace(/\s+/g, " ") };
    if (ex.status === "UNKNOWN") return { state: "UNKNOWN", text: `Instruction sent — outcome UNKNOWN, check the broker (id ${active.id})` };
    if (ex.status === "ACCEPTED") return { state: "SENT", text: `Instruction sent (${active.verdict}) — awaiting fill (id ${active.id})` };
    return { state: "SENT", text: `Instruction sent (${active.verdict}) — awaiting Algo reply (id ${active.id})` };
  }
  const lastExitTxt = lastHistory?.type === "CARRY_EXIT"
    ? `last carry (${lastHistory.date}) exited ${lastHistory.pnlInr != null ? inr(lastHistory.pnlInr) : "— ₹ not reported"}${lastHistory.pnlKnown === false ? " (incomplete)" : ""}`
    : null;
  if (claim) {
    if (lastHistory && lastHistory.id === claim.id) {
      if (lastHistory.type === "CARRY_EXIT") return { state: "EXITED", text: `Exited: ${lastHistory.pnlInr != null ? inr(lastHistory.pnlInr) : "₹ not reported"}` };
      const reason = lastHistory.execution?.reason || lastHistory.sync?.reason || lastHistory.execution?.outcome || "no reason given";
      return { state: "NOT_EXECUTED", text: `Not executed: ${reason}` };
    }
    return { state: "SENT", text: "Instruction sent today" };
  }
  const hh = minsToHHMM;
  if (nowMins < cfg.windowStartMins) return { state: "WAITING", text: `Waiting for ${hh(cfg.windowStartMins)}${lastExitTxt ? ` · ${lastExitTxt}` : ""}` };
  if (nowMins <= cfg.windowEndMins) return { state: "WATCHING", text: `Watching ${hh(cfg.windowStartMins)}–${hh(cfg.windowEndMins)}: ${block?.reason || "no reading yet"}` };
  return { state: "NOT_SENT", text: `Not sent: ${block?.reason || `no poll ran inside ${hh(cfg.windowStartMins)}–${hh(cfg.windowEndMins)}`}` };
}

/** Reads the state describeCarryAutomation needs (store adapter with get + lrange). Never throws. */
export async function readCarryAutomation({ store, env = process.env, nowMins, date }) {
  const cfg = getCarryConfig(env);
  if (!cfg.enabled || !store) return describeCarryAutomation({ cfg, nowMins, date });
  const safe = async (fn) => { try { return await fn(); } catch (e) { return null; } };
  const [claim, active, block, hist] = await Promise.all([
    safe(() => store.get(carryClaimKey(date))),
    safe(() => store.get(CARRY_ACTIVE_KEY)),
    safe(() => store.get(carryBlockKey(date))),
    safe(() => (store.lrange ? store.lrange(CARRY_HISTORY_KEY, 0, 0) : null)),
  ]);
  return describeCarryAutomation({ cfg, nowMins, date, claim, active, block, lastHistory: Array.isArray(hist) ? hist[0] || null : null });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Store adapters
// ─────────────────────────────────────────────────────────────────────────────

const enc = (v) => (typeof v === "string" ? v : JSON.stringify(v));
const dec = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch (e) { return v; }
};

/** Adapter over an @upstash/redis-style client (get/set(opts)/del/lpush/ltrim). */
export function storeFromClient(redis) {
  if (!redis) return null;
  return {
    get: async (k) => dec(await redis.get(k)),
    set: async (k, v, ttl) => (ttl ? redis.set(k, enc(v), { ex: ttl }) : redis.set(k, enc(v))),
    setNx: async (k, v, ttl) => (await redis.set(k, enc(v), { nx: true, ex: ttl })) === "OK",
    del: async (k) => redis.del(k),
    lpush: async (k, v) => redis.lpush(k, enc(v)),
    ltrim: async (k, a, b) => redis.ltrim(k, a, b),
    lrange: async (k, a, b) => ((await redis.lrange(k, a, b)) || []).map(dec),
  };
}

/** Adapter over an Upstash REST command function: cmd(["GET", k]) -> result (throws on error). */
export function storeFromCommand(cmd) {
  return {
    get: async (k) => dec(await cmd(["GET", k])),
    set: async (k, v, ttl) => cmd(ttl ? ["SET", k, enc(v), "EX", String(ttl)] : ["SET", k, enc(v)]),
    setNx: async (k, v, ttl) => (await cmd(["SET", k, enc(v), "NX", "EX", String(ttl)])) === "OK",
    del: async (k) => cmd(["DEL", k]),
    lpush: async (k, v) => cmd(["LPUSH", k, enc(v)]),
    ltrim: async (k, a, b) => cmd(["LTRIM", k, String(a), String(b)]),
    lrange: async (k, a, b) => ((await cmd(["LRANGE", k, String(a), String(b)])) || []).map(dec),
  };
}
