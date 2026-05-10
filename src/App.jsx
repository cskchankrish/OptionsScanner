import { useState, useMemo, useCallback, useEffect } from "react";
import Papa from "papaparse";

// ─── LIVE GOOGLE SHEETS LINK ──────────────────────────────────────────────────
const CSV_URL    = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQ7ytHIka0TPfS3uN4rVXKf0uGAKXLAp4q0vtHI6aPX4J0qDsz1jKHhRKs_jmlTKfkY85I-npDSihrU/pub?output=csv";
const REFRESH_MS = 15 * 60 * 1000;
const PAGE_SIZE  = 40;

// ─── THEMES ───────────────────────────────────────────────────────────────────
const THEMES = {
  dark: {
    bg:          "#060d18",
    surface:     "#0a1628",
    surface2:    "#0d1b2a",
    border:      "#1e3a5f",
    borderBright:"#2563eb44",
    text:        "#e2e8f0",
    textSub:     "#94a3b8",
    textMuted:   "#475569",
    textFaint:   "#334155",
    accent:      "#3b82f6",
    accentSub:   "#60a5fa",
    accentBg:    "#1e3a5f",
    inputBg:     "#0a1628",
    pillOff:     "#0a1628",
    pillOffText: "#64748b",
    statBg:      "#0a1628",
    liveColor:   "#22c55e",
  },
  light: {
    bg:          "#f0f4f8",
    surface:     "#ffffff",
    surface2:    "#f8fafc",
    border:      "#cbd5e1",
    borderBright:"#3b82f633",
    text:        "#0f172a",
    textSub:     "#374151",
    textMuted:   "#64748b",
    textFaint:   "#94a3b8",
    accent:      "#2563eb",
    accentSub:   "#1d4ed8",
    accentBg:    "#dbeafe",
    inputBg:     "#ffffff",
    pillOff:     "#ffffff",
    pillOffText: "#64748b",
    statBg:      "#ffffff",
    liveColor:   "#16a34a",
  },
};

// ─── SIGNAL & COMBO DEFS ──────────────────────────────────────────────────────
const SIGNAL_DEF = {
  insideDay:  { label:"Inside Day",        pts:25, color:"#f97316" },
  insideVal:  { label:"Inside Value",      pts:20, color:"#a78bfa" },
  confluence: { label:"Confluence Pivots", pts:25, color:"#22c55e" },
  tightDCR:   { label:"Daily CR ≤ 1.5",   pts:10, color:"#06b6d4" },
  tightWCR:   { label:"Weekly CR ≤ 1.5",  pts:10, color:"#06b6d4" },
  tightMCR:   { label:"Monthly CR ≤ 1.5", pts:10, color:"#06b6d4" },
};

const COMBOS = [
  { id:"jackpot",      label:"🎯 JACKPOT — All 6 Signals",     bonus:40, color:"#fbbf24", requires:["insideDay","insideVal","confluence","tightDCR","tightWCR","tightMCR"] },
  { id:"prime",        label:"⭐ Prime — ID + IV + Confluence", bonus:20, color:"#22c55e", requires:["insideDay","insideVal","confluence"] },
  { id:"id_squeeze",   label:"💥 Inside Day + All CR Tight",   bonus:15, color:"#f97316", requires:["insideDay","tightDCR","tightWCR","tightMCR"] },
  { id:"conf_squeeze", label:"🔲 Confluence + All CR Tight",   bonus:15, color:"#a78bfa", requires:["confluence","tightDCR","tightWCR","tightMCR"] },
  { id:"double_in",    label:"🔁 Inside Day + Inside Value",   bonus:8,  color:"#fb923c", requires:["insideDay","insideVal"] },
];

// ─── SCORING ──────────────────────────────────────────────────────────────────
function scoreStock(row) {
  const sigs = {
    insideDay:  row.insideDay  === true,
    insideVal:  row.insideVal  === true,
    confluence: row.confluence === true,
    tightDCR:   typeof row.dcr === "number" && row.dcr <= 1.5,
    tightWCR:   typeof row.wcr === "number" && row.wcr <= 1.5,
    tightMCR:   typeof row.mcr === "number" && row.mcr <= 1.5,
  };
  let score = 0;
  Object.entries(SIGNAL_DEF).forEach(([k,d]) => { if (sigs[k]) score += d.pts; });
  const appliedCombos = COMBOS.filter(c => c.requires.every(r => sigs[r]));
  appliedCombos.forEach(c => { score += c.bonus; });
  return { score, signals: sigs, appliedCombos };
}

function getTier(score) {
  if (score >= 115) return { label:"JACKPOT 🎯", color:"#fbbf24", bg:"#2d1f00", bgLight:"#fef9c3" };
  if (score >=  80) return { label:"A+ Setup",   color:"#16a34a", bg:"#052e16", bgLight:"#dcfce7" };
  if (score >=  55) return { label:"A Setup",    color:"#65a30d", bg:"#1a2e05", bgLight:"#f7fee7" };
  if (score >=  30) return { label:"B Setup",    color:"#d97706", bg:"#2d1b00", bgLight:"#fef3c7" };
  return                   { label:"C Setup",    color:"#64748b", bg:"#1e293b", bgLight:"#f1f5f9" };
}

