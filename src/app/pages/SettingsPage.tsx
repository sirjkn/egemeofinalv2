import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  ArrowLeft, FileSpreadsheet, Wrench, UploadCloud, Download, CreditCard,
  CheckCircle, XCircle, X, Loader2, RefreshCw,
  AlertCircle, CheckCircle2, SlidersHorizontal, KeyRound, ClipboardPaste,
  Building2, Users, UserCircle2, ChevronDown, ChevronRight,
  HelpCircle, Home, Link2, Search, RotateCcw, ShieldCheck, Lock, BadgeCheck,
  MessageSquare, Bell, Eye, EyeOff, Phone, Database, Settings2, Cloud, Trash2,
  Activity, Filter, LogIn, CreditCard as PayIcon, Edit2, Trash as TrashIcon,
  UserPlus, BarChart2, Map, RefreshCcw, BellRing, ShieldAlert, Camera, LayoutDashboard,
  BookOpen, FileDown,
} from "lucide-react";
import {
  shareholdersApi, clientsApi, contributionsApi, checkDbHealth,
  activityLogApi, type ActivityLog, type ActivityCategory,
  type Shareholder, type PaymentPayload, PAYMENT_PURPOSES, PAYMENT_MODES,
  uploadPhoto, plotsApi, plotPaymentsApi, type PlotPayment, type Plot,
} from "@/lib/api";
import { supabase } from "@/lib/supabase";
import { fmtKES, fmtDate, MONTHS } from "@/app/shared";
import { getCompanyDetails, saveCompanyDetails, type CompanyDetails } from "@/lib/company";
import { downloadSystemGuidePdf } from "@/lib/pdf";
import { getPaymentSettings, type PaymentSettings } from "@/lib/mpesa";
import { loadPaymentSettingsFromDb, savePaymentSettingsToDb, loadSmsSettingsFromDb, saveSmsSettingsToDb } from "@/lib/settingsApi";
import { getSmsSettings, saveSmsSettings, mergeSmsSettings, sendSms, SMS_TRIGGERS, DEFAULT_TEMPLATES, interpolate, type SmsSettings } from "@/lib/sms";
import { useImpersonation } from "@/lib/impersonation";
import type { UserProfile } from "@/app/pages/AuthPage";
import { useNavigate } from "react-router";

// ─── Settings ─────────────────────────────────────────────────────────────────

// CSV utility helpers

function parseCsvText(raw: string): string[][] {
  const lines = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') { if (inQ && line[i + 1] === '"') { cur += '"'; i++; } else inQ = !inQ; }
      else if (c === "," && !inQ) { cells.push(cur.trim()); cur = ""; }
      else cur += c;
    }
    cells.push(cur.trim());
    return cells;
  });
}

