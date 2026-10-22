import { useState, useEffect, useMemo } from "react";

function formatLots(n) {
  if (n == null || isNaN(n)) return "0";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  if (abs >= 100000) return `${sign}${(abs / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}k`;
  return `${sign}${abs.toLocaleString("en-IN")}`;
}

export function NiftyFlowView({ t, isDark }) {
  const [oiData, setOiData] = useState(null);
  const [argonData, setArgonData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedDayIdx, setSelectedDayIdx] = useState(0);

  const fetchNiftyOi = async () => {
    try {
      const res = await fetch("/api/nifty-oi");
      if (res.ok) {
        const data = await res.json();
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
    setRefreshing(false);
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
    const interval = setInterval(fetchNiftyOi, 5 * 60 * 1000); // Auto-refresh OI every 5 mins
    return () => clearInterval(interval);
  }, []);

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
              <span style={{ fontSize: 18, fontWeight: 900, color: t.text }}>⚡ NIFTY 5-MIN OI CONSOLIDATOR</span>
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

          <button onClick={loadAll} disabled={refreshing} style={{
            background: t.accentBg, border: `1px solid ${t.accent}`,
            color: t.accentSub, borderRadius: 8, padding: "7px 12px",
            fontSize: 12, fontWeight: 700, cursor: refreshing ? "default" : "pointer"
          }}>
            {refreshing ? "Refreshing…" : "🔄 Refresh 5m OI"}
          </button>
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
