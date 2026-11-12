/**
 * Rupee P&L reported by the Algo on final exit events (flow exits and CARRY_EXIT).
 *
 * The Algo sends (newer builds only):
 *   pnlInr (number, ₹, sum over accounts, option premium on real fills, before charges),
 *   pnlKnown (boolean), entryFill, exitFill (number|null), qty (total units),
 *   accounts: [{ account, grade, lots, qty, entryFill, exitFill, pnlInr,
 *                exitFillSource: "engine_order"|"broker_tradebook"|"unknown" }]
 *
 * Validation is type-only and lenient: malformed pieces become null / are dropped; the event is
 * never rejected because of them. For Algo-owned trades this is the ONLY money figure; index
 * points are shown separately as "index move … (not your P&L)".
 */

const FILL_SOURCES = ["engine_order", "broker_tradebook", "unknown"];
const PNL_KEYS = ["pnlInr", "pnlKnown", "entryFill", "exitFill", "qty"];

const fin = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v) => (typeof v === "string" && v.length ? v.slice(0, 64) : typeof v === "number" && Number.isFinite(v) ? String(v) : null);

function parseAccount(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  return {
    account: str(a.account),
    grade: str(a.grade),
    lots: fin(a.lots),
    qty: fin(a.qty),
    entryFill: fin(a.entryFill),
    exitFill: fin(a.exitFill),
    pnlInr: fin(a.pnlInr),
    exitFillSource: FILL_SOURCES.includes(a.exitFillSource) ? a.exitFillSource : null,
  };
}

/**
 * @returns {null | { reported: boolean, pnlInr: number|null, pnlKnown: boolean|null, entryFill: number|null,
 *   exitFill: number|null, qty: number|null, accounts: object[] }}
 *   null when the event carries none of the P&L fields (older Algo build).
 *   `reported` is true only when a numeric pnlInr total was sent.
 */
export function parseAlgoPnl(payload) {
  if (!payload || typeof payload !== "object") return null;
  const hasAny = PNL_KEYS.some((k) => payload[k] !== undefined)
    || (Array.isArray(payload.accounts) && payload.accounts.some((a) => a && typeof a === "object" && "pnlInr" in a));
  if (!hasAny) return null;
  const pnlInr = fin(payload.pnlInr);
  return {
    reported: pnlInr !== null,
    pnlInr,
    pnlKnown: typeof payload.pnlKnown === "boolean" ? payload.pnlKnown : null,
    entryFill: fin(payload.entryFill),
    exitFill: fin(payload.exitFill),
    qty: fin(payload.qty),
    accounts: Array.isArray(payload.accounts) ? payload.accounts.slice(0, 20).map(parseAccount).filter(Boolean) : [],
  };
}

/** "+₹1,070.00" / "-₹520.50" (en-IN grouping). */
export function formatInr(n) {
  if (!Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 ? "-" : "+"}₹${abs}`;
}

const fmtFill = (v) => (Number.isFinite(v) ? String(v) : "?");
const clean = (v) => String(v ?? "").replace(/[*_`[\]]/g, "");

/**
 * Telegram lines that LEAD an Algo-owned closing message: the ₹ total, per-account lines and the
 * completeness note. Without fields: "₹ P&L not reported by the Algo".
 */
export function algoPnlLines(pnl) {
  if (!pnl || !pnl.reported) {
    const lines = [`💰 *₹ P&L not reported by the Algo*`];
    if (pnl?.accounts?.length) lines.push(...accountLines(pnl.accounts));
    return lines;
  }
  const lines = [`💰 *Result: ${formatInr(pnl.pnlInr)}* (Algo, option premium on real fills, before charges)`];
  lines.push(...accountLines(pnl.accounts));
  if (pnl.pnlKnown === false) {
    lines.push(`⚠️ *Incomplete:* the total excludes the accounts whose exit price is unknown.`);
  } else if (pnl.pnlKnown === null) {
    lines.push(`⚠️ The Algo did not say whether every account's exit price is known.`);
  }
  return lines;
}

function accountLines(accounts) {
  return accounts.map((a) => {
    const src = a.exitFillSource === "broker_tradebook"
      ? " · exit price from broker trade book"
      : a.exitFillSource === "unknown" || a.exitFill === null
      ? " · exit price unknown"
      : "";
    const lots = a.lots !== null ? `${a.lots} lot${a.lots === 1 ? "" : "s"}` : "? lots";
    const res = a.pnlInr !== null ? formatInr(a.pnlInr) : "₹ n/a";
    return `  • \`${clean(a.account || "?")}\`: ${lots} · ${fmtFill(a.entryFill)} → ${fmtFill(a.exitFill)} · *${res}*${src}`;
  });
}

/**
 * Direction-signed index move from the signal entry to the exit level (points). This is NOT the
 * owner's P&L for an Algo-owned trade.
 */
export function indexMovePts(direction, entry, exit) {
  const e = Number(entry), x = Number(exit);
  if (!Number.isFinite(e) || !Number.isFinite(x) || e <= 0 || x <= 0) return null;
  const d = String(direction).toUpperCase() === "SHORT" ? e - x : x - e;
  return Math.round(d * 100) / 100;
}

/**
 * Contribution of one closed record to a running total, never mixing units:
 * Algo-owned → rupees only when pnlKnown === true; paper → index points.
 * @returns {{ unit: "INR"|"INDEX_POINTS"|null, value: number|null }}
 */
export function pnlContribution(record) {
  if (!record) return { unit: null, value: null };
  if (record.algoOwned) {
    const p = record.algoPnl;
    return p && p.reported && p.pnlKnown === true ? { unit: "INR", value: p.pnlInr } : { unit: null, value: null };
  }
  return Number.isFinite(record.netPnl) ? { unit: "INDEX_POINTS", value: record.netPnl } : { unit: null, value: null };
}
