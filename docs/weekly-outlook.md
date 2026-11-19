# Weekly Outlook (shadow)

A multi-day view of Nifty, for holds of up to a week: is it more likely to trend, range or break,
and which reference levels matter. It is **shadow only**:

- no orders, no Algo dispatch, no Telegram message;
- nothing in the live refresh, fusion, vetoes, EOD score, carry radar, webhook or scorecard reads it;
- it is not one of the scorecard sections.

Code: `src/swingSummary.js` (daily summary and capture), `src/weeklyOutlook.js` (outlook and
outcome measurement), `api/swing.js` (read-only API), `src/WeeklyOutlookCard.jsx` (card under the
EOD verdict card). Tests: `test/swingOutlook.test.js`.

## What is recorded each day, and when

Option-chain history cannot be backfilled, so recording starts with this release.

**When.** On weekday sessions, from 15:20 IST (`SWING_CAPTURE_START`) to 15:40 IST, a refresh of the
near expiry captures at most once every 300 s (`SWING_CAPTURE_EVERY_SEC`, Redis lock
`nifty:swing:capture_lock`, `SET NX EX`). Later captures overwrite earlier ones, so the last one
(about 15:35–15:40) stands. Not captured: Muhurat sessions, closed days, `?test=eod_alert`,
non-near-expiry refreshes, the TradingView webhook's pre-order refresh, or without Redis.

