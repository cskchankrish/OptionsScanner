# IV shadow (measurement only)

## Why

17-Nov-2026: a SYNERGY_BULL was skipped by the Algo's premium cap (1 lot of the call cost ₹25,792).
The question was whether an "expensive" premium means a pullback is due, so the system should be
cautious.

The rupee premium mostly reflects time to expiry. The comparable measure is **implied volatility
(IV)**. ₹397/unit for a December-monthly option near the money works out to roughly 11–12% IV,
which is normal for NIFTY. Whether *high* IV at a signal really predicts a worse outcome is an open
question, so it is measured before any rule uses it.

## What is recorded

- **Poller**: every live chain refresh stores `ivAtm` in `nifty:flow:latest`:
  `{ strike, ceIv, peIv, atmIv, skew, ceLtp, peLtp, expiry }`.
  - **ATM strike**: the strike nearest spot where both the call and the put have an IV quoted.
  - **atmIv**: the mean of the call and put IV at that strike.
  - **skew**: put IV minus call IV. It is positive when puts are richer, which is NIFTY's usual state.
  - **IV values**: NSE's per-strike `impliedVolatility`, in percent.
  - **Expiry**: the scanner's own chain expiry, not necessarily the contract the Algo trades.
- **Webhook**: every real TradingView signal (`fusedVerdict.ivShadow`) and every shadow candidate
  (`record.iv`) copies it **after** the decision is made. The scorecard SIGNAL / CANDIDATE event
  carries it as `data.iv`.

## Where to see it

**Scorecard tab → TradingView signals and Candidate alerts.** Each section has extra rows "IV shadow
— low / mid / high / not recorded":
- **Bands**: terciles of the ATM IV recorded on the window's signals and candidates. Their cut-offs
  are shown in the row labels and returned as `ivBands` by `GET /api/scorecard?days=N`.
- **Hit rule**: unchanged (T1 before the stop, same session).
- **CSV**: rows `iv:LOW|MID|HIGH|UNKNOWN`.

Old days (before this change) show as "not recorded".

## How to read it

After 20–30 sessions with enough signals in each band (no "too few to judge"):
- **High-IV hit rate clearly below low-IV** (95% ranges not overlapping): a "high IV → caution" rule
  (smaller size, or skip) is worth proposing and testing.
- **Hit rates about the same**: premium level is not a timing signal; leave it out.

## Guarantees

- **No effect on trading**: nothing reads the IV fields for a decision, veto, sizing, Telegram text
  or the Algo payload (the flow entry is built from explicit fields; tested).
- **Nothing breaks without it**: a missing or unquoted IV simply records `null`.
