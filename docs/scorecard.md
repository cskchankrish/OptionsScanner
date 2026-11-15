# Daily scorecard

The scorecard records what each section of the scanner said during a session, and measures what
NIFTY futures did next. After 20–30 sessions, each section has a measured hit rate, and its
thresholds can be set from evidence.

It is **measurement only**:
- no decision, veto, score, alert or dispatch reads it;
- it makes no NSE call;
- the recorder runs after every decision in a refresh, and swallows its own errors.

Turn it off with `SCORECARD_ENABLED=false`.

Code: `src/scorecard.js`, `api/scorecard.js`, `src/ScorecardView.jsx`, `scripts/backfill-scorecard.mjs`.
Tests: `test/scorecard.test.js`.

## What is recorded

All of it is kept in Redis for 180 days, one session per IST date.

| Key | Content |
|---|---|
| `nifty:sc:events:<date>` | An append-only list of events, capped at 300 a day. Excess events are counted in `nifty:sc:dropped:<date>`. |
| `nifty:sc:state:<date>` | The small change-detection state: last quadrant and scenario, stages seen per extreme, radar turns seen, last EOD slot and reading. |
| `nifty:sc:day:<date>` | The day document, written at finalisation. |
| `nifty:sc:eod_pending` | The last final EOD verdict, waiting for the next session's 09:20. |

### The day document

The day document holds:
- **Per-minute series**, compact and column-oriented: futures price, combined futures OI,
  cumulative futures volume, spot, put writing and call writing. Futures volume is a new per-tick
  field (`futVolume`, NSE `totalTradedVolume` of the near contract). It is filled from now on;
  older days have `null`.
- **Settings snapshot**: every threshold in effect. That covers the Turn Tracker, the radar, the
  fusion deadbands and mode, the EOD group caps, carry thresholds and closing tiers, the carry
  settings, the flow-bridge allow-list, the data-quality limits, the scorecard settings, and the
  non-secret environment overrides.
- **The day's data quality.**
- **All events, each with its outcome.**

### Events

Every event carries:
- the time and section;
- the direction;
- the futures price at that moment;
- the numbers behind it;
- the data-quality state of its own window at that moment.

| Section | Events |
|---|---|
| `FUSION` | Each change of the whole-day quadrant, and each change of the fusion scenario. |
| `TURN` | Each Turn Tracker stage transition per extreme (EARLY, LIKELY TURN, CONFIRMED), with both legs' numbers. |
| `RADAR` | Each 30-minute trap or turn, and each "divergence, not a trap". |
| `EOD_SLOT` | The verdict, score and three group contributions at every scheduled slot and every flip. |
| `EOD` | The final reading: the last one at or before 15:38. |
| `SIGNAL` | Each TradingView signal received, with its grade and decision. The decision is one of: approved, vetoed with the reason, not executed with the reason, blocked, or downgraded. The levels are included. |
| `TRADE` | Each Algo-owned trade exit and each carry exit, with the Algo's rupee result. |

Typical storage per session is about 60–130 KB:
- day document: about 20 KB of series, plus about 1.4 KB of settings, plus about 1.1–1.3 KB per event with its outcome;
- the raw event list;
- about 2 KB of state.

The worst case, at the 300-event cap, is about 0.6 MB, which stays below Upstash's 1 MB request
limit.

## How outcomes are measured

- **Futures only.** Every outcome is measured on NIFTY futures. The spot index freezes 15:15–15:30
  for the closing auction, so it never distorts an outcome.
- **Coverage first.** Every measurement window must pass the coverage rule in
  `src/dataQuality.js`: the largest hole is at most 4 minutes, with at least 70% of the expected
  ticks. If it fails, the outcome is `UNMEASURABLE` with the reason.

### Directional events

These are fusion, Turn Tracker, radar and EOD slot events. For each one the scorecard records:
- the forward move in the event's direction at +15, +30 and +60 minutes, and at the close
  (15:38), in points and percent;
- the maximum favourable and adverse excursion, within 60 minutes and to the close;
- which side of a symmetric band (default ±0.20%, `SCORECARD_BAND_PCT`) was reached first within
  60 minutes.

### EOD final

The scorecard records the next session's opening futures price and the 09:20 price, both compared
with the final reading's futures reference.
- The outcome stays `PENDING` until a later session has ticks up to 09:20. Weekends and holidays
  are handled by using the next session that has data.
- If the futures contract rolled in between, the outcome is `UNMEASURABLE`.

### TradingView signals

The signal's T1 and stop are converted to futures-equivalent levels: spot level + futures basis at
the signal time. The scorecard then checks which is reached first in the same session:
- approved and vetoed signals are measured alike, so the vetoed ones show whether the veto helped;
- if both levels are touched on the same tick, the stop is counted first, to be conservative.

## Hit rules

These are fixed in code (`HIT_RULES`) and decided before any data was seen.

