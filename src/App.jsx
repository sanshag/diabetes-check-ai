import { useState, useCallback, useRef, useEffect } from "react";
import {
  Upload, ClipboardList, BarChart2, MessageSquare, User, Activity,
  Heart, Droplets, Dna, FileText, Send, Bell, TrendingUp, AlertCircle,
  Shield, Microscope, Stethoscope, ArrowRight, CheckCircle, Info,
  AlertTriangle, Pill, ChevronRight, Search
} from "lucide-react";

// ─── Clinical Logic ───────────────────────────────────────────────────────────
function classifyGlycemic({ fpg, hba1c, ogtt }) {
  const results = [];
  const add = (marker, v, d, p) => results.push({ marker, category: v >= d ? "diabetes" : v >= p ? "prediabetes" : "normal", value: v });
  if (fpg !== "" && fpg != null) { const v = parseFloat(fpg); if (!isNaN(v)) add("FPG", v, 126, 100); }
  if (hba1c !== "" && hba1c != null) { const v = parseFloat(hba1c); if (!isNaN(v)) add("HbA1c", v, 6.5, 5.7); }
  if (ogtt !== "" && ogtt != null) { const v = parseFloat(ogtt); if (!isNaN(v)) add("OGTT", v, 200, 140); }
  if (!results.length) return null;
  const hasDiabetes = results.filter(r => r.category === "diabetes");
  const hasPrediabetes = results.filter(r => r.category === "prediabetes");
  const status = hasDiabetes.length ? "diabetes" : hasPrediabetes.length ? "prediabetes" : "normal";
  const discordant = [...new Set(results.map(r => r.category))].length > 1 && hasDiabetes.length > 0 && hasDiabetes.length < results.length;
  return { status, results, discordant };
}
function calcFIB4(age, ast, plt, alt) {
  if (!age || !ast || !plt || !alt) return null;
  const v = (parseFloat(age) * parseFloat(ast)) / (parseFloat(plt) * Math.sqrt(parseFloat(alt)));
  return isNaN(v) ? null : v.toFixed(3);
}
function calcGMI(avg) { if (!avg) return null; const v = (3.31 + 0.02392 * parseFloat(avg)).toFixed(2); return isNaN(parseFloat(v)) ? null : v; }
function stageCKD(egfr, uacr) {
  const e = parseFloat(egfr), u = parseFloat(uacr);
  if (isNaN(e)) return null;
  const stage = e >= 90 ? "G1" : e >= 60 ? "G2" : e >= 45 ? "G3a" : e >= 30 ? "G3b" : e >= 15 ? "G4" : "G5";
  const albuminuria = !isNaN(u) ? (u < 30 ? "A1 — Normal" : u < 300 ? "A2 — Moderate" : "A3 — Severe") : "—";
  return { stage, albuminuria, sglt2Indicated: e >= 20 && e <= 60 };
}
function generateTreatment({ glycemicStatus, ckdData, fib4, hf, egfr, bmi }) {
  const recs = [];
  if (!glycemicStatus || glycemicStatus === "normal") return recs;
  const e = parseFloat(egfr);
  if (isNaN(e) || e >= 30) recs.push({ drug: "Metformin", rationale: "First-line therapy per ADA 2025. Reduces hepatic glucose output.", tag: "First Line" });
  if (glycemicStatus === "prediabetes") recs.push({ drug: "Lifestyle Intervention", rationale: "5–7% weight loss + 150 min/week activity reduces T2DM progression by 58% (DPP trial).", tag: "Lifestyle" });
  if (bmi && parseFloat(bmi) >= 27) recs.push({ drug: "GLP-1 RA (Semaglutide)", rationale: "Prioritised for weight management and ASCVD risk reduction. ADA 2025 §5.", tag: "Weight + CV" });
  if (ckdData?.sglt2Indicated) recs.push({ drug: "SGLT2 Inhibitor (Empagliflozin)", rationale: `eGFR ${egfr} — SGLT2i slows CKD progression per KDIGO 2023.`, tag: "Renal" });
  if (hf) recs.push({ drug: "SGLT2 Inhibitor (Cardiac)", rationale: "Heart failure detected — SGLT2i initiated regardless of glucose control per ADA 2025.", tag: "Cardiac" });
  if (fib4 && parseFloat(fib4) > 1.3) recs.push({ drug: "Tirzepatide or Pioglitazone", rationale: `FIB-4 ${fib4} — hepatic steatosis risk. GIP/GLP-1 agonists reduce fibrosis.`, tag: "Hepatic" });
  return recs;
}

// ─── API (Groq — free tier) ───────────────────────────────────────────────────
// Get your free key at console.groq.com — no credit card needed
async function callGroq(messages, system = "") {
  const groqMessages = [];
  if (system) groqMessages.push({ role: "system", content: system });
  // Groq doesn't support image content blocks — flatten to text only
  const textOnly = messages.map(m => ({
    role: m.role,
    content: Array.isArray(m.content)
      ? m.content.filter(b => b.type === "text").map(b => b.text).join("\n")
      : m.content
  }));
  groqMessages.push(...textOnly);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${import.meta.env.VITE_GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",   // best free Groq model
      max_tokens: 1500,
      messages: groqMessages
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || "Groq API error " + res.status);
  return data.choices?.[0]?.message?.content || "";
}

async function extractTextFromPDF(file) {
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const pg = await pdf.getPage(i);
    const c = await pg.getTextContent();
    text += c.items.map(x => x.str).join(" ") + "\n";
  }
  return text.trim();
}

