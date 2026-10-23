const DOC_URL = "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/export?format=txt";

let cache = {
  data: null,
  timestamp: 0,
};

export function parseArgonDoc(text) {
  const start = text.indexOf("Phase-by-Phase & Day-Before Execution Table");
  if (start === -1) return [];
  const end = text.indexOf("Tab 2: Q4 Macro & Sector Map", start);
  const section = end !== -1 ? text.slice(start, end) : text.slice(start);
  const cells = section.split("\t").map(s => s.trim()).filter(Boolean);
  const headerIdx = cells.findIndex(c => c.includes("Lead / Shelter Sectors vs. Avoid"));
  if (headerIdx === -1) return [];
  const rows = [];
  const dataCells = cells.slice(headerIdx + 1);
  for (let i = 0; i < dataCells.length; i += 5) {
    const group = dataCells.slice(i, i + 5);
    if (group.length === 5) {
      const session = group[0].replace(/\r?\n/g, " ").trim();
      const stance = group[1].replace(/\r?\n/g, " ").trim();
      const forecast = group[2].replace(/\r?\n/g, " ").trim();
      const action = group[3].replace(/\r?\n/g, " ").trim();
      const sectors = group[4].replace(/\r?\n/g, " ").trim();
      rows.push({ session, stance, forecast, action, sectors });
    }
  }
  return rows;
}

const FALLBACK_SESSIONS = [
  {
    session: "Wednesday (Expiry Transition)",
    stance: "BEARISH BOUNCE-FADE (HIGH)",
    forecast: "Rejection expected around 22,780–22,820 roof. Downside targets 22,600 and 22,500.",
    action: "Do not chase early morning gap-ups. Look for exhaustion candles near Call writing walls to initiate puts.",
    sectors: "Lead: FMCG, Pharma (defensives). Avoid: High beta metals, leveraged midcaps."
  },
  {
    session: "Thursday (Today / Execution Focus)",
    stance: "RANGEBOUND TO BEARISH BIAS (HIGH)",
    forecast: "Roof firm at 22,800. Key floor support at 22,600. Breakdown below 22,600 triggers cascade to 22,500.",
    action: "Sell calls on rallies toward 22,750–22,800. Take puts in Tier-C distribution stocks if floor shows signs of unwinding.",
    sectors: "Shelter: IT select, FMCG. High Risk: Private Banks, Realty."
  },
  {
    session: "Friday (Weekly Reset)",
    stance: "SELECTIVE BOUNCE REVERSAL (MODERATE)",
    forecast: "Potential technical bounce if 22,500 holds as major weekly put base. Overhead cap at 22,700.",
    action: "Light positioning only. Look for high conviction accumulation setups for swing calls.",
    sectors: "Lead: Auto, Energy. Avoid: Distressed margin stocks."
  },
  {
    session: "Monday (Follow-through)",
    stance: "TREND CONFIRMATION (HIGH)",
    forecast: "Directional expansion session. Watch open interest buildup at 22,500 vs 22,700.",
    action: "Ride directional momentum confirmed by morning 9:30 AM delta OI threshold breach.",
    sectors: "Align strictly with institutional accumulation liquidity list."
  }
];

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  res.setHeader("Cache-Control", "s-maxage=120, stale-while-revalidate=300");

  const now = Date.now();
  if (cache.data && now - cache.timestamp < 120000) {
    return res.status(200).json(cache.data);
  }

  try {
    const response = await fetch(DOC_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) {
      throw new Error(`Google Doc fetch failed with status ${response.status}`);
    }
    const rawText = await response.text();
    const sessions = parseArgonDoc(rawText);
    const validSessions = sessions.length > 0 ? sessions : FALLBACK_SESSIONS;

    const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const currentDayName = dayNames[nowIst.getDay()];

    const todaySession = validSessions.find(s =>
      s.session.toLowerCase().includes(currentDayName.toLowerCase())
    ) || validSessions[1] || validSessions[0] || null;

    const payload = {
      success: true,
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions: validSessions,
      todaySession,
      currentDay: currentDayName,
    };

    cache = { data: payload, timestamp: now };
    return res.status(200).json(payload);
  } catch (err) {
    console.error("Argon API error, serving fallback:", err);
    if (cache.data) {
      return res.status(200).json(cache.data);
    }
    const fallbackPayload = {
      success: true,
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions: FALLBACK_SESSIONS,
      todaySession: FALLBACK_SESSIONS[1],
      currentDay: "Thursday",
    };
    return res.status(200).json(fallbackPayload);
  }
}
