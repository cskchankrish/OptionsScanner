/**
 * Signal Telegram must always be accepted by Telegram's legacy Markdown parser.
 * 18-Nov-2026: a BEAR_TRAP_BUY was BLOCKED_BY_ACTIVE_TRADE behind a SYNERGY_BEAR short; the reason
 * "(SYNERGY_BEAR SHORT @ 25256.25, …)" carried one unpaired "_", Telegram rejected the message
 * (400 can't parse entities) and sendTelegramAlert ignored the response, so it never arrived.
 * Also: the website's bridge strip showed that 0-lot blocked LONG as a green buy.
 */
import test from "node:test";
import assert from "node:assert/strict";

for (const k of [
  "UPSTASH_REDIS_REST_URL", "KV_REST_API_URL", "REDIS_REST_URL", "UPSTASH_REDIS_URL",
  "UPSTASH_REDIS_REST_TOKEN", "KV_REST_API_TOKEN", "REDIS_REST_TOKEN", "UPSTASH_REDIS_TOKEN",
  "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID", "FLOW_BRIDGE_ENABLED", "TV_ACK_DEADLINE_MS", "FLOW_ALGO_SQUAREOFF_TIME",
]) delete process.env[k];

const webhook = await import("../api/tv-webhook.js");
const { tvSignalTone } = await import("../src/tvSignalTone.js");

/**
 * Telegram legacy-Markdown acceptance (parse_mode "Markdown"): `\` escapes _ * ` [ outside an
 * entity; *bold*, _italic_, `code`, ```pre``` and [text](url) must each be closed; entities do not
 * nest, so everything up to the closing marker is literal. Returns null when accepted, else why.
 */
function legacyMarkdownError(text) {
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && "_*`[".includes(s[i + 1])) { i++; continue; }
    if (c === "`" && s.startsWith("```", i)) {
      const end = s.indexOf("```", i + 3);
      if (end < 0) return `unclosed \`\`\` at ${i}`;
      i = end + 2; continue;
    }
    if (c === "*" || c === "_" || c === "`") {
      const end = s.indexOf(c, i + 1);
      if (end < 0) return `unclosed ${c} at ${i}: …${s.slice(Math.max(0, i - 20), i + 20)}…`;
      i = end; continue;
    }
    if (c === "[") {
      const m = /^\[[^\]]*\]\([^)]*\)/.exec(s.slice(i));
      if (!m) return `unclosed [ at ${i}`;
      i += m[0].length - 1;
    }
  }
  return null;
}

test("checker sanity: what Telegram rejects and accepts", () => {
  assert.match(legacyMarkdownError("BLOCKED: Active trade already open (SYNERGY_BEAR SHORT @ 25256.25)"), /unclosed _/);
  assert.equal(legacyMarkdownError("*EXECUTE_HIGH_CONVICTION_SYNERGY* · `SYNERGY_BULL`"), null, "underscores inside an entity are literal");
  assert.equal(legacyMarkdownError("SYNERGY\\_BEAR \\*x\\* \\`y \\[z"), null);
});

const SNAP = { snapshotAt: Date.now() - 20_000, snapshotSource: "poller", corridor: { deltaPCR: 1.4, floorStrike: 25200, roofStrike: 25400 }, futures: { quadrant: "LONG_BUILDUP" }, smartMoneyFusion: { primaryScenario: "MIXED_FLOW", actionTag: "NEUTRAL" } };
const TRAP = { sym: "NSE:NIFTY", tf: "15", dir: "LONG", grade: "BEAR_TRAP_BUY", close: 25237.05, sl: 25150.14, cappedSl: 25150.14, rDist: 86.91, t1Dist: 86.91, t2Dist: 173.82, futQuad: "SHORT_BUILDUP" };
const BLOCKED_REASON = "BLOCKED: Active trade already open (SYNERGY_BEAR SHORT @ 25256.25, id ft-1794978028634-5df13194). The tested system strictly enforces one position at a time.";

function fusedWith(over) {
  const f = webhook.fuseChartWithOptionChain(TRAP, SNAP, Date.now());
  return { ...f, ...over };
}

test("18-Nov BLOCKED message (the one that never arrived) is now valid legacy Markdown and keeps the text", () => {
  const txt = webhook.formatTelegramAlert(fusedWith({ decision: "BLOCKED_BY_ACTIVE_TRADE", recommendedLots: 0, reasoning: BLOCKED_REASON }));
  assert.equal(legacyMarkdownError(txt), null, txt);
  assert.ok(txt.includes("SYNERGY\\_BEAR SHORT @ 25256.25"), "escaped, so Telegram prints SYNERGY_BEAR literally");
  assert.ok(txt.startsWith("🚫 *BLOCKED_BY_ACTIVE_TRADE* · `BEAR_TRAP_BUY` (LONG)"));
});

