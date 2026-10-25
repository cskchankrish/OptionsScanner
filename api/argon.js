const DOC_URL = "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/export?format=txt";

let cache = {
  data: null,
  timestamp: 0,
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH_REGEX_STR = MONTHS.join("|");

export function parseArgonDoc(text) {
  if (!text || typeof text !== "string") return [];

  // 1. Isolate Tab 1 (the live current week plan) before any Archive/Tab 2 sections
  let targetText = text;
  const tab2Idx = text.search(/Tab\s*2\s*:/i);
  if (tab2Idx !== -1) {
    targetText = text.slice(0, tab2Idx);
  } else {
    const archiveIdx = text.search(/4\.\s*Completed\s*Week\s*Correlation/i);
    if (archiveIdx !== -1) {
      targetText = text.slice(0, archiveIdx);
    }
  }

  // 2. Extract Document-level Date Range if available (e.g. "Oct 26 – Oct 30, 2026" or "Week 44 (Oct 26 – Oct 30)")
  const docRangeRegex = new RegExp(`\\b(${MONTH_REGEX_STR})[a-z]*\\.?\\s+(\\d{1,2})\\s*[–—-–]\\s*(?:(${MONTH_REGEX_STR})[a-z]*\\.?\\s+)?(\\d{1,2})\\b`, "i");
  const docRangeMatch = targetText.match(docRangeRegex);

  let defaultMonth = "";
  let startDayNum = 0;
  if (docRangeMatch) {
    const mRaw = docRangeMatch[1].slice(0, 3);
    defaultMonth = mRaw.charAt(0).toUpperCase() + mRaw.slice(1).toLowerCase();
    startDayNum = parseInt(docRangeMatch[2], 10);
  }

  // 3. Split by Tab characters (\t)
  const cells = targetText.split("\t").map(s => s.trim()).filter(Boolean);
  const rows = [];
  const dayRegex = /^(Monday|Tuesday|Wednesday|Thursday|Friday)/i;
  const monthRegex = new RegExp(`\\b(${MONTH_REGEX_STR})[a-z]*\\.?\\s+(\\d{1,2})\\b`, "i");
  const dayNumMonthRegex = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_REGEX_STR})[a-z]*\\b`, "i");

  let i = 0;
  let weekdayCounter = 0;
  const dayOrder = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];

  while (i < cells.length) {
    const rawCell = cells[i];
    const cleanCell = rawCell.replace(/\r?\n/g, " ").trim();
    const dayMatch = cleanCell.match(dayRegex);

    if (dayMatch && i + 4 < cells.length) {
      // Ensure the next cell is NOT another day name (headers or accidental adjacent matches)
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
            // Fallback: calculate day offset from Monday using JavaScript Date arithmetic
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

        // Clean any trailing section notes from the last row
        if (sectors.includes("4. Completed Week")) {
          sectors = sectors.split("4. Completed Week")[0].trim();
        } else if (sectors.includes("Tab 2:")) {
          sectors = sectors.split("Tab 2:")[0].trim();
        }

        const label = dateStr ? `${matchedDay} · ${dateStr}` : matchedDay;

        rows.push({
          session: fullSession,
          day: matchedDay,
          date: dateStr,
          label: label,
          stance: stance,
          forecast: forecast,
          action: action,
          sectors: sectors
        });

        weekdayCounter++;
        i += 5;
        continue;
      }
    }
    i++;
  }

  return rows;
}

const FALLBACK_SESSIONS = [
  {
    session: "Monday, Oct 26 (Purnima / Ashwini Nakshatra; Rahu Kaal 07:53–09:17 IST)",
    day: "Monday",
    date: "26 Oct",
    label: "Monday · 26 Oct",
    stance: "STAY OUT · PRE-EXPIRY CHOP (HIGH)",
    forecast: "Weak Open & Range-Bound Shakeout (22,450–22,680): GIFT Nifty at 22,535.50 (-72 pts) and FII index future shorts keep sentiment subdued. Ketu-ruled Ashwini Nakshatra and Full Moon trigger erratic swings; index tests support near 22,410–22,480.",
    action: "ACTION AT MON CLOSE (14:45–15:25 IST) FOR TUESDAY: NO LONG STOCK CEs (0% Exposure). Do not carry long options into Tuesday's high-risk Monthly Expiry settlement day. Stay 100% cash in Stock CEs.",
    sectors: "SHELTER: Pharma & Healthcare, FMCG Defensives. AVOID: High-Beta Midcaps, Broking, Rate-Sensitives."
  },
  {
    session: "Tuesday, Oct 27 (Monthly F&O Expiry Day; Bharani Nakshatra)",
    day: "Tuesday",
    date: "27 Oct",
    label: "Tuesday · 27 Oct",
    stance: "EXPIRY PINNING · NO FRESH LONGS (HIGH)",
    forecast: "Gamma Squeeze to 22,700 Max Pain, Then Afternoon Pin: Expiry liquidation in Venus-ruled Bharani Nakshatra. High call additions at 22,700 and 22,800 cap upside at Weekly Central Pivot (22,715.75), pinning spot between 22,550 and 22,700.",
    action: "ACTION AT TUE CLOSE (15:00–15:25 IST) FOR WEDNESDAY: CONDITIONAL YES (50% Starter Size — Strictly Nov 2026 Expiry): Once October expiry contracts expire, if Nifty closes above 22,580, initiate selective starter CEs in strong large-caps (Base Metals / IT) for post-expiry bounce.",
    sectors: "LEAD (For Nov Series): Base Metals, Mining, Defensive IT. AVOID: Oct expiry contracts (100% exit before 15:00 IST)."
  },
  {
    session: "Wednesday, Oct 28 (New Series Inception; Krittika Nakshatra)",
    day: "Wednesday",
    date: "28 Oct",
    label: "Wednesday · 28 Oct",
    stance: "TACTICAL REBOUND LEG 1 (MODERATE)",
    forecast: "New Series Relief Lift Toward 22,750–22,820: Post-expiry short covering supported by DII cash flows (+₹3,200+ Cr pace) lifts Nifty above the 22,715.75 Weekly Pivot toward Camarilla R3 (22,820.89). Sun-ruled Krittika star brings sharp selective momentum.",
    action: "ACTION AT WED CLOSE (14:45–15:25 IST) FOR THURSDAY: YES — HOLD / ADD T+1 STOCK CEs (75% Size) if Nifty sustains above 22,720 at 15:15 IST, targeting Thursday's Rohini continuation.",
    sectors: "LEAD: Base Metals, Mining (strongest late-Oct call), Capital Goods, Pharma. AVOID: Leveraged NBFCs, Broking."
  },
  {
    session: "Thursday, Oct 29 (Karwa Chauth; Rohini Nakshatra Exaltation)",
    day: "Thursday",
    date: "29 Oct",
    label: "Thursday · 29 Oct",
    stance: "PEAK MOMENTUM · BOOK 50–70% (HIGH)",
    forecast: "Morning Surge to 22,820–22,950 Followed by Midday Top: Moon in exaltation in Rohini Nakshatra with Variyan Yoga brings the best risk-on sentiment of the week. Nifty tests the 22,820–22,950 resistance pocket (approaching Fib R1 at 23,022.59).",
    action: "ACTION AT THU CLOSE (14:50–15:25 IST) FOR FRIDAY: BOOK 50–70% PROFITS on Stock CEs. Trail stop-loss on remaining 30% runners to cost. Do not enter aggressive fresh long swings here.",
    sectors: "LEAD: Consumer, Retail, FMCG, Private Banks. AVOID: Chasing extended momentum."
  },
  {
    session: "Friday, Oct 30 (Mrigashira Nakshatra)",
    day: "Friday",
    date: "30 Oct",
    label: "Friday · 30 Oct",
    stance: "CONSOLIDATION · EXIT TO CASH (HIGH)",
    forecast: "Two-Way Consolidation & Pre-Weekend Fade (22,680–22,850): Mars-ruled Mrigashira star and pre-weekend de-risking under Mercury Retrograde lead to profit booking.",
    action: "ACTION AT FRI CLOSE (14:45–15:15 IST) FOR MONDAY: NO — EXIT 100% OF STOCK CEs TO CASH. Carry zero leverage into November 1st week under active Mercury retrograde.",
    sectors: "SHELTER ONLY: Pharma & Healthcare, Cash."
  }
];

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
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=180");

  const now = Date.now();
  if (cache.data && now - cache.timestamp < 60000) {
    return res.status(200).json(cache.data);
  }

  const { dayName: currentDayName, dayNum } = getIstDayInfo();

  try {
    const response = await fetch(DOC_URL, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(4000),
    });
    if (!response.ok) {
      throw new Error(`Google Doc fetch failed with status ${response.status}`);
    }
    const rawText = await response.text();
    const sessions = parseArgonDoc(rawText);
    const validSessions = sessions.length > 0 ? sessions : FALLBACK_SESSIONS;
    const todaySession = findBestSession(validSessions, currentDayName, dayNum);

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
    const todaySession = findBestSession(FALLBACK_SESSIONS, currentDayName, dayNum);
    const fallbackPayload = {
      success: true,
      updatedAt: new Date().toISOString(),
      docUrl: "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing",
      sessions: FALLBACK_SESSIONS,
      todaySession,
      currentDay: currentDayName,
    };
    return res.status(200).json(fallbackPayload);
  }
}