| Section | A hit is… |
|---|---|
| Fusion, Turn Tracker, radar, trap shadow, EOD slots | Futures reach +0.20% in the event's direction before −0.20%, within 60 minutes. "Neither" counts as not a hit. If the 60-minute window is cut by the close before either band is reached, the outcome is unmeasurable. |
| EOD final, BTST/STBT | The next session's 09:20 futures price is beyond the final reading's reference, in the verdict's direction. |
| EOD final, NO CARRY | The next session's 09:20 futures price is within ±0.35% of the reference: no carry-worthy move was missed. |
| TradingView signals | The futures-equivalent T1 is reached before the stop, in the same session. |
| Algo trades | The Algo-reported rupee result is above zero. It counts only when `pnlKnown` is true. |

Why these rules:
- **±0.20% within 60 minutes** is about 50 points. That is larger than one-minute print noise, and
  small enough for an intraday reading to be judged within the hour it is meant for.
- **"Neither" is a miss**, because a reading that leads to no move was not useful.
- **09:20 rather than the open** avoids judging a carry on the first, noisiest print.

The raw numbers (every horizon, the excursions, open and 09:20) are stored, so any other rule can
be evaluated later without re-recording.

## Trap rules — current vs tighter (shadow)

Section `TRAP_SHADOW` measures the live Bear Trap / Bull Trap rules side by side with a tighter
version. **It changes no decision**: it is computed after fusion, the EOD decision and the Turn
Tracker (`src/trapShadow.js`, called from `refreshLiveSnapshot`), from values already computed, and
only the scorecard and a display-only `trapShadow` field of the API response receive it. It sends
no Telegram and is not part of the daily scorecard message. `TRAP_SHADOW_ENABLED=false` (or `0`)
turns the capture off.

Four variants are recorded, each once on its rising edge (re-armed only after it has been false for
10 minutes, `TRAP_SHADOW_REARM_MIN`, so a flickering label counts once):

| Variant | Fires when |
|---|---|
| `BEAR_TRAP_BASE` (bullish) | exactly the live rule: quadrant LONG_UNWINDING and (floor put-writing blitz or ΔPCR ≥ 1.30) |
| `BEAR_TRAP_STRICT` | base and all five conditions below pass |
| `BULL_TRAP_BASE` (bearish) | exactly the live rule: quadrant SHORT_COVERING and (roof call-writing blitz or ΔPCR ≤ 0.75) |
| `BULL_TRAP_STRICT` | base and all five mirrored conditions pass |

The five conditions (bear trap; the bull trap is the mirror with call writing, the roof and a rise):

| Condition | Default | Env override |
|---|---|---|
| **strength** — the day's writing is one-sided | ΔPCR ≥ 1.35 and put − call writing > 0 (bull: ΔPCR ≤ 0.70 and net < 0) | `TRAP_SHADOW_BEAR_MIN_DELTA_PCR`, `TRAP_SHADOW_BULL_MAX_DELTA_PCR` |
| **recent** — the writing is happening now | net writing (put − call) changed by ≥ +28,000 over the last 30 min (bull: ≤ −26,000) | `TRAP_SHADOW_RECENT_WINDOW_MIN`, `TRAP_SHADOW_BEAR_MIN_NET_CHANGE`, `TRAP_SHADOW_BULL_MAX_NET_CHANGE` |
| **relative** — writing is large next to the futures position change | \|net writing change\| / max(\|futures combined-OI change\|, 1) ≥ 3 over the same 30 min | `TRAP_SHADOW_MIN_RELATIVE_RATIO` |
| **proximity** — price is within reach of the defended strike | −25 ≤ spot − floor ≤ 75 points (bull: −25 ≤ roof − spot ≤ 75) | `TRAP_SHADOW_MAX_DISTANCE_PTS`, `TRAP_SHADOW_MAX_BREAK_PTS` |
| **stalled** — the move has stopped | the lowest futures price of the last 20 min is ≥ 5 min old and the current price is ≥ 0.03% above it (bull: the high, and below it) | `TRAP_SHADOW_STALL_WINDOW_MIN`, `TRAP_SHADOW_STALL_MIN_AGE_MIN`, `TRAP_SHADOW_STALL_MIN_BOUNCE_PCT` |

Windows use real (non-synthetic) ticks only and need a tick within 3 minutes of the window start
and no hole over 5 minutes (`TRAP_SHADOW_WINDOW_START_TOL_MIN`, `TRAP_SHADOW_WINDOW_MAX_GAP_MIN`).
A condition that cannot be evaluated (missing strike, gappy window) is listed as `unverified` and
counts as not passed, so the strict variant cannot fire on missing data. Every event stores each
condition's raw values (ΔPCR, net writing change, futures-OI change and ratio, distance to the
strike, the extreme's price/time and the bounce), so the thresholds can be re-fitted later from
recorded events without re-recording. The settings snapshot includes the shadow config.

