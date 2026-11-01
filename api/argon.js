const DOC_URL = "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/export?format=txt";

let cache = {
  data: null,
  timestamp: 0,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_REGEX_STR = MONTHS.join("|");

// Upstash Redis / Vercel KV REST integration (Zero extra npm packages needed)
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || process.env.REDIS_REST_URL || process.env.UPSTASH_REDIS_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || process.env.REDIS_REST_TOKEN || process.env.UPSTASH_REDIS_TOKEN;

async function getRedisArgonData() {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const res = await fetch(`${REDIS_URL}/get/argon_live_sessions_v2`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.result) return null;
    return typeof json.result === "string" ? JSON.parse(json.result) : json.result;
  } catch (e) {
    console.warn("Redis argon fetch error:", e.message);
    return null;
  }
}

async function setRedisArgonData(data) {
  if (!REDIS_URL || !REDIS_TOKEN || !data) return false;
  try {
    const res = await fetch(`${REDIS_URL}/set/argon_live_sessions_v2?ex=604800`, { // 7 days TTL
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_TOKEN}`,
        "Content-Type": "text/plain",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(2500),
    });
    return res.ok;
  } catch (e) {
    console.warn("Redis argon save error:", e.message);
    return false;
  }
}

async function fetchGoogleDocWithRetry(url, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/plain,text/html,*/*",
          "Cache-Control": "no-cache",
        },
        signal: AbortSignal.timeout(10000), // 10-second timeout allows Google 307 redirect
      });
      if (response.ok) {
        const text = await response.text();
        if (text && text.length > 500) {
          return text;
        }
      }
    } catch (e) {
      console.warn(`Attempt ${attempt} fetchGoogleDoc error:`, e.message);
      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }
  return null;
}

export function parseArgonDoc(text) {
  if (!text || typeof text !== "string") return [];

  // 1. Isolate Tab 1 (the live current week plan) before any Archive/Tab 2 sections
  let targetText = text;
  const tab2Idx = text.search(/Tab\s*2\s*:/i);
  if (tab2Idx !== -1) {
    targetText = text.slice(0, tab2Idx);
  } else {
    const archiveIdx = text.search(/(?:4|5)\.\s*Completed\s*Week\s*Correlation/i);
    if (archiveIdx !== -1) {
      targetText = text.slice(0, archiveIdx);
    }
  }

  // 2. Extract Document-level Date Range if available (e.g. "Nov 2 – Nov 6, 2026")
  const docRangeRegex = new RegExp(`\\b(${MONTH_REGEX_STR})[a-z]*\\.?\\s+(\\d{1,2})\\s*[–—-–]\\s*(?:(${MONTH_REGEX_STR})[a-z]*\\.?\\s+)?(\\d{1,2})\\b`, "i");
  const docRangeMatch = targetText.match(docRangeRegex);

  let defaultMonth = "";
  let startDayNum = 0;
  if (docRangeMatch) {
    const mRaw = docRangeMatch[1].slice(0, 3);
    defaultMonth = mRaw.charAt(0).toUpperCase() + mRaw.slice(1).toLowerCase();
    startDayNum = parseInt(docRangeMatch[2], 10);
  }

  const dayRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday)/i;
  const monthRegex = new RegExp(`\\b(${MONTH_REGEX_STR})[a-z]*\\.?\\s+(\\d{1,2})\\b`, "i");
  const dayNumMonthRegex = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_REGEX_STR})[a-z]*\\b`, "i");
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  // STRATEGY 1: Tab-separated cells (Google Docs default table text export)
  const cells = targetText.split("\t").map(s => s.trim()).filter(Boolean);
  const rows = [];
  let i = 0;
  let weekdayCounter = 0;

  while (i < cells.length) {
    const rawCell = cells[i];
    const cleanCell = rawCell.replace(/\r?\n/g, " ").trim();
    const dayMatch = cleanCell.match(dayRegex);

    if (dayMatch && i + 4 < cells.length) {
      const nextCellClean = cells[i + 1].replace(/\r?\n/g, " ").trim();
      if (!dayRegex.test(nextCellClean)) {
        const fullSession = cleanCell;
        const matchedDay = dayMatch[1].charAt(0).toUpperCase() + dayMatch[1].slice(1).toLowerCase();

        // Extract Date and Month
        let dateStr = "";
        const m1 = cleanCell.match(monthRegex);
        if (m1) {
          const mName = m1[1].slice(0, 3);
          dateStr = `${m1[2]} ${mName.charAt(0).toUpperCase() + mName.slice(1).toLowerCase()}`;
        } else {
          const m2 = cleanCell.match(dayNumMonthRegex);
          if (m2) {
            const mName = m2[2].slice(0, 3);
            dateStr = `${m2[1]} ${mName.charAt(0).toUpperCase() + mName.slice(1).toLowerCase()}`;
          } else if (defaultMonth && startDayNum > 0) {
            try {
              const dIdx = dayOrder.indexOf(matchedDay);
              const offset = dIdx !== -1 ? dIdx : weekdayCounter;
              const curYear = new Date().getFullYear();
              const baseDate = new Date(`${defaultMonth} ${startDayNum}, ${curYear}`);
              baseDate.setDate(baseDate.getDate() + offset);
              dateStr = `${baseDate.getDate()} ${MONTHS[baseDate.getMonth()]}`;
            } catch (e) {
              dateStr = "";
            }
          }
        }

        const stance = cells[i + 1].replace(/\r?\n/g, " ").trim();
        const forecast = cells[i + 2].replace(/\r?\n/g, " ").trim();
        const action = cells[i + 3].replace(/\r?\n/g, " ").trim();
        let sectors = cells[i + 4].replace(/\r?\n/g, " ").trim();

        // Clean any trailing section notes
        sectors = sectors.split(/(?:\d+\.\s*(?:Weekly|Completed)|Tab\s*2:)/i)[0].trim();

        const label = dateStr ? `${matchedDay} · ${dateStr}` : matchedDay;

        rows.push({
          session: fullSession,
          day: matchedDay,
          date: dateStr,
          label: label,
          stance: stance,
          forecast: forecast,
          action: action,
          sectors: sectors,
        });

        weekdayCounter++;
        i += 5;
        continue;
      }
    }
    i += 1;
  }

  if (rows.length >= 4) {
    return rows;
  }

  // STRATEGY 2: Line/Block-based Regex Fallback (immune to missing or stripped tabs)
  const lineRows = [];
  const lineDayRegex = /^\s*(Monday|Tuesday|Wednesday|Thursday|Friday)\b[^\n]*/gim;
  const matches = [];
  let m;
  while ((m = lineDayRegex.exec(targetText)) !== null) {
    matches.push({ day: m[1], index: m.index, matchText: m[0] });
  }

  for (let idx = 0; idx < matches.length; idx++) {
    const cur = matches[idx];
    const nextIdx = idx + 1 < matches.length ? matches[idx + 1].index : targetText.length;
    const block = targetText.slice(cur.index, nextIdx).trim();
    const blockLines = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    if (blockLines.length >= 2) {
      const fullSession = blockLines[0];
      const matchedDay = cur.day.charAt(0).toUpperCase() + cur.day.slice(1).toLowerCase();

      let dateStr = "";
      const m1 = fullSession.match(monthRegex);
      if (m1) {
        const mName = m1[1].slice(0, 3);
        dateStr = `${m1[2]} ${mName.charAt(0).toUpperCase() + mName.slice(1).toLowerCase()}`;
      } else {
        const m2 = fullSession.match(dayNumMonthRegex);
        if (m2) {
          const mName = m2[2].slice(0, 3);
          dateStr = `${m2[1]} ${mName.charAt(0).toUpperCase() + mName.slice(1).toLowerCase()}`;
        }
      }

      const stance = blockLines[1] || "";
      const forecast = blockLines[2] || "";
      const action = blockLines[3] || "";
      let sectors = blockLines.slice(4).join(" ") || "";
      sectors = sectors.split(/(?:\d+\.\s*(?:Weekly|Completed)|Tab\s*2:)/i)[0].trim();

      const label = dateStr ? `${matchedDay} · ${dateStr}` : matchedDay;
      lineRows.push({
        session: fullSession,
        day: matchedDay,
        date: dateStr,
        label: label,
        stance: stance,
        forecast: forecast,
        action: action,
        sectors: sectors,
      });
    }
  }

  return lineRows.length > 0 ? lineRows : rows;
}

function generateCurrentWeekFallback() {
  const now = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const curDayNum = now.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  const mondayOffset = curDayNum === 0 ? 1 : 1 - curDayNum;

  const mondayDate = new Date(now);
  mondayDate.setDate(now.getDate() + mondayOffset);

  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const sessions = [];

  for (let idx = 0; idx < 5; idx++) {
    const d = new Date(mondayDate);
    d.setDate(mondayDate.getDate() + idx);
    const dayName = dayNames[idx];
    const dateStr = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    sessions.push({
      session: `${dayName}, ${dateStr} (Connecting to live Google Doc plan...)`,
      day: dayName,
      date: dateStr,
      label: `${dayName} · ${dateStr}`,
      stance: "AWAITING LIVE SYNC",
      forecast: "Loading latest weekly execution matrix from Google Doc...",
      action: "Click '🔄 Sync Live Doc' button above to force an immediate refresh if data has just been published.",
      sectors: "SHELTER: Check live doc link above for latest updates.",
    });
  }

  return sessions;
}

function getIstDayInfo() {
  const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = dayNames[nowIst.getDay()];
  return { dayName, dayNum: nowIst.getDay() };
}

function findBestSession(sessions, dayName, dayNum) {
  if (!sessions || sessions.length === 0) return null;
  const lower = dayName.toLowerCase();

  // 1. Direct match on day or session
  let found = sessions.find(s =>
    (s.day && s.day.toLowerCase() === lower) ||
    (s.session && s.session.toLowerCase().includes(lower))
  );
  if (found) return found;

  // 2. Weekend logic: Saturday -> show Friday, Sunday -> show Monday
  if (dayNum === 6) { // Saturday
    found = sessions.find(s =>
      (s.day && s.day.toLowerCase() === "friday") ||
      (s.session && s.session.toLowerCase().includes("friday"))
    );
    if (found) return found;
  } else if (dayNum === 0) { // Sunday -> show Monday
    found = sessions.find(s =>
      (s.day && s.day.toLowerCase() === "monday") ||
      (s.session && s.session.toLowerCase().includes("monday"))
    );
    if (found) return found;
  }

  return sessions[0];
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const isForce = req.query?.force === "true" || req.query?.refresh === "1";
  res.setHeader("Cache-Control", isForce ? "no-store, max-age=0" : "s-maxage=30, stale-while-revalidate=60");

  const now = Date.now();
  if (!isForce && cache.data && now - cache.timestamp < 30000) {
    return res.status(200).json(cache.data);
  }

  const { dayName: currentDayName, dayNum } = getIstDayInfo();

  try {
    const rawText = await fetchGoogleDocWithRetry(DOC_URL, 2);
    let sessions = [];
    if (rawText) {
      sessions = parseArgonDoc(rawText);
    }

    if (sessions && sessions.length >= 4) {
      const todaySession = findBestSession(sessions, currentDayName, dayNum);
      const payload = {
        success: true,
        isLive: true,
        source: "google_doc_live",
        updatedAt: new Date().toISOString(),
        docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
        sessions,
        todaySession,
        currentDay: currentDayName,
      };

      cache = { data: payload, timestamp: now };
      setRedisArgonData(payload).catch(() => {});
      return res.status(200).json(payload);
    }

    // Fallback 1: Redis Cloud Cache (stores the latest successfully parsed doc)
    const redisData = await getRedisArgonData();
    if (redisData && Array.isArray(redisData.sessions) && redisData.sessions.length > 0) {
      const todaySession = findBestSession(redisData.sessions, currentDayName, dayNum);
      const payload = {
        ...redisData,
        isLive: false,
        source: "redis_cloud_cache",
        todaySession,
        currentDay: currentDayName,
      };
      cache = { data: payload, timestamp: now };
      return res.status(200).json(payload);
    }

    // Fallback 2: Dynamically calculated dates for current week
    const dynamicSessions = generateCurrentWeekFallback();
    const todaySession = findBestSession(dynamicSessions, currentDayName, dayNum);
    const fallbackPayload = {
      success: true,
      isLive: false,
      source: "dynamic_current_week",
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions: dynamicSessions,
      todaySession,
      currentDay: currentDayName,
    };
    return res.status(200).json(fallbackPayload);
  } catch (err) {
    console.error("Argon handler error:", err);
    const redisData = await getRedisArgonData();
    if (redisData && Array.isArray(redisData.sessions) && redisData.sessions.length > 0) {
      return res.status(200).json({ ...redisData, isLive: false, source: "redis_error_fallback" });
    }
    const dynamicSessions = generateCurrentWeekFallback();
    const todaySession = findBestSession(dynamicSessions, currentDayName, dayNum);
    return res.status(200).json({
      success: true,
      isLive: false,
      source: "dynamic_error_fallback",
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions: dynamicSessions,
      todaySession,
      currentDay: currentDayName,
    });
  }
}