test("every alert branch stays valid with underscores, asterisks, backticks and brackets in free text", () => {
  const nasty = "SYNERGY_BEAR vs BULL_TRAP_SELL *odd [bracket `tick";
  for (const decision of ["VETO_STALE_OPTION_CHAIN", "VETO_DIVERGENT_SYNERGY", "VETO_SIGNAL", "LOG_ONLY", "BLOCKED_BY_ACTIVE_TRADE", "EXECUTE_TIER1_SCOUT", "EXECUTE_HIGH_CONVICTION_SYNERGY"]) {
    const txt = webhook.formatTelegramAlert(fusedWith({ decision, reasoning: nasty, symbol: "NSE:NIFTY_FUT", snapshotProvenance: "poller_v2 (age 18s)" }));
    assert.equal(legacyMarkdownError(txt), null, `${decision}:\n${txt}`);
  }
});

test("mdEscape escapes exactly _ * ` [", () => {
  assert.equal(webhook.mdEscape("a_b*c`d[e]f"), "a\\_b\\*c\\`d\\[e]f");
  assert.equal(webhook.mdEscape(null), "");
});

// ── sendTelegramAlert: response checked, one plain-text fallback on 400 ──

async function withFetch(responses, fn) {
  const calls = [];
  const orig = globalThis.fetch;
  const prev = { a: process.env.TELEGRAM_BOT_TOKEN, b: process.env.TELEGRAM_CHAT_ID };
  process.env.TELEGRAM_BOT_TOKEN = "test-bot";
  process.env.TELEGRAM_CHAT_ID = "1";
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const r = responses[Math.min(calls.length - 1, responses.length - 1)];
    if (r === "throw") throw new Error("network down");
    return new Response(JSON.stringify({ ok: r === 200, description: r === 400 ? "Bad Request: can't parse entities" : "" }), { status: r });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = orig;
    if (prev.a === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = prev.a;
    if (prev.b === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = prev.b;
  }
}

const blocked = () => fusedWith({ decision: "BLOCKED_BY_ACTIVE_TRADE", recommendedLots: 0, reasoning: BLOCKED_REASON });

test("sendTelegramAlert: accepted first time → one Markdown call, true", async () => {
  await withFetch([200], async (calls) => {
    assert.equal(await webhook.sendTelegramAlert(blocked()), true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].parse_mode, "Markdown");
  });
});

test("sendTelegramAlert: Markdown rejected (400) → exactly one plain-text resend without escapes", async () => {
  await withFetch([400, 200], async (calls) => {
    assert.equal(await webhook.sendTelegramAlert(blocked()), true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].parse_mode, undefined);
    assert.ok(calls[1].text.includes("SYNERGY_BEAR SHORT @ 25256.25"), "plain text shows the grade as written");
  });
  await withFetch([400, 400], async (calls) => {
    assert.equal(await webhook.sendTelegramAlert(blocked()), false);
    assert.equal(calls.length, 2, "never more than one retry");
  });
});

test("sendTelegramAlert: other HTTP errors and network errors → false, no retry, never throws", async () => {
  await withFetch([500], async (calls) => {
    assert.equal(await webhook.sendTelegramAlert(blocked()), false);
    assert.equal(calls.length, 1);
  });
  await withFetch(["throw"], async (calls) => {
    assert.equal(await webhook.sendTelegramAlert(blocked()), false);
    assert.equal(calls.length, 1);
  });
});

test("sendTelegramAlert: no bot configured → false, no call", async () => {
  delete process.env.TELEGRAM_BOT_TOKEN;
  assert.equal(await webhook.sendTelegramAlert(blocked()), false);
});

// ── Website bridge strip tone ──

test("bridge strip: blocked / vetoed / log-only never get the green-red direction badge; the rest unchanged", () => {
  assert.deepEqual(tvSignalTone({ decision: "BLOCKED_BY_ACTIVE_TRADE", direction: "LONG" }), { kind: "BLOCKED", icon: "⛔", note: "blocked — not traded" });
  for (const d of ["VETO_SIGNAL", "VETO_DIVERGENT_SYNERGY", "VETO_STALE_OPTION_CHAIN"]) assert.equal(tvSignalTone({ decision: d, direction: "LONG" }).kind, "VETO");
  assert.equal(tvSignalTone({ decision: "LOG_ONLY", direction: "LONG" }).kind, "INFO");
  assert.deepEqual(tvSignalTone({ decision: "EXECUTE_TIER1_SCOUT", direction: "LONG" }), { kind: "LONG", icon: "🟢", note: null });
  assert.deepEqual(tvSignalTone({ decision: "EXECUTE_HIGH_CONVICTION_SYNERGY", direction: "SHORT" }), { kind: "SHORT", icon: "🔴", note: null });
  assert.equal(tvSignalTone({ decision: "DOWNGRADE_TO_SCALP", direction: "LONG" }).kind, "LONG", "1-lot scalp is traded");
  assert.equal(tvSignalTone({ decision: "TARGET_1_HIT", direction: "SHORT" }).kind, "SHORT", "exits keep today's look");
});
