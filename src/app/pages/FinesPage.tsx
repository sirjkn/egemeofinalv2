import React, { useState, useEffect, useCallback } from "react";
import {
  AlertCircle, Loader2, FileDown, Filter, CheckCircle, X,
  RefreshCw, TrendingUp, Layers, ChevronDown,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getCompanyDetails } from "@/lib/company";
import { MONTHS, fmtKES } from "@/app/shared";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FineRow {
  id: number;
  type: "contribution" | "plot";
  member_name: string;
  member_number: string | number;
  member_type: "shareholder" | "client";
  period: string;
  project: string;
  fine_amount: number;
  fine_status: "unpaid" | "paid" | "waived" | "none";
  record_date: string;
}

// ─── PDF ──────────────────────────────────────────────────────────────────────

async function downloadFinesPdf(rows: FineRow[], filters: string) {
  const company = await getCompanyDetails();
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const accent: [number, number, number] = [30, 58, 95];
  doc.setFillColor(...accent);
  doc.rect(0, 0, 297, 22, "F");
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text(company.name || "SACCO", 14, 10);
  doc.setFontSize(9);
  doc.setFont("helvetica", "normal");
  doc.text("Fines & Penalties Report", 14, 16);
  if (filters) doc.text(`Filters: ${filters}`, 14, 21);
  doc.text(new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }), 283, 10, { align: "right" });
  const totalFines  = rows.reduce((s, r) => s + r.fine_amount, 0);
  const totalPaid   = rows.filter((r) => r.fine_status === "paid").reduce((s, r) => s + r.fine_amount, 0);
  const totalUnpaid = rows.filter((r) => r.fine_status === "unpaid").reduce((s, r) => s + r.fine_amount, 0);
  autoTable(doc, {
    startY: 26,
    head: [["Type", "Member", "No.", "Member Type", "Period / Plot", "Project", "Fine (KES)", "Status", "Date"]],
    body: rows.map((r) => [
      r.type === "contribution" ? "Contribution" : "Plot Payment",
      r.member_name,
      String(r.member_number),
      r.member_type === "shareholder" ? "Shareholder" : "Client",
      r.period,
      r.project || "—",
      Number(r.fine_amount).toLocaleString("en-KE"),
      r.fine_status.charAt(0).toUpperCase() + r.fine_status.slice(1),
      new Date(r.record_date).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
    ]),
    foot: [[
      "TOTALS", "", "", "", "", "",
      `Total: ${Number(totalFines).toLocaleString("en-KE")}`,
      `Paid: ${Number(totalPaid).toLocaleString("en-KE")} | Unpaid: ${Number(totalUnpaid).toLocaleString("en-KE")}`,
      "",
    ]],
    headStyles: { fillColor: accent, textColor: 255, fontStyle: "bold", fontSize: 8 },
    footStyles: { fillColor: [245, 247, 250], textColor: 50, fontStyle: "bold", fontSize: 7 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    columnStyles: { 6: { halign: "right" } },
    didDrawPage: () => {
      doc.setFontSize(7);
      doc.setTextColor(150);
      doc.text(`© ${new Date().getFullYear()} ${company.name || "SACCO"} — Confidential`, 14, doc.internal.pageSize.height - 5);
    },
  });
  const blob = doc.output("blob");
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fines-report-${Date.now()}.pdf`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; color: string }> = {
    unpaid: { bg: "#fef2f2", color: "#dc2626" },
    paid:   { bg: "#f0fdf4", color: "#16a34a" },
    waived: { bg: "#f5f3ff", color: "#7c3aed" },
    none:   { bg: "#f8fafc", color: "#94a3b8" },
  };
  const s = styles[status] ?? styles.none;
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full capitalize"
      style={{ background: s.bg, color: s.color }}>
      {status}
    </span>
  );
}

function TypeBadge({ type }: { type: "contribution" | "plot" }) {
  return (
    <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
      style={{
        background: type === "contribution" ? "#eef2ff" : "#ecfdf5",
        color:      type === "contribution" ? "#4338ca" : "#059669",
      }}>
      {type === "contribution" ? "Contrib" : "Plot"}
    </span>
  );
}

function MemberTypeBadge({ type }: { type: "shareholder" | "client" }) {
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
      style={{
        background: type === "shareholder" ? "#dbeafe" : "#fef3c7",
        color:      type === "shareholder" ? "#1d4ed8" : "#b45309",
      }}>
      {type === "shareholder" ? "SH" : "CL"}
    </span>
  );
}

// ─── FinesPage ────────────────────────────────────────────────────────────────

export function FinesPage() {
  const [rows, setRows]       = useState<FineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr]         = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);

  const [dateFrom, setDateFrom]     = useState("");
  const [dateTo, setDateTo]         = useState("");
  const [memberType, setMemberType] = useState<"" | "shareholder" | "client">("");
  const [fineBy, setFineBy]         = useState<"" | "contribution" | "plot">("");
  const [statusF, setStatusF]       = useState<"" | "unpaid" | "paid" | "waived">("");

  const [updatingId, setUpdatingId] = useState<string | null>(null);

  const hasFilters = !!(dateFrom || dateTo || memberType || fineBy || statusF);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const results: FineRow[] = [];

      if (fineBy !== "plot") {
        const { data: contribs, error: ce } = await supabase
          .from("contributions")
          .select("id, month, year, payment_date, created_at, penalty_amount, penalty_status, shareholder_id, shareholders(id, name, member_number)")
          .gt("penalty_amount", 0)
          .order("created_at", { ascending: false });
        if (ce) throw new Error(ce.message);
        for (const c of contribs ?? []) {
          const sh = (c as any).shareholders;
          if (!sh) continue;
          if (memberType === "client") continue;
          results.push({
            id: c.id, type: "contribution",
            member_name: sh.name, member_number: sh.member_number, member_type: "shareholder",
            period: `${MONTHS[(c.month ?? 1) - 1]} ${c.year}`, project: "—",
            fine_amount: Number(c.penalty_amount),
            fine_status: (c.penalty_status as FineRow["fine_status"]) ?? "unpaid",
            record_date: c.payment_date || c.created_at,
          });
        }
      }

      if (fineBy !== "contribution") {
        const { data: plotPays, error: pe } = await supabase
          .from("plot_payments")
          .select("id, payment_date, created_at, penalty_amount, penalty_status, plot_id, plots(id, plot_number, assigned_to_id, assigned_to_type, projects(project_name))")
          .gt("penalty_amount", 0)
          .order("created_at", { ascending: false });
        if (pe) throw new Error(pe.message);
        const shIds = new Set<number>();
        const clIds = new Set<number>();
        for (const pp of plotPays ?? []) {
          const plot = (pp as any).plots;
          if (!plot) continue;
          if (plot.assigned_to_type === "shareholder" && plot.assigned_to_id) shIds.add(plot.assigned_to_id);
          if (plot.assigned_to_type === "client"      && plot.assigned_to_id) clIds.add(plot.assigned_to_id);
        }
        const shMap: Record<number, { name: string; member_number: string | number }> = {};
        const clMap: Record<number, { name: string; member_number: string | number }> = {};
        if (shIds.size > 0) {
          const { data: shs } = await supabase.from("shareholders").select("id, name, member_number").in("id", [...shIds]);
          (shs ?? []).forEach((s: any) => { shMap[s.id] = { name: s.name, member_number: s.member_number }; });
        }
        if (clIds.size > 0) {
          const { data: cls } = await supabase.from("clients").select("id, name, member_number").in("id", [...clIds]);
          (cls ?? []).forEach((c: any) => { clMap[c.id] = { name: c.name, member_number: c.member_number }; });
        }
        for (const pp of plotPays ?? []) {
          const plot = (pp as any).plots;
          if (!plot) continue;
          const isShType = plot.assigned_to_type === "shareholder";
          if (memberType === "shareholder" && !isShType) continue;
          if (memberType === "client"      && isShType)  continue;
          const member = isShType ? shMap[plot.assigned_to_id] : clMap[plot.assigned_to_id];
          if (!member) continue;
          results.push({
            id: pp.id, type: "plot",
            member_name: member.name, member_number: member.member_number,
            member_type: isShType ? "shareholder" : "client",
            period: plot.plot_number, project: (plot.projects as any)?.project_name ?? "—",
            fine_amount: Number(pp.penalty_amount),
            fine_status: (pp.penalty_status as FineRow["fine_status"]) ?? "unpaid",
            record_date: pp.payment_date || pp.created_at,
          });
        }
      }

      let filtered = results;
      if (dateFrom) filtered = filtered.filter((r) => r.record_date >= dateFrom);
      if (dateTo)   filtered = filtered.filter((r) => r.record_date <= dateTo + "T23:59:59");
      if (statusF)  filtered = filtered.filter((r) => r.fine_status === statusF);
      filtered.sort((a, b) => new Date(b.record_date).getTime() - new Date(a.record_date).getTime());
      setRows(filtered);
    } catch (e: any) {
      setErr(e.message ?? "Failed to load fines.");
    } finally {
      setLoading(false);
    }
  }, [fineBy, memberType, dateFrom, dateTo, statusF]);

  useEffect(() => { load(); }, [load]);

  const updateStatus = async (row: FineRow, newStatus: "unpaid" | "paid" | "waived") => {
    const key = `${row.type}-${row.id}`;
    setUpdatingId(key);
    try {
      if (row.type === "contribution") {
        await supabase.from("contributions").update({ penalty_status: newStatus }).eq("id", row.id);
      } else {
        await supabase.from("plot_payments").update({ penalty_status: newStatus }).eq("id", row.id);
      }
      setRows((prev) => prev.map((r) => r.id === row.id && r.type === row.type ? { ...r, fine_status: newStatus } : r));
    } catch { /* ignore */ }
    finally { setUpdatingId(null); }
  };

  const totalFines  = rows.reduce((s, r) => s + r.fine_amount, 0);
  const totalUnpaid = rows.filter((r) => r.fine_status === "unpaid").reduce((s, r) => s + r.fine_amount, 0);
  const totalPaid   = rows.filter((r) => r.fine_status === "paid").reduce((s, r) => s + r.fine_amount, 0);
  const totalWaived = rows.filter((r) => r.fine_status === "waived").reduce((s, r) => s + r.fine_amount, 0);

  const filtersLabel = [
    dateFrom && `From ${dateFrom}`,
    dateTo && `To ${dateTo}`,
    memberType && (memberType === "shareholder" ? "Shareholders" : "Clients"),
    fineBy && (fineBy === "contribution" ? "Contribution Fines" : "Plot Payment Fines"),
    statusF && `Status: ${statusF}`,
  ].filter(Boolean).join(" · ");

  const selCls = "w-full border rounded-xl px-3 py-2 text-xs focus:outline-none bg-white";

  const fmtDate = (s: string) =>
    new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" });

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ background: "var(--background)" }}>

      {/* ── Top bar ── */}
      <div className="flex-shrink-0 px-4 md:px-6 pt-4 pb-3 flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-bold" style={{ color: "#1a202c" }}>Fines & Penalties</h1>
          <p className="text-xs text-gray-400 mt-0.5">All contribution and plot payment fines</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFiltersOpen((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:bg-gray-50 transition-colors md:hidden relative"
            style={{ borderColor: "var(--border)", color: hasFilters ? "#16a34a" : "#64748b" }}>
            <Filter size={13} />
            Filters
            {hasFilters && <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-green-500" />}
          </button>
          <button onClick={load}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl border text-xs font-semibold hover:bg-gray-50 transition-colors"
            style={{ borderColor: "var(--border)", color: "#64748b" }}>
            <RefreshCw size={13} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <button
            onClick={() => downloadFinesPdf(rows, filtersLabel)}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
            style={{ background: "#16a34a" }}>
            <FileDown size={13} />
            <span className="hidden sm:inline">Export PDF</span>
          </button>
        </div>
      </div>

      {/* ── Stats row ── */}
      <div className="flex-shrink-0 grid grid-cols-2 md:grid-cols-4 gap-3 px-4 md:px-6 pb-3">
        {[
          { label: "Total Fines", value: fmtKES(totalFines),  color: "#6366f1", bg: "#eef2ff", icon: <Layers size={16} color="#6366f1" /> },
          { label: "Unpaid",      value: fmtKES(totalUnpaid), color: "#dc2626", bg: "#fef2f2", icon: <AlertCircle size={16} color="#dc2626" /> },
          { label: "Paid",        value: fmtKES(totalPaid),   color: "#16a34a", bg: "#f0fdf4", icon: <CheckCircle size={16} color="#16a34a" /> },
          { label: "Waived",      value: fmtKES(totalWaived), color: "#7c3aed", bg: "#f5f3ff", icon: <TrendingUp size={16} color="#7c3aed" /> },
        ].map((s) => (
          <div key={s.label} className="bg-white rounded-xl border p-3 flex items-center gap-3"
            style={{ borderColor: "var(--card-border)" }}>
            <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: s.bg }}>
              {s.icon}
            </div>
            <div className="min-w-0">
              <p className="text-xs text-gray-400 truncate">{s.label}</p>
              <p className="text-sm font-bold truncate" style={{ color: s.color }}>{s.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Filters — desktop always visible, mobile collapsible ── */}
      <div className={`flex-shrink-0 px-4 md:px-6 pb-3 ${filtersOpen || "hidden md:block"}`}>
        <div className="bg-white rounded-xl border p-3" style={{ borderColor: "var(--card-border)" }}>
          <div className="hidden md:flex items-center gap-1.5 mb-2">
            <Filter size={12} className="text-gray-400" />
            <span className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide">Filters</span>
            {hasFilters && (
              <button onClick={() => { setDateFrom(""); setDateTo(""); setMemberType(""); setFineBy(""); setStatusF(""); }}
                className="ml-auto flex items-center gap-1 text-xs font-semibold text-red-500 hover:text-red-700">
                <X size={11} /> Clear
              </button>
            )}
          </div>

          {/* Mobile header */}
          <div className="flex items-center justify-between mb-2 md:hidden">
            <span className="text-xs font-semibold text-gray-500">Filters</span>
            <div className="flex items-center gap-2">
              {hasFilters && (
                <button onClick={() => { setDateFrom(""); setDateTo(""); setMemberType(""); setFineBy(""); setStatusF(""); }}
                  className="flex items-center gap-1 text-xs font-semibold text-red-500">
                  <X size={11} /> Clear
                </button>
              )}
              <button onClick={() => setFiltersOpen(false)} className="text-gray-400">
                <ChevronDown size={14} />
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-2">
            <div>
              <label className="text-[10px] font-semibold text-gray-400 block mb-1">From Date</label>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
                className={selCls} style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-400 block mb-1">To Date</label>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
                className={selCls} style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-400 block mb-1">Member Type</label>
              <select value={memberType} onChange={(e) => setMemberType(e.target.value as any)}
                className={selCls} style={{ borderColor: "var(--border)" }}>
                <option value="">All Members</option>
                <option value="shareholder">Shareholders</option>
                <option value="client">Clients</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-400 block mb-1">Fines By</label>
              <select value={fineBy} onChange={(e) => setFineBy(e.target.value as any)}
                className={selCls} style={{ borderColor: "var(--border)" }}>
                <option value="">All Types</option>
                <option value="contribution">Contribution</option>
                <option value="plot">Plot Payment</option>
              </select>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-gray-400 block mb-1">Status</label>
              <select value={statusF} onChange={(e) => setStatusF(e.target.value as any)}
                className={selCls} style={{ borderColor: "var(--border)" }}>
                <option value="">All Statuses</option>
                <option value="unpaid">Unpaid</option>
                <option value="paid">Paid</option>
                <option value="waived">Waived</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-auto px-4 md:px-6 pb-24 md:pb-6">
        {loading ? (
          <div className="flex justify-center items-center py-16 gap-2 text-sm text-gray-400">
            <Loader2 size={16} className="animate-spin" /> Loading fines…
          </div>
        ) : err ? (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm"
            style={{ background: "#fef2f2", color: "#dc2626" }}>
            <AlertCircle size={14} /> {err}
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
              style={{ background: "#f0fdf4" }}>
              <CheckCircle size={28} color="#16a34a" />
            </div>
            <p className="font-semibold text-gray-500">No fines found</p>
            <p className="text-xs text-gray-400 mt-1">No penalty records match the current filters.</p>
          </div>
        ) : (
          <>
            {/* ── Desktop table (md+) ── */}
            <div className="hidden md:block bg-white rounded-2xl border overflow-hidden"
              style={{ borderColor: "var(--card-border)" }}>
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[780px]">
                  <thead>
                    <tr className="text-white text-[10px] font-semibold" style={{ background: "#1e3a5f" }}>
                      <th className="px-3 py-2.5 text-left w-24">Type</th>
                      <th className="px-3 py-2.5 text-left">Member</th>
                      <th className="px-3 py-2.5 text-left w-16">No.</th>
                      <th className="px-3 py-2.5 text-left w-16">M.Type</th>
                      <th className="px-3 py-2.5 text-left w-24">Period/Plot</th>
                      <th className="px-3 py-2.5 text-left w-24">Project</th>
                      <th className="px-3 py-2.5 text-right w-24">Fine (KES)</th>
                      <th className="px-3 py-2.5 text-left w-20">Date</th>
                      <th className="px-3 py-2.5 text-left w-20">Status</th>
                      <th className="px-3 py-2.5 text-left w-20">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => (
                      <tr key={`${row.type}-${row.id}`}
                        style={{ background: i % 2 === 0 ? "#f8fafc" : "#fff" }}>
                        <td className="px-3 py-2.5"><TypeBadge type={row.type} /></td>
                        <td className="px-3 py-2.5 font-semibold max-w-[160px] truncate" style={{ color: "#1a202c" }}>{row.member_name}</td>
                        <td className="px-3 py-2.5 text-gray-500">#{row.member_number}</td>
                        <td className="px-3 py-2.5"><MemberTypeBadge type={row.member_type} /></td>
                        <td className="px-3 py-2.5 text-gray-600 truncate max-w-[96px]">{row.period}</td>
                        <td className="px-3 py-2.5 text-gray-400 truncate max-w-[96px]">{row.project}</td>
                        <td className="px-3 py-2.5 text-right font-bold text-red-600">
                          {Number(row.fine_amount).toLocaleString("en-KE")}
                        </td>
                        <td className="px-3 py-2.5 text-gray-500 whitespace-nowrap">{fmtDate(row.record_date)}</td>
                        <td className="px-3 py-2.5"><StatusBadge status={row.fine_status} /></td>
                        <td className="px-3 py-2.5">
                          {updatingId === `${row.type}-${row.id}` ? (
                            <Loader2 size={12} className="animate-spin text-gray-400" />
                          ) : (
                            <select
                              value={row.fine_status}
                              onChange={(e) => updateStatus(row, e.target.value as "unpaid" | "paid" | "waived")}
                              className="text-[10px] border rounded-lg px-1.5 py-1 font-semibold focus:outline-none"
                              style={{
                                borderColor: row.fine_status === "paid" ? "#86efac" : row.fine_status === "waived" ? "#c4b5fd" : "#fca5a5",
                                color:       row.fine_status === "paid" ? "#15803d" : row.fine_status === "waived" ? "#7c3aed"  : "#dc2626",
                                background:  row.fine_status === "paid" ? "#f0fdf4" : row.fine_status === "waived" ? "#f5f3ff"  : "#fef2f2",
                              }}>
                              <option value="unpaid">Unpaid</option>
                              <option value="paid">Paid</option>
                              <option value="waived">Waived</option>
                            </select>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="text-xs font-bold border-t" style={{ borderColor: "#e2e8f0", background: "#f0f4ff" }}>
                      <td className="px-3 py-3" colSpan={6}>
                        <span className="text-gray-500">{rows.length} fine{rows.length !== 1 ? "s" : ""}</span>
                      </td>
                      <td className="px-3 py-3 text-right text-red-600">
                        {Number(totalFines).toLocaleString("en-KE")}
                      </td>
                      <td className="px-3 py-3" />
                      <td className="px-3 py-3 text-green-600 whitespace-nowrap">
                        Paid: {Number(totalPaid).toLocaleString("en-KE")}
                      </td>
                      <td className="px-3 py-3 text-red-500 whitespace-nowrap">
                        Unpaid: {Number(totalUnpaid).toLocaleString("en-KE")}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {/* ── Mobile cards (< md) ── */}
            <div className="md:hidden space-y-3">
              {rows.map((row) => (
                <div key={`${row.type}-${row.id}`}
                  className="bg-white rounded-2xl border overflow-hidden"
                  style={{ borderColor: "var(--card-border)" }}>
                  {/* Card header */}
                  <div className="px-4 py-3 flex items-start justify-between gap-2"
                    style={{ background: "#f8fafc", borderBottom: "1px solid #f1f5f9" }}>
                    <div className="flex-1 min-w-0">
                      <p className="font-bold text-sm truncate" style={{ color: "#1a202c" }}>{row.member_name}</p>
                      <p className="text-[11px] text-gray-400 mt-0.5">#{row.member_number} · {fmtDate(row.record_date)}</p>
                    </div>
                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <span className="text-sm font-black text-red-600">
                        KES {Number(row.fine_amount).toLocaleString("en-KE")}
                      </span>
                      <StatusBadge status={row.fine_status} />
                    </div>
                  </div>

                  {/* Card body */}
                  <div className="px-4 py-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <p className="text-[10px] text-gray-400 mb-0.5">Type</p>
                      <TypeBadge type={row.type} />
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 mb-0.5">Member Type</p>
                      <MemberTypeBadge type={row.member_type} />
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 mb-0.5">Period / Plot</p>
                      <p className="font-medium text-gray-700 truncate">{row.period}</p>
                    </div>
                    <div>
                      <p className="text-[10px] text-gray-400 mb-0.5">Project</p>
                      <p className="font-medium text-gray-700 truncate">{row.project}</p>
                    </div>
                  </div>

                  {/* Card footer — status action */}
                  <div className="px-4 py-2.5 border-t flex items-center justify-between"
                    style={{ borderColor: "#f1f5f9", background: "#fafafa" }}>
                    <span className="text-[10px] text-gray-400 font-semibold uppercase tracking-wide">Update Status</span>
                    {updatingId === `${row.type}-${row.id}` ? (
                      <Loader2 size={13} className="animate-spin text-gray-400" />
                    ) : (
                      <select
                        value={row.fine_status}
                        onChange={(e) => updateStatus(row, e.target.value as "unpaid" | "paid" | "waived")}
                        className="text-xs border rounded-xl px-3 py-1.5 font-semibold focus:outline-none"
                        style={{
                          borderColor: row.fine_status === "paid" ? "#86efac" : row.fine_status === "waived" ? "#c4b5fd" : "#fca5a5",
                          color:       row.fine_status === "paid" ? "#15803d" : row.fine_status === "waived" ? "#7c3aed"  : "#dc2626",
                          background:  row.fine_status === "paid" ? "#f0fdf4" : row.fine_status === "waived" ? "#f5f3ff"  : "#fef2f2",
                        }}>
                        <option value="unpaid">Unpaid</option>
                        <option value="paid">Paid</option>
                        <option value="waived">Waived</option>
                      </select>
                    )}
                  </div>
                </div>
              ))}

              {/* Mobile totals */}
              <div className="bg-white rounded-2xl border p-4 grid grid-cols-2 gap-3 text-xs"
                style={{ borderColor: "var(--card-border)" }}>
                <div>
                  <p className="text-gray-400">Total</p>
                  <p className="font-bold text-red-600">KES {Number(totalFines).toLocaleString("en-KE")}</p>
                </div>
                <div>
                  <p className="text-gray-400">Unpaid</p>
                  <p className="font-bold text-red-500">KES {Number(totalUnpaid).toLocaleString("en-KE")}</p>
                </div>
                <div>
                  <p className="text-gray-400">Paid</p>
                  <p className="font-bold text-green-600">KES {Number(totalPaid).toLocaleString("en-KE")}</p>
                </div>
                <div>
                  <p className="text-gray-400">Waived</p>
                  <p className="font-bold text-purple-600">KES {Number(totalWaived).toLocaleString("en-KE")}</p>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
