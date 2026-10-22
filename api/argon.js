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
    });
    if (!response.ok) {
      throw new Error(`Google Doc fetch failed with status ${response.status}`);
    }
    const rawText = await response.text();
    const sessions = parseArgonDoc(rawText);

    const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const currentDayName = dayNames[nowIst.getDay()];

    const todaySession = sessions.find(s =>
      s.session.toLowerCase().includes(currentDayName.toLowerCase())
    ) || sessions[1] || sessions[0] || null;

    const payload = {
      success: true,
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions,
      todaySession,
      currentDay: currentDayName,
    };

    cache = { data: payload, timestamp: now };
    return res.status(200).json(payload);
  } catch (err) {
    console.error("Argon API error:", err);
    if (cache.data) {
      return res.status(200).json(cache.data);
    }
    return res.status(500).json({
      success: false,
      error: err.message,
      sessions: [],
    });
  }
}