**Reading it after 20–30 sessions.** In the rolling table the section has one row per variant.
Compare each STRICT row with its BASE row: a tighter rule is worth switching to only if its hit
rate is clearly higher — its Wilson interval should sit above the base's, not just overlap it — and
it still fires often enough to matter (look at the event count, and ignore any row marked "too few
to judge"). If strict fires on almost nothing, look at which conditions fail most in the day CSVs
(`failed` / `unverified` in each event) before loosening any one of them. Nothing switches
automatically; changing the live rule is a separate, deliberate code change.

## Finalisation and messages

- **When a day is finalised.** At the first refresh at or after 15:38. If nothing refreshed then,
  it happens idempotently on the first `GET /api/scorecard?date=` for that day.
- **Days with no session are never finalised.** A closed weekend day (any Saturday/Sunday not in
  the Muhurat date list, `src/marketCalendar.js` / `MUHURAT_DATES`) or a day with no timeline ticks
  and no recorded events (e.g. an exchange holiday) writes no day document and sends no Telegram;
  `?date=` answers `200 { noSession: true }`. Stored documents with zero ticks and zero events, or
  dated on a closed weekend day, are not counted as sessions in the rolling aggregate.
- **Daily Telegram.** One compact message per session:
  - data coverage;
  - per section: events, hits / measurable, and the most notable hit and miss;
  - trades with their rupee result;
  - anything unmeasurable, and why.
- **Next-morning Telegram.** One short message once the EOD outcome is known.

## API and export

| Request | Returns |
|---|---|
| `GET /api/scorecard?date=YYYY-MM-DD` | One day in full: events, outcomes, data quality and notes. Add `series=1` for the per-minute series. On a live session, the outcomes measured so far. |
| `GET /api/scorecard?days=30` | The rolling aggregate per section (1–180 days). See the fields below. |
| `&format=csv` | Either of the above as CSV. |

The rolling aggregate gives, per section:
- sessions, events and measurable events;
- excluded unmeasurable events (and how many);
- pending outcomes;
- hits, hit rate, and the 95% Wilson interval;
- `tooFewToJudge`, true below 30 measurable events (`SCORECARD_MIN_SAMPLE`);
- the mean forward move at each horizon;
- the mean favourable and adverse excursion over 60 minutes;
- for the Turn Tracker, the same split by stage; for signals, the same split by decision.

**Public vs authenticated.** The panel statistics and events are public. Rupee trade results, the
`TRADE` section and the settings snapshot are shown only to a caller with the webhook secret
(`x-webhook-secret` header or `?key=`).

The dashboard's **Scorecard** tab shows the rolling table and the chosen day's events with
outcomes. Every rate is shown with its sample size, and with "too few to judge" below the minimum.

## Backfill (11-Nov and 12-Nov)

The script replays the two captured payloads in `test/fixtures/` through the same capture and
measurement code. Days it produces are marked `backfilled`, with their gaps listed. It never runs
on deploy.

```bash
node scripts/backfill-scorecard.mjs
```

```bash
node scripts/backfill-scorecard.mjs --out ./scorecard-backfill
```

```bash
TV_WEBHOOK_SECRET=<secret> node scripts/backfill-scorecard.mjs --post https://niftyninjaa.vercel.app
```

- The first command is a dry run: it prints the summaries and writes nothing.
- The second also saves the two day documents as JSON.
- The third writes them through the authenticated `POST /api/scorecard` action `backfill`. It
  refuses to overwrite a live-recorded day.

What the backfill can and cannot reconstruct:
- **Can:** the series; the Turn Tracker and radar, recomputed minute by minute with the current
  code; whole-day quadrant changes, taken from each tick; and the final EOD reading as captured.
- **Cannot:** fusion scenario changes, per-slot EOD readings, signals and trades.

## How to use this after 20–30 sessions

1. **Look at the sample before the rate.** A rate marked "too few to judge", or with a wide Wilson
   interval, does not support a change. 60% from 10 events cannot be told apart from 40%.
2. **Compare against a baseline.** Before raising or lowering a threshold, compare the section's
   hit rate with the rate of the same band rule applied to every minute of the same sessions, or
   to the opposite direction. A 55% hit rate means little if price drifted the same way on most
   days.
3. **Check the excluded counts.** If many events are unmeasurable, the measured ones may not be
   representative: for example, mornings only.
4. **Compare by stage or decision.** A Turn Tracker stage that does no better than the stage
   before it is not adding information. Vetoed signals that hit as often as approved ones mean the
   veto is not helping.
5. **Judge a new threshold on new data.** A threshold tuned on the same sessions it is judged on
   will look better than it is: it partly fits that sample's noise, which will not repeat. Choose
   it on the first 20 sessions, then judge it only on sessions recorded after the change. Every
   day's settings snapshot tells you which settings produced which readings.
6. **Change one thing at a time,** and note the date. Mixed settings within one comparison window
   cannot be attributed.
