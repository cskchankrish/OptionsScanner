# Plan document (Gemini) — shadow measurement

The dashboard shows a weekly plan written by an LLM (Gemini) in a Google Doc (`api/argon.js`). It mixes
ordinary price levels with astrological timing. Before anything of it is allowed near a decision, its
daily half-day calls are **measured**. This feature is measurement only:

- it feeds **no** decision, order, veto, EOD score, carry decision or Telegram message;
- it sends no Telegram (the `PLAN_DOC` section is filtered out of the daily scorecard message);
- a failure anywhere in it never changes a poll's status code or body (beyond one informational field).

Code: `src/planDocShadow.js` (parsing, snapshot, measurement, orchestration), `api/poll.js` (when),
`src/scorecard.js` (`PLAN_DOC` section), `src/ScorecardView.jsx` (display).

## What is snapshotted, and when

QStash calls `/api/poll` every minute from 08:30 IST on weekdays; before 09:15 it answers `MARKET_CLOSED`.

1. **Pre-open snapshot** (`MARKET_CLOSED` branch). On a weekday session day (src/marketCalendar.js,
   Muhurat weekends excluded) between `PLAN_DOC_SNAPSHOT_START` (default 08:45) and 09:14 IST:
   - claim `nifty:plan:snap_lock:<date>` (SET NX, 20 h);
   - fetch the Google Doc live (`fetchArgonSessionsLive`, capped at 8 s), parse it with `parseArgonDoc`;
   - pick today's entry with `findSessionForDate` — exact `date` ("16 Nov") **and** weekday; never the
     closest day; a document from another week gives no entry;
   - store `nifty:plan:snap:<date>` (SET NX, 400 days).
   If the fetch fails or the document has no entry for today, the lock is released and the next pre-open
   poll retries. The response gets `planSnapshot: "TAKEN" | "RETRY" | "NO_ENTRY" | "TIMEOUT"` only on the
   poll that did the work.
2. **First live poll** (after the refresh, heartbeat, watchdog and bookkeeping of a `LIVE_POLL_SUCCESS`):
   claim `nifty:plan:events_lock:<date>` (SET NX, 20 h), read the snapshot and append one scorecard event
   per parsed call with `recordEvent`. Response field `planEvents: "RECORDED" | "NO_ENTRY" | "TIMEOUT"`
   on that poll only. Skipped (left to the next poll, lock not claimed) when less than 0.5 s of the
   poll's 14 s budget is left; capped at 3 s.

Events are appended only at the first **live** poll, so an exchange holiday with a snapshot but no
session never gets a scorecard day document.

**Later edits to the Google Doc are ignored**: only the snapshot is scored.

### Late snapshots

If no pre-open snapshot exists at the first live poll (QStash down, Google unreachable), a snapshot is
built from the dashboard's Redis cache of the document (`argon_live_sessions_v2`, no network call),
stored with `late: true`, `source: "redis_cache"` and `cacheUpdatedAt`. That cache may have been
refreshed after the open, so late events carry `data.late = true` and the aggregate counts them
(`late`); exclude them when judging the document strictly.

## Parsing a session

`parsePlanCalls(session)` reads only the **stance** (for the calls) and the **forecast** (for the
windows).

- Conviction: `(Conviction: HIGHEST|HIGH|MEDIUM|LOW)`, else `null`.
- The stance text before `(Conviction:` is split on `·`. A phrase tagged `1ST-HALF` / `FIRST HALF` or
  `2ND-HALF` / `SECOND HALF` maps to that half. With no tag anywhere: two phrases → FIRST and SECOND by
  position; one phrase (or three or more, joined) → FULL. When some phrases are tagged, an untagged
  phrase continues the preceding tagged one (and is classified together with it).
- Keyword families (case-insensitive, matched at the start of a word, so `BOUNCE` also matches
  `BOUNCES` and `FALL` also matches `FALLBACK`); exported as constants:
  - bullish `PLAN_BULLISH_KEYWORDS`: BOUNCE, RALLY, RALLIES, RECOVER, STABILI, TURN SETUP, BREAKOUT, BUY,
    UPSIDE, REVERSAL UP, UPTREND
  - bearish `PLAN_BEARISH_KEYWORDS`: REJECT, SELL-OFF, SELLOFF, SELL, FLUSH, BREAKDOWN, DOWNSIDE, STRESS,
    FALL, TEST OF S&lt;digit&gt;, CRASH, DOWNTREND
  - range `PLAN_RANGE_KEYWORDS`: PINNING, PINNED, TWO-WAY, TWO WAY, RANGE, CHOP, WHIPSAW, SIDEWAYS,
    CONSOLIDAT
- **UNPARSED rule (never guess)**: a phrase containing `TRAP`, a phrase matching more than one family,
  or a phrase matching none is `UNPARSED`, with the reason. UNPARSED calls are recorded but not scored.

The week of 16 Nov 2026 parses as:

| Day | First half | Second half | Conviction |
|---|---|---|---|
| Mon 16 | BOUNCE TO SUPPLY → BULLISH, 09:15–12:00 | VYATIPATA REJECTION → BEARISH, 12:30–15:30 | HIGH |
| Tue 17 | TWO-WAY EXPIRY PINNING → RANGE, 09:15–13:00 | LATE RAHU KAAL WHIPSAW → RANGE, 13:00–15:30 | HIGH |
| Wed 18 | TRAP BOUNCE → UNPARSED, 09:15–12:05 | SUN-JUPITER SQUARE SELL-OFF → BEARISH, 12:06–15:30 | HIGHEST |
| Thu 19 | PEAK STRESS WINDOW → BEARISH, 09:15–13:15 | TEST OF S1 / DOWNSIDE FALLBACK → BEARISH, 13:31–15:30 | HIGHEST |
| Fri 20 | FINAL FLUSH/TEST → BEARISH, 09:15–12:15 | STABILIZATION & TURN SETUP → BULLISH, 13:00–15:30 | HIGH |

### Windows

`1st Half (HH:MM–HH:MM IST)` and `2nd Half (…)` are read from the forecast (`–`, `-` or `—`),
clamped to 09:15–15:30. Missing or unusable → defaults FIRST 09:15–12:00, SECOND 12:30–15:30.
FULL is always 09:15–15:30.

## Hit rule

On NIFTY futures (the scorecard's compact series): reference = the first tick at/after the window start
(within 5 minutes), end = the last tick at/before the window end (within 5 minutes); otherwise
`UNMEASURABLE` with the reason. `movePct = (end − ref) / ref × 100`; outcome `UP` if ≥ +band, `DOWN`
if ≤ −band, else `FLAT`; band `PLAN_DOC_BAND_PCT` (default 0.15%).

**Carry-over quotes at the open are never the reference.** NSE's feed often repeats the previous
session's futures quote, OI and cumulative volume on the first tick(s) of a session. `firstLiveIndex`
(src/sessionOpen.js) finds the first tick that belongs to today:
- *Volume reset (primary):* within the first 10 minutes of the series, a tick whose cumulative futures
  volume falls below half of an earlier tick's volume marks a reset; every tick before the last reset
  is carry-over and the reset tick is the first live tick.
- *Fallback when volume is missing:* a leading tick is carry-over only if its OI differs by more than
  1% **and** its futures price by more than 0.25% from the median of the next up-to-5 ticks within
  10 minutes (at least 3 needed), so a genuinely fast open is not discarded.

When a window starts before the first live tick, the reference is the first live tick, provided it is
at most 10 minutes after the window start (otherwise `UNMEASURABLE`); the outcome then carries
`refShifted: true` and `staleSkipped: n`. Windows that start later are unaffected.
Example, Mon 16 Nov 2026 first half (BULLISH, 09:15–12:00): 09:15 showed Friday's 25175 (volume
2,733,315), 09:16 the live 25275 (volume 68,835). Measured from 25175 the half was +0.389% UP (a false
hit); from 25275 it is −0.008% FLAT (a miss).

Stored day documents keep the outcome measured at finalisation. On read (day view, public and
authenticated, and the rolling aggregate) each `PLAN_DOC` event of a document that carries its series
is re-measured with the current rule; if the answer differs it replaces the stored one, marked
`remeasured: true` with `storedHit` / `storedRefPrice`. Nothing is written back and no other section
is re-measured.

Hit: BULLISH → UP, BEARISH → DOWN, RANGE → FLAT. UNPARSED → `NOT_SCORED` (the window move is still
recorded for the base rate).

## Reading the hit rate: the outcome mix

The `PLAN_DOC` section shows the hit rate by half, by call and by conviction **and** the outcome mix:
how many measured windows went up, down or stayed flat. That mix is the base rate. A call type that is
right only as often as its outcome happens anyway has no edge — e.g. if 45% of windows are DOWN, a
BEARISH hit rate of 45% means the document adds nothing. Also mind the sample: two calls a day means 30
sessions ≈ 60 calls in total, split across three call types and three conviction levels.

## Re-parsing from stored raw text

Each snapshot keeps `raw.stance`, `raw.forecast`, `raw.action`, `raw.sectors`, `raw.sessionTitle`
verbatim (`GET /api/scorecard?date=…` returns it as `planDoc`). To change the keyword lists or the
window rule later, re-run `parsePlanCalls(snapshot.raw)` on the stored snapshots and
`buildPlanEvents` + `measureEvent` against the stored day series; the scorecard event list itself is
not rewritten automatically.

## Settings and kill switch

| Env | Default | Meaning |
|---|---|---|
| `PLAN_DOC_SHADOW_ENABLED` | on | `false` / `0` / `off` stops both the snapshot and the events |
| `PLAN_DOC_BAND_PCT` | 0.15 | flat band for the outcome |
| `PLAN_DOC_SNAPSHOT_START` | 08:45 | first IST minute of the pre-open window (must be ≤ 09:14) |

All three are in the scorecard settings snapshot whitelist.