function triggerCsvDownload(filename: string, rows: string[][]) {
  const text = rows.map((r) => r.join(",")).join("\n");
  const blob = new Blob([text], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

interface ImportRow {
  idx: number;
  data: Record<string, string>;
  errors: string[];
  status: "pending" | "importing" | "success" | "error";
  msg?: string;
}

function normalizeImportPhone(phone: string): string {
  let p = phone.trim().replace(/[\s\-\(\)]/g, "").replace(/^\+/, "");
  if (!p) return p;
  if (p.startsWith("254") && p.length === 12) return "+" + p; // 254XXXXXXXXX → +254XXXXXXXXX
  if (p.startsWith("0") && p.length === 10) return "+254" + p.slice(1); // 07XXXXXXXX → +2547XXXXXXXX
  if (p.startsWith("7") && p.length === 9) return "+254" + p; // 7XXXXXXXX → +2547XXXXXXXX
  return "+" + p;
}

function validateImportPhone(phone: string): string | null {
  if (!phone.trim()) return "Phone required";
  return null;
}

// ─── Upload Section ───────────────────────────────────────────────────────────

const SHAREHOLDER_COLS = ["member_number", "name", "phone"];
const CLIENT_COLS = ["member_number", "name", "phone"];

interface UploadSectionProps {
  type: "shareholders" | "clients";
  accentColor: string;
  iconBg: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  onImport: (rows: ImportRow[], setRows: React.Dispatch<React.SetStateAction<ImportRow[] | null>>) => Promise<void>;
}

function UploadSection({ type, accentColor, iconBg, icon, title, subtitle, onImport }: UploadSectionProps) {
  const [expanded, setExpanded] = useState(true);
  const [inputMode, setInputMode] = useState<"csv" | "paste">("csv");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const cols = type === "shareholders" ? SHAREHOLDER_COLS : CLIENT_COLS;

  const handleTemplate = () => {
    const sample = ["1", "Jane Wanjiku", "0712345678"];
    triggerCsvDownload(`${type}_template.csv`, [cols, sample]);
  };

  // Shared row builder used by both CSV and paste paths
  const buildRows = (rawRows: string[][], headerRow: string[]): ImportRow[] => {
    const dataRows = rawRows.filter((r) => r.some((c) => c.trim()));
    return dataRows.map((r, idx) => {
      const data: Record<string, string> = {};
      cols.forEach((col) => {
        const hi = headerRow.indexOf(col);
        // also try matching by position if header not found (paste without header)
        data[col] = hi >= 0 ? (r[hi] ?? "") : (r[cols.indexOf(col)] ?? "");
      });
      // Strip # prefix from member_number (e.g. "#2" → "2")
      if (data["member_number"]) data["member_number"] = data["member_number"].replace(/^#/, "").trim();
      if (data["phone"]) data["phone"] = normalizeImportPhone(data["phone"]);
      const errors: string[] = [];
      if (!data["name"]?.trim()) errors.push("Name is required");
      if (type === "clients") {
        const phoneErr = validateImportPhone(data["phone"] ?? "");
        if (phoneErr) errors.push(phoneErr);
      }
      // Shareholders: phone is fully optional — no validation
      return { idx, data, errors, status: "pending" as const };
    });
  };

  const processFile = (file: File) => {
    if (!file.name.endsWith(".csv")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const allRows = parseCsvText(text);
      if (allRows.length < 2) return;
      const headerRow = allRows[0].map((h) => h.toLowerCase().replace(/[\s_]+/g, "_"));
      setRows(buildRows(allRows.slice(1), headerRow));
    };
    reader.readAsText(file);
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) processFile(file);
    e.target.value = "";
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const handlePasteParse = () => {
    setPasteError("");
    const text = pasteText.trim();
    if (!text) { setPasteError("Nothing to parse — paste your data first."); return; }

    // Detect separator: tab (Excel/Sheets copy) or comma
    const firstLine = text.split("\n")[0];
    const sep = firstLine.includes("\t") ? "\t" : ",";

    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
    const splitLine = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));

    const firstRow = splitLine(lines[0]).map((h) => h.toLowerCase().replace(/[\s_]+/g, "_"));

    // Check if first row looks like a header (contains "name" or "phone")
    const hasHeader = firstRow.some((h) => ["name", "phone", "member_number"].includes(h));
    const headerRow = hasHeader ? firstRow : cols;
    const dataLines = hasHeader ? lines.slice(1) : lines;

    const rawRows = dataLines.map(splitLine);
    const parsed = buildRows(rawRows, headerRow);
    if (parsed.length === 0) { setPasteError("Could not detect any rows — check your data."); return; }
    setRows(parsed);
  };

  const switchMode = (mode: "csv" | "paste") => {
    setInputMode(mode);
    setRows(null);
    setPasteText("");
    setPasteError("");
  };

  const validRows = rows?.filter((r) => r.errors.length === 0) ?? [];
  const errorRows = rows?.filter((r) => r.errors.length > 0) ?? [];

  const handleImport = async () => {
    if (!rows || validRows.length === 0) return;
    setImporting(true);
    await onImport(validRows, setRows);
    setImporting(false);
  };

  const successCount = rows?.filter((r) => r.status === "success").length ?? 0;
  const errorCount  = rows?.filter((r) => r.status === "error").length ?? 0;
  const allDone = rows !== null && rows.every((r) => r.status === "success" || r.status === "error");

  return (
    <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: iconBg }}>
          <span style={{ color: accentColor }}>{icon}</span>
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-sm" style={{ color: "#1a202c" }}>{title}</h3>
          <p className="text-xs text-gray-400">{subtitle}</p>
        </div>
        <button onClick={handleTemplate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors hover:opacity-80"
          style={{ borderColor: accentColor, color: accentColor }}>
          <Download size={12} /> Template
        </button>
        <button onClick={() => setExpanded((v) => !v)} className="p-1 text-gray-400 hover:text-gray-600">
          <ChevronDown size={16} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </button>
      </div>

      {expanded && (
        <div className="px-5 pb-5 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>

          {/* Mode tabs */}
          <div className="flex gap-1 mt-3 p-1 rounded-lg" style={{ background: "#f1f5f9" }}>
            {([["csv", "Upload CSV"], ["paste", "Paste Data"]] as const).map(([mode, label]) => (
              <button key={mode} onClick={() => switchMode(mode)}
                className="flex-1 py-1.5 rounded-md text-xs font-semibold transition-all"
                style={{
                  background: inputMode === mode ? "#fff" : "transparent",
                  color: inputMode === mode ? "#1a202c" : "#64748b",
                  boxShadow: inputMode === mode ? "0 1px 3px rgba(0,0,0,0.1)" : "none",
                }}>
                {label}
              </button>
            ))}
          </div>

          <p className="text-xs text-gray-400">
            <span className="font-semibold text-gray-500">Columns:</span> {cols.join(", ")}
            {" · "}
            {inputMode === "paste"
              ? "Copy cells from Excel or Google Sheets and paste below"
              : "member_number is optional — auto-assigned if blank"}
          </p>

          {/* CSV drop zone */}
          {inputMode === "csv" && !rows && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileRef.current?.click()}
              className="rounded-xl border-2 border-dashed flex flex-col items-center justify-center py-10 cursor-pointer transition-colors"
              style={{ borderColor: dragOver ? accentColor : "#cbd5e1", background: dragOver ? `${accentColor}08` : "#fafbfc" }}>
              <UploadCloud size={28} style={{ color: dragOver ? accentColor : "#94a3b8" }} />
              <p className="mt-2 text-sm font-semibold" style={{ color: dragOver ? accentColor : "#64748b" }}>Click to upload CSV</p>
              <p className="text-xs text-gray-400 mt-0.5">Supports .csv files only</p>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={handleFileInput} />

          {/* Paste area */}
          {inputMode === "paste" && !rows && (
            <div className="space-y-2">
              <textarea
                value={pasteText}
                onChange={(e) => { setPasteText(e.target.value); setPasteError(""); }}
                onPaste={(e) => {
                  // Read clipboard text synchronously before React nullifies currentTarget
                  const pasted = e.clipboardData.getData("text");
                  if (pasted.trim()) setPasteText(pasted);
                }}
                placeholder={"Paste data here — copied from Excel or Google Sheets\n\nExample:\n1\tJane Wanjiku\t0712345678\n2\tJohn Kamau\t0723456789"}
                rows={8}
                className="w-full px-3 py-3 rounded-xl text-xs font-mono border outline-none resize-y transition-colors"
                style={{ borderColor: pasteError ? "#ef4444" : "var(--border)", background: "#fafbfc", lineHeight: 1.6 }}
              />
              {pasteError && <p className="text-xs text-red-500">{pasteError}</p>}
              <button
                onClick={handlePasteParse}
                disabled={!pasteText.trim()}
                className="w-full py-2.5 rounded-xl text-sm font-bold flex items-center justify-center gap-2 disabled:opacity-40 transition-opacity"
                style={{ background: accentColor, color: "#fff" }}>
                Preview Data
              </button>
            </div>
          )}

          {/* Preview table */}
          {rows && rows.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {validRows.length > 0 && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-green-600">
                      <CheckCircle size={13} /> {validRows.length} valid
                    </span>
                  )}
                  {errorRows.length > 0 && (
                    <span className="flex items-center gap-1 text-xs font-semibold text-red-500">
                      <XCircle size={13} /> {errorRows.length} errors
                    </span>
                  )}
                </div>
                <button onClick={() => { setRows(null); if (inputMode === "paste") setPasteText(""); }} className="text-xs text-gray-400 hover:text-gray-600 underline">Clear</button>
              </div>

              <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
                <div className="overflow-x-auto max-h-52 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ background: "#1e3a5f" }}>
                        <th className="px-3 py-2 text-left font-semibold text-white">#</th>
                        {cols.slice(0, 5).map((c) => (
                          <th key={c} className="px-3 py-2 text-left font-semibold text-white whitespace-nowrap">{c}</th>
                        ))}
                        <th className="px-3 py-2 text-left font-semibold text-white">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.idx}
                          style={{ background: row.status === "success" ? "#f0fdf4" : row.status === "error" ? "#fef2f2" : row.errors.length ? "#fef2f2" : "white" }}
                          className="border-t"
                        >
                          <td className="px-3 py-2 text-gray-400">{row.idx + 1}</td>
                          {cols.slice(0, 5).map((c) => (
                            <td key={c} className="px-3 py-2 whitespace-nowrap" style={{ color: "#374151" }}>{row.data[c] || <span className="text-gray-300">—</span>}</td>
                          ))}
                          <td className="px-3 py-2">
                            {row.status === "success" && <span className="text-green-600 font-semibold flex items-center gap-1"><CheckCircle size={11} /> Imported</span>}
                            {row.status === "error" && <span className="text-red-500 font-semibold text-xs">{row.msg || "Failed"}</span>}
                            {row.status === "importing" && <Loader2 size={11} className="animate-spin text-gray-400" />}
                            {row.status === "pending" && row.errors.length > 0 && (
                              <span className="text-red-500 text-xs">{row.errors[0]}</span>
                            )}
                            {row.status === "pending" && row.errors.length === 0 && (
                              <span className="text-green-500 text-xs font-semibold">Ready</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Import button / results */}
              {allDone ? (
                <div className="flex items-center justify-between p-3 rounded-xl" style={{ background: successCount > 0 ? "#f0fdf4" : "#fef2f2" }}>
                  <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: successCount > 0 ? "#16a34a" : "#dc2626" }}>
                    <CheckCircle size={16} /> {successCount} imported{errorCount > 0 ? `, ${errorCount} failed` : " successfully"}
                  </div>
                  <button onClick={() => { setRows(null); setPasteText(""); }} className="text-xs font-semibold text-gray-500 hover:text-gray-700 underline">Start over</button>
                </div>
              ) : (
                <button
                  onClick={handleImport}
                  disabled={importing || validRows.length === 0}
                  className="w-full py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50 transition-opacity"
                  style={{ background: accentColor }}>
                  {importing ? <><Loader2 size={14} className="animate-spin" /> Importing…</> : `Import ${validRows.length} record${validRows.length !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function QuickSyncBanner() {
  const [syncing, setSyncing] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const run = async () => {
    setSyncing(true); setDone(null);
    try {
      const { updated, errors } = await recalcNetSavings();
      setDone(`Net savings recalculated for ${updated} shareholders.${errors > 0 ? ` (${errors} failed)` : ""}`);
    } catch (err: any) {
      setDone(`Error: ${err.message}`);
    } finally { setSyncing(false); }
  };

  return (
    <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
      <RefreshCw size={14} color="#16a34a" className="flex-shrink-0" />
      <div className="flex-1 text-xs" style={{ color: "#166534" }}>
        {done ?? "After uploading contributions, sync net savings to reflect the new totals."}
      </div>
      <button onClick={run} disabled={syncing}
        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60 hover:opacity-90"
        style={{ background: "#16a34a" }}>
        {syncing ? <><Loader2 size={11} className="animate-spin" /> Syncing…</> : "Sync Net Savings"}
      </button>
    </div>
  );
}

function DropContributionsUniqueButton() {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const run = async () => {
    setRunning(true); setDone(null);
    try {
      const { data, error } = await supabase.functions.invoke("db-admin", {
        body: { action: "drop_contributions_unique" },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Failed");
      const dropped = (data.dropped as string[]) ?? [];
      setDone({ type: "ok", text: `Done! Removed: ${dropped.join(", ") || "none found (already removed)"}. Multiple contributions per month now allowed.` });
    } catch (e: any) {
      setDone({ type: "err", text: e.message });
    } finally { setRunning(false); }
  };

  return (
    <div className="rounded-xl px-4 py-3 flex items-start gap-3" style={{ background: "#fef9c3", border: "1px solid #fde68a" }}>
      <AlertCircle size={14} color="#92400e" className="flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-xs space-y-1">
        <p style={{ color: "#92400e" }}>
          {done?.text ?? "Allow multiple contributions per month by removing the unique DB constraint."}
        </p>
        {done?.type === "ok" && <p className="text-green-700 font-semibold">✓ Done — members can now make multiple contributions per month and per day.</p>}
        {done?.type === "err" && <p className="text-red-600 font-semibold">Error: {done.text}</p>}
      </div>
      {done?.type !== "ok" && (
        <button onClick={run} disabled={running}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60"
          style={{ background: "#d97706" }}>
          {running ? <><Loader2 size={11} className="animate-spin" /> Fixing…</> : "Fix Now"}
        </button>
      )}
    </div>
  );
}

function SyncPlotPaidAmountsButton() {
  const [syncing, setSyncing] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const run = async () => {
    setSyncing(true); setDone(null);
    try {
      const fixed = await plotsApi.syncAllPaidAmounts();
      setDone(`Plot paid amounts recalculated for ${fixed} plot${fixed !== 1 ? "s" : ""}.`);
    } catch (err: any) {
      setDone(`Error: ${err.message}`);
    } finally { setSyncing(false); }
  };

  return (
    <div className="rounded-xl px-4 py-3 flex items-center gap-3" style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
      <RefreshCw size={14} color="#2563eb" className="flex-shrink-0" />
      <div className="flex-1 text-xs" style={{ color: "#1e40af" }}>
        {done ?? "Recalculates each plot's Paid Amount from actual payment records — fixes totals that were capped at the plot price."}
      </div>
      <button onClick={run} disabled={syncing}
        className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60 hover:opacity-90"
        style={{ background: "#2563eb" }}>
        {syncing ? <><Loader2 size={11} className="animate-spin" /> Syncing…</> : "Sync Plot Totals"}
      </button>
    </div>
  );
}

// ─── Data Upload Page ─────────────────────────────────────────────────────────

const CONTRIBUTION_COLS = ["month", "date_paid", "amount"];

// Parses many date formats → "YYYY-MM-DD" string, or "" on failure.
// Handles: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, "3 May 2026", "May 3 2026", "3 May", etc.
// DD/MM/YYYY is the primary numeric format (Kenyan/East African standard).
function parseDateToISO(raw: string): string {
  if (!raw.trim()) return "";

  // Already ISO: YYYY-MM-DD
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw.trim())) {
    const [y, m, d] = raw.trim().split("-").map(Number);
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // DD/MM/YYYY or DD-MM-YYYY (first number = day, second = month — East African standard)
  const dmy = raw.trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
  if (dmy) {
    const [, d, m, y] = dmy.map(Number);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31)
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // DD-Mon-YY or DD-Mon-YYYY (e.g. "09-Sept-21", "09-Sep-2021")
  const dmy2 = raw.trim().match(/^(\d{1,2})[-\/\s]([A-Za-z]+)[-\/\s](\d{2,4})$/);
  if (dmy2) {
    const d = parseInt(dmy2[1]);
    const mIdx = MONTHS.findIndex((mn) => mn.toLowerCase() === dmy2[2].slice(0, 3).toLowerCase());
    const rawY = parseInt(dmy2[3]);
    const y = rawY < 100 ? 2000 + rawY : rawY;
    if (mIdx >= 0)
      return `${y}-${String(mIdx + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  // "3 May 2026" or "May 3 2026" or "3 May" (no year → current year)
  const named = raw.trim().match(/^(\d{1,2})\s+([A-Za-z]+)\s*(\d{4})?$/) ||
                raw.trim().match(/^([A-Za-z]+)\s+(\d{1,2})\s*,?\s*(\d{4})?$/);
  if (named) {
    const isNameFirst = /^[A-Za-z]/.test(raw.trim());
    const dayStr  = isNameFirst ? named[2] : named[1];
    const monStr  = isNameFirst ? named[1] : named[2];
    const yearStr = named[3];
    const mIdx = MONTHS.findIndex((mn) => mn.toLowerCase() === monStr.slice(0, 3).toLowerCase());
    if (mIdx >= 0) {
      const d = parseInt(dayStr);
      const m = mIdx + 1;
      const y = yearStr ? parseInt(yearStr) : new Date().getFullYear();
      return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }

  return "";
}
const PAYMENT_UPLOAD_COLS = ["date", "amount", "paid_by", "notes"];

function PaymentsUploadSection() {
  const [expanded, setExpanded] = useState(true);
  const [inputMode, setInputMode] = useState<"csv" | "paste">("csv");
  const [rows, setRows] = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const updateRow = (idx: number, patch: Partial<ImportRow>) =>
    setRows((prev) => prev ? prev.map((r) => r.idx === idx ? { ...r, ...patch } : r) : prev);

  const buildRows = (data: string[][], header: string[]): ImportRow[] =>
    data.filter((r) => r.some((c) => c.trim())).map((cols, i) => {
      const obj: Record<string, string> = {};
      header.forEach((h, j) => { obj[h] = cols[j]?.trim() ?? ""; });
      const errors: string[] = [];
      const rawDate = obj["date"] || obj["date_paid"] || "";
      const parsed = parseDateToISO(rawDate);
      if (!parsed) errors.push("invalid date");
      const amt = parseFloat((obj["amount"] || "").replace(/,/g, ""));
      if (isNaN(amt) || amt < 0) errors.push("invalid amount");
      if (!obj["paid_by"]?.trim()) errors.push("paid_by required");
      return { idx: i, data: { ...obj, _parsedDate: parsed }, errors, status: "pending" };
    });

  const splitLine = (line: string, sep: string): string[] => {
    if (sep === "\t") return line.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
    const result: string[] = [];
    let cur = ""; let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; }
      else if (ch === "," && !inQ) { result.push(cur.trim()); cur = ""; }
      else { cur += ch; }
    }
    result.push(cur.trim());
    return result;
  };

  const parse = (text: string) => {
    const firstLine = text.split("\n")[0];
    const sep = firstLine.includes("\t") ? "\t" : ",";
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n").filter(Boolean);
    const split = (l: string) => splitLine(l, sep);
    const firstRow = splitLine(lines[0], sep).map((h) => h.toLowerCase().replace(/[\s\/\-]+/g, "_"));
    const hasHeader = firstRow.some((h) => ["date", "date_paid", "amount", "paid_by", "notes"].includes(h));
    const header = hasHeader ? firstRow : PAYMENT_UPLOAD_COLS;
    const parsed = buildRows((hasHeader ? lines.slice(1) : lines).map(split), header);
    if (parsed.length === 0) { setPasteError("No rows detected."); return; }
    setRows(parsed);
    setPasteError("");
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { if (ev.target?.result) parse(ev.target.result as string); };
    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { if (ev.target?.result) parse(ev.target.result as string); };
    reader.readAsText(file);
  };

  const handleImport = async () => {
    if (!rows) return;
    const valid = rows.filter((r) => r.errors.length === 0 && r.status === "pending");
    setImporting(true);
    for (const row of valid) {
      updateRow(row.idx, { status: "importing" });
      try {
        const amount = parseFloat((row.data["amount"] || "").replace(/,/g, ""));
        const notes = row.data["notes"]?.trim() || "";
        const rawDate = row.data["date"] || row.data["date_paid"] || "";
        const datePaid = parseDateToISO(rawDate) || row.data["_parsedDate"] || "";
        if (!datePaid) { updateRow(row.idx, { status: "error", msg: "Could not parse date" }); continue; }
        updateRow(row.idx, { status: "success" });
      } catch (err: any) {
        updateRow(row.idx, { status: "error", msg: err.message });
      }
    }
    setImporting(false);
  };

  const successCount = rows?.filter((r) => r.status === "success").length ?? 0;
  const errorCount   = rows?.filter((r) => r.status === "error").length ?? 0;
  const validRows    = rows?.filter((r) => r.errors.length === 0) ?? [];

  return (
    <div className="rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      <button onClick={() => setExpanded((v) => !v)} className="w-full flex items-center gap-3 px-5 py-4 hover:bg-gray-50 transition-colors">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#f0fdfa" }}>
          <CreditCard size={18} color="#14b8a6" />
        </div>
        <div className="flex-1 text-left">
          <h3 className="font-bold text-sm" style={{ color: "#1a202c" }}>Payments Upload</h3>
          <p className="text-xs text-gray-400">Columns: Date, Amount, Paid By, Notes</p>
        </div>
        <ChevronDown size={16} className={`text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`} />
      </button>

      {expanded && (
        <div className="border-t px-5 pb-5 pt-4 space-y-4" style={{ borderColor: "var(--border)" }}>
          {/* Template */}
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-500">Accepted date formats: <span className="font-mono">09-Sept-21 · 2025-01-04 · 3 May 2026</span></p>
            <button onClick={() => triggerCsvDownload("payments_template.csv", [
              ["Date", "Amount", "Paid By", "Notes"],
              ["09-Sept-21", "100000", "Jane Doe", "Mpesa"],
              ["10-Sept-21", "5000", "Jane Doe", "Mpesa"],
            ])}
              className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg hover:opacity-80"
              style={{ background: "#f0fdfa", color: "#0d9488" }}>
              <Download size={12} /> Template
            </button>
          </div>

          {/* Mode tabs */}
          <div className="flex gap-1 p-1 rounded-lg" style={{ background: "#f1f5f9" }}>
            {([["csv", "Upload CSV"], ["paste", "Paste Data"]] as const).map(([m, label]) => (
              <button key={m} onClick={() => { setInputMode(m); setRows(null); setPasteText(""); setPasteError(""); }}
                className={`flex-1 py-1.5 rounded-md text-xs font-semibold transition-all ${inputMode === m ? "bg-white shadow-sm" : "text-gray-500 hover:text-gray-700"}`}
                style={inputMode === m ? { color: "#14b8a6" } : {}}>
                {label}
              </button>
            ))}
          </div>

          {/* CSV drop zone */}
          {inputMode === "csv" && !rows && (
            <div onClick={() => fileRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)} onDrop={handleDrop}
              className="border-2 border-dashed rounded-xl py-8 text-center cursor-pointer transition-all"
              style={{ borderColor: dragOver ? "#14b8a6" : "#cbd5e1", background: dragOver ? "#f0fdfa" : "#fafafa" }}>
              <UploadCloud size={22} className="mx-auto mb-2 text-gray-300" />
              <p className="text-xs font-semibold text-gray-500">Drop CSV file here or <span style={{ color: "#14b8a6" }}>browse</span></p>
              <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={handleFileInput} />
            </div>
          )}

          {/* Paste zone */}
          {inputMode === "paste" && !rows && (
            <div className="space-y-2">
              <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} rows={6}
                placeholder={"Date\tAmount\tPaid By\tNotes\n09-Sept-21\t100,000\tJane Doe\tMpesa\n10-Sept-21\t5,000\tJane Doe\tMpesa"}
                className="w-full border rounded-xl p-3 text-xs font-mono resize-none focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
              {pasteError && <p className="text-xs text-red-500">{pasteError}</p>}
              <button onClick={() => parse(pasteText)} className="px-4 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#14b8a6" }}>
                Parse Data
              </button>
            </div>
          )}

          {/* Preview table */}
          {rows && (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs text-gray-500">{validRows.length} valid · {rows.length - validRows.length} errors</p>
                <div className="flex gap-2 items-center">
                  <button onClick={() => { setRows(null); setPasteText(""); }} className="text-xs px-3 py-1.5 rounded-lg border font-semibold hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Clear</button>
                  {successCount > 0 && <span className="text-xs font-bold text-green-600">{successCount} imported ✓</span>}
                  {errorCount > 0 && <span className="text-xs font-bold text-red-500">{errorCount} failed</span>}
                </div>
              </div>
              <div className="rounded-xl border overflow-auto max-h-64" style={{ borderColor: "var(--border)" }}>
                <table className="w-full text-xs min-w-[420px]">
                  <thead style={{ background: "#1e3a5f" }}>
                    <tr>{["Date", "Amount (KES)", "Paid By", "Notes", "Status"].map((h) => (
                      <th key={h} className="px-3 py-2 text-left text-[10px] font-semibold text-white uppercase whitespace-nowrap">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={r.idx} className="border-t" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                        <td className="px-3 py-2 whitespace-nowrap">{r.data["_parsedDate"] || <span className="text-red-400">{r.data["date"] || r.data["date_paid"] || "—"}</span>}</td>
                        <td className="px-3 py-2 font-semibold" style={{ color: "#059669" }}>{Number((r.data["amount"] || "0").replace(/,/g, "")).toLocaleString("en-US")}</td>
                        <td className="px-3 py-2">{r.data["paid_by"] || "—"}</td>
                        <td className="px-3 py-2 text-gray-500 max-w-[120px] truncate">{r.data["notes"] || "—"}</td>
                        <td className="px-3 py-2">
                          {r.errors.length > 0 && <span className="text-red-500 font-semibold text-[10px]">{r.errors.join(", ")}</span>}
                          {r.status === "importing" && <Loader2 size={10} className="animate-spin text-teal-500" />}
                          {r.status === "success"   && <span className="text-green-600 font-bold">✓</span>}
                          {r.status === "error"     && <span className="text-red-500 font-semibold text-[10px]">{r.msg}</span>}
                          {r.status === "pending" && r.errors.length === 0 && <span className="text-gray-400">Ready</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {validRows.some((r) => r.status === "pending") && (
                <button onClick={handleImport} disabled={importing}
                  className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
                  style={{ background: "#14b8a6" }}>
                  {importing ? <><Loader2 size={14} className="animate-spin" /> Importing…</> : `Import ${validRows.filter(r => r.status === "pending").length} Payment${validRows.filter(r => r.status === "pending").length !== 1 ? "s" : ""}`}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ContributionsUploadSection({ shareholders }: { shareholders: Shareholder[] }) {
  const [expanded, setExpanded]   = useState(true);
  const [selectedId, setSelectedId] = useState<number | "">("");
  const [inputMode, setInputMode] = useState<"csv" | "paste">("csv");
  const [rows, setRows]           = useState<ImportRow[] | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver]   = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [pasteError, setPasteError] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const updateRow = (idx: number, patch: Partial<ImportRow>) =>
    setRows((prev) => prev ? prev.map((r) => r.idx === idx ? { ...r, ...patch } : r) : prev);

  const buildRows = (rawRows: string[][], headerRow: string[]): ImportRow[] => {
    return rawRows.filter((r) => r.some((c) => c.trim())).map((r, idx) => {
      const data: Record<string, string> = {};
      CONTRIBUTION_COLS.forEach((col) => {
        const hi = headerRow.indexOf(col);
        data[col] = hi >= 0 ? (r[hi] ?? "") : (r[CONTRIBUTION_COLS.indexOf(col)] ?? "");
      });
      const errors: string[] = [];
      const rawM = data["month"]?.trim() ?? "";
      let mNum = NaN;
      const ym = rawM.match(/^(\d{4})-(\d{1,2})$/);
      if (ym) mNum = parseInt(ym[2]);
      else if (/^\d{1,2}$/.test(rawM)) mNum = parseInt(rawM);
      else { const i = MONTHS.findIndex((m) => m.toLowerCase() === rawM.slice(0,3).toLowerCase()); if (i >= 0) mNum = i + 1; }
      if (!rawM) errors.push("Month is required");
      else if (isNaN(mNum) || mNum < 1 || mNum > 12) errors.push(`Invalid month "${rawM}"`);
      if (!data["date_paid"]?.trim()) errors.push("Date Paid is required");
      const rawAmt = data["amount"]?.trim() ?? "";
      if (rawAmt !== "" && isNaN(parseFloat(rawAmt))) errors.push("Amount must be a number");
      return { idx, data, errors, status: "pending" as const };
    });
  };

  const processFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const allRows = parseCsvText(text);
      if (allRows.length < 2) return;
      const header = allRows[0].map((h) => h.toLowerCase().replace(/[\s\/]+/g, "_"));
      setRows(buildRows(allRows.slice(1), header));
    };
    reader.readAsText(file);
  };

  const handlePasteParse = () => {
    setPasteError("");
    const text = pasteText.trim();
    if (!text) { setPasteError("Nothing to parse — paste your data first."); return; }
    const firstLine = text.split("\n")[0];
    const sep = firstLine.includes("\t") ? "\t" : ",";
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n");
    const split = (l: string) => l.split(sep).map((c) => c.trim().replace(/^"|"$/g, ""));
    const firstRow = split(lines[0]).map((h) => h.toLowerCase().replace(/[\s\/]+/g, "_"));
    const hasHeader = firstRow.some((h) => ["month","date_paid","amount"].includes(h));
    const header = hasHeader ? firstRow : CONTRIBUTION_COLS;
    const parsed = buildRows((hasHeader ? lines.slice(1) : lines).map(split), header);
    if (parsed.length === 0) { setPasteError("No rows detected."); return; }
    setRows(parsed);
  };

  const handleImport = async () => {
    if (!selectedId || !rows) return;
    const valid = rows.filter((r) => r.errors.length === 0 && r.status === "pending");
    setImporting(true);
    for (const row of valid) {
      updateRow(row.idx, { status: "importing" });
      try {
        const rawMonth = row.data["month"]?.trim() ?? "";
        let monthNum = NaN;
        let yearFromMonth: number | null = null;
        // YYYY-MM  e.g. "2019-01"
        const yyyyMm = rawMonth.match(/^(\d{4})-(\d{1,2})$/);
        if (yyyyMm) { yearFromMonth = parseInt(yyyyMm[1]); monthNum = parseInt(yyyyMm[2]); }
        // numeric 1-12
        else if (/^\d{1,2}$/.test(rawMonth)) { monthNum = parseInt(rawMonth); }
        // short/full name Jan / January
        else {
          const idx = MONTHS.findIndex((m) => m.toLowerCase() === rawMonth.slice(0, 3).toLowerCase());
          if (idx >= 0) monthNum = idx + 1;
        }
        const rawAmt = (row.data["amount"] ?? "").trim().replace(/,/g, "").replace(/k$/i, "000").replace(/m$/i, "000000");
        const amount = parseFloat(rawAmt) || 0;
        const rawDate = row.data["date_paid"]?.trim() ?? "";
        // Parse date robustly — support DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, "3 May 2026", "May 3 2026"
        const datePaid = parseDateToISO(rawDate);
        const year = yearFromMonth ?? (datePaid ? parseInt(datePaid.slice(0, 4)) : new Date().getFullYear());

        if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) throw new Error(`Invalid month "${rawMonth}"`);

        // Skip duplicate month/year — but overwrite if existing record has amount 0 (bad prior import)
        const { data: exists } = await supabase
          .from("contributions").select("id, amount")
          .eq("shareholder_id", selectedId).eq("month", monthNum).eq("year", year).maybeSingle();
        if (exists) {
          if (Number(exists.amount) === 0 && amount > 0) {
            // Overwrite the zero-amount record
            await supabase.from("contributions").update({
              amount, payment_date: datePaid || undefined, notes: "Uploaded payment",
            }).eq("id", exists.id);
            // Fix net_savings delta
            const { data: sh } = await supabase.from("shareholders").select("net_savings").eq("id", selectedId).single();
            if (sh) await supabase.from("shareholders").update({ net_savings: Number(sh.net_savings) + amount }).eq("id", selectedId);
            updateRow(row.idx, { status: "success" });
          } else {
            updateRow(row.idx, { status: "error", msg: `Skipped — ${MONTHS[monthNum-1]} ${year} already recorded` });
          }
          continue;
        }

        await contributionsApi.record({ shareholder_id: selectedId as number, amount, month: monthNum, year, payment_date: datePaid || undefined, notes: "Uploaded payment" });
        updateRow(row.idx, { status: "success" });
      } catch (err: any) {
        updateRow(row.idx, { status: "error", msg: err.message });
      }
    }
    setImporting(false);
  };

  const handleTemplate = () =>
    triggerCsvDownload("contributions_template.csv", [CONTRIBUTION_COLS, ["1", "2025-01-04", "5000"]]);

  const validRows   = rows?.filter((r) => r.errors.length === 0) ?? [];
  const successCount = rows?.filter((r) => r.status === "success").length ?? 0;
  const errorCount   = rows?.filter((r) => r.status === "error").length ?? 0;

  return (
    <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef9c3" }}>
          <Link2 size={18} color="#ca8a04" />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-sm" style={{ color: "#1a202c" }}>Contributions Upload</h3>
          <p className="text-xs text-gray-400">Upload monthly contributions per member</p>
        </div>
        <button onClick={handleTemplate}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors hover:opacity-80"
          style={{ borderColor: "#ca8a04", color: "#ca8a04" }}>
          <Download size={12} /> Template
        </button>
        <button onClick={() => setExpanded((v) => !v)} className="p-1 text-gray-400 hover:text-gray-600">
          <ChevronDown size={16} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </button>
      </div>

      {expanded && (
        <div className="px-5 pb-5 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>

          {/* Step 1 — Select member */}
          <div className="mt-3">
            <label className="block text-xs font-bold text-gray-500 mb-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-xs mr-1.5" style={{ background: "#ca8a04" }}>1</span>
              Select Shareholder
            </label>
            <select value={selectedId} onChange={(e) => { setSelectedId(e.target.value ? parseInt(e.target.value) : ""); setRows(null); }}
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 bg-white"
              style={{ borderColor: "var(--border)" }}>
              <option value="">— Choose a shareholder —</option>
              {shareholders.map((s) => (
                <option key={s.id} value={s.id}>EW#{s.member_number} — {s.name}</option>
              ))}
            </select>
          </div>

          {/* Step 2 — Upload file (only shown after member selected) */}
          {selectedId !== "" && (
            <>
              <div>
                <label className="block text-xs font-bold text-gray-500 mb-1.5">
                  <span className="inline-flex items-center justify-center w-4 h-4 rounded-full text-white text-xs mr-1.5" style={{ background: "#ca8a04" }}>2</span>
                  Upload Data &nbsp;<span className="font-normal text-gray-400">Columns: month, date_paid, amount</span>
                </label>

                {/* Mode tabs */}
                <div className="flex gap-1 p-1 rounded-lg mb-3" style={{ background: "#f1f5f9" }}>
                  {([["csv","Upload CSV"],["paste","Paste Data"]] as const).map(([m, label]) => (
                    <button key={m} onClick={() => { setInputMode(m); setRows(null); setPasteText(""); }}
                      className="flex-1 py-1.5 rounded-md text-xs font-semibold transition-all"
                      style={{ background: inputMode === m ? "#fff" : "transparent", color: inputMode === m ? "#1a202c" : "#64748b", boxShadow: inputMode === m ? "0 1px 3px rgba(0,0,0,0.1)" : "none" }}>
                      {label}
                    </button>
                  ))}
                </div>

                {inputMode === "csv" ? (
                  <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) processFile(f); }}
                    onClick={() => fileRef.current?.click()}
                    className="border-2 border-dashed rounded-xl px-4 py-6 text-center cursor-pointer transition-colors"
                    style={{ borderColor: dragOver ? "#ca8a04" : "#e2e8f0", background: dragOver ? "#fffbeb" : "#fafafa" }}>
                    <UploadCloud size={22} className="mx-auto mb-2 text-gray-300" />
                    <p className="text-xs font-semibold text-gray-500">Drop CSV file here or <span style={{ color: "#ca8a04" }}>browse</span></p>
                    <input ref={fileRef} type="file" accept=".csv" className="hidden"
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) processFile(f); e.target.value = ""; }} />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)}
                      onPaste={(e) => { const t = e.clipboardData.getData("text"); setPasteText(t); setTimeout(() => { const raw = parseCsvText(t); if (raw.length > 0) { const h = raw[0].map((x) => x.toLowerCase().replace(/[\s\/]+/g, "_")); const hasH = h.some((x) => CONTRIBUTION_COLS.includes(x)); setRows(buildRows(hasH ? raw.slice(1) : raw, hasH ? h : CONTRIBUTION_COLS)); } }, 50); }}
                      placeholder={"month\tdate_paid\tamount\n1\t2025-01-04\t5000\n2\t2025-02-03\t5000"}
                      className="w-full h-28 border rounded-xl px-3 py-2.5 text-xs font-mono focus:outline-none resize-none"
                      style={{ borderColor: "var(--border)" }} />
                    {pasteError && <p className="text-xs text-red-500">{pasteError}</p>}
                    {!rows && <button onClick={handlePasteParse} className="px-4 py-2 rounded-xl text-xs font-bold text-white" style={{ background: "#ca8a04" }}>Parse Data</button>}
                  </div>
                )}
              </div>

              {/* Preview table */}
              {rows && rows.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-gray-500"><span className="font-semibold">{validRows.length}</span> valid · <span className="font-semibold text-red-500">{rows.filter((r) => r.errors.length > 0).length}</span> errors</p>
                    {(successCount > 0 || errorCount > 0) && (
                      <p className="text-xs"><span className="text-green-600 font-semibold">{successCount} imported</span>{errorCount > 0 && <span className="text-red-500 font-semibold"> · {errorCount} failed</span>}</p>
                    )}
                  </div>
                  <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
                    <table className="w-full text-xs">
                      <thead style={{ background: "#1e3a5f" }}>
                        <tr>{["Month","Date Paid","Amount","Status"].map((h) => <th key={h} className="px-3 py-2 text-left font-semibold text-white">{h}</th>)}</tr>
                      </thead>
                      <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
                        {rows.map((r) => (
                          <tr key={r.idx} style={{ background: r.status === "success" ? "#f0fdf4" : r.status === "error" ? "#fef2f2" : "white" }}>
                            <td className="px-3 py-2">{r.data["month"] ? (MONTHS[parseInt(r.data["month"]) - 1] ?? r.data["month"]) : "—"}</td>
                            <td className="px-3 py-2">{r.data["date_paid"] || "—"}</td>
                            <td className="px-3 py-2">{r.data["amount"] ? fmtKES(parseFloat(r.data["amount"])) : "—"}</td>
                            <td className="px-3 py-2">
                              {r.errors.length > 0 ? <span className="text-red-500">{r.errors[0]}</span>
                                : r.status === "success" ? <span className="text-green-600 font-semibold flex items-center gap-1"><CheckCircle size={11} /> Imported</span>
                                : r.status === "error"   ? <span className="text-red-500 flex items-center gap-1"><XCircle size={11} /> {r.msg}</span>
                                : r.status === "importing" ? <span className="text-gray-400 flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Importing…</span>
                                : <span className="text-gray-400">Ready</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {validRows.some((r) => r.status === "pending") && (
                    <button onClick={handleImport} disabled={importing}
                      className="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                      style={{ background: "#ca8a04" }}>
                      {importing ? "Importing…" : `Import ${validRows.filter((r) => r.status === "pending").length} Contributions`}
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Bulk Contributions Upload ────────────────────────────────────────────────
// Accepts multiple CSV files named like "monthly_template_#73.csv"
// Parses the member number from the filename and imports contributions for each.

interface BulkFileResult {
  filename: string;
  memberNumber: number | null;
  shareholder: Shareholder | null;
  status: "pending" | "importing" | "done" | "error";
  rowsTotal: number;
  rowsOk: number;
  rowsSkipped: number;
  rowsFailed: number;
  error?: string;
}

function parseMemberNumberFromFilename(name: string): number | null {
  // Matches patterns like: monthly_template_#73, template_#73, #73, member73, member_73
  const m = name.match(/#(\d+)|member[_\-\s]?(\d+)/i);
  if (m) return parseInt(m[1] ?? m[2]);
  // fallback: last standalone number in the name
  const nums = name.match(/\d+/g);
  if (nums) return parseInt(nums[nums.length - 1]);
  return null;
}

function BulkContributionsUploadSection({ shareholders }: { shareholders: Shareholder[] }) {
  const [expanded, setExpanded] = useState(true);
  const [files, setFiles] = useState<BulkFileResult[]>([]);
  const [importing, setImporting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const buildFileResults = (fileList: FileList): BulkFileResult[] => {
    return Array.from(fileList).map((f) => {
      const memberNumber = parseMemberNumberFromFilename(f.name.replace(/\.[^.]+$/, ""));
      const shareholder = memberNumber != null
        ? (shareholders.find((s) => s.member_number === memberNumber) ?? null)
        : null;
      return {
        filename: f.name,
        memberNumber,
        shareholder,
        status: "pending",
        rowsTotal: 0, rowsOk: 0, rowsSkipped: 0, rowsFailed: 0,
      };
    });
  };

  const handleFiles = (fileList: FileList) => {
    setFiles(buildFileResults(fileList));
  };

  const updateFile = (filename: string, patch: Partial<BulkFileResult>) =>
    setFiles((prev) => prev.map((f) => f.filename === filename ? { ...f, ...patch } : f));

  const importFile = async (fileResult: BulkFileResult, file: File) => {
    if (!fileResult.shareholder) {
      updateFile(fileResult.filename, { status: "error", error: fileResult.memberNumber == null ? "Could not parse member number from filename" : `No shareholder with member number ${fileResult.memberNumber}` });
      return;
    }
    updateFile(fileResult.filename, { status: "importing" });
    const shareholderId = fileResult.shareholder.id;
    const text = await file.text();
    const allRows = parseCsvText(text);
    if (allRows.length < 2) {
      updateFile(fileResult.filename, { status: "error", error: "File has no data rows" });
      return;
    }
    // Normalize headers: lowercase, strip everything except letters/digits/underscore
    const normalizeHeader = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, "");
    const header = allRows[0].map(normalizeHeader);
    const dataRows = allRows.slice(1).filter((r) => r.some((c) => c.trim()));
    let ok = 0, skipped = 0, failed = 0;
    for (const r of dataRows) {
      try {
        const get = (...cols: string[]) => {
          for (const col of cols) {
            const norm = normalizeHeader(col);
            const i = header.findIndex((h) => h === norm || h.startsWith(norm));
            if (i >= 0) return r[i]?.trim() ?? "";
          }
          return "";
        };
        const rawMonth = get("month");
        let monthNum = NaN, yearFromMonth: number | null = null;
        const ym = rawMonth.match(/^(\d{4})-(\d{1,2})$/);
        if (ym) { yearFromMonth = parseInt(ym[1]); monthNum = parseInt(ym[2]); }
        else if (/^\d{1,2}$/.test(rawMonth)) monthNum = parseInt(rawMonth);
        else { const mi = MONTHS.findIndex((m) => m.toLowerCase() === rawMonth.slice(0, 3).toLowerCase()); if (mi >= 0) monthNum = mi + 1; }
        if (isNaN(monthNum) || monthNum < 1 || monthNum > 12) { failed++; continue; }
        const rawDate = get("date_paid", "datepaid", "date");
        const datePaid = parseDateToISO(rawDate);
        const year = yearFromMonth ?? (datePaid ? parseInt(datePaid.slice(0, 4)) : new Date().getFullYear());
        // Match "amount", "Amount (KES)", "amount_kes", "AmountKES", etc.
        const rawAmount = get("amount", "amountkes", "amountksh", "amountke");
        const amount = parseFloat((rawAmount || "0").replace(/,/g, "")) || 0;
        // Skip rows where amount is 0 — avoids inserting blank rows
        if (amount <= 0) { skipped++; continue; }
        const { data: exists } = await supabase
          .from("contributions").select("id")
          .eq("shareholder_id", shareholderId).eq("month", monthNum).eq("year", year).maybeSingle();
        if (exists) { skipped++; continue; }
        await contributionsApi.record({ shareholder_id: shareholderId, amount, month: monthNum, year, payment_date: datePaid || undefined, notes: "Bulk upload" });
        ok++;
      } catch { failed++; }
    }
    updateFile(fileResult.filename, { status: "done", rowsTotal: dataRows.length, rowsOk: ok, rowsSkipped: skipped, rowsFailed: failed });
  };

  const handleImport = async () => {
    if (importing) return;
    setImporting(true);
    // Collect File objects from a fresh input — we need to re-read them
    // Since we can't re-read from state, we trigger via hidden input and store File refs
    // Instead, we stored files via fileRef
    const input = fileRef.current;
    if (!input?.files) { setImporting(false); return; }
    const fileMap: Record<string, File> = {};
    Array.from(input.files).forEach((f) => { fileMap[f.name] = f; });
    for (const fr of files) {
      const file = fileMap[fr.filename];
      if (!file || fr.status !== "pending") continue;
      await importFile(fr, file);
    }
    setImporting(false);
  };

  const reset = () => {
    setFiles([]);
    if (fileRef.current) fileRef.current.value = "";
  };

  const pendingCount = files.filter((f) => f.status === "pending").length;
  const doneCount = files.filter((f) => f.status === "done").length;
  const errorCount = files.filter((f) => f.status === "error").length;
  const canImport = pendingCount > 0 && !importing;

  return (
    <div className="rounded-2xl bg-white border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef9c3" }}>
          <FileSpreadsheet size={18} color="#ca8a04" />
        </div>
        <div className="flex-1">
          <h3 className="font-bold text-sm" style={{ color: "#1a202c" }}>Bulk Contributions Upload</h3>
          <p className="text-xs text-gray-400">Upload multiple files at once — filename must include member number, e.g. <span className="font-mono">monthly_template_#73.csv</span></p>
        </div>
        <button onClick={() => setExpanded((v) => !v)} className="p-1 text-gray-400 hover:text-gray-600">
          <ChevronDown size={16} style={{ transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
        </button>
      </div>

      {expanded && (
        <div className="px-5 pb-5 space-y-3 border-t" style={{ borderColor: "var(--border)" }}>
          {/* Naming hint */}
          <div className="mt-3 rounded-xl px-4 py-3 text-xs" style={{ background: "#fffbeb", border: "1px solid #fde68a" }}>
            <p className="font-semibold text-amber-700 mb-1">File naming format</p>
            <p className="text-amber-600">Include the member number with a <span className="font-mono font-bold">#</span> prefix anywhere in the filename:</p>
            <p className="font-mono text-amber-800 mt-1">monthly_template_#73.csv &nbsp;·&nbsp; member_#12_contributions.csv &nbsp;·&nbsp; #5_data.csv</p>
          </div>

          {/* Drop zone */}
          {files.length === 0 && (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) handleFiles(e.dataTransfer.files); }}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed rounded-xl py-10 flex flex-col items-center gap-2 cursor-pointer transition-colors"
              style={{ borderColor: dragOver ? "#ca8a04" : "#e2e8f0", background: dragOver ? "#fffbeb" : "#fafafa" }}>
              <UploadCloud size={26} style={{ color: dragOver ? "#ca8a04" : "#94a3b8" }} />
              <p className="text-sm font-semibold" style={{ color: dragOver ? "#ca8a04" : "#64748b" }}>Drop CSV files here or click to browse</p>
              <p className="text-xs text-gray-400">Select multiple files at once</p>
            </div>
          )}
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" multiple className="hidden"
            onChange={(e) => { if (e.target.files?.length) handleFiles(e.target.files); }} />

          {/* File list */}
          {files.length > 0 && (
            <div className="space-y-2">
              {/* Summary bar */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-gray-500 font-semibold">{files.length} file{files.length !== 1 ? "s" : ""}</span>
                  {doneCount > 0 && <span className="text-green-600 font-semibold flex items-center gap-1"><CheckCircle size={12} /> {doneCount} done</span>}
                  {errorCount > 0 && <span className="text-red-500 font-semibold flex items-center gap-1"><XCircle size={12} /> {errorCount} errors</span>}
                </div>
                <button onClick={reset} className="text-xs text-gray-400 hover:text-gray-600 underline">Clear all</button>
              </div>

              {/* Per-file rows */}
              <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
                {files.map((f, i) => (
                  <div key={f.filename}
                    className="flex items-start gap-3 px-4 py-3 border-b last:border-b-0 text-xs"
                    style={{ borderColor: "var(--border)", background: f.status === "done" ? "#f0fdf4" : f.status === "error" ? "#fef2f2" : i % 2 === 0 ? "#fff" : "#fafafa" }}>
                    {/* Status icon */}
                    <div className="flex-shrink-0 mt-0.5">
                      {f.status === "pending"   && <div className="w-4 h-4 rounded-full border-2 border-gray-200" />}
                      {f.status === "importing" && <Loader2 size={14} className="animate-spin text-amber-500" />}
                      {f.status === "done"      && <CheckCircle size={14} className="text-green-500" />}
                      {f.status === "error"     && <XCircle size={14} className="text-red-400" />}
                    </div>
                    {/* File info */}
                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-semibold truncate" style={{ color: "#1a202c" }}>{f.filename}</p>
                      {f.memberNumber != null && f.shareholder && (
                        <p className="text-gray-500 mt-0.5">
                          EW#{f.memberNumber} · <span className="font-semibold text-indigo-600">{f.shareholder.name}</span>
                        </p>
                      )}
                      {f.memberNumber != null && !f.shareholder && (
                        <p className="text-red-500 mt-0.5">Member #{f.memberNumber} not found</p>
                      )}
                      {f.memberNumber == null && (
                        <p className="text-red-500 mt-0.5">No member number in filename</p>
                      )}
                      {f.status === "done" && (
                        <p className="mt-0.5" style={{ color: "#16a34a" }}>
                          {f.rowsOk} imported
                          {f.rowsSkipped > 0 && <span className="text-amber-600"> · {f.rowsSkipped} skipped (duplicates)</span>}
                          {f.rowsFailed > 0 && <span className="text-red-500"> · {f.rowsFailed} failed</span>}
                        </p>
                      )}
                      {f.status === "error" && <p className="text-red-500 mt-0.5">{f.error}</p>}
                    </div>
                  </div>
                ))}
              </div>

              {/* Progress bar — shown while importing */}
              {importing && (() => {
                const total = files.length;
                const processed = files.filter((f) => f.status === "done" || f.status === "error").length;
                const pct = total > 0 ? Math.round((processed / total) * 100) : 0;
                const remaining = total - processed;
                return (
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-green-700">{pct}% complete</span>
                      <span className="text-gray-500">
                        <span className="font-bold text-gray-700">{remaining}</span> file{remaining !== 1 ? "s" : ""} remaining
                      </span>
                    </div>
                    <div className="h-2.5 rounded-full overflow-hidden" style={{ background: "#e2e8f0" }}>
                      <div className="h-full rounded-full transition-all duration-300" style={{ width: `${pct}%`, background: "#22c55e" }} />
                    </div>
                    <p className="text-[10px] text-gray-400 text-center">
                      {processed} of {total} files processed
                    </p>
                  </div>
                );
              })()}

              {/* Import / re-pick buttons */}
              {files.every((f) => f.status === "done" || f.status === "error") ? (
                <button onClick={reset}
                  className="w-full py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "var(--border)" }}>
                  Upload more files
                </button>
              ) : (
                <div className="flex gap-2">
                  <button onClick={() => fileRef.current?.click()}
                    className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                    style={{ borderColor: "var(--border)" }}>
                    Change files
                  </button>
                  <button onClick={handleImport} disabled={!canImport}
                    className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                    style={{ background: "#ca8a04" }}>
                    {importing
                      ? <><Loader2 size={14} className="animate-spin" /> Importing…</>
                      : `Import ${pendingCount} file${pendingCount !== 1 ? "s" : ""}`}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Fix Swapped Dates ────────────────────────────────────────────────────────
// Repairs contributions uploaded before the DD/MM parser fix.
// Those records have day and month swapped in payment_date
// (e.g. stored "2026-05-03" when the correct date is "2026-03-05").
// Pattern: payment_date month part equals 05 (the payment day) and
//          the day part 01-12 is the actual month.

function FixSwappedDatesButton() {
  const [status, setStatus] = useState<"idle" | "scanning" | "fixing" | "done" | "error">("idle");
  const [found, setFound] = useState(0);
  const [fixed, setFixed] = useState(0);
  const [msg, setMsg] = useState("");

  const run = async () => {
    setStatus("scanning"); setMsg(""); setFound(0); setFixed(0);
    try {
      // Fetch all uploaded contributions that have a payment_date with month=05
      // (day=5 was mistakenly stored as the month after MM/DD mis-parse)
      const { data, error } = await supabase
        .from("contributions")
        .select("id, payment_date")
        .like("payment_date", "%-05-%")
        .in("notes", ["Uploaded payment", "Bulk upload"]);
      if (error) throw new Error(error.message);
      const rows = (data ?? []).filter((r) => {
        if (!r.payment_date) return false;
        const parts = r.payment_date.split("-");
        // Must be YYYY-05-DD where DD is a valid month (01-12)
        if (parts.length !== 3) return false;
        const day = parseInt(parts[2]);
        return day >= 1 && day <= 12;
      });
      setFound(rows.length);
      if (rows.length === 0) { setStatus("done"); setMsg("No swapped dates found — nothing to fix."); return; }
      setStatus("fixing");
      let ok = 0;
      for (const r of rows) {
        const [yyyy, , dd] = r.payment_date.split("-"); // month is "05" (=day 5), dd is actual month
        const corrected = `${yyyy}-${dd.padStart(2, "0")}-05`;
        const { error: upErr } = await supabase
          .from("contributions")
          .update({ payment_date: corrected })
          .eq("id", r.id);
        if (!upErr) ok++;
      }
      setFixed(ok);
      setStatus("done");
      setMsg(`Fixed ${ok} of ${rows.length} records.`);
    } catch (err: any) {
      setStatus("error");
      setMsg(err.message ?? "Unknown error");
    }
  };

  return (
    <div className="rounded-xl px-4 py-3 flex items-start gap-3" style={{ background: "#fef3c7", border: "1px solid #fcd34d" }}>
      <AlertCircle size={15} color="#b45309" className="flex-shrink-0 mt-0.5" />
      <div className="flex-1 text-xs" style={{ color: "#92400e" }}>
        {status === "idle" && <span>Uploaded contributions may have swapped day/month in their payment dates. Click to scan and repair.</span>}
        {status === "scanning" && <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Scanning records…</span>}
        {status === "fixing" && <span className="flex items-center gap-1"><Loader2 size={11} className="animate-spin" /> Fixing {found} records…</span>}
        {status === "done" && <span className="font-semibold text-green-800">{msg}</span>}
        {status === "error" && <span className="text-red-700">{msg}</span>}
      </div>
      {(status === "idle" || status === "error") && (
        <button onClick={run}
          className="flex-shrink-0 text-xs font-bold px-3 py-1.5 rounded-lg text-white hover:opacity-90"
          style={{ background: "#b45309" }}>
          Fix Dates
        </button>
      )}
      {status === "done" && fixed > 0 && (
        <button onClick={() => setStatus("idle")}
          className="flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg border hover:bg-amber-50"
          style={{ borderColor: "#fcd34d", color: "#92400e" }}>
          Run Again
        </button>
      )}
    </div>
  );
}

function DataUploadPage({ onBack }: { onBack: () => void }) {
  const [shareholders, setShareholders] = useState<Shareholder[]>([]);

  useEffect(() => {
    shareholdersApi.list().then(setShareholders).catch(() => setShareholders([]));
  }, []);

  const updateRow = (
    setRows: React.Dispatch<React.SetStateAction<ImportRow[] | null>>,
    idx: number,
    patch: Partial<ImportRow>
  ) => setRows((prev) => prev ? prev.map((r) => r.idx === idx ? { ...r, ...patch } : r) : prev);

  const handleShareholdersImport = async (
    validRows: ImportRow[],
    setRows: React.Dispatch<React.SetStateAction<ImportRow[] | null>>
  ) => {
    for (const row of validRows) {
      updateRow(setRows, row.idx, { status: "importing" });
      try {
        const phone = row.data["phone"]?.trim() || undefined;
        const memberNum = row.data["member_number"] ? parseInt(row.data["member_number"]) : undefined;

        // Only check member_number for duplicates — phone is optional and not checked
        if (memberNum) {
          const { data: existing } = await supabase
            .from("shareholders").select("id").eq("member_number", memberNum).maybeSingle();
          if (existing) {
            updateRow(setRows, row.idx, { status: "success", msg: `Skipped — EW#${memberNum} already exists` });
            continue;
          }
        }

        await shareholdersApi.create({
          name: row.data["name"],
          phone: phone ?? "",
          email: row.data["email"] || undefined,
          id_passport: row.data["id_passport"] || undefined,
          joined_date: row.data["joined_date"] || undefined,
          status: (row.data["status"] as "Active" | "Inactive") || "Active",
          member_number: memberNum,
        });
        updateRow(setRows, row.idx, { status: "success" });
      } catch (err: any) {
        updateRow(setRows, row.idx, { status: "error", msg: err.message });
      }
    }
  };

  const handleClientsImport = async (
    validRows: ImportRow[],
    setRows: React.Dispatch<React.SetStateAction<ImportRow[] | null>>
  ) => {
    for (const row of validRows) {
      updateRow(setRows, row.idx, { status: "importing" });
      try {
        const phone = row.data["phone"];
        // Client numbers are text (e.g. EC001) — never parseInt
        const clientNum = row.data["member_number"]?.trim() || undefined;

        // Check phone duplicate across all member types
        const phoneCheck = await clientsApi.checkPhone(phone);
        if (!phoneCheck.available) {
          updateRow(setRows, row.idx, { status: "error", msg: `Skipped — phone already exists as a ${phoneCheck.conflict?.member_type}` });
          continue;
        }

        // Check client_number duplicate
        if (clientNum) {
          const { data: existing } = await supabase
            .from("clients").select("id").eq("member_number", clientNum).maybeSingle();
          if (existing) {
            updateRow(setRows, row.idx, { status: "success", msg: `Skipped — client number ${clientNum} already exists` });
            continue;
          }
        }

        await clientsApi.create({
          name: row.data["name"],
          phone,
          email: row.data["email"] || undefined,
          id_passport: row.data["id_passport"] || undefined,
          joined_date: row.data["joined_date"] || undefined,
          status: (row.data["status"] as "Active" | "Inactive") || "Active",
          member_number: clientNum,
        });
        updateRow(setRows, row.idx, { status: "success" });
      } catch (err: any) {
        updateRow(setRows, row.idx, { status: "error", msg: err.message });
      }
    }
  };

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-4xl mx-auto p-4 md:p-6 space-y-5">
        {/* Page header */}
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg hover:bg-gray-200 transition-colors" style={{ color: "#64748b" }}>
            <ArrowLeft size={14} /> Settings
          </button>
          <span className="text-gray-300">/</span>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#f0fdf4" }}>
              <FileSpreadsheet size={16} color="#22c55e" />
            </div>
            <div>
              <h1 className="font-bold text-base" style={{ color: "#1a202c" }}>Data Upload</h1>
              <p className="text-xs text-gray-400">Import data via CSV spreadsheet.</p>
            </div>
          </div>
        </div>

        {/* How to use */}
        <div className="rounded-xl p-4" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
          <p className="text-xs font-bold mb-2" style={{ color: "#0369a1" }}>How to use</p>
          <ol className="space-y-1">
            {[
              "Download the sample template for the data type",
              "Fill in your data following the column format",
              "Save as CSV and upload using the button below",
              "Review the import results for any errors",
            ].map((step, i) => (
              <li key={i} className="text-xs flex items-start gap-1.5" style={{ color: "#0369a1" }}>
                <span className="font-bold flex-shrink-0">{i + 1}.</span> {step}
              </li>
            ))}
          </ol>
        </div>

        {/* Shareholders upload */}
        <UploadSection
          type="shareholders"
          accentColor="#6366f1"
          iconBg="#eef2ff"
          icon={<Users size={18} />}
          title="Shareholders"
          subtitle="Upload shareholder member profiles"
          onImport={handleShareholdersImport}
        />

        {/* Clients upload */}
        <UploadSection
          type="clients"
          accentColor="#a855f7"
          iconBg="#faf5ff"
          icon={<UserCircle2 size={18} />}
          title="Clients"
          subtitle="Upload client records — only Name & Phone required"
          onImport={handleClientsImport}
        />

        <ContributionsUploadSection shareholders={shareholders} />

        <BulkContributionsUploadSection shareholders={shareholders} />

        {/* Quick sync after contribution upload */}
        <QuickSyncBanner />

        <FixSwappedDatesButton />

        <PaymentsUploadSection />
      </div>
    </div>
  );
}

// ─── App Maintenance Page ─────────────────────────────────────────────────────

async function recalcNetSavings(): Promise<{ updated: number; errors: number }> {
  // Fetch all shareholders
  const { data: shareholders } = await supabase.from("shareholders").select("id");
  if (!shareholders) return { updated: 0, errors: 0 };

  let updated = 0, errors = 0;
  for (const sh of shareholders) {
    try {
      // Sum contributions
      const { data: contribs } = await supabase
        .from("contributions").select("amount").eq("shareholder_id", sh.id);
      const totalContrib = (contribs ?? []).reduce((s: number, c: any) => s + Number(c.amount), 0);

      // Sum refunds
      const { data: refs } = await supabase
        .from("refunds").select("amount").eq("shareholder_id", sh.id);
      const totalRefunds = (refs ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);

      const netSavings = Math.max(0, totalContrib - totalRefunds);
      const contribCount = (contribs ?? []).length;

      await supabase.from("shareholders").update({
        net_savings: netSavings,
        contributions_count: contribCount,
      }).eq("id", sh.id);

      updated++;
    } catch {
      errors++;
    }
  }
  return { updated, errors };
}

function DeleteMemberContributionsCard({ onResult }: { onResult: (r: { type: "success" | "error"; msg: string }) => void }) {
  const [shareholders, setShareholders] = useState<Shareholder[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Shareholder[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProgress, setDeleteProgress] = useState<Record<number, "pending" | "done" | "error">>({});

  useEffect(() => {
    shareholdersApi.list().then(setShareholders).catch(() => {});
  }, []);

  const filtered = shareholders.filter((s) =>
    (s.name.toLowerCase().includes(search.toLowerCase()) ||
    String(s.member_number).includes(search)) &&
    !selected.some((sel) => sel.id === s.id)
  ).slice(0, 6);

  const addMember = (s: Shareholder) => {
    setSelected((prev) => [...prev, s]);
    setSearch("");
    setConfirming(false);
  };

  const removeMember = (id: number) => {
    setSelected((prev) => prev.filter((s) => s.id !== id));
    setDeleteProgress((prev) => { const n = { ...prev }; delete n[id]; return n; });
  };

  const handleDelete = async () => {
    if (selected.length === 0) return;
    setDeleting(true);
    const progress: Record<number, "pending" | "done" | "error"> = {};
    selected.forEach((s) => { progress[s.id] = "pending"; });
    setDeleteProgress({ ...progress });

    let successCount = 0;
    for (const s of selected) {
      try {
        const { error } = await supabase.from("contributions").delete().eq("shareholder_id", s.id);
        if (error) throw new Error(error.message);
        await supabase.from("shareholders").update({ net_savings: 0, contributions_count: 0 }).eq("id", s.id);
        progress[s.id] = "done";
        successCount++;
      } catch {
        progress[s.id] = "error";
      }
      setDeleteProgress({ ...progress });
    }

    const failed = selected.filter((s) => progress[s.id] === "error");
    if (failed.length === 0) {
      onResult({ type: "success", msg: `Contributions deleted for ${successCount} member${successCount !== 1 ? "s" : ""}. Net savings reset to 0.` });
      setSelected([]); setConfirming(false); setDeleteProgress({});
    } else {
      onResult({ type: "error", msg: `${successCount} succeeded, ${failed.length} failed: ${failed.map((s) => s.name).join(", ")}` });
      // Keep only the failed ones selected so user can retry
      setSelected(failed);
      setConfirming(false);
    }
    setDeleting(false);
  };

  const initials = (s: Shareholder) => s.name.split(" ").map((n: string) => n[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "#fecaca" }}>
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
          <span style={{ color: "#ef4444" }}><SlidersHorizontal size={18} /></span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Delete Member Contributions</div>
          <div className="text-xs text-gray-400 mt-0.5">Remove all contribution records for one or more members.</div>
        </div>
      </div>

      {/* Search */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setConfirming(false); }}
              placeholder="Search member by name or EW#…"
              className="w-full pl-8 pr-3 py-2 rounded-xl border text-xs focus:outline-none focus:ring-2 focus:ring-red-100"
              style={{ borderColor: "var(--border)" }}
            />
          </div>
          <button
            onClick={() => { setSelected(shareholders); setSearch(""); setConfirming(false); setDeleteProgress({}); }}
            disabled={shareholders.length === 0 || selected.length === shareholders.length}
            className="flex-shrink-0 px-3 py-2 rounded-xl border text-xs font-semibold transition-colors disabled:opacity-40 hover:bg-red-50"
            style={{ borderColor: "#fecaca", color: "#ef4444" }}>
            Select all ({shareholders.length})
          </button>
        </div>
        {search.length > 0 && (
          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
            {filtered.length === 0 ? (
              <p className="text-xs text-gray-400 px-3 py-2">No members found.</p>
            ) : filtered.map((s) => (
              <button key={s.id} onClick={() => addMember(s)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-red-50 transition-colors border-b last:border-b-0 text-left"
                style={{ borderColor: "var(--border)" }}>
                <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                  style={{ background: s.avatar_color }}>
                  {initials(s)}
                </div>
                <div className="flex-1">
                  <div className="text-xs font-semibold" style={{ color: "#1a202c" }}>{s.name}</div>
                  <div className="text-[10px] font-bold" style={{ color: "#6366f1" }}>EW#{s.member_number}</div>
                </div>
                <span className="text-[10px] font-semibold text-red-400 pr-1">+ Add</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected members chips */}
      {selected.length > 0 && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-gray-500">{selected.length} member{selected.length !== 1 ? "s" : ""} selected</p>
            <button onClick={() => { setSelected([]); setConfirming(false); setDeleteProgress({}); }}
              className="text-[11px] text-gray-400 hover:text-red-500 underline">Clear all</button>
          </div>

          <div className="rounded-xl border overflow-hidden" style={{ borderColor: "#fecaca" }}>
            {selected.map((s) => {
              const st = deleteProgress[s.id];
              return (
                <div key={s.id}
                  className="flex items-center gap-3 px-3 py-2.5 border-b last:border-b-0"
                  style={{ borderColor: "#fecaca", background: st === "done" ? "#f0fdf4" : st === "error" ? "#fef2f2" : "#fff9f9" }}>
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                    style={{ background: s.avatar_color }}>
                    {initials(s)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{s.name}</div>
                    <div className="text-[10px] font-bold" style={{ color: "#6366f1" }}>EW#{s.member_number}</div>
                  </div>
                  {st === "pending" && deleting && <Loader2 size={13} className="animate-spin text-red-400 flex-shrink-0" />}
                  {st === "done"    && <CheckCircle size={13} className="text-green-500 flex-shrink-0" />}
                  {st === "error"   && <XCircle size={13} className="text-red-400 flex-shrink-0" />}
                  {!deleting && (
                    <button onClick={() => removeMember(s.id)}
                      className="text-gray-300 hover:text-red-400 transition-colors flex-shrink-0 ml-1">
                      <X size={13} />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {!confirming ? (
            <button onClick={() => setConfirming(true)}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-white hover:opacity-90"
              style={{ background: "#ef4444" }}>
              Delete Contributions for {selected.length} Member{selected.length !== 1 ? "s" : ""}
            </button>
          ) : (
            <div className="rounded-xl border p-3 space-y-2" style={{ borderColor: "#fecaca", background: "#fef2f2" }}>
              <p className="text-xs font-semibold text-red-700">
                Permanently delete all contributions for <strong>{selected.length} member{selected.length !== 1 ? "s" : ""}</strong>? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setConfirming(false)}
                  className="flex-1 py-2 rounded-xl border text-xs font-semibold text-gray-500 hover:bg-white"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button onClick={handleDelete} disabled={deleting}
                  className="flex-1 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-60 flex items-center justify-center gap-1.5"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <><Loader2 size={12} className="animate-spin" /> Deleting…</> : "Yes, Delete All"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const FACTORY_TABLES = [
  "plot_payments",
  "profit_distributions",
  "project_shareholders",
  "plots",
  "projects",
  "contributions",
  "refunds",
  "payments",
  "investors",
  "clients",
  "shareholders",
] as const;

function FactoryResetCard({ onResult }: { onResult: (r: { type: "success" | "error"; msg: string }) => void }) {
  const [stage, setStage] = useState<"idle" | "confirm1" | "confirm2">("idle");
  const [typed, setTyped] = useState("");
  const [resetting, setResetting] = useState(false);

  const handleReset = async () => {
    setResetting(true);
    try {
      for (const table of FACTORY_TABLES) {
        const { error } = await supabase.from(table).delete().neq("id", 0);
        if (error) throw new Error(`Failed on ${table}: ${error.message}`);
      }
      onResult({ type: "success", msg: "Factory reset complete. All data has been wiped." });
      setStage("idle"); setTyped("");
    } catch (err: any) {
      onResult({ type: "error", msg: err.message });
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="rounded-2xl border-2 overflow-hidden" style={{ borderColor: "#7f1d1d" }}>
      {/* Header bar */}
      <div className="px-5 py-3 flex items-center gap-3" style={{ background: "#7f1d1d" }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "rgba(255,255,255,0.12)" }}>
          <RotateCcw size={16} color="#fca5a5" />
        </div>
        <div className="flex-1">
          <p className="font-bold text-sm text-white">Factory Reset</p>
          <p className="text-[11px]" style={{ color: "#fca5a5" }}>Wipes all data — shareholders, clients, contributions, payments, refunds, projects & plots</p>
        </div>
      </div>

      <div className="bg-white px-5 py-4 space-y-4">
        {stage === "idle" && (
          <div className="flex items-center justify-between gap-4">
            <p className="text-xs text-gray-500 leading-relaxed">
              This will permanently delete <strong>every record</strong> in the database. The app will return to a clean state as if freshly installed. <strong className="text-red-600">This cannot be undone.</strong>
            </p>
            <button onClick={() => setStage("confirm1")}
              className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
              style={{ background: "#7f1d1d" }}>
              Factory Reset
            </button>
          </div>
        )}

        {stage === "confirm1" && (
          <div className="space-y-3">
            <div className="rounded-xl p-3 flex items-start gap-2" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
              <AlertCircle size={14} color="#dc2626" className="flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-700 font-medium">
                You are about to permanently erase <strong>all shareholders, clients, contributions, payments, refunds, projects, plots and all related records</strong>. Are you absolutely sure?
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => setStage("idle")}
                className="flex-1 py-2 rounded-xl border text-xs font-semibold text-gray-500 hover:bg-gray-50"
                style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button onClick={() => setStage("confirm2")}
                className="flex-1 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90"
                style={{ background: "#dc2626" }}>
                Yes, I understand — continue
              </button>
            </div>
          </div>
        )}

        {stage === "confirm2" && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1.5 block">
                Type <span className="font-mono font-bold text-red-600">RESET</span> to confirm
              </label>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="RESET"
                className="w-full border rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-red-300"
                style={{ borderColor: "#fca5a5" }}
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => { setStage("idle"); setTyped(""); }}
                className="flex-1 py-2 rounded-xl border text-xs font-semibold text-gray-500 hover:bg-gray-50"
                style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button onClick={handleReset} disabled={typed !== "RESET" || resetting}
                className="flex-1 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-40 flex items-center justify-center gap-1.5"
                style={{ background: "#7f1d1d" }}>
                {resetting ? <><Loader2 size={13} className="animate-spin" /> Resetting…</> : "Confirm Factory Reset"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Zero-Amount Bulk Upload Cleanup ─────────────────────────────────────────

function ZeroAmountCleanupCard({ onResult }: { onResult: (r: { type: "success" | "error"; msg: string }) => void }) {
  const [checking, setChecking] = useState(false);
  const [count, setCount] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  const check = async () => {
    setChecking(true); setCount(null);
    try {
      const { count: n } = await supabase
        .from("contributions")
        .select("id", { count: "exact", head: true })
        .eq("amount", 0)
        .eq("notes", "Bulk upload");
      setCount(n ?? 0);
    } catch (e: any) { onResult({ type: "error", msg: e.message ?? "Check failed" }); }
    finally { setChecking(false); }
  };

  const clean = async () => {
    setDeleting(true);
    try {
      const { error } = await supabase
        .from("contributions")
        .delete()
        .eq("amount", 0)
        .eq("notes", "Bulk upload");
      if (error) throw new Error(error.message);
      onResult({ type: "success", msg: `Deleted all zero-amount bulk upload records${count !== null ? ` (${count} records)` : ""}.` });
      setCount(null); setConfirmed(false);
    } catch (e: any) { onResult({ type: "error", msg: e.message ?? "Cleanup failed" }); }
    finally { setDeleting(false); }
  };

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "#fde68a" }}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fffbeb" }}>
          <AlertCircle size={18} color="#d97706" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Clean Up Zero-Amount Bulk Records</div>
          <div className="text-xs text-gray-400 mt-0.5">
            Removes contribution records inserted with <strong>Ksh 0</strong> via bulk upload — caused by an old column detection bug. Run a check first to see how many records are affected.
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={check} disabled={checking || deleting}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border disabled:opacity-50"
          style={{ borderColor: "#d97706", color: "#d97706" }}>
          {checking ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          {checking ? "Checking…" : "Check Records"}
        </button>

        {count !== null && count > 0 && (
          <>
            <span className="text-xs font-bold text-red-600 bg-red-50 px-3 py-2 rounded-xl border border-red-200">
              {count} zero-amount record{count !== 1 ? "s" : ""} found
            </span>
            {!confirmed ? (
              <button onClick={() => setConfirmed(true)}
                className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white"
                style={{ background: "#ef4444" }}>
                <Trash2 size={12} /> Delete All
              </button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-xs text-red-600 font-semibold">Are you sure?</span>
                <button onClick={clean} disabled={deleting}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <Loader2 size={12} className="animate-spin" /> : "Yes, Delete"}
                </button>
                <button onClick={() => setConfirmed(false)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold border"
                  style={{ borderColor: "var(--border)", color: "#64748b" }}>
                  Cancel
                </button>
              </div>
            )}
          </>
        )}

        {count === 0 && (
          <span className="text-xs font-semibold text-green-600 bg-green-50 px-3 py-2 rounded-xl border border-green-200 flex items-center gap-1">
            <CheckCircle size={12} /> No zero-amount records found
          </span>
        )}
      </div>

      {count !== null && count > 0 && (
        <p className="text-[10px] text-amber-700 bg-amber-50 rounded-lg px-3 py-2 border border-amber-100">
          After deleting, re-run the bulk upload for affected members — the correct amounts will now be imported.
        </p>
      )}
    </div>
  );
}

// ─── Delete Payments Card ─────────────────────────────────────────────────────

function NormalizePhoneCard({ onResult }: { onResult: (r: { type: "success" | "error"; msg: string }) => void }) {
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<{ table: string; id: number; name: string; old: string; fixed: string }[] | null>(null);
  const [fixing, setFixing] = useState(false);

  const normalize = (phone: string) => {
    let p = phone.trim();
    // Strip a leading + if it's NOT followed by 254 (e.g. +07... → 07...)
    if (p.startsWith("+") && !p.startsWith("+254")) p = p.slice(1);
    if (p.startsWith("+254") && p.length === 13) return null; // already correct
    if (p.startsWith("254") && p.length === 12) return "+" + p;
    if (p.startsWith("0") && p.length === 10) return "+254" + p.slice(1);
    if (p.startsWith("7") && p.length === 9) return "+254" + p;
    return null; // unrecognised format, skip
  };

  const handlePreview = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      const [{ data: sh }, { data: cl }, { data: inv }] = await Promise.all([
        supabase.from("shareholders").select("id,name,phone"),
        supabase.from("clients").select("id,name,phone"),
        supabase.from("investors").select("id,name,phone"),
      ]);
      const rows: { table: string; id: number; name: string; old: string; fixed: string }[] = [];
      for (const r of (sh ?? [])) { const f = normalize(r.phone ?? ""); if (f) rows.push({ table: "shareholders", id: r.id, name: r.name, old: r.phone, fixed: f }); }
      for (const r of (cl ?? [])) { const f = normalize(r.phone ?? ""); if (f) rows.push({ table: "clients",      id: r.id, name: r.name, old: r.phone, fixed: f }); }
      for (const r of (inv ?? [])) { const f = normalize(r.phone ?? ""); if (f) rows.push({ table: "investors",   id: r.id, name: r.name, old: r.phone, fixed: f }); }
      setPreview(rows);
    } catch (e: any) { onResult({ type: "error", msg: e.message }); }
    finally { setPreviewing(false); }
  };

  const handleFix = async () => {
    if (!preview?.length) return;
    setFixing(true);
    try {
      for (const r of preview) {
        await supabase.from(r.table as any).update({ phone: r.fixed }).eq("id", r.id);
      }
      onResult({ type: "success", msg: `Fixed ${preview.length} phone number${preview.length !== 1 ? "s" : ""} to +254 format.` });
      setPreview(null);
    } catch (e: any) { onResult({ type: "error", msg: e.message }); }
    finally { setFixing(false); }
  };

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "var(--card-border)" }}>
      <div>
        <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Normalize Phone Numbers</div>
        <div className="text-xs text-gray-500 mt-0.5">Convert <code className="bg-gray-100 px-1 rounded">07XXXXXXXX</code> or <code className="bg-gray-100 px-1 rounded">+07XXXXXXXX</code> → <code className="bg-gray-100 px-1 rounded">+2547XXXXXXXX</code> for all members. Already-correct <code className="bg-gray-100 px-1 rounded">+254…</code> numbers are skipped.</div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={handlePreview} disabled={previewing || fixing}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50"
          style={{ background: "#6366f1" }}>
          {previewing ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
          {previewing ? "Scanning…" : "Preview Changes"}
        </button>
        {preview !== null && preview.length > 0 && (
          <button onClick={handleFix} disabled={fixing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-50"
            style={{ background: "#22c55e" }}>
            {fixing ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle size={12} />}
            {fixing ? "Fixing…" : `Fix ${preview.length} Number${preview.length !== 1 ? "s" : ""}`}
          </button>
        )}
        {preview !== null && preview.length === 0 && (
          <span className="text-xs text-green-600 font-semibold">✓ All numbers already in +254 format</span>
        )}
      </div>
      {preview !== null && preview.length > 0 && (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <div className="overflow-x-auto max-h-48 overflow-y-auto">
            <table className="w-full text-xs">
              <thead style={{ background: "#1e3a5f" }}>
                <tr>
                  {["Member", "Table", "Current", "Will become"].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-white">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
                {preview.map((r, i) => (
                  <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f8faff" }}>
                    <td className="px-3 py-1.5 font-semibold" style={{ color: "#1a202c" }}>{r.name}</td>
                    <td className="px-3 py-1.5 text-gray-500 capitalize">{r.table}</td>
                    <td className="px-3 py-1.5 text-red-500 font-mono">{r.old}</td>
                    <td className="px-3 py-1.5 text-green-600 font-mono font-bold">{r.fixed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}


// Modules that can be toggled — imported from App via localStorage
const HIDDEN_MODULES_KEY = "sacco_hidden_modules";
const ALWAYS_VISIBLE_IDS = ["dashboard", "settings"];

const ROLE_TABS = [
  { role: "admin",       label: "Admin",       color: "#6366f1" },
  { role: "shareholder", label: "Shareholder", color: "#ec4899" },
  { role: "client",      label: "Client",      color: "#a855f7" },
  { role: "investor",    label: "Investor",    color: "#eab308" },
] as const;

function hiddenModulesKey(role: string) {
  return role === "admin" ? HIDDEN_MODULES_KEY : `${HIDDEN_MODULES_KEY}_${role}`;
}

function getHiddenIds(role = "admin"): string[] {
  try { return JSON.parse(localStorage.getItem(hiddenModulesKey(role)) ?? "[]"); } catch { return []; }
}

const ALL_MODULES = [
  { id: "shareholders",       label: "Shareholders",        color: "#6366f1" },
  { id: "clients",            label: "Clients",             color: "#a855f7" },
  { id: "contributions",      label: "Contributions",       color: "#ec4899" },
  { id: "projects",           label: "Projects",            color: "#22c55e" },
  { id: "investors",          label: "Ext. Investors",      color: "#eab308" },
  { id: "payments",           label: "M-Pesa Payments",     color: "#14b8a6" },
  { id: "mpesa-transactions", label: "M-Pesa Transactions", color: "#0ea5e9" },
  { id: "refunds",            label: "Refunds",             color: "#ef4444" },
  { id: "reports",            label: "Reports",             color: "#3b82f6" },
  { id: "my-plots",           label: "My Plots",            color: "#059669" },
  { id: "help",               label: "Help & Support",      color: "#8b5cf6" },
];


// ─── Backup & Restore (local + cloud) ─────────────────────────────────────────

const BACKUP_TABLES = [
  "shareholders", "contributions", "refunds", "payments",
  "projects", "plots", "plot_payments", "investors",
  "project_investments", "project_shareholders", "profit_distributions", "clients",
];

const CLOUD_CREDS_KEY = "sacco_cloud_backup_creds";

interface CloudCreds {
  googleClientId: string;
  dropboxAppKey: string;
  oneDriveClientId: string;
}

function getCloudCreds(): CloudCreds {
  try {
    return { googleClientId: "", dropboxAppKey: "", oneDriveClientId: "", ...JSON.parse(localStorage.getItem(CLOUD_CREDS_KEY) ?? "{}") };
  } catch {
    return { googleClientId: "", dropboxAppKey: "", oneDriveClientId: "" };
  }
}

function oauthPopup(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const popup = window.open(url, "sacco_oauth", "width=540,height=640,left=200,top=80");
    if (!popup) { reject(new Error("Popup blocked — allow popups for this page and try again.")); return; }
    const timer = setInterval(() => {
      try {
        if (popup.closed) { clearInterval(timer); reject(new Error("Auth window closed before completing.")); return; }
        const hash = popup.location?.hash ?? "";
        const search = popup.location?.search ?? "";
        const combined = hash.startsWith("#") ? hash.slice(1) : search.startsWith("?") ? search.slice(1) : "";
        if (!combined) return;
        const params = new URLSearchParams(combined);
        const token = params.get("access_token");
        if (token) { clearInterval(timer); popup.close(); resolve(token); }
        else if (params.get("error")) { clearInterval(timer); popup.close(); reject(new Error(params.get("error_description") ?? params.get("error") ?? "Auth error")); }
      } catch { /* cross-origin while provider page is loading */ }
    }, 300);
  });
}

async function buildBackupBlob(): Promise<{ blob: Blob; filename: string; totalRows: number }> {
  const snapshot: Record<string, any[]> = {};
  let totalRows = 0;
  for (const table of BACKUP_TABLES) {
    const { data } = await supabase.from(table as any).select("*");
    snapshot[table] = data ?? [];
    totalRows += (data ?? []).length;
  }
  const json = JSON.stringify({ version: 1, exported_at: new Date().toISOString(), tables: snapshot }, null, 2);
  const filename = `sacco_backup_${new Date().toISOString().slice(0, 10)}.json`;
  return { blob: new Blob([json], { type: "application/json" }), filename, totalRows };
}

async function driveUpload(token: string, blob: Blob, filename: string): Promise<void> {
  const meta = { name: filename, mimeType: "application/json", parents: [] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(meta)], { type: "application/json" }));
  form.append("file", blob);
  const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", {
    method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message ?? `Drive error ${res.status}`); }
}

async function dropboxUpload(token: string, blob: Blob, filename: string): Promise<void> {
  const res = await fetch("https://content.dropboxapi.com/2/files/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Dropbox-API-Arg": JSON.stringify({ path: `/SaccoBackups/${filename}`, mode: "overwrite", autorename: true }),
      "Content-Type": "application/octet-stream",
    },
    body: blob,
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error_summary ?? `Dropbox error ${res.status}`); }
}

async function oneDriveUpload(token: string, blob: Blob, filename: string): Promise<void> {
  const res = await fetch(`https://graph.microsoft.com/v1.0/me/drive/root:/SaccoBackups/${filename}:/content`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: blob,
  });
  if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e?.error?.message ?? `OneDrive error ${res.status}`); }
}

const CLOUD_PROVIDERS = [
  {
    id: "google" as const,
    label: "Google Drive",
    color: "#4285F4",
    bg: "#EFF6FF",
    logo: (
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none">
        <path d="M6.6 1.8 1.2 11l2.6 4.5 5.4-9.3z" fill="#4285F4"/>
        <path d="M17.4 1.8H6.6L4 6.2h10.8z" fill="#EA4335"/>
        <path d="M22.8 11l-5.4-9.2h-3l5.4 9.3z" fill="#FBBC05"/>
        <path d="M12 14.7l-2.8 4.8H17l2.6-4.5L17 11H7l2.8 4.8z" fill="#34A853"/>
        <path d="M1.2 11l2.6 4.5h15.8L22.8 11H1.2z" fill="#FBBC05" opacity=".6"/>
      </svg>
    ),
  },
  {
    id: "dropbox" as const,
    label: "Dropbox",
    color: "#0061FF",
    bg: "#EFF6FF",
    logo: (
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path d="M12 6.5L6 10l6 3.5 6-3.5zm0 7L6 10l-6 3.5 6 3.5zm0 0L6 17l6 3.5 6-3.5zm0-7L18 10l6-3.5-6-3.5z" fill="#0061FF"/>
      </svg>
    ),
  },
  {
    id: "onedrive" as const,
    label: "OneDrive",
    color: "#0078D4",
    bg: "#EFF6FF",
    logo: (
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path d="M6.5 18a4.5 4.5 0 0 1-.5-9 6 6 0 0 1 11.8-1A4 4 0 0 1 20 16a3.5 3.5 0 0 1-.5 2H6.5z" fill="#0078D4"/>
      </svg>
    ),
  },
];

function BackupRestoreCard() {
  const [backing, setBacking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [localResult, setLocalResult] = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [cloudCreds, setCloudCreds] = useState<CloudCreds>(getCloudCreds);
  const [showConfig, setShowConfig] = useState(false);
  const [cloudState, setCloudState] = useState<Record<string, { loading: boolean; msg: string | null; ok: boolean }>>({
    google: { loading: false, msg: null, ok: false },
    dropbox: { loading: false, msg: null, ok: false },
    onedrive: { loading: false, msg: null, ok: false },
  });
  const fileRef = useRef<HTMLInputElement>(null);

  const setCloud = (id: string, patch: Partial<{ loading: boolean; msg: string | null; ok: boolean }>) =>
    setCloudState((s) => ({ ...s, [id]: { ...s[id], ...patch } }));

  const saveCreds = (creds: CloudCreds) => {
    setCloudCreds(creds);
    localStorage.setItem(CLOUD_CREDS_KEY, JSON.stringify(creds));
  };

  const handleBackup = async () => {
    setBacking(true); setLocalResult(null);
    try {
      const { blob, filename, totalRows } = await buildBackupBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
      URL.revokeObjectURL(url);
      setLocalResult({ type: "success", msg: `Downloaded ${filename} — ${totalRows} records` });
    } catch (e: any) { setLocalResult({ type: "error", msg: e?.message ?? "Backup failed" }); }
    finally { setBacking(false); }
  };

  const handleRestore = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]; if (!file) return;
    e.target.value = ""; setRestoring(true); setLocalResult(null);
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed?.tables) throw new Error("Invalid backup file.");
      let total = 0;
      for (const table of BACKUP_TABLES) {
        const rows: any[] = parsed.tables[table];
        if (!Array.isArray(rows) || rows.length === 0) continue;
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await supabase.from(table as any).upsert(rows.slice(i, i + 500), { onConflict: "id" });
          if (error) throw new Error(`${table}: ${error.message}`);
          total += Math.min(500, rows.length - i);
        }
      }
      setLocalResult({ type: "success", msg: `Restore complete — ${total} records imported.` });
    } catch (e: any) { setLocalResult({ type: "error", msg: e?.message ?? "Restore failed" }); }
    finally { setRestoring(false); }
  };

  const handleCloudUpload = async (provider: typeof CLOUD_PROVIDERS[number]) => {
    setCloud(provider.id, { loading: true, msg: null, ok: false });
    try {
      const { blob, filename, totalRows } = await buildBackupBlob();
      const redirectUri = window.location.href.split("?")[0].split("#")[0];
      let token: string;
      if (provider.id === "google") {
        if (!cloudCreds.googleClientId.trim()) throw new Error("Enter your Google Client ID in Configure below.");
        token = await oauthPopup(`https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(cloudCreds.googleClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent("https://www.googleapis.com/auth/drive.file")}&prompt=select_account`);
        await driveUpload(token, blob, filename);
      } else if (provider.id === "dropbox") {
        if (!cloudCreds.dropboxAppKey.trim()) throw new Error("Enter your Dropbox App Key in Configure below.");
        token = await oauthPopup(`https://www.dropbox.com/oauth2/authorize?client_id=${encodeURIComponent(cloudCreds.dropboxAppKey)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&token_access_type=legacy`);
        await dropboxUpload(token, blob, filename);
      } else {
        if (!cloudCreds.oneDriveClientId.trim()) throw new Error("Enter your OneDrive Client ID in Configure below.");
        token = await oauthPopup(`https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=${encodeURIComponent(cloudCreds.oneDriveClientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=token&scope=${encodeURIComponent("files.readwrite offline_access")}&prompt=select_account`);
        await oneDriveUpload(token, blob, filename);
      }
      setCloud(provider.id, { loading: false, msg: `Uploaded ${filename} (${totalRows} records)`, ok: true });
    } catch (e: any) {
      setCloud(provider.id, { loading: false, msg: e?.message ?? "Upload failed", ok: false });
    }
  };

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-5" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#eff6ff" }}>
          <Database size={16} color="#2563eb" />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Backup & Restore</div>
          <div className="text-xs text-gray-400">Download a full backup or upload to cloud storage.</div>
        </div>
      </div>

      {/* Local backup / restore */}
      <div className="grid grid-cols-2 gap-3">
        <button onClick={handleBackup} disabled={backing}
          className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold text-white disabled:opacity-60 hover:opacity-90 transition-opacity"
          style={{ background: "#2563eb" }}>
          {backing ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
          {backing ? "Exporting…" : "Download Backup"}
        </button>
        <button onClick={() => fileRef.current?.click()} disabled={restoring}
          className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-xs font-bold border disabled:opacity-60 hover:bg-gray-50 transition-colors"
          style={{ borderColor: "#d1d5db", color: "#374151" }}>
          {restoring ? <Loader2 size={13} className="animate-spin" /> : <UploadCloud size={13} />}
          {restoring ? "Restoring…" : "Restore from File"}
        </button>
      </div>
      <input ref={fileRef} type="file" accept=".json" className="hidden" onChange={handleRestore} />

      {localResult && (
        <div className={`flex items-start gap-2 rounded-xl px-3 py-2.5 text-xs ${localResult.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {localResult.type === "success" ? <CheckCircle size={13} className="flex-shrink-0 mt-0.5" /> : <XCircle size={13} className="flex-shrink-0 mt-0.5" />}
          <span className="font-medium flex-1">{localResult.msg}</span>
          <button onClick={() => setLocalResult(null)}><X size={12} className="text-gray-400" /></button>
        </div>
      )}

      {/* Divider */}
      <div className="flex items-center gap-3">
        <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
        <span className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Cloud Upload</span>
        <div className="flex-1 h-px" style={{ background: "var(--border)" }} />
      </div>

      {/* Cloud provider buttons */}
      <div className="space-y-2">
        {CLOUD_PROVIDERS.map((p) => {
          const s = cloudState[p.id];
          return (
            <div key={p.id} className="rounded-xl border p-3 flex items-center gap-3" style={{ borderColor: "var(--border)" }}>
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: p.bg }}>
                {p.logo}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-bold" style={{ color: "#1a202c" }}>{p.label}</div>
                {s.msg && (
                  <div className={`text-[10px] mt-0.5 truncate ${s.ok ? "text-green-600" : "text-red-500"}`}>{s.msg}</div>
                )}
                {!s.msg && <div className="text-[10px] text-gray-400">Saves to <span className="font-mono">SaccoBackups/</span> folder</div>}
              </div>
              <button onClick={() => handleCloudUpload(p)} disabled={s.loading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60 hover:opacity-90 transition-opacity flex-shrink-0"
                style={{ background: p.color }}>
                {s.loading ? <Loader2 size={11} className="animate-spin" /> : <Cloud size={11} />}
                {s.loading ? "Uploading…" : "Upload"}
              </button>
            </div>
          );
        })}
      </div>

      {/* Configure credentials toggle */}
      <button onClick={() => setShowConfig((v) => !v)}
        className="flex items-center gap-2 text-xs font-semibold text-gray-500 hover:text-gray-700 transition-colors w-full">
        <Settings2 size={12} />
        Configure Cloud Credentials
        {showConfig ? <ChevronDown size={12} className="ml-auto" /> : <ChevronRight size={12} className="ml-auto" />}
      </button>

      {showConfig && (
        <div className="space-y-3 pt-1">
          {[
            { label: "Google Client ID", key: "googleClientId" as keyof CloudCreds, hint: "Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID (Web app)" },
            { label: "Dropbox App Key", key: "dropboxAppKey" as keyof CloudCreds, hint: "Dropbox Developers → Your apps → App key" },
            { label: "OneDrive Client ID", key: "oneDriveClientId" as keyof CloudCreds, hint: "Azure Portal → App registrations → Application (client) ID" },
          ].map((f) => (
            <div key={f.key}>
              <label className="text-[10px] font-bold text-gray-600 block mb-1">{f.label}</label>
              <input
                type="text"
                value={cloudCreds[f.key]}
                onChange={(e) => saveCreds({ ...cloudCreds, [f.key]: e.target.value })}
                placeholder="Paste here…"
                className="w-full border rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none"
                style={{ borderColor: "var(--border)" }}
              />
              <p className="text-[9px] text-gray-400 mt-0.5">{f.hint}</p>
            </div>
          ))}
          <p className="text-[9px] text-gray-400 leading-relaxed bg-amber-50 rounded-lg px-2.5 py-2 border border-amber-100">
            <strong>Redirect URI</strong> — add <span className="font-mono break-all">{typeof window !== "undefined" ? window.location.href.split("?")[0].split("#")[0] : "this page's URL"}</span> as an authorised redirect URI in each provider's app settings.
          </p>
        </div>
      )}
    </div>
  );
}

// ─── View Settings per role ────────────────────────────────────────────────────
const VIEW_SETTINGS_KEY_PREFIX = "sacco_view_settings";
function viewSettingsKey(role: string) { return `${VIEW_SETTINGS_KEY_PREFIX}_${role}`; }

interface ViewSetting { id: string; label: string; desc: string }
const VIEW_SETTINGS_BY_ROLE: Record<string, ViewSetting[]> = {
  admin: [
    { id: "stat_members",       label: "Members Stats",       desc: "Total members & clients count card" },
    { id: "stat_contributions", label: "Contributions Stats", desc: "Total contributions summary card" },
    { id: "stat_revenue",       label: "Revenue / Profit",    desc: "Revenue & profit overview card" },
    { id: "stat_plots",         label: "Plots Stats",         desc: "Plots sold & available card" },
    { id: "pending_panel",      label: "Pending Items",       desc: "Pending approvals & tasks panel" },
    { id: "recent_activity",    label: "Recent Activity",     desc: "Recent transactions feed" },
    { id: "member_dist_chart",  label: "Member Distribution", desc: "Pie chart of member role breakdown" },
    { id: "revenue_chart",      label: "Revenue Chart",       desc: "Monthly revenue trend chart" },
  ],
  shareholder: [
    { id: "net_savings_card",   label: "Net Savings Card",    desc: "Net savings summary at top" },
    { id: "quick_actions",      label: "Quick Actions",       desc: "Pay & view shortcut buttons row" },
    { id: "contribution_trend", label: "Contribution Trend",  desc: "Bar chart of monthly contributions" },
    { id: "profit_dists",       label: "Profit Distributions",desc: "Profit payout history list" },
    { id: "payment_history",    label: "Payment History",     desc: "Monthly plot payment chart" },
  ],
  client: [
    { id: "quick_actions",        label: "Quick Actions",       desc: "Pay & view shortcut buttons row" },
    { id: "payment_history",      label: "Payment History",     desc: "Monthly payment history chart" },
    { id: "plot_payments_card",   label: "Plot Payments",       desc: "Per-plot payment progress bars" },
    { id: "plot_payment_summary", label: "Payment Summary",     desc: "Total paid / in-progress card" },
    { id: "loan_overview",        label: "Loan Overview",       desc: "Active loan summary card" },
  ],
  investor: [
    { id: "investment_summary", label: "Investment Summary",  desc: "Total invested & expected returns" },
    { id: "project_overview",   label: "Project Overview",    desc: "Active projects cards" },
    { id: "returns_chart",      label: "Returns Chart",       desc: "Projected vs actual returns chart" },
    { id: "quick_actions",      label: "Quick Actions",       desc: "Quick action shortcut buttons" },
  ],
};

function getViewSettings(role: string): string[] {
  try { return JSON.parse(localStorage.getItem(viewSettingsKey(role)) ?? "[]"); } catch { return []; }
}

function ModuleVisibilityCard() {
  const [activeRole, setActiveRole] = useState<string>("admin");
  const [activeSection, setActiveSection] = useState<"modules" | "view">("modules");
  const [hiddenByRole, setHiddenByRole] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ROLE_TABS.map((t) => [t.role, getHiddenIds(t.role)]))
  );
  const [hiddenWidgetsByRole, setHiddenWidgetsByRole] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(ROLE_TABS.map((t) => [t.role, getViewSettings(t.role)]))
  );
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [loadError, setLoadError] = useState("");

  // Load cloud settings on mount and merge into local state
  useEffect(() => {
    Promise.all([
      supabase.from("app_settings").select("value").eq("key", "module_visibility").maybeSingle(),
      supabase.from("app_settings").select("value").eq("key", "view_settings").maybeSingle(),
    ]).then(([modRow, viewRow]) => {
      const roles = ROLE_TABS.map((t) => t.role);
      if (modRow.data?.value) {
        const map = modRow.data.value as Record<string, string[]>;
        const merged = Object.fromEntries(roles.map((r) => [r, Array.isArray(map[r]) ? map[r] : getHiddenIds(r)]));
        setHiddenByRole(merged);
        roles.forEach((r) => localStorage.setItem(hiddenModulesKey(r), JSON.stringify(merged[r])));
        window.dispatchEvent(new Event("hidden-modules-changed"));
      }
      if (viewRow.data?.value) {
        const map = viewRow.data.value as Record<string, string[]>;
        const merged = Object.fromEntries(roles.map((r) => [r, Array.isArray(map[r]) ? map[r] : getViewSettings(r)]));
        setHiddenWidgetsByRole(merged);
        roles.forEach((r) => localStorage.setItem(viewSettingsKey(r), JSON.stringify(merged[r])));
        window.dispatchEvent(new Event("view-settings-changed"));
      }
    }).catch(() => {});
  }, []);

  const hidden = hiddenByRole[activeRole] ?? [];
  const hiddenWidgets = hiddenWidgetsByRole[activeRole] ?? [];
  const tab = ROLE_TABS.find((t) => t.role === activeRole)!;
  const viewItems = VIEW_SETTINGS_BY_ROLE[activeRole] ?? [];

  const toggleModule = (id: string) => {
    const cur = hiddenByRole[activeRole] ?? [];
    const next = cur.includes(id) ? cur.filter((h) => h !== id) : [...cur, id];
    setHiddenByRole((prev) => ({ ...prev, [activeRole]: next }));
    localStorage.setItem(hiddenModulesKey(activeRole), JSON.stringify(next));
    window.dispatchEvent(new Event("hidden-modules-changed"));
  };

  const toggleWidget = (id: string) => {
    const cur = hiddenWidgetsByRole[activeRole] ?? [];
    const next = cur.includes(id) ? cur.filter((h) => h !== id) : [...cur, id];
    setHiddenWidgetsByRole((prev) => ({ ...prev, [activeRole]: next }));
    localStorage.setItem(viewSettingsKey(activeRole), JSON.stringify(next));
    window.dispatchEvent(new Event("view-settings-changed"));
  };

  const handleSave = async () => {
    setSaving(true);
    setLoadError("");
    const moduleMap = Object.fromEntries(ROLE_TABS.map((t) => [t.role, hiddenByRole[t.role] ?? []]));
    const viewMap   = Object.fromEntries(ROLE_TABS.map((t) => [t.role, hiddenWidgetsByRole[t.role] ?? []]));
    const now = new Date().toISOString();
    const [e1, e2] = await Promise.all([
      supabase.from("app_settings").upsert({ key: "module_visibility", value: moduleMap, updated_at: now }, { onConflict: "key" }),
      supabase.from("app_settings").upsert({ key: "view_settings",     value: viewMap,   updated_at: now }, { onConflict: "key" }),
    ]);
    setSaving(false);
    if (e1.error || e2.error) {
      setLoadError((e1.error ?? e2.error)?.message ?? "Save failed");
    } else {
      setSavedAt(new Date());
    }
  };

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#f0f9ff" }}>
          <SlidersHorizontal size={18} color="#0ea5e9" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Module Visibility & View Settings</div>
          <div className="text-xs text-gray-400 mt-0.5">Configure navigation and dashboard widgets per role.</div>
        </div>
        {/* Save button */}
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white flex-shrink-0 disabled:opacity-60 hover:opacity-90 transition-opacity"
          style={{ background: savedAt && !saving ? "#16a34a" : "#0ea5e9" }}>
          {saving
            ? <><Loader2 size={13} className="animate-spin" /> Saving…</>
            : savedAt
              ? <><CheckCircle size={13} /> Saved</>
              : <><Cloud size={13} /> Save</>}
        </button>
      </div>
      {loadError && <p className="text-xs text-red-500">{loadError}</p>}
      {savedAt && !saving && (
        <p className="text-[11px] text-green-600">Saved to cloud · syncs across all devices & users</p>
      )}

      {/* Role tabs */}
      <div className="flex gap-1 p-1 rounded-xl" style={{ background: "#f1f5f9" }}>
        {ROLE_TABS.map((t) => (
          <button key={t.role} onClick={() => setActiveRole(t.role)}
            className="flex-1 py-1.5 px-1 rounded-lg text-[11px] font-semibold transition-all"
            style={activeRole === t.role
              ? { background: "#fff", color: t.color, boxShadow: "0 1px 4px rgba(0,0,0,0.10)" }
              : { color: "#64748b" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Section sub-tabs: Navigation vs View Settings */}
      <div className="flex gap-2">
        <button onClick={() => setActiveSection("modules")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border"
          style={activeSection === "modules"
            ? { background: tab.color, color: "#fff", borderColor: tab.color }
            : { background: "#f8fafc", color: "#64748b", borderColor: "#e2e8f0" }}>
          <LayoutDashboard size={11} /> Navigation Modules
        </button>
        <button onClick={() => setActiveSection("view")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold transition-all border"
          style={activeSection === "view"
            ? { background: tab.color, color: "#fff", borderColor: tab.color }
            : { background: "#f8fafc", color: "#64748b", borderColor: "#e2e8f0" }}>
          <SlidersHorizontal size={11} /> View Settings
        </button>
      </div>

      {/* ── Navigation Modules panel ── */}
      {activeSection === "modules" && (
        <div className="space-y-3">
          <p className="text-[11px] text-gray-400">
            {activeRole === "admin"
              ? "Dashboard & Settings are always visible to Admins."
              : `Controls which nav items ${tab.label}s see after login.`}
          </p>
          <div className="grid grid-cols-2 gap-2">
            {ALL_MODULES.map((m) => {
              const isHidden = hidden.includes(m.id);
              return (
                <button key={m.id} onClick={() => toggleModule(m.id)}
                  className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border text-left transition-all"
                  style={{
                    borderColor: isHidden ? "#e2e8f0" : m.color,
                    background: isHidden ? "#f8fafc" : `${m.color}12`,
                  }}>
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: isHidden ? "#cbd5e1" : m.color }} />
                  <span className="flex-1 text-xs font-semibold" style={{ color: isHidden ? "#94a3b8" : "#1a202c" }}>{m.label}</span>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: isHidden ? "#e2e8f0" : `${m.color}20`, color: isHidden ? "#94a3b8" : m.color }}>
                    {isHidden ? "Hidden" : "Visible"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* ── View Settings panel ── */}
      {activeSection === "view" && (
        <div className="space-y-3">
          <p className="text-[11px] text-gray-400">
            Toggle which dashboard cards and widgets appear in the <span className="font-semibold capitalize">{tab.label}</span> view.
          </p>
          <div className="space-y-2">
            {viewItems.map((w) => {
              const isHidden = hiddenWidgets.includes(w.id);
              return (
                <button key={w.id} onClick={() => toggleWidget(w.id)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl border text-left transition-all"
                  style={{
                    borderColor: isHidden ? "#e2e8f0" : tab.color,
                    background: isHidden ? "#f8fafc" : `${tab.color}0d`,
                  }}>
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: isHidden ? "#cbd5e1" : tab.color }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold" style={{ color: isHidden ? "#94a3b8" : "#1a202c" }}>{w.label}</div>
                    <div className="text-[10px] mt-0.5 leading-tight" style={{ color: "#94a3b8" }}>{w.desc}</div>
                  </div>
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                    style={{ background: isHidden ? "#e2e8f0" : `${tab.color}20`, color: isHidden ? "#94a3b8" : tab.color }}>
                    {isHidden ? "Hidden" : "Shown"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const MAINTENANCE_PASSWORD = "cat";

function SystemLiveCard() {
  const [isLive, setIsLive] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "system_live").maybeSingle()
      .then(({ data }) => setIsLive(data?.value === true || data?.value === "true"));
  }, []);

  const toggle = async () => {
    const next = !isLive;
    setSaving(true);
    await supabase.from("app_settings").upsert({ key: "system_live", value: next, updated_at: new Date().toISOString() }, { onConflict: "key" });
    setIsLive(next);
    setSaving(false);
  };

  if (isLive === null) return null;

  return (
    <div className="bg-white rounded-2xl border-2 p-5 flex items-center gap-4"
      style={{ borderColor: isLive ? "#16a34a" : "#f59e0b", background: isLive ? "#f0fdf4" : "#fffbeb" }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
        style={{ background: isLive ? "#dcfce7" : "#fef3c7" }}>
        <span className="text-xl">{isLive ? "🟢" : "🔴"}</span>
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold" style={{ color: "#1a202c" }}>
          System Status: <span style={{ color: isLive ? "#16a34a" : "#d97706" }}>{isLive ? "LIVE" : "Development / Testing"}</span>
        </div>
        <div className="text-xs mt-0.5" style={{ color: isLive ? "#15803d" : "#92400e" }}>
          {isLive
            ? "System is live and accessible to all users."
            : "System is in development mode. A banner is shown to all users."}
        </div>
      </div>
      <button onClick={toggle} disabled={saving}
        className="flex-shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-60 hover:opacity-90 transition-opacity"
        style={{ background: isLive ? "#dc2626" : "#16a34a" }}>
        {saving ? <Loader2 size={13} className="animate-spin" /> : null}
        {isLive ? "Set to Development" : "Go LIVE"}
      </button>
    </div>
  );
}

// ─── Admin Reset Password Card ────────────────────────────────────────────────

interface UserProfileRow {
  id: string;
  full_name: string;
  email: string;
  role: string;
  member_id: number | null;
  member_number?: number | null;
}

// ─── DeletePlotPaymentCard ────────────────────────────────────────────────────

interface MemberOption {
  id: number;
  name: string;
  member_number: string | number;
  type: "shareholder" | "client";
}

function DeletePlotPaymentCard() {
  const [search, setSearch]             = useState("");
  const [members, setMembers]           = useState<MemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [selected, setSelected]         = useState<MemberOption | null>(null);
  const [dropOpen, setDropOpen]         = useState(false);
  const [plots, setPlots]               = useState<Plot[]>([]);
  const [loadingPlots, setLoadingPlots] = useState(false);
  const [expandedPlotId, setExpandedPlotId] = useState<number | null>(null);
  const [payments, setPayments]         = useState<Record<number, PlotPayment[]>>({});
  const [loadingPayId, setLoadingPayId] = useState<number | null>(null);
  const [confirmId, setConfirmId]       = useState<number | null>(null);
  const [deletingId, setDeletingId]     = useState<number | null>(null);
  const [confirmDeleteAllPlotId, setConfirmDeleteAllPlotId] = useState<number | null>(null);
  const [deletingAllPlotId, setDeletingAllPlotId]           = useState<number | null>(null);
  const [msg, setMsg]                   = useState<{ ok: boolean; text: string } | null>(null);
  const searchRef                       = useRef<HTMLInputElement>(null);

  // Search members (shareholders + clients)
  useEffect(() => {
    if (!search.trim()) { setMembers([]); setDropOpen(false); return; }
    const q = search.trim().toLowerCase();
    setLoadingMembers(true);
    Promise.all([
      supabase.from("shareholders").select("id, name, member_number").ilike("name", `%${q}%`).limit(8),
      supabase.from("clients").select("id, name, member_number").ilike("name", `%${q}%`).limit(8),
    ]).then(([{ data: sh }, { data: cl }]) => {
      const opts: MemberOption[] = [
        ...(sh || []).map((r: any) => ({ id: r.id, name: r.name, member_number: r.member_number, type: "shareholder" as const })),
        ...(cl || []).map((r: any) => ({ id: r.id, name: r.name, member_number: r.member_number, type: "client" as const })),
      ];
      setMembers(opts);
      setDropOpen(opts.length > 0);
    }).finally(() => setLoadingMembers(false));
  }, [search]);

  const pickMember = async (m: MemberOption) => {
    setSelected(m);
    setSearch(m.name);
    setDropOpen(false);
    setPlots([]);
    setPayments({});
    setExpandedPlotId(null);
    setMsg(null);
    setLoadingPlots(true);
    try {
      const { data } = await supabase
        .from("plots")
        .select("*, project:projects(project_name)")
        .eq("assigned_to_id", m.id)
        .eq("assigned_to_type", m.type);
      setPlots(data ?? []);
    } catch { /* ignore */ }
    finally { setLoadingPlots(false); }
  };

  const togglePlot = async (plotId: number) => {
    if (expandedPlotId === plotId) { setExpandedPlotId(null); return; }
    setExpandedPlotId(plotId);
    if (payments[plotId]) return;
    setLoadingPayId(plotId);
    try {
      const data = await plotPaymentsApi.listByPlot(plotId);
      setPayments((prev) => ({ ...prev, [plotId]: data }));
    } catch { /* ignore */ }
    finally { setLoadingPayId(null); }
  };

  const handleDelete = async (paymentId: number, plotId: number) => {
    setDeletingId(paymentId);
    try {
      await plotPaymentsApi.remove(paymentId);
      setPayments((prev) => ({
        ...prev,
        [plotId]: (prev[plotId] ?? []).filter((p) => p.id !== paymentId),
      }));
      // Refresh plot paid_amount
      const { data: refreshed } = await supabase.from("plots").select("paid_amount").eq("id", plotId).single();
      if (refreshed) {
        setPlots((prev) => prev.map((pl) => pl.id === plotId ? { ...pl, paid_amount: refreshed.paid_amount } : pl));
      }
      setMsg({ ok: true, text: "Payment deleted successfully." });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Failed to delete payment." });
    } finally {
      setDeletingId(null);
      setConfirmId(null);
    }
  };

  const handleDeleteAll = async (plotId: number) => {
    setDeletingAllPlotId(plotId);
    try {
      const pays = payments[plotId] ?? [];
      await Promise.all(pays.map((p) => plotPaymentsApi.remove(p.id)));
      setPayments((prev) => ({ ...prev, [plotId]: [] }));
      const { data: refreshed } = await supabase.from("plots").select("paid_amount").eq("id", plotId).single();
      if (refreshed) {
        setPlots((prev) => prev.map((pl) => pl.id === plotId ? { ...pl, paid_amount: refreshed.paid_amount } : pl));
      }
      setMsg({ ok: true, text: `All ${pays.length} payment${pays.length !== 1 ? "s" : ""} deleted.` });
    } catch (e: any) {
      setMsg({ ok: false, text: e.message ?? "Failed to delete payments." });
    } finally {
      setDeletingAllPlotId(null);
      setConfirmDeleteAllPlotId(null);
    }
  };

  const fmtDate = (s: string) => new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const fmtAmt  = (n: number) => `KES ${Number(n).toLocaleString("en-KE", { minimumFractionDigits: 2 })}`;

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
          <Trash2 size={18} color="#ef4444" />
        </div>
        <div>
          <div className="text-sm font-bold" style={{ color: "#1a202c" }}>Delete Plot Payment</div>
          <div className="text-xs text-gray-400 mt-0.5">Search a shareholder or client and delete a specific plot payment record.</div>
        </div>
      </div>

      {/* Member search */}
      <div className="relative">
        <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Search Member</label>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            placeholder="Type member name…"
            onChange={(e) => { setSearch(e.target.value); setSelected(null); setPlots([]); setMsg(null); }}
            onFocus={() => { if (members.length > 0) setDropOpen(true); }}
            className="w-full pl-8 pr-8 py-2.5 rounded-xl border text-sm focus:outline-none transition-all"
            style={{ borderColor: "#e2e8f0" }}
          />
          {loadingMembers && <Loader2 size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 animate-spin" />}
          {search && !loadingMembers && (
            <button onClick={() => { setSearch(""); setSelected(null); setPlots([]); setMembers([]); setDropOpen(false); setMsg(null); }}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
              <X size={13} />
            </button>
          )}
        </div>

        {/* Dropdown */}
        {dropOpen && members.length > 0 && (
          <div className="absolute z-20 mt-1 w-full rounded-xl border bg-white shadow-lg overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
            {members.map((m) => (
              <button key={`${m.type}-${m.id}`} onClick={() => pickMember(m)}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-indigo-50 text-left transition-colors border-b last:border-b-0"
                style={{ borderColor: "#f1f5f9" }}>
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                  style={{ background: m.type === "shareholder" ? "#dbeafe" : "#fef3c7", color: m.type === "shareholder" ? "#1d4ed8" : "#b45309" }}>
                  {m.type === "shareholder" ? "SH" : "CL"}
                </span>
                <span className="text-sm font-medium flex-1 truncate" style={{ color: "#1a202c" }}>{m.name}</span>
                <span className="text-[10px] text-gray-400 flex-shrink-0">#{m.member_number}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Selected chip */}
      {selected && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-xl" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
            style={{ background: selected.type === "shareholder" ? "#dbeafe" : "#fef3c7", color: selected.type === "shareholder" ? "#1d4ed8" : "#b45309" }}>
            {selected.type === "shareholder" ? "Shareholder" : "Client"}
          </span>
          <span className="text-sm font-semibold flex-1" style={{ color: "#1a202c" }}>{selected.name}</span>
          <span className="text-xs text-gray-400">#{selected.member_number}</span>
        </div>
      )}

      {/* Plots list */}
      {loadingPlots && (
        <div className="flex justify-center py-4"><Loader2 size={16} className="animate-spin text-gray-300" /></div>
      )}
      {selected && !loadingPlots && plots.length === 0 && (
        <p className="text-xs text-gray-400 italic text-center py-3">No plots assigned to this member.</p>
      )}
      {plots.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Plots ({plots.length})</p>
          {plots.map((pl) => (
            <div key={pl.id} className="rounded-xl border overflow-hidden" style={{ borderColor: "#e2e8f0" }}>
              {/* Plot row */}
              <button
                onClick={() => togglePlot(pl.id)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors text-left"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-bold" style={{ color: "#1a202c" }}>{pl.plot_number}</p>
                  <p className="text-[11px] text-gray-400">{(pl.project as any)?.project_name ?? "—"}</p>
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="text-xs font-semibold" style={{ color: "#16a34a" }}>
                    KES {Number(pl.paid_amount).toLocaleString("en-KE")} paid
                  </p>
                  <p className="text-[10px] text-gray-400">
                    of KES {Number(pl.price).toLocaleString("en-KE")}
                  </p>
                </div>
                {loadingPayId === pl.id
                  ? <Loader2 size={13} className="animate-spin text-gray-300 flex-shrink-0" />
                  : expandedPlotId === pl.id
                    ? <ChevronDown size={13} className="text-gray-400 flex-shrink-0" />
                    : <ChevronRight size={13} className="text-gray-400 flex-shrink-0" />
                }
              </button>

              {/* Payments panel */}
              {expandedPlotId === pl.id && (
                <div className="border-t" style={{ borderColor: "#e2e8f0" }}>
                  {(payments[pl.id] ?? []).length === 0 ? (
                    <p className="px-4 py-3 text-xs text-gray-400 italic">No payment records.</p>
                  ) : (
                    <>
                      {/* Table header + Delete All */}
                      <div className="flex items-center">
                        <div className="grid flex-1 px-4 py-1.5 text-[10px] font-semibold text-white"
                          style={{ gridTemplateColumns: "1fr 1fr 1fr auto", background: "#1e3a5f" }}>
                          <span>Date</span>
                          <span>Amount</span>
                          <span>Notes</span>
                          <span />
                        </div>
                        {confirmDeleteAllPlotId === pl.id ? (
                          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-700 flex-shrink-0">
                            <span className="text-[10px] text-white font-semibold">Sure?</span>
                            <button
                              onClick={() => handleDeleteAll(pl.id)}
                              disabled={deletingAllPlotId === pl.id}
                              className="text-[10px] font-bold px-2 py-0.5 rounded bg-white text-red-700 disabled:opacity-50 flex items-center gap-1">
                              {deletingAllPlotId === pl.id ? <Loader2 size={9} className="animate-spin" /> : "Yes"}
                            </button>
                            <button onClick={() => setConfirmDeleteAllPlotId(null)}
                              className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-500 text-white">
                              No
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDeleteAllPlotId(pl.id)}
                            className="flex items-center gap-1 px-3 py-1.5 text-[10px] font-bold text-white hover:bg-red-800 transition-colors flex-shrink-0"
                            style={{ background: "#1e3a5f" }}>
                            <Trash2 size={10} /> Delete All
                          </button>
                        )}
                      </div>
                      {(payments[pl.id] ?? []).map((pay, i) => {
                        let note = pay.notes || "—";
                        try {
                          const parsed = JSON.parse(pay.notes ?? "");
                          if (parsed?.note) note = parsed.note;
                          else if (parsed?.method) note = parsed.method;
                        } catch { /* plain text */ }
                        return (
                          <div key={pay.id}
                            className="grid px-4 py-2 items-center text-xs border-b last:border-b-0"
                            style={{ gridTemplateColumns: "1fr 1fr 1fr auto", background: i % 2 === 0 ? "#f8fafc" : "#fff", borderColor: "#f1f5f9" }}>
                            <span className="text-gray-600">{fmtDate(pay.payment_date || pay.created_at)}</span>
                            <span className="font-bold text-green-600">{fmtAmt(Number(pay.amount))}</span>
                            <span className="text-gray-400 truncate pr-2">{note}</span>
                            <div className="flex items-center gap-1">
                              {confirmId === pay.id ? (
                                <>
                                  <button
                                    onClick={() => handleDelete(pay.id, pl.id)}
                                    disabled={deletingId === pay.id}
                                    className="text-[10px] font-bold px-2 py-1 rounded-lg text-white disabled:opacity-50"
                                    style={{ background: "#ef4444" }}>
                                    {deletingId === pay.id ? <Loader2 size={10} className="animate-spin" /> : "Delete"}
                                  </button>
                                  <button onClick={() => setConfirmId(null)}
                                    className="text-[10px] font-bold px-2 py-1 rounded-lg border"
                                    style={{ borderColor: "#e2e8f0", color: "#64748b" }}>
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <button onClick={() => setConfirmId(pay.id)}
                                  className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors"
                                  title="Delete payment">
                                  <Trash2 size={13} />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Status message */}
      {msg && (
        <div className="flex items-center gap-2 px-3 py-2.5 rounded-xl text-xs font-medium"
          style={{ background: msg.ok ? "#f0fdf4" : "#fef2f2", color: msg.ok ? "#16a34a" : "#dc2626", border: `1px solid ${msg.ok ? "#bbf7d0" : "#fecaca"}` }}>
          {msg.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
          {msg.text}
        </div>
      )}
    </div>
  );
}

// ─── AdminPasswordResetCard ───────────────────────────────────────────────────

// ─── Deleted Accounts Card ────────────────────────────────────────────────────

const RESET_ROLE_COLOR: Record<string, string> = {
  admin: "#6366f1", shareholder: "#16a34a", client: "#0ea5e9", investor: "#d97706",
};

function AdminPasswordResetCard() {
  const [users, setUsers]         = useState<UserProfileRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [search, setSearch]       = useState("");
  const [selected, setSelected]   = useState<UserProfileRow | null>(null);
  const [password, setPassword]   = useState("");
  const [showPw, setShowPw]       = useState(false);
  const [phone, setPhone]         = useState("");
  const [editPhone, setEditPhone] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [smsSending, setSmsSending] = useState(false);
  const [msg, setMsg]             = useState<{ ok: boolean; text: string } | null>(null);

  const genOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  useEffect(() => {
    Promise.all([
      supabase.from("user_profiles").select("id, full_name, email, role, member_id").order("full_name"),
      supabase.from("shareholders").select("id, member_number"),
      supabase.from("clients").select("id, member_number"),
    ]).then(([{ data: profiles }, { data: sh }, { data: cl }]) => {
      const numMap: Record<number, number> = {};
      (sh || []).forEach((r: any) => { numMap[r.id] = r.member_number; });
      (cl || []).forEach((r: any) => { numMap[r.id] = r.member_number; });
      const merged = (profiles || []).map((u: any) => ({
        ...u,
        member_number: u.member_id ? numMap[u.member_id] ?? null : null,
      }));
      setUsers(merged as UserProfileRow[]);
      setLoading(false);
    });
  }, []);

  const filtered = users.filter((u) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      u.full_name?.toLowerCase().includes(q) ||
      u.email?.toLowerCase().includes(q) ||
      (u.member_number != null && String(u.member_number).includes(q))
    );
  });

  const pickUser = async (u: UserProfileRow) => {
    setSelected(u);
    setSearch(u.full_name || u.email);
    setMsg(null); setShowPw(false); setEditPhone(false);
    setPassword(genOtp());
    const table = u.role === "shareholder" ? "shareholders"
                : u.role === "client"      ? "clients"
                : u.role === "investor"    ? "investors"
                : null;
    let ph = "";
    if (table && u.member_id) {
      const { data } = await supabase.from(table).select("phone").eq("id", u.member_id).maybeSingle();
      ph = (data as any)?.phone || "";
    }
    setPhone(ph || u.email || "");
  };

  const clearSelection = () => {
    setSelected(null); setSearch(""); setPassword(""); setPhone("");
    setShowPw(false); setEditPhone(false); setMsg(null);
  };

  const handleReset = async (withSms: boolean) => {
    if (!selected) return;
    if (!password.trim() || password.length < 6) { setMsg({ ok: false, text: "Password must be at least 6 characters." }); return; }
    setResetting(true); setMsg(null);
    try {
      const { data, error } = await supabase.rpc("admin_reset_password", {
        target_user_id: selected.id,
        new_password: password,
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Reset failed");

      if (withSms) {
        if (!phone.trim()) throw new Error("No phone number to send SMS to.");
        setSmsSending(true);
        const name = selected.full_name?.split(" ")[0] || "Member";
        const message = `Hi ${name}, your SACCO password has been reset. Temp password: ${password}. Login with your phone number and change it after login.`;
        await sendSms(phone.trim(), message);
        setMsg({ ok: true, text: `Password reset and SMS sent to ${phone.trim()}.` });
      } else {
        setMsg({ ok: true, text: "Password reset successfully. Member can log in with the new password." });
      }
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally { setResetting(false); setSmsSending(false); }
  };

  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-100";

  return (
    <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#f5f3ff" }}>
          <KeyRound size={18} color="#7c3aed" />
        </div>
        <div>
          <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Admin Password Reset</p>
          <p className="text-xs text-gray-400">Generate a temporary password for any member and optionally send it via SMS</p>
        </div>
      </div>

      {/* Search */}
      <div>
        <label className="text-xs font-semibold text-gray-500 block mb-1.5">Search member</label>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input className={inp} style={{ borderColor: "var(--border)", paddingLeft: "2rem" }}
            value={search}
            onChange={(e) => { setSearch(e.target.value); setSelected(null); setPassword(""); setPhone(""); setMsg(null); }}
            placeholder="Name or email…" />
        </div>

        {search && !selected && (
          <div className="mt-1 border rounded-xl overflow-hidden max-h-52 overflow-y-auto" style={{ borderColor: "var(--border)" }}>
            {loading
              ? <div className="px-4 py-3 text-xs text-gray-400">Loading…</div>
              : filtered.length === 0
                ? <div className="px-4 py-3 text-xs text-gray-400">No users found.</div>
                : filtered.map((u) => (
                  <button key={u.id} onClick={() => pickUser(u)}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-50 text-left border-b last:border-0"
                    style={{ borderColor: "#f1f5f9" }}>
                    <div className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 text-white text-[10px] font-bold"
                      style={{ background: RESET_ROLE_COLOR[u.role] || "#94a3b8" }}>
                      {(u.full_name || u.email || "?")[0].toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5">
                        <p className="text-xs font-semibold text-gray-800 truncate">{u.full_name || "—"}</p>
                        {u.member_number != null && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md flex-shrink-0"
                            style={{ background: "#f1f5f9", color: "#64748b" }}>#{u.member_number}</span>
                        )}
                      </div>
                      <p className="text-[10px] text-gray-400 truncate">{u.email}</p>
                    </div>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full text-white capitalize flex-shrink-0"
                      style={{ background: RESET_ROLE_COLOR[u.role] || "#94a3b8" }}>{u.role}</span>
                  </button>
                ))
            }
          </div>
        )}

        {selected && (
          <div className="mt-2 flex items-center gap-3 px-4 py-2.5 rounded-xl border"
            style={{ background: "#f5f3ff", borderColor: "#ddd6fe" }}>
            <div className="w-8 h-8 rounded-full flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
              style={{ background: RESET_ROLE_COLOR[selected.role] || "#94a3b8" }}>
              {(selected.full_name || selected.email || "?")[0].toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="text-sm font-bold text-violet-800 truncate">{selected.full_name || "—"}</p>
                {selected.member_number != null && (
                  <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-md flex-shrink-0"
                    style={{ background: "#ede9fe", color: "#7c3aed" }}>#{selected.member_number}</span>
                )}
              </div>
              <p className="text-[11px] text-violet-400 truncate">{selected.email} · <span className="capitalize">{selected.role}</span></p>
            </div>
            <button onClick={clearSelection} className="text-violet-300 hover:text-violet-600"><X size={14} /></button>
          </div>
        )}
      </div>

      {selected && (
        <>
          {/* Temp password */}
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1.5">Temporary Password</label>
            <div className="relative">
              <input
                type={showPw ? "text" : "password"}
                className={inp}
                style={{ borderColor: "var(--border)", paddingRight: "7rem", fontFamily: "monospace", letterSpacing: "0.15em" }}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setMsg(null); }}
                placeholder="Min 6 characters"
              />
              <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                <button type="button" onClick={() => { setPassword(genOtp()); setMsg(null); }}
                  className="p-1.5 rounded-lg hover:bg-violet-50" title="Generate new OTP">
                  <RefreshCw size={13} color="#7c3aed" />
                </button>
                <button type="button" onClick={() => setShowPw((v) => !v)}
                  className="p-1.5 rounded-lg hover:bg-gray-100">
                  {showPw ? <EyeOff size={13} color="#64748b" /> : <Eye size={13} color="#64748b" />}
                </button>
              </div>
            </div>
          </div>

          {/* Phone */}
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1.5">Send SMS to</label>
            <div className="flex items-center gap-2">
              {editPhone
                ? <input className={`${inp} flex-1`} style={{ borderColor: "var(--border)" }}
                    value={phone} onChange={(e) => setPhone(e.target.value)}
                    placeholder="e.g. 0712345678" />
                : <div className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-semibold"
                    style={{ borderColor: "var(--border)", color: "#1a202c" }}>
                    <Phone size={13} color="#7c3aed" />
                    <span className="truncate">{phone || <span className="text-gray-400 font-normal text-xs">No phone on record</span>}</span>
                  </div>
              }
              <button onClick={() => setEditPhone((v) => !v)}
                className="flex-shrink-0 flex items-center gap-1 text-xs font-bold px-3 py-2 rounded-xl border hover:bg-gray-50"
                style={{ borderColor: "var(--border)", color: "#7c3aed" }}>
                <Edit2 size={11} /> {editPhone ? "Done" : "Edit"}
              </button>
            </div>
          </div>

          {msg && (
            <div className={`rounded-xl px-4 py-3 flex items-start gap-2 ${msg.ok ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
              {msg.ok ? <CheckCircle size={13} color="#16a34a" className="mt-0.5 flex-shrink-0" /> : <XCircle size={13} color="#dc2626" className="mt-0.5 flex-shrink-0" />}
              <span className={`text-xs font-medium ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>
            </div>
          )}

          <div className="flex gap-2">
            <button onClick={() => handleReset(false)} disabled={resetting || smsSending}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-sm font-semibold disabled:opacity-50 hover:bg-gray-50"
              style={{ borderColor: "var(--border)", color: "#475569" }}>
              {resetting && !smsSending ? <><Loader2 size={13} className="animate-spin" /> Resetting…</> : <><KeyRound size={13} /> Reset Password</>}
            </button>
            <button onClick={() => handleReset(true)} disabled={resetting || smsSending || !phone.trim()}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50 hover:opacity-90"
              style={{ background: "#7c3aed" }}>
              {smsSending ? <><Loader2 size={13} className="animate-spin" /> Sending…</> : <><MessageSquare size={13} /> Reset & Send SMS</>}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Database Connection Card ─────────────────────────────────────────────────

// ─── Staff Accounts Card ──────────────────────────────────────────────────────

const ALL_STAFF_MODULES: { id: string; label: string }[] = [
  { id: "dashboard",          label: "Dashboard" },
  { id: "shareholders",       label: "Shareholders" },
  { id: "clients",            label: "Clients" },
  { id: "contributions",      label: "Contributions" },
  { id: "projects",           label: "Projects" },
  { id: "investors",          label: "Ext. Investors" },
  { id: "payments",           label: "Payments" },
  { id: "mpesa-transactions", label: "M-Pesa Transactions" },
  { id: "refunds",            label: "Refunds" },
  { id: "reports",            label: "Reports" },
  { id: "settings",           label: "Settings" },
];

interface StaffAccount {
  id: string;
  full_name: string;
  email: string;
  role: "admin" | "reception";
  is_active: boolean;
  allowed_modules: string[] | null;
  created_at: string;
}

async function createStaffAccount(params: {
  email: string; password: string; full_name: string;
  role: "admin" | "reception"; allowed_modules: string[] | null;
}): Promise<void> {
  const { data: { session: adminSession } } = await supabase.auth.getSession();

  const { data, error } = await supabase.auth.signUp({
    email: params.email,
    password: params.password,
    options: { data: { full_name: params.full_name } },
  });

  // Restore admin session immediately — signUp replaces it with the new user's session
  if (adminSession) {
    await supabase.auth.setSession({
      access_token: adminSession.access_token,
      refresh_token: adminSession.refresh_token,
    });
  }

  let userId: string;
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("already registered")) {
      const { data: existing } = await supabase
        .from("user_profiles").select("id").eq("email", params.email).maybeSingle();
      if (!existing) throw new Error("Account exists but profile not found. Delete the orphaned auth user in Supabase → Authentication → Users, then try again.");
      userId = existing.id;
    } else if (msg.includes("confirm")) {
      throw new Error("Disable email confirmation in Supabase → Auth → Email → uncheck \"Confirm email\".");
    } else {
      throw new Error(error.message);
    }
  } else {
    if (!data.user) throw new Error("Account creation failed.");
    userId = data.user.id;
  }

  const profileRow: Record<string, any> = {
    id: userId, role: params.role, member_id: null,
    full_name: params.full_name, email: params.email,
    is_active: true, password_changed: true,
  };
  if (params.allowed_modules) profileRow.allowed_modules = params.allowed_modules;

  const { error: upsertErr } = await supabase.from("user_profiles")
    .upsert(profileRow, { onConflict: "id", ignoreDuplicates: false });
  if (upsertErr) throw new Error(upsertErr.message);
}

async function updateStaffAccount(params: {
  id: string; full_name: string; email: string;
  role: "admin" | "reception"; allowed_modules: string[] | null;
  newPassword?: string;
}): Promise<void> {
  const profileRow: Record<string, any> = {
    full_name: params.full_name,
    email: params.email,
    role: params.role,
    allowed_modules: params.role === "reception" ? (params.allowed_modules ?? []) : null,
  };
  const { error } = await supabase.from("user_profiles").update(profileRow).eq("id", params.id);
  if (error) throw new Error(error.message);

  if (params.newPassword && params.newPassword.length >= 6) {
    await supabase.functions.invoke("admin-reset-password", {
      body: { userId: params.id, newPassword: params.newPassword },
    });
  }
}

function AddStaffModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [role, setRole]         = useState<"admin" | "reception">("reception");
  const [fullName, setFullName] = useState("");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) { setErr("Enter a full name"); return; }
    if (!email.trim() || !email.includes("@")) { setErr("Enter a valid email address"); return; }
    if (password.length < 6) { setErr("Password must be at least 6 characters"); return; }
    setSaving(true); setErr("");
    try {
      await createStaffAccount({
        email: email.trim().toLowerCase(),
        password,
        full_name: fullName.trim(),
        role,
        allowed_modules: null,
      });
      onDone();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Add Staff Account</p>
            <p className="text-xs text-gray-400">Admin or Reception with custom access</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-200 text-gray-400"><X size={15} /></button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

          {/* Role picker */}
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1.5">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: "admin",     label: "Admin",     desc: "Full access including Settings", icon: <ShieldCheck size={16} />, color: "#1e2d4a" },
                { value: "reception", label: "Reception", desc: "Full access except Settings",    icon: <UserCircle2 size={16} />, color: "#7c3aed" },
              ] as const).map((r) => (
                <button type="button" key={r.value} onClick={() => setRole(r.value)}
                  className="flex items-start gap-2.5 p-3 rounded-xl border-2 text-left transition-all"
                  style={{ borderColor: role === r.value ? r.color : "#e2e8f0", background: role === r.value ? r.color + "0d" : "#fff" }}>
                  <span className="mt-0.5 flex-shrink-0" style={{ color: r.color }}>{r.icon}</span>
                  <div>
                    <p className="text-xs font-bold" style={{ color: r.color }}>{r.label}</p>
                    <p className="text-[10px] text-gray-400">{r.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Full Name</label>
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Jane Doe"
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              style={{ borderColor: "#e2e8f0" }} />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Email Address</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              style={{ borderColor: "#e2e8f0" }} />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Password</label>
            <div className="relative">
              <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 6 characters"
                className="w-full border rounded-xl px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "#e2e8f0" }} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "#e2e8f0" }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#1e2d4a,#4338ca)" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              {saving ? "Creating…" : "Create Account"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function EditStaffModal({ account, onClose, onDone }: {
  account: StaffAccount; onClose: () => void; onDone: () => void;
}) {
  const [role, setRole]         = useState<"admin" | "reception">(account.role);
  const [fullName, setFullName] = useState(account.full_name || "");
  const [email, setEmail]       = useState(account.email || "");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw]     = useState(false);
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fullName.trim()) { setErr("Enter a full name"); return; }
    if (!email.trim() || !email.includes("@")) { setErr("Enter a valid email address"); return; }
    if (password && password.length < 6) { setErr("New password must be at least 6 characters"); return; }
    setSaving(true); setErr("");
    try {
      await updateStaffAccount({
        id: account.id,
        full_name: fullName.trim(),
        email: email.trim().toLowerCase(),
        role,
        allowed_modules: null,
        newPassword: password || undefined,
      });
      onDone();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Edit Staff Account</p>
            <p className="text-xs text-gray-400">{account.full_name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-200 text-gray-400"><X size={15} /></button>
        </div>

        <form onSubmit={submit} className="p-5 space-y-4 max-h-[80vh] overflow-y-auto">
          {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1.5">Role</label>
            <div className="grid grid-cols-2 gap-2">
              {([
                { value: "admin",     label: "Admin",     desc: "Full access including Settings", icon: <ShieldCheck size={16} />, color: "#1e2d4a" },
                { value: "reception", label: "Reception", desc: "Full access except Settings",    icon: <UserCircle2 size={16} />, color: "#7c3aed" },
              ] as const).map((r) => (
                <button type="button" key={r.value} onClick={() => setRole(r.value)}
                  className="flex items-start gap-2.5 p-3 rounded-xl border-2 text-left transition-all"
                  style={{ borderColor: role === r.value ? r.color : "#e2e8f0", background: role === r.value ? r.color + "0d" : "#fff" }}>
                  <span className="mt-0.5 flex-shrink-0" style={{ color: r.color }}>{r.icon}</span>
                  <div>
                    <p className="text-xs font-bold" style={{ color: r.color }}>{r.label}</p>
                    <p className="text-[10px] text-gray-400">{r.desc}</p>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Full Name</label>
            <input type="text" value={fullName} onChange={(e) => setFullName(e.target.value)}
              placeholder="e.g. Jane Doe"
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              style={{ borderColor: "#e2e8f0" }} />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Email Address</label>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)}
              placeholder="jane@example.com"
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              style={{ borderColor: "#e2e8f0" }} />
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">
              New Password <span className="font-normal text-gray-400">(leave blank to keep current)</span>
            </label>
            <div className="relative">
              <input type={showPw ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)}
                placeholder="Min. 6 characters"
                className="w-full border rounded-xl px-3 py-2.5 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "#e2e8f0" }} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showPw ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </div>

          <div className="flex gap-3 pt-1">
            <button type="button" onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "#e2e8f0" }}>Cancel</button>
            <button type="submit" disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ background: "linear-gradient(135deg,#1e2d4a,#4338ca)" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Edit2 size={14} />}
              {saving ? "Saving…" : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function StaffAccountsCard() {
  const [accounts, setAccounts]     = useState<StaffAccount[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [editTarget, setEditTarget] = useState<StaffAccount | null>(null);
  const [msg, setMsg]               = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase
        .from("user_profiles")
        .select("id, full_name, email, role, is_active, allowed_modules, created_at")
        .in("role", ["admin", "reception"])
        .order("created_at", { ascending: false });
      setAccounts((data ?? []) as StaffAccount[]);
    } catch { setAccounts([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleActive = async (acc: StaffAccount) => {
    await supabase.from("user_profiles").update({ is_active: !acc.is_active }).eq("id", acc.id);
    setMsg({ ok: true, text: `${acc.full_name} ${acc.is_active ? "deactivated" : "activated"}.` });
    load();
  };

  const deleteAcc = async (acc: StaffAccount) => {
    if (!window.confirm(`Delete account for ${acc.full_name}? This cannot be undone.`)) return;
    await supabase.from("user_profiles").delete().eq("id", acc.id);
    await supabase.functions.invoke("delete-auth-user", { body: { userId: acc.id } }).catch(() => {});
    setMsg({ ok: true, text: `${acc.full_name} removed.` });
    load();
  };

  const ROLE_STYLE: Record<string, { label: string; color: string; bg: string }> = {
    admin:     { label: "Admin",     color: "#1e2d4a", bg: "#eef2ff" },
    reception: { label: "Reception", color: "#7c3aed", bg: "#f5f3ff" },
  };

  return (
    <>
      <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
        <div className="flex items-center justify-between px-4 py-3 border-b" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "#eef2ff" }}>
              <ShieldCheck size={14} color="#4338ca" />
            </div>
            <div>
              <p className="text-xs font-bold" style={{ color: "#1a202c" }}>Staff Accounts</p>
              <p className="text-[10px] text-gray-400">Admin &amp; Reception users</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={load} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400"><RefreshCw size={13} /></button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold text-white"
              style={{ background: "#1e2d4a" }}>
              <UserPlus size={12} /> Add Staff
            </button>
          </div>
        </div>

        {msg && (
          <div className={`mx-4 mt-3 px-3 py-2 rounded-lg text-xs font-semibold flex items-center gap-2 ${msg.ok ? "bg-green-50 text-green-700" : "bg-red-50 text-red-700"}`}>
            {msg.ok ? <CheckCircle size={12} /> : <XCircle size={12} />} {msg.text}
            <button onClick={() => setMsg(null)} className="ml-auto"><X size={12} /></button>
          </div>
        )}

        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 size={18} className="animate-spin text-gray-300" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-8 text-center px-4">
              <ShieldCheck size={22} className="mx-auto mb-2 text-gray-300" />
              <p className="text-xs text-gray-400">No staff accounts yet.</p>
              <p className="text-[10px] text-gray-300 mt-1">Click "Add Staff" to create the first one.</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "#f1f5f9" }}>
              {accounts.map((acc) => {
                const meta = ROLE_STYLE[acc.role] ?? ROLE_STYLE.admin;
                const isPhoneLogin = acc.email?.includes("@sacco.co.ke");
                const displayLogin = isPhoneLogin ? acc.email.replace("@sacco.co.ke", "") : acc.email;
                return (
                  <div key={acc.id} className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 text-xs font-bold"
                        style={{ background: meta.bg, color: meta.color }}>
                        {(acc.full_name || acc.email || "?")[0].toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{acc.full_name}</p>
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                            style={{ background: meta.bg, color: meta.color }}>{meta.label}</span>
                          {!acc.is_active && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-400 flex-shrink-0">Inactive</span>
                          )}
                        </div>
                        <p className="text-[10px] text-gray-400 truncate mt-0.5">{displayLogin}</p>
                        {acc.role === "reception" && (
                          <p className="text-[10px] text-indigo-400 mt-0.5">Full access · no Settings</p>
                        )}
                      </div>
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => setEditTarget(acc)} title="Edit"
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-indigo-50 text-gray-400 hover:text-indigo-600 transition-colors">
                          <Edit2 size={12} />
                        </button>
                        <button onClick={() => toggleActive(acc)} title={acc.is_active ? "Deactivate" : "Activate"}
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                          <RefreshCw size={12} />
                        </button>
                        <button onClick={() => deleteAcc(acc)} title="Delete"
                          className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-4 py-3 border-t" style={{ borderColor: "#f1f5f9", background: "#fafbff" }}>
          <p className="text-[10px] text-gray-400 leading-relaxed">
            <strong className="text-amber-600">Setup note:</strong> Run this SQL in Supabase to enable custom module storage:
            <code className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-mono" style={{ background: "#f1f5f9", color: "#475569" }}>
              ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS allowed_modules text[];
            </code>
          </p>
        </div>
      </div>

      {showAdd && (
        <AddStaffModal
          onClose={() => setShowAdd(false)}
          onDone={() => { load(); setMsg({ ok: true, text: "Staff account created successfully." }); }}
        />
      )}

      {editTarget && (
        <EditStaffModal
          account={editTarget}
          onClose={() => setEditTarget(null)}
          onDone={() => { load(); setMsg({ ok: true, text: `${editTarget.full_name} updated successfully.` }); }}
        />
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

const PG_MODE_KEY       = "db_mode";
const PG_SERVER_URL_KEY = "pg_server_url";

function DatabaseConnectionCard() {
  const [mode, setMode]             = useState<"supabase" | "cpanel">(() =>
    (localStorage.getItem(PG_MODE_KEY) as "supabase" | "cpanel") || "supabase"
  );
  const [serverUrl, setServerUrl]   = useState(() => localStorage.getItem(PG_SERVER_URL_KEY) || "");
  const [host, setHost]             = useState(() => localStorage.getItem("pg_host") || "localhost");
  const [port, setPort]             = useState(() => localStorage.getItem("pg_port") || "5432");
  const [dbName, setDbName]         = useState(() => localStorage.getItem("pg_dbname") || "");
  const [dbUser, setDbUser]         = useState(() => localStorage.getItem("pg_user") || "");
  const [dbPass, setDbPass]         = useState(() => localStorage.getItem("pg_pass") || "");
  const [ssl, setSsl]               = useState(() => localStorage.getItem("pg_ssl") === "true");
  const [showPass, setShowPass]     = useState(false);
  const [testing, setTesting]       = useState(false);
  const [saving, setSaving]         = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-100";

  const saveToLocal = () => {
    localStorage.setItem(PG_SERVER_URL_KEY, serverUrl.trim());
    localStorage.setItem("pg_host",   host.trim());
    localStorage.setItem("pg_port",   port.trim());
    localStorage.setItem("pg_dbname", dbName.trim());
    localStorage.setItem("pg_user",   dbUser.trim());
    localStorage.setItem("pg_pass",   dbPass);
    localStorage.setItem("pg_ssl",    String(ssl));
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    const url = serverUrl.trim().replace(/\/$/, "");
    if (!url) { setTestResult({ ok: false, msg: "Enter the server URL first." }); setTesting(false); return; }
    try {
      const res = await fetch(`${url}/api/db/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port: parseInt(port), database: dbName, user: dbUser, password: dbPass, ssl }),
      });
      const json = await res.json();
      if (json.success) {
        setTestResult({ ok: true, msg: `Connected! PostgreSQL ${json.info?.version?.split(" ")[1] ?? ""} · DB: ${json.info?.db} · User: ${json.info?.usr}` });
      } else {
        setTestResult({ ok: false, msg: json.error || "Connection failed" });
      }
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message });
    } finally { setTesting(false); }
  };

  const handleSave = async () => {
    setSaving(true); setTestResult(null);
    const url = serverUrl.trim().replace(/\/$/, "");
    if (!url) { setTestResult({ ok: false, msg: "Enter the server URL first." }); setSaving(false); return; }
    try {
      // Save credentials to server .env file
      const res = await fetch(`${url}/api/db/configure`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host, port: parseInt(port), database: dbName, user: dbUser, password: dbPass, ssl }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error || "Save failed");
      // Persist mode + config locally
      saveToLocal();
      localStorage.setItem(PG_MODE_KEY, mode);
      setTestResult({ ok: true, msg: `Configuration saved. App is now using ${mode === "cpanel" ? "cPanel PostgreSQL" : "Supabase"}.` });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message });
    } finally { setSaving(false); }
  };

  const switchMode = (m: "supabase" | "cpanel") => {
    setMode(m);
    localStorage.setItem(PG_MODE_KEY, m);
    setTestResult({ ok: true, msg: `Switched to ${m === "cpanel" ? "cPanel PostgreSQL" : "Supabase (cloud)"}. Changes take effect immediately.` });
  };

  const card = "bg-white rounded-2xl border p-5 space-y-4";

  return (
    <div className="space-y-4">
      {/* Mode toggle */}
      <div className={card} style={{ borderColor: "var(--card-border)" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#eef2ff" }}>
            <Database size={17} color="#6366f1" />
          </div>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Database Mode</p>
            <p className="text-xs text-gray-400">Choose which database the app reads and writes to</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {([
            { key: "supabase", label: "Supabase", sub: "Cloud · Free tier", color: "#10b981", bg: "#f0fdf4", border: "#86efac" },
            { key: "cpanel",   label: "cPanel PostgreSQL", sub: "Self-hosted · Your server", color: "#6366f1", bg: "#eef2ff", border: "#a5b4fc" },
          ] as const).map((opt) => {
            const active = mode === opt.key;
            return (
              <button key={opt.key} onClick={() => switchMode(opt.key)}
                className="rounded-2xl border-2 p-4 text-left transition-all"
                style={{ borderColor: active ? opt.border : "#e2e8f0", background: active ? opt.bg : "#fafafa" }}>
                <div className="flex items-center gap-2 mb-1">
                  <div className="w-2.5 h-2.5 rounded-full" style={{ background: active ? opt.color : "#cbd5e1" }} />
                  <span className="text-xs font-bold" style={{ color: active ? opt.color : "#64748b" }}>{opt.label}</span>
                </div>
                <p className="text-[11px] text-gray-400">{opt.sub}</p>
                {active && <p className="text-[10px] font-bold mt-1.5" style={{ color: opt.color }}>● ACTIVE</p>}
              </button>
            );
          })}
        </div>
      </div>

      {/* cPanel credentials */}
      <div className={card} style={{ borderColor: "var(--card-border)" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#f5f3ff" }}>
            <Settings2 size={17} color="#7c3aed" />
          </div>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>cPanel Server Configuration</p>
            <p className="text-xs text-gray-400">Node.js API server URL + PostgreSQL credentials</p>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Node.js API Server URL <span className="text-red-400">*</span></label>
            <input className={inp} style={{ borderColor: "var(--border)" }}
              value={serverUrl} onChange={(e) => setServerUrl(e.target.value)}
              placeholder="https://yourdomain.com or http://yourserver.com:3001" />
            <p className="text-[10px] text-gray-400 mt-0.5">The URL where your Node.js server is running (the /server folder deployed on cPanel)</p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">DB Host</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={host} onChange={(e) => setHost(e.target.value)} placeholder="localhost" />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">DB Port</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={port} onChange={(e) => setPort(e.target.value)} placeholder="5432" />
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Database Name</label>
            <input className={inp} style={{ borderColor: "var(--border)" }}
              value={dbName} onChange={(e) => setDbName(e.target.value)} placeholder="sacco_db" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">DB Username</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={dbUser} onChange={(e) => setDbUser(e.target.value)} placeholder="db_user" />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 block mb-1">DB Password</label>
              <div className="relative">
                <input type={showPass ? "text" : "password"} className={inp} style={{ borderColor: "var(--border)", paddingRight: "2.5rem" }}
                  value={dbPass} onChange={(e) => setDbPass(e.target.value)} placeholder="••••••••" />
                <button type="button" onClick={() => setShowPass((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={ssl} onChange={(e) => setSsl(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-indigo-600" />
            <span className="text-xs font-semibold text-gray-600">Enable SSL / TLS</span>
          </label>
        </div>

        {testResult && (
          <div className={`rounded-xl px-4 py-3 flex items-start gap-3 ${testResult.ok ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
            {testResult.ok ? <CheckCircle size={14} color="#16a34a" className="mt-0.5 flex-shrink-0" /> : <XCircle size={14} color="#dc2626" className="mt-0.5 flex-shrink-0" />}
            <span className={`text-xs font-medium ${testResult.ok ? "text-green-700" : "text-red-700"}`}>{testResult.msg}</span>
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button onClick={handleTest} disabled={testing}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border text-sm font-semibold disabled:opacity-60 hover:bg-gray-50"
            style={{ borderColor: "var(--border)", color: "#475569" }}>
            {testing ? <><Loader2 size={13} className="animate-spin" /> Testing…</> : <><CheckCircle2 size={13} /> Test Connection</>}
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#6366f1" }}>
            {saving ? <><Loader2 size={13} className="animate-spin" /> Saving…</> : <><Database size={13} /> Save & Apply</>}
          </button>
        </div>
      </div>

      {/* Info card */}
      <div className="rounded-2xl border p-4 space-y-2" style={{ background: "#fffbeb", borderColor: "#fde68a" }}>
        <div className="flex items-center gap-2">
          <AlertCircle size={14} color="#d97706" />
          <span className="text-xs font-bold text-amber-700">How cPanel mode works</span>
        </div>
        <ul className="text-[11px] text-amber-700 space-y-1 pl-4 list-disc">
          <li>Deploy the <strong>/server</strong> folder to cPanel as a Node.js app</li>
          <li>Create the database schema using <code className="bg-amber-100 px-1 rounded">server/db/setup.sql</code></li>
          <li>Set the <strong>DB_*</strong> environment variables in cPanel (or use Save & Apply above)</li>
          <li>Enter the server URL above, click Test → Save & Apply, then switch the toggle to <strong>cPanel PostgreSQL</strong></li>
          <li>All reads and writes route through your cPanel server. <strong>Authentication still uses Supabase.</strong></li>
          <li>To switch back, set the toggle back to <strong>Supabase</strong> — no data is lost.</li>
        </ul>
      </div>
    </div>
  );
}

function SystemGuideCard() {
  const [loading, setLoading] = useState(false);

  const handleDownload = async () => {
    setLoading(true);
    try {
      const co = await getCompanyDetails();
      await downloadSystemGuidePdf(co);
    } catch (e: any) {
      console.error("Guide PDF error", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#eef2ff" }}>
            <BookOpen size={16} color="#4338ca" />
          </div>
          <div>
            <p className="text-sm font-bold" style={{ color: "#1a202c" }}>System User Guide</p>
            <p className="text-xs text-gray-400">All modules, menus, features &amp; role access — PDF reference</p>
          </div>
        </div>
        <button onClick={handleDownload} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-60 hover:opacity-90 transition-opacity"
          style={{ background: "linear-gradient(135deg,#4338ca,#6366f1)" }}>
          {loading ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
          {loading ? "Generating…" : "Download Guide"}
        </button>
      </div>
    </div>
  );
}

// ─── Login As Card ────────────────────────────────────────────────────────────

type MemberEntry = {
  id: number;
  name: string;
  phone?: string;
  role: "shareholder" | "client" | "investor";
};

function LoginAsCard() {
  const { impersonating, setImpersonating } = useImpersonation();
  const navigate = useNavigate();
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  useEffect(() => {
    Promise.all([
      supabase.from("shareholders").select("id, name, phone").order("name"),
      supabase.from("clients").select("id, name, phone").order("name"),
      supabase.from("investors").select("id, name, phone").order("name"),
    ]).then(([sh, cl, inv]) => {
      const all: MemberEntry[] = [
        ...(sh.data ?? []).map((r) => ({ id: r.id, name: r.name, phone: r.phone, role: "shareholder" as const })),
        ...(cl.data ?? []).map((r) => ({ id: r.id, name: r.name, phone: r.phone, role: "client" as const })),
        ...(inv.data ?? []).map((r) => ({ id: r.id, name: r.name, phone: r.phone, role: "investor" as const })),
      ];
      setMembers(all);
      setLoading(false);
    });
  }, []);

  const filtered = members.filter((m) => {
    const q = search.toLowerCase();
    return !q || m.name.toLowerCase().includes(q) || (m.phone ?? "").includes(q);
  });

  const grouped: Record<string, MemberEntry[]> = {
    shareholder: filtered.filter((m) => m.role === "shareholder"),
    client:      filtered.filter((m) => m.role === "client"),
    investor:    filtered.filter((m) => m.role === "investor"),
  };

  const ROLE_STYLE: Record<string, { label: string; color: string; bg: string }> = {
    shareholder: { label: "Shareholder", color: "#6366f1", bg: "#eef2ff" },
    client:      { label: "Client",      color: "#a855f7", bg: "#faf5ff" },
    investor:    { label: "Investor",    color: "#eab308", bg: "#fefce8" },
  };

  const loginAs = (member: MemberEntry) => {
    const synth: UserProfile = {
      id: `preview-${member.role}-${member.id}`,
      role: member.role,
      member_id: member.id,
      full_name: member.name,
      email: "",
      password_changed: true,
    };
    setImpersonating(synth);
    navigate("/");
  };

  return (
    <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
      {/* Header */}
      <div className="px-5 py-4 flex items-center gap-3" style={{ background: "#f5f3ff", borderBottom: "1px solid #e9d5ff" }}>
        <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#7c3aed" }}>
          <LogIn size={17} color="#fff" />
        </div>
        <div>
          <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>Login As</h2>
          <p className="text-xs mt-0.5" style={{ color: "#6d28d9" }}>Preview the app as any member — your admin session stays active</p>
        </div>
        {impersonating && (
          <div className="ml-auto flex items-center gap-2">
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "#7c3aed", color: "#fff" }}>
              Active: {impersonating.full_name}
            </span>
            <button
              onClick={() => setImpersonating(null)}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors hover:bg-red-50"
              style={{ color: "#dc2626", borderColor: "#fecaca" }}
            >
              <X size={12} /> Exit Preview
            </button>
          </div>
        )}
      </div>

      <div className="p-5">
        {/* Info callout */}
        <div className="rounded-xl p-3 flex items-start gap-2 mb-4" style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
          <AlertCircle size={14} color="#3b82f6" className="mt-0.5 flex-shrink-0" />
          <p className="text-xs leading-relaxed" style={{ color: "#1e40af" }}>
            Selecting a member launches preview mode. You will see exactly what they see in their dashboard.
            The yellow banner at the top lets you exit at any time. Your admin session is never interrupted.
          </p>
        </div>

        {/* Search */}
        <div className="relative mb-4">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2" color="#94a3b8" />
          <input
            className="w-full text-xs border rounded-xl pl-8 pr-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-purple-400"
            style={{ borderColor: "var(--border)" }}
            placeholder="Search by name or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-10 gap-2 text-xs text-gray-400">
            <Loader2 size={16} className="animate-spin" /> Loading members…
          </div>
        ) : (
          <div className="space-y-5">
            {(["shareholder", "client", "investor"] as const).map((role) => {
              const list = grouped[role];
              const style = ROLE_STYLE[role];
              if (list.length === 0) return null;
              return (
                <div key={role}>
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-full" style={{ background: style.bg, color: style.color }}>
                      {style.label}s
                    </span>
                    <span className="text-[11px]" style={{ color: "#94a3b8" }}>{list.length} members</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                    {list.map((member) => {
                      const isActive = impersonating?.member_id === member.id && impersonating?.role === member.role;
                      return (
                        <div
                          key={`${role}-${member.id}`}
                          className="flex items-center gap-3 p-3 rounded-xl border transition-colors"
                          style={{
                            borderColor: isActive ? style.color : "#e2e8f0",
                            background:  isActive ? style.bg   : "white",
                          }}
                        >
                          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 text-[11px] font-bold text-white"
                            style={{ background: style.color }}>
                            {member.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{member.name}</div>
                            {member.phone && <div className="text-[10px] font-mono mt-0.5" style={{ color: "#94a3b8" }}>{member.phone}</div>}
                          </div>
                          <button
                            onClick={() => loginAs(member)}
                            className="flex-shrink-0 flex items-center gap-1 text-[11px] font-bold px-2.5 py-1.5 rounded-lg transition-colors"
                            style={isActive
                              ? { background: style.color, color: "#fff" }
                              : { background: style.bg, color: style.color }
                            }
                          >
                            {isActive ? <><Eye size={11} /> Viewing</> : <><LogIn size={11} /> Login</>}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {filtered.length === 0 && (
              <div className="text-center py-8 text-xs text-gray-400">No members match your search.</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AppMaintenancePage({ onBack }: { onBack: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [pwInput, setPwInput] = useState("");
  const [pwError, setPwError] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [activeTab, setActiveTab] = useState<"system" | "modules" | "backup" | "database" | "danger" | "staff" | "login-as">("system");

  const handleUnlock = () => {
    if (pwInput === MAINTENANCE_PASSWORD) { setUnlocked(true); setPwError(false); }
    else { setPwError(true); setPwInput(""); }
  };

  const [confirmTarget, setConfirmTarget] = useState<"shareholders" | "clients" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const handleSync = async () => {
    setSyncing(true);
    setResult(null);
    try {
      const { updated, errors } = await recalcNetSavings();
      setResult({ type: errors === 0 ? "success" : "error", msg: `Recalculated net savings for ${updated} shareholders.${errors > 0 ? ` ${errors} failed.` : ""}` });
    } catch (err: any) {
      setResult({ type: "error", msg: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmTarget) return;
    setDeleting(true);
    setResult(null);
    try {
      const { error } = await supabase.from(confirmTarget).delete().neq("id", 0);
      if (error) throw new Error(error.message);
      setResult({ type: "success", msg: `All ${confirmTarget} deleted successfully.` });
    } catch (err: any) {
      setResult({ type: "error", msg: err.message });
    } finally {
      setDeleting(false);
      setConfirmTarget(null);
    }
  };

  const dangerItems = [
    {
      table: "shareholders" as const,
      label: "Delete All Shareholders",
      desc: "Permanently removes every shareholder record from the database.",
      icon: <Users size={18} />,
    },
    {
      table: "clients" as const,
      label: "Delete All Clients",
      desc: "Permanently removes every client record from the database.",
      icon: <UserCircle2 size={18} />,
    },
  ];

  // ── Password gate ──────────────────────────────────────────────────────────
  if (!unlocked) {
    return (
      <div className="h-full overflow-auto flex items-center justify-center p-6" style={{ background: "var(--background)" }}>
        <div className="w-full max-w-sm space-y-5">
          <div className="flex flex-col items-center gap-3 pb-2">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center" style={{ background: "#f8fafc", border: "1px solid #e2e8f0" }}>
              <Lock size={24} color="#475569" />
            </div>
            <div className="text-center">
              <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>App Maintenance</h2>
              <p className="text-xs text-gray-400 mt-0.5">Super Admin access required</p>
            </div>
          </div>

          <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-gray-500">Password</label>
              <div className="relative">
                <input
                  type={showPw ? "text" : "password"}
                  value={pwInput}
                  onChange={(e) => { setPwInput(e.target.value); setPwError(false); }}
                  onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
                  placeholder="Enter password…"
                  className="w-full border rounded-xl px-3 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2"
                  style={{ borderColor: pwError ? "#ef4444" : "var(--border)", focusRingColor: "#475569" }}
                  autoFocus
                />
                <button type="button" onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {pwError && <p className="text-xs text-red-500">Incorrect password. Try again.</p>}
            </div>
            <button onClick={handleUnlock}
              className="w-full py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90"
              style={{ background: "#475569" }}>
              Unlock
            </button>
            <button onClick={onBack} className="w-full py-2 text-xs font-semibold text-gray-400 hover:text-gray-600">
              ← Back to Settings
            </button>
          </div>
        </div>
      </div>
    );
  }

  const MAINT_TABS = [
    { id: "system",    label: "System",    color: "#475569" },
    { id: "staff",     label: "Staff",     color: "#1e2d4a" },
    { id: "modules",   label: "Modules",   color: "#0ea5e9" },
    { id: "backup",    label: "Backup",    color: "#16a34a" },
    { id: "database",  label: "Database",  color: "#6366f1" },
    { id: "danger",    label: "Data Tools", color: "#ef4444" },
    { id: "login-as",  label: "Login As",   color: "#7c3aed" },
  ] as const;

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-5xl mx-auto p-4 md:p-6 space-y-4">
        {/* Breadcrumb */}
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg hover:bg-gray-200 transition-colors" style={{ color: "#64748b" }}>
            <ArrowLeft size={14} /> Settings
          </button>
          <span className="text-gray-300">/</span>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#f8fafc" }}>
              <Wrench size={16} color="#475569" />
            </div>
            <div>
              <h1 className="font-bold text-base" style={{ color: "#1a202c" }}>App Maintenance</h1>
              <p className="text-xs text-gray-400">Data operations — Super Admin only</p>
            </div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="bg-white rounded-2xl border p-1.5 flex gap-1" style={{ borderColor: "var(--card-border)" }}>
          {MAINT_TABS.map((t) => {
            const isActive = activeTab === t.id;
            return (
              <button key={t.id} onClick={() => setActiveTab(t.id as typeof activeTab)}
                className="flex-1 py-2 px-1.5 rounded-xl text-[11px] font-bold transition-all"
                style={isActive
                  ? { background: t.color, color: "#fff", boxShadow: "0 1px 6px rgba(0,0,0,0.12)" }
                  : { color: "#94a3b8" }}>
                {t.label}
              </button>
            );
          })}
        </div>

        {/* Result toast */}
        {result && (
          <div className={`rounded-xl px-4 py-3 flex items-center gap-3 ${result.type === "success" ? "bg-green-50 border border-green-200" : "bg-red-50 border border-red-200"}`}>
            {result.type === "success"
              ? <CheckCircle size={15} color="#16a34a" />
              : <XCircle size={15} color="#dc2626" />}
            <span className={`text-xs font-semibold ${result.type === "success" ? "text-green-700" : "text-red-700"}`}>{result.msg}</span>
            <button onClick={() => setResult(null)} className="ml-auto text-gray-400 hover:text-gray-600"><X size={14} /></button>
          </div>
        )}

        {/* ── System Guide download — always visible ── */}
        <SystemGuideCard />

        {/* ── System tab ── */}
        {activeTab === "system" && (
          <SystemLiveCard />
        )}

        {/* ── Staff tab ── */}
        {activeTab === "staff" && (
          <StaffAccountsCard />
        )}

        {/* ── Modules tab ── */}
        {activeTab === "modules" && (
          <ModuleVisibilityCard />
        )}

        {/* ── Backup tab ── */}
        {activeTab === "backup" && (
          <BackupRestoreCard />
        )}

        {/* ── Database tab ── */}
        {activeTab === "database" && <DatabaseConnectionCard />}

        {/* ── Login As tab ── */}
        {activeTab === "login-as" && <LoginAsCard />}

        {/* ── Danger tab ── */}
        {activeTab === "danger" && (
          <div className="space-y-4">
            <div className="rounded-xl p-4 flex items-start gap-3" style={{ background: "#fef2f2", border: "1px solid #fecaca" }}>
              <AlertCircle size={16} color="#dc2626" className="flex-shrink-0 mt-0.5" />
              <p className="text-xs leading-relaxed" style={{ color: "#991b1b" }}>
                <span className="font-bold">Danger Zone.</span> Actions below are irreversible. All deleted data cannot be recovered.
              </p>
            </div>

            {/* 3-column grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Delete Plot Payment */}
              <DeletePlotPaymentCard />

              {/* Admin Password Reset */}
              <AdminPasswordResetCard />

              {/* Delete Member Contributions */}
              <DeleteMemberContributionsCard onResult={(r) => setResult(r)} />

              {/* Delete All Shareholders / Clients */}
              {dangerItems.map((item) => (
                <div key={item.table} className="bg-white rounded-2xl border p-5 flex items-center gap-4" style={{ borderColor: "#fecaca" }}>
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
                    <span style={{ color: "#ef4444" }}>{item.icon}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-bold" style={{ color: "#1a202c" }}>{item.label}</div>
                    <div className="text-xs text-gray-400 mt-0.5">{item.desc}</div>
                  </div>
                  {confirmTarget === item.table ? (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <span className="text-xs text-red-600 font-semibold">Are you sure?</span>
                      <button onClick={handleDelete} disabled={deleting}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold text-white transition-opacity hover:opacity-80 disabled:opacity-50"
                        style={{ background: "#ef4444" }}>
                        {deleting ? "Deleting…" : "Yes, Delete"}
                      </button>
                      <button onClick={() => setConfirmTarget(null)}
                        className="px-3 py-1.5 rounded-lg text-xs font-bold transition-colors hover:bg-gray-100"
                        style={{ color: "#64748b" }}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setConfirmTarget(item.table)}
                      className="flex-shrink-0 px-4 py-2 rounded-xl text-xs font-bold text-white transition-opacity hover:opacity-80"
                      style={{ background: "#ef4444" }}>
                      Delete All
                    </button>
                  )}
                </div>
              ))}
            </div>

            {/* Factory Reset — full width at bottom */}
            <FactoryResetCard onResult={(r) => setResult(r)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Company Details Page ─────────────────────────────────────────────────────

function CompanyDetailsPage({ onBack }: { onBack: () => void }) {
  const [details, setDetails] = useState<CompanyDetails>({
    name: "", phone: "", email: "", website: "", location: "", logo_data_url: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving]   = useState(false);
  const [saved, setSaved]     = useState(false);
  const [err, setErr]         = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getCompanyDetails().then((d) => { setDetails(d); setLoading(false); });
  }, []);

  const handleLogoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      if (ev.target?.result) setDetails((d) => ({ ...d, logo_data_url: ev.target!.result as string }));
    };
    reader.readAsDataURL(f);
  };

  const save = async () => {
    setSaving(true); setErr("");
    try {
      await saveCompanyDetails(details);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inp = "w-full px-3 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-green-200 bg-white";

  if (loading) return (
    <div className="flex items-center justify-center h-full">
      <Loader2 size={22} className="animate-spin text-gray-300" />
    </div>
  );

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex items-center gap-2">
          <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600">
            <ArrowLeft size={14} /> Settings
          </button>
          <span className="text-gray-300">›</span>
          <span className="text-xs font-bold" style={{ color: "#16a34a" }}>Company Details</span>
        </div>

        <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
          {/* Logo */}
          <div className="px-6 py-5 border-b" style={{ borderColor: "var(--border)", background: "#f8fafc" }}>
            <p className="text-xs font-bold uppercase tracking-wider text-gray-500 mb-4">Company Logo</p>
            <div className="flex items-center gap-5">
              <div className="w-20 h-20 rounded-2xl border-2 overflow-hidden flex items-center justify-center flex-shrink-0"
                style={{ borderColor: details.logo_data_url ? "#16a34a" : "#e2e8f0", background: "#f1f5f9" }}>
                {details.logo_data_url
                  ? <img src={details.logo_data_url} alt="Company logo" className="w-full h-full object-contain" />
                  : <Building2 size={28} className="text-gray-300" />}
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-gray-600 mb-1">Upload your company logo</p>
                <p className="text-xs text-gray-400 mb-3">PNG, JPG or SVG — appears on reports and the login page. Square format works best.</p>
                <div className="flex gap-2 flex-wrap">
                  <button onClick={() => fileRef.current?.click()}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border hover:bg-gray-50 transition-colors"
                    style={{ borderColor: "#16a34a", color: "#16a34a" }}>
                    <UploadCloud size={13} /> Upload Logo
                  </button>
                  {details.logo_data_url && (
                    <button onClick={() => setDetails((d) => ({ ...d, logo_data_url: "" }))}
                      className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold border text-red-400 hover:bg-red-50 transition-colors"
                      style={{ borderColor: "#fca5a5" }}>
                      <X size={13} /> Remove
                    </button>
                  )}
                </div>
                <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={handleLogoFile} />
              </div>
            </div>
          </div>

          {/* Fields */}
          <div className="px-6 py-5 space-y-4">
            <p className="text-xs font-bold uppercase tracking-wider text-gray-500">Company Information</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="md:col-span-2">
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Company Name *</label>
                <input className={inp} style={{ borderColor: "var(--border)" }}
                  value={details.name}
                  onChange={(e) => setDetails((d) => ({ ...d, name: e.target.value }))}
                  placeholder="Egemeo Ardhi SACCO" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Phone Number</label>
                <input className={inp} style={{ borderColor: "var(--border)" }}
                  value={details.phone}
                  onChange={(e) => setDetails((d) => ({ ...d, phone: e.target.value }))}
                  placeholder="+254 700 000 000" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Email Address</label>
                <input type="email" className={inp} style={{ borderColor: "var(--border)" }}
                  value={details.email}
                  onChange={(e) => setDetails((d) => ({ ...d, email: e.target.value }))}
                  placeholder="info@company.co.ke" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Website</label>
                <input className={inp} style={{ borderColor: "var(--border)" }}
                  value={details.website}
                  onChange={(e) => setDetails((d) => ({ ...d, website: e.target.value }))}
                  placeholder="https://www.company.co.ke" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Physical Location</label>
                <input className={inp} style={{ borderColor: "var(--border)" }}
                  value={details.location}
                  onChange={(e) => setDetails((d) => ({ ...d, location: e.target.value }))}
                  placeholder="Nairobi, Kenya" />
              </div>
            </div>
          </div>
        </div>

        {err && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-600">{err}</div>
        )}

        <div className="flex justify-end gap-3">
          <button onClick={onBack}
            className="px-5 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
            style={{ borderColor: "var(--border)" }}>
            Cancel
          </button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "#16a34a" }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : saved ? <CheckCircle size={14} /> : null}
            {saving ? "Saving…" : saved ? "Saved!" : "Save Details"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Payment Rules Page ───────────────────────────────────────────────────────

export interface PaymentRules {
  /** @deprecated No longer used — penalties have been removed from the system */
  contribution_penalty_amount?: number;
  minimum_contribution_amount: number;
  /** @deprecated No longer used — penalties have been removed from the system */
  plot_penalty_amount?: number;
  /** Legacy — kept for backward compat, no longer used in logic */
  contribution_deadline_day?: number;
  contribution_penalty_type?: "flat" | "percentage";
  plot_grace_days?: number;
  plot_penalty_type?: "flat" | "percentage";
}

export const DEFAULT_PAYMENT_RULES: PaymentRules = {
  contribution_penalty_amount: 500,
  minimum_contribution_amount: 0,
  plot_penalty_amount: 500,
};

export async function getPaymentRules(): Promise<PaymentRules> {
  const { data } = await supabase.from("app_settings").select("value").eq("key", "payment_rules").maybeSingle();
  if (!data?.value) return DEFAULT_PAYMENT_RULES;
  return { ...DEFAULT_PAYMENT_RULES, ...(data.value as Partial<PaymentRules>) };
}

async function savePaymentRules(rules: PaymentRules): Promise<void> {
  await supabase.from("app_settings").upsert({ key: "payment_rules", value: rules, updated_at: new Date().toISOString() }, { onConflict: "key" });
}

function PaymentRulesPage({ onBack }: { onBack: () => void }) {
  const [rules, setRules] = useState<PaymentRules>(DEFAULT_PAYMENT_RULES);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    getPaymentRules().then((r) => { setRules(r); setLoading(false); });
  }, []);

  const set = (k: keyof PaymentRules, v: string | number) =>
    setRules((r) => ({ ...r, [k]: typeof r[k] === "number" ? Number(v) : v }));

  const handleSave = async () => {
    setSaving(true); setSaved(false);
    try {
      await savePaymentRules(rules);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } finally { setSaving(false); }
  };

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-xl mx-auto p-4 md:p-6 pb-20 space-y-5">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600">
          <ArrowLeft size={13} /> Back to Settings
        </button>
        <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Payment Rules</h1>
        <p className="text-sm text-gray-400">Set deadlines and late-payment penalties for contributions and plot instalments.</p>

        {loading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-gray-400"><Loader2 size={15} className="animate-spin" /> Loading rules…</div>
        ) : (
          <>
          {/* Late Payment Rule — informational */}
          <div className="rounded-2xl px-5 py-4 text-sm space-y-1" style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
            <p className="font-bold text-blue-800">Late Payment Rule</p>
            <p className="text-blue-700 text-xs leading-relaxed">
              Payment for a given month is due by the <strong>10th of the following month</strong>.<br />
              Example: July contribution → deadline is <strong>August 10th</strong>.<br />
              Payments past that date are marked <strong>Late</strong>. Penalties are added manually by admins only.
            </p>
          </div>

          {/* Contribution Rules */}
          <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
            <div className="flex items-center gap-2 pb-1 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#eef2ff" }}>
                <CreditCard size={15} color="#6366f1" />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Contribution Rules</p>
                <p className="text-xs text-gray-400">Minimum contribution rules</p>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Minimum Contribution Amount (KES)</label>
              <input type="number" min={0} value={rules.minimum_contribution_amount}
                onChange={(e) => set("minimum_contribution_amount", e.target.value)}
                placeholder="e.g. 5000"
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200"
                style={{ borderColor: "var(--border)" }} />
              <p className="text-xs text-gray-400 mt-1">Set to 0 to allow any amount. Members will be warned if they record below this amount.</p>
            </div>
          </div>

          {/* Plot Instalment Rules */}
          <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
            <div className="flex items-center gap-2 pb-1 border-b" style={{ borderColor: "var(--border)" }}>
              <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#ecfdf5" }}>
                <Link2 size={15} color="#059669" />
              </div>
              <div>
                <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Plot Instalment Rules</p>
                <p className="text-xs text-gray-400">Plot instalment payment rules</p>
              </div>
            </div>
          </div>

          <button onClick={handleSave} disabled={saving}
            className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
            style={{ background: saved ? "#16a34a" : "#0d9488" }}>
            {saving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : saved ? <><CheckCircle2 size={15} /> Saved!</> : "Save Payment Rules"}
          </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Settings Index Page ──────────────────────────────────────────────────────

type SettingsSub = null | "data-upload" | "app-maintenance" | "company-details" | "help" | "payment-settings" | "sms-settings" | "profile" | "activity-log" | "payment-rules";

function DbStatusBadge() {
  const [status, setStatus] = useState<"checking" | "connected" | "disconnected">("checking");
  const [errMsg, setErrMsg] = useState<string>("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setStatus("checking");
    checkDbHealth().then((result) => {
      if (cancelled) return;
      setStatus(result.connected ? "connected" : "disconnected");
      setErrMsg(result.error ?? "");
    });
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tick]);

  const cfg = {
    checking:     { dot: "bg-yellow-400 animate-pulse", text: "text-yellow-600", label: "Checking database…",    bg: "bg-yellow-50 border-yellow-200" },
    connected:    { dot: "bg-green-500",                text: "text-green-700",  label: "Database connected",     bg: "bg-green-50 border-green-200" },
    disconnected: { dot: "bg-red-500",                  text: "text-red-700",    label: "Database not connected", bg: "bg-red-50 border-red-200" },
  }[status];

  return (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl border mb-5 ${cfg.bg}`}>
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 ${cfg.dot}`} />
      <div className="flex-1 min-w-0">
        <span className={`text-sm font-semibold ${cfg.text}`}>{cfg.label}</span>
        {status === "disconnected" && errMsg && (
          <p className="text-xs text-red-500 mt-0.5 truncate">{errMsg}</p>
        )}
      </div>
      {status === "disconnected" && (
        <button onClick={() => setTick((t) => t + 1)} className="text-xs text-red-600 underline flex-shrink-0">
          Retry
        </button>
      )}
    </div>
  );
}


// ─── Payment Settings Page ────────────────────────────────────────────────────


const METHOD_META: Record<string, {
  label: string; icon: string; color: string; borderColor: string; bg: string; bgEnabled: string;
  access: string; accessColor: string; accessBg: string; accessIcon: React.ReactNode;
}> = {
  cash: {
    label: "Cash", icon: "💵",
    color: "#15803d", borderColor: "#16a34a", bg: "#fff", bgEnabled: "#f0fdf4",
    access: "Admin only", accessColor: "#b45309", accessBg: "#fffbeb",
    accessIcon: <Lock size={10} />,
  },
  bank: {
    label: "Bank Transfer", icon: "🏦",
    color: "#1d4ed8", borderColor: "#2563eb", bg: "#fff", bgEnabled: "#eff6ff",
    access: "Requires approval", accessColor: "#7c3aed", accessBg: "#f5f3ff",
    accessIcon: <ShieldCheck size={10} />,
  },
  cheque: {
    label: "Cheque", icon: "📄",
    color: "#6d28d9", borderColor: "#7c3aed", bg: "#fff", bgEnabled: "#f5f3ff",
    access: "Requires approval", accessColor: "#7c3aed", accessBg: "#f5f3ff",
    accessIcon: <ShieldCheck size={10} />,
  },
};

type DarajaSettings = {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  callbackUrl: string;
  environment: "sandbox" | "production";
};

const EMPTY_DARAJA: DarajaSettings = {
  consumerKey: "", consumerSecret: "", shortCode: "",
  passkey: "", callbackUrl: "", environment: "production",
};

function PaymentSettingsPage({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<PaymentSettings>(() => getPaymentSettings());
  const [daraja, setDaraja] = useState<DarajaSettings>(EMPTY_DARAJA);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [showSecret, setShowSecret] = useState(false);
  const [showPasskey, setShowPasskey] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testAmount, setTestAmount] = useState("1");
  const [testAccount, setTestAccount] = useState("");
  const [testState, setTestState] = useState<"idle" | "pushing" | "ok" | "err">("idle");
  const [testMsg, setTestMsg] = useState("");

  useEffect(() => {
    Promise.all([
      loadPaymentSettingsFromDb().catch(() => getPaymentSettings()),
      supabase.from("app_settings").select("value").eq("key", "daraja_settings").maybeSingle(),
    ]).then(([pay, { data }]) => {
      setCfg(pay);
      if (data?.value) setDaraja({ ...EMPTY_DARAJA, ...(data.value as Partial<DarajaSettings>) });
      setLoading(false);
    });
  }, []);

  const setField = (key: keyof DarajaSettings, value: string) =>
    setDaraja((prev) => ({ ...prev, [key]: value }));

  const toggleMethod = (m: keyof PaymentSettings["methods"]) =>
    setCfg((prev) => ({ ...prev, methods: { ...prev.methods, [m]: !prev.methods[m] } }));

  const save = async () => {
    setSaving(true);
    try {
      await Promise.all([
        savePaymentSettingsToDb(cfg),
        supabase.from("app_settings").upsert(
          { key: "daraja_settings", value: daraja, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        ),
      ]);
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      alert("Save failed: " + e.message);
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!testPhone.trim()) { setTestMsg("Enter a phone number"); setTestState("err"); return; }
    if (!daraja.consumerKey || !daraja.shortCode || !daraja.passkey) {
      setTestMsg("Fill in Consumer Key, Short Code, and Passkey first.");
      setTestState("err"); return;
    }
    const amt = Math.round(Number(testAmount) || 1);
    const acct = testAccount.trim() || daraja.shortCode;
    setTestState("pushing"); setTestMsg("");
    try {
      const { data, error } = await supabase.functions.invoke("mpesa-stk", {
        body: { action: "push", phone: testPhone.trim(), amount: amt, accountRef: acct, description: `Pay ${acct}` },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "Push failed");
      setTestMsg(
        `✓ Accepted\nPhone sent to Safaricom: ${data._phone}\nShortCode: ${data._shortCode}  |  Env: ${data._env}\nCheckoutRequestID: ${data.CheckoutRequestID ?? "?"}`
      );
      setTestState("ok");
    } catch (e: any) {
      setTestMsg(e.message ?? "Push failed");
      setTestState("err");
    }
  };

  const inputCls = "w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200 font-mono";
  const labelCls = "text-xs font-semibold text-gray-500 mb-1 block";

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-5">

        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600">
          <ArrowLeft size={15} /> Settings
        </button>

        <div>
          <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Payment Methods</h1>
          <p className="text-sm text-gray-400 mt-0.5">Configure payment methods and M-Pesa integration</p>
        </div>

        {/* Payment method toggles */}
        <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--card-border)" }}>
          <h2 className="text-sm font-bold mb-1" style={{ color: "#1a202c" }}>Enabled Payment Methods</h2>
          <p className="text-xs text-gray-400 mb-4">Toggle which methods appear during payment entry</p>
          <div className="grid grid-cols-3 gap-3">
            {(["cash", "bank", "cheque"] as const).map((m) => {
              const meta = METHOD_META[m];
              const on = cfg.methods[m];
              return (
                <button key={m} onClick={() => toggleMethod(m)}
                  className="flex items-start gap-3 px-4 py-3.5 rounded-xl border-2 text-left transition-all"
                  style={{ borderColor: on ? meta.borderColor : "#e2e8f0", background: on ? meta.bgEnabled : "#fafafa" }}>
                  <span className="text-2xl mt-0.5 flex-shrink-0">{meta.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-sm font-bold" style={{ color: on ? meta.color : "#64748b" }}>{meta.label}</span>
                      <div className="w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0"
                        style={{ background: on ? meta.borderColor : "#e2e8f0", border: `2px solid ${on ? meta.borderColor : "#cbd5e1"}` }}>
                        {on && <CheckCircle size={10} color="#fff" />}
                      </div>
                    </div>
                    <div className="text-[11px] mt-0.5" style={{ color: on ? meta.color : "#94a3b8" }}>
                      {on ? "Enabled" : "Disabled"}
                    </div>
                    <div className="inline-flex items-center gap-1 mt-1.5 px-1.5 py-0.5 rounded-md text-[10px] font-semibold"
                      style={{ background: on ? meta.accessBg : "#f1f5f9", color: on ? meta.accessColor : "#94a3b8" }}>
                      {on ? meta.accessIcon : <Lock size={10} />}
                      {meta.access}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Daraja (M-Pesa STK Push) */}
        <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl flex-shrink-0" style={{ background: "#f0fdf4" }}>📱</div>
            <div>
              <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>M-Pesa Daraja (STK Push)</h2>
              <p className="text-xs text-gray-400 mt-0.5">Safaricom Daraja credentials for STK push payments</p>
            </div>
          </div>

          {/* Environment */}
          <div>
            <p className={labelCls}>Environment</p>
            <div className="flex rounded-xl overflow-hidden border" style={{ borderColor: "var(--border)" }}>
              <button onClick={() => setField("environment", "production")}
                className="flex-1 py-2.5 text-xs font-bold transition-colors"
                style={{ background: daraja.environment === "production" ? "#16a34a" : "#f9fafb", color: daraja.environment === "production" ? "#fff" : "#64748b" }}>
                ✓ Production
              </button>
              <button onClick={() => setField("environment", "sandbox")}
                className="flex-1 py-2.5 text-xs font-bold transition-colors"
                style={{ background: daraja.environment === "sandbox" ? "#f59e0b" : "#f9fafb", color: daraja.environment === "sandbox" ? "#fff" : "#64748b" }}>
                ⚙ Sandbox
              </button>
            </div>
            {daraja.environment === "sandbox" && (
              <p className="text-xs text-amber-600 mt-1.5 bg-amber-50 rounded-lg px-3 py-2">
                Sandbox: pushes are accepted by Safaricom but the phone will not ring. Switch to Production for real payments.
              </p>
            )}
          </div>

          {/* Credentials */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={labelCls}>Consumer Key</label>
              <input value={daraja.consumerKey} onChange={(e) => setField("consumerKey", e.target.value)}
                placeholder="From Daraja portal" className={inputCls} style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className={labelCls}>Consumer Secret</label>
              <div className="relative">
                <input type={showSecret ? "text" : "password"} value={daraja.consumerSecret}
                  onChange={(e) => setField("consumerSecret", e.target.value)}
                  placeholder="From Daraja portal" className={inputCls + " pr-9"} style={{ borderColor: "var(--border)" }} />
                <button type="button" onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
            <div>
              <label className={labelCls}>Short Code (Business Number)</label>
              <input value={daraja.shortCode} onChange={(e) => setField("shortCode", e.target.value)}
                placeholder="e.g. 4093785" className={inputCls} style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className={labelCls}>Passkey</label>
              <div className="relative">
                <input type={showPasskey ? "text" : "password"} value={daraja.passkey}
                  onChange={(e) => setField("passkey", e.target.value)}
                  placeholder="Lipa Na M-Pesa passkey" className={inputCls + " pr-9"} style={{ borderColor: "var(--border)" }} />
                <button type="button" onClick={() => setShowPasskey((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  {showPasskey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>
          </div>

          <div>
            <label className={labelCls}>Callback URL</label>
            <input value={daraja.callbackUrl} onChange={(e) => setField("callbackUrl", e.target.value)}
              placeholder="https://your-project.supabase.co/functions/v1/mpesa-callback"
              className={inputCls} style={{ borderColor: "var(--border)" }} />
            <p className="text-xs text-gray-400 mt-1">Safaricom POSTs payment results here after the customer enters their PIN.</p>
          </div>

          {/* Test push */}
          <div className="pt-3 border-t space-y-2" style={{ borderColor: "var(--border)" }}>
            <p className="text-xs font-bold text-gray-600">Test STK Push <span className="font-normal text-gray-400">(PayBill)</span></p>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className={labelCls}>Phone Number</label>
                <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
                  placeholder="e.g. 0712345678"
                  className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                  style={{ borderColor: "var(--border)" }} />
              </div>
              <div>
                <label className={labelCls}>Amount (KES)</label>
                <input value={testAmount} onChange={(e) => setTestAmount(e.target.value)}
                  placeholder="e.g. 1"
                  type="number" min="1"
                  className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                  style={{ borderColor: "var(--border)" }} />
              </div>
            </div>
            <div>
              <label className={labelCls}>Account Reference</label>
              <input value={testAccount} onChange={(e) => setTestAccount(e.target.value)}
                placeholder={`e.g. ${daraja.shortCode || "4093785"}`}
                className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                style={{ borderColor: "var(--border)" }} />
              <p className="text-xs text-gray-400 mt-1">Account number shown on the customer's STK prompt. Defaults to your short code.</p>
            </div>
            <button onClick={runTest} disabled={testState === "pushing"}
              className="w-full py-2.5 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: "#16a34a" }}>
              {testState === "pushing" ? <Loader2 size={13} className="animate-spin" /> : null}
              Send Test Push
            </button>
            {testMsg && (
              <pre className={`text-xs rounded-lg px-3 py-2 font-mono whitespace-pre-wrap ${testState === "ok" ? "bg-green-50 text-green-700" : "bg-red-50 text-red-600"}`}>
                {testMsg}
              </pre>
            )}
          </div>
        </div>

        {loading && (
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <Loader2 size={13} className="animate-spin" /> Loading settings…
          </div>
        )}

        <button onClick={save} disabled={saving || loading}
          className="w-full py-3 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
          style={{ background: saved ? "#16a34a" : "#ea580c" }}>
          {saving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> :
           saved  ? <><CheckCircle size={15} /> Saved!</> :
           "Save Payment Settings"}
        </button>
      </div>
    </div>
  );
}

// ─── FAQ Item ─────────────────────────────────────────────────────────────────

function FaqItem({ question, answer }: { question: string; answer: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-xl overflow-hidden bg-white" style={{ borderColor: "var(--card-border)" }}>
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-gray-50 transition-colors">
        <span className="text-sm font-semibold pr-4" style={{ color: "#1a202c" }}>{question}</span>
        <ChevronDown size={15} className="flex-shrink-0 text-gray-400 transition-transform"
          style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && (
        <div className="px-4 pb-4 pt-1 text-sm text-gray-500 border-t" style={{ borderColor: "var(--border)" }}>
          {answer}
        </div>
      )}
    </div>
  );
}

// ─── SMS Settings Page ────────────────────────────────────────────────────────

const SMS_REMINDER_CODE = [
  'import { serve } from "https://deno.land/std@0.168.0/http/server.ts";',
  'import { createClient } from "https://esm.sh/@supabase/supabase-js@2";',
  '// ... full code at supabase/functions/sms-reminder/index.ts',
].join("\n");

function SmsToggle({ label, desc, value, onChange }: { label: string; desc: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3 border-b last:border-0" style={{ borderColor: "var(--border)" }}>
      <div>
        <p className="text-sm font-semibold" style={{ color: "#1a202c" }}>{label}</p>
        <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
      </div>
      <button onClick={() => onChange(!value)}
        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
        style={{ background: value ? "#16a34a" : "#e2e8f0" }}>
        <span className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all"
          style={{ left: value ? "calc(100% - 1.375rem)" : "0.125rem" }} />
      </button>
    </div>
  );
}

function SmsSettingsPage({ onBack }: { onBack: () => void }) {
  const [cfg, setCfg] = useState<SmsSettings>(() => getSmsSettings());
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    loadSmsSettingsFromDb()
      .then((s) => { if (s) setCfg(mergeSmsSettings(s)); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  const setAt = (key: keyof SmsSettings["providerConfig"]["africastalking"], val: string) =>
    setCfg((prev) => ({ ...prev, providerConfig: { ...prev.providerConfig, africastalking: { ...prev.providerConfig.africastalking, [key]: val } } }));

  const setOra = (key: keyof SmsSettings["providerConfig"]["oramobile"], val: string) =>
    setCfg((prev) => ({ ...prev, providerConfig: { ...prev.providerConfig, oramobile: { ...prev.providerConfig.oramobile, [key]: val } } }));

  const setProvider = (p: "africastalking" | "oramobile") =>
    setCfg((prev) => ({ ...prev, providerConfig: { ...prev.providerConfig, provider: p } }));

  const setTrigger = (id: string, val: boolean) =>
    setCfg((prev) => ({ ...prev, smsTriggers: { ...prev.smsTriggers, [id]: val } }));

  const save = async () => {
    setSaving(true);
    try {
      saveSmsSettings(cfg);
      await saveSmsSettingsToDb(cfg as any);
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e: any) { alert("Save failed: " + e.message); }
    finally { setSaving(false); }
  };

  const testSms = async () => {
    if (!testPhone.trim()) return;
    setTesting(true); setTestResult(null);
    try {
      await sendSms(testPhone.trim(), `Egemeo Ardhi SACCO — SMS test successful! (${new Date().toLocaleTimeString()})`, undefined, cfg);
      const isSandbox = cfg.providerConfig.provider === "africastalking" && cfg.providerConfig.africastalking.username === "sandbox";
      setTestResult({
        ok: !isSandbox,
        msg: isSandbox
          ? "Accepted by AT sandbox — messages in sandbox do NOT arrive on real phones. Use your live username + live API key."
          : "Test SMS sent successfully!",
      });
    } catch (e: any) {
      setTestResult({ ok: false, msg: e.message });
    } finally { setTesting(false); }
  };

  const inputCls = "w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100 bg-white";
  const labelCls = "text-xs font-semibold text-gray-500 mb-1.5 block";

  const [expandedTrigger, setExpandedTrigger] = useState<string | null>(null);

  const setTemplate = (id: string, val: string) =>
    setCfg((prev) => ({ ...prev, messageTemplates: { ...(prev.messageTemplates ?? {}), [id]: val } }));

  const TRIGGERS: Array<{
    id: string; label: string; desc: string; icon: string;
    vars: string[]; example: Record<string, string>;
  }> = [
    {
      id: SMS_TRIGGERS.newUser,
      label: "New User Welcome", icon: "👤",
      desc: "Sent when a new member account is created",
      vars: ["name", "phone"],
      example: { name: "John", phone: "0712345678" },
    },
    {
      id: SMS_TRIGGERS.contribReceipt,
      label: "Payment Received", icon: "💰",
      desc: "Sent when a contribution payment is recorded",
      vars: ["name", "amount", "month", "ref"],
      example: { name: "John", amount: "KES 5,000", month: "January 2025", ref: " Ref: QHX4ABC123." },
    },
    {
      id: SMS_TRIGGERS.plotAssigned,
      label: "Plot Assigned", icon: "🏘️",
      desc: "Sent when a plot is assigned to a member",
      vars: ["name", "plotNo", "project", "amount"],
      example: { name: "John", plotNo: "A-01", project: "Phase 1", amount: "KES 250,000" },
    },
    {
      id: SMS_TRIGGERS.passwordReminder,
      label: "Password Reminder", icon: "🔑",
      desc: "Sent via More Actions on a member profile",
      vars: ["name", "phone"],
      example: { name: "John", phone: "0712345678" },
    },
    {
      id: SMS_TRIGGERS.reminder5d,
      label: "Reminder — 5 days", icon: "📅",
      desc: "5 days before monthly contribution is due",
      vars: ["name", "month", "days"],
      example: { name: "John", month: "January 2025", days: "5" },
    },
    {
      id: SMS_TRIGGERS.reminder2d,
      label: "Reminder — 2 days", icon: "📅",
      desc: "2 days before monthly contribution is due",
      vars: ["name", "month", "days"],
      example: { name: "John", month: "January 2025", days: "2" },
    },
    {
      id: SMS_TRIGGERS.reminder1d,
      label: "Reminder — 1 day", icon: "⏰",
      desc: "1 day before monthly contribution is due",
      vars: ["name", "month"],
      example: { name: "John", month: "January 2025" },
    },
    {
      id: SMS_TRIGGERS.reminderToday,
      label: "Reminder — Due today", icon: "🔔",
      desc: "On the day the monthly contribution is due",
      vars: ["name", "month"],
      example: { name: "John", month: "January 2025" },
    },
  ];

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-2xl mx-auto p-4 md:p-6 space-y-5">

        <button onClick={onBack} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-gray-600">
          <ArrowLeft size={15} /> Settings
        </button>

        {/* Header + global toggle */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>SMS Notifications</h1>
            <p className="text-sm text-gray-400 mt-0.5">Configure SMS alerts for members</p>
          </div>
          <button
            onClick={() => setCfg((p) => ({ ...p, smsEnabled: !p.smsEnabled }))}
            className="relative w-12 h-6 rounded-full transition-colors flex-shrink-0"
            style={{ background: cfg.smsEnabled ? "#16a34a" : "#e2e8f0" }}>
            <span className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all"
              style={{ left: cfg.smsEnabled ? "calc(100% - 1.375rem)" : "0.125rem" }} />
          </button>
        </div>

        {!cfg.smsEnabled && (
          <div className="rounded-xl px-4 py-3 text-xs flex items-center gap-2" style={{ background: "#fef9c3", color: "#854d0e" }}>
            <AlertCircle size={13} className="flex-shrink-0" />
            SMS notifications are disabled. Toggle on above to activate.
          </div>
        )}

        {/* Provider selection */}
        <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="mb-1">
            <span className="text-sm font-bold" style={{ color: "#1a202c" }}>SMS Provider</span>
          </div>
          <div className="flex gap-2">
            {(["africastalking", "oramobile"] as const).map((p) => (
              <button
                key={p}
                onClick={() => setProvider(p)}
                className="flex-1 py-2.5 px-3 rounded-xl text-sm font-semibold border transition-colors"
                style={{
                  background: cfg.providerConfig.provider === p ? "#2563eb" : "#f8fafc",
                  color: cfg.providerConfig.provider === p ? "#fff" : "#64748b",
                  borderColor: cfg.providerConfig.provider === p ? "#2563eb" : "var(--border)",
                }}>
                {p === "africastalking" ? "Africa's Talking" : "Oramobile"}
              </button>
            ))}
          </div>

          {cfg.providerConfig.provider === "africastalking" && (
            <div className="space-y-3 pt-1">
              <div className="text-xs text-gray-400 -mt-1">africastalking.com</div>
              <div>
                <label className={labelCls}>Username</label>
                <input value={cfg.providerConfig.africastalking.username} onChange={(e) => setAt("username", e.target.value)}
                  className={inputCls} style={{ borderColor: "var(--border)" }} placeholder="Your AT account username (not 'sandbox')" />
              </div>
              <div>
                <label className={labelCls}>API Key</label>
                <div className="relative">
                  <input type={showKey ? "text" : "password"} value={cfg.providerConfig.africastalking.apiKey}
                    onChange={(e) => setAt("apiKey", e.target.value)}
                    className={inputCls + " pr-10"} style={{ borderColor: "var(--border)" }} placeholder="atsk_..." />
                  <button type="button" onClick={() => setShowKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div>
                <label className={labelCls}>Sender ID</label>
                <input value={cfg.providerConfig.africastalking.senderId} onChange={(e) => setAt("senderId", e.target.value)}
                  className={inputCls} style={{ borderColor: "var(--border)" }} placeholder="e.g. EgemeoArdhi" />
              </div>
            </div>
          )}

          {cfg.providerConfig.provider === "oramobile" && (
            <div className="space-y-3 pt-1">
              <div className="text-xs text-gray-400 -mt-1">107.20.199.106 — Infobip-compatible gateway</div>
              <div>
                <label className={labelCls}>API Key <span className="text-gray-400 font-normal">(recommended)</span></label>
                <div className="relative">
                  <input type={showKey ? "text" : "password"} value={cfg.providerConfig.oramobile.apiKey}
                    onChange={(e) => setOra("apiKey", e.target.value)}
                    className={inputCls + " pr-10"} style={{ borderColor: "var(--border)" }} placeholder="Oramobile API key" />
                  <button type="button" onClick={() => setShowKey((v) => !v)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                <p className="text-xs text-gray-400 mt-1">If you have an API key, leave username/password blank.</p>
              </div>
              <div className="border-t pt-3" style={{ borderColor: "var(--border)" }}>
                <p className="text-xs font-semibold text-gray-400 mb-3">Or use username + password</p>
                <div className="space-y-3">
                  <div>
                    <label className={labelCls}>Username</label>
                    <input value={cfg.providerConfig.oramobile.username} onChange={(e) => setOra("username", e.target.value)}
                      className={inputCls} style={{ borderColor: "var(--border)" }} placeholder="Your Oramobile username" />
                  </div>
                  <div>
                    <label className={labelCls}>Password</label>
                    <input type="password" value={cfg.providerConfig.oramobile.password}
                      onChange={(e) => setOra("password", e.target.value)}
                      className={inputCls} style={{ borderColor: "var(--border)" }} placeholder="Your Oramobile password" />
                  </div>
                </div>
              </div>
              <div>
                <label className={labelCls}>Sender ID</label>
                <input value={cfg.providerConfig.oramobile.senderId} onChange={(e) => setOra("senderId", e.target.value)}
                  className={inputCls} style={{ borderColor: "var(--border)" }} placeholder="e.g. EgemeoArdhi" />
              </div>
            </div>
          )}
        </div>

        {/* Test SMS */}
        <div className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2 mb-1">
            <Phone size={14} className="text-blue-500" />
            <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>Send Test SMS</h2>
          </div>
          <div className="flex gap-2">
            <input value={testPhone} onChange={(e) => setTestPhone(e.target.value)}
              placeholder="07XXXXXXXX"
              className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
              style={{ borderColor: "var(--border)" }} />
            <button onClick={testSms} disabled={testing || !testPhone.trim() || !cfg.smsEnabled}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white flex items-center gap-2 disabled:opacity-50"
              style={{ background: "#2563eb" }}>
              {testing ? <Loader2 size={13} className="animate-spin" /> : <MessageSquare size={13} />}
              {testing ? "Sending…" : "Send"}
            </button>
          </div>
          {testResult && (
            <p className="text-xs font-medium px-3 py-2 rounded-lg"
              style={{ background: testResult.ok ? "#f0fdf4" : "#fef2f2", color: testResult.ok ? "#15803d" : "#dc2626" }}>
              {testResult.ok ? "✓ " : "✗ "}{testResult.msg}
            </p>
          )}
        </div>

        {/* Notification Types + Message Templates */}
        <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2 px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
            <Bell size={14} className="text-orange-500" />
            <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>Notification Types & Message Templates</h2>
          </div>

          <div className="divide-y" style={{ borderColor: "var(--border)" }}>
            {TRIGGERS.map(({ id, label, desc, icon, vars, example }) => {
              const enabled = cfg.smsTriggers[id] !== false;
              const isOpen = expandedTrigger === id;
              const storedTpl = cfg.messageTemplates?.[id];
              const tpl = (storedTpl && storedTpl.trim()) ? storedTpl : (DEFAULT_TEMPLATES[id] ?? "");
              const isCustom = !!(storedTpl && storedTpl.trim() && storedTpl !== DEFAULT_TEMPLATES[id]);
              const preview = interpolate(tpl, example);
              const charCount = tpl.length;

              return (
                <div key={id}>
                  {/* Trigger row */}
                  <div className="flex items-center gap-3 px-5 py-3.5 hover:bg-gray-50 transition-colors">
                    <span className="text-lg flex-shrink-0">{icon}</span>
                    <button
                      className="flex-1 min-w-0 text-left"
                      onClick={() => setExpandedTrigger(isOpen ? null : id)}
                    >
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold" style={{ color: "#1a202c" }}>{label}</p>
                        {isCustom && (
                          <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wide"
                            style={{ background: "#ede9fe", color: "#6d28d9" }}>Custom</span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400 mt-0.5">{desc}</p>
                    </button>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        onClick={() => setExpandedTrigger(isOpen ? null : id)}
                        className="text-gray-400 hover:text-gray-600 transition-colors p-0.5"
                      >
                        <ChevronDown size={14} style={{ transform: isOpen ? "rotate(180deg)" : "none", transition: "transform .2s" }} />
                      </button>
                      <button
                        onClick={() => setTrigger(id, !enabled)}
                        className="relative w-10 h-[22px] rounded-full transition-colors flex-shrink-0"
                        style={{ background: enabled ? "#16a34a" : "#e2e8f0" }}
                      >
                        <span className="absolute top-[3px] w-4 h-4 bg-white rounded-full shadow transition-all"
                          style={{ left: enabled ? "calc(100% - 19px)" : "3px" }} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded template editor */}
                  {isOpen && (
                    <div className="px-5 pb-5 pt-3 space-y-4" style={{ background: "#f8fafc", borderTop: "1px solid var(--border)" }}>
                      {/* Template textarea */}
                      <div>
                        <div className="flex items-center justify-between mb-1.5">
                          <label className="text-xs font-semibold text-gray-500">Message Template</label>
                          <span className={`text-[11px] font-mono font-semibold ${charCount > 160 ? "text-orange-500" : "text-gray-400"}`}>
                            {charCount} chars {charCount > 160 ? `(${Math.ceil(charCount / 160)} SMS)` : "(1 SMS)"}
                          </span>
                        </div>
                        <textarea
                          value={tpl}
                          onChange={(e) => setTemplate(id, e.target.value)}
                          rows={4}
                          className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono resize-none focus:outline-none focus:ring-2 focus:ring-indigo-100 bg-white leading-relaxed"
                          style={{ borderColor: isCustom ? "#a78bfa" : "var(--border)" }}
                        />
                      </div>

                      {/* Variable chips */}
                      <div>
                        <p className="text-[10px] font-bold text-gray-400 mb-2 uppercase tracking-wider">Available Variables — click to insert</p>
                        <div className="flex flex-wrap gap-1.5">
                          {vars.map((v) => (
                            <button
                              key={v}
                              type="button"
                              onClick={() => setTemplate(id, tpl + `{${v}}`)}
                              className="text-[11px] font-mono px-2 py-0.5 rounded-md transition-colors hover:opacity-80"
                              style={{ background: "#ede9fe", color: "#5b21b6" }}
                            >
                              {`{${v}}`}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Live preview */}
                      <div className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
                        <div className="px-3 py-2 flex items-center gap-2" style={{ background: "#f1f5f9", borderBottom: "1px solid var(--border)" }}>
                          <MessageSquare size={11} className="text-gray-400" />
                          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-wider">Preview with sample data</p>
                        </div>
                        <div className="px-3 py-2.5 bg-white">
                          <p className="text-xs text-gray-700 leading-relaxed">{preview}</p>
                        </div>
                      </div>

                      {/* Reset link */}
                      {isCustom && (
                        <button
                          onClick={() => setTemplate(id, DEFAULT_TEMPLATES[id] ?? "")}
                          className="text-xs text-indigo-500 hover:text-indigo-700 underline"
                        >
                          Reset to default template
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="px-5 py-4 border-t" style={{ borderColor: "var(--border)" }}>
            <label className={labelCls}>Contribution Due Day (day of month)</label>
            <input type="number" min={1} max={28}
              value={cfg.contributionDueDay}
              onChange={(e) => setCfg((p) => ({ ...p, contributionDueDay: parseInt(e.target.value) || 5 }))}
              className="w-24 border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-100"
              style={{ borderColor: "var(--border)" }} />
            <p className="text-xs text-gray-400 mt-1">Reminders count back from this day each month.</p>
          </div>
        </div>

        {/* Cron setup instructions */}
        <div className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-blue-500" />
            <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>Scheduled Reminder Setup</h2>
          </div>
          <p className="text-xs text-gray-500">Automatic daily reminders require two one-time steps in Supabase Dashboard:</p>
          <ol className="space-y-2 text-xs text-gray-600">
            <li className="flex gap-2">
              <span className="font-bold text-blue-600 flex-shrink-0">1.</span>
              Deploy the <strong>sms-reminder</strong> Edge Function (code at <code className="bg-gray-100 px-1 rounded">supabase/functions/sms-reminder/index.ts</code>)
            </li>
            <li className="flex gap-2">
              <span className="font-bold text-blue-600 flex-shrink-0">2.</span>
              Enable pg_cron in SQL Editor then schedule the job:
            </li>
          </ol>
          <pre className="text-[10px] rounded-lg p-3 overflow-x-auto leading-relaxed" style={{ background: "#1e293b", color: "#94a3b8" }}>{`create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'sms-reminder-daily',
  '0 7 * * *',
  $$
  select net.http_post(
    url := 'https://YOUR_PROJECT.supabase.co/functions/v1/sms-reminder',
    headers := '{"Authorization":"Bearer YOUR_ANON_KEY"}'::jsonb
  );
  $$
);`}</pre>
        </div>

        {loading && <div className="flex items-center gap-2 text-xs text-gray-400"><Loader2 size={13} className="animate-spin" /> Loading settings…</div>}

        <button onClick={save} disabled={saving || loading}
          className="w-full py-3 rounded-xl font-bold text-white flex items-center justify-center gap-2 transition-colors disabled:opacity-60"
          style={{ background: saved ? "#16a34a" : "#2563eb" }}>
          {saving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> :
           saved  ? <><CheckCircle size={15} /> Saved!</> : "Save SMS Settings"}
        </button>
      </div>
    </div>
  );
}

function ProfileSettingsPage({ onBack }: { onBack: () => void }) {
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [session, setSession] = useState<any>(null);

  // Member profile state
  const [memberRecord, setMemberRecord] = useState<any>(null);
  const [memberRole, setMemberRole] = useState<string>("");
  const [memberId, setMemberId] = useState<number | null>(null);
  const [detailsForm, setDetailsForm] = useState({ name: "", phone: "", email: "", id_passport: "" });
  const [detailsSaving, setDetailsSaving] = useState(false);
  const [detailsMsg, setDetailsMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const [loadingMember, setLoadingMember] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);
  const photoInputRef = React.useRef<HTMLInputElement>(null);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data }) => {
      setSession(data.session);
      const uid = data.session?.user?.id;
      if (!uid) return;
      setLoadingMember(true);
      try {
        const { data: prof } = await supabase.from("user_profiles").select("member_id, role").eq("id", uid).maybeSingle();
        if (!prof?.member_id || !prof?.role || prof.role === "admin") return;
        setMemberId(prof.member_id);
        setMemberRole(prof.role);
        const table = prof.role === "shareholder" ? "shareholders" : "clients";
        const { data: rec } = await supabase.from(table).select("*").eq("id", prof.member_id).maybeSingle();
        if (rec) {
          setMemberRecord(rec);
          setDetailsForm({
            name: rec.name ?? "",
            phone: rec.phone ?? "",
            email: rec.email ?? "",
            id_passport: rec.id_passport ?? "",
          });
        }
      } finally { setLoadingMember(false); }
    });
  }, []);

  const handlePasswordSave = async () => {
    setMsg(null);
    if (!newPw) { setMsg({ type: "err", text: "Enter a new password." }); return; }
    if (newPw.length < 6) { setMsg({ type: "err", text: "Password must be at least 6 characters." }); return; }
    if (newPw !== confirmPw) { setMsg({ type: "err", text: "Passwords do not match." }); return; }
    setSaving(true);
    const { error } = await supabase.auth.updateUser({ password: newPw });
    setSaving(false);
    if (error) { setMsg({ type: "err", text: error.message }); return; }
    setMsg({ type: "ok", text: "Password updated successfully." });
    setNewPw(""); setConfirmPw("");
  };

  const handleDetailsSave = async () => {
    if (!memberId || !memberRole) return;
    setDetailsSaving(true); setDetailsMsg(null);
    try {
      // Only allow filling in empty fields — lock fields that already have values
      const patch: any = {};
      if (!memberRecord?.email && detailsForm.email.trim())         patch.email        = detailsForm.email.trim();
      if (!memberRecord?.id_passport && detailsForm.id_passport.trim()) patch.id_passport = detailsForm.id_passport.trim();
      if (!memberRecord?.phone && detailsForm.phone.trim())          patch.phone        = detailsForm.phone.trim();
      if (!memberRecord?.name && detailsForm.name.trim())            patch.name         = detailsForm.name.trim();
      if (Object.keys(patch).length === 0) {
        setDetailsMsg({ type: "err", text: "No empty fields to update." });
        return;
      }
      const table = memberRole === "shareholder" ? "shareholders" : "clients";
      const { data: updated, error } = await supabase.from(table).update(patch).eq("id", memberId).select().single();
      if (error) throw new Error(error.message);
      setMemberRecord(updated);
      setDetailsForm({
        name: updated.name ?? "",
        phone: updated.phone ?? "",
        email: updated.email ?? "",
        id_passport: updated.id_passport ?? "",
      });
      setDetailsMsg({ type: "ok", text: "Details updated successfully." });
    } catch (e: any) {
      setDetailsMsg({ type: "err", text: e.message });
    } finally { setDetailsSaving(false); }
  };

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !memberId || !memberRole) return;
    if (!file.type.startsWith("image/")) { setPhotoMsg({ type: "err", text: "Please select an image file." }); return; }
    if (file.size > 5 * 1024 * 1024) { setPhotoMsg({ type: "err", text: "Image must be under 5MB." }); return; }
    setPhotoUploading(true); setPhotoMsg(null);
    try {
      const url = await uploadPhoto(file);
      const table = memberRole === "shareholder" ? "shareholders" : "clients";
      const { data: updated, error } = await supabase.from(table).update({ photo_url: url }).eq("id", memberId).select().single();
      if (error) throw new Error(error.message);
      setMemberRecord(updated);
      setPhotoMsg({ type: "ok", text: "Photo updated!" });
    } catch (err: any) {
      setPhotoMsg({ type: "err", text: err.message });
    } finally {
      setPhotoUploading(false);
      if (photoInputRef.current) photoInputRef.current.value = "";
    }
  };

  const email = session?.user?.email ?? "";
  const name = session?.user?.user_metadata?.full_name ?? memberRecord?.name ?? "";
  const hasEmptyFields = memberRecord && (
    !memberRecord.email || !memberRecord.id_passport || !memberRecord.phone
  );

  // Fields config: label, key, type, locked if already has value
  const detailFields: { label: string; key: keyof typeof detailsForm; type: string; locked: boolean }[] = memberRecord ? [
    { label: "Full Name",       key: "name",        type: "text",  locked: !!memberRecord.name },
    { label: "Phone Number",    key: "phone",       type: "tel",   locked: !!memberRecord.phone },
    { label: "Email Address",   key: "email",       type: "email", locked: !!memberRecord.email },
    { label: "ID / Passport No",key: "id_passport", type: "text",  locked: !!memberRecord.id_passport },
  ] : [];

  const emptyCount = detailFields.filter(f => !f.locked).length;

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-xl mx-auto p-4 md:p-6 pb-28 md:pb-6 space-y-5">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600">
          <ArrowLeft size={13} /> Back to Settings
        </button>
        <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Profile Settings</h1>

        {/* Account info */}
        <div className="bg-white rounded-2xl border p-5 space-y-3" style={{ borderColor: "var(--card-border)" }}>
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400">Account Info</h2>
          {name && (
            <div className="flex items-center gap-4">
              {/* Avatar — clickable for members to upload photo */}
              <div className="relative flex-shrink-0">
                <div
                  className="w-28 h-28 rounded-full overflow-hidden flex items-center justify-center text-3xl font-bold text-white"
                  style={{ background: memberRole === "client" ? "#0891b2" : "#6366f1" }}>
                  {memberRecord?.photo_url
                    ? <img src={memberRecord.photo_url} alt={name} className="w-full h-full object-cover" />
                    : name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()
                  }
                </div>
                {/* Camera button — only for shareholders/clients */}
                {memberRecord && (
                  <button
                    onClick={() => photoInputRef.current?.click()}
                    disabled={photoUploading}
                    title="Change photo"
                    className="absolute bottom-0 right-0 w-8 h-8 rounded-full border-2 border-white flex items-center justify-center shadow-sm transition-opacity hover:opacity-90"
                    style={{ background: memberRole === "client" ? "#0891b2" : "#6366f1" }}>
                    {photoUploading
                      ? <Loader2 size={13} className="animate-spin text-white" />
                      : <Camera size={13} className="text-white" />}
                  </button>
                )}
                <input ref={photoInputRef} type="file" accept="image/*" className="hidden" onChange={handlePhotoUpload} />
              </div>

              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm" style={{ color: "#1a202c" }}>{name}</p>
                <p className="text-xs text-gray-400 truncate">{email}</p>
                {memberRecord?.member_number && (
                  <span className="inline-block mt-0.5 text-[10px] font-bold px-1.5 py-0.5 rounded-md"
                    style={{ background: memberRole === "client" ? "#ecfeff" : "#eef2ff", color: memberRole === "client" ? "#0891b2" : "#6366f1" }}>
                    {memberRole === "client" ? "EC" : "EW"}#{memberRecord.member_number}
                  </span>
                )}
                {memberRecord && (
                  <p className="text-[11px] text-gray-400 mt-1">
                    {memberRecord.photo_url ? "Tap the camera icon to change your photo" : "Tap the camera icon to add a profile photo"}
                  </p>
                )}
                {photoMsg && (
                  <p className={`text-[11px] font-semibold mt-1 ${photoMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
                    {photoMsg.text}
                  </p>
                )}
              </div>
            </div>
          )}
          {!name && email && <p className="text-sm text-gray-500">{email}</p>}
        </div>

        {/* My Details — only for shareholders / clients */}
        {loadingMember && (
          <div className="bg-white rounded-2xl border p-5 flex items-center gap-2 text-sm text-gray-400" style={{ borderColor: "var(--card-border)" }}>
            <Loader2 size={15} className="animate-spin" /> Loading your details…
          </div>
        )}

        {!loadingMember && memberRecord && (
          <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
            {/* Header */}
            <div className="px-5 py-4 flex items-center justify-between border-b" style={{ borderColor: "var(--border)" }}>
              <div>
                <h2 className="text-sm font-bold" style={{ color: "#1a202c" }}>My Details</h2>
                <p className="text-xs text-gray-400 mt-0.5">
                  {emptyCount > 0
                    ? `${emptyCount} field${emptyCount > 1 ? "s" : ""} still empty — fill them in below`
                    : "All your details are up to date"}
                </p>
              </div>
              {emptyCount > 0 && (
                <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg"
                  style={{ background: "#fef9c3", color: "#92400e" }}>
                  <AlertCircle size={12} /> {emptyCount} empty
                </span>
              )}
              {emptyCount === 0 && (
                <span className="flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-lg"
                  style={{ background: "#f0fdf4", color: "#16a34a" }}>
                  <CheckCircle2 size={12} /> Complete
                </span>
              )}
            </div>

            <div className="p-5 space-y-4">
              {detailFields.map(({ label, key, type, locked }) => (
                <div key={key}>
                  <label className="flex items-center gap-1.5 text-xs font-semibold mb-1" style={{ color: locked ? "#6b7280" : "#374151" }}>
                    {label}
                    {locked
                      ? <span className="text-[10px] font-normal text-gray-400 ml-1">(locked)</span>
                      : <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded" style={{ background: "#fef9c3", color: "#92400e" }}>Empty — fill in</span>
                    }
                  </label>
                  <input
                    type={type}
                    value={detailsForm[key]}
                    onChange={(e) => !locked && setDetailsForm(f => ({ ...f, [key]: e.target.value }))}
                    readOnly={locked}
                    placeholder={locked ? "" : `Enter your ${label.toLowerCase()}`}
                    className={`w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none transition-colors ${
                      locked
                        ? "bg-gray-50 text-gray-400 cursor-not-allowed"
                        : "bg-white focus:ring-2 focus:ring-amber-200"
                    }`}
                    style={{ borderColor: locked ? "#e5e7eb" : "#f59e0b" }}
                  />
                </div>
              ))}

              {detailsMsg && (
                <p className={`text-xs font-semibold ${detailsMsg.type === "ok" ? "text-green-600" : "text-red-500"}`}>
                  {detailsMsg.text}
                </p>
              )}

              <button onClick={handleDetailsSave} disabled={detailsSaving || emptyCount === 0}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50 flex items-center justify-center gap-2"
                style={{ background: emptyCount > 0 ? "#f59e0b" : "#9ca3af" }}>
                {detailsSaving ? <><Loader2 size={15} className="animate-spin" /> Saving…</> : emptyCount === 0 ? "All Details Saved" : "Save My Details"}
              </button>
            </div>
          </div>
        )}

        {/* Change password */}
        <div className="bg-white rounded-2xl border p-5 space-y-4" style={{ borderColor: "var(--card-border)" }}>
          <h2 className="text-xs font-bold uppercase tracking-widest text-gray-400">Change Password</h2>
          {[
            { label: "New Password",     val: newPw,     set: setNewPw },
            { label: "Confirm Password", val: confirmPw, set: setConfirmPw },
          ].map(({ label, val, set }) => (
            <div key={label}>
              <label className="block text-xs font-semibold text-gray-500 mb-1">{label}</label>
              <input type="password" value={val} onChange={(e) => set(e.target.value)}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          ))}
          {msg && (
            <p className={`text-xs font-semibold ${msg.type === "ok" ? "text-green-600" : "text-red-500"}`}>{msg.text}</p>
          )}
          <button onClick={handlePasswordSave} disabled={saving}
            className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#6366f1" }}>
            {saving ? "Saving…" : "Update Password"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Activity Log Page ────────────────────────────────────────────────────────

const CATEGORY_META: Record<ActivityCategory, { label: string; color: string; bg: string; icon: React.ReactNode }> = {
  auth:         { label: "Auth",         color: "#7c3aed", bg: "#f5f3ff", icon: <LogIn size={13} /> },
  contribution: { label: "Contribution", color: "#6366f1", bg: "#eef2ff", icon: <PayIcon size={13} /> },
  payment:      { label: "Payment",      color: "#059669", bg: "#f0fdf4", icon: <PayIcon size={13} /> },
  shareholder:  { label: "Shareholder",  color: "#2563eb", bg: "#eff6ff", icon: <UserPlus size={13} /> },
  client:       { label: "Client",       color: "#0891b2", bg: "#ecfeff", icon: <UserPlus size={13} /> },
  investor:     { label: "Investor",     color: "#d97706", bg: "#fffbeb", icon: <BarChart2 size={13} /> },
  project:      { label: "Project",      color: "#16a34a", bg: "#f0fdf4", icon: <Map size={13} /> },
  plot:         { label: "Plot",         color: "#0d9488", bg: "#f0fdfa", icon: <Map size={13} /> },
  profit:       { label: "Profit",       color: "#ca8a04", bg: "#fefce8", icon: <BarChart2 size={13} /> },
  refund:       { label: "Refund",       color: "#dc2626", bg: "#fef2f2", icon: <RefreshCcw size={13} /> },
  settings:     { label: "Settings",     color: "#475569", bg: "#f8fafc", icon: <Settings2 size={13} /> },
  sms:          { label: "SMS",          color: "#0284c7", bg: "#f0f9ff", icon: <BellRing size={13} /> },
  other:        { label: "Other",        color: "#9ca3af", bg: "#f9fafb", icon: <ShieldAlert size={13} /> },
};

function ActivityLogPage({ onBack }: { onBack: () => void }) {
  const [logs, setLogs]         = useState<ActivityLog[]>([]);
  const [loading, setLoading]   = useState(true);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo]     = useState("");
  const [actorQ, setActorQ]     = useState("");
  const [catFilter, setCatFilter] = useState<ActivityCategory | "">("");
  const [clearing, setClearing] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const data = await activityLogApi.list({
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        actor: actorQ || undefined,
        category: catFilter || undefined,
        limit: 500,
      });
      setLogs(data);
    } catch { setLogs([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, []);

  const handleFilter = () => load();

  const handleClear = async () => {
    setClearing(true);
    try { await activityLogApi.clear(); setLogs([]); setConfirmClear(false); }
    catch { } finally { setClearing(false); }
  };

  const fmtTs = (ts: string) => {
    const d = new Date(ts);
    return d.toLocaleString("en-KE", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };

  const categories = Object.keys(CATEGORY_META) as ActivityCategory[];

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-4xl mx-auto p-4 md:p-6">
        {/* Header */}
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 mb-4">
          <ArrowLeft size={13} /> Back to Settings
        </button>
        <div className="flex items-center justify-between mb-1">
          <div>
            <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Activity Log</h1>
            <p className="text-sm text-gray-400">Every action tracked across the system</p>
          </div>
          <button onClick={() => setConfirmClear(true)}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
            Clear All
          </button>
        </div>

        {/* Filters */}
        <div className="bg-white rounded-2xl border p-4 mb-4 mt-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center gap-2 mb-3">
            <Filter size={13} style={{ color: "#6b7280" }} />
            <span className="text-xs font-bold text-gray-500 uppercase tracking-wide">Filters</span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">Date From</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className="w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">Date To</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className="w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">User / Actor</label>
              <input type="text" value={actorQ} onChange={(e) => setActorQ(e.target.value)}
                placeholder="Search by name…"
                className="w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-gray-400 mb-1">Category</label>
              <select value={catFilter} onChange={(e) => setCatFilter(e.target.value as ActivityCategory | "")}
                className="w-full border rounded-lg px-2.5 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-indigo-300"
                style={{ borderColor: "var(--border)" }}>
                <option value="">All Categories</option>
                {categories.map((c) => (
                  <option key={c} value={c}>{CATEGORY_META[c].label}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <button onClick={handleFilter}
              className="flex items-center gap-1.5 text-xs font-bold px-4 py-2 rounded-lg text-white"
              style={{ background: "#6366f1" }}>
              <Filter size={12} /> Apply Filters
            </button>
          </div>
        </div>

        {/* Log table */}
        <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center justify-between px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs font-semibold text-gray-500">{logs.length} event{logs.length !== 1 ? "s" : ""}</span>
            <button onClick={load} className="text-xs font-semibold text-indigo-500 hover:text-indigo-700 flex items-center gap-1">
              <RefreshCw size={12} /> Refresh
            </button>
          </div>

          {loading ? (
            <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin" style={{ color: "#6366f1" }} /></div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-3" style={{ background: "#f0fdf4", color: "#059669" }}>
                <Activity size={28} />
              </div>
              <p className="font-semibold text-sm text-gray-500">No activity recorded yet</p>
              <p className="text-xs text-gray-400 mt-1">Actions in the app will appear here</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {logs.map((log) => {
                const cat = CATEGORY_META[log.category] ?? CATEGORY_META.other;
                // Action badge — color-coded by what was done
                const actionKey = (log.action ?? "").toLowerCase();
                const actionMeta = actionKey === "create"
                  ? { label: "Added",   color: "#15803d", bg: "#dcfce7" }
                  : actionKey === "update"
                  ? { label: "Edited",  color: "#b45309", bg: "#fef3c7" }
                  : actionKey === "delete"
                  ? { label: "Deleted", color: "#b91c1c", bg: "#fee2e2" }
                  : actionKey === "payment"
                  ? { label: "Payment", color: "#0d9488", bg: "#ccfbf1" }
                  : actionKey === "login"
                  ? { label: "Login",   color: "#7c3aed", bg: "#ede9fe" }
                  : actionKey === "logout"
                  ? { label: "Logout",  color: "#64748b", bg: "#f1f5f9" }
                  : actionKey === "status"
                  ? { label: "Status",  color: "#2563eb", bg: "#dbeafe" }
                  : { label: log.action ?? "Action", color: "#6b7280", bg: "#f3f4f6" };

                return (
                  <div key={log.id} className="flex items-start gap-3 px-4 py-3.5 hover:bg-gray-50 transition-colors">
                    {/* Category icon */}
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: cat.bg, color: cat.color }}>
                      {cat.icon}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Row 1: Action badge + Module badge */}
                      <div className="flex items-center gap-1.5 flex-wrap mb-1">
                        <span className="text-[10px] font-extrabold uppercase tracking-wide px-2 py-0.5 rounded-full"
                          style={{ background: actionMeta.bg, color: actionMeta.color }}>
                          {actionMeta.label}
                        </span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                          style={{ background: cat.bg, color: cat.color }}>
                          {cat.label}
                        </span>
                      </div>

                      {/* Row 2: Description */}
                      <p className="text-sm leading-snug" style={{ color: "#1a202c" }}>{log.description}</p>

                      {/* Row 3: By who + timestamp */}
                      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                        <span className="flex items-center gap-1 text-xs font-semibold"
                          style={{ color: log.actor_name ? "#374151" : "#9ca3af" }}>
                          <UserCircle2 size={11} className="flex-shrink-0" style={{ color: log.actor_name ? "#6366f1" : "#d1d5db" }} />
                          {log.actor_name ?? "Unknown user"}
                        </span>
                        {log.actor_role && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold capitalize"
                            style={{ background: "#f1f5f9", color: "#475569" }}>
                            {log.actor_role}
                          </span>
                        )}
                        <span className="text-gray-200 select-none">·</span>
                        <span className="text-[11px] text-gray-400">
                          {new Date(log.created_at).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}
                          {" "}
                          <span className="font-semibold" style={{ color: "#6b7280" }}>
                            {new Date(log.created_at).toLocaleTimeString("en-KE", { hour: "2-digit", minute: "2-digit" })}
                          </span>
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Confirm clear modal */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-3">
              <Trash2 size={22} className="text-red-500" />
            </div>
            <p className="font-bold text-gray-800 mb-1">Clear Activity Log?</p>
            <p className="text-sm text-gray-400 mb-5">This will permanently delete all {logs.length} log entries. This cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmClear(false)} className="flex-1 py-2 rounded-xl border text-sm font-semibold text-gray-500"
                style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button onClick={handleClear} disabled={clearing}
                className="flex-1 py-2 rounded-xl text-sm font-bold text-white bg-red-500 disabled:opacity-60">
                {clearing ? "Clearing…" : "Clear All"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SettingsPage({ isAdmin = true }: { isAdmin?: boolean }) {
  const [sub, setSub] = useState<SettingsSub>(null);

  if (sub === "data-upload") return <DataUploadPage onBack={() => setSub(null)} />;
  if (sub === "app-maintenance") return <AppMaintenancePage onBack={() => setSub(null)} />;
  if (sub === "company-details") return <CompanyDetailsPage onBack={() => setSub(null)} />;
  if (sub === "payment-settings") return <PaymentSettingsPage onBack={() => setSub(null)} />;
  if (sub === "sms-settings") return <SmsSettingsPage onBack={() => setSub(null)} />;
  if (sub === "profile") return <ProfileSettingsPage onBack={() => setSub(null)} />;
  if (sub === "activity-log") return <ActivityLogPage onBack={() => setSub(null)} />;
  if (sub === "payment-rules") return <PaymentRulesPage onBack={() => setSub(null)} />;
  if (sub === "help") return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-3xl mx-auto p-4 md:p-6">
        <button onClick={() => setSub(null)} className="flex items-center gap-1.5 text-xs font-semibold text-gray-400 hover:text-gray-600 mb-4">
          <ArrowLeft size={13} /> Back to Settings
        </button>
        <h1 className="font-bold text-xl mb-1" style={{ color: "#1a202c" }}>Help & Support</h1>
        <p className="text-sm text-gray-400 mb-6">Frequently asked questions and system guidance</p>
        <div className="space-y-3">
          {[
            { q: "How do I add a new shareholder?", a: "Go to Shareholders in the sidebar, click the Add button, fill in the member's details and save. A member number is auto-assigned." },
            { q: "How do members log in?", a: "Members log in using their registered phone number (e.g. 0712345678) and the default password 123456. They are prompted to change their password on first login." },
            { q: "How do I bulk-create login accounts?", a: "Go to Settings → User Accounts and click the Bulk Create button. Accounts will be created for all members who don't already have one." },
            { q: "How do I import shareholders from a spreadsheet?", a: "Go to Settings → Data Upload, select Shareholders, download the CSV template, fill it in, then upload. Duplicate member numbers are skipped automatically." },
            { q: "How do I record an M-Pesa contribution?", a: "Paste the M-Pesa confirmation SMS into the Contributions page. The system auto-parses the amount, reference and date." },
            { q: "How do I distribute profits to shareholders?", a: "Open a Project, scroll to the Profit Distributions section, click Distribute Profit, enter each member's amount and save." },
            { q: "How do I fix the RLS policy error when importing data?", a: "Run the SQL from the README in Supabase Dashboard → SQL Editor to re-apply the permissive RLS policies for the anon and authenticated roles." },
            { q: "What is the default member password?", a: "123456. Members are required to set a new personal password on their first login." },
          ].map(({ q, a }, i) => (
            <FaqItem key={i} question={q} answer={a} />
          ))}
        </div>
      </div>
    </div>
  );
  const allCards = [
    {
      label: "Profile Settings", sub: "View account info and change your password",
      icon: <Lock size={18} />, iconBg: "#f5f3ff", color: "#7c3aed", action: () => setSub("profile"), memberVisible: true,
    },
    {
      label: "Help & Support", sub: "FAQs and system guidance",
      icon: <HelpCircle size={18} />, iconBg: "#eef2ff", color: "#4f46e5", action: () => setSub("help"), memberVisible: false,
    },
    {
      label: "Company Details", sub: "Logo, name, contact info & location",
      icon: <Building2 size={18} />, iconBg: "#f0fdf4", color: "#16a34a", action: () => setSub("company-details"), memberVisible: false,
    },
    {
      label: "Plot / Contribution Payment Rules", sub: "Deadlines, grace periods & late penalties — date per transaction",
      icon: <Link2 size={18} />, iconBg: "#f0fdfa", color: "#0d9488", action: () => setSub("payment-rules"), memberVisible: false,
    },
    {
      label: "Payment Methods", sub: "Enable or disable payment methods (M-Pesa, Cash, Bank, Cheque)",
      icon: <CreditCard size={18} />, iconBg: "#fff7ed", color: "#ea580c", action: () => setSub("payment-settings"), memberVisible: false,
    },
    {
      label: "SMS Notifications", sub: "Africa's Talking — member alerts & reminders",
      icon: <MessageSquare size={18} />, iconBg: "#eff6ff", color: "#2563eb", action: () => setSub("sms-settings"), memberVisible: false,
    },
    {
      label: "Data Upload", sub: "Import shareholders, clients, contributions & payments",
      icon: <FileSpreadsheet size={18} />, iconBg: "#f0fdf4", color: "#16a34a", action: () => setSub("data-upload"), memberVisible: false,
    },
    {
      label: "App Maintenance", sub: "Data ops, modules & licence — Super Admin",
      icon: <Wrench size={18} />, iconBg: "#f8fafc", color: "#475569", action: () => setSub("app-maintenance"), memberVisible: false,
    },
    {
      label: "Activity Log", sub: "Logins, payments, edits, deletes — full audit trail",
      icon: <Activity size={18} />, iconBg: "#fdf4ff", color: "#9333ea", action: () => setSub("activity-log"), memberVisible: false,
    },
  ];
  const cards = isAdmin ? allCards : allCards.filter((c) => c.memberVisible);

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-4xl mx-auto p-4 md:p-6">
        <div className="mb-5">
          <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Settings</h1>
          <p className="text-sm text-gray-400">{isAdmin ? "Configure your Sacco system" : "Account & support"}</p>
        </div>

        {isAdmin && <DbStatusBadge />}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {cards.map((card) => (
            <button
              key={card.label}
              onClick={card.action}
              className="flex items-center gap-4 px-5 py-4 rounded-2xl bg-white border text-left hover:shadow-md transition-shadow group"
              style={{ borderColor: "var(--card-border)" }}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: card.iconBg }}>
                <span style={{ color: card.color }}>{card.icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold" style={{ color: card.color }}>{card.label}</div>
                <div className="text-xs mt-0.5 truncate text-[#303235]">{card.sub}</div>
              </div>
              <ChevronRight size={15} className="text-gray-300 flex-shrink-0 group-hover:text-gray-400 transition-colors" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

export { SettingsPage };
