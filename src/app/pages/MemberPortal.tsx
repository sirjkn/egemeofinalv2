import { useState, useEffect, useCallback } from "react";
import {
  LogOut, User, TrendingUp, Wallet, BarChart2, Download,
  ChevronRight, Loader2, Home, FileText, Building2, CreditCard,
  CircleDollarSign, Calendar, CheckCircle2, Clock, X, ArrowLeft,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { shareholdersApi, clientsApi, investorsApi, contributionsApi } from "@/lib/api";
import { fmtKESFull, fmtDate, MONTHS, initials } from "@/app/shared";
import { downloadContributionsPdf, downloadReportPdf } from "@/lib/pdf";
import { getCompanyDetails } from "@/lib/company";
import type { UserProfile } from "@/app/pages/AuthPage";

// ─── Shared portal shell ──────────────────────────────────────────────────────

function PortalShell({
  title, subtitle, accentColor, avatarContent, onLogout, children,
}: {
  title: string; subtitle: string; accentColor: string; avatarContent: React.ReactNode;
  onLogout: () => void; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex flex-col" style={{ background: "#f8fafc", fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      {/* Top bar */}
      <header className="sticky top-0 z-30 shadow-sm" style={{ background: accentColor }}>
        <div className="max-w-2xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
            style={{ background: "rgba(255,255,255,0.2)" }}>
            {avatarContent}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-white font-bold text-sm truncate">{title}</p>
            <p className="text-xs truncate" style={{ color: "rgba(255,255,255,0.6)" }}>{subtitle}</p>
          </div>
          <button
            onClick={onLogout}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
            style={{ background: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.9)" }}
          >
            <LogOut size={13} /> Sign Out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-2xl mx-auto w-full px-4 py-5 space-y-4 pb-10">
        {children}
      </main>
    </div>
  );
}

function StatCard({ label, value, icon, color, bg }: { label: string; value: string; icon: React.ReactNode; color: string; bg: string }) {
  return (
    <div className="bg-white rounded-2xl border p-4 flex items-center gap-3" style={{ borderColor: "var(--border)" }}>
      <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: bg }}>
        <span style={{ color }}>{icon}</span>
      </div>
      <div>
        <p className="text-xs text-gray-400 font-medium">{label}</p>
        <p className="font-bold text-sm mt-0.5" style={{ color: "#1a202c" }}>{value}</p>
      </div>
    </div>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
      <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border)", background: "#f8fafc" }}>
        <p className="text-xs font-bold uppercase tracking-wider text-gray-500">{title}</p>
      </div>
      {children}
    </div>
  );
}

// ─── Shareholder Portal ───────────────────────────────────────────────────────

