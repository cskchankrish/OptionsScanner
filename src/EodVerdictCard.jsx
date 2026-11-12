/**
 * EOD verdict card (Part 3): the final verdict and results, precise and easy on the eye.
 * Driven by eodDecision.card (src/eodCard.js). The long audit stays below it, collapsed.
 */
import React from "react";

export function EodVerdictCard({ card, t, isDark, isMobile }) {
  if (!card) return null;
  const rowColor = (r) => (r.unverified ? (isDark ? "#fbbf24" : "#b45309") : r.contribution > 0 ? "#16a34a" : r.contribution < 0 ? "#ef4444" : t.textSub);
  return (
    <div data-testid="eod-verdict-card" style={{
      border: `2px solid ${card.color}66`, borderRadius: 12, padding: isMobile ? "12px 14px" : "16px 20px", marginBottom: 12,
      background: isDark ? "#0b1220" : "#ffffff",
    }}>
      <div style={{ fontSize: isMobile ? 26 : 34, fontWeight: 900, color: card.color, letterSpacing: 0.5, lineHeight: 1.1 }}>
        {card.headline}
      </div>
      <div style={{ fontSize: isMobile ? 12.5 : 14, fontWeight: 700, color: t.text, marginTop: 6 }}>
        {card.scoreLine}
        {card.agreementLine && <span style={{ color: t.textSub, fontWeight: 600 }}> · {card.agreementLine}</span>}
      </div>

      <div style={{ marginTop: 10, display: "grid", gap: 6 }}>
        {card.rows.map((r) => (
          <div key={r.group} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 44px" : "190px 52px 1fr", alignItems: "baseline", gap: 8, fontSize: isMobile ? 12 : 13 }}>
            <span style={{ fontWeight: 800, color: t.textSub }}>{r.group} · {r.label}</span>
            <span style={{ fontFamily: "monospace", fontWeight: 900, color: rowColor(r), textAlign: "right" }}>{r.contributionText}</span>
            <span style={{ color: t.text, gridColumn: isMobile ? "1 / -1" : "auto" }}>
              {r.reason}
              {r.unverified && <span style={{ marginLeft: 6, fontSize: 10.5, fontWeight: 900, padding: "1px 6px", borderRadius: 4, background: "#f59e0b22", color: "#d97706", border: "1px solid #f59e0b55" }}>UNVERIFIED</span>}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${t.border}`, fontSize: isMobile ? 12 : 13, color: t.text, display: "flex", flexWrap: "wrap", gap: "4px 16px" }}>
        <span><strong>Stop:</strong> {card.stop != null ? card.stop : "—"}</span>
        {card.contract && <span><strong>Contract:</strong> {card.contract}</span>}
        <span><strong>Carry automation:</strong> {card.automation?.text || "status unavailable"}</span>
      </div>
      {card.dataLine && (
        <div style={{ marginTop: 4, fontSize: isMobile ? 11 : 12, color: t.textMuted }}><strong>Data:</strong> {card.dataLine}</div>
      )}
      {card.caveat && (
        <div style={{ marginTop: 6, fontSize: isMobile ? 11 : 12, fontWeight: 700, color: isDark ? "#fbbf24" : "#b45309" }}>{card.caveat}</div>
      )}
      {card.turnTracker && (
        <div style={{ marginTop: 6, fontSize: isMobile ? 10.5 : 11.5, color: t.textMuted }}><strong>Turn Tracker (detail, not scored):</strong> {card.turnTracker}</div>
      )}
    </div>
  );
}