**Where it runs.** After the refresh has computed its payload and persisted (or started persisting)
the snapshot. On the poller (awaited persist) it is awaited inside the poll's deadline: the next
weekly and monthly chains are fetched only when at least 4.5 s (`SWING_MIN_BUDGET_MS`) remain, each
with a 3.5 s timeout (`SWING_FETCH_TIMEOUT_MS`), and the whole capture is cut off at
`min(5 s, deadline − 0.25 s)` (`SWING_MAX_CAPTURE_MS`, default 5000 ms, leaving the poll handler
time for its heartbeat, watchdog and bookkeeping inside Vercel's 15 s limit). On browser/cron refreshes it is not awaited.
Its errors are swallowed; it can never fail or change a refresh.

**What** (`nifty:swing:day:<YYYY-MM-DD>`, kept 400 days, `SWING_RETENTION_DAYS`):

- spot open/high/low/close from the real ticks (synthetic ticks excluded; spot high/low ignore the
  15:15–15:30 closing-auction freeze). When the day has at least 30 live ticks
  (`isLiveTick !== false`; `SWING_MIN_LIVE_TICKS`), spot and futures OHLC and OI open/close use the
  live ticks only, so gap-bridging (interpolated) ticks synced back by a browser cannot set a high
  or low (seen on 11-Nov 09:16–09:23). With fewer live ticks it falls back to all non-synthetic
  ticks and adds a note. The summary records `ticks`, `ticksUsed`, `nonLiveExcluded` and
  `liveOnly`;
- futures open/high/low/close, open interest at open and close, OI change %, volume. Futures
  open/high/low and OI-open use ticks from 09:17 onward (the first minutes can carry a stale
  previous-day quote);
- for the near weekly, next weekly and monthly chains: ATM strike, ATM straddle (CE + PE last
  price), expected range (spot ± straddle), top-3 call-OI and put-OI strikes, call wall / put wall
  (largest OI), PCR by OI, days to expiry, strike count. Equal expiries are not fetched twice; on
  expiry-day afternoons the next-expiry chain the refresh already fetched is reused. A failed fetch
  leaves that chain `null` with a note;
- the near expiry's intraday floor, roof, PCR, ΔPCR, total put/call writing;
- tick coverage %, a `partial` flag (no spot or futures ticks, no near chain, or coverage < 50%) and
  notes.

Each capture also stores the outlook computed at that moment at `nifty:swing:outlook:<date>` (same
retention); these snapshots are what the past-outlook record measures.

Days before recording started (11–13 Nov 2026) and any day without a swing summary but with a
scorecard day document get a **partial** summary derived from the scorecard series (spot and
futures OHLC and OI; no chains). It is computed when read and never written. The scorecard series
carries no live/non-live flag, so this derivation cannot exclude gap-bridging ticks: such days may
still show an interpolated high or low.

## The four groups

Every threshold is a default you can override; every raw input is kept in `groups.*.inputs`.

| Group | Needs | Rule | Score |
|---|---|---|---|
| Price | 5 daily bars (`SWING_PRICE_MIN_DAYS`) | close vs 5-day mean of closes (±0.3%, `SWING_PRICE_MEAN_BAND_PCT`): +1/−1; higher highs and higher lows over the last 3 sessions +1, lower lows and lower highs −1; close in the top / bottom third of the 5-day high–low range +1/−1 | sum, clamped to −2..+2 |
| Futures | 3 sessions with futures close and OI (`SWING_FUTURES_MIN_DAYS`), uses up to the last 5 (`SWING_FUTURES_LOOKBACK_DAYS`) | net futures close change and net OI change across the window, with the day-quadrant deadbands 0.08% price / 0.25% OI (`SWING_FUT_PRICE_DEADBAND_PCT`, `SWING_FUT_OI_DEADBAND_PCT`) | long build-up +2, short build-up −2, short covering +1, long unwinding −1, inside a deadband 0 |
| Options | the outlook-expiry chain on the last session | position: above the call wall +1, below the put wall −1, lower third between the walls (near put support) +1, upper third (near call resistance) −1; PCR ≥ 1.2 +1 (`SWING_PCR_SUPPORTIVE`), ≤ 0.8 −1 (`SWING_PCR_RESISTIVE`); wall migration vs the previous session's chain of the same expiry: walls moving up +1, down −1 | sum, clamped to −2..+2 |
| Volatility (not directional) | the straddle and 3 daily ranges (`SWING_VOL_MIN_DAYS`), uses up to 5 (`SWING_VOL_LOOKBACK_DAYS`) | implied per day = straddle / √max(dte, 1) vs the average daily spot range | `COMPRESSED` if implied ≥ 1.3 × realised, `EXPANDING` if realised ≥ 1.3 × implied (`SWING_VOL_RATIO`), else `NORMAL` |

**Outlook expiry.** The near weekly if it has ≥ 3 days left (`SWING_MIN_NEAR_DTE`), otherwise the
next weekly. If that chain was not captured, the first captured of near / next weekly / monthly is
used and the outlook says so.

## Regimes

The score is the sum of the available directional groups (price, futures, options).

- `INSUFFICIENT_DATA` — no directional group available, or fewer than 3 recorded sessions
  (`SWING_MIN_DAYS_FOR_REGIME`). The expected range and walls are still shown when a chain exists.
- `TREND_UP` — score ≥ +3 (`SWING_TREND_SCORE`), at least two groups positive, none negative.
  `TREND_DOWN` is the mirror.
- `BREAK_RISK_UP` — the reference close is within 0.25 × straddle (`SWING_BREAK_PROXIMITY_FRAC`) of
  the call wall, or above it, **and** volatility is `EXPANDING` or the call wall moved up since the
  previous session. `BREAK_RISK_DOWN` mirrors this with the put wall (moving down).
- `RANGE` — otherwise.

Trend is checked before break risk.

**Confidence.** Trend: HIGH when |score| ≥ 5 (`SWING_HIGH_CONFIDENCE_SCORE`), else MEDIUM. Break
risk: HIGH when both expanding volatility and wall migration agree, else MEDIUM. Range: HIGH when
|score| ≤ 1 and volatility is known and not expanding, else MEDIUM. Then capped by the directional
groups available (1 → LOW, 2 → MEDIUM, 3 → HIGH possible), and LOW whenever the last session is
partial.

## Levels

- Expected range: outlook-expiry spot ± ATM straddle.
- Call wall / put wall: largest call / put OI of the outlook-expiry chain.
- Previous day high/low: the last recorded session.
- Previous week high/low and pivot: the last complete calendar week (the week of the last session
  if that session is a Friday, otherwise the week before). Classic pivot (H + L + C) / 3 when that
  week has ≥ 4 recorded sessions (`SWING_PIVOT_MIN_SESSIONS`); otherwise the mean of the last (up
  to 5) recorded closes. `levels.pivot.basis` says which.
- Invalidation: trend up / break risk up → a daily close below the put wall (or the expected-range
  low without a wall); trend down / break risk down → a close above the call wall; range → a daily
  close outside the expected range.

## Measuring past outlooks

Horizon: the first recorded session on/after the outlook's expiry date, or the 5th later session,
whichever comes first. Until it is recorded the outcome is `PENDING`. Hit rules (spot closes):

- `TREND_UP`: horizon close above the reference close; `TREND_DOWN`: below.
- `RANGE`: every later close up to the horizon inside the expected range.
- `BREAK_RISK_UP`: some later close up to the horizon above the expected-range high;
  `BREAK_RISK_DOWN`: below the low.
- `INSUFFICIENT_DATA`: not measured.

`GET /api/swing?days=30` (1–120) returns `{ outlook, days, pastOutlooks, tally: { byRegime: { n,
hits, pending } } }`. Public, read-only, `Cache-Control: no-store`; no writes, no NSE call.
Switch everything off with `SWING_ENABLED=false`.

## What becomes available when

- **Day 1 with a capture:** expected range, walls, options group (position, PCR); regime still
  `INSUFFICIENT_DATA`.
- **2 captured sessions of the same expiry:** wall migration.
- **3 sessions:** futures group, volatility state, and a regime (confidence LOW with one group,
  at most MEDIUM with two).
- **5 sessions:** price group — all three directional groups, HIGH confidence possible.
- **A full previous calendar week (≥ 4 sessions):** the classic weekly pivot and previous-week
  high/low.

## Thresholds are starting values

None of these thresholds has been fitted to data. They are starting points chosen to be easy to
read. Every raw input behind each group is stored with each daily outlook snapshot, so after 20–30
sessions they should be re-fitted from the recorded inputs and the measured outcomes (the past
outlook tally), not tuned to a handful of days.

## Invalidation ladder (added 2026-11-19)

The invalidation used to be the whole-chain call wall (bearish view) or put wall (bullish). Those
sit on far round strikes that collect hedges: 26000 / 24000 on 18-Nov-2026, about 800 points
away. On NIFTY daily bars from Oct-2021 to Nov-2026 a level that far was reached 7 times, never in
time to matter.

An invalidation is a **risk boundary, not a forecast**. On the same bars, a first daily close
beyond the last swing level was followed by a move in the new direction over the next 3 days 51%
(up) and 56% (down) of the time, against 54% for any day. So the outlook now shows the nearest
real structure, in three steps, each a daily close beyond the level:

| Step | Bearish view (mirror for bullish) |
|---|---|
| 1 Warning | back above the multi-session volume centre: the higher of the point of control and the volume-weighted average (5 sessions; futures volume at spot price, 15:15–15:30 skipped) |
| 2 Invalidated | above the previous day's high, merged with the value-area high and the largest near-money call OI when within max(25 pts, 0.15 × straddle) |
| 3 Narrative flipped | above the last confirmed swing high (a day whose high beat the days either side), merged with the near-money call wall when close; the expected-range high when no swing is recorded |

A range view shows both an upper and a lower ladder. `levels.invalidation` is step 2 (or step 3
when there is no step 2) with `source: "ladder"`; the whole-chain walls are still reported as
information. Near-money walls (`nearCallWall` / `nearPutWall` in each chain summary: the largest
call OI above and put OI below spot within spot ± straddle) are recorded from the first daily
capture after this change; earlier days use price and volume levels only. Stored outlooks record
when each step was first breached (`outcome.ladderBreaches`), so the ladder is measured too.