// ─── CSV PARSER ───────────────────────────────────────────────────────────────
function parseData(rows) {
  const g = (r, k) => { const v = r[k]; return (v !== null && v !== undefined) ? String(v).trim() : ""; };
  const out = rows
    .filter(r => r["NSE Symbol"] && r["Weekly Pivot"] !== undefined && r["Weekly Pivot"] !== null)
    .map(r => {
      const raw = {
        sym:       g(r,"NSE Symbol").replace(/%5E/g,"").replace("NSEI","NIFTY").replace("NSEBANK","BANKNIFTY"),
        name:      g(r,"Scrip Name"),
        dcr:       typeof r["Daily Compression Ratio"]   === "number" ? r["Daily Compression Ratio"]   : null,
        wcr:       typeof r["Weekly Compression Ratio"]  === "number" ? r["Weekly Compression Ratio"]  : null,
        mcr:       typeof r["Monthly Compression Ratio"] === "number" ? r["Monthly Compression Ratio"] : null,
        buyAbove:  Number(r["Buy Above"])   || 0,
        sellBelow: Number(r["Sell Below"])  || 0,
        vol:       Number(r["Volume"])      || 0,
        insideDay: g(r,"Inside Day").toUpperCase()    === "YES",
        insideVal: g(r,"Inside Value").toUpperCase()  === "YES",
        confluence:g(r,"Confluence").includes("Confluence Detected"),
        near200:   g(r,"Near 200EMA D").toUpperCase() === "YES",
        emaDist:   r["EMA Distance%"] ? parseFloat(String(r["EMA Distance%"]).replace("%","")) : null,
        ema200:    Number(r["200 EMA"]) || null,
      };
      const { score, signals, appliedCombos } = scoreStock(raw);
      return { ...raw, score, signals, appliedCombos };
    })
    .sort((a,b) => b.score - a.score);

  if (!out.length) throw new Error("No valid rows found. Ensure the sheet is published as CSV.");
  return out;
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
const fmt = n => typeof n === "number" ? n.toLocaleString("en-IN") : "—";

function getStrikes(stock) {
  const isIdx = ["NIFTY","BANKNIFTY"].includes(stock.sym);
  const step  = isIdx ? 50 : stock.buyAbove > 5000 ? 100 : stock.buyAbove > 1000 ? 50 : stock.buyAbove > 200 ? 10 : 5;
  return {
    atmCall: Math.ceil(stock.buyAbove   / step) * step,
    otmCall: Math.ceil(stock.buyAbove   / step) * step + step,
    atmPut:  Math.floor(stock.sellBelow / step) * step,
    otmPut:  Math.floor(stock.sellBelow / step) * step - step,
  };
}

function timeAgo(ts) {
  if (!ts) return "never";
  const m = Math.floor((Date.now()-ts)/60000);
  if (m < 1)  return "just now";
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m/60)}h ${m%60}m ago`;
}

// ─── HOOKS ────────────────────────────────────────────────────────────────────
function useIsMobile() {
  const [mobile, setMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < 768);
    window.addEventListener("resize", fn);
    return () => window.removeEventListener("resize", fn);
  }, []);
  return mobile;
}

// ─── PRIMITIVES ───────────────────────────────────────────────────────────────
function ScoreBar({ score, t }) {
  const pct = Math.min((score/165)*100, 100);
  const { color } = getTier(score);
  return (
    <div style={{ height:5, background:t.border, borderRadius:3, overflow:"hidden" }}>
      <div style={{ height:"100%", width:`${pct}%`, background:color, borderRadius:3, transition:"width .4s" }} />
    </div>
  );
}

function Chip({ label, color }) {
  return (
    <span style={{ fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:4,
      whiteSpace:"nowrap", background:`${color}22`, border:`1px solid ${color}55`, color }}>
      {label}
    </span>
  );
}

function StatBox({ label, val, color, t }) {
  return (
    <div style={{ background:t.statBg, border:`1px solid ${t.border}`, borderRadius:8,
      padding:"6px 12px", textAlign:"center", flexShrink:0 }}>
      <div style={{ fontSize:9, color:t.textMuted, textTransform:"uppercase", letterSpacing:1 }}>{label}</div>
      <div style={{ fontSize:18, fontWeight:900, color, fontFamily:"monospace" }}>{val}</div>
    </div>
  );
}

// ─── THEME TOGGLE BUTTON ──────────────────────────────────────────────────────
function ThemeToggle({ isDark, onToggle, t }) {
  return (
    <button onClick={onToggle}
      style={{ background:t.accentBg, border:`1px solid ${t.border}`, color:t.textSub,
        borderRadius:8, padding:"8px 12px", cursor:"pointer", fontFamily:"inherit",
        fontSize:16, lineHeight:1, WebkitTapHighlightColor:"transparent",
        display:"flex", alignItems:"center", justifyContent:"center" }}>
      {isDark ? "☀️" : "🌙"}
    </button>
  );
}

// ─── MODAL ────────────────────────────────────────────────────────────────────
function Modal({ onClose, t, children }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, []);
  return (
    <div style={{ position:"fixed", inset:0, zIndex:300, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div onClick={onClose} style={{ position:"absolute", inset:0, background:"#000000bb" }} />
      <div style={{ position:"relative", zIndex:1, background:t.surface, border:`1px solid ${t.border}`,
        borderRadius:"16px 16px 0 0", width:"100%", maxWidth:520, maxHeight:"88vh",
        display:"flex", flexDirection:"column", overflow:"hidden",
        boxShadow:"0 -8px 40px #0006" }}>
        <div style={{ padding:"12px 0 6px", textAlign:"center", flexShrink:0 }}>
          <div style={{ width:36, height:4, background:t.border, borderRadius:2, display:"inline-block" }} />
        </div>
        <div style={{ flex:1, overflowY:"auto", WebkitOverflowScrolling:"touch", padding:"0 16px 32px" }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────
function DetailContent({ stock, onClose, t, isDark }) {
  const tier   = getTier(stock.score);
  const str    = getStrikes(stock);
  const callSL  = +(stock.buyAbove  * 0.97).toFixed(2);
  const putSL   = +(stock.sellBelow * 1.03).toFixed(2);
  const callTgt = +(stock.buyAbove  * 1.03).toFixed(2);
  const putTgt  = +(stock.sellBelow * 0.97).toFixed(2);
  const tierBg  = isDark ? tier.bg : tier.bgLight;

  const Row = ({ l, v, c }) => (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"7px 0", borderBottom:`1px solid ${t.border}` }}>
      <span style={{ fontSize:12, color:t.textMuted }}>{l}</span>
      <span style={{ fontSize:12, fontWeight:700, color:c||t.text, fontFamily:"monospace" }}>{v}</span>
    </div>
  );

  return (
    <>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:16 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
            <span style={{ fontFamily:"monospace", fontWeight:900, fontSize:22, color:t.text }}>{stock.sym}</span>
            <span style={{ fontSize:11, padding:"3px 9px", background:tierBg, color:tier.color,
              borderRadius:5, fontWeight:800, border:`1px solid ${tier.color}44` }}>{tier.label}</span>
          </div>
          <div style={{ fontSize:11, color:t.textMuted, marginTop:3 }}>{stock.name}</div>
        </div>
        <button onClick={onClose} style={{ background:t.surface2, border:`1px solid ${t.border}`,
          color:t.textSub, borderRadius:8, padding:"8px 14px", cursor:"pointer", fontSize:18,
          flexShrink:0, WebkitTapHighlightColor:"transparent" }}>✕</button>
      </div>

      <div style={{ background:t.surface2, borderRadius:12, padding:16, marginBottom:14, textAlign:"center" }}>
        <div style={{ fontSize:52, fontWeight:900, color:tier.color, fontFamily:"monospace", lineHeight:1 }}>{stock.score}</div>
        <div style={{ fontSize:10, color:t.textMuted, marginTop:4, textTransform:"uppercase", letterSpacing:1 }}>Setup Score — max 165</div>
        <div style={{ marginTop:10 }}><ScoreBar score={stock.score} t={t} /></div>
      </div>

      {stock.appliedCombos?.length > 0 && (
        <div style={{ marginBottom:14 }}>
          <div style={{ fontSize:10, color:t.textMuted, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8, fontWeight:700 }}>🎁 Combo Bonuses</div>
          {stock.appliedCombos.map(c => (
            <div key={c.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
              background:`${c.color}18`, border:`1px solid ${c.color}44`, borderRadius:7,
              padding:"8px 12px", marginBottom:4 }}>
              <span style={{ fontSize:12, color:c.color, fontWeight:700 }}>{c.label}</span>
              <span style={{ fontSize:12, fontFamily:"monospace", color:c.color, fontWeight:900 }}>+{c.bonus}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:10, color:t.textMuted, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8, fontWeight:700 }}>📡 Signal Breakdown</div>
        {Object.entries(SIGNAL_DEF).map(([key,def]) => (
          <div key={key} style={{ display:"flex", justifyContent:"space-between", padding:"7px 10px", marginBottom:3,
            borderRadius:6, background:stock.signals[key]?`${def.color}18`:"transparent",
            border:`1px solid ${stock.signals[key]?def.color+"44":t.border+"00"}` }}>
            <span style={{ fontSize:12, color:stock.signals[key]?def.color:t.textFaint,
              fontWeight:stock.signals[key]?700:400 }}>
              {stock.signals[key]?"✓":"✗"} {def.label}
            </span>
            <span style={{ fontSize:12, fontFamily:"monospace", color:stock.signals[key]?def.color:t.textFaint }}>
              {stock.signals[key]?`+${def.pts}`:"—"}
            </span>
          </div>
        ))}
      </div>

      <div style={{ marginBottom:14 }}>
        <div style={{ fontSize:10, color:t.textMuted, textTransform:"uppercase", letterSpacing:1.5, marginBottom:8, fontWeight:700 }}>🔄 Compression Ratios</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:8 }}>
          {[["Daily",stock.dcr],["Weekly",stock.wcr],["Monthly",stock.mcr]].map(([tf,cr]) => {
            const tight = cr!=null && cr<=1.5;
            return (
              <div key={tf} style={{ background: tight?(isDark?"#052e16":"#dcfce7"):t.surface2,
                border:`1px solid ${tight?(isDark?"#166534":"#86efac"):t.border}`,
                borderRadius:8, padding:"10px 8px", textAlign:"center" }}>
                <div style={{ fontSize:9, color:t.textMuted, textTransform:"uppercase", letterSpacing:1 }}>{tf}</div>
                <div style={{ fontSize:22, fontWeight:900, fontFamily:"monospace", marginTop:4,
                  color:cr==null?t.textMuted:cr<=1.5?"#16a34a":cr>=2.5?"#ef4444":"#d97706" }}>
                  {cr!=null?cr.toFixed(2):"—"}
                </div>
                {cr!=null && <div style={{ fontSize:9, marginTop:3, color:cr<=1.5?"#16a34a":t.textMuted }}>{cr<=1.5?"✓ Tight":"Wide"}</div>}
              </div>
            );
          })}
        </div>
      </div>

      {(stock.near200||stock.emaDist!=null) && (
        <div style={{ marginBottom:14, background:t.surface2, border:`1px solid ${t.border}`, borderRadius:8, padding:12 }}>
          <div style={{ fontSize:10, color:t.accent, fontWeight:700, marginBottom:8 }}>📐 200 EMA — Reference Only (not scored)</div>
          <Row l="200 EMA Level" v={stock.ema200?`₹${fmt(stock.ema200)}`:"—"} />
          <Row l="EMA Distance"  v={stock.emaDist!=null?`${stock.emaDist}%`:"—"}
            c={stock.emaDist!=null?(stock.emaDist<3?"#16a34a":stock.emaDist>15?"#ef4444":"#d97706"):undefined} />
          <Row l="Near 200 EMA" v={stock.near200?"Yes ✓":"No"} c={stock.near200?"#16a34a":t.textMuted} />
        </div>
      )}

      <div style={{ background:isDark?"#052e16":"#f0fdf4", border:isDark?"1px solid #166534":"1px solid #86efac",
        borderRadius:10, padding:14, marginBottom:10 }}>
        <div style={{ fontWeight:800, fontSize:13, color:"#16a34a", marginBottom:10 }}>📈 BULLISH CALL SETUP · T+1–T+3</div>
        <Row l="Entry Trigger"   v={`₹${fmt(stock.buyAbove)}`}  c="#16a34a" />
        <Row l="ATM Call Strike" v={`₹${fmt(str.atmCall)}`}     c="#15803d" />
        <Row l="1-OTM Strike"   v={`₹${fmt(str.otmCall)}`} />
        <Row l="Underlying SL"  v={`₹${fmt(callSL)} (−3%)`}    c="#ef4444" />
        <Row l="Target"         v={`₹${fmt(callTgt)} (+3%)`}   c="#16a34a" />
        <div style={{ marginTop:10, background:isDark?"#0d2818":"#dcfce7", borderRadius:6,
          padding:"8px 10px", fontSize:11, color:isDark?"#86efac":"#15803d", lineHeight:1.7 }}>
          <strong>Options SL:</strong> Exit if premium ↓ 35–40% · <strong>Target:</strong> 70–100% gain
        </div>
      </div>

      <div style={{ background:isDark?"#2d0a0a":"#fef2f2", border:isDark?"1px solid #7f1d1d":"1px solid #fca5a5",
        borderRadius:10, padding:14 }}>
        <div style={{ fontWeight:800, fontSize:13, color:"#ef4444", marginBottom:10 }}>📉 BEARISH PUT SETUP · T+1–T+3</div>
        <Row l="Entry Trigger"  v={`₹${fmt(stock.sellBelow)}`} c="#ef4444" />
        <Row l="ATM Put Strike" v={`₹${fmt(str.atmPut)}`}      c="#dc2626" />
        <Row l="1-OTM Strike"  v={`₹${fmt(str.otmPut)}`} />
        <Row l="Underlying SL" v={`₹${fmt(putSL)} (+3%)`}      c="#ef4444" />
        <Row l="Target"        v={`₹${fmt(putTgt)} (−3%)`}     c="#ef4444" />
        <div style={{ marginTop:10, background:isDark?"#2d0808":"#fee2e2", borderRadius:6,
          padding:"8px 10px", fontSize:11, color:isDark?"#fca5a5":"#dc2626", lineHeight:1.7 }}>
          <strong>Options SL:</strong> Exit if premium ↓ 35–40% · <strong>Target:</strong> 70–100% gain
        </div>
      </div>
    </>
  );
}

// ─── STOCK CARD ───────────────────────────────────────────────────────────────
function StockCard({ stock, onClick, t, isDark }) {
  const tier     = getTier(stock.score);
  const str      = getStrikes(stock);
  const topCombo = stock.appliedCombos?.[0];
  const tierBg   = isDark ? tier.bg : tier.bgLight;

  return (
    <div onClick={onClick} style={{ background:t.surface, border:`1.5px solid ${t.border}`,
      borderRadius:12, padding:"14px 16px", cursor:"pointer", position:"relative",
      overflow:"hidden", WebkitTapHighlightColor:"transparent" }}>
      <div style={{ position:"absolute", top:0, left:0, bottom:0, width:3,
        background:tier.color, borderRadius:"12px 0 0 12px" }} />

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom:6 }}>
        <div>
          <div style={{ display:"flex", alignItems:"center", gap:6, flexWrap:"wrap" }}>
            <span style={{ fontFamily:"monospace", fontWeight:900, fontSize:15, color:t.text }}>{stock.sym}</span>
            <span style={{ fontSize:10, padding:"2px 7px", background:tierBg, color:tier.color,
              borderRadius:4, fontWeight:800, border:`1px solid ${tier.color}44` }}>{tier.label}</span>
          </div>
          <div style={{ fontSize:10, color:t.textMuted, marginTop:2 }}>{stock.name}</div>
        </div>
        <div style={{ textAlign:"right", flexShrink:0 }}>
          <div style={{ fontFamily:"monospace", fontSize:22, fontWeight:900, color:tier.color, lineHeight:1 }}>{stock.score}</div>
          <div style={{ fontSize:9, color:t.textMuted }}>/ 165</div>
        </div>
      </div>

      <ScoreBar score={stock.score} t={t} />

      {topCombo && (
        <div style={{ marginTop:8, fontSize:10, fontWeight:700, color:topCombo.color,
          background:`${topCombo.color}18`, border:`1px solid ${topCombo.color}44`,
          borderRadius:5, padding:"3px 10px", display:"inline-block" }}>
          {topCombo.label} <span style={{ opacity:.7 }}>+{topCombo.bonus}pts</span>
        </div>
      )}

      <div style={{ display:"flex", gap:4, marginTop:8, flexWrap:"wrap" }}>
        {stock.signals.insideDay  && <Chip label="Inside Day"   color="#f97316" />}
        {stock.signals.insideVal  && <Chip label="Inside Value" color="#a78bfa" />}
        {stock.signals.confluence && <Chip label="Confluence"   color="#22c55e" />}
        {stock.signals.tightDCR   && <Chip label={`D ${stock.dcr?.toFixed(2)}`} color="#06b6d4" />}
        {stock.signals.tightWCR   && <Chip label={`W ${stock.wcr?.toFixed(2)}`} color="#06b6d4" />}
        {stock.signals.tightMCR   && <Chip label={`M ${stock.mcr?.toFixed(2)}`} color="#06b6d4" />}
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:6, marginTop:10 }}>
        <div style={{ background:isDark?"#052e16":"#f0fdf4", borderRadius:6, padding:"7px 10px",
          border:isDark?"none":`1px solid #86efac` }}>
          <div style={{ fontSize:9, color:"#16a34a", fontWeight:700, textTransform:"uppercase" }}>Buy Above</div>
          <div style={{ fontFamily:"monospace", fontSize:14, fontWeight:800, color:t.text }}>₹{fmt(stock.buyAbove)}</div>
          <div style={{ fontSize:9, color:t.textMuted }}>ATM Call ₹{fmt(str.atmCall)}</div>
        </div>
        <div style={{ background:isDark?"#2d0a0a":"#fef2f2", borderRadius:6, padding:"7px 10px",
          border:isDark?"none":`1px solid #fca5a5` }}>
          <div style={{ fontSize:9, color:"#ef4444", fontWeight:700, textTransform:"uppercase" }}>Sell Below</div>
          <div style={{ fontFamily:"monospace", fontSize:14, fontWeight:800, color:t.text }}>₹{fmt(stock.sellBelow)}</div>
          <div style={{ fontSize:9, color:t.textMuted }}>ATM Put ₹{fmt(str.atmPut)}</div>
        </div>
      </div>

      <div style={{ display:"flex", gap:12, marginTop:8, fontSize:10, color:t.textMuted, flexWrap:"wrap" }}>
        <span>Vol: <span style={{ color:t.textSub }}>
          {stock.vol>=1e7?`${(stock.vol/1e7).toFixed(1)}Cr`:`${(stock.vol/1e5).toFixed(1)}L`}
        </span></span>
        {stock.near200 && <span style={{ color:"#16a34a" }}>📍 Near 200 EMA</span>}
        {stock.emaDist!=null && (
          <span>EMA: <span style={{ color:stock.emaDist<3?"#16a34a":stock.emaDist>15?"#ef4444":"#d97706" }}>{stock.emaDist}%</span></span>
        )}
      </div>
    </div>
  );
}

