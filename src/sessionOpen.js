/**
 * First live tick of a session (pure, never throws).
 *
 * NSE's futures feed often lags at the open: the first tick(s) of a session repeat the previous
 * session's quote, OI and cumulative volume. Anything that takes "the session's opening price"
 * from the first tick must skip those carry-over ticks.
 *
 * Evidence (scorecard compact series, m minutes / f futures / o futures OI / v cumulative volume):
 *   Fri 2026-11-13: 09:15 fut 25314, vol 3,559,335, OI 216128 (previous session) → 09:17 fut 25170,
 *                   OI 212215; by 09:30 cumulative volume was only 475,865.
 *   Mon 2026-11-16: 09:15 fut 25175, vol 2,733,315, OI 208489 (previous session) → 09:16 fut 25275,
 *                   vol 68,835, OI 208312 (volume has reset: today's first real tick). Note 09:17's
 *                   volume (61,620) is slightly BELOW 09:16's — a small vendor dip, not a reset, which is
 *                   why a reset needs the volume to fall below SESSION_OPEN_VOLUME_RESET_RATIO of the
 *                   earlier high (2,733,315 → 68,835 is 2.5%).
 */

/** Only ticks within this many minutes of the series' first tick can be carry-over quotes. */
export const SESSION_OPEN_MAX_LOOK_MIN = 10;
/** A volume "reset" = a tick's cumulative volume below this fraction of an earlier tick's volume. */
export const SESSION_OPEN_VOLUME_RESET_RATIO = 0.5;
/** Fallback (no volume): a leading tick's OI must differ from its followers' median by more than this %… */
export const SESSION_OPEN_OI_DIFF_PCT = 1;
/** …AND its futures price must differ from their median by more than this % (a fast real open moves price, not OI). */
export const SESSION_OPEN_PRICE_DIFF_PCT = 0.25;
/** Fallback: followers = the next up-to-N ticks within SESSION_OPEN_FOLLOWER_WINDOW_MIN minutes; at least MIN needed. */
export const SESSION_OPEN_FOLLOWERS_MAX = 5;
export const SESSION_OPEN_FOLLOWERS_MIN = 3;
export const SESSION_OPEN_FOLLOWER_WINDOW_MIN = 10;

const pos = (x) => {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const median = (a) => {
  const s = a.slice().sort((x, y) => x - y);
  const k = Math.floor(s.length / 2);
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
};

/**
 * @param {{m:number[], f?:number[], o?:number[], v?:number[]}} series minutes ascending
 * @param {{maxLookMin?:number}} [opts]
 * @returns {{index:number, minutes:number|null, skipped:number, reason:string}}
 */
export function firstLiveIndex(series, opts = {}) {
  try {
    const m = Array.isArray(series?.m) ? series.m : [];
    if (!m.length) return { index: -1, minutes: null, skipped: 0, reason: "empty series" };
    const maxLook = Number(opts?.maxLookMin) > 0 ? Number(opts.maxLookMin) : SESSION_OPEN_MAX_LOOK_MIN;
    const m0 = Number(m[0]);
    if (!Number.isFinite(m0)) return { index: 0, minutes: null, skipped: 0, reason: "malformed series" };
    let look = 0; // number of ticks inside the look window
    while (look < m.length && Number.isFinite(Number(m[look])) && Number(m[look]) - m0 <= maxLook) look++;
    const none = (reason) => ({ index: 0, minutes: m0, skipped: 0, reason });
    const done = (i, reason) => ({ index: i, minutes: Number(m[i]), skipped: i, reason });

    // Primary: cumulative-volume reset inside the look window.
    const v = Array.isArray(series?.v) ? series.v : [];
    let maxPrev = null;
    let lastReset = -1;
    let validVol = 0;
    for (let i = 0; i < look; i++) {
      const x = pos(v[i]);
      if (x === null) continue;
      validVol++;
      if (maxPrev !== null && x < maxPrev * SESSION_OPEN_VOLUME_RESET_RATIO) {
        lastReset = i;
        maxPrev = x; // a new session's count starts here; later ticks compare against it
      } else if (maxPrev === null || x > maxPrev) maxPrev = x;
    }
    if (lastReset > 0) {
      // Every tick before the last reset is carry-over; the live session starts at the reset tick.
      return done(lastReset, `cumulative futures volume reset at minute ${m[lastReset]} (carry-over quote before it)`);
    }
    if (validVol >= 2) return none("cumulative volume rises from the first tick");

    // Fallback without volume: leading ticks whose OI AND price both disagree with what follows.
    const f = Array.isArray(series?.f) ? series.f : [];
    const o = Array.isArray(series?.o) ? series.o : [];
    let i = 0;
    for (; i < look - 1; i++) {
      const oi = pos(o[i]);
      const pr = pos(f[i]);
      if (oi === null || pr === null) break;
      const fo = [];
      const ff = [];
      for (let j = i + 1; j < m.length && fo.length < SESSION_OPEN_FOLLOWERS_MAX; j++) {
        if (!(Number(m[j]) - Number(m[i]) <= SESSION_OPEN_FOLLOWER_WINDOW_MIN)) break;
        const oj = pos(o[j]);
        const pj = pos(f[j]);
        if (oj === null || pj === null) continue;
        fo.push(oj);
        ff.push(pj);
      }
      if (fo.length < SESSION_OPEN_FOLLOWERS_MIN) break;
      const oiDiff = (Math.abs(oi - median(fo)) / median(fo)) * 100;
      const prDiff = (Math.abs(pr - median(ff)) / median(ff)) * 100;
      if (!(oiDiff > SESSION_OPEN_OI_DIFF_PCT && prDiff > SESSION_OPEN_PRICE_DIFF_PCT)) break;
    }
    if (i > 0) return done(i, "leading tick(s) carry a different OI and price from the ticks after them (no volume)");
    return none("no evidence of a carry-over quote");
  } catch (e) {
    return { index: 0, minutes: null, skipped: 0, reason: "error" };
  }
}