// For image files — use Tesseract.js OCR (free, runs in browser)
async function extractTextFromImage(file) {
  if (!window.Tesseract) {
    await new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.0.4/tesseract.min.js";
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  const url = URL.createObjectURL(file);
  const { data: { text } } = await window.Tesseract.recognize(url, "eng");
  URL.revokeObjectURL(url);
  return text.trim();
}

const PARSER_SYSTEM = `You are a medical report parser for a Diabetes Check AI system (ADA 2025).
Identify report type, extract all values, map to fields. Handle synonyms: FBS/FPG/Glucose Level→fpg, A1C/HbA1c→hba1c, SGOT/AST→ast, SGPT/ALT→alt, GFR/eGFR→egfr, ACR/UACR→uacr, BNP/NT-proBNP→ntProBNP, TIR→tir, TBR→tbr, TAR→tar, CV%→cv.
Return ONLY valid JSON, no markdown:
{"reportType":"","reportDescription":"","confidence":"high|medium|low","extractedValues":{"fpg":null,"hba1c":null,"ogtt":null,"fastingInsulin":null,"fastingGlucoseMmol":null,"cPeptide":null,"ast":null,"alt":null,"platelets":null,"egfr":null,"uacr":null,"ntProBNP":null,"avgGlucose":null,"tir":null,"tbr":null,"tar":null,"cv":null,"bmi":null,"age":null},"presentFields":[],"missingFields":[],"additionalFindings":"","rawValuesFound":""}`;

async function parseReportWithAI(file) {
  let text = "";
  try {
    if (file.type === "application/pdf") {
      text = await extractTextFromPDF(file);
    } else {
      // Use OCR for images
      text = await extractTextFromImage(file);
    }
  } catch (e) {
    text = "[text extraction failed: " + e.message + "]";
  }

  const raw = await callGroq([{
    role: "user",
    content: `Medical report "${file.name}":\n---\n${text}\n---\nReturn JSON only.`
  }], PARSER_SYSTEM);

  try {
    const cleaned = raw.replace(/```json[\s\S]*?```|```[\s\S]*?```/g, s => s.replace(/```json|```/g,"")).replace(/```/g,"").trim();
    return JSON.parse(cleaned);
  } catch(e) {
    return { reportType: "Parse Error", reportDescription: "Could not extract structured data. Check your GROQ_API_KEY in .env", confidence: "low", extractedValues: {}, presentFields: [], missingFields: [], additionalFindings: raw.slice(0, 600), rawValuesFound: "" };
  }
}

// ─── CSS-in-JS global styles ──────────────────────────────────────────────────
const GLOBAL_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800;900&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Plus Jakarta Sans', sans-serif; background: #EEEAF8; }
  ::-webkit-scrollbar { width: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #C4B9F0; border-radius: 99px; }
  @keyframes pulse-dot { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.4);opacity:.7} }
  @keyframes slide-up { from{opacity:0;transform:translateY(14px)} to{opacity:1;transform:translateY(0)} }
  @keyframes bounce { 0%,100%{transform:translateY(0);opacity:.4} 50%{transform:translateY(-5px);opacity:1} }
  .card-hover { transition: transform 0.2s, box-shadow 0.2s; }
  .card-hover:hover { transform: translateY(-3px); box-shadow: 0 20px 48px rgba(109,93,233,0.18) !important; }
  .nav-icon { transition: background 0.15s; cursor: pointer; }
  .input-field:focus { border-color: #7C6EF6 !important; box-shadow: 0 0 0 3px rgba(124,110,246,0.15) !important; outline: none; }
  .btn-primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .btn-primary { transition: filter 0.15s, transform 0.15s; }
`;

// ─── Design system ────────────────────────────────────────────────────────────
const C = {
  // Page background: soft lavender matching reference exactly
  pageBg:    "#EEEAF8",
  // Sidebar gradient (vertical pill, purple→deep violet)
  sidebarBg: "linear-gradient(180deg, #8B7FF0 0%, #5B4FD4 100%)",
  // Cards
  card:      "#FFFFFF",
  cardShadow:"0 4px 24px rgba(109,93,233,0.08), 0 1px 4px rgba(0,0,0,0.04)",
  // Hero gradient card (large purple card like reference overview card)
  heroGrad:  "linear-gradient(135deg, #7968F2 0%, #5B4FD4 55%, #4840BE 100%)",
  // Pink accent (matches reference's pink jogging card)
  pinkGrad:  "linear-gradient(135deg, #F472B6 0%, #EC4899 100%)",
  // Text
  textDark:  "#1A1245",
  textMid:   "#6B6490",
  textLight: "#A89FC8",
  // Semantic
  purple:    "#7C6EF6",
  purpleDeep:"#5B4FD4",
  purpleSoft:"#EDE9FF",
  pink:      "#F472B6",
  pinkSoft:  "#FDF2F8",
  green:     "#22C55E",
  greenSoft: "#F0FDF4",
  amber:     "#F59E0B",
  amberSoft: "#FFFBEB",
  red:       "#EF4444",
  redSoft:   "#FEF2F2",
  blue:      "#3B82F6",
  blueSoft:  "#EFF6FF",
  border:    "rgba(124,110,246,0.12)",
  font:      "'Plus Jakarta Sans', sans-serif",
  mono:      "'DM Mono', monospace",
};

// ─── Primitive components ─────────────────────────────────────────────────────

// White glass card — the base card from reference
const Card = ({ children, style = {}, gradient, className = "" }) => (
  <div className={`card-hover ${className}`} style={{
    background: gradient || C.card,
    borderRadius: 22,
    padding: "20px 22px",
    boxShadow: gradient ? "0 8px 32px rgba(109,93,233,0.22)" : C.cardShadow,
    border: gradient ? "none" : `1px solid ${C.border}`,
    ...style
  }}>
    {children}
  </div>
);

// Progress bar (like reference's green/orange bars)
const Bar = ({ pct = 0, color = C.purple, thin = false }) => (
  <div style={{ background: `${color}22`, borderRadius: 99, height: thin ? 5 : 8, overflow: "hidden" }}>
    <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, height: "100%", background: color, borderRadius: 99, transition: "width 0.8s cubic-bezier(.4,0,.2,1)" }} />
  </div>
);

// Tiny status tag
const Tag = ({ label, color = C.purple }) => (
  <span style={{ display: "inline-block", padding: "2px 10px", borderRadius: 99, fontSize: 10, fontWeight: 800, background: `${color}1A`, color, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
);

// Big stat number (like "748 Hr" / "9.178 St" in reference)
const BigStat = ({ value, unit, label, dark = false }) => (
  <div style={{ background: dark ? "rgba(255,255,255,0.14)" : C.pageBg, borderRadius: 16, padding: "14px 18px", flex: "1 1 0" }}>
    <p style={{ margin: "0 0 1px", fontSize: 24, fontWeight: 900, color: dark ? "#fff" : C.textDark, fontFamily: C.mono, letterSpacing: "-0.03em" }}>
      {value}<span style={{ fontSize: 12, fontWeight: 600, color: dark ? "rgba(255,255,255,0.55)" : C.textMid, marginLeft: 4 }}>{unit}</span>
    </p>
    <p style={{ margin: 0, fontSize: 11, color: dark ? "rgba(255,255,255,0.45)" : C.textLight, fontWeight: 500 }}>{label}</p>
  </div>
);

// Labelled metric row with progress
const MetricRow = ({ label, value, unit, pct, color }) => {
  const col = color || C.purple;
  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 7 }}>
        <span style={{ fontSize: 12, color: C.textMid, fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: 14, fontWeight: 800, color: col, fontFamily: C.mono }}>
          {value}<span style={{ fontSize: 10, color: C.textLight, fontWeight: 500, marginLeft: 2 }}>{unit}</span>
        </span>
      </div>
      {pct !== undefined && <Bar pct={pct} color={col} />}
    </div>
  );
};

// Alert strip
const Alert = ({ type = "info", children }) => {
  const s = { error: [C.redSoft, C.red, AlertCircle], warn: [C.amberSoft, C.amber, AlertTriangle], success: [C.greenSoft, C.green, CheckCircle], info: [C.purpleSoft, C.purple, Info] }[type] || [C.purpleSoft, C.purple, Info];
  const Icon = s[2];
  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 13px", background: s[0], borderRadius: 11, marginTop: 10, alignItems: "flex-start" }}>
      <Icon size={14} color={s[1]} style={{ flexShrink: 0, marginTop: 1 }} />
      <span style={{ fontSize: 12, color: C.textDark, lineHeight: 1.6 }}>{children}</span>
    </div>
  );
};

// Form input
const Input = ({ label, name, value, onChange, placeholder, type = "number" }) => (
  <div style={{ marginBottom: 13 }}>
    <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: C.textLight, marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>{label}</label>
    <input className="input-field" type={type} name={name} value={value} onChange={onChange} placeholder={placeholder || "—"}
      style={{ width: "100%", background: C.pageBg, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "9px 13px", color: C.textDark, fontSize: 13, fontFamily: C.font, transition: "border-color 0.15s, box-shadow 0.15s" }} />
  </div>
);

// Toggle switch
const Toggle = ({ label, checked, onChange, description }) => (
  <div onClick={onChange} style={{ display: "flex", gap: 11, padding: "9px 11px", borderRadius: 12, cursor: "pointer", background: checked ? C.purpleSoft : "rgba(0,0,0,0.02)", border: `1.5px solid ${checked ? C.purple + "44" : C.border}`, marginBottom: 8, userSelect: "none", transition: "all 0.15s" }}>
    <div style={{ flexShrink: 0, marginTop: 1, width: 36, height: 20, borderRadius: 99, background: checked ? C.purple : "#D1D5DB", position: "relative", transition: "background 0.2s" }}>
      <div style={{ position: "absolute", top: 3, left: checked ? 17 : 3, width: 14, height: 14, borderRadius: "50%", background: "#fff", transition: "left 0.2s", boxShadow: "0 1px 4px rgba(0,0,0,0.18)" }} />
    </div>
    <div>
      <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: C.textDark }}>{label}</p>
      {description && <p style={{ margin: "1px 0 0", fontSize: 11, color: C.textMid }}>{description}</p>}
    </div>
  </div>
);

// Section heading
const SHead = ({ children }) => (
  <p style={{ margin: "0 0 14px", fontSize: 10, fontWeight: 800, color: C.textLight, letterSpacing: "0.1em", textTransform: "uppercase" }}>{children}</p>
);

