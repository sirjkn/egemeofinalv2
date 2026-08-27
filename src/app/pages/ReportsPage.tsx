import { useState, useEffect, useCallback } from "react";
import {
  BarChart2, Link2, CreditCard, RotateCcw, Users, UserCircle2,
  Filter, Search, ChevronRight, ArrowLeft, FileDown, Loader2, TrendingUp,
} from "lucide-react";
import {
  contributionsApi, paymentsApi, shareholdersApi, clientsApi, refundsApi,
  PAYMENT_MODES, PAYMENT_PURPOSES,
} from "@/lib/api";
import { supabase } from "@/lib/supabase";
import {
  downloadPaymentsPdf, downloadContributionsPdf, downloadRefundsPdf,
  downloadMembersPdf, downloadReportPdf,
  type PaymentRow, type ContribRow,
} from "@/lib/pdf";
import { fmtKES, fmtKESFull, fmtDate, MONTHS, CY, YEAR_OPTS } from "@/app/shared";
import { getCompanyDetails, type CompanyDetails } from "@/lib/company";

type ReportSub = "contributions" | "payments" | "refunds" | "shareholders" | "clients" | "summary" | "profits";

const REPORT_META: Record<ReportSub, { label: string; desc: string; color: string; bg: string; icon: React.ReactNode }> = {
  summary:       { label: "Annual Summary",       desc: "Membership, contributions & payments overview", color: "#1e2d4a", bg: "#eef2ff", icon: <BarChart2 size={22} /> },
  contributions: { label: "Contributions Report", desc: "All monthly contributions with status",         color: "#6366f1", bg: "#eef2ff", icon: <Link2 size={22} /> },
  payments:      { label: "Payments Report",       desc: "All payments with mode and purpose",           color: "#14b8a6", bg: "#f0fdfa", icon: <CreditCard size={22} /> },
  refunds:       { label: "Refunds Report",        desc: "All processed refunds",                        color: "#ef4444", bg: "#fef2f2", icon: <RotateCcw size={22} /> },
  shareholders:  { label: "Shareholders List",     desc: "All shareholders with savings",                color: "#6366f1", bg: "#eef2ff", icon: <Users size={22} /> },
  clients:       { label: "Clients List",          desc: "All registered clients",                       color: "#a855f7", bg: "#faf5ff", icon: <UserCircle2 size={22} /> },
  profits:       { label: "Profit Distributions",  desc: "All profit payouts by project and member",     color: "#d97706", bg: "#fffbeb", icon: <TrendingUp size={22} /> },
};