// ─── STOCK LIST VIEW ──────────────────────────────────────────────────────────
const SIG_FILTERS = ["All","Inside Day","Inside Value","Confluence","Tight CR"];

function StockListView({ stocks, t, isDark }) {
  const [search,    setSearch]    = useState("");
  const [sigFilter, setSigFilter] = useState("All");
  const [minScore,  setMinScore]  = useState(0);
  const [selected,  setSelected]  = useState(null);
  const [page,      setPage]      = useState(1);

  useEffect(() => { setPage(1); }, [search, sigFilter, minScore]);

  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    return stocks.filter(s => {
      if (q && !s.sym.toLowerCase().includes(q) && !s.name.toLowerCase().includes(q)) return false;
      if (sigFilter==="Inside Day"  && !s.signals?.insideDay)  return false;
      if (sigFilter==="Inside Value"&& !s.signals?.insideVal)  return false;
      if (sigFilter==="Confluence"  && !s.signals?.confluence) return false;
      if (sigFilter==="Tight CR"    && !(s.signals?.tightDCR||s.signals?.tightWCR||s.signals?.tightMCR)) return false;
      return s.score >= minScore;
    });
  }, [stocks, search, sigFilter, minScore]);

  const visible = filtered.slice(0, page * PAGE_SIZE);
  const hasMore = visible.length < filtered.length;

  return (
    <div style={{ padding:"12px 14px" }}>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="🔍 Search symbol or name…"
        style={{ width:"100%", boxSizing:"border-box", background:t.inputBg,
          border:`1px solid ${t.border}`, borderRadius:8, padding:"11px 14px",
          color:t.text, fontFamily:"inherit", fontSize:14, outline:"none", marginBottom:10 }} />

      <div style={{ display:"flex", gap:6, overflowX:"auto", WebkitOverflowScrolling:"touch",
        paddingBottom:6, marginBottom:10 }}>
        {SIG_FILTERS.map(f => (
          <button key={f} onClick={()=>setSigFilter(f)}
            style={{ padding:"8px 15px", borderRadius:20, fontSize:12, fontWeight:700,
              cursor:"pointer", fontFamily:"inherit", flexShrink:0, border:"none",
              background: sigFilter===f ? t.accent    : t.pillOff,
              color:      sigFilter===f ? "#ffffff"   : t.pillOffText,
              outline:    sigFilter===f ? "none"      : `1px solid ${t.border}`,
              WebkitTapHighlightColor:"transparent" }}>
            {f}
          </button>
        ))}
      </div>

      <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:14 }}>
        <span style={{ fontSize:11, color:t.textMuted, whiteSpace:"nowrap" }}>Min score:</span>
        <input type="range" min={0} max={100} step={5} value={minScore}
          onChange={e=>setMinScore(+e.target.value)} style={{ flex:1, accentColor:t.accent }} />
        <span style={{ fontSize:12, color:t.accent, fontFamily:"monospace", fontWeight:700, minWidth:26 }}>{minScore}</span>
        <span style={{ fontSize:11, color:t.textMuted, whiteSpace:"nowrap" }}>· {filtered.length} stocks</span>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:10 }}>
        {visible.map(s => <StockCard key={s.sym} stock={s} onClick={()=>setSelected(s)} t={t} isDark={isDark} />)}
        {!filtered.length && (
          <div style={{ textAlign:"center", padding:60, color:t.textMuted, gridColumn:"1/-1" }}>
            No stocks match your filters.
          </div>
        )}
      </div>

      {hasMore && (
        <div style={{ textAlign:"center", marginTop:16 }}>
          <button onClick={()=>setPage(p=>p+1)}
            style={{ background:t.surface, border:`1px solid ${t.border}`, color:t.accent,
              borderRadius:8, padding:"11px 28px", cursor:"pointer", fontFamily:"inherit",
              fontSize:13, fontWeight:700, WebkitTapHighlightColor:"transparent" }}>
            Load more ({filtered.length-visible.length} remaining)
          </button>
        </div>
      )}

      {selected && (
        <Modal onClose={()=>setSelected(null)} t={t}>
          <DetailContent stock={selected} onClose={()=>setSelected(null)} t={t} isDark={isDark} />
        </Modal>
      )}
    </div>
  );
}