// ─── Upload Panel ─────────────────────────────────────────────────────────────
function UploadPanel({ onExtracted }) {
  const [results, setResults] = useState([]);
  const [parsing, setParsing] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileRef = useRef();

  const process = async (files) => {
    const valid = Array.from(files).filter(f => f.type.startsWith("image/") || f.type === "application/pdf");
    if (!valid.length) return;
    setParsing(true);
    const out = [];
    for (const f of valid) {
      try { out.push({ name: f.name, ...(await parseReportWithAI(f)) }); }
      catch (e) { out.push({ name: f.name, reportType: "Error", reportDescription: e.message, confidence: "low", extractedValues: {}, presentFields: [], missingFields: [], additionalFindings: "", rawValuesFound: "" }); }
    }
    setResults(p => [...p, ...out]);
    setParsing(false);
    const merged = {};
    for (const r of out) for (const [k, v] of Object.entries(r.extractedValues || {})) if (v != null) merged[k] = String(v);
    if (Object.keys(merged).length) onExtracted(merged);
  };

  return (
    <div>
      {/* Drop zone */}
      <div
        onClick={() => fileRef.current.click()}
        onDrop={e => { e.preventDefault(); setDrag(false); process(e.dataTransfer.files); }}
        onDragOver={e => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        style={{ border: `2px dashed ${drag ? C.purple : C.border}`, borderRadius: 18, padding: "38px 20px", textAlign: "center", background: drag ? C.purpleSoft : `${C.purple}05`, cursor: "pointer", transition: "all 0.2s" }}>
        <input ref={fileRef} type="file" multiple accept="image/*,.pdf" style={{ display: "none" }} onChange={e => process(e.target.files)} />
        <div style={{ width: 54, height: 54, borderRadius: 17, background: C.heroGrad, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 14px", boxShadow: `0 8px 24px ${C.purple}55` }}>
          <Upload size={22} color="#fff" />
        </div>
        <p style={{ margin: "0 0 5px", fontSize: 15, fontWeight: 800, color: C.textDark }}>Drop medical reports here</p>
        <p style={{ margin: "0 0 16px", fontSize: 12, color: C.textMid }}>Blood reports · HbA1c · LFT · KFT · CGM — JPG, PNG, PDF</p>
        <button className="btn-primary" style={{ padding: "9px 26px", background: C.heroGrad, color: "#fff", border: "none", borderRadius: 99, fontSize: 13, fontWeight: 700, cursor: "pointer", boxShadow: `0 4px 16px ${C.purple}44` }}>
          Select Files
        </button>
      </div>

      {parsing && (
        <div style={{ marginTop: 14, display: "flex", gap: 12, alignItems: "center", padding: "13px 16px", background: C.purpleSoft, borderRadius: 14, border: `1px solid ${C.purple}22` }}>
          <div style={{ width: 32, height: 32, borderRadius: 10, background: C.heroGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <Microscope size={15} color="#fff" />
          </div>
          <div>
            <p style={{ margin: 0, fontSize: 13, fontWeight: 700, color: C.textDark }}>AI reading your report…</p>
            <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textMid }}>Detecting type · Extracting values · Mapping fields</p>
          </div>
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {[0,1,2].map(j => <div key={j} style={{ width: 6, height: 6, borderRadius: "50%", background: C.purple, animation: `bounce 1.2s ease-in-out ${j*0.2}s infinite` }} />)}
          </div>
        </div>
      )}

      {results.map((r, i) => {
        const cc = r.confidence === "high" ? C.green : r.confidence === "medium" ? C.amber : C.red;
        const extracted = Object.entries(r.extractedValues || {}).filter(([, v]) => v != null);
        return (
          <div key={i} style={{ marginTop: 12, background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: "16px", animation: "slide-up 0.3s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
              <div style={{ display: "flex", gap: 11 }}>
                <div style={{ width: 38, height: 38, borderRadius: 12, background: C.heroGrad, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <FileText size={17} color="#fff" />
                </div>
                <div>
                  <p style={{ margin: 0, fontSize: 13, fontWeight: 800, color: C.textDark }}>{r.reportType}</p>
                  <p style={{ margin: "2px 0 0", fontSize: 11, color: C.textLight }}>{r.name}</p>
                </div>
              </div>
              <Tag label={r.confidence === "high" ? "High" : r.confidence === "medium" ? "Medium" : "Low"} color={cc} />
            </div>
            {r.reportDescription && <p style={{ margin: "0 0 10px", fontSize: 12, color: C.textMid, lineHeight: 1.6 }}>{r.reportDescription}</p>}
            {extracted.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {extracted.map(([k, v]) => (
                  <span key={k} style={{ fontSize: 11, background: C.purpleSoft, color: C.purple, borderRadius: 8, padding: "3px 9px", fontFamily: C.mono, fontWeight: 700 }}>{k}: {v}</span>
                ))}
              </div>
            )}
            {r.rawValuesFound && <p style={{ margin: "8px 0 0", fontSize: 11, color: C.textMid, background: C.pageBg, padding: "7px 10px", borderRadius: 9, lineHeight: 1.6 }}><strong style={{ color: C.textDark }}>Raw: </strong>{r.rawValuesFound}</p>}
            {r.presentFields?.length > 0 && (
              <div style={{ marginTop: 10 }}>
                <p style={{ margin: "0 0 5px", fontSize: 10, fontWeight: 800, color: C.green, textTransform: "uppercase", letterSpacing: "0.06em" }}>Fields found</p>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>{r.presentFields.map(f => <Tag key={f} label={f} color={C.green} />)}</div>
              </div>
            )}
          </div>
        );
      })}
      {results.length > 0 && !parsing && <Alert type="success">{results.length} report(s) processed — form auto-populated.</Alert>}
    </div>
  );
}

// ─── Chat Panel ───────────────────────────────────────────────────────────────
function ChatPanel({ report, form }) {
  const [msgs, setMsgs] = useState([{ role: "assistant", content: "Hello. I'm your DiabetesCheck clinical assistant, grounded in ADA 2025 and KDIGO 2023. Ask me about any result, medication, or next step." }]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef();
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs]);

  const ctx = () => {
    const p = [];
    if (form.fpg) p.push(`FPG:${form.fpg}`);
    if (form.hba1c) p.push(`HbA1c:${form.hba1c}%`);
    if (form.egfr) p.push(`eGFR:${form.egfr}`);
    if (form.bmi) p.push(`BMI:${form.bmi}`);
    if (report?.glycemic?.status) p.push(`Dx:${report.glycemic.status}`);
    return p.join(" | ") || "No data entered";
  };

  const send = async () => {
    if (!input.trim() || loading) return;
    const user = { role: "user", content: input.trim() };
    const updated = [...msgs, user];
    setMsgs(updated); setInput(""); setLoading(true);
    const sys = `You are DiabetesCheck AI — ADA 2025 + KDIGO 2023 clinical assistant. Patient context: ${ctx()}. Be precise, cite guidelines, note when physician review is needed. Keep answers concise (3–5 sentences max). Never provide a definitive diagnosis.`;
    const reply = await callGroq(updated.map(m => ({ role: m.role, content: m.content })), sys);
    setMsgs(p => [...p, { role: "assistant", content: reply }]);
    setLoading(false);
  };

  const QUICK = ["What does my HbA1c mean?", "Is my FPG in diabetes range?", "Explain kidney results", "What lifestyle changes help?", "When is Metformin used?", "What is FIB-4?"];

  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      {/* Messages */}
      <div style={{ overflowY: "auto", maxHeight: 420, marginBottom: 14, paddingRight: 4, display: "flex", flexDirection: "column", gap: 14 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: m.role === "user" ? "flex-end" : "flex-start", animation: "slide-up 0.2s ease" }}>
            {m.role === "assistant" && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                <div style={{ width: 26, height: 26, borderRadius: 9, background: C.heroGrad, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Stethoscope size={12} color="#fff" />
                </div>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.textMid }}>DiabetesCheck AI</span>
              </div>
            )}
            <div style={{ maxWidth: "80%", padding: "11px 15px", borderRadius: m.role === "user" ? "17px 17px 4px 17px" : "4px 17px 17px 17px", background: m.role === "user" ? C.heroGrad : C.card, border: m.role !== "user" ? `1px solid ${C.border}` : "none", color: m.role === "user" ? "#fff" : C.textDark, fontSize: 13, lineHeight: 1.7, boxShadow: m.role === "user" ? `0 4px 14px ${C.purple}44` : C.cardShadow }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 5, padding: "12px 15px", background: C.card, border: `1px solid ${C.border}`, borderRadius: "4px 17px 17px 17px", width: "fit-content", boxShadow: C.cardShadow }}>
            {[0,1,2].map(j => <div key={j} style={{ width: 7, height: 7, borderRadius: "50%", background: C.purple, animation: `bounce 1.2s ease-in-out ${j*0.2}s infinite` }} />)}
          </div>
        )}
        <div ref={endRef} />
      </div>

      {/* Quick prompts */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
        {QUICK.map((q, i) => (
          <button key={i} onClick={() => setInput(q)}
            style={{ padding: "5px 13px", borderRadius: 99, background: C.purpleSoft, border: `1px solid ${C.purple}22`, color: C.purple, fontSize: 11, fontWeight: 700, cursor: "pointer", transition: "background 0.15s" }}
            onMouseEnter={e => e.currentTarget.style.background = `${C.purple}28`}
            onMouseLeave={e => e.currentTarget.style.background = C.purpleSoft}>
            {q}
          </button>
        ))}
      </div>

      {/* Input bar */}
      <div style={{ display: "flex", gap: 8 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && send()}
          placeholder="Ask about results, medications, lifestyle…"
          className="input-field"
          style={{ flex: 1, background: C.pageBg, border: `1.5px solid ${C.border}`, borderRadius: 13, padding: "11px 15px", color: C.textDark, fontSize: 13, fontFamily: C.font }} />
        <button className="btn-primary" onClick={send} disabled={loading || !input.trim()}
          style={{ padding: "11px 18px", borderRadius: 13, background: input.trim() && !loading ? C.heroGrad : "#E5E7EB", border: "none", color: "#fff", cursor: loading ? "not-allowed" : "pointer", display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 700, boxShadow: input.trim() ? `0 4px 14px ${C.purple}44` : "none" }}>
          <Send size={14} /> Send
        </button>
      </div>
    </div>
  );
}

// ─── Initial form state ───────────────────────────────────────────────────────
const INIT = { name: "", age: "", sex: "male", bmi: "", fpg: "", hba1c: "", ogtt: "", fastingInsulin: "", fastingGlucoseMmol: "", cPeptide: "", gad65: false, ia2: false, znt8: false, ast: "", alt: "", platelets: "", egfr: "", uacr: "", hf: false, ntProBNP: "", avgGlucose: "", tir: "", tbr: "", tar: "", cv: "", familyHistory: false, htn: false, ascvd: false, polyuria: false, polydipsia: false, weightLoss: false };

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function App() {
  const [page, setPage]     = useState("upload");
  const [form, setForm]     = useState(INIT);
  const [report, setReport] = useState(null);

  const onChange    = useCallback(e => { const { name, value, type, checked } = e.target; setForm(f => ({ ...f, [name]: type === "checkbox" ? checked : value })); }, []);
  const onToggle    = useCallback(name => setForm(f => ({ ...f, [name]: !f[name] })), []);
  const onExtracted = useCallback(vals => setForm(f => { const m = { ...f }; for (const [k, v] of Object.entries(vals)) if (v != null && m[k] !== undefined && typeof m[k] !== "boolean") m[k] = v; return m; }), []);

  const runAnalysis = () => {
    const glycemic  = classifyGlycemic({ fpg: form.fpg, hba1c: form.hba1c, ogtt: form.ogtt });
    const fib4      = calcFIB4(form.age, form.ast, form.platelets, form.alt);
    const fib4Val   = fib4 ? parseFloat(fib4) : null;
    const fib4Risk  = fib4Val === null ? null : fib4Val > 2.67 ? "high" : fib4Val > 1.3 ? "intermediate" : "low";
    const gmi       = calcGMI(form.avgGlucose);
    const ckdData   = form.egfr ? stageCKD(form.egfr, form.uacr) : null;
    const treatment = generateTreatment({ glycemicStatus: glycemic?.status, ckdData, fib4, hf: form.hf, egfr: form.egfr, bmi: form.bmi });
    const cgmAlerts = [];
    if (form.tbr && parseFloat(form.tbr) > 1) cgmAlerts.push("TBR > 1% — immediate hypoglycaemia risk");
    if (form.cv && parseFloat(form.cv) > 36) cgmAlerts.push("%CV > 36% — high glycaemic variability");
    const t1dAbs   = [form.gad65 && "GAD65", form.ia2 && "IA-2", form.znt8 && "ZnT8"].filter(Boolean);
    const t1dStage = t1dAbs.length >= 2 ? "Stage 1/2" : t1dAbs.length === 1 ? "Stage 1" : null;
    setReport({ glycemic, fib4, fib4Val, fib4Risk, gmi, ckdData, treatment, cgmAlerts, t1dAbs, t1dStage, form: { ...form }, ts: new Date().toLocaleString() });
    setPage("report");
  };

  // Sidebar nav items
  const NAV = [
    { id: "upload",  Icon: Upload,        label: "Upload"  },
    { id: "input",   Icon: ClipboardList, label: "Patient" },
    { id: "report",  Icon: BarChart2,     label: "Report"  },
    { id: "chat",    Icon: MessageSquare, label: "Ask AI"  },
    { id: "patient", Icon: User,          label: "Summary" },
  ];

  // Status config
  const STAT_CFG = {
    normal:      { grad: "linear-gradient(135deg,#22C55E,#16A34A)", label: "Normal",       sub: "Glycaemic levels within healthy range" },
    prediabetes:  { grad: "linear-gradient(135deg,#F59E0B,#D97706)", label: "Pre-Diabetes", sub: "Elevated glucose — early intervention recommended" },
    diabetes:    { grad: "linear-gradient(135deg,#EF4444,#DC2626)", label: "Diabetes",     sub: "Confirmed hyperglycaemia — treatment required" },
  };

  const pageTitles = { upload: "Upload Reports", input: "Patient Data", report: "Clinical Report", chat: "Ask the AI", patient: "Patient Summary" };

  return (
    <>
      <style>{GLOBAL_CSS}</style>

      <div style={{ display: "flex", minHeight: "100vh", background: C.pageBg, fontFamily: C.font, color: C.textDark }}>

        {/* ══ SIDEBAR — narrow icon rail, purple gradient, pill-shaped active states ══ */}
        <div style={{ width: 78, background: C.sidebarBg, display: "flex", flexDirection: "column", alignItems: "center", padding: "22px 0 20px", position: "fixed", top: 0, bottom: 0, left: 0, zIndex: 60, boxShadow: "4px 0 32px rgba(91,79,212,0.35)" }}>

          {/* Logo mark */}
          <div style={{ width: 44, height: 44, borderRadius: 15, background: "rgba(255,255,255,0.22)", display: "flex", alignItems: "center", justifyContent: "center", marginBottom: 30, boxShadow: "0 4px 14px rgba(0,0,0,0.2)" }}>
            <Activity size={22} color="#fff" strokeWidth={2.5} />
          </div>

          {/* Nav icons — each a pill/rounded square */}
          <nav style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, width: "100%", padding: "0 10px" }}>
            {NAV.map(({ id, Icon, label }) => {
              const active = page === id;
              return (
                <div key={id} title={label} onClick={() => setPage(id)} className="nav-icon"
                  style={{ borderRadius: 16, padding: "10px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 4, background: active ? "rgba(255,255,255,0.24)" : "transparent", boxShadow: active ? "0 4px 14px rgba(0,0,0,0.15)" : "none" }}>
                  <Icon size={19} color={active ? "#fff" : "rgba(255,255,255,0.58)"} strokeWidth={active ? 2.5 : 2} />
                  <span style={{ fontSize: 9, fontWeight: 800, color: active ? "#fff" : "rgba(255,255,255,0.5)", letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
                </div>
              );
            })}
          </nav>

          {/* User avatar */}
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", border: "2px solid rgba(255,255,255,0.25)" }}>
            <User size={17} color="rgba(255,255,255,0.85)" />
          </div>
        </div>

        {/* ══ MAIN AREA ══ */}
        <div style={{ marginLeft: 78, flex: 1, display: "flex", flexDirection: "column" }}>

          {/* Top bar — frosted glass like reference */}
          <div style={{ position: "sticky", top: 0, zIndex: 50, background: "rgba(238,234,248,0.82)", backdropFilter: "blur(18px)", borderBottom: `1px solid ${C.border}`, padding: "13px 28px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <p style={{ margin: "0 0 1px", fontSize: 10, fontWeight: 800, color: C.textLight, letterSpacing: "0.1em", textTransform: "uppercase" }}>DiabetesCheck AI · ADA 2025</p>
              <p style={{ margin: 0, fontSize: 19, fontWeight: 900, color: C.textDark }}>{pageTitles[page]}</p>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              {/* Search bar like reference */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: "8px 14px", boxShadow: C.cardShadow }}>
                <Search size={14} color={C.textLight} />
                <span style={{ fontSize: 13, color: C.textLight }}>Search…</span>
              </div>
              {report?.glycemic?.status && (() => {
                const sc = STAT_CFG[report.glycemic.status];
                return <div style={{ padding: "6px 16px", borderRadius: 99, background: sc.grad, color: "#fff", fontSize: 12, fontWeight: 800, boxShadow: "0 4px 12px rgba(0,0,0,0.18)" }}>{sc.label}</div>;
              })()}
              <div style={{ width: 38, height: 38, borderRadius: 13, background: C.card, border: `1px solid ${C.border}`, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", boxShadow: C.cardShadow }}>
                <Bell size={16} color={C.textMid} />
              </div>
            </div>
          </div>

          {/* ══ PAGE CONTENT ══ */}
          <div style={{ flex: 1, padding: "26px 28px" }}>

            {/* ───── UPLOAD PAGE ───── */}
            {page === "upload" && (
              <div style={{ animation: "slide-up 0.3s ease" }}>
                <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 900, color: C.textDark }}>Upload Medical Reports</p>
                <p style={{ margin: "0 0 24px", fontSize: 14, color: C.textMid }}>AI detects report type, extracts all values, and auto-fills the patient form.</p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, alignItems: "start" }}>
                  {/* Left — upload */}
                  <div>
                    <Card><UploadPanel onExtracted={onExtracted} /></Card>
                    <button className="btn-primary" onClick={() => setPage("input")}
                      style={{ marginTop: 14, width: "100%", padding: "13px", background: C.heroGrad, color: "#fff", border: "none", borderRadius: 16, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, boxShadow: `0 6px 22px ${C.purple}44` }}>
                      Continue to Patient Data <ArrowRight size={16} />
                    </button>
                  </div>

                  {/* Right — info */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>

                    {/* How it works — purple hero card */}
                    <Card gradient={C.heroGrad} style={{ padding: "24px 26px" }}>
                      <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.1em" }}>3-Step Process</p>
                      <p style={{ margin: "0 0 20px", fontSize: 17, fontWeight: 900, color: "#fff" }}>How AI Parsing Works</p>
                      {[
                        { Icon: FileText,    t: "Upload Any Report",  d: "JPG, PNG or PDF — photos, scans, printed tables all supported." },
                        { Icon: Stethoscope, t: "AI Reads & Maps",    d: "Handles 50+ name variants: FBS→FPG, SGOT→AST, ACR→UACR automatically." },
                        { Icon: CheckCircle, t: "Form Auto-Filled",   d: "All matched values instantly populate — just verify and run." },
                      ].map((s, i) => (
                        <div key={i} style={{ display: "flex", gap: 12, marginBottom: i < 2 ? 16 : 0 }}>
                          <div style={{ width: 36, height: 36, borderRadius: 11, background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <s.Icon size={16} color="#fff" />
                          </div>
                          <div>
                            <p style={{ margin: "0 0 2px", fontSize: 13, fontWeight: 800, color: "#fff" }}>{s.t}</p>
                            <p style={{ margin: 0, fontSize: 12, color: "rgba(255,255,255,0.62)", lineHeight: 1.5 }}>{s.d}</p>
                          </div>
                        </div>
                      ))}
                    </Card>

                    {/* Report types grid */}
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
                      {[
                        { label: "FPG / HbA1c", sub: "Blood Sugar", col: C.purple },
                        { label: "LFT",         sub: "Liver Panel",  col: C.amber  },
                        { label: "KFT / eGFR",  sub: "Kidney",      col: C.blue   },
                        { label: "CGM / AGP",   sub: "TIR · CV%",   col: C.green  },
                        { label: "Cardiac",     sub: "NT-proBNP",   col: C.pink   },
                        { label: "OGTT",        sub: "Glucose test", col: C.red    },
                      ].map((r, i) => (
                        <Card key={i} style={{ padding: "14px 14px", textAlign: "center" }}>
                          <div style={{ width: 34, height: 34, borderRadius: 11, background: `${r.col}18`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 8px" }}>
                            <Activity size={15} color={r.col} />
                          </div>
                          <p style={{ margin: "0 0 2px", fontSize: 12, fontWeight: 800, color: C.textDark }}>{r.label}</p>
                          <p style={{ margin: 0, fontSize: 10, color: C.textMid }}>{r.sub}</p>
                        </Card>
                      ))}
                    </div>

                    {/* ADA thresholds — graphical card */}
                    <Card style={{ background: "linear-gradient(135deg,#1A1245 0%,#2B1F6B 100%)", border: "none", overflow: "hidden" }}>
                      {/* Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <Shield size={14} color="#4ADE80" />
                          <span style={{ fontSize: 12, fontWeight: 800, color: "#fff", letterSpacing: "0.01em" }}>ADA 2025 Key Thresholds</span>
                        </div>
                        <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", letterSpacing: "0.08em", fontWeight: 700 }}>LIVE REFERENCE</span>
                      </div>

                      {/* ── Donut rings row: TIR + HbA1c ── */}
                      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}>
                        {/* TIR ring */}
                        {(() => { const r=28, circ=2*Math.PI*r, dash=(70/100)*circ; return (
                          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "13px 10px", display: "flex", alignItems: "center", gap: 10 }}>
                            <svg width={66} height={66} style={{ flexShrink: 0 }}>
                              <circle cx={33} cy={33} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={7}/>
                              <circle cx={33} cy={33} r={r} fill="none" stroke="#4ADE80" strokeWidth={7}
                                strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round" transform="rotate(-90 33 33)"/>
                              <text x={33} y={37} textAnchor="middle" fill="#4ADE80" fontSize={12} fontWeight={800} fontFamily="DM Mono,monospace">70%</text>
                            </svg>
                            <div>
                              <p style={{ margin:"0 0 2px", fontSize:11, fontWeight:700, color:"#fff" }}>Time in Range</p>
                              <p style={{ margin:"0 0 7px", fontSize:10, color:"rgba(255,255,255,0.35)" }}>CGM target TIR</p>
                              <span style={{ fontSize:9, background:"rgba(74,222,128,0.15)", color:"#4ADE80", padding:"2px 8px", borderRadius:20, border:"1px solid rgba(74,222,128,0.3)", fontWeight:700 }}>Target &gt; 70%</span>
                            </div>
                          </div>
                        ); })()}
                        {/* HbA1c ring */}
                        {(() => { const r=28, circ=2*Math.PI*r, dash=(65/100)*circ; return (
                          <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "13px 10px", display: "flex", alignItems: "center", gap: 10 }}>
                            <svg width={66} height={66} style={{ flexShrink: 0 }}>
                              <circle cx={33} cy={33} r={r} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={7}/>
                              <circle cx={33} cy={33} r={r} fill="none" stroke="#F87171" strokeWidth={7}
                                strokeDasharray={`${dash} ${circ-dash}`} strokeLinecap="round" transform="rotate(-90 33 33)"/>
                              <text x={33} y={37} textAnchor="middle" fill="#F87171" fontSize={12} fontWeight={800} fontFamily="DM Mono,monospace">6.5%</text>
                            </svg>
                            <div>
                              <p style={{ margin:"0 0 2px", fontSize:11, fontWeight:700, color:"#fff" }}>HbA1c</p>
                              <p style={{ margin:"0 0 7px", fontSize:10, color:"rgba(255,255,255,0.35)" }}>Diabetes cutoff</p>
                              <span style={{ fontSize:9, background:"rgba(248,113,113,0.15)", color:"#F87171", padding:"2px 8px", borderRadius:20, border:"1px solid rgba(248,113,113,0.3)", fontWeight:700 }}>≥ 6.5% = Diabetes</span>
                            </div>
                          </div>
                        ); })()}
                      </div>

                      {/* ── FPG segmented range bar ── */}
                      <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "13px 13px", marginBottom: 10 }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 9 }}>
                          <p style={{ margin:0, fontSize:11, fontWeight:700, color:"#fff" }}>Fasting Plasma Glucose (FPG)</p>
                          <span style={{ fontSize:10, color:"rgba(255,255,255,0.3)", fontFamily:C.mono }}>mg/dL</span>
                        </div>
                        <div style={{ height: 9, borderRadius: 9, overflow: "hidden", display: "flex", marginBottom: 9 }}>
                          <div style={{ flex: 100, background: "#4ADE80" }} />
                          <div style={{ flex: 25,  background: "#FCD34D" }} />
                          <div style={{ flex: 75,  background: "#F87171" }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          {[
                            { label:"Normal",      range:"< 100",   color:"#4ADE80" },
                            { label:"Prediabetes", range:"100–125", color:"#FCD34D" },
                            { label:"Diabetes",    range:"≥ 126",   color:"#F87171" },
                          ].map((z,i) => (
                            <div key={i} style={{ display:"flex", alignItems:"center", gap:5 }}>
                              <div style={{ width:7, height:7, borderRadius:"50%", background:z.color }} />
                              <span style={{ fontSize:10, fontWeight:700, color:z.color }}>{z.label}</span>
                              <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)", fontFamily:C.mono }}>{z.range}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* ── FIB-4 scale bar ── */}
                      <div style={{ background: "rgba(255,255,255,0.05)", borderRadius: 12, padding: "13px 13px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 9 }}>
                          <p style={{ margin:0, fontSize:11, fontWeight:700, color:"#fff" }}>FIB-4 Liver Fibrosis Index</p>
                          <span style={{ fontSize:9, background:"rgba(252,211,77,0.15)", color:"#FCD34D", padding:"2px 8px", borderRadius:20, border:"1px solid rgba(252,211,77,0.3)", fontWeight:700 }}>Risk &gt; 1.3</span>
                        </div>
                        <div style={{ position:"relative", marginBottom: 9 }}>
                          <div style={{ display:"flex", height:9, borderRadius:9, overflow:"hidden" }}>
                            <div style={{ flex:13, background:"#4ADE80" }} />
                            <div style={{ flex:14, background:"#FCD34D" }} />
                            <div style={{ flex:73, background:"#F87171" }} />
                          </div>
                          <div style={{ position:"absolute", top:-3, left:"13%", width:2, height:15, background:"rgba(255,255,255,0.6)", borderRadius:2 }} />
                          <div style={{ position:"absolute", top:-3, left:"27%", width:2, height:15, background:"rgba(255,255,255,0.6)", borderRadius:2 }} />
                        </div>
                        <div style={{ display:"flex", justifyContent:"space-between" }}>
                          {[
                            { label:"Low risk",     range:"≤ 1.3",    color:"#4ADE80" },
                            { label:"Intermediate", range:"1.3–2.67", color:"#FCD34D" },
                            { label:"High risk",    range:"> 2.67",   color:"#F87171" },
                          ].map((z,i) => (
                            <div key={i} style={{ display:"flex", alignItems:"center", gap:5 }}>
                              <div style={{ width:7, height:7, borderRadius:"50%", background:z.color }} />
                              <span style={{ fontSize:10, fontWeight:700, color:z.color }}>{z.label}</span>
                              <span style={{ fontSize:9, color:"rgba(255,255,255,0.25)", fontFamily:C.mono }}>{z.range}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      <p style={{ margin:"12px 0 0", fontSize:9, color:"rgba(255,255,255,0.18)", letterSpacing:"0.07em", fontWeight:600 }}>SOURCE: ADA 2025 STANDARDS OF CARE · KDIGO 2023</p>
                    </Card>
                  </div>
                </div>
              </div>
            )}

            {/* ───── PATIENT DATA ───── */}
            {page === "input" && (
              <div style={{ animation: "slide-up 0.3s ease" }}>
                <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 900 }}>Patient Data</p>
                <p style={{ margin: "0 0 24px", fontSize: 14, color: C.textMid }}>Auto-populated from uploaded reports — review and complete any missing fields.</p>

                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 }}>

                  <Card>
                    <SHead>Demographics</SHead>
                    <Input label="Patient Name" name="name" value={form.name} onChange={onChange} type="text" placeholder="Full name" />
                    <Input label="Age (years)" name="age" value={form.age} onChange={onChange} placeholder="e.g. 45" />
                    <div style={{ marginBottom: 13 }}>
                      <label style={{ display: "block", fontSize: 10, fontWeight: 800, color: C.textLight, marginBottom: 5, letterSpacing: "0.08em", textTransform: "uppercase" }}>Sex</label>
                      <select name="sex" value={form.sex} onChange={onChange} style={{ width: "100%", background: C.pageBg, border: `1.5px solid ${C.border}`, borderRadius: 12, padding: "9px 13px", color: C.textDark, fontSize: 13, fontFamily: C.font, outline: "none" }}>
                        <option value="male">Male</option>
                        <option value="female">Female</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <Input label="BMI (kg/m²)" name="bmi" value={form.bmi} onChange={onChange} placeholder="e.g. 28.5" />
                    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 13, marginTop: 4 }}>
                      <SHead>Risk Factors</SHead>
                      <Toggle label="Family history of diabetes" checked={form.familyHistory} onChange={() => onToggle("familyHistory")} />
                      <Toggle label="Hypertension ≥ 130/80 mmHg" checked={form.htn} onChange={() => onToggle("htn")} />
                      <Toggle label="Established ASCVD" checked={form.ascvd} onChange={() => onToggle("ascvd")} />
                    </div>
                  </Card>

                  <Card>
                    <SHead>Glycaemic Markers</SHead>
                    <Input label="Fasting Plasma Glucose — FPG (mg/dL)" name="fpg" value={form.fpg} onChange={onChange} placeholder="Normal < 100" />
                    <Input label="HbA1c (%)" name="hba1c" value={form.hba1c} onChange={onChange} placeholder="Normal < 5.7" />
                    <Input label="2-hr OGTT (mg/dL)" name="ogtt" value={form.ogtt} onChange={onChange} placeholder="Normal < 140" />
                    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 13, marginTop: 4 }}>
                      <SHead>Secondary Biomarkers</SHead>
                      <Input label="Fasting Insulin (μU/mL)" name="fastingInsulin" value={form.fastingInsulin} onChange={onChange} placeholder="For HOMA-IR" />
                      <Input label="Fasting Glucose (mmol/L)" name="fastingGlucoseMmol" value={form.fastingGlucoseMmol} onChange={onChange} placeholder="For HOMA-IR" />
                      <Input label="C-Peptide (nmol/L)" name="cPeptide" value={form.cPeptide} onChange={onChange} placeholder="> 0.33 suggests T2D" />
                    </div>
                  </Card>

                  <Card>
                    <SHead>T1D Autoimmunity</SHead>
                    <Toggle label="GAD65 Antibody positive" description="Most common T1D antibody" checked={form.gad65} onChange={() => onToggle("gad65")} />
                    <Toggle label="IA-2 Antibody positive" description="Targets pancreatic phosphatase" checked={form.ia2} onChange={() => onToggle("ia2")} />
                    <Toggle label="ZnT8 Antibody positive" description="Zinc transporter antibody" checked={form.znt8} onChange={() => onToggle("znt8")} />
                    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 13, marginTop: 4 }}>
                      <SHead>Classic Symptoms</SHead>
                      <Toggle label="Polyuria — frequent urination" checked={form.polyuria} onChange={() => onToggle("polyuria")} />
                      <Toggle label="Polydipsia — excessive thirst" checked={form.polydipsia} onChange={() => onToggle("polydipsia")} />
                      <Toggle label="Unexplained weight loss" checked={form.weightLoss} onChange={() => onToggle("weightLoss")} />
                    </div>
                  </Card>

                  <Card>
                    <SHead>Liver — FIB-4 Index</SHead>
                    <p style={{ margin: "0 0 13px", fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>ADA 2025 mandates MASLD screening in all T2DM / prediabetes adults.</p>
                    <Input label="AST (U/L)" name="ast" value={form.ast} onChange={onChange} placeholder="e.g. 32" />
                    <Input label="ALT (U/L)" name="alt" value={form.alt} onChange={onChange} placeholder="e.g. 28" />
                    <Input label="Platelet Count (10⁹/L)" name="platelets" value={form.platelets} onChange={onChange} placeholder="e.g. 220" />
                  </Card>

                  <Card>
                    <SHead>Kidney — KDIGO 2023</SHead>
                    <p style={{ margin: "0 0 13px", fontSize: 12, color: C.textMid, lineHeight: 1.5 }}>Annual eGFR + UACR assessment for all T2DM patients.</p>
                    <Input label="eGFR (mL/min/1.73m²)" name="egfr" value={form.egfr} onChange={onChange} placeholder="Normal > 60" />
                    <Input label="UACR (mg/g)" name="uacr" value={form.uacr} onChange={onChange} placeholder="Normal < 30" />
                  </Card>

                  <Card>
                    <SHead>Heart & CGM</SHead>
                    <Toggle label="Heart failure symptoms" description="Fatigue or dyspnoea at rest" checked={form.hf} onChange={() => onToggle("hf")} />
                    <Input label="NT-proBNP (pg/mL)" name="ntProBNP" value={form.ntProBNP} onChange={onChange} placeholder="e.g. 125" />
                    <div style={{ borderTop: `1px solid ${C.border}`, paddingTop: 13, marginTop: 4 }}>
                      <SHead>CGM / AGP Metrics</SHead>
                      <Input label="Avg Glucose (mg/dL)" name="avgGlucose" value={form.avgGlucose} onChange={onChange} placeholder="e.g. 154" />
                      <Input label="TIR — Time in Range (%)" name="tir" value={form.tir} onChange={onChange} placeholder="Target > 70%" />
                      <Input label="TBR — Time Below Range (%)" name="tbr" value={form.tbr} onChange={onChange} placeholder="Target < 4%" />
                      <Input label="TAR — Time Above Range (%)" name="tar" value={form.tar} onChange={onChange} placeholder="Target < 25%" />
                      <Input label="Glucose CV (%)" name="cv" value={form.cv} onChange={onChange} placeholder="Target ≤ 36%" />
                    </div>
                  </Card>
                </div>

                <div style={{ marginTop: 22, display: "flex", gap: 14, alignItems: "center" }}>
                  <button className="btn-primary" onClick={runAnalysis}
                    style={{ padding: "13px 36px", background: C.heroGrad, color: "#fff", border: "none", borderRadius: 16, fontSize: 14, fontWeight: 800, cursor: "pointer", display: "flex", alignItems: "center", gap: 10, boxShadow: `0 8px 28px ${C.purple}44` }}>
                    <Microscope size={17} /> Run Full Diabetes Check
                  </button>
                  <p style={{ margin: 0, fontSize: 12, color: C.textLight }}>All results pending clinician review</p>
                </div>
              </div>
            )}

            {/* ───── CLINICAL REPORT ───── */}
            {page === "report" && !report && (
              <div style={{ textAlign: "center", paddingTop: 80, animation: "slide-up 0.3s ease" }}>
                <div style={{ width: 68, height: 68, borderRadius: 22, background: C.heroGrad, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 18px", boxShadow: `0 10px 32px ${C.purple}55` }}>
                  <BarChart2 size={30} color="#fff" />
                </div>
                <p style={{ margin: "0 0 6px", fontSize: 18, fontWeight: 900 }}>No analysis run yet</p>
                <p style={{ margin: "0 0 22px", fontSize: 14, color: C.textMid }}>Upload reports or enter patient data, then run the analysis.</p>
                <button className="btn-primary" onClick={() => setPage("upload")}
                  style={{ padding: "10px 28px", background: C.heroGrad, color: "#fff", border: "none", borderRadius: 99, fontSize: 13, fontWeight: 800, cursor: "pointer", boxShadow: `0 4px 16px ${C.purple}44` }}>
                  Get Started
                </button>
              </div>
            )}

            {page === "report" && report && (() => {
              const sc = STAT_CFG[report.glycemic?.status] || { grad: C.heroGrad, label: "Pending", sub: "Enter patient data to generate" };
              const glcPct = (v, max) => Math.min(100, (parseFloat(v) / max) * 100);
              return (
                <div style={{ animation: "slide-up 0.3s ease" }}>

                  {/* Hero card — mirrors reference's large purple overview card */}
                  <Card gradient={sc.grad} style={{ marginBottom: 20, padding: "26px 28px" }}>
                    <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.1em" }}>Primary Diagnosis · {report.ts}</p>
                    <p style={{ margin: "0 0 4px", fontSize: 32, fontWeight: 900, color: "#fff", letterSpacing: "-0.03em" }}>{sc.label}</p>
                    <p style={{ margin: "0 0 22px", fontSize: 13, color: "rgba(255,255,255,0.6)" }}>{sc.sub}</p>
                    <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {[
                        { v: report.form.fpg  || "—", u: "mg/dL",   l: "FPG"    },
                        { v: report.form.hba1c|| "—", u: "%",       l: "HbA1c"  },
                        { v: report.form.egfr || "—", u: "mL/min",  l: "eGFR"   },
                        { v: report.form.bmi  || "—", u: "kg/m²",   l: "BMI"    },
                      ].map((s, i) => <BigStat key={i} value={s.v} unit={s.u} label={s.l} dark />)}
                    </div>
                    {report.glycemic?.discordant && <Alert type="warn">Discordant results — repeat higher-value test on separate day (ADA 2025 §2).</Alert>}
                  </Card>

                  {/* 3-column metrics grid */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 16 }}>

                    {/* Glycaemic */}
                    <Card>
                      <SHead>Glycaemic Results</SHead>
                      {report.glycemic?.results?.map((r, i) => {
                        const maxV = r.marker === "HbA1c" ? 12 : 300;
                        const col = r.category === "diabetes" ? C.red : r.category === "prediabetes" ? C.amber : C.green;
                        return <MetricRow key={i} label={r.marker} value={r.value} unit={r.marker === "HbA1c" ? "%" : "mg/dL"} pct={glcPct(r.value, maxV)} color={col} />;
                      })}
                      {!report.glycemic && <p style={{ color: C.textMid, fontSize: 13 }}>No values entered.</p>}
                    </Card>

                    {/* T1D */}
                    <Card>
                      <SHead>T1D Autoimmunity</SHead>
                      {!report.t1dStage
                        ? <Alert type="success">No autoantibodies detected.</Alert>
                        : <>
                            <p style={{ margin: "0 0 8px", fontSize: 16, fontWeight: 900, color: C.amber }}>{report.t1dStage} Detected</p>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 8 }}>
                              {report.t1dAbs.map(a => <Tag key={a} label={`${a} +`} color={C.amber} />)}
                            </div>
                            <Alert type="warn">Stage 2 may qualify for Teplizumab-mzwv — delays T1D onset ~2 years (ADA 2025 §1).</Alert>
                          </>}
                    </Card>

                    {/* Liver FIB-4 */}
                    <Card>
                      <SHead>Liver — FIB-4 Index</SHead>
                      {!report.fib4
                        ? <p style={{ color: C.textMid, fontSize: 12 }}>Enter age, AST, ALT, platelets to calculate.</p>
                        : <>
                            <MetricRow label="FIB-4 Score" value={report.fib4} unit="" pct={Math.min(100, (parseFloat(report.fib4) / 4) * 100)} color={report.fib4Risk === "high" ? C.red : report.fib4Risk === "intermediate" ? C.amber : C.green} />
                            <Alert type={report.fib4Risk === "high" ? "error" : report.fib4Risk === "intermediate" ? "warn" : "success"}>
                              {report.fib4Risk === "low" && "Low fibrosis risk — re-screen every 2–3 years (ADA 2025)."}
                              {report.fib4Risk === "intermediate" && "Intermediate — perform VCTE elastography (ADA 2025 §17)."}
                              {report.fib4Risk === "high" && "High risk — GI/Hepatology referral. Consider Tirzepatide."}
                            </Alert>
                          </>}
                    </Card>

                    {/* Kidney */}
                    <Card>
                      <SHead>Kidney — KDIGO 2023</SHead>
                      {!report.ckdData
                        ? <p style={{ color: C.textMid, fontSize: 12 }}>Enter eGFR for CKD staging.</p>
                        : <>
                            <MetricRow label="eGFR" value={report.form.egfr} unit="mL/min/1.73m²" pct={Math.min(100, parseFloat(report.form.egfr))} color={parseFloat(report.form.egfr) < 30 ? C.red : parseFloat(report.form.egfr) < 60 ? C.amber : C.green} />
                            {report.form.uacr && <MetricRow label="UACR" value={report.form.uacr} unit="mg/g" pct={Math.min(100, parseFloat(report.form.uacr) / 3)} color={parseFloat(report.form.uacr) >= 300 ? C.red : parseFloat(report.form.uacr) >= 30 ? C.amber : C.green} />}
                            <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                              <Tag label={`CKD ${report.ckdData.stage}`} color={C.purple} />
                              <Tag label={report.ckdData.albuminuria} color={C.blue} />
                            </div>
                            {report.ckdData.sglt2Indicated && <Alert type="info">SGLT2i indicated — eGFR 20–60 slows CKD progression (KDIGO 2023).</Alert>}
                          </>}
                    </Card>

                    {/* Heart */}
                    <Card>
                      <SHead>Cardiovascular</SHead>
                      {report.form.hf
                        ? <>
                            <MetricRow label="Heart Failure" value="Confirmed" unit="" color={C.red} />
                            {report.form.ntProBNP && <MetricRow label="NT-proBNP" value={report.form.ntProBNP} unit="pg/mL" pct={Math.min(100, parseFloat(report.form.ntProBNP) / 20)} color={C.red} />}
                            <Alert type="error">SGLT2i initiated regardless of glycaemic control for cardiac protection (ADA 2025 §5).</Alert>
                          </>
                        : <Alert type="success">No heart failure reported. Continue annual ASCVD assessment.</Alert>}
                    </Card>

                    {/* CGM */}
                    <Card>
                      <SHead>CGM / AGP Analysis</SHead>
                      {!report.form.avgGlucose && !report.form.tir
                        ? <p style={{ color: C.textMid, fontSize: 12 }}>No CGM data entered.</p>
                        : <>
                            {report.form.avgGlucose && <MetricRow label="Avg Glucose" value={report.form.avgGlucose} unit="mg/dL" color={C.purple} />}
                            {report.gmi && <MetricRow label="GMI (Est. A1c)" value={report.gmi} unit="%" pct={(parseFloat(report.gmi) / 12) * 100} color={parseFloat(report.gmi) >= 6.5 ? C.red : parseFloat(report.gmi) >= 5.7 ? C.amber : C.green} />}
                            {report.form.tir && <MetricRow label="Time in Range" value={report.form.tir} unit="%" pct={parseFloat(report.form.tir)} color={parseFloat(report.form.tir) >= 70 ? C.green : C.amber} />}
                            {report.form.tbr && <MetricRow label="Time Below Range" value={report.form.tbr} unit="%" pct={Math.min(100, parseFloat(report.form.tbr) * 10)} color={parseFloat(report.form.tbr) > 4 ? C.red : C.green} />}
                            {report.form.cv && <MetricRow label="Glucose CV" value={report.form.cv} unit="%" pct={(parseFloat(report.form.cv) / 50) * 100} color={parseFloat(report.form.cv) > 36 ? C.red : C.green} />}
                            {report.cgmAlerts.map((a, i) => <Alert key={i} type="error">{a}</Alert>)}
                          </>}
                    </Card>
                  </div>

                  {/* Treatment cards — like reference's bottom activity cards */}
                  <Card style={{ marginBottom: 14 }}>
                    <SHead>Treatment Recommendations · ADA 2025</SHead>
                    {report.treatment.length === 0
                      ? <p style={{ color: C.textMid, fontSize: 13 }}>No recommendations — enter glycaemic data first.</p>
                      : <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                          {report.treatment.map((r, i) => (
                            <div key={i} style={{ background: C.pageBg, borderRadius: 16, padding: "16px", border: `1px solid ${C.border}` }}>
                              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                                <div style={{ width: 36, height: 36, borderRadius: 11, background: C.purpleSoft, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                  <Pill size={16} color={C.purple} />
                                </div>
                                <Tag label={r.tag} color={C.purple} />
                              </div>
                              <p style={{ margin: "0 0 6px", fontSize: 13, fontWeight: 800, color: C.textDark }}>{r.drug}</p>
                              <p style={{ margin: "0 0 10px", fontSize: 12, color: C.textMid, lineHeight: 1.6 }}>{r.rationale}</p>
                              <Bar pct={60 + i * 8} color={C.purple} thin />
                              <p style={{ margin: "6px 0 0", fontSize: 10, fontWeight: 700, color: C.textLight, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pending Clinician Review</p>
                            </div>
                          ))}
                        </div>}
                  </Card>

                  <div style={{ display: "flex", gap: 9, alignItems: "center", padding: "11px 15px", background: C.card, borderRadius: 13, border: `1px solid ${C.border}` }}>
                    <Shield size={14} color={C.textMid} style={{ flexShrink: 0 }} />
                    <p style={{ margin: 0, fontSize: 12, color: C.textMid, lineHeight: 1.7 }}><strong style={{ color: C.textDark }}>Human-in-the-Loop:</strong> All suggestions pending clinician review. Grounded in ADA 2025, KDIGO 2023, and RSSDI guidelines.</p>
                  </div>
                </div>
              );
            })()}

            {/* ───── CHAT ───── */}
            {page === "chat" && (
              <div style={{ maxWidth: 760, animation: "slide-up 0.3s ease" }}>
                <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 900 }}>Ask the AI</p>
                <p style={{ margin: "0 0 18px", fontSize: 14, color: C.textMid }}>Ask about results, medications, guidelines, or lifestyle advice.</p>
                {report && (
                  <div style={{ display: "flex", gap: 9, alignItems: "center", marginBottom: 16, padding: "10px 15px", background: C.purpleSoft, borderRadius: 13, border: `1px solid ${C.purple}22` }}>
                    <Shield size={14} color={C.purple} />
                    <span style={{ fontSize: 12, color: C.purple, fontWeight: 700 }}>Context loaded — {report.form?.name || "Anonymous"} · {report.glycemic?.status || "pending"}</span>
                  </div>
                )}
                <Card><ChatPanel report={report} form={form} /></Card>
              </div>
            )}

            {/* ───── PATIENT SUMMARY ───── */}
            {page === "patient" && (
              <div style={{ maxWidth: 700, animation: "slide-up 0.3s ease" }}>
                <p style={{ margin: "0 0 4px", fontSize: 22, fontWeight: 900 }}>Patient Summary</p>
                <p style={{ margin: "0 0 20px", fontSize: 14, color: C.textMid }}>Plain-language summary at 8th grade reading level — review before sharing with patient.</p>

                {!report
                  ? <Card><p style={{ color: C.textMid }}>Run an analysis first to generate the summary.</p></Card>
                  : <>
                      cd "c:/java/java vs code/practice/diabetes-check-ai"
                      git init
                      <Card gradient={C.heroGrad} style={{ marginBottom: 16, padding: "24px 26px" }}>
                        <p style={{ margin: "0 0 2px", fontSize: 10, fontWeight: 800, color: "rgba(255,255,255,0.5)", textTransform: "uppercase", letterSpacing: "0.1em" }}>For Patient · Plain Language</p>
                        <p style={{ margin: "0 0 16px", fontSize: 17, fontWeight: 900, color: "#fff" }}>{report.form.name || "Patient"}</p>
                        <div style={{ background: "rgba(255,255,255,0.13)", borderRadius: 14, padding: "16px 18px", fontSize: 14, color: "#fff", lineHeight: 1.9, whiteSpace: "pre-line" }}>
                          {report.glycemic?.status === "normal" && "Your blood sugar levels look healthy. Keep up your current lifestyle to maintain this.\n\n"}
                          {report.glycemic?.status === "prediabetes" && "Your blood sugar is slightly elevated — this is called prediabetes. With healthier eating and regular walking, many people bring it back to normal.\n\n"}
                          {report.glycemic?.status === "diabetes" && "Your blood sugar levels suggest diabetes. With the right treatment and care, many people with diabetes live full and healthy lives.\n\n"}
                          {report.fib4Risk && report.fib4Risk !== "low" && "A liver test showed some concern. Your doctor may request a special scan to look more closely.\n\n"}
                          {report.ckdData && report.ckdData.stage !== "G1" && "Your kidneys may need extra attention. Your doctor will monitor them regularly.\n\n"}
                          {"Next steps: Share these results with your doctor for a personalised care plan."}
                        </div>
                      </Card>

                      <Card>
                        <SHead>Risk Factor Overview</SHead>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                          {[
                            ["Family History",         report.form.familyHistory],
                            ["Hypertension",           report.form.htn],
                            ["ASCVD",                  report.form.ascvd],
                            ["Heart Failure",          report.form.hf],
                            ["GAD65 Antibody",         report.form.gad65],
                            ["IA-2 Antibody",          report.form.ia2],
                            ["ZnT8 Antibody",          report.form.znt8],
                            ["Polyuria / Polydipsia",  report.form.polyuria || report.form.polydipsia],
                          ].map(([l, v]) => (
                            <div key={l} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 13px", background: v ? C.redSoft : C.greenSoft, borderRadius: 12, border: `1px solid ${v ? C.red + "22" : C.green + "33"}` }}>
                              <span style={{ fontSize: 13, color: C.textDark, fontWeight: 500 }}>{l}</span>
                              <Tag label={v ? "Yes" : "No"} color={v ? C.red : C.green} />
                            </div>
                          ))}
                        </div>
                      </Card>
                    </>}
              </div>
            )}

          </div>{/* end page content */}
        </div>{/* end main area */}
      </div>{/* end root */}
    </>
  );
}