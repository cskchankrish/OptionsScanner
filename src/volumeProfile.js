/**
 * Volume at price from the recorded minute data (pure, never throws).
 *
 * Volume comes from the NIFTY futures cumulative traded volume (per-minute differences); price is
 * the spot index at that minute, so the levels read in spot terms like every other level on the
 * Weekly Outlook. Minutes inside the 15:15–15:30 closing-auction freeze are skipped (spot is a stale
 * print there), and a fall in cumulative volume (the session reset, or a carry-over quote) is never
 * counted as volume.
 */
export const VP_BIN = 25;
export const VP_VALUE_AREA = 0.7;

const pos = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
const r2 = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/** One session's profile from a compact series { m, s (spot), v (cumulative futures volume) }. */
export function profileFromSeries(series, { bin = VP_BIN } = {}) {
  try {
    const m = series?.m || [], s = series?.s || [], v = series?.v || [];
    const bins = {};
    let vol = 0, pv = 0, prev = null;
    for (let i = 0; i < m.length; i++) {
      const cum = pos(v[i]);
      const sp = pos(s[i]);
      const minute = Number(m[i]);
      if (cum === null) continue;
      if (minute >= 915 && minute < 930) { prev = cum; continue; }
      if (prev !== null && cum >= prev && sp !== null) {
        const dv = cum - prev;
        if (dv > 0) {
          const b = Math.round(sp / bin) * bin;
          bins[b] = (bins[b] || 0) + dv;
          vol += dv;
          pv += dv * sp;
        }
      }
      prev = cum;
    }
    return vol > 0 ? { bin, bins, vol, pv: r2(pv) } : null;
  } catch (e) {
    return null;
  }
}

/** Same, from timeline ticks { minutes, spot, futVolume }. */
export function profileFromTicks(ticks, opts = {}) {
  const t = (Array.isArray(ticks) ? ticks : []).filter((x) => x && Number.isFinite(Number(x.minutes))).slice().sort((a, b) => a.minutes - b.minutes);
  return profileFromSeries({ m: t.map((x) => Number(x.minutes)), s: t.map((x) => x.spot), v: t.map((x) => x.futVolume) }, opts);
}

/**
 * Several sessions combined: point of control (busiest price), the 70% value area grown outward
 * from it (the standard method: add whichever neighbouring bin is busier), and the volume-weighted
 * average price. Null when there is no volume.
 */
export function combineProfiles(profiles) {
  try {
    const ps = (Array.isArray(profiles) ? profiles : []).filter((p) => p && p.vol > 0 && p.bins);
    if (!ps.length) return null;
    const bin = ps[0].bin || VP_BIN;
    const bins = new Map();
    let vol = 0, pv = 0;
    for (const p of ps) {
      for (const [k, x] of Object.entries(p.bins)) bins.set(Number(k), (bins.get(Number(k)) || 0) + Number(x));
      vol += p.vol;
      pv += p.pv;
    }
    const prices = [...bins.keys()].sort((a, b) => a - b);
    let pocIdx = 0;
    prices.forEach((pr, i) => { if (bins.get(pr) > bins.get(prices[pocIdx])) pocIdx = i; });
    let lo = pocIdx, hi = pocIdx, acc = bins.get(prices[pocIdx]);
    const at = (i) => (i >= 0 && i < prices.length ? bins.get(prices[i]) : -1);
    while (acc < VP_VALUE_AREA * vol && (lo > 0 || hi < prices.length - 1)) {
      const up = at(hi + 1), dn = at(lo - 1);
      if (up >= dn) { hi += 1; acc += up; } else { lo -= 1; acc += dn; }
    }
    return { poc: prices[pocIdx], vah: prices[hi] + bin / 2, val: prices[lo] - bin / 2, vwap: r2(pv / vol), sessions: ps.length, bin };
  } catch (e) {
    return null;
  }
}
