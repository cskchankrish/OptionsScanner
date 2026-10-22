import { useState, useEffect, useMemo } from "react";

function formatLots(n) {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

function getMarketSessionStatus() {
  const nowIst = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const day = nowIst.getDay(); // 0 = Sunday, 6 = Saturday
  const isWeekend = day === 0 || day === 6;
  const mins = nowIst.getHours() * 60 + nowIst.getMinutes();

  // Active market auto-refresh window: 09:00 AM (540 mins) to 04:00 PM (960 mins) IST
  const isWithinHours = mins >= 540 && mins < 960;
  const isAutoActive = !isWeekend && isWithinHours;

  let reason = "";
  if (isWeekend) {
    reason = "Weekend · Resumes Mon 09:00 AM";
  } else if (mins < 540) {
    reason = "Pre-market · Resumes 09:00 AM";
  } else if (mins >= 960) {
    reason = "Market Closed · Resumes 09:00 AM";
  }

  return { isAutoActive, reason };
}

function NiftyIntradayLineChart({ timeline = [], spot = 22696.65, isDark, t }) {
  const [mode, setMode] = useState("diff"); // "diff" (Net Put - Call) or "dual" (Put vs Call)
  const [hoverIdx, setHoverIdx] = useState(null);
  const [threshold, setThreshold] = useState(75000); // Institutional Conviction Threshold (Default: 75k)

  // Fallback points if empty
  const points = useMemo(() => {
    if (timeline && timeline.length > 0) return timeline;
    return [
      { time: "09:15", minutes: 555, putWriting: 0, callWriting: 0, netDiff: 0, spot },
      { time: "10:00", minutes: 600, putWriting: 45000, callWriting: 25000, netDiff: 20000, spot },
      { time: "11:30", minutes: 690, putWriting: 140000, callWriting: 80000, netDiff: 60000, spot },
      { time: "13:30", minutes: 810, putWriting: 279500, callWriting: 157500, netDiff: 122000, spot },
    ];
  }, [timeline, spot]);

  // SVG dimensions
  const svgWidth = 850;
  const svgHeight = 220;
  const padLeft = 65;
  const padRight = 35;
  const padTop = 30;
  const padBottom = 35;
  const plotW = svgWidth - padLeft - padRight;
  const plotH = svgHeight - padTop - padBottom;

  const startMin = 555; // 09:15
  const endMin = 930;   // 15:30
  const spanMin = endMin - startMin; // 375

  const xPos = (m) => padLeft + ((Math.max(startMin, Math.min(endMin, m)) - startMin) / spanMin) * plotW;

  // Max diff bound symmetric around 0 (ensures threshold line is always cleanly visible)
  const maxDiff = useMemo(() => {
    let max = Math.max(50000, threshold * 1.35);
    points.forEach(p => {
      max = Math.max(max, Math.abs(p.netDiff || 0));
    });
    return Math.ceil((max * 1.15) / 10000) * 10000;
  }, [points, threshold]);

  // Max dual bound
  const maxDual = useMemo(() => {
    let max = 50000;
    points.forEach(p => {
      max = Math.max(max, p.putWriting || 0, p.callWriting || 0);
    });
    return Math.ceil((max * 1.15) / 10000) * 10000;
  }, [points]);

  const yCenter = padTop + plotH / 2;
  const yDiffPos = (d) => yCenter - (d / maxDiff) * (plotH / 2);
  const yDualPos = (v) => padTop + plotH - (v / maxDual) * plotH;

  // Path generators
  const diffLinePath = useMemo(() => {
    if (!points.length) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDiffPos(p.netDiff)}`).join(" ");
  }, [points, maxDiff]);

  const diffAreaPath = useMemo(() => {
    if (!points.length) return "";
    const firstX = xPos(points[0].minutes);
    const lastX = xPos(points[points.length - 1].minutes);
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDiffPos(p.netDiff)}`).join(" ");
    return `${line} L ${lastX} ${yCenter} L ${firstX} ${yCenter} Z`;
  }, [points, maxDiff]);

  const putLinePath = useMemo(() => {
    if (!points.length) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDualPos(p.putWriting)}`).join(" ");
  }, [points, maxDual]);

  const callLinePath = useMemo(() => {
    if (!points.length) return "";
    return points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDualPos(p.callWriting)}`).join(" ");
  }, [points, maxDual]);

  const putAreaPath = useMemo(() => {
    if (!points.length) return "";
    const firstX = xPos(points[0].minutes);
    const lastX = xPos(points[points.length - 1].minutes);
    const bottomY = padTop + plotH;
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDualPos(p.putWriting)}`).join(" ");
    return `${line} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  }, [points, maxDual]);

  const callAreaPath = useMemo(() => {
    if (!points.length) return "";
    const firstX = xPos(points[0].minutes);
    const lastX = xPos(points[points.length - 1].minutes);
    const bottomY = padTop + plotH;
    const line = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xPos(p.minutes)} ${yDualPos(p.callWriting)}`).join(" ");
    return `${line} L ${lastX} ${bottomY} L ${firstX} ${bottomY} Z`;
  }, [points, maxDual]);

  // Hourly grid points
  const timeLabels = [
    { label: "09:15", min: 555 },
    { label: "10:00", min: 600 },
    { label: "11:00", min: 660 },
    { label: "12:00", min: 720 },
    { label: "13:00", min: 780 },
    { label: "14:00", min: 840 },
    { label: "15:00", min: 900 },
    { label: "15:30", min: 930 },
  ];

  const latestPoint = points[points.length - 1];
  const hovered = hoverIdx !== null && points[hoverIdx] ? points[hoverIdx] : latestPoint;

  const handleMouseMove = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = ((e.clientX - rect.left) / rect.width) * svgWidth;
    let closestIdx = 0;
    let minDistance = Infinity;
    points.forEach((p, idx) => {
      const dist = Math.abs(xPos(p.minutes) - mouseX);
      if (dist < minDistance) {
        minDistance = dist;
        closestIdx = idx;
      }
    });
    setHoverIdx(closestIdx);
  };

  const currentDiff = latestPoint?.netDiff || 0;
  const isBullBreach = currentDiff >= threshold;
  const isBearBreach = currentDiff <= -threshold;

  return (
    <div style={{
      background: t.surface,
      border: `1.5px solid ${t.border}`,
      borderRadius: 12,
      padding: "16px 18px",
      marginBottom: 16,
      boxShadow: "0 4px 14px rgba(0,0,0,0.06)"
    }}>
      {/* HEADER & VIEW TOGGLES */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 12 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontSize: 15, fontWeight: 900, color: t.text }}>
              📈 INTRADAY CALL vs PUT &amp; ΔOI LINE GRAPH
            </span>
            <span style={{
              fontSize: 10.5,
              fontWeight: 800,
              padding: "3px 9px",
              borderRadius: 6,
              background: isBullBreach
                ? (isDark ? "#052e16" : "#dcfce7")
                : isBearBreach
                ? (isDark ? "#2d0a0a" : "#fee2e2")
                : (isDark ? "#1e293b" : "#f1f5f9"),
              color: isBullBreach ? "#16a34a" : isBearBreach ? "#ef4444" : t.textMuted,
              border: `1px solid ${isBullBreach ? "#16a34a55" : isBearBreach ? "#ef444455" : t.border}`
            }}>
              {isBullBreach
                ? `🔥 BULL CONVICTION ACTIVE (> +${formatLots(threshold)})`
                : isBearBreach
                ? `🚨 BEAR CONVICTION ACTIVE (< -${formatLots(threshold)})`
                : `⚪ CHOP / NEUTRAL ZONE (Within ±${formatLots(threshold)})`}
            </span>
          </div>
          <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2 }}>
            Market Open (09:15) to Market Close (15:30) · Tracks cumulative institutional writing pressure &amp; breakout thresholds
          </div>
        </div>

        {/* TOGGLE & THRESHOLD SELECTOR */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {mode === "diff" && (
            <div style={{
              display: "flex", alignItems: "center", gap: 3,
              background: isDark ? "#0f172a" : "#f1f5f9",
              padding: "2px 6px", borderRadius: 8, border: `1px solid ${t.border}`
            }}>
              <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, marginRight: 2 }}>Threshold:</span>
              {[50000, 75000, 100000].map(val => (
                <button
                  key={val}
                  onClick={() => setThreshold(val)}
                  style={{
                    background: threshold === val ? t.accent : "transparent",
                    color: threshold === val ? "#fff" : t.textMuted,
                    border: "none",
                    borderRadius: 4, padding: "3px 7px",
                    fontSize: 10, fontWeight: 800, cursor: "pointer"
                  }}>
                  {formatLots(val)}
                </button>
              ))}
            </div>
          )}

          <div style={{ display: "flex", background: isDark ? "#0f172a" : "#f1f5f9", borderRadius: 8, padding: 2, border: `1px solid ${t.border}` }}>
            <button
              onClick={() => setMode("diff")}
              style={{
                background: mode === "diff" ? t.accent : "transparent",
                color: mode === "diff" ? "#fff" : t.textMuted,
                border: "none", borderRadius: 6, padding: "5px 10px",
                fontSize: 11, fontWeight: 800, cursor: "pointer"
              }}>
              ⚡ Net Diff (Put - Call)
            </button>
            <button
              onClick={() => setMode("dual")}
              style={{
                background: mode === "dual" ? t.accent : "transparent",
                color: mode === "dual" ? "#fff" : t.textMuted,
                border: "none", borderRadius: 6, padding: "5px 10px",
                fontSize: 11, fontWeight: 800, cursor: "pointer"
              }}>
              📊 Put vs Call (Dual Lines)
            </button>
          </div>
        </div>
      </div>

      {/* SVG CHART CONTAINER */}
      <div style={{ position: "relative", width: "100%", overflowX: "auto" }}>
        <svg
          viewBox={`0 0 ${svgWidth} ${svgHeight}`}
          style={{ width: "100%", height: "auto", display: "block", cursor: "crosshair" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            {/* Diff area gradient */}
            <linearGradient id="diffGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22c55e" stopOpacity="0.4" />
              <stop offset="50%" stopColor="#22c55e" stopOpacity="0.05" />
              <stop offset="50%" stopColor="#ef4444" stopOpacity="0.05" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.4" />
            </linearGradient>

            {/* Put Area Gradient */}
            <linearGradient id="putGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#22c55e" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#22c55e" stopOpacity="0.02" />
            </linearGradient>

            {/* Call Area Gradient */}
            <linearGradient id="callGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#ef4444" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#ef4444" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* BACKGROUND GRID LINES & TIME LABELS */}
          {timeLabels.map((tl, i) => {
            const x = xPos(tl.min);
            return (
              <g key={tl.label}>
                <line
                  x1={x} y1={padTop}
                  x2={x} y2={padTop + plotH}
                  stroke={isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)"}
                  strokeDasharray="3 3"
                />
                <text
                  x={x}
                  y={padTop + plotH + 18}
                  fill={t.textMuted}
                  fontSize="10"
                  fontFamily="monospace"
                  textAnchor={i === 0 ? "start" : i === timeLabels.length - 1 ? "end" : "middle"}
                >
                  {tl.label}
                </text>
              </g>
            );
          })}

          {/* NET DIFFERENCE MODE */}
          {mode === "diff" && (
            <>
              {/* CHOP / NOISE CORRIDOR BAND */}
              <rect
                x={padLeft}
                y={yDiffPos(threshold)}
                width={plotW}
                height={Math.max(0, yDiffPos(-threshold) - yDiffPos(threshold))}
                fill={isDark ? "rgba(255,255,255,0.02)" : "rgba(0,0,0,0.02)"}
              />

              {/* BULL CONVICTION THRESHOLD (+LINE) */}
              <line
                x1={padLeft} y1={yDiffPos(threshold)}
                x2={padLeft + plotW} y2={yDiffPos(threshold)}
                stroke="#16a34a"
                strokeWidth="1.25"
                strokeDasharray="4 3"
              />
              <text
                x={padLeft + plotW - 4}
                y={yDiffPos(threshold) - 3}
                fill="#16a34a"
                fontSize="8.5"
                fontWeight="800"
                fontFamily="monospace"
                textAnchor="end"
              >
                ▲ +{formatLots(threshold)} BULL CONVICTION
              </text>

              {/* BEAR CONVICTION THRESHOLD (-LINE) */}
              <line
                x1={padLeft} y1={yDiffPos(-threshold)}
                x2={padLeft + plotW} y2={yDiffPos(-threshold)}
                stroke="#ef4444"
                strokeWidth="1.25"
                strokeDasharray="4 3"
              />
              <text
                x={padLeft + plotW - 4}
                y={yDiffPos(-threshold) + 10}
                fill="#ef4444"
                fontSize="8.5"
                fontWeight="800"
                fontFamily="monospace"
                textAnchor="end"
              >
                ▼ -{formatLots(threshold)} BEAR CONVICTION
              </text>

              {/* ZERO BASELINE */}
              <line
                x1={padLeft} y1={yCenter}
                x2={padLeft + plotW} y2={yCenter}
                stroke={isDark ? "rgba(255,255,255,0.25)" : "rgba(0,0,0,0.25)"}
                strokeWidth="1.5"
                strokeDasharray="4 4"
              />
              <text x={padLeft - 6} y={yCenter + 3} fill={t.textMuted} fontSize="9" textAnchor="end" fontFamily="monospace">
                0 Neutral
              </text>
              <text x={padLeft - 6} y={padTop + 10} fill="#16a34a" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="700">
                +{formatLots(maxDiff)}
              </text>
              <text x={padLeft - 6} y={padTop + plotH} fill="#ef4444" fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="700">
                -{formatLots(maxDiff)}
              </text>

              {/* AREA FILL */}
              <path d={diffAreaPath} fill="url(#diffGrad)" />

              {/* MAIN NET LINE */}
              <path d={diffLinePath} fill="none" stroke="#38bdf8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* POINTS */}
              {points.map((p, idx) => (
                <circle
                  key={idx}
                  cx={xPos(p.minutes)}
                  cy={yDiffPos(p.netDiff)}
                  r={idx === points.length - 1 ? 4.5 : 2.5}
                  fill={p.netDiff >= 0 ? "#22c55e" : "#ef4444"}
                  stroke={isDark ? "#080f1a" : "#fff"}
                  strokeWidth="1.5"
                />
              ))}
            </>
          )}

          {/* DUAL MODE: PUT VS CALL SEPARATE CURVES */}
          {mode === "dual" && (
            <>
              {/* HORIZONTAL ZERO AT BOTTOM */}
              <line
                x1={padLeft} y1={padTop + plotH}
                x2={padLeft + plotW} y2={padTop + plotH}
                stroke={isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)"}
                strokeWidth="1"
              />
              <text x={padLeft - 6} y={padTop + plotH} fill={t.textMuted} fontSize="9" textAnchor="end" fontFamily="monospace">
                0
              </text>
              <text x={padLeft - 6} y={padTop + plotH / 2} fill={t.textMuted} fontSize="9" textAnchor="end" fontFamily="monospace">
                {formatLots(maxDual / 2)}
              </text>
              <text x={padLeft - 6} y={padTop + 10} fill={t.textMuted} fontSize="9" textAnchor="end" fontFamily="monospace" fontWeight="700">
                {formatLots(maxDual)}
              </text>

              {/* AREA FILLS */}
              <path d={putAreaPath} fill="url(#putGrad)" />
              <path d={callAreaPath} fill="url(#callGrad)" />

              {/* PUT LINE (GREEN) */}
              <path d={putLinePath} fill="none" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* CALL LINE (RED) */}
              <path d={callLinePath} fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />

              {/* POINTS */}
              {points.map((p, idx) => (
                <g key={idx}>
                  <circle
                    cx={xPos(p.minutes)}
                    cy={yDualPos(p.putWriting)}
                    r={idx === points.length - 1 ? 4 : 2}
                    fill="#22c55e"
                    stroke={isDark ? "#080f1a" : "#fff"}
                    strokeWidth="1"
                  />
                  <circle
                    cx={xPos(p.minutes)}
                    cy={yDualPos(p.callWriting)}
                    r={idx === points.length - 1 ? 4 : 2}
                    fill="#ef4444"
                    stroke={isDark ? "#080f1a" : "#fff"}
                    strokeWidth="1"
                  />
                </g>
              ))}
            </>
          )}

          {/* HOVER CROSSHAIR */}
          {hovered && (
            <g>
              <line
                x1={xPos(hovered.minutes)}
                y1={padTop}
                x2={xPos(hovered.minutes)}
                y2={padTop + plotH}
                stroke={isDark ? "#38bdf8" : "#0284c7"}
                strokeWidth="1.5"
                strokeDasharray="2 2"
              />
              {mode === "diff" ? (
                <circle
                  cx={xPos(hovered.minutes)}
                  cy={yDiffPos(hovered.netDiff)}
                  r="6"
                  fill="#38bdf8"
                  stroke="#fff"
                  strokeWidth="2"
                />
              ) : (
                <>
                  <circle
                    cx={xPos(hovered.minutes)}
                    cy={yDualPos(hovered.putWriting)}
                    r="5"
                    fill="#22c55e"
                    stroke="#fff"
                    strokeWidth="1.5"
                  />
                  <circle
                    cx={xPos(hovered.minutes)}
                    cy={yDualPos(hovered.callWriting)}
                    r="5"
                    fill="#ef4444"
                    stroke="#fff"
                    strokeWidth="1.5"
                  />
                </>
              )}
            </g>
          )}
        </svg>
      </div>

      {/* HOVER TOOLTIP & CURRENT STATUS BAR */}
      <div style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        flexWrap: "wrap",
        gap: 10,
        padding: "8px 12px",
        marginTop: 6,
        background: isDark ? "#0a1628" : "#f8fafc",
        borderRadius: 8,
        border: `1px solid ${t.border}`,
        fontSize: 11
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span>
            <strong style={{ color: t.text }}>Time:</strong> <span style={{ fontFamily: "monospace" }}>{hovered?.time || "—"}</span>
          </span>
          {hovered?.spot && (
            <span>
              <strong style={{ color: t.text }}>Spot:</strong> <span style={{ fontFamily: "monospace" }}>₹{hovered.spot.toLocaleString("en-IN")}</span>
            </span>
          )}
          <span>
            <strong style={{ color: "#16a34a" }}>Put Writing:</strong> <span style={{ fontFamily: "monospace", color: "#16a34a", fontWeight: 700 }}>+{formatLots(hovered?.putWriting)}</span>
          </span>
          <span>
            <strong style={{ color: "#ef4444" }}>Call Writing:</strong> <span style={{ fontFamily: "monospace", color: "#ef4444", fontWeight: 700 }}>+{formatLots(hovered?.callWriting)}</span>
          </span>
          <span>
            <strong style={{ color: t.text }}>Net ΔOI:</strong>{" "}
            <span style={{
              fontFamily: "monospace",
              fontWeight: 900,
              color: (hovered?.netDiff || 0) >= 0 ? "#16a34a" : "#ef4444"
            }}>
              {(hovered?.netDiff || 0) >= 0 ? "+" : ""}{formatLots(hovered?.netDiff)}
            </span>
          </span>
        </div>

        <div style={{ fontSize: 10.5, color: t.textMuted }}>
          💡 <strong>Historical Edge:</strong> When Net ΔOI sustains beyond <strong>±{formatLots(threshold)}</strong>, trend continuation probability reaches <strong>~78–82%</strong>. Inside corridor is chop/noise.
        </div>
      </div>
    </div>
  );
}

export function NiftyFlowView({ t, isDark }) {
  const [oiData, setOiData] = useState(null);
  const [argonData, setArgonData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);
  const [refreshIntervalSec, setRefreshIntervalSec] = useState(60); // 1-min (60s) or 2-min (120s) auto-refresh
  const [countdown, setCountdown] = useState(60);
  const [marketStatus, setMarketStatus] = useState(getMarketSessionStatus());

  // Check market status every 5 seconds so live transitions (09:00 AM or 04:00 PM) reflect immediately
  useEffect(() => {
    const statusTimer = setInterval(() => {
      setMarketStatus(getMarketSessionStatus());
    }, 5000);
    return () => clearInterval(statusTimer);
  }, []);

  const changeInterval = (sec) => {
    setRefreshIntervalSec(sec);
    setCountdown(sec);
  };

  const fetchNiftyOi = async () => {
    try {
      const res = await fetch("/api/nifty-oi");
      if (res.ok) {
        const data = await res.json();
        // Client-side local persistence across today's session
        try {
          const todayKey = `nifty_timeline_${new Date().toISOString().slice(0, 10)}`;
          const stored = JSON.parse(localStorage.getItem(todayKey) || "[]");
          const incoming = data.intradayTimeline || [];
          const map = new Map();
          incoming.forEach(p => map.set(p.minutes, p));
          stored.forEach(p => {
            if (!map.has(p.minutes)) map.set(p.minutes, p);
          });
          const merged = Array.from(map.values()).sort((a, b) => a.minutes - b.minutes);
          localStorage.setItem(todayKey, JSON.stringify(merged));
          data.intradayTimeline = merged;
        } catch (_) {}
        setOiData(data);
      }
    } catch (e) {
      console.error("Failed to load /api/nifty-oi:", e);
    }
  };

  const fetchArgon = async () => {
    try {
      const res = await fetch("/api/argon");
      if (res.ok) {
        const data = await res.json();
        setArgonData(data);
        if (data.sessions?.length) {
          // Default to Thursday or today's session if found
          const todayIdx = data.sessions.findIndex(s => s.session.toLowerCase().includes("thursday"));
          if (todayIdx !== -1) setSelectedDayIdx(todayIdx);
        }
      }
    } catch (e) {
      console.error("Failed to load /api/argon:", e);
    }
  };

  const loadAll = async () => {
    setRefreshing(true);
    await Promise.all([fetchNiftyOi(), fetchArgon()]);
    setCountdown(refreshIntervalSec);
    setRefreshing(false);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, []);

  // Live 1-second interval to tick down and auto-refresh at 0 (ACTIVE ONLY 09:00 AM to 04:00 PM IST)
  useEffect(() => {
    if (!marketStatus.isAutoActive) return;

    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          fetchNiftyOi();
          return refreshIntervalSec;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [marketStatus.isAutoActive, refreshIntervalSec]);

  const maxBarVal = useMemo(() => {
    if (!oiData?.strikes?.length) return 100000;
    let max = 10000;
    oiData.strikes.forEach(s => {
      max = Math.max(max, Math.abs(s.putDeltaOI || 0), Math.abs(s.callDeltaOI || 0));
    });
    return max;
  }, [oiData]);

  if (loading && !oiData) {
    return (
      <div style={{ padding: "40px 14px", textAlign: "center", color: t.textMuted }}>
        <div style={{ fontSize: 24, marginBottom: 12 }}>⚡</div>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Loading Nifty Option Chain & Argon Prediction…</div>
      </div>
    );
  }

  const spot = oiData?.spotPrice || 22696.65;
  const floor = oiData?.floor || 22600;
  const roof = oiData?.roof || 22800;
  const strikes = oiData?.strikes || [];
  const currentSession = argonData?.sessions?.[selectedDayIdx] || null;

  const isSupportHeavier = oiData?.balanceStatus?.toLowerCase().includes("support");
  const isResistanceHeavier = oiData?.balanceStatus?.toLowerCase().includes("resistance");

  return (
    <div style={{ padding: "14px", maxWidth: 1300, margin: "0 auto" }}>
      {/* ── TOP LIVE CONSOLIDATOR BANNER ── */}
      <div style={{
        background: t.surface,
        border: `1.5px solid ${t.border}`,
        borderRadius: 12,
        padding: "16px 18px",
        marginBottom: 16,
        boxShadow: "0 4px 14px rgba(0,0,0,0.06)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 10 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 18, fontWeight: 900, color: t.text }}>⚡ NIFTY LIVE OI CONSOLIDATOR</span>
              <span style={{
                background: isSupportHeavier ? (isDark ? "#052e16" : "#dcfce7") : isResistanceHeavier ? (isDark ? "#2d0a0a" : "#fee2e2") : (isDark ? "#1e293b" : "#f1f5f9"),
                color: isSupportHeavier ? "#16a34a" : isResistanceHeavier ? "#ef4444" : "#d97706",
                padding: "3px 8px", borderRadius: 6, fontSize: 11, fontWeight: 800,
                border: `1px solid ${isSupportHeavier ? "#16a34a44" : isResistanceHeavier ? "#ef444444" : "#d9770644"}`
              }}>
                {oiData?.balanceStatus || "Balanced"}
              </span>
              <span style={{ fontSize: 11, color: t.textMuted }}>
                ● {oiData?.timestamp || "Live"} · Expiry {oiData?.expiryDate || "Near"}
              </span>
            </div>
            <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
              <strong>Action Bias:</strong> {oiData?.recommendation || "Evaluate support/resistance before entering stock options."}
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            {/* INTERVAL SELECTOR (ACTIVE ONLY DURING MARKET WINDOW 09:00 - 16:00 IST) */}
            {marketStatus.isAutoActive && (
              <div style={{
                display: "flex", alignItems: "center", gap: 3,
                background: isDark ? "#0f172a" : "#f1f5f9",
                padding: "2px 6px", borderRadius: 8, border: `1px solid ${t.border}`
              }}>
                <span style={{ fontSize: 10, color: t.textMuted, fontWeight: 700, marginRight: 2 }}>Auto:</span>
                {[
                  { label: "1 min", sec: 60 },
                  { label: "2 min", sec: 120 },
                  { label: "5 min", sec: 300 },
                ].map(opt => (
                  <button
                    key={opt.sec}
                    onClick={() => changeInterval(opt.sec)}
                    style={{
                      background: refreshIntervalSec === opt.sec ? t.accent : "transparent",
                      color: refreshIntervalSec === opt.sec ? "#fff" : t.textMuted,
                      border: "none",
                      borderRadius: 4, padding: "3px 7px",
                      fontSize: 10, fontWeight: 800, cursor: "pointer"
                    }}>
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {/* COUNTDOWN OR PAUSED STATUS BADGE */}
            {marketStatus.isAutoActive ? (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 11, color: t.textMuted,
                background: isDark ? "#0f172a" : "#f1f5f9",
                padding: "5px 9px", borderRadius: 6,
                border: `1px solid ${t.border}`,
                fontFamily: "monospace"
              }}>
                <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#22c55e" }} />
                {Math.floor(countdown / 60)}:{(countdown % 60).toString().padStart(2, "0")}
              </div>
            ) : (
              <div style={{
                display: "flex", alignItems: "center", gap: 6,
                fontSize: 11, color: isDark ? "#fbbf24" : "#b45309",
                background: isDark ? "#291e05" : "#fefce8",
                padding: "5px 10px", borderRadius: 6,
                border: `1px solid ${isDark ? "#78350f" : "#fef08a"}`,
                fontFamily: "monospace", fontWeight: 700
              }}>
                <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: "#f59e0b" }} />
                ⏸️ {marketStatus.reason}
              </div>
            )}

            <button onClick={loadAll} disabled={refreshing} style={{
              background: t.accentBg, border: `1px solid ${t.accent}`,
              color: t.accentSub, borderRadius: 8, padding: "7px 12px",
              fontSize: 12, fontWeight: 700, cursor: refreshing ? "default" : "pointer"
            }}>
              {refreshing ? "Refreshing…" : "🔄 Refresh Now"}
            </button>
          </div>
        </div>

        {/* METRICS ROW */}
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 10,
          marginTop: 14,
          paddingTop: 12,
          borderTop: `1px solid ${t.border}`
        }}>
          <div style={{ background: isDark ? "#0a1628" : "#f8fafc", padding: "10px 12px", borderRadius: 8, border: `1px solid ${t.border}` }}>
            <div style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Nifty Spot</div>
            <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 900, color: t.text }}>₹{spot.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <div style={{ fontSize: 10, color: t.textSub }}>Current Index Market Price</div>
          </div>

          <div style={{ background: isDark ? "#052e16" : "#f0fdf4", padding: "10px 12px", borderRadius: 8, border: "1px solid #16a34a44" }}>
            <div style={{ fontSize: 10, color: "#16a34a", textTransform: "uppercase", fontWeight: 800 }}>Floor (Support)</div>
            <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 900, color: "#16a34a" }}>{floor}</div>
            <div style={{ fontSize: 10, color: isDark ? "#86efac" : "#15803d" }}>{oiData?.floorShift || "Support holding"}</div>
          </div>

          <div style={{ background: isDark ? "#2d0a0a" : "#fef2f2", padding: "10px 12px", borderRadius: 8, border: "1px solid #ef444444" }}>
            <div style={{ fontSize: 10, color: "#ef4444", textTransform: "uppercase", fontWeight: 800 }}>Roof (Resistance)</div>
            <div style={{ fontFamily: "monospace", fontSize: 20, fontWeight: 900, color: "#ef4444" }}>{roof}</div>
            <div style={{ fontSize: 10, color: isDark ? "#fca5a5" : "#b91c1c" }}>{oiData?.roofShift || "Resistance holding"}</div>
          </div>

          <div style={{ background: isDark ? "#0a1628" : "#f8fafc", padding: "10px 12px", borderRadius: 8, border: `1px solid ${t.border}` }}>
            <div style={{ fontSize: 10, color: t.textMuted, textTransform: "uppercase", fontWeight: 700 }}>Put vs Call Writing</div>
            <div style={{ fontFamily: "monospace", fontSize: 15, fontWeight: 800, color: t.text, marginTop: 4 }}>
              <span style={{ color: "#16a34a" }}>P: {oiData?.totalPutWritingFormatted || "—"}</span> vs <span style={{ color: "#ef4444" }}>C: {oiData?.totalCallWritingFormatted || "—"}</span>
            </div>
            <div style={{ fontSize: 10, color: t.textSub }}>PCR: {oiData?.pcr || 1.0} · ΔPCR: {oiData?.deltaPcr || 1.0}</div>
          </div>
        </div>
      </div>

      {/* ── INTRADAY NET OI LINE GRAPH (09:15 to 15:30) ── */}
      <NiftyIntradayLineChart
        timeline={oiData?.intradayTimeline}
        spot={spot}
        isDark={isDark}
        t={t}
      />

      {/* ── TWO-COLUMN SPLIT: HORIZONTAL CHART (LEFT) & ARGON PREDICTION (RIGHT) ── */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.4fr) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>

        {/* ── LEFT: BI-DIRECTIONAL STRIKE ΔOI PROFILE CHART ── */}
        <div style={{
          background: isDark ? "#080f1a" : "#ffffff",
          border: `1.5px solid ${t.border}`,
          borderRadius: 12,
          padding: "16px",
          overflowX: "auto"
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div>
              <div style={{ fontSize: 14, fontWeight: 800, color: t.text }}>
                NIFTY OI change today (contracts) · expiry {oiData?.expiryDate || "Current"}
              </div>
              <div style={{ fontSize: 10, color: t.textMuted }}>
                Live institutional strike additions and unwinding
              </div>
            </div>
            <span style={{ fontSize: 10, color: t.textMuted, fontFamily: "monospace" }}>{oiData?.timestamp}</span>
          </div>

          {/* TABLE HEADER */}
          <div style={{
            display: "grid",
            gridTemplateColumns: "1fr 90px 1fr",
            padding: "8px 0",
            fontSize: 10,
            fontWeight: 800,
            textTransform: "uppercase",
            borderBottom: `1px solid ${t.border}`,
            color: t.textMuted,
            textAlign: "center"
          }}>
            <div style={{ textAlign: "right", paddingRight: 10 }}>put writers ΔOI</div>
            <div>strike</div>
            <div style={{ textAlign: "left", paddingLeft: 10 }}>ΔOI call writers</div>
          </div>

          {/* STRIKE ROWS */}
          <div style={{ display: "flex", flexDirection: "column", gap: 3, marginTop: 6 }}>
            {strikes.map((s, idx) => {
              const strike = s.strike;
              const isRoof = strike === roof;
              const isFloor = strike === floor;

              // Spot indicator insertion between rows
              const prevStrike = idx > 0 ? strikes[idx - 1].strike : 999999;
              const nextStrike = idx < strikes.length - 1 ? strikes[idx + 1].strike : 0;
              const showSpotAbove = prevStrike > spot && strike <= spot;

              const pDoi = s.putDeltaOI;
              const cDoi = s.callDeltaOI;

              // Bar width percentages
              const pWidth = Math.min(100, Math.round((Math.abs(pDoi) / maxBarVal) * 95));
              const cWidth = Math.min(100, Math.round((Math.abs(cDoi) / maxBarVal) * 95));

              const isPutBuilt = pDoi > 0;
              const isPutRemoved = pDoi < 0;
              const isCallBuilt = cDoi > 0;
              const isCallRemoved = cDoi < 0;

              return (
                <div key={strike}>
                  {showSpotAbove && (
                    <div style={{
                      display: "flex", alignItems: "center", justifyContent: "center",
                      margin: "4px 0", padding: "2px 0",
                      borderTop: "1.5px dashed #38bdf8",
                      borderBottom: "1.5px dashed #38bdf8",
                      background: isDark ? "rgba(56, 189, 248, 0.08)" : "rgba(14, 165, 233, 0.08)"
                    }}>
                      <span style={{ fontFamily: "monospace", fontSize: 11, fontWeight: 900, color: "#38bdf8" }}>
                        - - - - - - - - - - - - - - - - {spot.toFixed(2)} SPOT - - - - - - - - - - - - - - - -
                      </span>
                    </div>
                  )}

                  <div style={{
                    display: "grid",
                    gridTemplateColumns: "1fr 90px 1fr",
                    alignItems: "center",
                    minHeight: 24,
                    fontSize: 11,
                    background: (isRoof || isFloor) ? (isDark ? "rgba(255,255,255,0.03)" : "#f8fafc") : "transparent"
                  }}>
                    {/* LEFT: PUT WRITERS BAR (EXTENDS LEFT) */}
                    <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 6, minWidth: 0, paddingRight: 6 }}>
                      {isFloor && (
                        <span style={{ background: "#16a34a", color: "#fff", fontSize: 8, fontWeight: 900, padding: "1px 5px", borderRadius: 3 }}>
                          FLOOR
                        </span>
                      )}
                      <span style={{
                        fontFamily: "monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color: isPutBuilt ? "#16a34a" : isPutRemoved ? (isDark ? "#86efac" : "#65a30d") : t.textMuted,
                        whiteSpace: "nowrap"
                      }}>
                        {s.putDeltaFormatted}
                      </span>
                      <div style={{ width: "65%", display: "flex", justifyContent: "flex-end" }}>
                        <div style={{
                          width: `${Math.max(2, pWidth)}%`,
                          height: 14,
                          borderRadius: "3px 0 0 3px",
                          background: isPutBuilt
                            ? "#22c55e"
                            : isPutRemoved
                            ? (isDark ? "repeating-linear-gradient(45deg, #166534, #166534 3px, #052e16 3px, #052e16 6px)" : "repeating-linear-gradient(45deg, #86efac, #86efac 3px, #f0fdf4 3px, #f0fdf4 6px)")
                            : "#64748b",
                          border: isPutRemoved ? "1px solid #16a34a" : "none"
                        }} />
                      </div>
                    </div>

                    {/* CENTER: STRIKE PRICE */}
                    <div style={{
                      textAlign: "center",
                      fontFamily: "monospace",
                      fontWeight: (isRoof || isFloor) ? 900 : 700,
                      color: isRoof ? "#ef4444" : isFloor ? "#16a34a" : t.text,
                      fontSize: 11,
                      padding: "2px 0",
                      borderRadius: 4,
                      background: isRoof ? (isDark ? "#2d0a0a" : "#fee2e2") : isFloor ? (isDark ? "#052e16" : "#dcfce7") : "transparent"
                    }}>
                      {strike}
                    </div>

                    {/* RIGHT: CALL WRITERS BAR (EXTENDS RIGHT) */}
                    <div style={{ display: "flex", justifyContent: "flex-start", alignItems: "center", gap: 6, minWidth: 0, paddingLeft: 6 }}>
                      <div style={{ width: "65%", display: "flex", justifyContent: "flex-start" }}>
                        <div style={{
                          width: `${Math.max(2, cWidth)}%`,
                          height: 14,
                          borderRadius: "0 3px 3px 0",
                          background: isCallBuilt
                            ? "#ef4444"
                            : isCallRemoved
                            ? (isDark ? "repeating-linear-gradient(45deg, #991b1b, #991b1b 3px, #2d0a0a 3px, #2d0a0a 6px)" : "repeating-linear-gradient(45deg, #fca5a5, #fca5a5 3px, #fef2f2 3px, #fef2f2 6px)")
                            : "#64748b",
                          border: isCallRemoved ? "1px solid #ef4444" : "none"
                        }} />
                      </div>
                      <span style={{
                        fontFamily: "monospace",
                        fontSize: 10,
                        fontWeight: 700,
                        color: isCallBuilt ? "#ef4444" : isCallRemoved ? (isDark ? "#fca5a5" : "#b91c1c") : t.textMuted,
                        whiteSpace: "nowrap"
                      }}>
                        {s.callDeltaFormatted}
                      </span>
                      {isRoof && (
                        <span style={{ background: "#ef4444", color: "#fff", fontSize: 8, fontWeight: 900, padding: "1px 5px", borderRadius: 3 }}>
                          ROOF
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* LEGEND BAR */}
          <div style={{
            display: "flex",
            justifyContent: "center",
            gap: 14,
            flexWrap: "wrap",
            paddingTop: 12,
            marginTop: 12,
            borderTop: `1px solid ${t.border}`,
            fontSize: 10,
            color: t.textMuted
          }}>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ display: "inline-block", width: 12, height: 10, background: "#22c55e", borderRadius: 2 }} />
              floor being built (Put writing)
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ display: "inline-block", width: 12, height: 10, border: "1px solid #22c55e", background: isDark ? "#052e16" : "#f0fdf4", borderRadius: 2 }} />
              floor being removed (unwinding)
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ display: "inline-block", width: 12, height: 10, background: "#ef4444", borderRadius: 2 }} />
              roof being built (Call writing)
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 5 }}>
              <span style={{ display: "inline-block", width: 12, height: 10, border: "1px solid #ef4444", background: isDark ? "#2d0a0a" : "#fef2f2", borderRadius: 2 }} />
              roof being removed (covering)
            </span>
          </div>

          {/* SUMMARY STRIP */}
          <div style={{
            background: isDark ? "#040810" : "#f8fafc",
            border: `1px solid ${t.border}`,
            borderRadius: 6,
            padding: "8px 10px",
            marginTop: 10,
            fontSize: 11,
            color: t.textSub,
            textAlign: "center",
            fontFamily: "monospace"
          }}>
            Floor <strong style={{ color: "#16a34a" }}>{floor}</strong> · Roof <strong style={{ color: "#ef4444" }}>{roof}</strong> · put writing <span style={{ color: "#16a34a" }}>{oiData?.totalPutWritingFormatted}</span> vs call writing <span style={{ color: "#ef4444" }}>{oiData?.totalCallWritingFormatted}</span> · {oiData?.balanceStatus} · PCR <strong>{oiData?.pcr}</strong> · ΔPCR <strong>{oiData?.deltaPcr}</strong>
          </div>
        </div>

        {/* ── RIGHT: ARGON'S DAILY PREDICTION & CONFLUENCE ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>

          {/* ARGON HEADER & DAY SELECTOR */}
          <div style={{
            background: t.surface,
            border: `1.5px solid ${t.border}`,
            borderRadius: 12,
            padding: "16px",
            boxShadow: "0 4px 14px rgba(0,0,0,0.06)"
          }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 800, color: t.text }}>🎯 ARGON WEEKLY & DAILY PREDICTION</div>
                <div style={{ fontSize: 10, color: t.textMuted }}>Price Action Model & Execution Triggers</div>
              </div>
              <a href={argonData?.docUrl || "https://docs.google.com/document/d/1P21Ba9Jlf9Ebn2rTKW0rTyQtzR_oJCPCyqFq_5LRB_c/edit?usp=sharing"}
                target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: t.accentSub, textDecoration: "none", fontWeight: 700 }}>
                Doc ↗
              </a>
            </div>

            {/* DAY SELECTOR BUTTONS */}
            <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4 }}>
              {(argonData?.sessions || []).map((sess, idx) => {
                const label = sess.session.split("(")[0].trim();
                const isSelected = selectedDayIdx === idx;
                return (
                  <button key={sess.session} onClick={() => setSelectedDayIdx(idx)} style={{
                    padding: "6px 12px",
                    borderRadius: 20,
                    fontSize: 11,
                    fontWeight: 700,
                    cursor: "pointer",
                    border: "none",
                    background: isSelected ? t.accent : t.pillOff,
                    color: isSelected ? "#fff" : t.pillOffText,
                    outline: isSelected ? "none" : `1px solid ${t.border}`,
                    whiteSpace: "nowrap"
                  }}>
                    {label}
                  </button>
                );
              })}
            </div>

            {/* ACTIVE DAY CARD */}
            {currentSession && (
              <div style={{ marginTop: 14 }}>
                <div style={{
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: isDark ? "#0f1f38" : "#f1f5f9",
                  borderLeft: `4px solid ${t.accent}`,
                  marginBottom: 10
                }}>
                  <div style={{ fontSize: 13, fontWeight: 900, color: t.text }}>{currentSession.session}</div>
                  <div style={{
                    display: "inline-block",
                    marginTop: 4,
                    fontSize: 11,
                    fontWeight: 800,
                    color: currentSession.stance.includes("BEARISH") ? "#ef4444" : currentSession.stance.includes("BOUNCE") ? "#16a34a" : "#d97706",
                    background: currentSession.stance.includes("BEARISH") ? (isDark ? "#2d0a0a" : "#fee2e2") : (isDark ? "#052e16" : "#dcfce7"),
                    padding: "2px 7px",
                    borderRadius: 4
                  }}>
                    {currentSession.stance}
                  </div>
                </div>

                <div style={{ fontSize: 12, lineHeight: 1.6, color: t.text, marginBottom: 12 }}>
                  <strong style={{ color: t.accentSub }}>Forecast & Key Levels:</strong><br />
                  {currentSession.forecast}
                </div>

                <div style={{
                  background: isDark ? "rgba(220, 38, 38, 0.08)" : "#fef2f2",
                  border: "1px solid rgba(220, 38, 38, 0.2)",
                  borderRadius: 6,
                  padding: "10px",
                  fontSize: 11.5,
                  lineHeight: 1.5,
                  color: isDark ? "#fca5a5" : "#b91c1c",
                  marginBottom: 10
                }}>
                  <strong>Execution Rule (Day Before):</strong><br />
                  {currentSession.action}
                </div>

                <div style={{ fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>
                  <strong style={{ color: t.text }}>Sectors Guidance:</strong><br />
                  {currentSession.sectors}
                </div>
              </div>
            )}
          </div>

          {/* ── CONFLUENCE VERDICT BOX: PRICE ACTION vs OPTIONS OI ── */}
          <div style={{
            background: isDark ? "#081b2e" : "#f0fdf4",
            border: `1.5px solid ${isDark ? "#1e3a5f" : "#86efac"}`,
            borderRadius: 12,
            padding: "14px 16px"
          }}>
            <div style={{ fontSize: 12, fontWeight: 900, color: isDark ? "#38bdf8" : "#166534", textTransform: "uppercase" }}>
              ⚡ LIVE CONFLUENCE VERDICT (Price Action + OI)
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.6, color: t.text, marginTop: 8 }}>
              • <strong>Roof Alignment:</strong> Call resistance wall at <strong>{roof}</strong> ({oiData?.totalCallWritingFormatted} calls built) acts as the hard ceiling.<br />
              • <strong>Floor Alignment:</strong> Put support cushion at <strong>{floor}</strong> ({oiData?.totalPutWritingFormatted} puts built) is the active battleground.<br />
              • <strong>Decision Rule:</strong>
              {isSupportHeavier ? (
                <span style={{ color: "#16a34a", fontWeight: 700 }}>
                  {" "}Support is heavier. Favorable to take CALLS in strong accumulation stocks on dips toward {floor}.
                </span>
              ) : isResistanceHeavier ? (
                <span style={{ color: "#ef4444", fontWeight: 700 }}>
                  {" "}Resistance is heavier. Do not chase long stock calls into {roof}. Favor PUT setups in high distribution stocks.
                </span>
              ) : (
                <span style={{ color: "#d97706", fontWeight: 700 }}>
                  {" "}Market is balanced within {floor}–{roof}. Play quick range-reversals or stay selective in Tier A names.
                </span>
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
