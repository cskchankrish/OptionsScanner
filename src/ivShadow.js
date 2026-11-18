/**
 * Implied-volatility shadow — MEASUREMENT ONLY.
 *
 * Question (owner, 18-Nov-2026): when option premium looks expensive at a signal, is a pullback more
 * likely, so the system should be cautious? Rupee premium mostly reflects time to expiry; the
 * comparable measure is implied volatility (IV). So every TradingView signal and shadow candidate
 * records the at-the-money IV of the scanner's chain (and the put-minus-call IV skew), and the
 * scorecard shows hit rates for signals taken in LOW / MID / HIGH IV (terciles of the window's own
 * signals). Nothing here feeds a decision, a veto, sizing, the Algo or Telegram. After 20–30
 * sessions the owner decides whether "high IV" deserves a caution rule.
 *
 * NSE's chain reports impliedVolatility per strike in percent (e.g. 11.8). The scanner's chain is
 * its own expiry (the near/active contract), not necessarily the contract the Algo trades.
 *
 * Pure functions only (browser-safe).
 */

export const IV_BANDS = ["LOW", "MID", "HIGH"];
/** Below this many IV readings in the window, no band cut-offs are computed (all UNKNOWN). */
export const IV_MIN_FOR_BANDS = 3;

const num = (v) => (v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const ivOk = (v) => v !== null && v > 0 && v < 200; // NSE prints 0 for an unquoted leg

/**
 * At-the-money IV summary from raw NSE rows [{ strikePrice, CE: { impliedVolatility, lastPrice },
 * PE: {...} }]. ATM = the strike nearest spot whose call AND put both have an IV (ties → lower
 * strike). Returns null (never throws) when no such strike exists.
 * @returns {{ strike, ceIv, peIv, atmIv, skew, ceLtp, peLtp, expiry } | null}
 */
export function summariseAtmIv(rows, spot, { expiry = null } = {}) {
  try {
    const s = num(spot);
    if (!Array.isArray(rows) || !(s > 0)) return null;
    let best = null;
    for (const r of rows) {
      const strike = num(r?.strikePrice);
      const ceIv = num(r?.CE?.impliedVolatility);
      const peIv = num(r?.PE?.impliedVolatility);
      if (!(strike > 0) || !ivOk(ceIv) || !ivOk(peIv)) continue;
      const d = Math.abs(strike - s);
      if (!best || d < best.d || (d === best.d && strike < best.strike)) {
        best = { d, strike, ceIv, peIv, ceLtp: num(r?.CE?.lastPrice), peLtp: num(r?.PE?.lastPrice) };
      }
    }
    if (!best) return null;
    return {
      strike: best.strike,
      ceIv: r2(best.ceIv),
      peIv: r2(best.peIv),
      atmIv: r2((best.ceIv + best.peIv) / 2),
      skew: r2(best.peIv - best.ceIv), // > 0: puts richer than calls (NIFTY's usual state)
      ceLtp: best.ceLtp,
      peLtp: best.peLtp,
      expiry: expiry ?? null,
    };
  } catch (e) {
    return null;
  }
}

/** Compact IV fields recorded on a signal / candidate (from the snapshot's ivAtm), or null. */
export function ivShadowFromSnapshot(snapshot) {
  const iv = snapshot?.ivAtm;
  if (!iv || !ivOk(num(iv.atmIv))) return null;
  return { atmIv: num(iv.atmIv), ceIv: num(iv.ceIv), peIv: num(iv.peIv), skew: num(iv.skew), strike: num(iv.strike), expiry: iv.expiry ?? null };
}

/** Tercile cut-offs { lo, hi, n } over the given IV values (null when fewer than IV_MIN_FOR_BANDS). */
export function ivCuts(values) {
  const v = (values || []).map(num).filter(ivOk).sort((a, b) => a - b);
  if (v.length < IV_MIN_FOR_BANDS) return null;
  const q = (p) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    return r2(v[lo] + (v[Math.ceil(i)] - v[lo]) * (i - lo));
  };
  return { lo: q(1 / 3), hi: q(2 / 3), n: v.length };
}

/** LOW (≤ lo) / MID / HIGH (> hi) / UNKNOWN (no IV recorded or no cut-offs). */
export function ivBandOf(atmIv, cuts) {
  const x = num(atmIv);
  if (!cuts || !ivOk(x)) return "UNKNOWN";
  if (x <= cuts.lo) return "LOW";
  if (x > cuts.hi) return "HIGH";
  return "MID";
}
