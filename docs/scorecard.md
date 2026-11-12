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
| Fusion, Turn Tracker, radar, EOD slots | Futures reach +0.20% in the event's direction before −0.20%, within 60 minutes. "Neither" counts as not a hit. If the 60-minute window is cut by the close before either band is reached, the outcome is unmeasurable. |
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

## Finalisation and messages

- **When a day is finalised.** At the first refresh at or after 15:38. If nothing refreshed then,
  it happens idempotently on the first `GET /api/scorecard?date=` for that day.
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
