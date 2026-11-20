import { useState, useEffect, useCallback } from "react";
import {
  BarChart2, Link2, CreditCard, RotateCcw, Users, UserCircle2,
  Filter, Search, ChevronRight, ArrowLeft, FileDown, FileSpreadsheet, Loader2, TrendingUp, AlertTriangle, ListOrdered,
} from "lucide-react";
import {
  contributionsApi, paymentsApi, shareholdersApi, clientsApi, refundsApi, logActivity,
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
import { computePlotArrears, todayEAT } from "@/lib/arrears";
import { sendSms, smsTemplates, SMS_TRIGGERS } from "@/lib/sms";
import { downloadExcel, downloadExcelWorkbook } from "@/lib/excel";

type ReportSub = "contributions" | "contributionsList" | "payments" | "refunds" | "shareholders" | "clients" | "summary" | "profits" | "debtors";

const REPORT_META: Record<ReportSub, { label: string; desc: string; color: string; bg: string; icon: React.ReactNode }> = {
  debtors:       { label: "Arrears",               desc: "Plot arrears: monthly repayments missed by the deadline", color: "#dc2626", bg: "#fef2f2", icon: <AlertTriangle size={22} /> },
  summary:       { label: "Annual Summary",       desc: "Membership, contributions & payments overview", color: "#1e2d4a", bg: "#eef2ff", icon: <BarChart2 size={22} /> },
  contributions: { label: "Contributions Report", desc: "All monthly contributions with status",         color: "#6366f1", bg: "#eef2ff", icon: <Link2 size={22} /> },
  contributionsList: { label: "Contributions List", desc: "Total contributed per member for a date range",   color: "#4f46e5", bg: "#eef2ff", icon: <ListOrdered size={22} /> },
  payments:      { label: "Payments Report",       desc: "All payments with mode and purpose",           color: "#14b8a6", bg: "#f0fdfa", icon: <CreditCard size={22} /> },
  refunds:       { label: "Refunds Report",        desc: "All processed refunds",                        color: "#ef4444", bg: "#fef2f2", icon: <RotateCcw size={22} /> },
  shareholders:  { label: "Shareholders List",     desc: "All shareholders with savings",                color: "#6366f1", bg: "#eef2ff", icon: <Users size={22} /> },
  clients:       { label: "Clients List",          desc: "All registered clients",                       color: "#a855f7", bg: "#faf5ff", icon: <UserCircle2 size={22} /> },
  profits:       { label: "Profit Distributions",  desc: "All profit payouts by project and member",     color: "#d97706", bg: "#fffbeb", icon: <TrendingUp size={22} /> },
};

/**
 * Paid-status label for an arrears-report row:
 *   Paid · Deadline Today (due today, not yet paid) · Upcoming · In Arrears · N days
 */
function arrearStatusInfo(row: { status: string; dueDate: string }): { label: string; sub: string; badge: string; subColor: string } {
  const today = todayEAT();
  const due = `Due ${fmtDate(row.dueDate)}`;
  if (row.status === "paid") return { label: "Paid", sub: "", badge: "bg-emerald-50 text-emerald-700", subColor: "" };
  if (row.status === "upcoming" && row.dueDate === today)
    return { label: "Deadline Today", sub: due, badge: "bg-red-600 text-white", subColor: "text-red-600" };
  if (row.status === "upcoming") return { label: "Upcoming", sub: due, badge: "bg-green-600 text-white", subColor: "text-green-700" };
  const days = Math.max(1, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.dueDate}T00:00:00Z`)) / 86_400_000));
  return { label: `In Arrears · ${days} day${days === 1 ? "" : "s"}`, sub: due, badge: "bg-rose-50 text-rose-700", subColor: "text-rose-500" };
}
const arrearStatusText = (row: { status: string; dueDate: string }) => arrearStatusInfo(row).label.replace(" · ", " (") + (row.status === "unpaid" ? ")" : "");

/** Arrear row the Debtors report hands to the payment modal. */
export interface ArrearPayRequest {
  plot: { id: number; plot_number: string; price: number; paid_amount: number; projectName: string };
  member: { id: number; name: string; phone?: string; type: "shareholder" | "client" };
  amount: number;
  monthLabel: string;
}

/** Payment modal supplied by App.tsx (kept there to reuse its M-Pesa flow without a circular import). */
export type ArrearPayComponent = React.ComponentType<{ request: ArrearPayRequest; onClose: () => void; onPaid: () => void }>;

function ReportsPage({ ArrearPay }: { ArrearPay?: ArrearPayComponent } = {}) {
  // ?report=<type> opens a report directly (e.g. the dashboard's Monthly Arrears card).
  const [sub, setSub] = useState<ReportSub | null>(() => {
    const requested = new URLSearchParams(window.location.search).get("report");
    return requested && requested in REPORT_META ? (requested as ReportSub) : null;
  });
  const closeReport = () => {
    setSub(null);
    if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
  };
  if (sub) return <ReportViewPage type={sub} onBack={closeReport} ArrearPay={ArrearPay} />;

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

function ReportViewPage({ type, onBack, ArrearPay }: { type: ReportSub; onBack: () => void; ArrearPay?: ArrearPayComponent }) {
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
  const [contribStatusF, setContribStatusF] = useState<"all" | "paid" | "unpaid">("all");

  // ── contributions-list filter state (Active by default) ─────────────────
  const [listStatusF, setListStatusF] = useState<"Active" | "Inactive" | "">("Active");

  // ── profits-specific filter state ────────────────────────────────────────
  const [projectF,  setProjectF]  = useState("");
  const [projects,  setProjects]  = useState<{ id: number; project_name: string }[]>([]);
  const [shareholderF, setShareholderF] = useState("");
  const [memberTypeF, setMemberTypeF] = useState<"" | "shareholder" | "client">("");
  const [shareholders, setShareholders] = useState<{ id: number; name: string; member_number: string | number; phone?: string }[]>([]);
  const [debtorClients, setDebtorClients] = useState<{ id: number; name: string; member_number: string | number; phone?: string }[]>([]);
  const [plotF, setPlotF] = useState("");
  const [plotOptions, setPlotOptions] = useState<{ id: number; project_id: number; plot_number: string }[]>([]);
  // ── debtors (arrears) filter state — unpaid by default ──────────────────
  const [arrearStatusF, setArrearStatusF] = useState<"unpaid" | "paid" | "">("unpaid");
  // Picking a To date of today or later also lists repayments due up to that date
  // which are not yet paid (members who have not defaulted yet), marked "Upcoming".
  const includeUpcoming = type === "debtors" && !!dateTo && dateTo >= todayEAT();
  const [payRequest, setPayRequest] = useState<ArrearPayRequest | null>(null);
  const [notifyState, setNotifyState] = useState<Record<string, { status: "sending" | "sent" | "error"; message?: string }>>({});

  // Send the arrears-notice SMS for one unpaid arrear.
  const notifyArrear = async (row: any) => {
    const phone = row.shareholder?.phone;
    if (!phone) { setNotifyState((s) => ({ ...s, [row.key]: { status: "error", message: "No phone number" } })); return; }
    setNotifyState((s) => ({ ...s, [row.key]: { status: "sending" } }));
    try {
      const upcoming = row.status === "upcoming";
      const message = upcoming
        ? smsTemplates.upcomingNotice(row.shareholder?.name ?? "Member", fmtKESFull(Number(row.remaining)), fmtDate(row.dueDate), String(row.plotNumber ?? ""))
        : smsTemplates.arrearsNotice(
            row.shareholder?.name ?? "Member",
            fmtKESFull(Number(row.amount)),
            fmtDate(row.dueDate),
            fmtKESFull(Number(row.remaining)),
            String(row.plotNumber ?? ""),
          );
      await sendSms(phone, message, upcoming ? SMS_TRIGGERS.upcomingNotice : SMS_TRIGGERS.arrearsNotice);
      logActivity({ category: "plot", action: "notify", description: `${upcoming ? "Upcoming repayment" : "Arrears"} notice (${row.monthLabel}, plot ${row.plotNumber}) sent to ${row.shareholder?.name ?? "member"}`, meta: { plot_id: row.plotId, period: row.period, amount: row.remaining } });
      setNotifyState((s) => ({ ...s, [row.key]: { status: "sent" } }));
    } catch (e: any) {
      setNotifyState((s) => ({ ...s, [row.key]: { status: "error", message: e?.message ?? "SMS failed" } }));
    }
  };

  const [rows, setRows]       = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [company, setCompany] = useState<CompanyDetails | null>(null);

  useEffect(() => { getCompanyDetails().then(setCompany); }, []);

  // ── load filter directories ───────────────────────────────────────────────
  useEffect(() => {
    if (!["profits", "debtors"].includes(type)) return;
    const requests: PromiseLike<any>[] = [
      supabase.from("projects").select("id,project_name").order("project_name").then(({ data }) => setProjects(data ?? [])),
    ];
    if (type === "debtors") {
      requests.push(
        supabase.from("shareholders").select("id,name,member_number,phone").order("name").then(({ data }) => setShareholders((data ?? []) as any)),
        supabase.from("clients").select("id,name,member_number,phone").order("name").then(({ data }) => setDebtorClients((data ?? []) as any)),
        supabase.from("plots").select("id,project_id,plot_number").not("assigned_to_id", "is", null).order("plot_number").then(({ data }) => setPlotOptions((data ?? []) as any)),
      );
    }
    Promise.all(requests).catch(() => {});
  }, [type]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (type === "debtors") {
        // One row per arrear: a monthly repayment not paid on or before its deadline.
        let plotsQuery = supabase
          .from("plots")
          .select("id,plot_number,project_id,assigned_to_id,assigned_to_type,price,paid_amount,min_monthly_payment,loan_duration_months,deadline,status")
          .not("assigned_to_id", "is", null)
          .in("status", ["assigned", "sold"]);
        if (shareholderF) {
          const [memberType, memberId] = shareholderF.split(":");
          plotsQuery = plotsQuery.eq("assigned_to_type", memberType).eq("assigned_to_id", Number(memberId));
        } else if (memberTypeF) {
          plotsQuery = plotsQuery.eq("assigned_to_type", memberTypeF);
        }
        if (projectF) plotsQuery = plotsQuery.eq("project_id", Number(projectF));
        if (plotF) plotsQuery = plotsQuery.eq("id", Number(plotF));
        const { data: debtPlots, error: plotError } = await plotsQuery;
        if (plotError) throw new Error(plotError.message);

        // Plot payments, paged (Supabase returns at most 1000 rows per request).
        const plotIds = (debtPlots ?? []).map((plot: any) => Number(plot.id));
        const paymentRows: any[] = [];
        if (plotIds.length) {
          const PAGE = 1000;
          for (let from = 0; ; from += PAGE) {
            const { data, error } = await supabase.from("plot_payments")
              .select("id,plot_id,amount,payment_date,created_at").in("plot_id", plotIds)
              .order("id").range(from, from + PAGE - 1);
            if (error) throw new Error(error.message);
            paymentRows.push(...(data ?? []));
            if (!data || data.length < PAGE) break;
          }
        }

        const shareholderMap = Object.fromEntries(shareholders.map((m) => [m.id, m]));
        const clientMap = Object.fromEntries(debtorClients.map((m) => [m.id, m]));
        // Upcoming window: from today up to a To date that is today or later.
        const today = todayEAT();
        const upcomingUntil = includeUpcoming ? dateTo : undefined;
        const projectMap = Object.fromEntries(projects.map((pr) => [pr.id, pr]));
        const arrearRows = (debtPlots ?? []).flatMap((plot: any) => {
          const member = plot.assigned_to_type === "client"
            ? clientMap[Number(plot.assigned_to_id)] ?? null
            : shareholderMap[Number(plot.assigned_to_id)] ?? null;
          const project = projectMap[Number(plot.project_id)] ?? null;
          return computePlotArrears(plot, paymentRows, today, { includeUpcomingUntil: upcomingUntil }).map((a) => ({
            ...a,
            key: `${a.plotId}-${a.period}`,
            plot,
            shareholder: member,
            memberType: plot.assigned_to_type,
            project,
            payable: false,
          }));
        }).sort((a: any, b: any) => a.period.localeCompare(b.period)
          || String(a.shareholder?.name ?? "").localeCompare(String(b.shareholder?.name ?? ""))
          || String(a.plotNumber).localeCompare(String(b.plotNumber)));

        // Only the oldest unpaid month of each plot is payable (payments apply oldest-first).
        // Decided before filtering so a date filter can't make a newer month payable.
        const seenPlots = new Set<number>();
        for (const row of arrearRows) {
          if ((row.status !== "unpaid" && row.status !== "upcoming") || seenPlots.has(row.plotId)) continue;
          seenPlots.add(row.plotId);
          row.payable = true;
        }
        setRows(arrearRows
          // "Not paid" covers overdue arrears and (when included) upcoming repayments.
          .filter((row: any) => !arrearStatusF || row.status === arrearStatusF || (arrearStatusF === "unpaid" && row.status === "upcoming"))
          .filter((row: any) => (!dateFrom || row.dueDate >= dateFrom) && (!dateTo || row.dueDate <= dateTo)));

      } else if (type === "profits") {
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
        // Always work from active shareholders only
        const eatNow = new Date(new Date().getTime() + 3 * 60 * 60 * 1000);
        const checkYear  = yearF  === "all" ? eatNow.getUTCFullYear()     : Number(yearF);
        const checkMonth = monthF === "all" ? eatNow.getUTCMonth() + 1    : Number(monthF);

        // Fetch active shareholders + contributions for the period (specific month/year)
        const [activeSH, contribRes] = await Promise.all([
          shareholdersApi.list({ status: "Active" }),
          supabase
            .from("contributions")
            .select("*")
            .eq("year", checkYear)
            .eq("month", checkMonth)
            .gte("amount", 1),
        ]);

        const activeIds = new Set<number>(activeSH.map((sh: any) => sh.id));
        // Map shareholder id → consolidated single row (sum multiple payments per member)
        const contribByShId = new Map<number, any>();
        for (const c of (contribRes.data ?? [])) {
          if (!activeIds.has(Number(c.shareholder_id))) continue;
          const sh = activeSH.find((s: any) => s.id === Number(c.shareholder_id));
          if (!sh) continue;
          const existing = contribByShId.get(c.shareholder_id);
          if (existing) {
            // Merge: sum amounts, keep latest payment_date, escalate to "late" if any is late
            existing.amount = Number(existing.amount) + Number(c.amount);
            if (c.payment_date && (!existing.payment_date || c.payment_date > existing.payment_date)) {
              existing.payment_date = c.payment_date;
            }
            if (c.status === "late") existing.status = "late";
            if (c.notes) existing.notes = existing.notes ? `${existing.notes}; ${c.notes}` : c.notes;
          } else {
            contribByShId.set(c.shareholder_id, { ...c, shareholder: sh, amount: Number(c.amount) });
          }
        }

        if (contribStatusF === "paid") {
          // Active shareholders who have paid for this period
          const paidRows: any[] = [];
          contribByShId.forEach((row) => paidRows.push(row));
          setRows(paidRows);
        } else if (contribStatusF === "unpaid") {
          // Active shareholders who have NOT paid for this period
          const unpaidRows = activeSH
            .filter((sh: any) => !contribByShId.has(sh.id))
            .map((sh: any) => ({
              id: `unpaid-${sh.id}`,
              shareholder: sh,
              month: checkMonth,
              year:  checkYear,
              payment_date: null,
              amount: 0,
              status: "unpaid",
              notes: "",
            }));
          setRows(unpaidRows);
        } else {
          // "all" — All active members: paid ones with their consolidated row, unpaid ones as unpaid row
          const allRows: any[] = [];
          for (const sh of activeSH) {
            const consolidated = contribByShId.get(sh.id);
            if (consolidated) {
              allRows.push(consolidated);
            } else {
              allRows.push({
                id: `unpaid-${sh.id}`,
                shareholder: sh,
                month: checkMonth,
                year:  checkYear,
                payment_date: null,
                amount: 0,
                status: "unpaid",
                notes: "",
              });
            }
          }
          setRows(allRows);
        }

      } else if (type === "contributionsList") {
        // One row per shareholder: total contributed within the date range.
        // Contributions are paged because Supabase caps a single response at 1000 rows.
        const members = await shareholdersApi.list({ status: listStatusF || undefined });
        const contribs: any[] = [];
        const PAGE = 1000;
        for (let from = 0; ; from += PAGE) {
          const { data, error } = await supabase
            .from("contributions")
            .select("shareholder_id,amount,payment_date,year,month")
            .order("id")
            .range(from, from + PAGE - 1);
          if (error) throw new Error(error.message);
          contribs.push(...(data ?? []));
          if (!data || data.length < PAGE) break;
        }
        const totals = new Map<number, { amount: number; count: number }>();
        for (const c of contribs) {
          // Use the date paid; fall back to the billing month when no payment date was recorded.
          const day = c.payment_date
            ? String(c.payment_date).slice(0, 10)
            : `${c.year}-${String(c.month).padStart(2, "0")}-01`;
          if (dateFrom && day < dateFrom) continue;
          if (dateTo && day > dateTo) continue;
          const id = Number(c.shareholder_id);
          const cur = totals.get(id) ?? { amount: 0, count: 0 };
          totals.set(id, { amount: cur.amount + Number(c.amount), count: cur.count + 1 });
        }
        setRows(members.map((m: any) => ({
          id: m.id,
          name: m.name,
          member_number: m.member_number,
          status: m.status,
          amount: totals.get(m.id)?.amount ?? 0,
          count: totals.get(m.id)?.count ?? 0,
        })));

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
  }, [type, yearF, monthF, modeF, purposeF, statusF, dateFrom, dateTo, search, listStatusF, projectF, contribStatusF, shareholderF, memberTypeF, plotF, arrearStatusF, includeUpcoming, shareholders, debtorClients, projects]);

  useEffect(() => { load(); }, [load]);

  // Plot debtors must reflect new allocations, edits and payments immediately.
  useEffect(() => {
    if (type !== "debtors") return;
    const channel = supabase
      .channel(`plot-debtors-report-${Date.now()}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "plots" }, () => {
        supabase.from("plots").select("id,project_id,plot_number").not("assigned_to_id", "is", null).order("plot_number")
          .then(({ data }) => setPlotOptions((data ?? []) as any));
        load();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "plot_payments" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "shareholders" }, () => {
        supabase.from("shareholders").select("id,name,member_number,phone").order("name")
          .then(({ data }) => setShareholders((data ?? []) as any));
        load();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "clients" }, () => {
        supabase.from("clients").select("id,name,member_number,phone").order("name")
          .then(({ data }) => setDebtorClients((data ?? []) as any));
        load();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "projects" }, () => {
        supabase.from("projects").select("id,project_name").order("project_name")
          .then(({ data }) => setProjects(data ?? []));
        load();
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [type, load]);

  // ── search filter applied in-memory for member lists ────────────────────
  const filtered = (type === "contributions" || type === "contributionsList" || type === "payments" || type === "refunds" || type === "profits" || type === "debtors")
    ? rows.filter((r) => {
        if (!search) return true;
        const q = search.toLowerCase();
        if (type === "contributions") return r.shareholder?.name.toLowerCase().includes(q) || `EW#${r.shareholder?.member_number}`.includes(q);
        if (type === "contributionsList") return (r.name ?? "").toLowerCase().includes(q) || `ew#${r.member_number}`.includes(q) || String(r.member_number).includes(q);
        if (type === "payments") return r.paid_by?.toLowerCase().includes(q) || (r.payment_id ?? "").toLowerCase().includes(q) || r.purpose?.toLowerCase().includes(q);
        if (type === "refunds") return r.shareholder?.name?.toLowerCase().includes(q) || `EW#${r.shareholder?.member_number}`.includes(q);
        if (type === "profits") {
          const memberName = r.shareholder?.name ?? r.investor?.name ?? "";
          const memberNo = r.shareholder?.member_number ?? r.investor?.member_number ?? "";
          return memberName.toLowerCase().includes(q) || `EW#${memberNo}`.includes(q) || (r.project?.project_name ?? "").toLowerCase().includes(q);
        }
        if (type === "debtors") {
          return `${r.shareholder?.name ?? ""} ${r.shareholder?.member_number ?? ""} ${r.project?.project_name ?? ""} ${r.plotNumber ?? ""} ${r.monthLabel ?? ""}`.toLowerCase().includes(q);
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
        type !== "contributionsList" && yearF !== "all" && `Year: ${yearF}`,
        type !== "contributionsList" && monthF !== "all" && `Month: ${MONTHS[(monthF as number) - 1]}`,
        type === "contributionsList" && `Members: ${listStatusF || "All"}`,
        modeF    && `Mode: ${modeF}`,
        purposeF && `Purpose: ${purposeF}`,
        statusF  && `Status: ${statusF}`,
        dateFrom && `From: ${dateFrom}`,
        dateTo   && `To: ${dateTo}`,
        projectF && `Project: ${projects.find((p) => String(p.id) === projectF)?.project_name ?? projectF}`,
        shareholderF && `Member: ${shareholderF.startsWith("client:")
          ? debtorClients.find((member) => `client:${member.id}` === shareholderF)?.name
          : shareholders.find((member) => `shareholder:${member.id}` === shareholderF)?.name}`,
        memberTypeF && `Member Type: ${memberTypeF === "client" ? "Client" : "Shareholder"}`,
        plotF && `Plot: ${plotOptions.find((p) => String(p.id) === plotF)?.plot_number ?? plotF}`,
        type === "debtors" && `Status: ${arrearStatusF === "unpaid" ? "Not paid" : arrearStatusF === "paid" ? "Paid" : "All"}`,
        type === "debtors" && includeUpcoming && "Including upcoming repayments",
      ].filter(Boolean).join(" · ") || "All records";

      if (type === "debtors") {
        downloadReportPdf([{
          title: "Plot Arrears",
          headers: ["Member", "Member No.", "Phone", "Month", "Project", "Plot Number", "Monthly Repayment", "Outstanding", "Paid Status"],
          rows: filtered.map((row: any) => [
            row.shareholder?.name ?? "—", row.memberType === "client" ? String(row.shareholder?.member_number ?? "—") : `EW#${row.shareholder?.member_number ?? "—"}`,
            row.shareholder?.phone ?? "—", row.monthLabel, row.project?.project_name ?? "—", row.plotNumber,
            Number(row.amount).toLocaleString("en-KE"), Number(row.remaining).toLocaleString("en-KE"),
            arrearStatusText(row),
          ]),
          total: filtered.reduce((sum: number, row: any) => sum + Number(row.remaining), 0),
        }], "Arrears Report", co, filterStr);

      } else if (type === "contributionsList") {
        downloadReportPdf([{
          title: "Contributions List",
          headers: ["#", "Member Name", "EW No.", "Amount (KES)"],
          rows: filtered.map((r: any, i: number) => [String(i + 1), r.name, `EW#${r.member_number}`, Number(r.amount).toLocaleString("en-KE")]),
          total: filtered.reduce((s: number, r: any) => s + Number(r.amount), 0),
        }], "Contributions List", co, filterStr);

      } else if (type === "contributions") {
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

  const handleExcel = () => {
    const stamp = new Date().toISOString().slice(0, 10);
    if (type === "debtors") {
      downloadExcel(`arrears-report-${stamp}`, "Arrears",
        ["Member", "Member No.", "Phone", "Month", "Due Date", "Project", "Plot Number", "Monthly Repayment", "Outstanding", "Paid Status"],
        filtered.map((row: any) => [
          row.shareholder?.name ?? "—", row.memberType === "client" ? String(row.shareholder?.member_number ?? "—") : `EW#${row.shareholder?.member_number ?? "—"}`,
          row.shareholder?.phone ?? "—", row.monthLabel, fmtDate(row.dueDate), row.project?.project_name ?? "—", row.plotNumber,
          Number(row.amount), Number(row.remaining), arrearStatusText(row),
        ]));
    } else if (type === "contributionsList") {
      downloadExcel(`contributions-list-${stamp}`, "Contributions List",
        ["Member Name", "EW No.", "Amount"],
        filtered.map((r: any) => [r.name, `EW#${r.member_number}`, Number(r.amount)]));
    } else if (type === "contributions") {
      downloadExcel(`contributions-report-${stamp}`, "Contributions",
        ["Member", "Member No.", "Month", "Year", "Date Paid", "Amount", "Status", "Notes"],
        filtered.map((c: any) => [c.shareholder?.name ?? "—", `EW#${c.shareholder?.member_number ?? "—"}`, MONTHS[c.month - 1], c.year, c.payment_date ? fmtDate(c.payment_date) : "—", Number(c.amount), c.status, c.notes ?? "—"]));
    } else if (type === "payments") {
      downloadExcel(`payments-report-${stamp}`, "Payments",
        ["Payment ID", "Date Paid", "Amount", "Paid By", "Purpose", "Mode", "Comment"],
        filtered.map((p: any) => [p.payment_id ?? "—", fmtDate(p.date_paid), Number(p.amount), p.paid_by, p.purpose, p.mode, p.comment ?? "—"]));
    } else if (type === "refunds") {
      downloadExcel(`refunds-report-${stamp}`, "Refunds",
        ["Member", "Member No.", "Amount", "Refund Date", "Notes"],
        filtered.map((r: any) => [r.shareholder?.name ?? "Unknown", `EW#${r.shareholder?.member_number ?? "—"}`, Number(r.amount), fmtDate(r.refund_date), r.notes ?? "—"]));
    } else if (type === "shareholders" || type === "clients") {
      downloadExcel(`${type}-report-${stamp}`, type === "shareholders" ? "Shareholders" : "Clients",
        ["Member No.", "Name", "Phone", "Email", "Joined", "Status", ...(type === "shareholders" ? ["Net Savings"] : [])],
        filtered.map((member: any) => [member.member_number, member.name, member.phone, member.email, fmtDate(member.joined_date), member.status, ...(type === "shareholders" ? [Number(member.net_savings ?? 0)] : [])]));
    } else if (type === "profits") {
      downloadExcel(`profit-distributions-${stamp}`, "Profit Distributions",
        ["Member", "Member No.", "Type", "Project", "Date", "Amount", "Notes"],
        filtered.map((r: any) => {
          const isInvestor = !!r.investor_id;
          return [
            isInvestor ? r.investor?.name ?? "—" : r.shareholder?.name ?? "—",
            `EW#${isInvestor ? r.investor?.member_number ?? "—" : r.shareholder?.member_number ?? "—"}`,
            isInvestor ? "Investor" : "Shareholder", r.project?.project_name ?? "—",
            fmtDate(r.distributed_at?.slice(0, 10)), Number(r.amount), r.notes ?? "—",
          ];
        }));
    } else if (type === "summary" && rows[0]) {
      const { sh, cl, contribRes, payRes } = rows[0];
      downloadExcelWorkbook(`annual-summary-${yearF === "all" ? "all-years" : yearF}-${stamp}`, [
        { name: "Membership", headers: ["Category", "Total", "Active", "Inactive"], rows: [
          ["Shareholders", sh.length, sh.filter((s: any) => s.status === "Active").length, sh.filter((s: any) => s.status !== "Active").length],
          ["Clients", cl.length, cl.filter((c: any) => c.status === "Active").length, cl.filter((c: any) => c.status !== "Active").length],
        ] },
        { name: "Contributions", headers: ["Member", "Member No.", "Total", "Payments"], rows: contribRes.map((s: any) => [s.shareholder.name, `EW#${s.shareholder.member_number}`, Number(s.total), s.count]) },
        { name: "Payments", headers: ["Paid By", "Purpose", "Mode", "Amount"], rows: payRes.map((p: any) => [p.paid_by, p.purpose, p.mode, Number(p.amount)]) },
      ]);
    }
  };

  // ── filter bar ───────────────────────────────────────────────────────────
  // Arrears filters are laid out on a grid (2 columns on phones, 3 on wider screens).
  const gridFilters = type === "debtors";
  const filterBar = (
    <div className={gridFilters
      ? "px-5 py-3 border-b grid grid-cols-2 sm:grid-cols-3 gap-2 items-center bg-white [&_select]:w-full [&_select]:max-w-none [&_label]:w-full [&_input]:min-w-0 [&_label>input]:flex-1"
      : "px-5 py-3 border-b flex flex-wrap gap-2 items-center bg-white"} style={{ borderColor: "var(--border)" }}>
      {!gridFilters && <Filter size={13} className="text-gray-400 flex-shrink-0" />}
      {/* Search */}
      {["contributions", "contributionsList", "payments", "refunds", "profits", "debtors"].includes(type) && (
        <div className={gridFilters ? "relative col-span-full" : "relative flex-1 min-w-[160px]"}>
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder={type === "contributionsList" ? "Search member name or EW No.…" : type === "profits" ? "Search member or project…" : type === "debtors" ? "Search member/client, project or plot…" : "Search…"}
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
        <select value={contribStatusF} onChange={(e) => setContribStatusF(e.target.value as "all" | "paid" | "unpaid")}
          className="border rounded-lg px-2 py-1.5 text-xs font-semibold focus:outline-none bg-white"
          style={{
            borderColor: contribStatusF === "unpaid" ? "#ef4444" : contribStatusF === "paid" ? "#16a34a" : "var(--border)",
            color: contribStatusF === "unpaid" ? "#ef4444" : contribStatusF === "paid" ? "#16a34a" : undefined,
          }}>
          <option value="all">All Members</option>
          <option value="paid">Paid</option>
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
      {type === "contributionsList" && (
        <select value={listStatusF} onChange={(e) => setListStatusF(e.target.value as "Active" | "Inactive" | "")}
          className="border rounded-lg px-2 py-1.5 text-xs font-semibold focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="Active">Active</option>
          <option value="Inactive">Inactive</option>
          <option value="">All Members</option>
        </select>
      )}
      {["contributionsList", "payments", "refunds", "profits", "debtors"].includes(type) && (
        <>
          <label className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-xs font-normal text-slate-700 focus:outline-none bg-white" style={{ borderColor: "var(--border)" }} />
          </label>
          <label className="flex items-center gap-1.5 text-[10px] font-semibold text-slate-400">
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-xs font-normal text-slate-700 focus:outline-none bg-white" style={{ borderColor: "var(--border)" }} />
          </label>
        </>
      )}
      {/* Project filter */}
      {["profits", "debtors"].includes(type) && (
        <select value={projectF} onChange={(e) => { setProjectF(e.target.value); if (type === "debtors") setPlotF(""); }}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
          <option value="">All Projects</option>
          {projects.map((p) => <option key={p.id} value={String(p.id)}>{p.project_name}</option>)}
        </select>
      )}
      {type === "debtors" && (
        <>
          <select value={arrearStatusF} onChange={(e) => setArrearStatusF(e.target.value as "unpaid" | "paid" | "")}
            className="border rounded-lg px-2 py-1.5 text-xs font-semibold focus:outline-none bg-white"
            style={{ borderColor: arrearStatusF === "unpaid" ? "#ef4444" : arrearStatusF === "paid" ? "#16a34a" : "var(--border)", color: arrearStatusF === "unpaid" ? "#dc2626" : arrearStatusF === "paid" ? "#15803d" : undefined }}>
            <option value="unpaid">Not paid</option>
            <option value="paid">Paid</option>
            <option value="">All arrears</option>
          </select>
          <select value={memberTypeF} onChange={(e) => {
            const next = e.target.value as "" | "shareholder" | "client";
            setMemberTypeF(next);
            if (shareholderF && !shareholderF.startsWith(`${next}:`)) setShareholderF("");
          }}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white" style={{ borderColor: "var(--border)" }}>
            <option value="">All Member Types</option>
            <option value="shareholder">Shareholders</option>
            <option value="client">Clients</option>
          </select>
          <select value={shareholderF} onChange={(e) => setShareholderF(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white max-w-[210px]" style={{ borderColor: "var(--border)" }}>
            <option value="">All Shareholders & Clients</option>
            {memberTypeF !== "client" && <optgroup label="Shareholders">
              {shareholders.map((shareholder) => <option key={`shareholder-${shareholder.id}`} value={`shareholder:${shareholder.id}`}>{shareholder.name} · EW#{shareholder.member_number}</option>)}
            </optgroup>}
            {memberTypeF !== "shareholder" && <optgroup label="Clients">
              {debtorClients.map((client) => <option key={`client-${client.id}`} value={`client:${client.id}`}>{client.name} · {client.member_number}</option>)}
            </optgroup>}
          </select>
          <select value={plotF} disabled={!projectF} onChange={(e) => setPlotF(e.target.value)}
            className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white disabled:bg-slate-100 disabled:text-slate-400" style={{ borderColor: "var(--border)" }}>
            <option value="">{projectF ? "All Plots" : "Select project first"}</option>
            {plotOptions.filter((plot) => String(plot.project_id) === projectF).map((plot) => <option key={plot.id} value={String(plot.id)}>{plot.plot_number}</option>)}
          </select>
        </>
      )}
    </div>
  );

  // ── per-type table ────────────────────────────────────────────────────────
  const renderTable = () => {
    if (loading) return <div className="flex items-center justify-center py-16"><Loader2 size={22} className="animate-spin text-gray-300" /></div>;

    if (type === "debtors") {
      const unpaidRows = filtered.filter((row: any) => row.status === "unpaid");
      const totalOutstanding = unpaidRows.reduce((sum: number, row: any) => sum + Number(row.remaining), 0);
      const debtorCount = new Set(unpaidRows.map((row: any) => `${row.memberType}:${row.plot?.assigned_to_id}`)).size;
      const upcomingRows = filtered.filter((row: any) => row.status === "upcoming");
      const upcomingTotal = upcomingRows.reduce((sum: number, row: any) => sum + Number(row.remaining), 0);
      const upcomingMembers = new Set(upcomingRows.map((row: any) => `${row.memberType}:${row.plot?.assigned_to_id}`)).size;
      const paidCount = filtered.filter((row: any) => row.status === "paid").length;
      return (
        <>
          <div className={`grid grid-cols-1 gap-3 px-5 py-4 border-b bg-slate-50 ${includeUpcoming ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3"}`} style={{ borderColor: "var(--border)" }}>
            {[
              { label: "Total Unpaid Arrears", value: fmtKESFull(totalOutstanding), color: "#dc2626", sub: "Outstanding on missed months" },
              { label: "Unpaid Months", value: String(unpaidRows.length), color: "#d97706", sub: `${paidCount} arrear${paidCount === 1 ? "" : "s"} since paid` },
              { label: "Debtors", value: String(debtorCount), color: "#1e3a5f", sub: "Members with unpaid arrears" },
              ...(includeUpcoming ? [{ label: "Upcoming (not yet due)", value: fmtKESFull(upcomingTotal), color: "#b45309", sub: `${upcomingRows.length} repayment${upcomingRows.length === 1 ? "" : "s"} · ${upcomingMembers} member${upcomingMembers === 1 ? "" : "s"}` }] : []),
            ].map((stat) => (
              <div key={stat.label} className="rounded-xl border bg-white px-4 py-3.5" style={{ borderColor: "var(--border)" }}>
                <p className="text-[10px] font-bold uppercase tracking-wide text-gray-400">{stat.label}</p>
                <p className="mt-1 text-lg font-extrabold" style={{ color: stat.color }}>{stat.value}</p>
                <p className="mt-0.5 text-[10px] text-slate-400">{stat.sub}</p>
              </div>
            ))}
          </div>
          <div className="overflow-x-auto flex-1">
            <table className="w-full text-sm min-w-[980px]">
              <thead style={{ background: "#1e3a5f" }}>
                <tr>{["Member", "No.", "Month", "Project", "Plot Number", "Monthly Repayment", "Paid Status", "Action"].map((heading) => (
                  <th key={heading} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{heading}</th>
                ))}</tr>
              </thead>
              <tbody>
                {filtered.map((row: any, index: number) => (
                  <tr key={row.key} className="border-t hover:bg-red-50/40" style={{ borderColor: "var(--border)", background: index % 2 === 0 ? "#fff" : "#f8fafc" }}>
                    <td className="px-3 py-2">
                      <p className="text-xs font-semibold text-slate-800">{row.shareholder?.name ?? "Unknown"}</p>
                      <p className="text-[10px] text-slate-400">{row.memberType === "client" ? "Client" : "Shareholder"}{row.shareholder?.phone ? ` · ${row.shareholder.phone}` : ""}</p>
                    </td>
                    <td className="px-3 py-2 text-xs font-bold text-indigo-600">{row.memberType === "client" ? row.shareholder?.member_number ?? "—" : `EW#${row.shareholder?.member_number ?? "—"}`}</td>
                    <td className="px-3 py-2">
                      <p className="text-xs font-semibold text-slate-700">{row.monthLabel}</p>
                      <p className="text-[10px] text-slate-400">Due {fmtDate(row.dueDate)}</p>
                    </td>
                    <td className="px-3 py-2 text-xs font-semibold text-slate-700">{row.project?.project_name ?? "—"}</td>
                    <td className="px-3 py-2 text-xs font-bold text-blue-700">{row.plotNumber}</td>
                    <td className="px-3 py-2">
                      <p className="text-xs font-bold text-slate-800">{fmtKESFull(Number(row.amount))}</p>
                      {row.status !== "paid" && Number(row.paid) > 0 && <p className={`text-[10px] ${row.status === "upcoming" ? "text-amber-600" : "text-rose-600"}`}>{fmtKESFull(Number(row.remaining))} left</p>}
                    </td>
                    <td className="px-3 py-2">
                      {(() => {
                        const st = arrearStatusInfo(row);
                        return (
                          <div className="flex flex-col items-start gap-0.5">
                            <span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-bold ${st.badge}`}>{st.label}</span>
                            {st.sub && <p className={`px-2 text-[10px] font-semibold whitespace-nowrap ${st.subColor}`}>{st.sub}</p>}
                          </div>
                        );
                      })()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                      {row.status === "paid"
                        ? <span className="text-[10px] text-slate-400">{row.clearedOn ? `Paid ${fmtDate(row.clearedOn)}` : "—"}</span>
                        : row.payable && ArrearPay && row.shareholder
                          ? <button onClick={() => setPayRequest({
                              plot: { id: row.plotId, plot_number: row.plotNumber, price: Number(row.plot?.price ?? 0), paid_amount: Number(row.plot?.paid_amount ?? 0), projectName: row.project?.project_name ?? "" },
                              member: { id: Number(row.plot?.assigned_to_id), name: row.shareholder.name, phone: row.shareholder.phone, type: row.memberType },
                              amount: Number(row.remaining),
                              monthLabel: row.monthLabel,
                            })}
                              className="rounded-lg px-3 py-1.5 text-[11px] font-bold text-white hover:opacity-90" style={{ background: "#16a34a" }}>Pay</button>
                          : <span className="text-[10px] text-slate-400">{row.payable ? "—" : "Pay earlier month first"}</span>}
                      {row.status !== "paid" && (() => {
                        const n = notifyState[row.key];
                        return (
                          <button onClick={() => notifyArrear(row)} disabled={n?.status === "sending"}
                            title={n?.status === "error" ? n.message : row.status === "upcoming" ? "Send an upcoming-repayment reminder SMS" : "Send an arrears reminder SMS to this member"}
                            className="rounded-lg border px-3 py-1.5 text-[11px] font-bold transition-colors disabled:opacity-60"
                            style={n?.status === "sent"
                              ? { borderColor: "#86efac", background: "#f0fdf4", color: "#15803d" }
                              : n?.status === "error"
                                ? { borderColor: "#fecaca", background: "#fef2f2", color: "#b91c1c" }
                                : { borderColor: "#fcd34d", background: "#fffbeb", color: "#b45309" }}>
                            {n?.status === "sending" ? "Sending…" : n?.status === "sent" ? "Notified ✓" : n?.status === "error" ? "Retry" : "Notify"}
                          </button>
                        );
                      })()}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              {filtered.length > 0 && (
                <tfoot>
                  <tr className="border-t-2" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
                    <td colSpan={5} className="px-3 py-2 text-xs font-extrabold uppercase text-red-700">Total Unpaid</td>
                    <td className="px-3 py-2 text-xs font-extrabold text-red-700">{fmtKESFull(totalOutstanding)}</td>
                    <td colSpan={2} />
                  </tr>
                  {includeUpcoming && upcomingRows.length > 0 && (
                    <tr style={{ background: "#fffbeb" }}>
                      <td colSpan={5} className="px-3 py-2 text-xs font-extrabold uppercase text-amber-700">Upcoming (not yet due)</td>
                      <td className="px-3 py-2 text-xs font-extrabold text-amber-700">{fmtKESFull(upcomingTotal)}</td>
                      <td colSpan={2} />
                    </tr>
                  )}
                </tfoot>
              )}
            </table>
            {filtered.length === 0 && <div className="py-14 text-center"><AlertTriangle size={28} className="mx-auto mb-2 text-slate-300" /><p className="text-sm text-slate-400">No arrears match the selected filters.</p></div>}
          </div>
          {payRequest && ArrearPay && (
            <ArrearPay request={payRequest} onClose={() => setPayRequest(null)} onPaid={() => { setPayRequest(null); load(); }} />
          )}
        </>
      );
    }

    if (type === "contributionsList") {
      const total = filtered.reduce((s: number, r: any) => s + Number(r.amount), 0);
      return (
        <div className="overflow-x-auto flex-1">
          <table className="w-full text-sm">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>{["#", "Member Name", "EW No.", "Amount (KES)"].map((h) => (
                <th key={h} className={`px-3 py-2 text-xs font-semibold uppercase tracking-wider text-white ${h === "Amount (KES)" ? "text-right" : "text-left"}`}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {filtered.map((r: any, i: number) => (
                <tr key={r.id} className="border-t hover:bg-gray-50" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#eef2ff" }}>
                  <td className="px-3 py-1.5 text-xs text-gray-400">{i + 1}</td>
                  <td className="px-3 py-1.5 font-semibold text-xs">{r.name}</td>
                  <td className="px-3 py-1.5 text-xs font-bold" style={{ color: "#6366f1" }}>EW#{r.member_number}</td>
                  <td className="px-3 py-1.5 text-xs font-bold text-right" style={{ color: Number(r.amount) > 0 ? "#16a34a" : "#94a3b8" }}>{fmtKESFull(Number(r.amount))}</td>
                </tr>
              ))}
            </tbody>
            {filtered.length > 0 && (
              <tfoot>
                <tr style={{ background: "#f0fdf4" }}>
                  <td colSpan={3} className="px-3 py-1.5 text-xs font-bold uppercase" style={{ color: "#15803d" }}>Total</td>
                  <td className="px-3 py-1.5 font-bold text-right" style={{ color: "#14532d" }}>{fmtKESFull(total)}</td>
                </tr>
              </tfoot>
            )}
          </table>
          {filtered.length === 0 && <div className="py-12 text-center text-sm text-gray-400">No members match the selected filters.</div>}
        </div>
      );
    }

    if (type === "contributions") {
      const paidCount   = filtered.filter((c: any) => c.status !== "unpaid").length;
      const unpaidCount = filtered.filter((c: any) => c.status === "unpaid").length;
      const total = filtered.reduce((s: number, c: any) => s + Number(c.amount), 0);
      return (
        <>
          {/* Summary pills */}
          <div className="flex items-center gap-3 px-5 py-2.5 border-b flex-shrink-0" style={{ borderColor: "var(--border)" }}>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "#f0fdf4", color: "#16a34a" }}>
              {paidCount} Paid
            </span>
            <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: "#fef2f2", color: "#ef4444" }}>
              {unpaidCount} Unpaid
            </span>
            <span className="text-xs text-gray-400">{filtered.length} total active members</span>
          </div>
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
                <tr style={{ background: "#f0fdf4" }}>
                  <td colSpan={5} className="px-3 py-1.5 text-xs font-bold uppercase" style={{ color: "#15803d" }}>
                    Total Collected
                  </td>
                  <td className="px-3 py-1.5 font-bold" style={{ color: "#14532d" }}>
                    {fmtKESFull(total)}
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
      <div className="px-5 py-4 border-b flex-shrink-0 flex flex-wrap items-center justify-between gap-2"
        style={{ background: meta.color, borderColor: "rgba(0,0,0,0.1)" }}>
        <div className="flex items-center gap-3 min-w-0">
          <button onClick={onBack}
            className="flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg hover:opacity-80"
            style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}>
            <ArrowLeft size={13} /> Reports
          </button>
          <div style={{ color: "rgba(255,255,255,0.4)" }}>›</div>
          <h1 className="font-bold text-base text-white">{meta.label}</h1>
        </div>
        <div className="flex items-center gap-2">
          {recordCount !== null && (
            <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.9)" }}>
              {recordCount} record{recordCount !== 1 ? "s" : ""}
            </span>
          )}
          {/* Export buttons live in the header so they stay visible above the phone's bottom navigation. */}
          <button onClick={handleExcel} title="Download Excel"
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-white text-emerald-700 hover:bg-emerald-50 transition-colors">
            <FileSpreadsheet size={14} /> Excel
          </button>
          <button onClick={handlePdf} disabled={downloading} title="Download PDF"
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-1.5 rounded-lg bg-white hover:opacity-90 disabled:opacity-60 transition-opacity"
            style={{ color: meta.color }}>
            {downloading ? <Loader2 size={14} className="animate-spin" /> : <FileDown size={14} />}
            {downloading ? "PDF…" : "PDF"}
          </button>
        </div>
      </div>

      {/* Scrollable body: filters and company header scroll away with the table */}
      <div className="flex-1 overflow-auto pb-20 md:pb-0">
        {/* Filters */}
        {filterBar}

        {/* Company header — shown in report body */}
        {company && (
          <div className="px-5 py-4 border-b bg-white flex items-center gap-4"
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
        {renderTable()}
      </div>

      {/* Download footer (desktop only — on phones the bottom navigation covers it; the header has the buttons) */}
      <div className="px-5 py-4 border-t bg-white flex-shrink-0 hidden md:flex items-center justify-between"
        style={{ borderColor: "var(--border)" }}>
        <p className="text-xs text-gray-400">
          {recordCount !== null ? `${recordCount} record${recordCount !== 1 ? "s" : ""} shown` : "Summary report"}
        </p>
        <div className="flex items-center gap-2">
          <button onClick={handleExcel}
            className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-emerald-700 border border-emerald-200 bg-emerald-50 hover:bg-emerald-100 transition-colors">
            <FileSpreadsheet size={15} /> Download Excel
          </button>
          <button onClick={handlePdf} disabled={downloading}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-50 hover:opacity-90 transition-opacity"
            style={{ background: meta.color }}>
            {downloading ? <Loader2 size={15} className="animate-spin" /> : <FileDown size={15} />}
            {downloading ? "Generating PDF…" : "Download PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}
export { ReportsPage };
