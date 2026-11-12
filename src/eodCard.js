/**
 * EOD verdict card (12-Nov Part 3). Pure, browser-safe: shared by the scanner (api/nifty-oi.js),
 * the EOD Telegram header (api/tv-webhook.js) and tests. No scoring happens here.
 */

function formatLots(n) {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

/** Trims a plain-language reason to at most 12 words. */
function twelveWords(s) {
  const w = String(s || "").trim().split(/\s+/);
  return w.length <= 12 ? w.join(" ") : `${w.slice(0, 12).join(" ")}…`;
}
const signedNum = (v) => (v > 0 ? `+${v}` : v < 0 ? `−${Math.abs(v)}` : "0");

/**
 * EOD verdict card (Part 3): precise, short, the same wording on the dashboard and in the EOD
 * Telegram header. Built from values calculateEODDecision already computed — no scoring here.
 * automation / dataLine / turnTracker are filled in by the refresh core.
 */
export function buildEodCard({ bias, score, thresh, conviction, thresholdDistance, dataQualityCaveat, stop, targetContract, isRollover, a, b, c }) {
  const headline = bias === "BULLISH" ? "BTST · BUY CE" : bias === "BEARISH" ? "STBT · BUY PE" : "NO CARRY";
  const color = bias === "BULLISH" ? "#16a34a" : bias === "BEARISH" ? "#ef4444" : "#d97706";
  const scoreLine = bias === "BULLISH"
    ? `Score ${signedNum(score)} · needs ≥ +${thresh} for BTST`
    : bias === "BEARISH"
    ? `Score ${signedNum(score)} · needs ≤ −${thresh} for STBT`
    : thresholdDistance.text.replace(/^Score \+0/, "Score 0").replace(/^Score -/, "Score −");
  const agreementLine = bias === "NEUTRAL" || conviction == null ? null : `Agreement ${conviction}/100 — rule agreement, not a probability`;

  const aWords = [
    a.fullDayStatus === "BULLISH" ? "Put writing dominates" : a.fullDayStatus === "BEARISH" ? "Call writing dominates" : "Balanced writing",
    a.pcrStatus === "BULLISH" ? "PCR bullish" : a.pcrStatus === "BEARISH" ? "PCR bearish"
      : /OVERBOUGHT/.test(a.pcrStatus) ? "PCR overbought" : /OVERSOLD|CAPITULATION/.test(a.pcrStatus) ? "PCR oversold" : "PCR neutral",
    a.levelStatus === "BULLISH" ? "spot above floor" : a.levelStatus === "BEARISH" ? (/Roof/.test(a.levelDetail) ? "spot at roof" : "spot near floor") : "spot mid-range",
  ].join("; ");

  const net = formatLots(b.net);
  let bWords;
  if (b.pending) bWords = `Pending — window from ${b.anchor} scores after ${b.activate}`;
  else if (b.unverified) bWords = b.coverage?.worstGap ? `Not enough data (gap ${b.coverage.worstGap.from}–${b.coverage.worstGap.to})` : "Not enough closing-flow data";
  else if (/CALL_BLITZ|^BEARISH$|MILD_BEARISH/.test(b.status)) bWords = `Fresh call writing since ${b.anchor} (net ${net})`;
  else if (/PUT_BLITZ|^BULLISH$|MILD_BULLISH/.test(b.status)) bWords = `Fresh put writing since ${b.anchor} (net ${net})`;
  else if (b.status === "BEARISH_PUT_UNWINDING") bWords = `Put support withdrawn since ${b.anchor} (net ${net})`;
  else if (b.status === "BULLISH_CALL_UNWINDING") bWords = `Call resistance withdrawn since ${b.anchor} (net ${net})`;
  else if (/^MIXED/.test(b.status)) bWords = `Mixed closing flow (net ${net})`;
  else if (/UNCONFIRMED/.test(b.status)) bWords = `Closing flow net ${net}; legs unavailable`;
  else bWords = `No meaningful closing flow (net ${net})`;

  const qWord = { LONG_BUILDUP: "Long build-up", SHORT_BUILDUP: "Short build-up", SHORT_COVERING: "Short covering", LONG_UNWINDING: "Long unwinding", NEUTRAL_CHOP: "Futures flat" }[c.quadrant] || "Futures quadrant unavailable";
  const cWords = c.unverified
    ? "Futures data stale or missing"
    : `${qWord}; basis ${c.basisPts !== 0 ? "confirms" : /contradicts/.test(c.basisDetail || "") ? "contradicts" : /^basis (not scored|unavailable)/.test(c.basisDetail || "") ? "not scored" : "neutral"}`;

  const row = (group, label, g, reason, extra = {}) => ({ group, label, contribution: g.contribution, contributionText: signedNum(g.contribution), reason: twelveWords(reason), unverified: Boolean(g.unverified), ...extra });
  return {
    headline,
    color,
    scoreLine,
    agreementLine,
    rows: [
      row("A", "Options positioning", a, aWords),
      row("B", "Closing flow", b, bWords, { pending: Boolean(b.pending) }),
      row("C", "Futures", c, cWords),
    ],
    stop: stop ?? null,
    contract: targetContract ? `${targetContract}${isRollover ? " (next-week rollover)" : ""}` : null,
    caveat: dataQualityCaveat,
    automation: null,
    dataLine: null,
    turnTracker: null,
  };
}

/** Plain-text lines of the card (EOD Telegram header block; Markdown-safe values only). */
export function formatEodCardLines(card) {
  if (!card) return [];
  const rows = card.rows.map((r) => `  ${r.group} ${r.label}: \`${r.contributionText}\` — ${r.reason}${r.unverified ? " · UNVERIFIED" : ""}`);
  return [
    `*${card.headline}*`,
    `• ${card.scoreLine}${card.agreementLine ? ` · ${card.agreementLine}` : ""}`,
    ...rows,
    `• *Stop:* ${card.stop != null ? `\`${card.stop}\`` : "—"}${card.contract ? ` · *Contract:* ${card.contract}` : ""}`,
    `• *Carry automation:* ${card.automation?.text || "status unavailable"}`,
    card.dataLine ? `• *Data:* ${card.dataLine}` : null,
    card.caveat ? `• ${card.caveat}` : null,
  ].filter(Boolean);
}