function ReportsPage() {
  const [sub, setSub] = useState<ReportSub | null>(null);
  if (sub) return <ReportViewPage type={sub} onBack={() => setSub(null)} />;

  return (
    <div className="h-full overflow-auto pb-20 md:pb-0" style={{ background: "var(--background)" }}>
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-5">
        <div>
          <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>Reports</h1>
          <p className="text-sm text-gray-400">View and download system reports</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {(Object.keys(REPORT_META) as ReportSub[]).map((id) => {
            const r = REPORT_META[id];
            return (
              <div key={id} className="bg-white rounded-2xl border p-5 flex items-start gap-4 hover:shadow-md transition-shadow"
                style={{ borderColor: "var(--border)" }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: r.bg, color: r.color }}>{r.icon}</div>
                <div className="flex-1">
                  <p className="font-bold text-sm" style={{ color: "#1a202c" }}>{r.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5 mb-3">{r.desc}</p>
                  <button onClick={() => setSub(id)}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90 transition-opacity"
                    style={{ background: r.color }}>
                    View Report <ChevronRight size={13} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function ReportViewPage({ type, onBack }: { type: ReportSub; onBack: () => void }) {
  const meta = REPORT_META[type];

  // ── shared filter state ──────────────────────────────────────────────────
  const [yearF,    setYearF]    = useState<number | "all">(CY);
  const [monthF,   setMonthF]   = useState<number | "all">("all");
  const [modeF,    setModeF]    = useState("");
  const [purposeF, setPurposeF] = useState("");
  const [statusF,  setStatusF]  = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [search,   setSearch]   = useState("");

  // ── contributions-specific filter state ─────────────────────────────────
  const [contribStatusF, setContribStatusF] = useState<"all" | "unpaid">("all");

  // ── profits-specific filter state ────────────────────────────────────────
  const [projectF,  setProjectF]  = useState("");
  const [projects,  setProjects]  = useState<{ id: number; project_name: string }[]>([]);

  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [company, setCompany] = useState<CompanyDetails | null>(null);

  useEffect(() => { getCompanyDetails().then(setCompany); }, []);

  // ── load project list for profits filter ─────────────────────────────────
  useEffect(() => {
    if (type !== "profits") return;
    supabase.from("projects").select("id,project_name").order("project_name").then(({ data }) => {
      setProjects(data ?? []);
    });
  }, [type]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (type === "profits") {
        let q = supabase
          .from("profit_distributions")
          .select("*, project:projects(id,project_name), shareholder:shareholders(id,name,member_number), investor:investors(id,name,member_number)")
          .order("distributed_at", { ascending: false });
        if (projectF) q = q.eq("project_id", Number(projectF));
        if (dateFrom) q = q.gte("distributed_at", dateFrom);
        if (dateTo)   q = q.lte("distributed_at", dateTo + "T23:59:59");
        const { data, error } = await q;
        if (error) throw new Error(error.message);
        setRows(data ?? []);

      } else if (type === "contributions") {
        if (contribStatusF === "unpaid") {
          // Fetch all active shareholders + contributions for the period, then find unpaid
          const [allSH, summaries] = await Promise.all([
            shareholdersApi.list({ status: "Active" }),
            contributionsApi.summaryByShareholder({
              year:  yearF === "all" ? undefined : yearF,
              month: monthF === "all" ? undefined : monthF,
            }),
          ]);
          // Build a set of shareholder IDs that have at least one contribution with amount >= 1
          const paidIds = new Set<number>();
          summaries.forEach((s) => {
            const hasValid = s.contributions.some((c) => Number(c.amount) >= 1);
            if (hasValid) paidIds.add(s.shareholder.id);
          });
          // Shareholders not in paidIds are "unpaid"
          const unpaidRows = allSH
            .filter((sh: any) => !paidIds.has(sh.id))
            .map((sh: any) => ({
              id: `unpaid-${sh.id}`,
              shareholder: sh,
              month: monthF === "all" ? null : monthF,
              year: yearF === "all" ? null : yearF,
              payment_date: null,
              amount: 0,
              status: "unpaid",
              notes: "",
            }));
          setRows(unpaidRows);
        } else {
          const summaries = await contributionsApi.summaryByShareholder({
            year:  yearF === "all" ? undefined : yearF,
            month: monthF === "all" ? undefined : monthF,
          });
          const flat = summaries.flatMap((s) => s.contributions.map((c) => ({ ...c, shareholder: s.shareholder })));
          setRows(flat);
        }

      } else if (type === "payments") {
        const data = await paymentsApi.list({
          year:    yearF === "all" ? undefined : yearF,
          mode:    modeF    || undefined,
          purpose: purposeF || undefined,
          dateFrom: dateFrom || undefined,
          dateTo:   dateTo   || undefined,
        });
        setRows(data);

      } else if (type === "refunds") {
        const { data } = await supabase
          .from("refunds")
          .select("*, shareholder:shareholders(*)")
          .order("refund_date", { ascending: false });
        let d = data ?? [];
        if (dateFrom) d = d.filter((r: any) => r.refund_date >= dateFrom);
        if (dateTo)   d = d.filter((r: any) => r.refund_date <= dateTo);
        setRows(d);

      } else if (type === "shareholders") {
        const data = await shareholdersApi.list({ status: statusF || undefined, search: search || undefined });
        setRows(data);

      } else if (type === "clients") {
        const data = await clientsApi.list({ status: statusF || undefined, search: search || undefined });
        setRows(data);

      } else if (type === "summary") {
        const [sh, cl, contribRes, payRes] = await Promise.all([
          shareholdersApi.list(),
          clientsApi.list(),
          contributionsApi.summaryByShareholder({ year: yearF === "all" ? undefined : yearF }),
          paymentsApi.list({ year: yearF === "all" ? undefined : yearF }),
        ]);
        setRows([{ sh, cl, contribRes, payRes }]);
      }
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [type, yearF, monthF, modeF, purposeF, statusF, dateFrom, dateTo, search, projectF, contribStatusF]);

  useEffect(() => { load(); }, [load]);

  // ── search filter applied in-memory for member lists ────────────────────
  const filtered = (type === "contributions" || type === "payments" || type === "refunds" || type === "profits")
    ? rows.filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        if (type === "contributions") return r.shareholder?.name.toLowerCase().includes(q) || `EW#${r.shareholder?.member_number}`.includes(q);
        if (type === "payments") return r.paid_by?.toLowerCase().includes(q) || (r.payment_id ?? "").toLowerCase().includes(q) || r.purpose?.toLowerCase().includes(q);
        if (type === "refunds") return r.shareholder?.name?.toLowerCase().includes(q) || `EW#${r.shareholder?.member_number}`.includes(q);
        if (type === "profits") {
          const memberName = r.shareholder?.name ?? r.investor?.name ?? "";
          const memberNo = r.shareholder?.member_number ?? r.investor?.member_number ?? "";
          return memberName.toLowerCase().includes(q) || `EW#${memberNo}`.includes(q) || (r.project?.project_name ?? "").toLowerCase().includes(q);
        }
        return true;
      })
    : rows;

  // ── PDF download ─────────────────────────────────────────────────────────
  const handlePdf = async () => {
    setDownloading(true);
    try {
      const co = await getCompanyDetails();
      const filterStr = [
        yearF !== "all" && `Year: ${yearF}`,
        monthF !== "all" && `Month: ${MONTHS[(monthF as number) - 1]}`,
        modeF    && `Mode: ${modeF}`,
        purposeF && `Purpose: ${purposeF}`,
        statusF  && `Status: ${statusF}`,
        dateFrom && `From: ${dateFrom}`,
        dateTo   && `To: ${dateTo}`,
        projectF && `Project: ${projects.find((p) => String(p.id) === projectF)?.project_name ?? projectF}`,
      ].filter(Boolean).join(" · ") || "All records";

      if (type === "contributions") {
        downloadContributionsPdf(filtered.map((c: any) => ({
          member: c.shareholder?.name ?? "—",
          memberNo: `EW#${c.shareholder?.member_number ?? "—"}`,
          month: MONTHS[c.month - 1],
          year: c.year,
          date_paid: c.payment_date ? fmtDate(c.payment_date) : "—",
          amount: Number(c.amount),
          status: c.status,
          notes: c.notes ?? "—",
        })), co, filterStr);

      } else if (type === "payments") {
        downloadPaymentsPdf(filtered.map((p: any) => ({
          payment_id: p.payment_id ?? "—",
          date_paid: fmtDate(p.date_paid),
          amount: Number(p.amount),
          paid_by: p.paid_by,
          purpose: p.purpose,
          mode: p.mode,
          comment: p.comment ?? "—",
        })), co, filterStr);

      } else if (type === "refunds") {
        downloadRefundsPdf(filtered.map((r: any) => ({
          member: r.shareholder?.name ?? "Unknown",
          member_no: `EW#${r.shareholder?.member_number ?? "—"}`,
          amount: Number(r.amount),
          refund_date: fmtDate(r.refund_date),
          notes: r.notes ?? "—",
        })), co);

      } else if (type === "shareholders") {
        downloadMembersPdf(rows.map((s: any) => ({
          member_no: `EW#${s.member_number}`, name: s.name, phone: s.phone,
          email: s.email, joined: fmtDate(s.joined_date), status: s.status,
          net_savings: fmtKESFull(Number(s.net_savings)),
        })), "Shareholders Report", co, filterStr);

      } else if (type === "clients") {
        downloadMembersPdf(rows.map((c: any) => ({
          member_no: String(c.member_number), name: c.name, phone: c.phone,
          email: c.email, joined: fmtDate(c.joined_date), status: c.status,
        })), "Clients Report", co, filterStr);

      } else if (type === "profits") {
        const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);
        downloadReportPdf([{
          title: "Profit Distributions",
          headers: ["Member", "No.", "Type", "Project", "Date", "Amount (KES)", "Notes"],
          rows: filtered.map((r: any) => {
            const isInvestor = !!r.investor_id;
            const name = isInvestor ? (r.investor?.name ?? "—") : (r.shareholder?.name ?? "—");
            const no = `EW#${isInvestor ? (r.investor?.member_number ?? "—") : (r.shareholder?.member_number ?? "—")}`;
            return [name, no, isInvestor ? "Investor" : "Shareholder", r.project?.project_name ?? "—", fmtDate(r.distributed_at?.slice(0, 10)), Number(r.amount).toLocaleString("en-KE"), r.notes ?? "—"];
          }),
          total,
        }], "Profit Distributions Report", co, filterStr);

      } else if (type === "summary" && rows[0]) {
        const { sh, cl, contribRes, payRes } = rows[0];
        const totalContrib = contribRes.reduce((s: number, r: any) => s + r.total, 0);
        const totalPay = payRes.reduce((s: number, p: any) => s + Number(p.amount), 0);
        downloadReportPdf([
          {
            title: "Membership",
            headers: ["Category", "Total", "Active", "Inactive"],
            rows: [
              ["Shareholders", String(sh.length), String(sh.filter((s: any) => s.status === "Active").length), String(sh.filter((s: any) => s.status !== "Active").length)],
              ["Clients", String(cl.length), String(cl.filter((c: any) => c.status === "Active").length), String(cl.filter((c: any) => c.status !== "Active").length)],
            ],
          },
          {
            title: `Contributions ${yearF !== "all" ? yearF : "All Years"}`,
            headers: ["Member", "Member No.", "Total (KES)", "Payments"],
            rows: contribRes.map((s: any) => [s.shareholder.name, `EW#${s.shareholder.member_number}`, Number(s.total).toLocaleString("en-KE"), String(s.count)]),
            total: totalContrib,
          },
          {
            title: `Payments ${yearF !== "all" ? yearF : "All Years"}`,
            headers: ["Paid By", "Purpose", "Mode", "Amount (KES)"],
            rows: payRes.map((p: any) => [p.paid_by, p.purpose, p.mode, Number(p.amount).toLocaleString("en-KE")]),
            total: totalPay,
          },
        ], `Annual Summary Report${yearF !== "all" ? ` ${yearF}` : ""}`, co, filterStr);
      }
    } finally { setDownloading(false); }
  };

  // ── filter bar ───────────────────────────────────────────────────────────
  const filterBar = (
    <div className="px-5 py-3 border-b flex flex-wrap gap-2 items-center bg-white flex-shrink-0" style={{ borderColor: "var(--border)" }}>
      <Filter size={13} className="text-gray-400 flex-shrink-0" />
      {/* Search */}
      {["contributions", "payments", "refunds", "profits"].includes(type) && (
        <div className="relative flex-1 min-w-[160px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={type === "profits" ? "Search member or project…" : "Search…"}
            className="w-full pl-7 pr-2 py-1.5 border rounded-lg text-xs focus:outline-none"
            style={{ borderColor: "var(--border)" }} />
        </div>
      )}
      {["shareholders", "clients"].includes(type) && (
        <div className="relative flex-1 min-w-[160px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name or phone…"
            className="w-full pl-7 pr-2 py-1.5 border rounded-lg text-xs focus:outline-none"
            style={{ borderColor: "var(--border)" }} />
        </div>
      )}
      {/* Year */}
      {["contributions", "payments", "summary"].includes(type) && (
        <select value={String(yearF)} onChange={(e) => setYearF(e.target.value === "all" ? "all" : parseInt(e.target.value))}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="all">All Years</option>
          {YEAR_OPTS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
      )}
      {/* Month */}
      {type === "contributions" && (
        <select value={String(monthF)} onChange={(e) => setMonthF(e.target.value === "all" ? "all" : parseInt(e.target.value))}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="all">All Months</option>
          {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
      )}
      {/* Contribution payment status */}
      {type === "contributions" && (
        <select value={contribStatusF} onChange={(e) => setContribStatusF(e.target.value as "all" | "unpaid")}
          className="border rounded-lg px-2 py-1.5 text-xs font-semibold focus:outline-none bg-white"
          style={{ borderColor: contribStatusF === "unpaid" ? "#ef4444" : "var(--border)", color: contribStatusF === "unpaid" ? "#ef4444" : undefined }}>
          <option value="all">All Payments</option>
          <option value="unpaid">Unpaid</option>
        </select>
      )}
      {/* Mode + Purpose */}
      {type === "payments" && (
        <>
          <select value={modeF} onChange={(e) => setModeF(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
            <option value="">All Modes</option>
            {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <select value={purposeF} onChange={(e) => setPurposeF(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
            <option value="">All Purposes</option>
            {PAYMENT_PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </>
      )}
      {/* Status */}
      {["shareholders", "clients"].includes(type) && (
        <select value={statusF} onChange={(e) => setStatusF(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="">All Status</option>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
        </select>
      )}
      {/* Date range */}
      {["payments", "refunds", "profits"].includes(type) && (
        <>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }} />
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }} />
        </>
      )}
      {/* Project filter (profits only) */}
      {type === "profits" && (
        <select value={projectF} onChange={(e) => setProjectF(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="">All Projects</option>
          {projects.map((p) => <option key={p.id} value={String(p.id)}>{p.project_name}</option>)}
        </select>
      )}
    </div>
  );

  // ── per-type table ────────────────────────────────────────────────────────
  const renderTable = () => {
    if (loading) return <div className="flex items-center justify-center py-16"><Loader2 size={22} className="animate-spin text-gray-300" /></div>;

    if (type === "contributions") {
      const isUnpaidView = contribStatusF === "unpaid";
      const total = filtered.reduce((s: number, c: any) => s + Number(c.amount), 0);
      return (
        <>
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-sm min-w-[700px]">
              <thead style={{ background: "#1e3a5f" }}>
                <tr>{["Member", "No.", "Month", "Year", "Date Paid", "Amount (KES)", "Status", "Notes"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filtered.map((c: any, i: number) => (
                  <tr key={c.id} className="border-t hover:bg-gray-50"
                    style={{ borderColor: "var(--border)", background: c.status === "unpaid" ? "#fff5f5" : i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                    <td className="px-3 py-1.5 font-semibold text-xs">{c.shareholder?.name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-xs font-bold" style={{ color: "#6366f1" }}>EW#{c.shareholder?.member_number}</td>
                    <td className="px-3 py-1.5 text-xs">{c.month ? MONTHS[c.month - 1] : "—"}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{c.year ?? "—"}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{c.payment_date ? fmtDate(c.payment_date) : "—"}</td>
                    <td className="px-3 py-1.5 font-bold text-xs" style={{ color: c.status === "unpaid" ? "#ef4444" : "#22c55e" }}>
                      {c.status === "unpaid" ? "—" : fmtKESFull(Number(c.amount))}
                    </td>
                    <td className="px-3 py-1.5">
                      {c.status === "unpaid" ? (
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-500">Unpaid</span>
                      ) : (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.status === "late" ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"}`}>
                          {c.status === "late" ? "Late" : "On time"}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-xs text-gray-400 max-w-[140px] truncate">{c.notes || "—"}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: isUnpaidView ? "#fef2f2" : "#f0fdf4" }}>
                  <td colSpan={5} className="px-3 py-1.5 text-xs font-bold uppercase" style={{ color: isUnpaidView ? "#b91c1c" : "#15803d" }}>
                    {isUnpaidView ? `${filtered.length} unpaid member${filtered.length !== 1 ? "s" : ""}` : "Total"}
                  </td>
                  <td className="px-3 py-1.5 font-bold" style={{ color: isUnpaidView ? "#b91c1c" : "#14532d" }}>
                    {isUnpaidView ? "KES 0" : fmtKESFull(total)}
                  </td>
                  <td colSpan={2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      );
    }

    if (type === "payments") {
      const total = filtered.reduce((s: number, p: any) => s + Number(p.amount), 0);
      const MODE_COLORS: Record<string, string> = { mpesa: "#22c55e", cash: "#16a34a", bank: "#2563eb", cheque: "#7c3aed" };
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm min-w-[700px]">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["Payment ID", "Date Paid", "Amount (KES)", "Paid By", "Purpose", "Mode", "Comment"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.map((p: any, i: number) => (
                <tr key={p.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5 font-mono text-xs font-bold" style={{ color: "#0d9488" }}>{p.payment_id || "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{fmtDate(p.date_paid)}</td>
                  <td className="px-3 py-1.5 font-bold text-xs" style={{ color: "#14b8a6" }}>{fmtKESFull(Number(p.amount))}</td>
                  <td className="px-3 py-1.5 text-xs font-semibold">{p.paid_by}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-600">{p.purpose}</td>
                  <td className="px-3 py-1.5">
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                      style={{ background: MODE_COLORS[p.mode?.toLowerCase()] ?? "#64748b" }}>{p.mode}</span>
                  </td>
                  <td className="px-3 py-1.5 text-xs text-gray-400 max-w-[140px] truncate">{p.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#f0fdfa" }}>
                <td colSpan={2} className="px-3 py-1.5 text-xs font-bold text-teal-700 uppercase">Total</td>
                <td className="px-3 py-1.5 font-bold text-teal-800">{fmtKESFull(total)}</td>
                <td colSpan={4} />
              </tr>
            </tfoot>
          </table>
        </div>
      );
    }

    if (type === "refunds") {
      const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["Member", "Member No.", "Amount (KES)", "Refund Date", "Notes"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.map((r: any, i: number) => (
                <tr key={r.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5 font-semibold text-xs">{r.shareholder?.name ?? "Unknown"}</td>
                  <td className="px-3 py-1.5 text-xs font-bold text-red-500">EW#{r.shareholder?.member_number ?? "—"}</td>
                  <td className="px-3 py-1.5 font-bold text-xs text-red-600">{fmtKESFull(Number(r.amount))}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{fmtDate(r.refund_date)}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-400">{r.notes || "—"}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: "#fef2f2" }}>
                <td colSpan={2} className="px-3 py-1.5 text-xs font-bold text-red-700 uppercase">Total Refunded</td>
                <td className="px-3 py-1.5 font-bold text-red-800">{fmtKESFull(total)}</td>
                <td colSpan={2} />
              </tr>
            </tfoot>
          </table>
        </div>
      );
    }

    if (type === "shareholders") {
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["No.", "Name", "Phone", "Email", "Joined", "Status", "Net Savings"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((s: any, i: number) => (
                <tr key={s.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5 font-bold text-xs" style={{ color: "#6366f1" }}>EW#{s.member_number}</td>
                  <td className="px-3 py-1.5 font-semibold text-xs">{s.name}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{s.phone}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-400">{s.email || "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{fmtDate(s.joined_date)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${s.status === "Active" ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"}`}>
                      {s.status}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 font-bold text-xs" style={{ color: "#22c55e" }}>{fmtKESFull(Number(s.net_savings))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (type === "clients") {
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["No.", "Name", "Phone", "Email", "Joined", "Status"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {rows.map((c: any, i: number) => (
                <tr key={c.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5 font-bold text-xs text-purple-600">{c.member_number}</td>
                  <td className="px-3 py-1.5 font-semibold text-xs">{c.name}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{c.phone}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-400">{c.email || "—"}</td>
                  <td className="px-3 py-1.5 text-xs text-gray-500">{fmtDate(c.joined_date)}</td>
                  <td className="px-3 py-1.5">
                    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.status === "Active" ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"}`}>
                      {c.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }

    if (type === "profits") {
      const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm min-w-[700px]">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["Member", "No.", "Type", "Project", "Date", "Amount (KES)", "Notes"].map((h) => (
                <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.map((r: any, i: number) => {
                const isInvestor = !!r.investor_id;
                const name = isInvestor ? (r.investor?.name ?? "—") : (r.shareholder?.name ?? "—");
                const memberNo = isInvestor ? (r.investor?.member_number ?? "—") : (r.shareholder?.member_number ?? "—");
                return (
                  <tr key={r.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#fef9ec" }}>
                    <td className="px-3 py-1.5 font-semibold text-xs">{name}</td>
                    <td className="px-3 py-1.5 text-xs font-bold" style={{ color: "#d97706" }}>EW#{memberNo}</td>
                    <td className="px-3 py-1.5">
                      {isInvestor
                        ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-600">Investor</span>
                        : <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-indigo-50 text-indigo-600">Shareholder</span>}
                    </td>
                    <td className="px-3 py-1.5 text-xs font-semibold text-gray-700">{r.project?.project_name ?? "—"}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{fmtDate(r.distributed_at?.slice(0, 10))}</td>
                    <td className="px-3 py-1.5 font-bold text-xs text-amber-600">{fmtKESFull(Number(r.amount))}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-400 max-w-[140px] truncate">{r.notes || "—"}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: "#fffbeb" }}>
                <td colSpan={5} className="px-3 py-1.5 text-xs font-bold text-amber-700 uppercase">Total Distributed</td>
                <td className="px-3 py-1.5 font-bold text-amber-800">{fmtKESFull(total)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
          {filtered.length === 0 && !loading && (
            <div className="py-12 text-center text-sm text-gray-400">No profit distributions found for the selected filters.</div>
          )}
        </div>
      );
    }

    if (type === "summary" && rows[0]) {
      const { sh, cl, contribRes, payRes } = rows[0];
      const totalContrib = contribRes.reduce((s: number, r: any) => s + r.total, 0);
      const totalPay = payRes.reduce((s: number, p: any) => s + Number(p.amount), 0);
      return (
        <div className="p-5 space-y-6 flex-1 overflow-auto">
          {/* Membership */}
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--border)" }}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Membership</h3>
            <div className="grid grid-cols-3 gap-3">
              {[
                { label: "Total Shareholders", value: sh.length, sub: `${sh.filter((s: any) => s.status === "Active").length} active` },
                { label: "Total Clients",       value: cl.length, sub: `${cl.filter((c: any) => c.status === "Active").length} active` },
                { label: "Total Members",        value: sh.length + cl.length, sub: "shareholders + clients" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl px-4 py-3 text-center" style={{ background: "#f8fafc" }}>
                  <div className="text-2xl font-bold" style={{ color: "#1a202c" }}>{stat.value}</div>
                  <div className="text-xs font-semibold text-gray-500 mt-0.5">{stat.label}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">{stat.sub}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Financials */}
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--border)" }}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">
              Financials {yearF !== "all" ? `— ${yearF}` : "— All Time"}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Total Contributions", value: fmtKESFull(totalContrib), color: "#22c55e" },
                { label: "Total Payments",       value: fmtKESFull(totalPay),    color: "#14b8a6" },
              ].map((stat) => (
                <div key={stat.label} className="rounded-xl px-4 py-3 text-center" style={{ background: "#f8fafc" }}>
                  <div className="text-xl font-bold" style={{ color: stat.color }}>{stat.value}</div>
                  <div className="text-xs font-semibold text-gray-500 mt-0.5">{stat.label}</div>
                </div>
              ))}
            </div>
          </div>
          {/* Top contributors */}
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--border)" }}>
            <h3 className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-3">Top 10 Contributors</h3>
            <table className="w-full text-sm">
              <thead><tr style={{ background: "#1e3a5f" }}>
                {["Member", "No.", "Total (KES)", "Payments"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {[...contribRes].sort((a: any, b: any) => b.total - a.total).slice(0, 10).map((s: any, i: number) => (
                  <tr key={s.shareholder.id} className="border-t" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                    <td className="px-3 py-1.5 text-xs font-semibold">{s.shareholder.name}</td>
                    <td className="px-3 py-1.5 text-xs font-bold" style={{ color: "#6366f1" }}>EW#{s.shareholder.member_number}</td>
                    <td className="px-3 py-1.5 text-xs font-bold" style={{ color: "#22c55e" }}>{fmtKESFull(s.total)}</td>
                    <td className="px-3 py-1.5 text-xs text-gray-500">{s.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      );
    }

    return <div className="flex items-center justify-center py-16 text-sm text-gray-400">No data</div>;
  };

  const recordCount = type === "summary" ? null : filtered.length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b flex-shrink-0 flex items-center justify-between"
        style={{ background: meta.color, borderColor: "rgba(0,0,0,0.1)" }}>
        <div className="flex items-center gap-3">
          <button onClick={onBack}
            className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg hover:opacity-80"
            style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}>
            <ArrowLeft size={13} /> Reports
          </button>
          <div style={{ color: "rgba(255,255,255,0.4)" }}>›</div>
          <h1 className="font-bold text-base text-white">{meta.label}</h1>
        </div>
        {recordCount !== null && (
          <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.9)" }}>
            {recordCount} record{recordCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* Filters */}
      {filterBar}

      {/* Company header — shown in report body */}
      {company && (
        <div className="px-5 py-4 border-b bg-white flex-shrink-0 flex items-center gap-4"
          style={{ borderColor: "var(--border)" }}>
          {company.logo_data_url ? (
            <img src={company.logo_data_url} alt="Logo" className="w-12 h-12 object-contain rounded-xl flex-shrink-0" />
          ) : (
            <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
              style={{ background: "#1e2d4a" }}>
              <span className="text-white font-bold text-lg">{company.name.charAt(0)}</span>
            </div>
          )}
          <div className="flex-1 min-w-0">
            <p className="font-bold text-base leading-tight" style={{ color: "#1a202c" }}>{company.name}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 mt-0.5">
              {company.phone    && <span className="text-xs text-gray-400">{company.phone}</span>}
              {company.email    && <span className="text-xs text-gray-400">{company.email}</span>}
              {company.website  && <span className="text-xs text-gray-400">{company.website}</span>}
              {company.location && <span className="text-xs text-gray-400">{company.location}</span>}
            </div>
          </div>
          <div className="text-right flex-shrink-0">
            <p className="text-xs font-bold uppercase tracking-wider" style={{ color: meta.color }}>{meta.label}</p>
            <p className="text-[10px] text-gray-400 mt-0.5">Generated {new Date().toLocaleDateString("en-KE", { dateStyle: "long" })}</p>
          </div>
        </div>
      )}

      {/* Table area */}
      <div className="flex-1 overflow-auto pb-20 md:pb-0">
        {renderTable()}
      </div>

      {/* Download PDF footer */}
      <div className="px-5 py-4 border-t bg-white flex-shrink-0 flex items-center justify-between"
        style={{ borderColor: "var(--border)" }}>
        <p className="text-xs text-gray-400">
          {recordCount !== null ? `${recordCount} record${recordCount !== 1 ? "s" : ""} shown` : "Summary report"}
        </p>
        <button onClick={handlePdf} disabled={downloading}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
          style={{ background: meta.color }}>
          {downloading ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />}
          {downloading ? "Generating PDF…" : "Download PDF"}
        </button>
      </div>
    </div>
  );
}
export { ReportsPage };