export function ShareholderPortal({ profile, onLogout }: { profile: UserProfile; onLogout: () => void }) {
  const [member, setMember]             = useState<any>(null);
  const [contributions, setContribs]    = useState<any[]>([]);
  const [profits, setProfits]           = useState<any[]>([]);
  const [loading, setLoading]           = useState(true);
  const [tab, setTab]                   = useState<"overview" | "contributions" | "profits">("overview");

  const load = useCallback(async () => {
    if (!profile.member_id) return;
    setLoading(true);
    try {
      const [sh, contribs, profitRows] = await Promise.all([
        shareholdersApi.get(profile.member_id),
        contributionsApi.listByShareholder(profile.member_id),
        supabase
          .from("profit_distributions")
          .select("*, project:projects(project_name)")
          .eq("shareholder_id", profile.member_id)
          .order("distributed_at", { ascending: false }),
      ]);
      setMember(sh);
      setContribs(contribs);
      setProfits(profitRows.data ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [profile.member_id]);

  useEffect(() => { load(); }, [load]);

  // Still loading — give member_id a moment to resolve (covers race conditions)
  if (loading && !profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Shareholder Account" accentColor="#6366f1"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-indigo-400" />
        </div>
      </PortalShell>
    );
  }

  if (!profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Shareholder Account" accentColor="#6366f1"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="bg-white rounded-2xl border p-8 text-center" style={{ borderColor: "var(--border)" }}>
          <p className="text-gray-500 text-sm">Account setup is still in progress.</p>
          <p className="text-gray-400 text-xs mt-1">Please sign out and sign in again. If the problem persists, contact your administrator.</p>
        </div>
      </PortalShell>
    );
  }

  const totalContribs = contributions.reduce((s, c) => s + Number(c.amount), 0);
  const totalProfits  = profits.reduce((s, p) => s + Number(p.amount), 0);

  const downloadStatement = async () => {
    const co = await getCompanyDetails();
    downloadContributionsPdf(contributions.map((c) => ({
      member: member?.name ?? "",
      memberNo: `EW#${member?.member_number}`,
      month: MONTHS[c.month - 1],
      year: c.year,
      date_paid: c.payment_date ? fmtDate(c.payment_date) : "—",
      amount: Number(c.amount),
      status: c.status,
      notes: c.notes ?? "—",
    })), co, `Member: ${member?.name}`);
  };

  return (
    <PortalShell
      title={member?.name ?? profile.full_name ?? "Shareholder"}
      subtitle={`EW#${member?.member_number} · Shareholder Account`}
      accentColor="#4f46e5"
      avatarContent={<span className="text-white font-bold text-xs">{initials(member?.name ?? "SH")}</span>}
      onLogout={onLogout}
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-indigo-300" /></div>
      ) : (
        <>
          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Net Savings" value={fmtKESFull(Number(member?.net_savings ?? 0))} icon={<Wallet size={18} />} color="#6366f1" bg="#eef2ff" />
            <StatCard label="Total Profits" value={fmtKESFull(Number(member?.total_profits ?? 0))} icon={<TrendingUp size={18} />} color="#d97706" bg="#fffbeb" />
            <StatCard label="Contributions" value={String(member?.contributions_count ?? 0)} icon={<CheckCircle2 size={18} />} color="#22c55e" bg="#f0fdf4" />
            <StatCard label="Member Since" value={member?.joined_date ? fmtDate(member.joined_date) : "—"} icon={<Calendar size={18} />} color="#0d9488" bg="#f0fdfa" />
          </div>

          {/* Tab bar */}
          <div className="flex gap-1 bg-white rounded-2xl border p-1" style={{ borderColor: "var(--border)" }}>
            {([
              { id: "overview", label: "Overview" },
              { id: "contributions", label: `Contributions (${contributions.length})` },
              { id: "profits", label: `Profits (${profits.length})` },
            ] as const).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="flex-1 py-2 rounded-xl text-xs font-bold transition-colors"
                style={{ background: tab === t.id ? "#4f46e5" : "transparent", color: tab === t.id ? "#fff" : "#64748b" }}>
                {t.label}
              </button>
            ))}
          </div>

          {/* Overview */}
          {tab === "overview" && (
            <>
              <SectionCard title="Profile">
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {[
                    { label: "Full Name",     value: member?.name },
                    { label: "Member No.",    value: `EW#${member?.member_number}` },
                    { label: "Phone",         value: member?.phone },
                    { label: "Email",         value: member?.email || "—" },
                    { label: "Status",        value: member?.status },
                    { label: "Joined Date",   value: member?.joined_date ? fmtDate(member.joined_date) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-gray-400">{label}</span>
                      <span className="text-xs font-semibold" style={{ color: "#1a202c" }}>{value}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <SectionCard title="Financial Summary">
                <div className="p-4 space-y-3">
                  {[
                    { label: "Total Contributions", value: fmtKESFull(totalContribs), color: "#6366f1" },
                    { label: "Total Profits Received", value: fmtKESFull(totalProfits), color: "#d97706" },
                    { label: "Net Savings (Balance)", value: fmtKESFull(Number(member?.net_savings ?? 0)), color: "#22c55e" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5">
                      <span className="text-xs text-gray-500">{label}</span>
                      <span className="text-xs font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>

              <button onClick={downloadStatement}
                className="w-full flex items-center justify-center gap-2 py-3 rounded-2xl text-sm font-bold text-white"
                style={{ background: "#4f46e5" }}>
                <Download size={15} /> Download Statement (PDF)
              </button>
            </>
          )}

          {/* Contributions */}
          {tab === "contributions" && (
            <SectionCard title={`Contributions — ${contributions.length} records, Total: ${fmtKESFull(totalContribs)}`}>
              {contributions.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No contributions recorded yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {contributions.map((c) => (
                    <div key={c.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold" style={{ color: "#1a202c" }}>
                          {MONTHS[c.month - 1]} {c.year}
                        </p>
                        <p className="text-[10px] text-gray-400">
                          {c.payment_date ? fmtDate(c.payment_date) : "—"}
                          {c.notes ? ` · ${c.notes}` : ""}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-xs font-bold text-green-600">{fmtKESFull(Number(c.amount))}</p>
                        <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${c.status === "late" ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"}`}>
                          {c.status === "late" ? "Late" : "On time"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}

          {/* Profits */}
          {tab === "profits" && (
            <SectionCard title={`Profit Distributions — Total: ${fmtKESFull(totalProfits)}`}>
              {profits.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No profit distributions yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {profits.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold" style={{ color: "#1a202c" }}>
                          {p.project?.project_name ?? "Project"}
                        </p>
                        <p className="text-[10px] text-gray-400">{fmtDate(p.distributed_at?.slice(0, 10))}</p>
                      </div>
                      <p className="text-xs font-bold text-amber-600">{fmtKESFull(Number(p.amount))}</p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}
        </>
      )}
    </PortalShell>
  );
}

// ─── Client Portal ────────────────────────────────────────────────────────────

export function ClientPortal({ profile, onLogout }: { profile: UserProfile; onLogout: () => void }) {
  const [member, setMember]   = useState<any>(null);
  const [plots, setPlots]     = useState<any[]>([]);
  const [payments, setPayments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab]         = useState<"overview" | "plots" | "payments">("overview");

  const load = useCallback(async () => {
    if (!profile.member_id) return;
    setLoading(true);
    try {
      const [cl, plotsRes, payRes] = await Promise.all([
        clientsApi.get(profile.member_id),
        supabase
          .from("plots")
          .select("*, project:projects(project_name)")
          .eq("assigned_to_id", profile.member_id)
          .eq("assigned_to_type", "client"),
        supabase
          .from("payments")
          .select("*")
          .eq("shareholder_id", profile.member_id)
          .order("date_paid", { ascending: false }),
      ]);
      setMember(cl);
      setPlots(plotsRes.data ?? []);
      setPayments(payRes.data ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [profile.member_id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Client Account" accentColor="#a855f7"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-purple-400" />
        </div>
      </PortalShell>
    );
  }

  if (!profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Client Account" accentColor="#a855f7"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="bg-white rounded-2xl border p-8 text-center" style={{ borderColor: "var(--border)" }}>
          <p className="text-gray-500 text-sm">Account setup is still in progress.</p>
          <p className="text-gray-400 text-xs mt-1">Please sign out and sign in again. If the problem persists, contact your administrator.</p>
        </div>
      </PortalShell>
    );
  }

  const totalPaid = plots.reduce((s, p) => s + Number(p.paid_amount ?? 0), 0);
  const totalBalance = plots.reduce((s, p) => s + (Number(p.price ?? 0) - Number(p.paid_amount ?? 0)), 0);

  return (
    <PortalShell
      title={member?.name ?? profile.full_name ?? "Client"}
      subtitle={`#${member?.member_number} · Client Account`}
      accentColor="#9333ea"
      avatarContent={<span className="text-white font-bold text-xs">{initials(member?.name ?? "CL")}</span>}
      onLogout={onLogout}
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-purple-300" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Assigned Plots" value={String(plots.length)} icon={<Home size={18} />} color="#9333ea" bg="#faf5ff" />
            <StatCard label="Total Paid" value={fmtKESFull(totalPaid)} icon={<CheckCircle2 size={18} />} color="#22c55e" bg="#f0fdf4" />
            <StatCard label="Balance Due" value={fmtKESFull(totalBalance)} icon={<Wallet size={18} />} color="#ef4444" bg="#fef2f2" />
            <StatCard label="Member Since" value={member?.joined_date ? fmtDate(member.joined_date) : "—"} icon={<Calendar size={18} />} color="#0d9488" bg="#f0fdfa" />
          </div>

          <div className="flex gap-1 bg-white rounded-2xl border p-1" style={{ borderColor: "var(--border)" }}>
            {([
              { id: "overview", label: "Profile" },
              { id: "plots", label: `Plots (${plots.length})` },
              { id: "payments", label: `Payments (${payments.length})` },
            ] as const).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="flex-1 py-2 rounded-xl text-xs font-bold transition-colors"
                style={{ background: tab === t.id ? "#9333ea" : "transparent", color: tab === t.id ? "#fff" : "#64748b" }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <SectionCard title="Profile">
              <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                {[
                  { label: "Full Name",   value: member?.name },
                  { label: "Member No.", value: String(member?.member_number) },
                  { label: "Phone",      value: member?.phone },
                  { label: "Email",      value: member?.email || "—" },
                  { label: "Status",     value: member?.status },
                  { label: "Joined",     value: member?.joined_date ? fmtDate(member.joined_date) : "—" },
                ].map(({ label, value }) => (
                  <div key={label} className="px-4 py-2.5 flex items-center justify-between">
                    <span className="text-xs text-gray-400">{label}</span>
                    <span className="text-xs font-semibold" style={{ color: "#1a202c" }}>{value}</span>
                  </div>
                ))}
              </div>
            </SectionCard>
          )}

          {tab === "plots" && (
            <SectionCard title={`Assigned Plots — ${plots.length}`}>
              {plots.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No plots assigned yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {plots.map((plot) => {
                    const balance = Number(plot.price ?? 0) - Number(plot.paid_amount ?? 0);
                    return (
                      <div key={plot.id} className="px-4 py-3">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-xs font-bold" style={{ color: "#1a202c" }}>
                            Plot {plot.plot_number} · {plot.project?.project_name ?? "—"}
                          </p>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                            plot.status === "sold" ? "bg-green-50 text-green-600" :
                            plot.status === "reserved" ? "bg-amber-50 text-amber-600" : "bg-blue-50 text-blue-600"
                          }`}>{plot.status}</span>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          {[
                            { l: "Price", v: fmtKESFull(Number(plot.price ?? 0)), c: "#1a202c" },
                            { l: "Paid", v: fmtKESFull(Number(plot.paid_amount ?? 0)), c: "#22c55e" },
                            { l: "Balance", v: fmtKESFull(balance), c: balance > 0 ? "#ef4444" : "#22c55e" },
                          ].map(({ l, v, c }) => (
                            <div key={l} className="bg-gray-50 rounded-lg px-2 py-1.5 text-center">
                              <p className="text-[9px] text-gray-400">{l}</p>
                              <p className="text-[11px] font-bold" style={{ color: c }}>{v}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </SectionCard>
          )}

          {tab === "payments" && (
            <SectionCard title={`Payment History — ${payments.length}`}>
              {payments.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No payments recorded yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {payments.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold" style={{ color: "#1a202c" }}>{p.purpose}</p>
                        <p className="text-[10px] text-gray-400">{fmtDate(p.date_paid)} · {p.mode}</p>
                      </div>
                      <p className="text-xs font-bold text-teal-600">{fmtKESFull(Number(p.amount))}</p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}
        </>
      )}
    </PortalShell>
  );
}

// ─── Investor Portal ──────────────────────────────────────────────────────────

export function InvestorPortal({ profile, onLogout }: { profile: UserProfile; onLogout: () => void }) {
  const [member, setMember]     = useState<any>(null);
  const [investments, setInv]   = useState<any[]>([]);
  const [profits, setProfits]   = useState<any[]>([]);
  const [loading, setLoading]   = useState(true);
  const [tab, setTab]           = useState<"overview" | "investments" | "profits">("overview");

  const load = useCallback(async () => {
    if (!profile.member_id) return;
    setLoading(true);
    try {
      const [inv, invRes, profitRes] = await Promise.all([
        investorsApi.get(profile.member_id),
        supabase
          .from("project_investments")
          .select("*, project:projects(project_name)")
          .eq("investor_id", profile.member_id)
          .order("invested_at", { ascending: false }),
        supabase
          .from("profit_distributions")
          .select("*, project:projects(project_name)")
          .eq("investor_id", profile.member_id)
          .order("distributed_at", { ascending: false }),
      ]);
      setMember(inv);
      setInv(invRes.data ?? []);
      setProfits(profitRes.data ?? []);
    } catch { /* silent */ }
    finally { setLoading(false); }
  }, [profile.member_id]);

  useEffect(() => { load(); }, [load]);

  if (loading && !profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Investor Account" accentColor="#d97706"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-amber-400" />
        </div>
      </PortalShell>
    );
  }

  if (!profile.member_id) {
    return (
      <PortalShell title={profile.full_name || profile.email} subtitle="Investor Account" accentColor="#d97706"
        avatarContent={<User size={18} color="white" />} onLogout={onLogout}>
        <div className="bg-white rounded-2xl border p-8 text-center" style={{ borderColor: "var(--border)" }}>
          <p className="text-gray-500 text-sm">Account setup is still in progress.</p>
          <p className="text-gray-400 text-xs mt-1">Please sign out and sign in again. If the problem persists, contact your administrator.</p>
        </div>
      </PortalShell>
    );
  }

  const totalInvested = investments.reduce((s, i) => s + Number(i.amount ?? 0), 0);
  const totalProfits  = profits.reduce((s, p) => s + Number(p.amount ?? 0), 0);

  return (
    <PortalShell
      title={member?.name ?? profile.full_name ?? "Investor"}
      subtitle={`EW#${member?.member_number} · Investor Account`}
      accentColor="#b45309"
      avatarContent={<span className="text-white font-bold text-xs">{initials(member?.name ?? "IN")}</span>}
      onLogout={onLogout}
    >
      {loading ? (
        <div className="flex justify-center py-16"><Loader2 size={24} className="animate-spin text-amber-300" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <StatCard label="Total Invested" value={fmtKESFull(totalInvested)} icon={<CircleDollarSign size={18} />} color="#b45309" bg="#fffbeb" />
            <StatCard label="Total Profits" value={fmtKESFull(totalProfits)} icon={<TrendingUp size={18} />} color="#d97706" bg="#fef9c3" />
            <StatCard label="Projects" value={String(investments.length)} icon={<Building2 size={18} />} color="#22c55e" bg="#f0fdf4" />
            <StatCard label="Member Since" value={member?.joined_date ? fmtDate(member.joined_date) : "—"} icon={<Calendar size={18} />} color="#0d9488" bg="#f0fdfa" />
          </div>

          <div className="flex gap-1 bg-white rounded-2xl border p-1" style={{ borderColor: "var(--border)" }}>
            {([
              { id: "overview", label: "Profile" },
              { id: "investments", label: `Investments (${investments.length})` },
              { id: "profits", label: `Profits (${profits.length})` },
            ] as const).map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className="flex-1 py-2 rounded-xl text-xs font-bold transition-colors"
                style={{ background: tab === t.id ? "#b45309" : "transparent", color: tab === t.id ? "#fff" : "#64748b" }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === "overview" && (
            <>
              <SectionCard title="Profile">
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {[
                    { label: "Full Name",     value: member?.name },
                    { label: "Member No.",    value: `EW#${member?.member_number}` },
                    { label: "Phone",         value: member?.phone },
                    { label: "Email",         value: member?.email || "—" },
                    { label: "Status",        value: member?.status },
                    { label: "Joined",        value: member?.joined_date ? fmtDate(member.joined_date) : "—" },
                  ].map(({ label, value }) => (
                    <div key={label} className="px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs text-gray-400">{label}</span>
                      <span className="text-xs font-semibold" style={{ color: "#1a202c" }}>{value}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
              <SectionCard title="Financial Summary">
                <div className="p-4 space-y-3">
                  {[
                    { label: "Total Invested",  value: fmtKESFull(totalInvested), color: "#b45309" },
                    { label: "Profits Received", value: fmtKESFull(totalProfits), color: "#d97706" },
                    { label: "Net Return",       value: fmtKESFull(totalProfits - totalInvested), color: totalProfits >= totalInvested ? "#22c55e" : "#ef4444" },
                  ].map(({ label, value, color }) => (
                    <div key={label} className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-2.5">
                      <span className="text-xs text-gray-500">{label}</span>
                      <span className="text-xs font-bold" style={{ color }}>{value}</span>
                    </div>
                  ))}
                </div>
              </SectionCard>
            </>
          )}

          {tab === "investments" && (
            <SectionCard title={`Investments — Total: ${fmtKESFull(totalInvested)}`}>
              {investments.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No investments recorded yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {investments.map((inv) => (
                    <div key={inv.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold" style={{ color: "#1a202c" }}>{inv.project?.project_name ?? "Project"}</p>
                        <p className="text-[10px] text-gray-400">{fmtDate(inv.invested_at)}</p>
                        {inv.notes && <p className="text-[10px] text-gray-400">{inv.notes}</p>}
                      </div>
                      <p className="text-xs font-bold text-amber-700">{fmtKESFull(Number(inv.amount))}</p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}

          {tab === "profits" && (
            <SectionCard title={`Profit Distributions — Total: ${fmtKESFull(totalProfits)}`}>
              {profits.length === 0 ? (
                <p className="px-4 py-6 text-center text-xs text-gray-400">No profit distributions yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {profits.map((p) => (
                    <div key={p.id} className="px-4 py-2.5 flex items-center justify-between gap-3">
                      <div>
                        <p className="text-xs font-semibold" style={{ color: "#1a202c" }}>{p.project?.project_name ?? "Project"}</p>
                        <p className="text-[10px] text-gray-400">{fmtDate(p.distributed_at?.slice(0, 10))}</p>
                      </div>
                      <p className="text-xs font-bold text-amber-600">{fmtKESFull(Number(p.amount))}</p>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          )}
        </>
      )}
    </PortalShell>
  );
}