// ─── SCORING GUIDE ────────────────────────────────────────────────────────────
function ScoringGuide({ t }) {
  return (
    <div style={{ padding:"16px 14px", maxWidth:680, margin:"0 auto", display:"flex", flexDirection:"column", gap:12 }}>
      <div style={{ background:t.surface, border:`1px solid ${t.border}`, borderRadius:12, padding:18 }}>
        <div style={{ fontWeight:800, fontSize:14, color:t.text, marginBottom:4 }}>📐 Base Signals — Max 100 pts</div>
        <div style={{ fontSize:11, color:t.textMuted, marginBottom:12 }}>200 EMA is reference only — not scored.</div>
        {Object.entries(SIGNAL_DEF).map(([k,d]) => (
          <div key={k} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"10px 12px", marginBottom:5, background:`${d.color}12`, border:`1px solid ${d.color}33`, borderRadius:7 }}>
            <div>
              <span style={{ fontSize:13, fontWeight:700, color:d.color }}>{d.label}</span>
              <div style={{ fontSize:11, color:t.textMuted, marginTop:2 }}>
                {k==="insideDay"  && "Yesterday's range fully inside prior candle — coiling signal"}
                {k==="insideVal"  && "Price compressed within Value Area — institutional squeeze"}
                {k==="confluence" && "Daily/Weekly/Monthly pivots converging — magnetic zone"}
                {k==="tightDCR"   && "Daily CR ≤ 1.5 — daily range tightening"}
                {k==="tightWCR"   && "Weekly CR ≤ 1.5 — weekly squeeze building"}
                {k==="tightMCR"   && "Monthly CR ≤ 1.5 — multi-week compression"}
              </div>
            </div>
            <span style={{ fontFamily:"monospace", fontWeight:900, fontSize:16, color:d.color, flexShrink:0 }}>+{d.pts}</span>
          </div>
        ))}
      </div>

      <div style={{ background:t.surface, border:`1px solid #fbbf2444`, borderRadius:12, padding:18 }}>
        <div style={{ fontWeight:800, fontSize:14, color:"#d97706", marginBottom:12 }}>🎁 Combo Bonuses</div>
        {COMBOS.map(c => (
          <div key={c.id} style={{ display:"flex", justifyContent:"space-between", alignItems:"center",
            padding:"10px 12px", marginBottom:5, background:`${c.color}12`, border:`1px solid ${c.color}33`, borderRadius:7 }}>
            <div>
              <span style={{ fontSize:13, fontWeight:700, color:c.color }}>{c.label}</span>
              <div style={{ fontSize:11, color:t.textMuted, marginTop:2 }}>
                Needs: {c.requires.map(r=>SIGNAL_DEF[r]?.label).join(" + ")}
              </div>
            </div>
            <span style={{ fontFamily:"monospace", fontWeight:900, fontSize:16, color:c.color, flexShrink:0 }}>+{c.bonus}</span>
          </div>
        ))}
      </div>

      <div style={{ background:t.surface, border:`1px solid ${t.border}`, borderRadius:12, padding:18 }}>
        <div style={{ fontWeight:800, fontSize:14, color:t.text, marginBottom:12 }}>🏆 Tier Reference</div>
        {[
          ["JACKPOT 🎯","≥ 115","#d97706","All signals firing. Rare. Highest priority."],
          ["A+ Setup",  "≥ 80", "#16a34a","Multiple signals + combo. High conviction."],
          ["A Setup",   "≥ 55", "#65a30d","2–3 signals with partial combo. Good candidate."],
          ["B Setup",   "≥ 30", "#d97706","1–2 signals. Watchlist — wait for confluence."],
          ["C Setup",   "< 30", "#64748b","Minimal signals. No edge — skip."],
        ].map(([tier,range,color,desc]) => (
          <div key={tier} style={{ display:"flex", gap:10, padding:"8px 12px", marginBottom:5,
            background:`${color}10`, border:`1px solid ${color}33`, borderRadius:7, alignItems:"center" }}>
            <span style={{ fontSize:12, fontWeight:800, color, minWidth:110, flexShrink:0 }}>{tier}</span>
            <span style={{ fontSize:12, fontFamily:"monospace", color, minWidth:40, flexShrink:0 }}>{range}</span>
            <span style={{ fontSize:11, color:t.textMuted }}>{desc}</span>
          </div>
        ))}
      </div>

      <div style={{ background:t.surface2, border:`1px solid ${t.border}`, borderRadius:10,
        padding:14, fontSize:11, color:t.textMuted, lineHeight:1.8 }}>
        ⚠️ <strong style={{ color:t.textSub }}>Disclaimer:</strong> Decision-support tool only.
        Not buy/sell advice. Options trading carries substantial risk.
        Always validate with your own analysis before entry.
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const mobile       = useIsMobile();
  const [isDark,     setIsDark]     = useState(true);
  const [stocks,     setStocks]     = useState(null);
  const [lastUpdated,setLastUpdated]= useState(null);
  const [error,      setError]      = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab,  setActiveTab]  = useState("setups");

  const t = THEMES[isDark ? "dark" : "light"];

  const fetchLive = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await fetch(`${CSV_URL}&t=${Date.now()}`);
      if (!res.ok) throw new Error(`Network error ${res.status}`);
      const text = await res.text();
      Papa.parse(text, {
        header: true, dynamicTyping: true, skipEmptyLines: true,
        complete: results => {
          try { setStocks(parseData(results.data)); setLastUpdated(Date.now()); }
          catch(e) { setError(e.message); }
          setRefreshing(false);
        },
        error: e => { setError(`Parse error: ${e.message}`); setRefreshing(false); }
      });
    } catch(e) {
      setError(e.message);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchLive();
    const id = setInterval(fetchLive, REFRESH_MS);
    return () => clearInterval(id);
  }, [fetchLive]);

  // ── Conditional renders AFTER all hooks ──────────────────────────────────
  if (error) {
    return (
      <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"center", background:t.bg, padding:24, textAlign:"center", gap:16 }}>
        <div style={{ fontSize:40 }}>⚠️</div>
        <div style={{ fontWeight:800, fontSize:16, color:t.text }}>Failed to load live data</div>
        <div style={{ fontSize:12, color:"#ef4444", maxWidth:340, lineHeight:1.7 }}>{error}</div>
        <button onClick={fetchLive}
          style={{ marginTop:8, padding:"12px 28px", background:t.accent, color:"#fff",
            border:"none", borderRadius:8, cursor:"pointer", fontSize:14, fontWeight:800, fontFamily:"inherit" }}>
          ↻ Try Again
        </button>
      </div>
    );
  }

  if (stocks === null) {
    return (
      <div style={{ minHeight:"100vh", display:"flex", flexDirection:"column", alignItems:"center",
        justifyContent:"center", background:t.bg, gap:16 }}>
        <div style={{ width:40, height:40, border:`3px solid ${t.border}`, borderTopColor:t.accent,
          borderRadius:"50%", animation:"spin .8s linear infinite" }} />
        <div style={{ fontSize:13, color:t.textMuted }}>Fetching live data from Google Sheets…</div>
        <style>{`@keyframes spin { to { transform:rotate(360deg); } }`}</style>
      </div>
    );
  }

  const jackpots  = stocks.filter(s => s.score >= 115).length;
  const aPlus     = stocks.filter(s => s.score >= 80 && s.score < 115).length;
  const aSetups   = stocks.filter(s => s.score >= 55 && s.score < 80).length;
  const idCount   = stocks.filter(s => s.signals?.insideDay).length;
  const confCount = stocks.filter(s => s.signals?.confluence).length;
  const topPicks  = stocks.filter(s => s.score >= 80);

  const TABS = [
    { id:"setups", label:`🎯 All (${stocks.length})` },
    { id:"top",    label:`⭐ Top (${topPicks.length})` },
    { id:"guide",  label:"📐 Scoring" },
  ];

  return (
    <div style={{ minHeight:"100vh", background:t.bg, color:t.text,
      fontFamily:"system-ui,sans-serif", fontSize:13,
      transition:"background .25s, color .25s" }}>

      {/* HEADER */}
      <div style={{ background:t.surface, borderBottom:`1px solid ${t.border}`, padding:"12px 14px" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <div>
            <div style={{ fontSize:mobile?18:22, fontWeight:900, color:t.text }}>
              ⚡ <span style={{ color:t.accent }}>OPTIONS</span>SCANNER
            </div>
            <div style={{ fontSize:10, color:t.textMuted, marginTop:3, display:"flex", gap:6, alignItems:"center", flexWrap:"wrap" }}>
              <span style={{ color:t.liveColor }}>● LIVE</span>
              <span>· {stocks.length} stocks</span>
              {lastUpdated && <span>· {timeAgo(lastUpdated)}</span>}
              {refreshing  && <span style={{ color:t.accentSub }}>· Refreshing…</span>}
            </div>
          </div>
          {/* Action buttons */}
          <div style={{ display:"flex", gap:8, alignItems:"center" }}>
            <ThemeToggle isDark={isDark} onToggle={()=>setIsDark(d=>!d)} t={t} />
            <button onClick={fetchLive} disabled={refreshing}
              style={{ background:t.accentBg, border:`1px solid ${t.accent}`, color:refreshing?t.textFaint:t.accentSub,
                borderRadius:8, padding:"9px 14px", cursor:refreshing?"default":"pointer",
                fontFamily:"inherit", fontSize:13, fontWeight:800,
                WebkitTapHighlightColor:"transparent" }}>
              {refreshing ? "⏳" : "🔄"}
            </button>
          </div>
        </div>

        <div style={{ display:"flex", gap:6, overflowX:"auto", WebkitOverflowScrolling:"touch", paddingBottom:2 }}>
          <StatBox label="Jackpot"    val={jackpots}  color="#d97706" t={t} />
          <StatBox label="A+ Setup"   val={aPlus}     color="#16a34a" t={t} />
          <StatBox label="A Setup"    val={aSetups}   color="#65a30d" t={t} />
          <StatBox label="Inside Day" val={idCount}   color="#f97316" t={t} />
          <StatBox label="Confluence" val={confCount} color="#0891b2" t={t} />
        </div>
      </div>

      {/* TABS */}
      <div style={{ background:t.surface, borderBottom:`1px solid ${t.border}`, display:"flex",
        overflowX:"auto", WebkitOverflowScrolling:"touch", paddingLeft:8 }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={()=>setActiveTab(tab.id)}
            style={{ background:"none", border:"none", cursor:"pointer", padding:"13px 16px",
              fontFamily:"inherit", fontSize:13, fontWeight:700,
              color:     activeTab===tab.id ? t.text    : t.textMuted,
              borderBottom: activeTab===tab.id ? `2px solid ${t.accent}` : "2px solid transparent",
              whiteSpace:"nowrap", flexShrink:0, WebkitTapHighlightColor:"transparent" }}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* CONTENT */}
      {activeTab==="setups" && <StockListView stocks={stocks} t={t} isDark={isDark} />}
      {activeTab==="top"    && <StockListView stocks={topPicks} t={t} isDark={isDark} />}
      {activeTab==="guide"  && <ScoringGuide t={t} />}
    </div>
  );
}
