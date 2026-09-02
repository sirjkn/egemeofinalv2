import React, { useState, useEffect, useCallback, useRef, useMemo, createContext, useContext } from "react";
import { createBrowserRouter, RouterProvider, useNavigate, useLocation } from "react-router";
import {
  LayoutDashboard, Users, UserCircle2, Link2, FolderOpen,
  CircleDollarSign, CreditCard, RotateCcw, BarChart2,
  SlidersHorizontal, HelpCircle, ChevronRight, Bell,
  CheckCircle2, Clock, MoreHorizontal, X, Plus, Search,
  Phone, Mail, Calendar, ChevronDown, ArrowLeft, AlertCircle,
  TrendingUp, BookOpen, MapPin, RefreshCw, Edit2, KeyRound, Trash2,
  Loader2, CreditCard as IdCard, Wallet, Camera, ImagePlus,
  Building2, FileSpreadsheet, Wrench, UploadCloud, Download,
  XCircle, CheckCircle, BellRing, Home, ClipboardPaste, FileDown, Filter, LogOut, Eye, Printer, List,
  ShieldAlert,
} from "lucide-react";
import {
  shareholdersApi, clientsApi, investorsApi, contributionsApi, refundsApi, paymentsApi,
  projectsApi, plotsApi, plotPaymentsApi, profitDistributionsApi, uploadPhoto, checkDbHealth,
  logActivity,
  type Shareholder, type Client, type Investor, type MemberPayload,
  type Contribution, type ContributionPayload, type ShareholderContributionSummary,
  type Refund, type Payment, type PaymentPayload, type ProfitDistribution,
  type Project, type Plot, type PlotAssignPayload, type PlotPayment,
  PAYMENT_PURPOSES, PAYMENT_MODES,
} from "@/lib/api";
import {
  downloadPaymentsPdf, downloadContributionsPdf, downloadRefundsPdf, downloadMembersPdf, downloadReportPdf,
  downloadMemberStatementPdf, downloadContributionHistoryPdf,
  parseMpesaMessage, type PaymentRow, type ContribRow, type StatementRow, type ProfitRow,
} from "@/lib/pdf";
import { getCompanyDetails } from "@/lib/company";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { supabase } from "@/lib/supabase";
import { ProjectsPage, AssignedPlotCard, PlotPaymentModal } from "@/app/pages/ProjectsPage";
import { ReportsPage } from "@/app/pages/ReportsPage";
import { SettingsPage, getPaymentRules, type PaymentRules } from "@/app/pages/SettingsPage";
import { THIS_YEAR, CY, YEAR_OPTS, MONTHS, CURRENT_YEAR, YEAR_RANGE, initials, fmtKES, fmtKESFull, fmtDate } from "@/app/shared";
import { sendSms, smsTemplates, SMS_TRIGGERS } from "@/lib/sms";
import { parseMpesaMessage as _parseMpesaMsg, getPaymentSettings } from "@/lib/mpesa";
import { getEnabledPaymentMethodKeys } from "@/lib/settingsApi";
import { toast, Toaster } from "sonner";
import { LoginPage, SetPasswordPage, fetchProfile, type UserProfile, phoneToEmail } from "@/app/pages/AuthPage";
import { ShareholderPortal, ClientPortal, InvestorPortal } from "@/app/pages/MemberPortal";
import {
  BarChart as RechartBarChart, Bar,
  AreaChart as RechartAreaChart, Area,
  PieChart as RechartPieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, LabelList,
} from "recharts";

// ─── Module type ──────────────────────────────────────────────────────────────

type Module =
  | "dashboard" | "shareholders" | "clients" | "contributions"
  | "projects" | "investors" | "payments" | "refunds"
  | "reports" | "settings" | "my-plots" | "help"
  | "mpesa-transactions";

type PreviewRole = "admin" | "shareholder" | "client";

// ─── Profile Context ──────────────────────────────────────────────────────────

const ProfileCtx = createContext<UserProfile | null>(null);
function useProfile() { return useContext(ProfileCtx); }
function useIsViewOnly() { const p = useProfile(); return !!p && p.role !== "admin"; }
function useCanMakePayment() { const p = useProfile(); return !!p && (p.role === "admin" || p.role === "reception"); }

// Billing cycle: day 1–10 → previous month's contribution period; day 11+ → current month
function getBillingPeriod(date: Date = new Date()): { month: number; year: number } {
  if (date.getDate() <= 10) {
    const prev = new Date(date.getFullYear(), date.getMonth() - 1, 1);
    return { month: prev.getMonth() + 1, year: prev.getFullYear() };
  }
  return { month: date.getMonth() + 1, year: date.getFullYear() };
}

// When an admin changes a member's phone number, sync the Supabase Auth email so
// the member can immediately log in with the new number.
async function syncAuthEmailOnPhoneChange(memberId: number, newPhone: string): Promise<void> {
  const newEmail = phoneToEmail(newPhone);
  // Find the auth user for this member
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("id, email")
    .eq("member_id", memberId)
    .maybeSingle();
  if (!profile) return; // no auth account yet — nothing to sync
  if (profile.email === newEmail) return; // phone didn't actually change
  // Call the Edge Function to update both the auth account email and user_profiles.email
  await supabase.functions.invoke("update-auth-email", {
    body: { userId: profile.id, newEmail },
  });
}

function PaymentRulesBanner() {
  return (
    <div className="rounded-xl p-3 flex items-start gap-2" style={{ background: "#eff6ff", border: "1px solid #bfdbfe" }}>
      <AlertCircle size={14} color="#3b82f6" className="mt-0.5 flex-shrink-0" />
      <div className="text-xs leading-relaxed" style={{ color: "#1e40af" }}>
        <span className="font-semibold">Deadline:</span> 10th of the following month (e.g. July payment → August 10th).
      </div>
    </div>
  );
}

function useSystemLive() {
  const [isLive, setIsLive] = useState<boolean | null>(null);
  useEffect(() => {
    supabase.from("app_settings").select("value").eq("key", "system_live").maybeSingle()
      .then(({ data }) => setIsLive(data?.value === true || data?.value === "true"));
  }, []);
  return isLive;
}

const ROLE_NAV: Record<string, Module[]> = {
  admin:       ["dashboard","shareholders","clients","contributions","projects","investors","payments","refunds","reports","mpesa-transactions","settings"],
  shareholder: ["dashboard","contributions","projects","my-plots","payments","settings"],
  client:      ["dashboard","my-plots","refunds","settings"],
  investor:    ["dashboard","projects","my-plots","settings"],
  reception:   ["dashboard","shareholders","clients","contributions","projects","investors","payments","refunds","reports","mpesa-transactions"],
};

// ─── Nav config ───────────────────────────────────────────────────────────────

interface NavItem { id: Module; label: string; icon: React.ReactNode; iconBg: string; hasChevron?: boolean }

// Modules that can never be hidden (admin always needs access)
const ALWAYS_VISIBLE: Module[] = ["dashboard", "settings"];
const HIDDEN_MODULES_KEY = "sacco_hidden_modules";
const VIEW_SETTINGS_KEY_PREFIX = "sacco_view_settings";

function hiddenModulesKeyForRole(role: string) {
  return role === "admin" ? HIDDEN_MODULES_KEY : `${HIDDEN_MODULES_KEY}_${role}`;
}

export function getHiddenModules(role = "admin"): Module[] {
  try { return JSON.parse(localStorage.getItem(hiddenModulesKeyForRole(role)) ?? "[]"); } catch { return []; }
}
export function setHiddenModules(ids: Module[], role = "admin") {
  localStorage.setItem(hiddenModulesKeyForRole(role), JSON.stringify(ids));
  window.dispatchEvent(new Event("hidden-modules-changed"));
}

function useHiddenModules(role = "admin") {
  const [hidden, setHidden] = useState<Module[]>(() => getHiddenModules(role));
  useEffect(() => {
    const handler = () => setHidden(getHiddenModules(role));
    window.addEventListener("hidden-modules-changed", handler);
    return () => window.removeEventListener("hidden-modules-changed", handler);
  }, [role]);
  return hidden;
}

function getViewSettings(role: string): string[] {
  try { return JSON.parse(localStorage.getItem(`${VIEW_SETTINGS_KEY_PREFIX}_${role}`) ?? "[]"); } catch { return []; }
}
export function useViewSettings(role: string) {
  const [hidden, setHidden] = useState<string[]>(() => getViewSettings(role));
  useEffect(() => {
    const handler = () => setHidden(getViewSettings(role));
    window.addEventListener("view-settings-changed", handler);
    return () => window.removeEventListener("view-settings-changed", handler);
  }, [role]);
  return (id: string) => hidden.includes(id);
}

// Sync module visibility + view settings from Supabase into localStorage on startup
const ROLES_TO_SYNC = ["admin", "shareholder", "client", "investor"];
export async function syncVisibilitySettingsFromCloud() {
  const [modRow, viewRow] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "module_visibility").maybeSingle(),
    supabase.from("app_settings").select("value").eq("key", "view_settings").maybeSingle(),
  ]);
  if (modRow.data?.value) {
    const map = modRow.data.value as Record<string, string[]>;
    ROLES_TO_SYNC.forEach((r) => {
      if (Array.isArray(map[r])) {
        localStorage.setItem(r === "admin" ? HIDDEN_MODULES_KEY : `${HIDDEN_MODULES_KEY}_${r}`, JSON.stringify(map[r]));
      }
    });
    window.dispatchEvent(new Event("hidden-modules-changed"));
  }
  if (viewRow.data?.value) {
    const map = viewRow.data.value as Record<string, string[]>;
    ROLES_TO_SYNC.forEach((r) => {
      if (Array.isArray(map[r])) {
        localStorage.setItem(`${VIEW_SETTINGS_KEY_PREFIX}_${r}`, JSON.stringify(map[r]));
      }
    });
    window.dispatchEvent(new Event("view-settings-changed"));
  }
}

const navItems: NavItem[] = [
  { id: "dashboard",    label: "Dashboard",      icon: <LayoutDashboard size={19} color="#fff" />,   iconBg: "#f97316" },
  { id: "shareholders", label: "Shareholders",   icon: <Users size={19} color="#fff" />,             iconBg: "#6366f1" },
  { id: "clients",      label: "Clients",        icon: <UserCircle2 size={19} color="#fff" />,       iconBg: "#a855f7" },
  { id: "contributions",label: "Contributions",  icon: <Link2 size={19} color="#fff" />,             iconBg: "#ec4899", hasChevron: true },
  { id: "projects",     label: "Projects",       icon: <FolderOpen size={19} color="#fff" />,        iconBg: "#22c55e" },
  { id: "investors",    label: "Ext. Investors", icon: <CircleDollarSign size={19} color="#fff" />,  iconBg: "#eab308" },
  { id: "payments",           label: "Payments",             icon: <CreditCard size={19} color="#fff" />,        iconBg: "#14b8a6" },
  { id: "mpesa-transactions", label: "M-Pesa Transactions", icon: <RefreshCw size={19} color="#fff" />,        iconBg: "#0ea5e9" },
  { id: "refunds",            label: "Refunds",             icon: <RotateCcw size={19} color="#fff" />,        iconBg: "#ef4444" },
  { id: "reports",      label: "Reports",        icon: <BarChart2 size={19} color="#fff" />,         iconBg: "#3b82f6", hasChevron: true },
  { id: "settings",     label: "Settings",       icon: <SlidersHorizontal size={19} color="#fff" />, iconBg: "#64748b", hasChevron: true },
  { id: "my-plots",     label: "My Plots",       icon: <MapPin size={19} color="#fff" />,            iconBg: "#059669" },
  { id: "help",         label: "Help & Support", icon: <HelpCircle size={19} color="#fff" />,        iconBg: "#8b5cf6" },
];

// ─── Shared: Member Avatar ────────────────────────────────────────────────────

function MemberAvatar({
  photoUrl, name, color, size = 40, rounded = "rounded-xl",
}: { photoUrl?: string | null; name: string; color: string; size?: number; rounded?: string }) {
  return (
    <div
      className={`${rounded} overflow-hidden flex items-center justify-center flex-shrink-0`}
      style={{ width: size, height: size, background: color }}>
      {photoUrl
        ? <img src={photoUrl} alt={name} className="w-full h-full object-cover" />
        : <UserCircle2 size={Math.round(size * 0.6)} color="rgba(255,255,255,0.9)" strokeWidth={1.5} />}
    </div>
  );
}

// ─── Shared: Member Form Modal (Add + Edit) ───────────────────────────────────

interface MemberFormModalProps {
  title: string;
  accentColor: string;
  initial?: Partial<MemberPayload & { id: number }>;
  onClose: () => void;
  onSave: (payload: MemberPayload) => Promise<void>;
}

function MemberFormModal({ title, accentColor, initial, onClose, onSave }: MemberFormModalProps) {
  const isEdit = !!initial?.id;
  const memberNumLabel = title === "Shareholder" ? "Shareholder No." : title === "Client" ? "Client No." : "Investor No.";

  const [form, setForm] = useState<MemberPayload & { status: "Active" | "Inactive" }>({
    name: initial?.name ?? "",
    phone: initial?.phone ?? "",
    email: initial?.email ?? "",
    id_passport: initial?.id_passport ?? "",
    joined_date: initial?.joined_date ?? new Date().toISOString().slice(0, 10),
    status: (initial?.status as "Active" | "Inactive") ?? "Active",
    photo_url: initial?.photo_url ?? undefined,
    member_number: initial?.member_number ?? undefined,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | null>(initial?.photo_url ?? null);
  const [photoUploading, setPhotoUploading] = useState(false);

  const set = (k: string, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    setErrors((e) => { const n = { ...e }; delete n[k]; return n; });
  };

  const handlePhotoFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const preview = URL.createObjectURL(file);
    setPhotoPreview(preview);
    setPhotoUploading(true);
    try {
      const url = await uploadPhoto(file);
      setForm((f) => ({ ...f, photo_url: url }));
    } catch {
      setErrors((e) => ({ ...e, photo: "Upload failed — try again" }));
    } finally {
      setPhotoUploading(false);
    }
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.name.trim()) e.name = "Full name is required";
    if (!form.phone.trim()) e.phone = "Phone number is required";
    else if (!/^(0[0-9]{9}|\+?254[0-9]{9})$/.test(form.phone.trim().replace(/[\s\-()]/g, ""))) e.phone = "Enter a valid phone number (e.g. 0712345678 or +254712345678)";
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Invalid email";
    return e;
  };

  const submit = async () => {
    const e = validate();
    if (Object.keys(e).length) { setErrors(e); return; }
    setSaving(true);
    try {
      await onSave({ ...form });
      onClose();
    } catch (err: any) {
      setErrors({ phone: err.message });
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof typeof form, opts?: { placeholder?: string; type?: string }) => (
    <div>
      <label className="text-xs font-semibold text-gray-500 mb-1 block">{label}</label>
      <input
        type={opts?.type ?? "text"}
        value={(form[key] as string) ?? ""}
        onChange={(e) => set(key, e.target.value)}
        placeholder={opts?.placeholder}
        className="w-full px-3 py-2.5 rounded-lg text-sm border outline-none transition-colors"
        style={{ borderColor: errors[key] ? "#ef4444" : "var(--border)", background: "#f8fafc" }}
      />
      {errors[key] && <p className="text-xs text-red-500 mt-1">{errors[key]}</p>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b sticky top-0 bg-white z-10" style={{ borderColor: "var(--card-border)" }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>{isEdit ? `Edit ${title}` : `Add ${title}`}</h2>
            <p className="text-xs text-gray-400 mt-0.5">Phone number is the unique login ID</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100 text-gray-400"><X size={16} /></button>
        </div>

        <div className="px-6 py-5 space-y-4">
          {/* Photo upload */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-2 block">Photo</label>
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-xl overflow-hidden flex-shrink-0 flex items-center justify-center border" style={{ borderColor: "var(--border)", background: "#f8fafc" }}>
                {photoPreview ? (
                  <img src={photoPreview} alt="preview" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-gray-300"><ImagePlus size={24} /></span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity" style={{ background: `${accentColor}18`, color: accentColor }}>
                  <ImagePlus size={13} />
                  Upload Photo
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoFile(f); e.target.value = ""; }} />
                </label>
                <label className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity" style={{ background: "#f0fdf4", color: "#22c55e" }}>
                  <Camera size={13} />
                  Take Photo
                  <input type="file" accept="image/*" capture="user" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePhotoFile(f); e.target.value = ""; }} />
                </label>
              </div>
              {photoUploading && <Loader2 size={16} className="animate-spin text-gray-400" />}
            </div>
            {errors.photo && <p className="text-xs text-red-500 mt-1">{errors.photo}</p>}
          </div>

          {field("Full Name *", "name", { placeholder: "e.g. Jane Wanjiku" })}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1 block">{memberNumLabel}</label>
              <input
                type={title === "Client" ? "text" : "number"}
                min={title === "Client" ? undefined : 1}
                value={form.member_number ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setForm((f) => ({
                    ...f,
                    member_number: title === "Client"
                      ? (v || undefined)
                      : (v ? parseInt(v) : undefined),
                  }));
                }}
                placeholder={title === "Client" ? "e.g. EC001" : "Auto-assigned"}
                className="w-full px-3 py-2.5 rounded-lg text-sm border outline-none"
                style={{ borderColor: "var(--border)", background: "#f8fafc" }}
              />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1 block">Status</label>
              <select
                value={form.status} onChange={(e) => set("status", e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg text-sm border outline-none"
                style={{ borderColor: "var(--border)", background: "#f8fafc" }}
              >
                <option>Active</option>
                <option>Inactive</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">
              Phone Number * <span className="font-normal" style={{ color: accentColor }}>(Login ID — unique across all members)</span>
            </label>
            <input
              value={form.phone} onChange={(e) => set("phone", e.target.value)}
              placeholder="07XXXXXXXX"
              className="w-full px-3 py-2.5 rounded-lg text-sm border outline-none"
              style={{ borderColor: errors.phone ? "#ef4444" : "var(--border)", background: "#f8fafc" }}
            />
            {errors.phone && <p className="text-xs text-red-500 mt-1">{errors.phone}</p>}
          </div>

          <div className="grid grid-cols-2 gap-3">
            {field("Email", "email", { placeholder: "email@example.com" })}
            {field("ID / Passport", "id_passport", { placeholder: "National ID or Passport" })}
          </div>

          {field("Joined Date", "joined_date", { type: "date" })}
        </div>

        <div className="flex gap-3 px-6 pb-5">
          <button onClick={onClose} disabled={saving} className="flex-1 py-2.5 rounded-lg text-sm font-semibold border" style={{ borderColor: "var(--border)", color: "#64748b" }}>
            Cancel
          </button>
          <button onClick={submit} disabled={saving || photoUploading} className="flex-1 py-2.5 rounded-lg text-sm font-semibold text-white flex items-center justify-center gap-2 disabled:opacity-60" style={{ background: accentColor }}>
            {saving && <Loader2 size={14} className="animate-spin" />}
            {saving ? "Saving…" : isEdit ? "Save Changes" : `Add ${title}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Shared: Accordion ───────────────────────────────────────────────────────

// ─── Shareholder: Contributions Accordion ────────────────────────────────────
function ContribMethodLabel({ notes }: { notes: string | null }) {
  const raw = notes ?? "";
  // Try JSON notes first (recorded via modal: {method, ref, ...})
  let method = "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.method) method = String(parsed.method).toLowerCase();
  } catch { /* not JSON */ }
  if (!method) {
    const n = raw.toLowerCase();
    if (n.includes("mpesa") || n.includes("m-pesa")) method = "mpesa";
    else if (n.includes("cash")) method = "cash";
    else if (n.includes("bank")) method = "bank";
    else if (n.includes("cheque") || n.includes("check")) method = "cheque";
    else if (n.includes("uploaded payment")) method = "uploaded";
    else {
      const via = raw.match(/via\s+(\S+)/i);
      if (via) method = via[1].toLowerCase();
    }
  }
  const META: Record<string, { label: string; icon: string; color: string; bg: string }> = {
    mpesa:    { label: "M-Pesa",   icon: "📱", color: "#15803d", bg: "#dcfce7" },
    cash:     { label: "Cash",     icon: "💵", color: "#1d4ed8", bg: "#dbeafe" },
    bank:     { label: "Bank",     icon: "🏦", color: "#2563eb", bg: "#eff6ff" },
    cheque:   { label: "Cheque",   icon: "📝", color: "#7c3aed", bg: "#f5f3ff" },
    uploaded: { label: "Uploaded", icon: "📤", color: "#0369a1", bg: "#e0f2fe" },
  };
  const m = META[method];
  if (m) return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold whitespace-nowrap"
      style={{ background: m.bg, color: m.color }}>
      {m.icon} {m.label}
    </span>
  );
  return <span className="text-gray-400 text-[10px]">{raw ? raw.slice(0, 20) : "—"}</span>;
}

/** Extracts the human-readable payment method label from notes (JSON or plain text). */
function parseContribMethod(notes: string | null): string {
  const raw = notes ?? "";
  let key = "";
  try { const p = JSON.parse(raw); key = String(p.method || "").toLowerCase(); } catch {}
  if (!key) {
    const n = raw.toLowerCase();
    if (n.includes("mpesa") || n.includes("m-pesa")) key = "mpesa";
    else if (n.includes("cash")) key = "cash";
    else if (n.includes("bank")) key = "bank";
    else if (n.includes("cheque") || n.includes("check")) key = "cheque";
    else if (n.includes("uploaded")) key = "uploaded";
  }
  const labels: Record<string, string> = { mpesa: "M-Pesa", cash: "Cash", bank: "Bank", cheque: "Cheque", uploaded: "Uploaded" };
  return labels[key] || key;
}

/** Extracts the plain-text comment from notes (strips JSON envelope if present). */
function parseContribComment(notes: string | null): string {
  if (!notes) return "";
  try { const p = JSON.parse(notes); return String(p.note || p.notes || ""); } catch {}
  return notes;
}

/** Converts raw profit distribution records to ProfitRow[], optionally filtered by year/month. */
function buildProfitRows(
  dists: (ProfitDistribution & { project?: any })[],
  yearFilter?: number | "all",
  monthFilter?: number | "all",
): ProfitRow[] {
  return dists
    .filter((d) => {
      if (!d.distributed_at) return false;
      const dt = new Date(d.distributed_at);
      if (yearFilter && yearFilter !== "all" && dt.getFullYear() !== yearFilter) return false;
      if (monthFilter && monthFilter !== "all" && dt.getMonth() + 1 !== monthFilter) return false;
      return true;
    })
    .sort((a, b) => String(a.distributed_at).localeCompare(String(b.distributed_at)))
    .map((d) => ({
      date: new Date(d.distributed_at!).toLocaleDateString("en-US", { month: "long", year: "numeric" }),
      project: d.project?.project_name ?? "—",
      amount: Number(d.amount),
    }));
}

function ShareholderContributionsAccordion({ shareholder, onChanged }: {
  shareholder: Shareholder;
  onChanged?: () => void;
}) {
  const profile = useProfile();
  const isAdmin = profile?.role === "admin";
  const [contribs, setContribs] = useState<Contribution[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewC, setViewC] = useState<Contribution | null>(null);
  const [viewMulti, setViewMulti] = useState<Contribution[] | null>(null);
  const [editC, setEditC] = useState<Contribution | null>(null);
  const [deleteC, setDeleteC] = useState<Contribution | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [profitDists, setProfitDists] = useState<(ProfitDistribution & { project?: any })[]>([]);

  const reload = useCallback(() => {
    setLoading(true);
    contributionsApi.listByShareholder(shareholder.id)
      .then(setContribs).catch(() => setContribs([]))
      .finally(() => setLoading(false));
  }, [shareholder.id]);

  useEffect(() => { reload(); }, [reload]);

  useEffect(() => {
    profitDistributionsApi.listByShareholder(shareholder.id)
      .then(setProfitDists).catch(() => {});
  }, [shareholder.id]);

  const total = contribs.reduce((s, c) => s + Number(c.amount), 0);
  const meta = loading ? "…" : `${contribs.length} record${contribs.length !== 1 ? "s" : ""}`;

  // Group by month+year; each group sorted by payment_date desc
  const grouped = useMemo(() => {
    const map = new Map<string, { key: string; month: number; year: number; items: Contribution[] }>();
    const order: string[] = [];
    [...contribs]
      .sort((a, b) => b.year - a.year || b.month - a.month || (b.payment_date ?? "").localeCompare(a.payment_date ?? ""))
      .forEach((c) => {
        const k = `${c.year}-${c.month}`;
        if (!map.has(k)) { map.set(k, { key: k, month: c.month, year: c.year, items: [] }); order.push(k); }
        map.get(k)!.items.push(c);
      });
    return order.map((k) => map.get(k)!);
  }, [contribs]);

  const printReceipt = async (c: Contribution) => {
    // jsPDF imported statically at top of file
    const co = await getCompanyDetails();
    const doc = new jsPDF({ unit: "mm", format: [80, 120] });
    const w = 80;
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(30, 45, 74);
    doc.text(co.name || "SACCO", w / 2, 12, { align: "center" });
    doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(100, 100, 100);
    doc.text("Contribution Receipt", w / 2, 18, { align: "center" });
    doc.setDrawColor(200, 200, 200); doc.setLineWidth(0.3); doc.line(5, 21, w - 5, 21);
    const rows: [string, string][] = [
      ["Member", shareholder.name],
      ["Member No.", `EW#${shareholder.member_number}`],
      ["Period", `${MONTHS[c.month - 1]} ${c.year}`],
      ["Date Paid", c.payment_date ? fmtDate(c.payment_date) : "—"],
      ["Amount", fmtKESFull(Number(c.amount))],
      ["Status", c.status === "late" ? "Late" : "On Time"],
      ["Method", c.notes || "—"],
      ["Printed", new Date().toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })],
    ];
    let y = 28;
    rows.forEach(([label, val]) => {
      doc.setFont("helvetica", "bold"); doc.setFontSize(7); doc.setTextColor(120, 120, 120);
      doc.text(label, 6, y);
      doc.setFont("helvetica", "normal"); doc.setTextColor(30, 30, 30);
      doc.text(String(val), w - 6, y, { align: "right" });
      y += 7.5;
    });
    doc.setDrawColor(200, 200, 200); doc.line(5, y, w - 5, y); y += 6;
    doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(22, 163, 74);
    doc.text(fmtKESFull(Number(c.amount)), w / 2, y, { align: "center" }); y += 6;
    doc.setFont("helvetica", "normal"); doc.setFontSize(6.5); doc.setTextColor(160, 160, 160);
    doc.text("Thank you for your contribution.", w / 2, y + 2, { align: "center" });
    doc.save(`receipt-EW${shareholder.member_number}-${MONTHS[c.month - 1]}-${c.year}.pdf`);
  };

  // ── Edit form state lives inside a sub-component to keep this one clean
  return (
    <>
    <Accordion icon={<CreditCard size={16} />} label="Contributions / Payments" meta={meta} color="#6366f1">
      {loading ? (
        <div className="flex justify-center py-3"><Loader2 size={14} className="animate-spin text-gray-300" /></div>
      ) : contribs.length === 0 ? (
        <p className="py-2 text-xs text-gray-400">No contributions recorded yet.</p>
      ) : (
        <>
          {/* Export PDF toolbar */}
          <div className="flex justify-end mb-2 -mt-1">
            <button
              onClick={async () => {
                const co = await getCompanyDetails();
                const rows = contribs
                  .slice()
                  .sort((a, b) => b.year - a.year || b.month - a.month)
                  .map((c) => ({
                    month: `${MONTHS[c.month - 1]} ${c.year}`,
                    date_paid: c.payment_date ? fmtDate(c.payment_date) : "",
                    amount: Number(c.amount),
                    method: parseContribMethod(c.notes),
                    status: c.status === "late" ? "Late" : "On time",
                    notes: parseContribComment(c.notes),
                  }));
                const nsVal = shareholder.net_savings != null ? Math.max(0, Number(shareholder.net_savings)) : undefined;
                await downloadContributionHistoryPdf(
                  shareholder.name,
                  `EW#${shareholder.member_number}`,
                  rows,
                  co,
                  nsVal,
                  buildProfitRows(profitDists),
                );
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80"
              style={{ background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0" }}>
              <FileDown size={12} /> Export PDF
            </button>
          </div>
          <div className="overflow-x-auto -mx-4">
          <table className="w-full text-xs">
            <thead><tr style={{ background: "#1e3a5f" }}>
              {["Month", "Date Paid", "Amount", "PmtMethod", "Status", "Comments", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-white whitespace-nowrap">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {grouped.map((g, i) => {
                const isMulti = g.items.length > 1;
                const c = g.items[0];
                const groupTotal = g.items.reduce((s, x) => s + Number(x.amount), 0);
                const rowBg = i % 2 === 0 ? "#fff" : "#dbeafe";

                if (isMulti) {
                  return (
                    <tr key={g.key} className="border-t" style={{ borderColor: "var(--border)", background: rowBg }}>
                      <td className="px-3 py-1.5 font-semibold whitespace-nowrap" style={{ color: "#1a202c" }}>{MONTHS[g.month - 1]} {g.year}</td>
                      <td className="px-3 py-1.5">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-50 text-indigo-600">
                          {g.items.length} payments
                        </span>
                      </td>
                      <td className="px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: "#22c55e" }}>{fmtKESFull(groupTotal)}</td>
                      <td className="px-3 py-1.5"><span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-50 text-violet-600">Multiple</span></td>
                      <td className="px-3 py-1.5">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-50 text-violet-600">Multiple</span>
                      </td>
                      <td className="px-3 py-1.5 text-left"><span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-violet-50 text-violet-600">Multiple</span></td>
                      <td className="px-3 py-1.5">
                        <button onClick={() => setViewMulti(g.items)} title="View all"
                          className="p-1 rounded hover:bg-indigo-50 text-indigo-400 hover:text-indigo-600 transition-colors">
                          <Eye size={12} />
                        </button>
                      </td>
                    </tr>
                  );
                }

                const isLateRow = c.status === "late" || (c.payment_date ? new Date(c.payment_date) > new Date(c.year, c.month, 10) : false);
                return (
                  <tr key={c.id} className="border-t" style={{ borderColor: "var(--border)", background: rowBg }}>
                    <td className="px-3 py-1.5 font-semibold whitespace-nowrap" style={{ color: "#1a202c" }}>{MONTHS[c.month - 1]} {c.year}</td>
                    <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{c.payment_date ? fmtDate(c.payment_date) : "—"}</td>
                    <td className="px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: "#22c55e" }}>{fmtKESFull(Number(c.amount))}</td>
                    <td className="px-3 py-1.5"><ContribMethodLabel notes={c.notes} /></td>
                    <td className="px-3 py-1.5">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${isLateRow ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"}`}>
                        {isLateRow ? "Late" : "On time"}
                      </span>
                    </td>
                    <td className="px-3 py-1.5 text-[10px] text-gray-500 max-w-[160px]">
                      <span className="block truncate" title={parseContribComment(c.notes) || c.notes || ""}>{parseContribComment(c.notes) || "—"}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      <div className="flex items-center gap-1">
                        <button onClick={() => setViewC(c)} title="View"
                          className="p-1 rounded hover:bg-indigo-50 text-indigo-300 hover:text-indigo-600 transition-colors">
                          <Eye size={12} />
                        </button>
                        {isAdmin && <button onClick={() => setEditC(c)} title="Edit"
                          className="p-1 rounded hover:bg-amber-50 text-amber-300 hover:text-amber-600 transition-colors">
                          <Edit2 size={12} />
                        </button>}
                        {isAdmin && <button onClick={() => setDeleteC(c)} title="Delete"
                          className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors">
                          <Trash2 size={12} />
                        </button>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr style={{ background: "#1e3a5f" }}>
              <td colSpan={2} className="px-3 py-1.5 text-xs font-bold text-white uppercase">Total</td>
              <td className="px-3 py-1.5 font-bold text-white">{fmtKESFull(total)}</td>
              <td colSpan={4} />
            </tr></tfoot>
          </table>
          </div>
        </>
      )}
    </Accordion>

    {/* ── View / Receipt modal ── */}
    {viewC && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={(e) => { if (e.target === e.currentTarget) setViewC(null); }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#eef2ff", borderColor: "#c7d2fe" }}>
            <div>
              <p className="font-bold text-sm" style={{ color: "#3730a3" }}>Contribution Details</p>
              <p className="text-xs" style={{ color: "#6366f1" }}>{MONTHS[viewC.month - 1]} {viewC.year}</p>
            </div>
            <button onClick={() => setViewC(null)} className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-400"><X size={15} /></button>
          </div>
          <div className="px-5 py-4 space-y-2.5">
            {([
              ["Member", shareholder.name],
              ["Member No.", `EW#${shareholder.member_number}`],
              ["Period", `${MONTHS[viewC.month - 1]} ${viewC.year}`],
              ["Date Paid", viewC.payment_date ? fmtDate(viewC.payment_date) : "—"],
              ["Amount", fmtKESFull(Number(viewC.amount))],
              ["Status", viewC.status === "late" ? "Late" : "On Time"],
              ["Method / Notes", viewC.notes || "—"],
            ] as [string, string][]).map(([label, val]) => (
              <div key={label} className="flex items-start justify-between gap-3">
                <span className="text-xs text-gray-400 flex-shrink-0 w-28">{label}</span>
                <span className="text-xs font-semibold text-right" style={{ color: label === "Amount" ? "#16a34a" : "#1a202c" }}>{val}</span>
              </div>
            ))}
          </div>
          <div className="px-5 pb-5 flex gap-2">
            <button onClick={() => setViewC(null)}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Close</button>
            <button onClick={() => printReceipt(viewC)}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-1.5"
              style={{ background: "#6366f1" }}>
              <Printer size={13} /> Print Receipt
            </button>
          </div>
        </div>
      </div>
    )}

    {/* ── Multi-payment month drill-down modal ── */}
    {viewMulti && viewMulti.length > 0 && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={(e) => { if (e.target === e.currentTarget) setViewMulti(null); }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#eef2ff", borderColor: "#c7d2fe" }}>
            <div>
              <p className="font-bold text-sm" style={{ color: "#3730a3" }}>
                {MONTHS[viewMulti[0].month - 1]} {viewMulti[0].year} — {viewMulti.length} Payments
              </p>
              <p className="text-xs" style={{ color: "#6366f1" }}>
                Total: <strong>{fmtKESFull(viewMulti.reduce((s, x) => s + Number(x.amount), 0))}</strong>
              </p>
            </div>
            <button onClick={() => setViewMulti(null)} className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-400"><X size={15} /></button>
          </div>
          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="w-full text-xs">
              <thead><tr style={{ background: "#1e3a5f" }}>
                {["Date Paid", "Amount", "Status", "Method", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-semibold text-white whitespace-nowrap">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {viewMulti.map((c, i) => {
                  return (
                    <tr key={c.id} className="border-t" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{c.payment_date ? fmtDate(c.payment_date) : "—"}</td>
                      <td className="px-3 py-1.5 font-bold whitespace-nowrap" style={{ color: "#22c55e" }}>{fmtKESFull(Number(c.amount))}</td>
                      <td className="px-3 py-1.5">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${c.status === "late" ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"}`}>
                          {c.status === "late" ? "Late" : "On time"}
                        </span>
                      </td>
                      <td className="px-3 py-1.5 text-left"><ContribMethodLabel notes={c.notes} /></td>
                      <td className="px-3 py-1.5">
                        <div className="flex items-center gap-1">
                          <button onClick={() => { setViewMulti(null); setViewC(c); }} title="View"
                            className="p-1 rounded hover:bg-indigo-50 text-indigo-300 hover:text-indigo-600 transition-colors">
                            <Eye size={12} />
                          </button>
                          {isAdmin && <button onClick={() => { setViewMulti(null); setEditC(c); }} title="Edit"
                            className="p-1 rounded hover:bg-amber-50 text-amber-300 hover:text-amber-600 transition-colors">
                            <Edit2 size={12} />
                          </button>}
                          {isAdmin && <button onClick={() => { setViewMulti(null); setDeleteC(c); }} title="Delete"
                            className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors">
                            <Trash2 size={12} />
                          </button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot><tr style={{ background: "#1e3a5f" }}>
                <td className="px-3 py-1.5 text-xs font-bold text-white uppercase">Total</td>
                <td className="px-3 py-1.5 font-bold text-white whitespace-nowrap">{fmtKESFull(viewMulti.reduce((s, x) => s + Number(x.amount), 0))}</td>
                <td colSpan={4} />
              </tr></tfoot>
            </table>
          </div>
          <div className="px-5 py-3 border-t" style={{ borderColor: "var(--border)" }}>
            <button onClick={() => setViewMulti(null)}
              className="w-full py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Close</button>
          </div>
        </div>
      </div>
    )}

    {/* ── Edit modal ── */}
    {editC && (
      <ContribEditModal
        contrib={editC}
        onClose={() => setEditC(null)}
        onSave={async (patch) => {
          await contributionsApi.update(editC.id, patch);
          logActivity({ category: "contribution", action: "update", description: `Contribution #${editC.id} updated for ${shareholder.name}`, actor_name: shareholder.name, meta: { id: editC.id } });
          setEditC(null);
          reload();
          onChanged?.();
          toast.success("Contribution updated");
        }}
      />
    )}

    {/* ── Delete confirm ── */}
    {deleteC && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
          <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
            <p className="font-bold text-sm text-red-600">Delete Contribution?</p>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-sm text-gray-600">
              Delete <strong>{MONTHS[deleteC.month - 1]} {deleteC.year}</strong> — <strong className="text-green-700">{fmtKESFull(Number(deleteC.amount))}</strong> for <strong>{shareholder.name}</strong>?
              {" "}Net savings will be reduced accordingly.
            </p>
            <div className="flex gap-2">
              <button onClick={() => setDeleteC(null)} disabled={deleting}
                className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                style={{ borderColor: "var(--border)" }}>Cancel</button>
              <button disabled={deleting} onClick={async () => {
                setDeleting(true);
                try {
                  await contributionsApi.remove(deleteC.id);
                  logActivity({ category: "contribution", action: "delete", description: `Contribution #${deleteC.id} deleted for ${shareholder.name}`, actor_name: shareholder.name, meta: { id: deleteC.id } });
                  setDeleteC(null);
                  reload();
                  onChanged?.();
                  toast.success("Contribution deleted");
                } catch (e: any) { toast.error(e.message); }
                finally { setDeleting(false); }
              }}
                className="flex-1 py-2.5 rounded-xl font-bold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                style={{ background: "#ef4444" }}>
                {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
              </button>
            </div>
          </div>
        </div>
      </div>
    )}

    </>
  );
}

function ContribEditModal({ contrib, onClose, onSave }: {
  contrib: Contribution;
  onClose: () => void;
  onSave: (patch: Partial<ContributionPayload>) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(contrib.amount));
  const [payDate, setPayDate] = useState(contrib.payment_date?.slice(0, 10) ?? "");
  const [status, setStatus] = useState<"paid" | "late">(contrib.status);
  const [notes, setNotes] = useState(contrib.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200";

  const handleSave = async () => {
    if (amount === "" || isNaN(Number(amount)) || Number(amount) < 0) { setErr("Enter a valid amount"); return; }
    setSaving(true); setErr("");
    try {
      await onSave({ amount: Number(amount), payment_date: payDate || undefined, status, notes: notes || undefined });
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#eef2ff", borderColor: "#c7d2fe" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#3730a3" }}>Edit Contribution</p>
            <p className="text-xs" style={{ color: "#6366f1" }}>{MONTHS[contrib.month - 1]} {contrib.year}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-400"><X size={15} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Amount (KES)</label>
            <input type="number" min="1" className={inp} style={{ borderColor: "var(--border)" }}
              value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Date Paid</label>
            <input type="date" className={inp} style={{ borderColor: "var(--border)" }}
              value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Status</label>
            <select className={inp} style={{ borderColor: "var(--border)" }}
              value={status} onChange={(e) => setStatus(e.target.value as "paid" | "late")}>
              <option value="paid">On Time</option>
              <option value="late">Late</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 block mb-1">Notes / Method</label>
            <input className={inp} style={{ borderColor: "var(--border)" }}
              value={notes} onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. M-Pesa, Bank transfer…" />
          </div>
          {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: "#6366f1" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Shareholder: Enrolled Projects Accordion ────────────────────────────────
function ShareholderProjectsAccordion({ shareholderId }: { shareholderId: number }) {
  const [enrollments, setEnrollments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    projectsApi.getEnrolledByShareholder(shareholderId)
      .then(setEnrollments)
      .catch(() => setEnrollments([]))
      .finally(() => setLoading(false));
  }, [shareholderId]);

  const count = loading ? "…" : `${enrollments.length} project${enrollments.length !== 1 ? "s" : ""}`;

  return (
    <Accordion icon={<BookOpen size={16} />} label="Enrolled Projects" meta={count} color="#f97316">
      {loading ? (
        <div className="flex justify-center py-3"><Loader2 size={14} className="animate-spin text-gray-300" /></div>
      ) : enrollments.length === 0 ? (
        <p className="py-2 text-xs text-gray-400">Not enrolled in any projects yet.</p>
      ) : (
        <div className="space-y-2 pt-1">
          {enrollments.map((e) => (
            <div key={e.id} className="flex items-center justify-between px-3 py-2 rounded-xl" style={{ background: "#fff7ed", border: "1px solid #fed7aa" }}>
              <div>
                <p className="text-xs font-bold" style={{ color: "#ea580c" }}>{e.project?.project_name ?? "—"}</p>
                <p className="text-[10px] text-gray-400">{e.project?.location ?? ""}</p>
              </div>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-orange-50 text-orange-600">
                {e.project?.number_of_plots ?? 0} plots
              </span>
            </div>
          ))}
        </div>
      )}
    </Accordion>
  );
}

// ─── Shareholder: Profits Accordion ──────────────────────────────────────────
function ShareholderProfitsAccordion({ shareholderId, onTotalLoaded }: { shareholderId: number; onTotalLoaded?: (t: number) => void }) {
  const [dists, setDists] = useState<(ProfitDistribution & { project?: Project })[]>([]);
  const [loading, setLoading] = useState(true);
  const [editDist, setEditDist] = useState<ProfitDistribution | null>(null);

  const reload = useCallback(() => {
    profitDistributionsApi.listByShareholder(shareholderId)
      .then((data) => {
        setDists(data);
        const sum = data.reduce((s, d) => s + Number(d.amount), 0);
        onTotalLoaded?.(sum);
      })
      .catch(() => setDists([]))
      .finally(() => setLoading(false));
  }, [shareholderId, onTotalLoaded]);

  useEffect(() => { reload(); }, [reload]);

  const total = dists.reduce((s, d) => s + Number(d.amount), 0);
  const meta = loading ? "…" : fmtKES(total);

  return (
    <>
    <Accordion icon={<TrendingUp size={16} />} label="Profits" meta={meta} color="#22c55e">
      {loading ? (
        <div className="flex justify-center py-3"><Loader2 size={14} className="animate-spin text-gray-300" /></div>
      ) : dists.length === 0 ? (
        <p className="py-2 text-xs text-gray-400">No profit distributions yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr style={{ background: "#1e3a5f" }}>
              {["Project", "Amount", "Date", "Notes", ""].map((h) => (
                <th key={h} className="px-3 py-2 text-left font-semibold text-white">{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {dists.map((d, i) => {
                const isActive = !(d as any).project?.date_completed;
                return (
                <tr key={d.id} className="border-t" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5 font-semibold" style={{ color: "#1a202c" }}>{(d as any).project?.project_name ?? "—"}</td>
                  <td className="px-3 py-1.5">
                    <span className="font-bold" style={{ color: isActive ? "#dc2626" : "#16a34a" }}>{fmtKESFull(Number(d.amount))}</span>
                    {isActive && <span className="ml-1.5 text-[9px] font-bold px-1 py-0.5 rounded" style={{ background: "#fef2f2", color: "#dc2626" }}>Estimated</span>}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{d.distributed_at ? fmtDate(String(d.distributed_at).split("T")[0]) : "—"}</td>
                  <td className="px-3 py-1.5 text-gray-400 truncate max-w-[120px]" title={d.notes ?? ""}>{d.notes || "—"}</td>
                  <td className="px-3 py-1.5">
                    <button onClick={() => setEditDist(d)}
                      className="px-2 py-0.5 rounded-lg text-[10px] font-bold hover:opacity-80"
                      style={{ background: "#eef2ff", color: "#6366f1" }}>
                      EDIT
                    </button>
                  </td>
                </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: "#f0fdf4", borderTop: "2px solid #bbf7d0" }}>
                <td className="px-3 py-2 text-xs font-bold" style={{ color: "#15803d" }}>TOTAL</td>
                <td className="px-3 py-2 text-xs font-extrabold" style={{ color: "#15803d" }}>{fmtKESFull(total)}</td>
                <td colSpan={3} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Accordion>

    {/* Edit Distribution modal */}
    {editDist && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={(e) => { if (e.target === e.currentTarget) setEditDist(null); }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
            <div>
              <p className="font-bold text-sm" style={{ color: "#166534" }}>Edit Distribution</p>
              <p className="text-xs text-gray-500">{(editDist as any).project?.project_name ?? "—"}</p>
            </div>
            <button onClick={() => setEditDist(null)} className="p-1.5 rounded-full hover:bg-green-100 text-green-600"><X size={15} /></button>
          </div>
          <EditDistributionForm dist={editDist} onClose={() => setEditDist(null)} onSaved={(patch) => {
            setDists((prev) => prev.map((d) => d.id === editDist.id ? { ...d, ...patch } : d));
            setEditDist(null);
            toast.success("Distribution updated");
          }} />
        </div>
      </div>
    )}
    </>
  );
}

function EditDistributionForm({ dist, onClose, onSaved }: {
  dist: ProfitDistribution;
  onClose: () => void;
  onSaved: (patch: { amount?: number; distributed_at?: string; notes?: string }) => void;
}) {
  const [amount, setAmount] = useState(String(dist.amount));
  const [date, setDate] = useState(String(dist.distributed_at).split("T")[0]);
  const [notes, setNotes] = useState(dist.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-200";

  const save = async () => {
    if (amount === "" || isNaN(Number(amount)) || Number(amount) < 0) { setErr("Enter a valid amount"); return; }
    setSaving(true); setErr("");
    try {
      const patch = { amount: Number(amount), distributed_at: date || undefined, notes: notes.trim() || undefined };
      await profitDistributionsApi.update(dist.id, patch);
      logActivity({ category: "project", action: "update", description: `Profit distribution #${dist.id} updated`, meta: { id: dist.id } });
      onSaved(patch);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="p-5 space-y-3">
      <div>
        <label className="text-xs font-semibold text-gray-500 block mb-1">Amount (KES)</label>
        <input type="number" min="1" className={inp} style={{ borderColor: "var(--border)" }}
          value={amount} onChange={(e) => setAmount(e.target.value)} />
      </div>
      <div>
        <label className="text-xs font-semibold text-gray-500 block mb-1">Distribution Date</label>
        <input type="date" className={inp} style={{ borderColor: "var(--border)" }}
          value={date} onChange={(e) => setDate(e.target.value)} />
      </div>
      <div>
        <label className="text-xs font-semibold text-gray-500 block mb-1">Notes</label>
        <input className={inp} style={{ borderColor: "var(--border)" }}
          value={notes} onChange={(e) => setNotes(e.target.value)}
          placeholder="Optional notes…" />
      </div>
      {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
      <div className="flex gap-2 pt-1">
        <button onClick={onClose}
          className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
          style={{ borderColor: "var(--border)" }}>Cancel</button>
        <button onClick={save} disabled={saving}
          className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
          style={{ background: "#22c55e" }}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
          Save
        </button>
      </div>
    </div>
  );
}

// ─── Plot CSV Upload Modal ────────────────────────────────────────────────────
function PlotCsvUploadModal({ plot, memberName, onClose, onDone }: {
  plot: Plot & { project?: Project };
  memberName: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [rows, setRows] = useState<{ rawDate: string; parsedDate: string; amount: string; paymentMethod: string; transactionCode: string; paidBy: string; phone: string; fine: string; status: string; notes: string }[]>([
    { rawDate: "", parsedDate: new Date().toISOString().split("T")[0], amount: "", paymentMethod: "", transactionCode: "", paidBy: memberName, phone: "", fine: "", status: "", notes: "" }
  ]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  const MONTHS_SHORT = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];

  const parseDateToISO = (raw: string): string => {
    if (!raw.trim()) return "";
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(raw.trim())) return raw.trim();
    // DD/MM/YYYY or DD-MM-YYYY (day first — East African standard)
    const dmyNum = raw.trim().match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})$/);
    if (dmyNum) {
      const [, d, m, y] = dmyNum.map(Number);
      return `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    }
    // DD-Mon-YY or DD-Mon-YYYY (e.g. "09-Sept-21")
    const dmy = raw.trim().match(/^(\d{1,2})[-\/\s]([A-Za-z]+)[-\/\s](\d{2,4})$/);
    if (dmy) {
      const d = parseInt(dmy[1]);
      const mIdx = MONTHS_SHORT.findIndex((mn) => mn === dmy[2].slice(0,3).toLowerCase());
      const rawY = parseInt(dmy[3]);
      const y = rawY < 100 ? 2000 + rawY : rawY;
      if (mIdx >= 0) return `${y}-${String(mIdx+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    }
    return "";
  };

  const splitLine = (line: string, sep: string): string[] => {
    if (sep === "\t") return line.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
    // Proper RFC-4180 comma parser — handles "100,000" quoted fields
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

  const parseCsv = (text: string) => {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim().split("\n").filter(Boolean);
    const sep = lines[0].includes("\t") ? "\t" : ",";
    const firstRow = splitLine(lines[0], sep).map((h) => h.toLowerCase().replace(/[\s\/\-]+/g, "_"));
    const split = (l: string) => splitLine(l, sep);
    // Excel column order: Date, Amount, PaymentMethod, TransactionCode, Paid By, MOBILE NO, FINE, STATUS, Notes
    const hasHeader = firstRow.some((h) => ["date","amount","paymentmethod","payment_method","transactioncode","transaction_code","paid_by","paidby","mobile_no","mobileno","notes"].includes(h));
    const header = hasHeader ? firstRow : ["date","amount","paymentmethod","transactioncode","paid_by","mobile_no","fine","status","notes"];
    const data = (hasHeader ? lines.slice(1) : lines).map(split);
    const hi = (k: string) => header.findIndex((h) => h === k || h === k.replace(/_/g,"") || h === k.replace(/ /g,"_").toLowerCase());
    const di  = hi("date");
    const ai  = hi("amount");
    const pmi = Math.max(hi("paymentmethod"), hi("payment_method"));
    const tci = Math.max(hi("transactioncode"), hi("transaction_code"));
    const pbi = Math.max(hi("paid_by"), hi("paidby"), hi("paid by"));
    const phi = Math.max(hi("mobile_no"), hi("mobileno"), hi("phone"), hi("mobile no"));
    const fni = Math.max(hi("fine"));
    const sti = Math.max(hi("status"));
    const ni  = hi("notes");
    setRows(data.filter((r) => r.some((c) => c)).map((r) => {
      const rawDate = (di >= 0 ? r[di] : r[0]) || "";
      const rawAmt  = ((ai >= 0 ? r[ai] : r[1]) || "").replace(/,/g, "");
      return {
        rawDate,
        parsedDate: parseDateToISO(rawDate),
        amount: rawAmt,
        paymentMethod: (pmi >= 0 ? r[pmi] : r[2]) || "",
        transactionCode: (tci >= 0 ? r[tci] : r[3]) || "",
        paidBy: (pbi >= 0 ? r[pbi] : r[4]) || memberName,
        phone:  (phi >= 0 ? r[phi] : r[5]) || "",
        fine:   (fni >= 0 ? r[fni] : r[6]) || "",
        status: (sti >= 0 ? r[sti] : r[7]) || "",
        notes:  (ni  >= 0 ? r[ni]  : r[8]) || "",
      };
    }));
  };

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = (ev) => { if (ev.target?.result) parseCsv(ev.target.result as string); };
    reader.readAsText(f);
  };

  const handleSave = async () => {
    setErr(""); setSaving(true);
    const rowErrors: string[] = [];
    let saved = 0;
    for (const r of rows) {
      const amt = parseFloat(r.amount);
      if (!r.parsedDate || isNaN(amt) || amt <= 0 || !r.paymentMethod) continue;
      const structuredNotes = JSON.stringify({
        method: r.paymentMethod,
        ref: r.transactionCode || "",
        paidBy: r.paidBy || memberName,
        phone: r.phone || "",
        fine: r.fine || "",
        status: r.status || "",
        note: r.notes || "",
      });
      try {
        await plotsApi.recordPayment(plot.id, amt, structuredNotes, r.parsedDate || undefined);
        saved++;
      } catch (e: any) {
        rowErrors.push(`${r.rawDate || r.parsedDate}: ${e?.message ?? "error"}`);
      }
    }
    setSaving(false);
    if (rowErrors.length > 0) {
      setErr(`${saved} payment${saved !== 1 ? "s" : ""} saved. ${rowErrors.length} failed: ${rowErrors.join("; ")}`);
    } else {
      onDone();
      onClose();
    }
  };

  const templateRows = [
    ["Date", "Amount", "PaymentMethod", "TransactionCode", "Paid By", "MOBILE NO", "FINE", "STATUS", "Notes"],
    ["09-Sept-21", "100,000", "Mpesa paybill-KCB", "", "Bancy Wambui", "0712345678", "", "", ""],
    ["10-Sept-21", "5,000",   "Mpesa paybill-KCB", "", "Bancy Wambui", "0712345678", "", "", ""],
  ];
  const templateCsv = templateRows.map((r) => r.join(",")).join("\n");

  const validCount = rows.filter((r) => r.parsedDate && parseFloat(r.amount) > 0 && r.paymentMethod).length;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
        <div className="px-5 py-4 border-b flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Upload Plot Payments</p>
            <p className="text-xs text-gray-400">{plot.plot_number} · Date, Amount, PaymentMethod, TransactionCode, Paid By, MOBILE NO, FINE, STATUS, Notes</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={15} /></button>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-gray-400">Accepted date formats: <span className="font-mono text-gray-600">09-Sept-21 · 2025-01-04</span></p>
            <button onClick={() => { const a = document.createElement("a"); a.href = "data:text/csv," + encodeURIComponent(templateCsv); a.download = "plot_payments_template.csv"; a.click(); }}
              className="flex items-center gap-1 text-xs font-bold px-2.5 py-1.5 rounded-lg hover:opacity-80"
              style={{ background: "#eef2ff", color: "#6366f1" }}>
              <Download size={11} /> Template
            </button>
          </div>
          <button onClick={() => fileRef.current?.click()}
            className="w-full border-2 border-dashed rounded-xl py-6 text-center text-xs text-gray-400 hover:border-indigo-300 hover:text-indigo-400 transition-colors"
            style={{ borderColor: "#cbd5e1" }}>
            <UploadCloud size={20} className="mx-auto mb-1.5 text-gray-300" />
            Click to browse CSV file
          </button>
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={handleFile} />

          {rows.length > 0 && (
            <div className="rounded-xl border overflow-auto max-h-60" style={{ borderColor: "var(--border)" }}>
              <table className="w-full text-xs min-w-[960px]">
                <thead><tr style={{ background: "#1e3a5f" }}>
                  {["Date", "Amount", "PaymentMethod", "TransactionCode", "Paid By", "MOBILE NO", "FINE", "STATUS", "Notes", ""].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold text-white whitespace-nowrap">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map((r, i) => {
                    const hasDateErr = r.rawDate && !r.parsedDate;
                    const hasAmtErr  = r.amount && isNaN(parseFloat(r.amount));
                    const upd = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
                      setRows((prev) => prev.map((x, j) => j === i ? { ...x, [k]: e.target.value } : x));
                    return (
                      <tr key={i} className="border-t" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                        <td className="px-3 py-1.5">
                          <input value={r.rawDate}
                            onChange={(e) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, rawDate: e.target.value, parsedDate: parseDateToISO(e.target.value) } : x))}
                            placeholder="09-Sept-21"
                            className="border rounded px-1.5 py-0.5 text-xs w-24"
                            style={{ borderColor: hasDateErr ? "#ef4444" : "var(--border)" }} />
                          {r.parsedDate && <div className="text-[9px] text-green-600 mt-0.5">{r.parsedDate}</div>}
                          {hasDateErr   && <div className="text-[9px] text-red-500 mt-0.5">invalid date</div>}
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.amount}
                            onChange={(e) => setRows((prev) => prev.map((x, j) => j === i ? { ...x, amount: e.target.value.replace(/,/g,"") } : x))}
                            placeholder="0"
                            className="border rounded px-1.5 py-0.5 text-xs w-20"
                            style={{ borderColor: hasAmtErr ? "#ef4444" : "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.paymentMethod} onChange={upd("paymentMethod")}
                            placeholder="Mpesa paybill-KCB"
                            className="border rounded px-1.5 py-0.5 text-xs w-32"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.transactionCode} onChange={upd("transactionCode")}
                            placeholder=""
                            className="border rounded px-1.5 py-0.5 text-xs w-24"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.paidBy} onChange={upd("paidBy")}
                            placeholder="Full name"
                            className="border rounded px-1.5 py-0.5 text-xs w-28"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.phone} onChange={upd("phone")}
                            placeholder="07XXXXXXXX"
                            className="border rounded px-1.5 py-0.5 text-xs w-24"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.fine} onChange={upd("fine")}
                            placeholder=""
                            className="border rounded px-1.5 py-0.5 text-xs w-16"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.status} onChange={upd("status")}
                            placeholder=""
                            className="border rounded px-1.5 py-0.5 text-xs w-16"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-3 py-1.5">
                          <input value={r.notes} onChange={upd("notes")}
                            placeholder=""
                            className="border rounded px-1.5 py-0.5 text-xs w-20"
                            style={{ borderColor: "var(--border)" }} />
                        </td>
                        <td className="px-2 py-1.5">
                          <button onClick={() => setRows((prev) => prev.filter((_, j) => j !== i))}
                            className="text-gray-300 hover:text-red-400 transition-colors">
                            <X size={12} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {err && <p className="text-xs text-red-500">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving || validCount === 0}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
              style={{ background: "#6366f1" }}>
              {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : `Import ${validCount} Row${validCount !== 1 ? "s" : ""}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AllocatedPlotsAccordion({ memberId, memberType, memberName, memberPhone }: { memberId: number; memberType: "shareholder" | "client"; memberName: string; memberPhone?: string }) {
  const navigate = useNavigate();
  const _profile = useProfile();
  const _isAdmin = _profile?.role === "admin";
  const [plots, setPlots] = useState<(Plot & { project?: Project })[]>([]);
  const [loading, setLoading] = useState(true);
  const [payTarget, setPayTarget] = useState<(Plot & { project?: Project }) | null>(null);
  const [payStep, setPayStep] = useState<"amount" | "method" | null>(null);
  const [plotAmount, setPlotAmount] = useState("");
  const [uploadTarget, setUploadTarget] = useState<(Plot & { project?: Project }) | null>(null);

  const reload = useCallback(() => {
    setLoading(true);
    plotsApi.listByMember(memberId, memberType)
      .then((p) => setPlots(p))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [memberId, memberType]);

  useEffect(() => { reload(); }, [reload]);

  const closePay = () => { setPayTarget(null); setPayStep(null); setPlotAmount(""); };

  const handlePay = async (method: PayMethod, ref?: string, viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => {
    if (!payTarget) return;
    const amt = Math.min(parseFloat(plotAmount) || 0, Math.max(0, Number(payTarget.price) - Number(payTarget.paid_amount)));
    if (amt <= 0) return;
    const today = new Date().toISOString().slice(0, 10);

    // extras.paidBy overrides for manual; for STK try resolving from callback
    let payerName = extras?.paidBy || memberName;
    let payerPhone = phone ?? memberPhone ?? "";
    if (method === "mpesa" && ref && !extras) {
      try {
        const { data: cbRow } = await supabase
          .from("app_settings").select("value").eq("key", "mpesa_callback_last").maybeSingle();
        if (cbRow?.value) {
          const stkCb = (cbRow.value as any)?.Body?.stkCallback ?? cbRow.value;
          const cbItems: { Name: string; Value?: string | number }[] = stkCb?.CallbackMetadata?.Item ?? [];
          const cbPhone = String(cbItems.find((i) => i.Name === "PhoneNumber")?.Value ?? "");
          if (cbPhone) {
            payerPhone = cbPhone;
            const norm = cbPhone.replace(/^254/, "0");
            const [shRows, clRows] = await Promise.all([
              supabase.from("shareholders").select("name").or(`phone.eq.${cbPhone},phone.eq.${norm}`).limit(1),
              supabase.from("clients").select("name").or(`phone.eq.${cbPhone},phone.eq.${norm}`).limit(1),
            ]);
            const found = shRows.data?.[0]?.name ?? clRows.data?.[0]?.name;
            if (found) payerName = found;
          }
        }
      } catch { /* best-effort */ }
    }

    const structuredNotes = JSON.stringify({
      method: method === "mpesa" ? "Mpesa" : method === "bank" ? "Bank Transfer" : method === "cheque" ? "Cheque" : "Cash",
      ref: ref ?? "",
      paidBy: payerName,
      phone: payerPhone,
      fine: "",
      status: "",
      note: extras?.comment ?? "",
    });
    await plotsApi.recordPayment(payTarget.id, amt, structuredNotes);
    logActivity({ category: "plot", action: "payment", description: `Plot ${payTarget.plot_number} payment of KES ${amt.toLocaleString()} recorded for ${payerName}`, actor_name: memberName, meta: { plot_id: payTarget.id, amount: amt } });
    if (method === "mpesa") {
      const baseComment = `PHONE:${payerPhone}|ACCOUNT:${payTarget.plot_number}`;
      await paymentsApi.create({
        payment_id: ref ?? undefined,
        date_paid: today,
        amount: amt,
        paid_by: payerName,
        purpose: "Plot Payment",
        mode: "Mpesa",
        comment: extras?.comment ? `${baseComment} · ${extras.comment}` : baseComment,
      });
    }
    reload();
  };

  const due = payTarget ? Math.max(0, Number(payTarget.price) - Number(payTarget.paid_amount)) : 0;
  const parsedPlotAmt = Math.min(parseFloat(plotAmount) || 0, due);

  return (
    <>
      <Accordion icon={<MapPin size={16} />} label="Allocated Plots" meta={loading ? "…" : `${plots.length} plot${plots.length !== 1 ? "s" : ""}`} color="#ec4899">
        {loading ? (
          <div className="flex justify-center py-3"><Loader2 size={16} className="animate-spin text-gray-300" /></div>
        ) : plots.length === 0 ? (
          <p className="py-2 text-xs text-gray-400">No plots allocated yet.</p>
        ) : (
          <div className="space-y-3 pt-1">
            {plots.map((p) => (
              <AssignedPlotCard key={p.id} plot={p} isAdmin={_isAdmin}
                onPay={() => { setPayTarget(p); setPayStep("amount"); }}
                onUpload={() => setUploadTarget(p)}
                onRemove={() => plotsApi.unassign(p.id).then(reload)}
                onRefresh={reload}
                onNavigatePlot={() => navigate("/projects", { state: { projectId: (p.project as any)?.id, plotId: p.id } })}
                onNavigateProject={() => navigate("/projects", { state: { projectId: (p.project as any)?.id } })}
              />
            ))}
          </div>
        )}
      </Accordion>

      {/* Step 1: Amount entry */}
      {payTarget && payStep === "amount" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
              <div>
                <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Record Payment — {payTarget.plot_number}</p>
                <p className="text-xs text-gray-400 mt-0.5">{memberName}</p>
              </div>
              <button onClick={closePay} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-gray-500">Outstanding: <span className="font-bold text-red-500">{fmtKESFull(due)}</span></p>
              <input type="number" value={plotAmount} onChange={(e) => setPlotAmount(e.target.value)}
                placeholder="Amount (KES)" autoFocus
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-pink-200"
                style={{ borderColor: "var(--border)" }} />
              <div className="flex gap-2">
                <button onClick={closePay}
                  className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button onClick={() => setPayStep("method")} disabled={!parsedPlotAmt || parsedPlotAmt <= 0}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
                  style={{ background: "#ec4899" }}>
                  Choose Payment →
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Step 2: PaymentModal (same as contributions) */}
      {payTarget && payStep === "method" && (
        <PaymentModal
          amount={parsedPlotAmt}
          description={`Plot ${payTarget.plot_number}`}
          memberName={memberName}
          memberPhone={memberPhone}
          accountRef={(payTarget.project?.project_name ? `${payTarget.project.project_name}/Plot ${payTarget.plot_number}` : `Plot ${payTarget.plot_number}`).slice(0, 12)}
          onClose={closePay}
          onComplete={async (method, ref, viaStk, phone, extras) => {
            await handlePay(method, ref, viaStk, phone, extras);
            closePay();
          }}
        />
      )}

      {uploadTarget && (
        <PlotCsvUploadModal plot={uploadTarget} memberName={memberName} onClose={() => setUploadTarget(null)} onDone={reload} />
      )}
    </>
  );
}

function Accordion({ icon, label, meta, color, children }: { icon: React.ReactNode; label: string; meta: string; color: string; children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-xl overflow-hidden" style={{ borderColor: "var(--border)" }}>
      <button onClick={() => setOpen((v) => !v)} className="w-full flex items-center gap-3 px-4 py-3.5 bg-white hover:bg-gray-50 transition-colors bg-[#bfbaba]">
        <span style={{ color }}>{icon}</span>
        <span className="flex-1 text-left text-sm font-semibold" style={{ color: "#1a202c" }}>{label}</span>
        <span className="text-sm font-medium" style={{ color }}>{meta}</span>
        <ChevronDown size={15} className="text-gray-400 transition-transform" style={{ transform: open ? "rotate(180deg)" : "none" }} />
      </button>
      {open && children && (
        <div className="px-4 pb-4 pt-1 bg-white border-t text-sm text-gray-500" style={{ borderColor: "var(--card-border)" }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Shared: Member List Panel ────────────────────────────────────────────────

interface MemberListPanelProps<T extends { id: number; name: string; phone: string; member_number: number | string; status: "Active" | "Inactive"; avatar_color: string; photo_url: string | null }> {
  title: string;
  accentColor: string;
  members: T[];
  total: number;
  loading: boolean;
  selected: T | null;
  filter: "All" | "Active" | "Inactive";
  search: string;
  mobileDetail: boolean;
  memberPrefix?: string;
  onFilterChange: (f: "All" | "Active" | "Inactive") => void;
  onSearchChange: (s: string) => void;
  onSelect: (m: T) => void;
  onAddClick: () => void;
}

function MemberListPanel<T extends { id: number; name: string; phone: string; member_number: number | string; status: "Active" | "Inactive"; avatar_color: string; photo_url: string | null }>({
  title, accentColor, members, total, loading, selected, filter, search, mobileDetail,
  memberPrefix = "#",
  onFilterChange, onSearchChange, onSelect, onAddClick,
}: MemberListPanelProps<T>) {
  return (
    <div
      className={`flex flex-col border-r flex-shrink-0 bg-white ${mobileDetail ? "hidden md:flex" : "flex"}`}
      style={{ width: "100%", maxWidth: 300, borderColor: "var(--border)" }}
    >
      <div className="px-4 pt-4 pb-3 border-b" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center justify-between mb-1">
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>{title}</h2>
            <p className="text-xs text-gray-400">{total} registered members</p>
          </div>
          {!useIsViewOnly() && (
            <button onClick={onAddClick} className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white" style={{ background: accentColor }}>
              <Plus size={13} /> Add
            </button>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2 px-3 py-2 rounded-lg" style={{ background: "#f8fafc", border: "1px solid var(--border)" }}>
          <Search size={13} className="text-gray-400 flex-shrink-0" />
          <input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search name or phone..."
            className="flex-1 text-xs bg-transparent outline-none text-gray-700 placeholder-gray-400" />
          {search && <button onClick={() => onSearchChange("")}><X size={12} className="text-gray-400" /></button>}
        </div>

        <div className="mt-2.5 flex rounded-lg overflow-hidden border" style={{ borderColor: "var(--border)" }}>
          {(["All", "Active", "Inactive"] as const).map((f) => (
            <button key={f} onClick={() => onFilterChange(f)}
              className="flex-1 py-1.5 text-xs font-semibold transition-colors"
              style={{ background: filter === f ? accentColor : "#f8fafc", color: filter === f ? "#fff" : "#64748b" }}>
              {f}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
        {loading && (
          <div className="flex items-center justify-center py-12">
            <Loader2 size={20} className="animate-spin text-gray-400" />
          </div>
        )}
        {!loading && members.length === 0 && (
          <div className="py-12 text-center">
            <p className="text-xs text-gray-400">No members found</p>
          </div>
        )}
        {members.map((m) => (
          <button key={m.id} onClick={() => onSelect(m)}
            className="w-full flex items-center gap-3 px-4 py-3 border-b text-left transition-colors"
            style={{ borderColor: "var(--border)", background: selected?.id === m.id ? `${accentColor}12` : "white" }}>
            <MemberAvatar photoUrl={m.photo_url} name={m.name} color={m.avatar_color} size={36} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>{m.name}</div>
              <div className="text-xs text-gray-400">{m.phone}</div>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-xs font-bold" style={{ color: accentColor }}>{memberPrefix}{m.member_number}</div>
              <div className="flex items-center gap-1 mt-0.5 justify-end">
                <span className={`w-1.5 h-1.5 rounded-full ${m.status === "Active" ? "bg-green-400" : "bg-gray-300"}`} />
                <span className="text-[10px] text-gray-400">{m.status}</span>
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Refund Confirm Modal ─────────────────────────────────────────────────────

function RefundConfirmModal({ shareholder, onClose, onConfirm }: {
  shareholder: Shareholder;
  onClose: () => void;
  onConfirm: (amount: number, notes: string, refund_date: string) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(Number(shareholder.net_savings)));
  const [notes, setNotes] = useState("");
  const [refundDate, setRefundDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [contribCount, setContribCount] = useState<number | null>(null);

  useEffect(() => {
    contributionsApi.listByShareholder(shareholder.id)
      .then((c) => setContribCount(c.length))
      .catch(() => setContribCount(0));
  }, [shareholder.id]);

  const handleConfirm = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 0) { setErr("Enter a valid amount"); return; }
    setSaving(true);
    try {
      await onConfirm(amt, notes, refundDate);
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
          <div className="flex items-center gap-2">
            <RotateCcw size={18} color="#ef4444" />
            <span className="font-bold text-red-600">Process Refund</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Member card */}
          <div className="flex items-center gap-3 bg-gray-50 rounded-xl p-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white text-sm font-bold flex-shrink-0" style={{ background: shareholder.avatar_color }}>
              {initials(shareholder.name)}
            </div>
            <div>
              <div className="font-semibold text-sm" style={{ color: "#1a202c" }}>{shareholder.name}</div>
              <div className="text-xs text-gray-400">EW#{shareholder.member_number} · Net Savings: {fmtKESFull(Number(shareholder.net_savings))}</div>
            </div>
          </div>

          {/* Loading check */}
          {contribCount === null ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 size={18} className="animate-spin text-gray-300" />
            </div>
          ) : contribCount === 0 && Number(shareholder.net_savings) <= 0 ? (
            /* Blocked — no contributions AND no savings balance */
            <div className="rounded-xl border px-4 py-5 flex flex-col items-center gap-3 text-center" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
              <div className="w-12 h-12 rounded-2xl flex items-center justify-center" style={{ background: "#fee2e2" }}>
                <AlertCircle size={22} color="#ef4444" />
              </div>
              <div>
                <p className="font-bold text-sm" style={{ color: "#1a202c" }}>No Contributions Found</p>
                <p className="text-xs text-gray-400 mt-1">
                  <strong>{shareholder.name}</strong> has no recorded contributions and a zero savings balance. There is nothing to refund.
                </p>
              </div>
              <button onClick={onClose}
                className="mt-1 px-5 py-2 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-100"
                style={{ borderColor: "var(--border)" }}>
                Close
              </button>
            </div>
          ) : (
            /* Refund form — allow if net_savings > 0 even when contribution rows were deleted */
            <>
              {contribCount === 0 && Number(shareholder.net_savings) > 0 && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 text-xs text-blue-700 font-medium flex items-start gap-2">
                  <AlertCircle size={13} className="flex-shrink-0 mt-0.5" />
                  <span>No contribution rows found, but this member has a net savings balance of <strong>{fmtKESFull(Number(shareholder.net_savings))}</strong>. Run <em>Recalculate Net Savings</em> in App Maintenance to sync if needed.</span>
                </div>
              )}
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700 font-medium">
                Refunding will deduct the amount from net savings and mark this shareholder as <strong>Inactive</strong>.
                {contribCount > 0 && <>&nbsp;This member has <strong>{contribCount} contribution{contribCount !== 1 ? "s" : ""}</strong>.</>}
              </div>

              <div className="space-y-3">
                <div>
                  <label className="text-xs font-semibold text-gray-500 mb-1 block">Refund Amount (KES)</label>
                  <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                    style={{ borderColor: "#fca5a5" }} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 mb-1 block">Refund Date</label>
                  <input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)}
                    className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300"
                    style={{ borderColor: "#fca5a5" }} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-gray-500 mb-1 block">Notes (optional)</label>
                  <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
                    placeholder="Reason for refund…"
                    className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-red-300 resize-none"
                    style={{ borderColor: "#fca5a5" }} />
                </div>
              </div>

              {err && <p className="text-xs text-red-500 font-medium">{err}</p>}

              <div className="flex gap-2 pt-1">
                <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button onClick={handleConfirm} disabled={saving}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ background: "#ef4444" }}>
                  {saving ? <Loader2 size={15} className="animate-spin" /> : <RotateCcw size={15} />}
                  Confirm Refund
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Shareholders Page ────────────────────────────────────────────────────────

function ShareholdersPage() {
  const viewOnly = useIsViewOnly();
  const [members, setMembers] = useState<Shareholder[]>([]);
  const [selected, setSelected] = useState<Shareholder | null>(null);
  const [filter, setFilter] = useState<"All" | "Active" | "Inactive">("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Shareholder | null>(null);
  const [refundTarget, setRefundTarget] = useState<Shareholder | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [sendingPwReminder, setSendingPwReminder] = useState(false);
  const [pwReminderSuccess, setPwReminderSuccess] = useState<string | null>(null);
  const [pwReminderCountdown, setPwReminderCountdown] = useState(5);
  const [deleteTarget, setDeleteTarget] = useState<Shareholder | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [memberSince, setMemberSince] = useState<string | null>(null);
  const [showRecordContrib, setShowRecordContrib] = useState(false);
  const [liveProfitTotal, setLiveProfitTotal] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await shareholdersApi.list({ status: filter === "All" ? undefined : filter, search: search || undefined });
      setMembers(data);
    } catch { setMembers([]); }
    finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => { load(); }, [load]);

  // Real-time: patch local state whenever a shareholder row is updated in Supabase
  useEffect(() => {
    const channel = supabase
      .channel("sh-stats-live")
      .on(
        "postgres_changes" as any,
        { event: "UPDATE", schema: "public", table: "shareholders" },
        (payload: any) => {
          const updated = payload.new as Shareholder;
          setMembers((prev) => prev.map((m) => m.id === updated.id ? { ...m, ...updated } : m));
          setSelected((s) => s?.id === updated.id ? { ...s, ...updated } : s);
        }
      )
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  useEffect(() => { setLiveProfitTotal(null); }, [selected?.id]);

  useEffect(() => {
    if (!selected) { setMemberSince(null); return; }
    supabase
      .from("contributions")
      .select("month, year")
      .eq("shareholder_id", selected.id)
      .order("year", { ascending: true })
      .order("month", { ascending: true })
      .limit(1)
      .then(({ data }) => {
        if (data && data.length > 0) {
          const { month, year } = data[0];
          const d = new Date(year, month - 1, 1);
          setMemberSince(d.toLocaleDateString("en-KE", { month: "short", year: "numeric" }));
        } else {
          setMemberSince(null);
        }
      });
  }, [selected?.id]);

  const handleAdd = async (payload: MemberPayload) => {
    const s = await shareholdersApi.create(payload);
    setMembers((prev) => [...prev, s]);
    setSelected(s);
    logActivity({ category: "shareholder", action: "create", description: `Shareholder "${s.name}" added`, actor_name: s.name, meta: { id: s.id } });
    if (s.phone) {
      sendSms(s.phone, smsTemplates.newUser(s.name.split(" ")[0], s.phone), SMS_TRIGGERS.newUser).catch(() => {});
    }
  };

  const handleEdit = async (payload: MemberPayload) => {
    if (!editTarget) return;
    const phoneChanged = payload.phone && payload.phone !== editTarget.phone;
    const updated = await shareholdersApi.update(editTarget.id, payload);
    setMembers((prev) => prev.map((m) => m.id === updated.id ? updated : m));
    setSelected(updated);
    logActivity({ category: "shareholder", action: "update", description: `Shareholder "${updated.name}" updated`, actor_name: updated.name, meta: { id: updated.id } });
    if (phoneChanged && payload.phone) {
      syncAuthEmailOnPhoneChange(editTarget.id, payload.phone).catch(() => {});
    }
  };

  const toggleStatus = async (m: Shareholder) => {
    const next = m.status === "Active" ? "Inactive" : "Active";
    const updated = await shareholdersApi.setStatus(m.id, next);
    setMembers((prev) => prev.map((x) => x.id === updated.id ? { ...x, status: updated.status } : x));
    setSelected((s) => s?.id === updated.id ? { ...s, status: updated.status } : s);
    logActivity({ category: "shareholder", action: "update", description: `Shareholder "${m.name}" status set to ${next}`, meta: { id: m.id } });
  };

  const mainActions = (m: Shareholder) => viewOnly ? [] : [
    { label: "Record Contribution", icon: <CreditCard size={13} />, color: "#6366f1", bg: "#eef2ff", onClick: () => setShowRecordContrib(true) },
    { label: "Edit",                icon: <Edit2 size={13} />,      color: "#0ea5e9", bg: "#f0f9ff", onClick: () => setEditTarget(m) },
    { label: "Refund",              icon: <RefreshCw size={13} />,  color: "#ffffff", bg: "#ef4444", onClick: () => setRefundTarget(m) },
  ];
  const handlePasswordReminder = async (m: Shareholder) => {
    if (!m.phone) { toast.error("No phone number on record for this member."); return; }
    setSendingPwReminder(true);
    try {
      const firstName = m.name.split(" ")[0];
      await sendSms(m.phone, smsTemplates.passwordReminder(firstName, m.phone), SMS_TRIGGERS.passwordReminder);
      // Show countdown modal
      setPwReminderSuccess(m.phone);
      setPwReminderCountdown(5);
      const interval = setInterval(() => {
        setPwReminderCountdown((n) => {
          if (n <= 1) { clearInterval(interval); setPwReminderSuccess(null); return 5; }
          return n - 1;
        });
      }, 1000);
    } catch (e: any) {
      toast.error(`Failed to send: ${e.message}`);
    } finally {
      setSendingPwReminder(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await shareholdersApi.remove(deleteTarget.id);
      logActivity({ category: "shareholder", action: "delete", description: `Shareholder "${deleteTarget.name}" deleted`, meta: { id: deleteTarget.id } });
      setMembers((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      toast.success(`${deleteTarget.name} has been deleted.`);
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const moreActions = (m: Shareholder) => [
    ...(viewOnly ? [] : [
      { label: "Make Plot Payment", icon: <MapPin size={13} />,    color: "#22c55e", onClick: () => {} },
      { label: "Assign Plot",       icon: <MapPin size={13} />,    color: "#f97316", onClick: () => {} },
    ]),
    { label: "Password Reminder", icon: <KeyRound size={13} />,  color: "#64748b", onClick: () => handlePasswordReminder(m) },
    ...(viewOnly ? [] : [
      { label: "Delete Member",     icon: <Trash2 size={13} />,    color: "#ef4444", onClick: () => setDeleteTarget(m) },
    ]),
  ];

  const renderDetail = (m: Shareholder) => (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Action bar — overflow-visible so dropdown isn't clipped */}
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b flex-shrink-0 flex-wrap" style={{ borderColor: "var(--card-border)" }}>
        <button onClick={() => setMobileDetail(false)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mr-1 flex-shrink-0 md:hidden">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="hidden md:block w-px h-4 bg-gray-200 flex-shrink-0" />
        {mainActions(m).map((a) => (
          <button key={a.label} onClick={a.onClick}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold flex-shrink-0 whitespace-nowrap hover:opacity-80 transition-opacity"
            style={{ background: a.bg, color: a.color }}>
            {a.icon} {a.label}
          </button>
        ))}
        <div className="relative flex-shrink-0">
          <button onClick={() => setShowMore((v) => !v)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap hover:opacity-80 transition-opacity"
            style={{ background: "#f1f5f9", color: "#475569" }}>
            <MoreHorizontal size={13} /> More Actions
          </button>
          {showMore && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMore(false)} />
              <div className="absolute top-full left-0 mt-1 bg-white rounded-xl shadow-xl border z-50 min-w-[180px] py-1" style={{ borderColor: "var(--border)" }}>
                {moreActions(m).map((a) => {
                  const isPwReminder = a.label === "Password Reminder";
                  return (
                    <button key={a.label} onClick={() => { a.onClick(); setShowMore(false); }}
                      disabled={isPwReminder && sendingPwReminder}
                      className="w-full flex items-center gap-2.5 px-4 py-2.5 text-xs font-semibold hover:bg-gray-50 text-left transition-colors disabled:opacity-50"
                      style={{ color: a.color }}>
                      {isPwReminder && sendingPwReminder ? <Loader2 size={13} className="animate-spin" /> : a.icon}
                      {isPwReminder && sendingPwReminder ? "Sending…" : a.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-3">
        {/* Profile */}
        <div className="bg-white rounded-xl border p-4 flex items-center gap-4" style={{ borderColor: "var(--card-border)" }}>
          <MemberAvatar photoUrl={m.photo_url} name={m.name} color={m.avatar_color} size={56} />
          <div className="flex-1">
            <h2 className="text-xl font-bold" style={{ color: "#1a202c" }}>{m.name}</h2>
            <p className="text-sm font-bold" style={{ color: "#eab308" }}>EW#{m.member_number}</p>
            <div className="flex items-center gap-3 mt-1">
              <span className={`flex items-center gap-1 text-xs font-semibold ${m.status === "Active" ? "text-green-600" : "text-gray-400"}`}>
                <CheckCircle2 size={12} /> {m.status}
              </span>
              {!viewOnly && <button onClick={() => toggleStatus(m)} className="text-xs text-gray-400 hover:text-gray-600 underline">
                Mark {m.status === "Active" ? "Inactive" : "Active"}
              </button>}
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="rounded-xl overflow-hidden grid grid-cols-2 md:grid-cols-4" style={{ background: "#1e2d4a" }}>
          {[
            { label: "Net Savings",   value: fmtKESFull(Number(m.net_savings)) },
            { label: "Total Profits", value: liveProfitTotal !== null ? fmtKESFull(liveProfitTotal) : fmtKESFull(Number(m.total_profits)) },
            { label: "Contributions", value: String(m.contributions_count) },
            { label: "Member Since",  value: memberSince ?? fmtDate(m.joined_date) },
          ].map((s, i) => (
            <div key={i} className="px-4 py-3 text-center border-r border-b last:border-r-0" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="text-sm font-bold text-white">{s.value}</div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Contact info */}
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: "var(--card-border)" }}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Contact Info</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              { icon: <Phone size={13} color="#22c55e" />, bg: "#f0fdf4", label: "Phone",       val: m.phone },
              { icon: <IdCard size={13} color="#8b5cf6" />, bg: "#faf5ff", label: "ID/Passport", val: m.id_passport },
              { icon: <Mail size={13} color="#3b82f6" />,  bg: "#eff6ff", label: "Email",       val: m.email },
              { icon: <Calendar size={13} color="#22c55e" />, bg: "#f0fdf4", label: "Joined",   val: fmtDate(m.joined_date) },
            ].map((c) => (
              <div key={c.label} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: c.bg }}>{c.icon}</div>
                <div>
                  <div className="text-xs text-gray-400">{c.label}</div>
                  <div className="text-sm font-semibold" style={{ color: "#1a202c" }}>{c.val || "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Rules */}
        <PaymentRulesBanner />

        <ShareholderContributionsAccordion shareholder={m} onChanged={async () => {
          const fresh = await shareholdersApi.list({ search: m.member_number?.toString() });
          const updated = fresh.find((x) => x.id === m.id);
          if (updated) {
            setMembers((prev) => prev.map((x) => x.id === m.id ? updated : x));
            setSelected(updated);
          }
        }} />
        <ShareholderProfitsAccordion shareholderId={m.id} onTotalLoaded={setLiveProfitTotal} />
        <ShareholderProjectsAccordion shareholderId={m.id} />
        <AllocatedPlotsAccordion memberId={m.id} memberType="shareholder" memberName={m.name} memberPhone={m.phone} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden">
      <MemberListPanel
        title="Shareholders" accentColor="#6366f1"
        members={members} total={members.length}
        loading={loading} selected={selected}
        filter={filter} search={search} mobileDetail={mobileDetail}
        onFilterChange={setFilter} onSearchChange={setSearch}
        onSelect={(m) => { setSelected(m); setMobileDetail(true); }}
        onAddClick={() => setShowAdd(true)}
        memberPrefix="EW#"
      />

      <div className={`flex-1 overflow-hidden ${mobileDetail ? "flex" : "hidden md:flex"} flex-col`} style={{ background: "var(--background)" }}>
        {selected ? renderDetail(selected) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#eef2ff" }}>
              <Users size={30} color="#6366f1" />
            </div>
            <p className="text-sm font-semibold text-gray-500">Select a shareholder to view details</p>
          </div>
        )}
      </div>

      {showAdd && (
        <MemberFormModal title="Shareholder" accentColor="#6366f1"
          onClose={() => setShowAdd(false)} onSave={handleAdd} />
      )}
      {editTarget && (
        <MemberFormModal title="Shareholder" accentColor="#6366f1"
          initial={editTarget}
          onClose={() => setEditTarget(null)} onSave={handleEdit} />
      )}
      {refundTarget && (
        <RefundConfirmModal
          shareholder={refundTarget}
          onClose={() => setRefundTarget(null)}
          onConfirm={async (amount, notes, refund_date) => {
            await refundsApi.create({ shareholder_id: refundTarget.id, amount, notes, refund_date });
            logActivity({ category: "refund", action: "create", description: `Refund of KES ${Number(amount).toLocaleString()} issued for "${refundTarget.name}"`, meta: { shareholder_id: refundTarget.id } });
            setRefundTarget(null);
          }}
        />
      )}
      {showRecordContrib && selected && (
        <RecordContributionModal
          shareholders={[selected]}
          initial={{ shareholder_id: selected.id }}
          onClose={() => setShowRecordContrib(false)}
          onSave={() => setShowRecordContrib(false)}
        />
      )}
      {/* Delete confirm modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="h-1.5 w-full" style={{ background: "#ef4444" }} />
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
                  <Trash2 size={18} style={{ color: "#ef4444" }} />
                </div>
                <div>
                  <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Delete Member</h2>
                  <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <span className="font-semibold" style={{ color: "#1a202c" }}>{deleteTarget.name}</span>?
                All contributions and records linked to this member will also be removed.
              </p>
              <div className="flex gap-3 pt-1">
                <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors hover:bg-gray-50 disabled:opacity-50"
                  style={{ borderColor: "var(--border)", color: "#64748b" }}>
                  Cancel
                </button>
                <button onClick={handleDelete} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <><Loader2 size={14} className="animate-spin" /> Deleting…</> : <><Trash2 size={14} /> Delete</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Password reminder success modal */}
      {pwReminderSuccess && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            {/* Green top strip */}
            <div className="h-1.5 w-full" style={{ background: "#16a34a" }} />
            <div className="p-8 flex flex-col items-center text-center gap-4">
              {/* Animated checkmark ring */}
              <div className="relative flex items-center justify-center">
                <svg width="72" height="72" viewBox="0 0 72 72">
                  <circle cx="36" cy="36" r="32" fill="none" stroke="#dcfce7" strokeWidth="6" />
                  <circle cx="36" cy="36" r="32" fill="none" stroke="#16a34a" strokeWidth="6"
                    strokeDasharray={`${2 * Math.PI * 32 * (1 - (pwReminderCountdown - 1) / 5)} ${2 * Math.PI * 32}`}
                    strokeLinecap="round"
                    transform="rotate(-90 36 36)"
                    style={{ transition: "stroke-dasharray 0.9s linear" }} />
                  <text x="36" y="41" textAnchor="middle" fontSize="22" fontWeight="700" fill="#16a34a">{pwReminderCountdown}</text>
                </svg>
              </div>
              <div>
                <h2 className="text-lg font-bold" style={{ color: "#1a202c" }}>SMS Sent!</h2>
                <p className="text-sm text-gray-500 mt-1">
                  Password reminder delivered to<br />
                  <span className="font-semibold text-gray-700">{pwReminderSuccess}</span>
                </p>
              </div>
              <button
                onClick={() => setPwReminderSuccess(null)}
                className="w-full py-2.5 rounded-xl text-sm font-bold text-white transition-colors"
                style={{ background: "#16a34a" }}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Clients Page ─────────────────────────────────────────────────────────────

function ClientsPage() {
  const viewOnly = useIsViewOnly();
  const [members, setMembers] = useState<Client[]>([]);
  const [selected, setSelected] = useState<Client | null>(null);
  const [filter, setFilter] = useState<"All" | "Active" | "Inactive">("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Client | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Client | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await clientsApi.list({ status: filter === "All" ? undefined : filter, search: search || undefined });
      setMembers(data);
    } catch { setMembers([]); }
    finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (payload: MemberPayload) => {
    const c = await clientsApi.create(payload);
    setMembers((prev) => [...prev, c]);
    setSelected(c);
    logActivity({ category: "client", action: "create", description: `Client "${c.name}" added`, meta: { id: c.id } });
  };

  const handleEdit = async (payload: MemberPayload) => {
    if (!editTarget) return;
    const phoneChanged = payload.phone && payload.phone !== editTarget.phone;
    const updated = await clientsApi.update(editTarget.id, payload);
    setMembers((prev) => prev.map((m) => m.id === updated.id ? updated : m));
    setSelected(updated);
    logActivity({ category: "client", action: "update", description: `Client "${updated.name}" updated`, meta: { id: updated.id } });
    if (phoneChanged && payload.phone) {
      syncAuthEmailOnPhoneChange(editTarget.id, payload.phone).catch(() => {});
    }
  };

  const toggleStatus = async (m: Client) => {
    const next = m.status === "Active" ? "Inactive" : "Active";
    const updated = await clientsApi.setStatus(m.id, next);
    setMembers((prev) => prev.map((x) => x.id === updated.id ? { ...x, status: updated.status } : x));
    setSelected((s) => s?.id === updated.id ? { ...s, status: updated.status } : s);
    logActivity({ category: "client", action: "update", description: `Client "${m.name}" status set to ${next}`, meta: { id: m.id } });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await clientsApi.remove(deleteTarget.id);
      logActivity({ category: "client", action: "delete", description: `Client "${deleteTarget.name}" deleted`, meta: { id: deleteTarget.id } });
      setMembers((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      toast.success(`${deleteTarget.name} has been deleted.`);
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const actions = (m: Client) => viewOnly ? [] : [
    { label: "Record Payment",    icon: <CreditCard size={13} />, color: "#a855f7", bg: "#faf5ff", onClick: () => {} },
    { label: "View Loans",        icon: <Wallet size={13} />,     color: "#22c55e", bg: "#f0fdf4", onClick: () => {} },
    { label: "Assign Loan",       icon: <Link2 size={13} />,      color: "#f97316", bg: "#fff7ed", onClick: () => {} },
    { label: "Password Reminder", icon: <KeyRound size={13} />,   color: "#64748b", bg: "#f8fafc", onClick: () => {} },
    { label: "Edit",              icon: <Edit2 size={13} />,      color: "#0ea5e9", bg: "#f0f9ff", onClick: () => setEditTarget(m) },
    { label: "Delete",            icon: <Trash2 size={13} />,     color: "#ffffff", bg: "#ef4444", onClick: () => setDeleteTarget(m) },
    { label: "Block",             icon: <X size={13} />,          color: "#64748b", bg: "#f1f5f9", onClick: () => toggleStatus(m) },
  ];

  const renderDetail = (m: Client) => (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b flex-shrink-0 overflow-x-auto" style={{ borderColor: "var(--card-border)" }}>
        <button onClick={() => setMobileDetail(false)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mr-1 flex-shrink-0 md:hidden">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="hidden md:block w-px h-4 bg-gray-200 flex-shrink-0" />
        {actions(m).map((a) => (
          <button key={a.label} onClick={a.onClick}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold flex-shrink-0 whitespace-nowrap hover:opacity-80 transition-opacity"
            style={{ background: a.bg, color: a.color }}>
            {a.icon} {a.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-3">
        {/* Profile */}
        <div className="bg-white rounded-xl border p-4 flex items-center gap-4" style={{ borderColor: "var(--card-border)" }}>
          <MemberAvatar photoUrl={m.photo_url} name={m.name} color={m.avatar_color} size={56} />
          <div className="flex-1">
            <h2 className="text-xl font-bold" style={{ color: "#1a202c" }}>{m.name}</h2>
            <p className="text-sm font-bold" style={{ color: "#eab308" }}>{m.member_number}</p>
            <div className="flex items-center gap-3 mt-1">
              <span className={`flex items-center gap-1 text-xs font-semibold ${m.status === "Active" ? "text-green-600" : "text-gray-400"}`}>
                <CheckCircle2 size={12} /> {m.status}
              </span>
              {!viewOnly && <button onClick={() => toggleStatus(m)} className="text-xs text-gray-400 hover:text-gray-600 underline">
                Mark {m.status === "Active" ? "Inactive" : "Active"}
              </button>}
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="rounded-xl overflow-hidden grid grid-cols-2 md:grid-cols-3" style={{ background: "#1e2d4a" }}>
          {[
            { label: "Loan Balance",  value: fmtKES(Number(m.loan_balance)) },
            { label: "Client Since",  value: fmtDate(m.joined_date) },
            { label: "Status",        value: m.status },
          ].map((s, i) => (
            <div key={i} className="px-4 py-3 text-center border-r border-b last:border-r-0" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="text-sm font-bold text-white">{s.value}</div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Contact info */}
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: "var(--card-border)" }}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Contact Info</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              { icon: <Phone size={13} color="#a855f7" />, bg: "#faf5ff", label: "Phone",        val: m.phone },
              { icon: <IdCard size={13} color="#8b5cf6" />, bg: "#f5f3ff", label: "ID/Passport",  val: m.id_passport },
              { icon: <Mail size={13} color="#3b82f6" />,  bg: "#eff6ff", label: "Email",        val: m.email },
              { icon: <Calendar size={13} color="#a855f7" />, bg: "#faf5ff", label: "Joined",    val: fmtDate(m.joined_date) },
            ].map((c) => (
              <div key={c.label} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: c.bg }}>{c.icon}</div>
                <div>
                  <div className="text-xs text-gray-400">{c.label}</div>
                  <div className="text-sm font-semibold" style={{ color: "#1a202c" }}>{c.val || "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <Accordion icon={<CreditCard size={16} />} label="Loan Accounts" meta="" color="#a855f7">
          <p className="py-2 text-gray-400 text-xs">No active loans.</p>
        </Accordion>
        <Accordion icon={<TrendingUp size={16} />} label="Payment History" meta="" color="#22c55e">
          <p className="py-2 text-gray-400 text-xs">Payment history will appear here.</p>
        </Accordion>
        <Accordion icon={<BookOpen size={16} />} label="Documents" meta="" color="#f97316">
          <p className="py-2 text-gray-400 text-xs">Client documents will appear here.</p>
        </Accordion>
        <AllocatedPlotsAccordion memberId={m.id} memberType="client" memberName={m.name} memberPhone={m.phone} />
      </div>
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden">
      <MemberListPanel
        title="Clients" accentColor="#a855f7"
        members={members} total={members.length}
        loading={loading} selected={selected}
        filter={filter} search={search} mobileDetail={mobileDetail}
        memberPrefix=""
        onFilterChange={setFilter} onSearchChange={setSearch}
        onSelect={(m) => { setSelected(m); setMobileDetail(true); }}
        onAddClick={() => setShowAdd(true)}
      />

      <div className={`flex-1 overflow-hidden ${mobileDetail ? "flex" : "hidden md:flex"} flex-col`} style={{ background: "var(--background)" }}>
        {selected ? renderDetail(selected) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#faf5ff" }}>
              <UserCircle2 size={30} color="#a855f7" />
            </div>
            <p className="text-sm font-semibold text-gray-500">Select a client to view details</p>
          </div>
        )}
      </div>

      {showAdd && (
        <MemberFormModal title="Client" accentColor="#a855f7"
          onClose={() => setShowAdd(false)} onSave={handleAdd} />
      )}
      {editTarget && (
        <MemberFormModal title="Client" accentColor="#a855f7"
          initial={editTarget}
          onClose={() => setEditTarget(null)} onSave={handleEdit} />
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="h-1.5 w-full" style={{ background: "#ef4444" }} />
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
                  <Trash2 size={18} style={{ color: "#ef4444" }} />
                </div>
                <div>
                  <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Delete Client</h2>
                  <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <span className="font-semibold" style={{ color: "#1a202c" }}>{deleteTarget.name}</span>? All records linked to this client will also be removed.
              </p>
              <div className="flex gap-3 pt-1">
                <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors hover:bg-gray-50 disabled:opacity-50"
                  style={{ borderColor: "var(--border)", color: "#64748b" }}>Cancel</button>
                <button onClick={handleDelete} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <><Loader2 size={14} className="animate-spin" /> Deleting…</> : <><Trash2 size={14} /> Delete</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Investors Page ───────────────────────────────────────────────────────────

function InvestorsPage() {
  const viewOnly = useIsViewOnly();
  const [members, setMembers] = useState<Investor[]>([]);
  const [selected, setSelected] = useState<Investor | null>(null);
  const [filter, setFilter] = useState<"All" | "Active" | "Inactive">("All");
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Investor | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Investor | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await investorsApi.list({ status: filter === "All" ? undefined : filter, search: search || undefined });
      setMembers(data);
    } catch { setMembers([]); }
    finally { setLoading(false); }
  }, [filter, search]);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async (payload: MemberPayload) => {
    const inv = await investorsApi.create(payload);
    setMembers((prev) => [...prev, inv]);
    setSelected(inv);
    logActivity({ category: "investor", action: "create", description: `Investor "${inv.name}" added`, meta: { id: inv.id } });
  };

  const handleEdit = async (payload: MemberPayload) => {
    if (!editTarget) return;
    const phoneChanged = payload.phone && payload.phone !== editTarget.phone;
    const updated = await investorsApi.update(editTarget.id, payload);
    setMembers((prev) => prev.map((m) => m.id === updated.id ? updated : m));
    setSelected(updated);
    logActivity({ category: "investor", action: "update", description: `Investor "${updated.name}" updated`, meta: { id: updated.id } });
    if (phoneChanged && payload.phone) {
      syncAuthEmailOnPhoneChange(editTarget.id, payload.phone).catch(() => {});
    }
  };

  const toggleStatus = async (m: Investor) => {
    const next = m.status === "Active" ? "Inactive" : "Active";
    const updated = await investorsApi.setStatus(m.id, next);
    setMembers((prev) => prev.map((x) => x.id === updated.id ? { ...x, status: updated.status } : x));
    setSelected((s) => s?.id === updated.id ? { ...s, status: updated.status } : s);
    logActivity({ category: "investor", action: "update", description: `Investor "${m.name}" status set to ${next}`, meta: { id: m.id } });
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await investorsApi.remove(deleteTarget.id);
      logActivity({ category: "investor", action: "delete", description: `Investor "${deleteTarget.name}" deleted`, meta: { id: deleteTarget.id } });
      setMembers((prev) => prev.filter((m) => m.id !== deleteTarget.id));
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      toast.success(`${deleteTarget.name} has been deleted.`);
    } catch (e: any) {
      toast.error(`Delete failed: ${e.message}`);
    } finally {
      setDeleting(false);
    }
  };

  const actions = (m: Investor) => viewOnly ? [] : [
    { label: "Record Investment", icon: <TrendingUp size={13} />,  color: "#eab308", bg: "#fefce8", onClick: () => {} },
    { label: "Assign Project",    icon: <FolderOpen size={13} />, color: "#22c55e", bg: "#f0fdf4", onClick: () => {} },
    { label: "Pay Returns",       icon: <CircleDollarSign size={13} />, color: "#f97316", bg: "#fff7ed", onClick: () => {} },
    { label: "Password Reminder", icon: <KeyRound size={13} />,   color: "#64748b", bg: "#f8fafc", onClick: () => {} },
    { label: "Edit",              icon: <Edit2 size={13} />,      color: "#0ea5e9", bg: "#f0f9ff", onClick: () => setEditTarget(m) },
    { label: "Delete",            icon: <Trash2 size={13} />,     color: "#ffffff", bg: "#ef4444", onClick: () => setDeleteTarget(m) },
    { label: "Suspend",           icon: <X size={13} />,          color: "#64748b", bg: "#f1f5f9", onClick: () => toggleStatus(m) },
  ];

  const renderDetail = (m: Investor) => (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Action bar */}
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b flex-shrink-0 overflow-x-auto" style={{ borderColor: "var(--card-border)" }}>
        <button onClick={() => setMobileDetail(false)} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mr-1 flex-shrink-0 md:hidden">
          <ArrowLeft size={14} /> Back
        </button>
        <div className="hidden md:block w-px h-4 bg-gray-200 flex-shrink-0" />
        {actions(m).map((a) => (
          <button key={a.label} onClick={a.onClick}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold flex-shrink-0 whitespace-nowrap hover:opacity-80 transition-opacity"
            style={{ background: a.bg, color: a.color }}>
            {a.icon} {a.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-3">
        {/* Profile */}
        <div className="bg-white rounded-xl border p-4 flex items-center gap-4" style={{ borderColor: "var(--card-border)" }}>
          <MemberAvatar photoUrl={m.photo_url} name={m.name} color={m.avatar_color} size={56} />
          <div className="flex-1">
            <h2 className="text-xl font-bold" style={{ color: "#1a202c" }}>{m.name}</h2>
            <p className="text-sm font-bold" style={{ color: "#eab308" }}>#{m.member_number}</p>
            <div className="flex items-center gap-3 mt-1">
              <span className={`flex items-center gap-1 text-xs font-semibold ${m.status === "Active" ? "text-green-600" : "text-gray-400"}`}>
                <CheckCircle2 size={12} /> {m.status}
              </span>
              <button onClick={() => toggleStatus(m)} className="text-xs text-gray-400 hover:text-gray-600 underline">
                Mark {m.status === "Active" ? "Inactive" : "Active"}
              </button>
            </div>
          </div>
        </div>

        {/* Stats bar */}
        <div className="rounded-xl overflow-hidden grid grid-cols-2 md:grid-cols-3" style={{ background: "#1e2d4a" }}>
          {[
            { label: "Total Invested",  value: fmtKES(Number(m.investment_amount)) },
            { label: "Investor Since",  value: fmtDate(m.joined_date) },
            { label: "Status",          value: m.status },
          ].map((s, i) => (
            <div key={i} className="px-4 py-3 text-center border-r border-b last:border-r-0" style={{ borderColor: "rgba(255,255,255,0.08)" }}>
              <div className="text-sm font-bold text-white">{s.value}</div>
              <div className="text-xs mt-0.5" style={{ color: "#94a3b8" }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Contact info */}
        <div className="bg-white rounded-xl border p-4" style={{ borderColor: "var(--card-border)" }}>
          <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-3">Contact Info</h3>
          <div className="grid grid-cols-2 gap-4">
            {[
              { icon: <Phone size={13} color="#eab308" />,    bg: "#fefce8", label: "Phone",        val: m.phone },
              { icon: <IdCard size={13} color="#f97316" />,   bg: "#fff7ed", label: "ID/Passport",  val: m.id_passport },
              { icon: <Mail size={13} color="#3b82f6" />,     bg: "#eff6ff", label: "Email",        val: m.email },
              { icon: <Calendar size={13} color="#eab308" />, bg: "#fefce8", label: "Joined",       val: fmtDate(m.joined_date) },
            ].map((c) => (
              <div key={c.label} className="flex items-start gap-2.5">
                <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: c.bg }}>{c.icon}</div>
                <div>
                  <div className="text-xs text-gray-400">{c.label}</div>
                  <div className="text-sm font-semibold" style={{ color: "#1a202c" }}>{c.val || "—"}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Info box */}
        <div className="rounded-xl p-4 flex items-start gap-2" style={{ background: "#fefce8", border: "1px solid #fde68a" }}>
          <AlertCircle size={15} color="#ca8a04" className="mt-0.5 flex-shrink-0" />
          <div className="text-xs leading-relaxed" style={{ color: "#92400e" }}>
            <span className="font-semibold">Returns:</span> Quarterly based on project performance &nbsp;·&nbsp;
            <span className="font-semibold">Min. investment:</span> KES 50,000
          </div>
        </div>

        <Accordion icon={<TrendingUp size={16} />} label="Investment Portfolio" meta="" color="#eab308">
          <p className="py-2 text-gray-400 text-xs">Investment records will appear here.</p>
        </Accordion>
        <Accordion icon={<CircleDollarSign size={16} />} label="Returns / Profits" meta="" color="#22c55e">
          <p className="py-2 text-gray-400 text-xs">Return distributions will appear here.</p>
        </Accordion>
        <Accordion icon={<BookOpen size={16} />} label="Enrolled Projects" meta="" color="#f97316">
          <p className="py-2 text-gray-400 text-xs">Project enrollments will appear here.</p>
        </Accordion>
        <Accordion icon={<MapPin size={16} />} label="Allocated Plots" meta="" color="#ec4899">
          <p className="py-2 text-gray-400 text-xs">Plot allocations will appear here.</p>
        </Accordion>
      </div>
    </div>
  );

  return (
    <div className="flex h-full overflow-hidden">
      <MemberListPanel
        title="Ext. Investors" accentColor="#eab308"
        members={members} total={members.length}
        loading={loading} selected={selected}
        filter={filter} search={search} mobileDetail={mobileDetail}
        onFilterChange={setFilter} onSearchChange={setSearch}
        onSelect={(m) => { setSelected(m); setMobileDetail(true); }}
        onAddClick={() => setShowAdd(true)}
      />

      <div className={`flex-1 overflow-hidden ${mobileDetail ? "flex" : "hidden md:flex"} flex-col`} style={{ background: "var(--background)" }}>
        {selected ? renderDetail(selected) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#fefce8" }}>
              <CircleDollarSign size={30} color="#eab308" />
            </div>
            <p className="text-sm font-semibold text-gray-500">Select an investor to view details</p>
          </div>
        )}
      </div>

      {showAdd && (
        <MemberFormModal title="Investor" accentColor="#eab308"
          onClose={() => setShowAdd(false)} onSave={handleAdd} />
      )}
      {editTarget && (
        <MemberFormModal title="Investor" accentColor="#eab308"
          initial={editTarget}
          onClose={() => setEditTarget(null)} onSave={handleEdit} />
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
            <div className="h-1.5 w-full" style={{ background: "#ef4444" }} />
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
                  <Trash2 size={18} style={{ color: "#ef4444" }} />
                </div>
                <div>
                  <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Delete Investor</h2>
                  <p className="text-xs text-gray-500 mt-0.5">This action cannot be undone</p>
                </div>
              </div>
              <p className="text-sm text-gray-600">
                Are you sure you want to delete <span className="font-semibold" style={{ color: "#1a202c" }}>{deleteTarget.name}</span>? All records linked to this investor will also be removed.
              </p>
              <div className="flex gap-3 pt-1">
                <button onClick={() => setDeleteTarget(null)} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold border transition-colors hover:bg-gray-50 disabled:opacity-50"
                  style={{ borderColor: "var(--border)", color: "#64748b" }}>Cancel</button>
                <button onClick={handleDelete} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <><Loader2 size={14} className="animate-spin" /> Deleting…</> : <><Trash2 size={14} /> Delete</>}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────

// ─── Admin Dashboard ──────────────────────────────────────────────────────────

const adminDashMods = [
  { id: "shareholders" as Module, label: "Shareholders",  icon: <Users size={26} />,            iconColor: "#6366f1", iconBg: "#eef2ff" },
  { id: "clients"      as Module, label: "Clients",       icon: <UserCircle2 size={26} />,       iconColor: "#a855f7", iconBg: "#faf5ff" },
  { id: "contributions"as Module, label: "Contributions", icon: <Link2 size={26} />,             iconColor: "#ec4899", iconBg: "#fdf2f8" },
  { id: "projects"     as Module, label: "Projects",      icon: <FolderOpen size={26} />,        iconColor: "#22c55e", iconBg: "#f0fdf4" },
  { id: "investors"    as Module, label: "Investors",     icon: <CircleDollarSign size={26} />,  iconColor: "#eab308", iconBg: "#fefce8" },
  { id: "payments"     as Module, label: "Payments",         icon: <CreditCard size={26} />,        iconColor: "#14b8a6", iconBg: "#f0fdfa" },
  { id: "refunds"      as Module, label: "Refunds",       icon: <RotateCcw size={26} />,         iconColor: "#ef4444", iconBg: "#fef2f2" },
  { id: "reports"      as Module, label: "Reports",       icon: <BarChart2 size={26} />,         iconColor: "#3b82f6", iconBg: "#eff6ff" },
];

function AdminDashboard({ onNavigate }: { onNavigate: (m: Module) => void }) {
  const [stats, setStats] = useState<{ shareholders: number; clients: number; investors: number; totalCollected: number; thisMonth: number; overdueCount: number; plots: number; assignedPlots: number } | null>(null);
  const [monthlyCollections, setMonthlyCollections] = useState<Array<{ month: string; amount: number }>>([]);
  const [memberDist, setMemberDist] = useState<Array<{ name: string; value: number; color: string }>>([]);
  const [plotStatusDist, setPlotStatusDist] = useState<Array<{ name: string; value: number; color: string }>>([]);
  const [paymentBreakdown, setPaymentBreakdown] = useState<Array<{ name: string; completed: number; pending: number }>>([]);
  const [totalProfits, setTotalProfits] = useState<number | null>(null);
  const [profitsByProject, setProfitsByProject] = useState<Array<{ name: string; total: number; count: number; isActive: boolean }>>([]);
  const [projectCostProfit, setProjectCostProfit] = useState<Array<{ name: string; cost: number; profit: number; year: number }>>([]);
  const [showProfitsModal, setShowProfitsModal] = useState(false);

  useEffect(() => {
    (async () => {
      const now = new Date(); const { month, year } = getBillingPeriod(now);
      const [shR, clR, invR, totR, monR, plotR, payR, contribAllR] = await Promise.all([
        supabase.from("shareholders").select("id", { count: "exact", head: true }),
        supabase.from("clients").select("id", { count: "exact", head: true }).eq("status", "Active"),
        supabase.from("investors").select("id", { count: "exact", head: true }),
        supabase.from("contributions").select("amount"),
        supabase.from("contributions").select("amount, status").eq("month", month).eq("year", year),
        supabase.from("plots").select("id, status"),
        supabase.from("payments").select("id, amount, purpose, created_at, status, member_type").order("created_at", { ascending: false }).limit(30),
        supabase.from("contributions").select("amount, month, year").order("year", { ascending: true }).order("month", { ascending: true }),
      ]);

      const shCount  = shR.count ?? 0;
      const clCount  = clR.count ?? 0;
      const invCount = invR.count ?? 0;

      setStats({
        shareholders: shCount, clients: clCount, investors: invCount,
        totalCollected: (totR.data ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0),
        thisMonth: (monR.data ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0),
        overdueCount: (monR.data ?? []).filter((r: any) => r.status === "late").length,
        plots: (plotR.data ?? []).length,
        assignedPlots: (plotR.data ?? []).filter((p: any) => p.status === "assigned" || p.status === "sold").length,
      });

      // Member distribution pie
      setMemberDist([
        { name: "Shareholders", value: shCount,  color: "#6366f1" },
        { name: "Clients",      value: clCount,  color: "#a855f7" },
        { name: "Investors",    value: invCount, color: "#eab308" },
      ].filter((d) => d.value > 0));

      // Plot status pie
      const plots = plotR.data ?? [];
      const avail    = plots.filter((p: any) => p.status === "available").length;
      const assigned = plots.filter((p: any) => p.status === "assigned").length;
      const sold     = plots.filter((p: any) => p.status === "sold").length;
      setPlotStatusDist([
        { name: "Available", value: avail,    color: "#22c55e" },
        { name: "Assigned",  value: assigned, color: "#3b82f6" },
        { name: "Sold",      value: sold,     color: "#f97316" },
      ].filter((d) => d.value > 0));

      // Monthly collections bar chart (last 6 months)
      const last6: Record<string, number> = {};
      for (let i = 5; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1);
        last6[`${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`] = 0;
      }
      (contribAllR.data ?? []).forEach((c: any) => {
        const key = `${MONTHS[c.month - 1].slice(0, 3)} ${c.year}`;
        if (key in last6) last6[key] += Number(c.amount);
      });
      setMonthlyCollections(Object.entries(last6).map(([m, amount]) => ({ month: m, amount })));

      // Payment breakdown by member type (last 30)
      const pays = payR.data ?? [];
      const types = ["shareholder", "client", "investor"];
      setPaymentBreakdown(types.map((t) => {
        const tPays = pays.filter((p: any) => p.member_type === t);
        return {
          name: t.charAt(0).toUpperCase() + t.slice(1),
          completed: tPays.filter((p: any) => p.status === "completed").reduce((s: number, p: any) => s + Number(p.amount), 0),
          pending:   tPays.filter((p: any) => p.status === "pending").reduce((s: number, p: any) => s + Number(p.amount), 0),
        };
      }).filter((d) => d.completed > 0 || d.pending > 0));

      // Total profits distributed, grouped by project
      const { data: distRows } = await supabase
        .from("profit_distributions")
        .select("amount, project:projects(id, project_name, date_completed)");
      if (distRows) {
        const byProject: Record<string, { name: string; total: number; count: number; isActive: boolean }> = {};
        distRows.forEach((d: any) => {
          const key = String(d.project?.id ?? "unknown");
          const name = d.project?.project_name ?? `Project #${key}`;
          const isActive = !d.project?.date_completed;
          if (!byProject[key]) byProject[key] = { name, total: 0, count: 0, isActive };
          byProject[key].total += Number(d.amount);
          byProject[key].count += 1;
        });
        const rows = Object.values(byProject).sort((a, b) => a.name.localeCompare(b.name));
        setProfitsByProject(rows);
        setTotalProfits(rows.reduce((s, r) => s + r.total, 0));
      }

      // Projects cost vs profit bar chart
      const { data: projRows } = await supabase
        .from("projects")
        .select("project_name, project_cost, net_profit, date_started, date_completed")
        .order("date_started", { ascending: true });
      if (projRows) {
        setProjectCostProfit(projRows.map((p: any) => ({
          name: p.project_name ?? "Unnamed",
          cost: Number(p.project_cost ?? 0),
          profit: Number(p.net_profit ?? 0),
          year: p.date_started ? new Date(p.date_started).getFullYear() : new Date().getFullYear(),
        })));
      }
    })();
  }, []);

  const ChartSkeleton = () => <div className="h-36 w-full animate-pulse rounded-xl" style={{ background: "#f1f5f9" }} />;
  const statusColor = (s: string) => s === "completed" ? "#10b981" : s === "pending" ? "#f59e0b" : "#94a3b8";

  return (
    <>
    <div className="p-4 md:p-6 flex flex-col lg:flex-row gap-6 min-h-0">

      {/* ── Left column ── */}
      <div className="flex flex-col gap-5 w-full lg:w-[380px] xl:w-[420px] flex-shrink-0">
        {/* Admin identity card */}
        <div className="rounded-2xl overflow-hidden">
          <div className="p-5 flex items-center gap-4" style={{ background: "#1e2d4a" }}>
            <div className="w-12 h-12 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0" style={{ background: "#22c55e" }}>SA</div>
            <div className="flex-1">
              <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "#94a3b8" }}>Administrator</p>
              <h2 className="text-lg font-bold text-white">System Admin</h2>
            </div>
            <span className="text-xs font-semibold px-3 py-1 rounded-full border" style={{ color: "#e2e8f0", borderColor: "#334155" }}>ADMIN</span>
          </div>
          <div className="px-5 py-2.5 flex items-center gap-2" style={{ background: "#253450" }}>
            <CheckCircle2 size={13} style={{ color: "#22c55e" }} />
            <span className="text-sm" style={{ color: "#94a3b8" }}>Full system access</span>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3">
          {[
            { label: "Shareholders",    value: stats ? String(stats.shareholders)       : "—",     sub: "Total members",  icon: <Users size={20} />,          iconColor: "#6366f1", iconBg: "#eef2ff" },
            { label: "Total Collected", value: stats ? fmtKESFull(stats.totalCollected) : "KES —", sub: "All time",       icon: <Link2 size={20} />,          iconColor: "#22c55e", iconBg: "#f0fdf4" },
            { label: "Clients",         value: stats ? String(stats.clients)            : "—",     sub: "Active",         icon: <UserCircle2 size={20} />,    iconColor: "#a855f7", iconBg: "#faf5ff" },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl p-4 flex items-center gap-3 border" style={{ borderColor: "var(--card-border)" }}>
              <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: s.iconBg, color: s.iconColor }}>{s.icon}</div>
              <div><div className="text-xl font-bold" style={{ color: "#1a202c" }}>{s.value}</div><div className="text-xs font-semibold" style={{ color: s.iconColor }}>{s.label}</div><div className="text-xs text-gray-400">{s.sub}</div></div>
            </div>
          ))}
          {/* Total Profits card — clickable */}
          <button onClick={() => setShowProfitsModal(true)}
            className="bg-white rounded-xl p-4 flex items-center gap-3 border text-left hover:shadow-md transition-shadow"
            style={{ borderColor: "var(--card-border)" }}>
            <div className="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center" style={{ background: "#fefce8", color: "#ca8a04" }}>
              <TrendingUp size={20} />
            </div>
            <div>
              <div className="text-xl font-bold" style={{ color: "#1a202c" }}>
                {totalProfits === null ? "KES —" : fmtKESFull(totalProfits)}
              </div>
              <div className="text-xs font-semibold" style={{ color: "#ca8a04" }}>Total Profits Assigned</div>
              <div className="text-xs text-gray-400">{profitsByProject.length} project{profitsByProject.length !== 1 ? "s" : ""} · tap to view</div>
            </div>
          </button>
        </div>

        {/* Modules grid */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Modules</h3>
          <div className="grid grid-cols-3 gap-2.5">
            {adminDashMods.map((mod) => (
              <button key={mod.id} onClick={() => onNavigate(mod.id)}
                className="bg-white rounded-xl p-3 flex flex-col items-center gap-2 border hover:shadow-md transition-shadow"
                style={{ borderColor: "var(--card-border)" }}>
                <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: mod.iconBg, color: mod.iconColor }}>{mod.icon}</span>
                <span className="text-[10px] font-medium text-center leading-tight" style={{ color: "#374151" }}>{mod.label}</span>
              </button>
            ))}
          </div>
        </div>

      </div>

      {/* ── Right column: Analytics ── */}
      <div className="flex-1 flex flex-col gap-5 min-w-0">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">System Analytics</h2>

        {/* Row 1: Member Distribution + Plot Status side by side */}
        <div className="grid grid-cols-2 gap-3">
          {/* Member Distribution */}
          <div className="bg-white rounded-2xl border p-3 flex flex-col gap-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold" style={{ color: "#1a202c" }}>Members</p>
                <p className="text-[10px] text-gray-400">By type</p>
              </div>
              <div className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: "#eef2ff", color: "#6366f1" }}><Users size={13} /></div>
            </div>
            {stats ? (
              memberDist.length > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <RechartPieChart width={90} height={90}>
                    <Pie data={memberDist} cx={42} cy={42} innerRadius={24} outerRadius={40} paddingAngle={3} dataKey="value" strokeWidth={0}>
                      {memberDist.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                  </RechartPieChart>
                  <div className="w-full flex flex-col gap-1">
                    {memberDist.map((d) => (
                      <div key={d.name} className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.color }} />
                        <span className="text-[10px] text-gray-500 flex-1 truncate">{d.name}</span>
                        <span className="text-[10px] font-bold" style={{ color: "#1a202c" }}>{d.value}</span>
                      </div>
                    ))}
                    <div className="pt-1 border-t text-[10px] text-gray-400" style={{ borderColor: "var(--border)" }}>
                      Total: <span className="font-bold text-gray-700">{memberDist.reduce((s, d) => s + d.value, 0)}</span>
                    </div>
                  </div>
                </div>
              ) : <p className="text-[10px] text-gray-400 py-6 text-center">No members</p>
            ) : <ChartSkeleton />}
          </div>

          {/* Plot Status */}
          <div className="bg-white rounded-2xl border p-3 flex flex-col gap-2" style={{ borderColor: "var(--card-border)" }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-bold" style={{ color: "#1a202c" }}>Plots</p>
                <p className="text-[10px] text-gray-400">By status</p>
              </div>
              <div className="w-7 h-7 rounded-xl flex items-center justify-center" style={{ background: "#ecfdf5", color: "#059669" }}><MapPin size={13} /></div>
            </div>
            {stats ? (
              plotStatusDist.length > 0 ? (
                <div className="flex flex-col items-center gap-2">
                  <RechartPieChart width={90} height={90}>
                    <Pie data={plotStatusDist} cx={42} cy={42} innerRadius={24} outerRadius={40} paddingAngle={3} dataKey="value" strokeWidth={0}>
                      {plotStatusDist.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                  </RechartPieChart>
                  <div className="w-full flex flex-col gap-1">
                    {plotStatusDist.map((d) => (
                      <div key={d.name} className="flex items-center gap-1.5">
                        <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: d.color }} />
                        <span className="text-[10px] text-gray-500 flex-1 truncate">{d.name}</span>
                        <span className="text-[10px] font-bold" style={{ color: "#1a202c" }}>{d.value}</span>
                      </div>
                    ))}
                    <div className="pt-1 border-t text-[10px] text-gray-400" style={{ borderColor: "var(--border)" }}>
                      Total: <span className="font-bold text-gray-700">{stats.plots}</span>
                    </div>
                  </div>
                </div>
              ) : <p className="text-[10px] text-gray-400 py-6 text-center">No plots</p>
            ) : <ChartSkeleton />}
          </div>
        </div>

        {/* Row 2: Project Cost vs Profit bar chart */}
        <div className="bg-white rounded-2xl border p-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Project Cost vs Profit</p>
              <p className="text-xs text-gray-400">All projects</p>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-gray-400">
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "#ef4444" }} />Cost</span>
              <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: "#22c55e" }} />Profit</span>
            </div>
          </div>
          {projectCostProfit.length > 0 ? (
            <RechartBarChart width={320} height={180} data={projectCostProfit} margin={{ top: 4, right: 8, left: 0, bottom: 30 }}
              style={{ width: "100%", maxWidth: "100%" }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 9, fill: "#94a3b8" }} angle={-35} textAnchor="end" interval={0} />
              <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickFormatter={(v: number) => `${(v/1e6).toFixed(1)}M`} />
              <Tooltip formatter={(v: number) => fmtKESFull(v)} labelStyle={{ fontSize: 11, fontWeight: 600 }} contentStyle={{ borderRadius: 10, fontSize: 11 }} />
              <Bar dataKey="cost" name="Cost" fill="#ef4444" radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar dataKey="profit" name="Profit" fill="#22c55e" radius={[4, 4, 0, 0]} maxBarSize={28} />
            </RechartBarChart>
          ) : <ChartSkeleton />}
        </div>

        {/* Row 3: System Summary */}
        {stats && (
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--card-border)" }}>
            <p className="text-sm font-bold mb-4" style={{ color: "#1a202c" }}>System Summary</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="text-center p-3 rounded-xl" style={{ background: "#eef2ff" }}>
                <div className="text-lg font-bold" style={{ color: "#6366f1" }}>{stats.shareholders}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Shareholders</div>
              </div>
              <div className="text-center p-3 rounded-xl" style={{ background: "#faf5ff" }}>
                <div className="text-lg font-bold" style={{ color: "#a855f7" }}>{stats.clients}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Clients</div>
              </div>
              <div className="text-center p-3 rounded-xl" style={{ background: "#f0fdf4" }}>
                <div className="text-lg font-bold" style={{ color: "#22c55e" }}>{fmtKESFull(stats.totalCollected)}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Total Collected</div>
              </div>
              <div className="text-center p-3 rounded-xl" style={{ background: "#ecfdf5" }}>
                <div className="text-lg font-bold" style={{ color: "#059669" }}>{stats.assignedPlots}/{stats.plots}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Plots Assigned</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>

    {/* ── Total Profits Modal ── */}

    {showProfitsModal && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={(e) => { if (e.target === e.currentTarget) setShowProfitsModal(false); }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#fefce8", borderColor: "#fde68a" }}>
            <div>
              <p className="font-bold text-base" style={{ color: "#92400e" }}>Total Profits Assigned</p>
              <p className="text-xs" style={{ color: "#b45309" }}>All distributions per project</p>
            </div>
            <button onClick={() => setShowProfitsModal(false)}
              className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-amber-100">
              <X size={16} style={{ color: "#b45309" }} />
            </button>
          </div>
          <div className="px-5 py-4 max-h-[60vh] overflow-y-auto">
            {profitsByProject.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No profit distributions recorded yet.</p>
            ) : (
              <>
                {profitsByProject.map((r, i) => (
                  <div key={r.name} className={`flex items-center justify-between py-3 ${i < profitsByProject.length - 1 ? "border-b" : ""}`}
                    style={{ borderColor: "var(--border)" }}>
                    <div>
                      <p className="text-sm font-semibold" style={{ color: "#1a202c" }}>{r.name}</p>
                      <p className="text-xs" style={{ color: r.isActive ? "#dc2626" : "#9ca3af" }}>
                        {r.isActive ? "Estimated · active project" : `${r.count} distribution${r.count !== 1 ? "s" : ""}`}
                      </p>
                    </div>
                    <div className="flex flex-col items-end gap-0.5">
                      <p className="text-sm font-bold" style={{ color: r.isActive ? "#dc2626" : "#ca8a04" }}>{fmtKESFull(r.total)}</p>
                      {r.isActive && (
                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#fef2f2", color: "#dc2626" }}>Estimated</span>
                      )}
                    </div>
                  </div>
                ))}
                <div className="mt-3 pt-3 border-t flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
                  <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Grand Total</p>
                  <p className="text-base font-extrabold" style={{ color: "#ca8a04" }}>{fmtKESFull(totalProfits ?? 0)}</p>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ─── Member Dashboard (Shareholder / Client / Investor) ───────────────────────

function MemberDashboard({ onNavigate }: { onNavigate: (m: Module) => void }) {
  const profile = useProfile()!;
  const isSH   = profile.role === "shareholder";
  const isCL   = profile.role === "client";
  const mid    = profile.member_id;
  const mtype  = profile.role as "shareholder" | "client" | "investor";

  const [memberInfo, setMemberInfo] = useState<{ name: string; member_number: number | null; photo_url?: string | null } | null>(null);
  const [stats, setStats] = useState<{
    totalContributed: number; contributionCount: number; thisMonth: number;
    plotCount: number; paymentCount: number; pendingPayments: number;
  } | null>(null);
  const [activity, setActivity] = useState<Array<{ key: string; type: string; label: string; amount: number; date: string }>>([]);
  const [monthlyContribs, setMonthlyContribs] = useState<Array<{ year: string; amount: number }>>([]);
  const [monthlyPayments, setMonthlyPayments] = useState<Array<{ month: string; total: number }>>([]);
  const [plotsData, setPlotsData] = useState<Array<{ name: string; paid: number; remaining: number; pct: number }>>([]);
  const [thisMonthPlotPaid, setThisMonthPlotPaid] = useState(0);
  const [paymentStatus, setPaymentStatus] = useState<Array<{ name: string; value: number; color: string }>>([]);
  const [cumulativeSavings, setCumulativeSavings] = useState<Array<{ month: string; total: number }>>([]);
  const [reloadKey, setReloadKey] = useState(0);
  const [pendingScroll, setPendingScroll] = useState<"plot" | null>(null);
  const plotSectionRef = useRef<HTMLDivElement>(null);

  // Net Profits modal
  const [showNetProfits, setShowNetProfits] = useState(false);
  const [profitDists, setProfitDists] = useState<(ProfitDistribution & { project?: Project })[]>([]);
  const [profitLoading, setProfitLoading] = useState(false);
  const [profitLoaded, setProfitLoaded] = useState(false);

  const loadProfitDists = async () => {
    if (!mid || !isSH || profitLoaded) return;
    setProfitLoading(true);
    try { setProfitDists(await profitDistributionsApi.listByShareholder(mid)); setProfitLoaded(true); }
    catch { /* ignore */ }
    finally { setProfitLoading(false); }
  };

  const openNetProfits = () => {
    setShowNetProfits(true);
    loadProfitDists();
  };

  // Click to Pay flow
  const [showPayChoice, setShowPayChoice] = useState(false);
  const [payFlowType, setPayFlowType] = useState<"plot" | "contribution" | null>(null);
  const [memberPlots, setMemberPlots] = useState<(Plot & { project?: Project })[]>([]);
  const [memberShareholder, setMemberShareholder] = useState<Shareholder | null>(null);
  const [plotPayTarget, setPlotPayTarget] = useState<(Plot & { project?: Project }) | null>(null);
  const [plotPayStep, setPlotPayStep] = useState<"select" | "amount" | "method" | null>(null);
  const [plotPayAmount, setPlotPayAmount] = useState("");

  const loadMemberPlots = useCallback(async () => {
    if (!mid || mtype === "investor") return;
    const data = await plotsApi.listByMember(mid, mtype as "shareholder" | "client");
    setMemberPlots(data);
  }, [mid, mtype]);

  const loadMemberShareholder = useCallback(async () => {
    if (!mid || !isSH) return;
    const data = await shareholdersApi.list({});
    const sh = data.find((s: Shareholder) => s.id === mid);
    if (sh) setMemberShareholder(sh);
  }, [mid, isSH]);

  const openPayChoice = async () => {
    setShowPayChoice(true);
    await Promise.all([loadMemberPlots(), loadMemberShareholder()]);
  };

  const closeAllPay = () => {
    setShowPayChoice(false);
    setPayFlowType(null);
    setPlotPayTarget(null);
    setPlotPayStep(null);
    setPlotPayAmount("");
  };

  const startPlotPay = () => {
    setShowPayChoice(false);
    setPayFlowType("plot");
    setPlotPayStep(memberPlots.length === 1 ? "amount" : "select");
    if (memberPlots.length === 1) setPlotPayTarget(memberPlots[0]);
  };

  const startContribPay = () => {
    setShowPayChoice(false);
    setPayFlowType("contribution");
  };

  const plotDue = plotPayTarget ? Math.max(0, Number(plotPayTarget.price) - Number(plotPayTarget.paid_amount)) : 0;
  const parsedPlotAmt = Math.min(parseFloat(plotPayAmount) || 0, plotDue);

  const handlePlotPayComplete = async (method: PayMethod, ref?: string, _viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => {
    if (!plotPayTarget) return;
    await plotsApi.recordPayment(plotPayTarget.id, parsedPlotAmt, ref ? `${method} — ${ref}` : method);
    logActivity({ category: "plot", action: "payment", description: `Plot ${plotPayTarget.plot_number} payment of KES ${parsedPlotAmt.toLocaleString()} via ${method} by ${memberInfo?.name ?? "member"}`, meta: { plot_id: plotPayTarget.id, amount: parsedPlotAmt, method } });
    if (method === "mpesa") {
      const baseComment = `PHONE:${phone ?? ""}|ACCOUNT:${plotPayTarget.plot_number}|${plotPayTarget.plot_number}`;
      await paymentsApi.create({
        payment_id: ref ?? undefined,
        date_paid: new Date().toISOString().slice(0, 10),
        amount: parsedPlotAmt,
        paid_by: extras?.paidBy || memberInfo?.name || "",
        purpose: "Plot Payment",
        mode: "Mpesa",
        comment: extras?.comment ? `${baseComment} · ${extras.comment}` : baseComment,
      });
    }
    closeAllPay();
    setPendingScroll("plot");
    setReloadKey((k) => k + 1);
  };

  useEffect(() => {
    if (!mid) return;
    (async () => {
      const now = new Date(); const { month, year } = getBillingPeriod(now);
      const [mRes, plotRes, payRes] = await Promise.all([
        supabase.from(mtype + "s").select(isSH ? "name, member_number, net_savings, photo_url" : "name, member_number, photo_url").eq("id", mid).maybeSingle(),
        supabase.from("plots").select("id, plot_number, price, paid_amount, status").eq("assigned_to_id", mid).eq("assigned_to_type", mtype),
        supabase.from("payments").select("id, amount, purpose, created_at, status").eq("member_id", mid).eq("member_type", mtype).order("created_at", { ascending: false }).limit(20),
      ]);
      if (mRes.data) setMemberInfo(mRes.data as any);

      let totalContributed = 0, contributionCount = 0, thisMonth = 0;
      const acts: typeof activity = [];

      if (isSH) {
        const [cAll, cMon] = await Promise.all([
          supabase.from("contributions").select("id, amount, month, year, created_at").eq("shareholder_id", mid).order("year", { ascending: true }).order("month", { ascending: true }),
          supabase.from("contributions").select("amount").eq("shareholder_id", mid).eq("month", month).eq("year", year),
        ]);
        const allContribs = cAll.data ?? [];
        const rawSum = allContribs.reduce((s: number, r: any) => s + Number(r.amount), 0);
        // Use net_savings as authoritative balance — it reflects refunds deducted by admin.
        // Only fall back to rawSum when net_savings is null (never set), not when it's 0.
        const netSavingsRaw = (mRes.data as any)?.net_savings;
        totalContributed = netSavingsRaw != null ? Math.max(0, Number(netSavingsRaw)) : rawSum;
        contributionCount = allContribs.length;
        thisMonth = (cMon.data ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
        allContribs.slice(-3).forEach((c: any) => acts.push({ key: "c"+c.id, type: "contribution", label: `Contribution – ${MONTHS[c.month-1]} ${c.year}`, amount: Number(c.amount), date: c.created_at }));

        // Per-year contribution totals
        const byYear: Record<string, number> = {};
        allContribs.forEach((c: any) => {
          const y = String(c.year);
          byYear[y] = (byYear[y] ?? 0) + Number(c.amount);
        });
        const sortedYears = Object.keys(byYear).sort();
        setMonthlyContribs(sortedYears.map((y) => ({ year: y, amount: byYear[y] })));

        // Cumulative savings area chart
        let running = 0;
        const cum: typeof cumulativeSavings = [];
        allContribs.forEach((c: any) => {
          running += Number(c.amount);
          cum.push({ month: `${MONTHS[c.month - 1].slice(0, 3)} ${c.year}`, total: running });
        });
        setCumulativeSavings(cum.length > 12 ? cum.slice(-12) : cum);
      }

      const plots = plotRes.data ?? [];
      const pays  = payRes.data  ?? [];

      // For clients/investors: sum plot payments made this month
      if (!isSH && plots.length > 0) {
        const plotIds = plots.map((pl: any) => pl.id);
        const monthStart = new Date(year, month - 1, 1).toISOString().slice(0, 10);
        const monthEnd   = new Date(year, month, 0).toISOString().slice(0, 10);
        const { data: ppMon } = await supabase
          .from("plot_payments")
          .select("amount")
          .in("plot_id", plotIds)
          .gte("payment_date", monthStart)
          .lte("payment_date", monthEnd);
        setThisMonthPlotPaid((ppMon ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0));
      }

      plots.slice(0, 2).forEach((pl: any) => acts.push({ key: "pl"+pl.id, type: "plot", label: "Plot allocated", amount: Number(pl.price), date: "" }));
      pays.slice(0, 3).forEach((p: any)  => acts.push({ key: "py"+p.id,  type: "payment", label: p.purpose ?? "Payment", amount: Number(p.amount), date: p.created_at }));
      acts.sort((a, b) => (b.date > a.date ? 1 : -1));

      // Plot payment progress
      setPlotsData(plots.map((pl: any) => {
        const price = Number(pl.price) || 0;
        const paid  = Math.min(Number(pl.paid_amount) || 0, price);
        return { name: `Plot ${pl.plot_number}`, paid, remaining: Math.max(price - paid, 0), pct: price > 0 ? Math.round((paid / price) * 100) : 0 };
      }));

      // Payment status donut
      const paidAmt    = pays.filter((p: any) => p.status === "completed").reduce((s: number, p: any) => s + Number(p.amount), 0);
      const pendingAmt = pays.filter((p: any) => p.status === "pending").reduce((s: number, p: any) => s + Number(p.amount), 0);
      const otherAmt   = pays.filter((p: any) => p.status !== "completed" && p.status !== "pending").reduce((s: number, p: any) => s + Number(p.amount), 0);
      const pieData: Array<{ name: string; value: number; color: string }> = [];
      if (paidAmt > 0)    pieData.push({ name: "Completed", value: paidAmt, color: "#10b981" });
      if (pendingAmt > 0) pieData.push({ name: "Pending",   value: pendingAmt, color: "#f59e0b" });
      if (otherAmt > 0)   pieData.push({ name: "Other",     value: otherAmt, color: "#94a3b8" });
      if (pieData.length === 0) pieData.push({ name: "No Payments", value: 1, color: "#e2e8f0" });
      setPaymentStatus(pieData);

      // Monthly payment history bar chart (last 6 months, single series total)
      const last6pay: Record<string, number> = {};
      for (let i = 5; i >= 0; i--) {
        const d = new Date(year, month - 1 - i, 1);
        last6pay[`${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`] = 0;
      }
      pays.forEach((p: any) => {
        const d = new Date(p.created_at);
        const key = `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getFullYear()}`;
        if (key in last6pay) last6pay[key] += Number(p.amount);
      });
      setMonthlyPayments(Object.entries(last6pay).map(([month, total]) => ({ month, total })));

      setStats({ totalContributed, contributionCount, thisMonth, plotCount: plots.length, paymentCount: pays.length, pendingPayments: pays.filter((p: any) => p.status === "pending").length });
      setActivity(acts.slice(0, 5));
    })();
    if (isSH) loadProfitDists();
  }, [mid, mtype, isSH, reloadKey]);

  // Scroll to the plot section after a plot payment reload
  useEffect(() => {
    if (!pendingScroll) return;
    const target = plotSectionRef.current;
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
    setPendingScroll(null);
  }, [pendingScroll]);

  const name    = memberInfo?.name ?? profile.full_name ?? "";
  const avi     = name.split(" ").slice(0, 2).map((w: string) => w[0] ?? "").join("").toUpperCase() || "?";
  const roleLbl = profile.role.charAt(0).toUpperCase() + profile.role.slice(1);

  const quickActions: Array<{ label: string; icon: React.ReactNode; bg: string; color: string; mod: Module }> = [
    ...(isSH ? [{ label: "Contributions", icon: <Link2 size={18} />,  bg: "#fdf2f8", color: "#ec4899", mod: "contributions" as Module }] : []),
    { label: "My Plots", icon: <MapPin size={18} />, bg: "#ecfdf5", color: "#059669", mod: "my-plots" as Module },
    ...(isCL ? [{ label: "Refunds", icon: <RotateCcw size={18} />,    bg: "#fef2f2", color: "#ef4444", mod: "refunds"   as Module }] : []),
    ...(!isCL ? [{ label: "Projects", icon: <FolderOpen size={18} />, bg: "#f0fdf4", color: "#22c55e", mod: "projects" as Module }] : []),
    { label: "Settings",   icon: <SlidersHorizontal size={18} />, bg: "#f8fafc", color: "#64748b", mod: "settings"  as Module },
  ];

  const dotColor = (type: string) => type === "contribution" ? "#ec4899" : type === "payment" ? "#14b8a6" : "#059669";
  const totalPayAmt = paymentStatus.reduce((s, d) => s + (d.name !== "No Payments" ? d.value : 0), 0);
  const ChartSkeleton = () => <div className="h-36 w-full animate-pulse rounded-xl" style={{ background: "#f1f5f9" }} />;

  return (
    <>
    <div className="p-4 md:p-6 flex flex-col lg:flex-row gap-6 min-h-0">

      {/* ── Left column ── */}
      <div className="flex flex-col gap-5 w-full lg:w-[400px] xl:w-[440px] flex-shrink-0">
        {/* Identity card */}
        <div className="rounded-2xl overflow-hidden shadow-sm">
          <div className="p-5 flex items-center gap-4" style={{ background: "linear-gradient(135deg,#312e81 0%,#4338ca 55%,#6366f1 100%)" }}>
            {/* Text info — left */}
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wider mb-0.5" style={{ color: "rgba(255,255,255,0.55)" }}>{roleLbl}</p>
              <h2 className="text-base font-bold text-white truncate">{name}</h2>
              {memberInfo?.member_number && (
                <p className="text-xs" style={{ color: "rgba(255,255,255,0.65)" }}>Member No. <span style={{ color: "#fbbf24" }}>#{memberInfo.member_number}</span></p>
              )}
            </div>
            {/* Photo — right, larger */}
            {memberInfo?.photo_url ? (
              <img src={memberInfo.photo_url} alt={name} className="w-20 h-20 rounded-2xl object-cover flex-shrink-0" style={{ border: "3px solid rgba(255,255,255,0.35)" }} />
            ) : (
              <div className="w-20 h-20 rounded-2xl flex items-center justify-center text-2xl font-bold text-white flex-shrink-0" style={{ background: "rgba(255,255,255,0.18)" }}>{avi}</div>
            )}
          </div>
          <div className="px-5 py-2.5 flex items-center gap-2" style={{ background: "#1e2d4a" }}>
            <CheckCircle2 size={13} style={{ color: "#22c55e" }} />
            <span className="text-xs" style={{ color: "#94a3b8" }}>Account active · View-only access</span>
          </div>
        </div>

        {/* Click to Pay card */}
        <button onClick={openPayChoice}
          className="w-full rounded-2xl overflow-hidden shadow-sm hover:shadow-lg transition-all active:scale-[0.98] text-left"
          style={{ background: "linear-gradient(135deg, #15803d 0%, #16a34a 50%, #22c55e 100%)" }}>
          <div className="px-5 py-4 flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl flex items-center justify-center flex-shrink-0"
              style={{ background: "rgba(255,255,255,0.18)" }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.15)" />
                <text x="16" y="22" textAnchor="middle" fontSize="18" fill="white" fontWeight="900" fontFamily="Arial">M</text>
                <circle cx="24" cy="10" r="5" fill="#ef4444" />
                <text x="24" y="13" textAnchor="middle" fontSize="7" fill="white" fontWeight="bold" fontFamily="Arial">P</text>
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-bold uppercase tracking-widest mb-0.5" style={{ color: "rgba(255,255,255,0.65)" }}>M-Pesa Payment</p>
              <h3 className="text-lg font-extrabold text-white">Click to Pay</h3>
              <p className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.75)" }}>Contribute · Plot Payment</p>
            </div>
            <div className="flex-shrink-0">
              <div className="w-10 h-10 rounded-full flex items-center justify-center"
                style={{ background: "rgba(255,255,255,0.2)" }}>
                <ChevronRight size={20} color="white" />
              </div>
            </div>
          </div>
          <div className="px-5 pb-3 flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-white animate-pulse" />
            <span className="text-xs font-semibold" style={{ color: "rgba(255,255,255,0.8)" }}>Instant M-Pesa STK Push</span>
          </div>
        </button>


        {/* Stat cards */}
        <div className="grid grid-cols-2 gap-3">
          {isSH && stats && <>
            <div className="bg-white rounded-xl p-4 border" style={{ borderColor: "var(--card-border)" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: "#fdf2f8", color: "#ec4899" }}><Link2 size={17} /></div>
              <div className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(stats.totalContributed)}</div>
              <div className="text-xs font-semibold" style={{ color: "#ec4899" }}>Net Savings</div>
              <div className="text-xs text-gray-400">{stats.contributionCount} contributions</div>
            </div>
            <button onClick={openNetProfits}
              className="bg-white rounded-xl p-4 border text-left hover:shadow-md transition-shadow active:scale-[0.98]"
              style={{ borderColor: "var(--card-border)" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: "#fef9c3", color: "#ca8a04" }}><TrendingUp size={17} /></div>
              <div className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(profitDists.reduce((s, d) => s + Number(d.amount), 0))}</div>
              <div className="text-xs font-semibold" style={{ color: "#ca8a04" }}>Net Profits</div>
              <div className="text-xs text-gray-400">Tap to view per project</div>
            </button>
          </>}
          {stats && <>
            <div className="bg-white rounded-xl p-4 border" style={{ borderColor: "var(--card-border)" }}>
              <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: "#fff7ed", color: "#f97316" }}><Calendar size={17} /></div>
              <div className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(isSH ? stats.thisMonth : thisMonthPlotPaid)}</div>
              <div className="text-xs font-semibold" style={{ color: "#f97316" }}>This Month</div>
              <div className="text-xs text-gray-400">{isSH ? "Contribution" : "Plot payment"}</div>
            </div>
            {isSH && (
              <div className="bg-white rounded-xl p-4 border" style={{ borderColor: "var(--card-border)" }}>
                <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: "#eef2ff", color: "#6366f1" }}><TrendingUp size={17} /></div>
                <div className="text-xl font-bold" style={{ color: "#1a202c" }}>
                  {fmtKESFull(stats.totalContributed + profitDists.reduce((s, d) => s + Number(d.amount), 0))}
                </div>
                <div className="text-xs font-semibold" style={{ color: "#6366f1" }}>Cumulative</div>
                <div className="text-xs text-gray-400">Savings + Profits</div>
              </div>
            )}
            {/* Plot Payments stat — clients/investors only, paired with This Month */}
            {!isSH && (() => {
              const totalPaid = plotsData.reduce((s, p) => s + p.paid, 0);
              const done = plotsData.filter((p) => p.pct >= 100).length;
              return (
                <div className="bg-white rounded-xl p-4 border" style={{ borderColor: "var(--card-border)" }}>
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2" style={{ background: "#ecfdf5", color: "#059669" }}><MapPin size={17} /></div>
                  <div className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(totalPaid)}</div>
                  <div className="text-xs font-semibold" style={{ color: "#059669" }}>Plot Payments</div>
                  <div className="text-xs text-gray-400">{plotsData.length} plot{plotsData.length !== 1 ? "s" : ""}{done > 0 ? `, ${done} complete` : ""}</div>
                </div>
              );
            })()}
          </>}
          {!stats && [0,1,2,3].map((i) => <div key={i} className="bg-white rounded-xl h-24 animate-pulse border" style={{ borderColor: "var(--card-border)" }} />)}
        </div>

        {/* Plot Payment Summary — clients/investors only */}
        <div ref={plotSectionRef} />
        {!isSH && plotsData.length > 0 && (() => {
          const totalPaid      = plotsData.reduce((s, p) => s + p.paid, 0);
          const totalValue     = plotsData.reduce((s, p) => s + p.paid + p.remaining, 0);
          const completedAmt   = plotsData.filter((p) => p.pct >= 100).reduce((s, p) => s + p.paid, 0);
          const inProgressAmt  = plotsData.filter((p) => p.pct > 0 && p.pct < 100).reduce((s, p) => s + p.paid, 0);
          const completedCount = plotsData.filter((p) => p.pct >= 100).length;
          const inProgCount    = plotsData.filter((p) => p.pct > 0 && p.pct < 100).length;
          return (
            <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
              <div className="px-4 py-3 flex items-center justify-between border-b" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "#dcfce7" }}>
                    <MapPin size={14} color="#16a34a" />
                  </div>
                  <div>
                    <p className="text-xs font-bold" style={{ color: "#15803d" }}>Plot Payment Summary</p>
                    <p className="text-[10px] text-gray-400">{plotsData.length} plot{plotsData.length !== 1 ? "s" : ""} assigned</p>
                  </div>
                </div>
                <span className="text-xs font-bold" style={{ color: "#15803d" }}>{fmtKESFull(totalPaid)} paid</span>
              </div>
              <div className="grid grid-cols-3 divide-x" style={{ divideColor: "var(--border)" }}>
                <div className="px-3 py-3 text-center">
                  <div className="text-base font-bold" style={{ color: "#1a202c" }}>{fmtKES(totalPaid)}</div>
                  <div className="text-[10px] font-semibold mt-0.5" style={{ color: "#059669" }}>Total Paid</div>
                  <div className="text-[10px] text-gray-400">of {fmtKES(totalValue)}</div>
                </div>
                <div className="px-3 py-3 text-center">
                  <div className="text-base font-bold" style={{ color: "#1a202c" }}>{fmtKES(inProgressAmt)}</div>
                  <div className="text-[10px] font-semibold mt-0.5" style={{ color: "#f59e0b" }}>In Progress</div>
                  <div className="text-[10px] text-gray-400">{inProgCount} plot{inProgCount !== 1 ? "s" : ""}</div>
                </div>
                <div className="px-3 py-3 text-center">
                  <div className="text-base font-bold" style={{ color: "#1a202c" }}>{fmtKES(completedAmt)}</div>
                  <div className="text-[10px] font-semibold mt-0.5" style={{ color: "#6366f1" }}>Completed</div>
                  <div className="text-[10px] text-gray-400">{completedCount} plot{completedCount !== 1 ? "s" : ""}</div>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Quick Access */}
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Quick Access</h3>
          <div className="grid grid-cols-3 gap-2.5">
            {quickActions.map((qa) => (
              <button key={qa.mod} onClick={() => onNavigate(qa.mod)}
                className="bg-white rounded-xl p-3.5 flex flex-col items-center gap-2 border hover:shadow-md transition-shadow"
                style={{ borderColor: "var(--card-border)" }}>
                <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: qa.bg, color: qa.color }}>{qa.icon}</span>
                <span className="text-xs font-medium text-center leading-tight" style={{ color: "#374151" }}>{qa.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Recent Activity */}
        {activity.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3">Recent Activity</h3>
            <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
              {activity.map((a, i) => (
                <div key={a.key} className={`flex items-center gap-3 px-4 py-3 ${i < activity.length - 1 ? "border-b" : ""}`} style={{ borderColor: "var(--border)" }}>
                  <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: dotColor(a.type) }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate" style={{ color: "#374151" }}>{a.label}</p>
                    {a.date && <p className="text-xs text-gray-400">{fmtDate(a.date)}</p>}
                  </div>
                  {a.amount > 0 && <span className="text-sm font-bold flex-shrink-0" style={{ color: "#1a202c" }}>{fmtKES(a.amount)}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Right column: Analytics ── */}
      <div className="flex-1 flex flex-col gap-5 min-w-0">
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">Analytics Overview</h2>

        {/* Row 1: Contribution Trend (SH) / Payment History (client) + Payment Status */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Contribution Trend — shareholders only */}
          {isSH && (
            <div className="bg-white rounded-2xl border p-4 flex flex-col gap-3" style={{ borderColor: "var(--card-border)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Contribution Trend</p>
                  <p className="text-xs text-gray-400">Per year</p>
                </div>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#fdf2f8", color: "#ec4899" }}><TrendingUp size={15} /></div>
              </div>
              {monthlyContribs.length > 0 ? (
                <RechartBarChart width={280} height={170} data={monthlyContribs} style={{ width: "100%", maxWidth: "100%" }} margin={{ top: 20, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="year" tick={{ fontSize: 10, fill: "#94a3b8" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} width={30} />
                  <Tooltip formatter={(v: any) => [`KES ${Number(v).toLocaleString()}`, "Total"]} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Bar dataKey="amount" fill="#ec4899" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="amount" position="top" formatter={(v: any) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} style={{ fontSize: 9, fill: "#be185d", fontWeight: 600 }} />
                  </Bar>
                </RechartBarChart>
              ) : <ChartSkeleton />}
            </div>
          )}

          {/* Payment History bar — non-shareholders: full-width */}
          {!isSH && (
            <div className="bg-white rounded-2xl border p-4 flex flex-col gap-3 md:col-span-2" style={{ borderColor: "var(--card-border)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Payment History</p>
                  <p className="text-xs text-gray-400">Last 6 months</p>
                </div>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#f0fdfa", color: "#14b8a6" }}><TrendingUp size={15} /></div>
              </div>
              {monthlyPayments.length > 0 ? (
                <RechartBarChart id="payment-history-chart" width={280} height={150} data={monthlyPayments} style={{ width: "100%", maxWidth: "100%" }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} width={30} />
                  <Tooltip formatter={(v: any) => [`KES ${Number(v).toLocaleString()}`, "Total"]} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Bar dataKey="total" fill="#14b8a6" radius={[4, 4, 0, 0]} />
                </RechartBarChart>
              ) : <ChartSkeleton />}
            </div>
          )}


        </div>

        {/* Row 2: Savings Growth + Plot Payment Progress (shareholders only) */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Savings Growth — shareholders */}
          {isSH && (
            <div className="bg-white rounded-2xl border p-4 flex flex-col gap-3" style={{ borderColor: "var(--card-border)" }}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Savings Growth</p>
                  <p className="text-xs text-gray-400">Cumulative over time</p>
                </div>
                <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#eff6ff", color: "#3b82f6" }}><TrendingUp size={15} /></div>
              </div>
              {cumulativeSavings.length > 0 ? (
                <RechartAreaChart id="savings-growth-chart" width={280} height={140} data={cumulativeSavings} style={{ width: "100%", maxWidth: "100%" }}>
                  <defs>
                    <linearGradient id="mbSavGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 9, fill: "#94a3b8" }} tickLine={false} axisLine={false} tickFormatter={(v) => v >= 1000 ? `${(v/1000).toFixed(0)}k` : String(v)} width={30} />
                  <Tooltip formatter={(v: any) => [`KES ${Number(v).toLocaleString()}`, "Cumulative"]} contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid #e2e8f0" }} />
                  <Area type="monotone" dataKey="total" stroke="#6366f1" strokeWidth={2} fill="url(#mbSavGrad)" dot={false} />
                </RechartAreaChart>
              ) : (
                <div className="flex flex-col items-center justify-center h-32 text-center">
                  <p className="text-2xl font-bold" style={{ color: "#6366f1" }}>–</p>
                  <p className="text-xs text-gray-400 mt-1">No contribution history yet</p>
                </div>
              )}
            </div>
          )}

          {/* Plot Payment Progress — shareholders only (clients already shown in Row 1) */}
          {isSH && (
          <>{/* Plot Payment Progress */}
          <div className="bg-white rounded-2xl border p-4 flex flex-col gap-3" style={{ borderColor: "var(--card-border)" }}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Plot Payments</p>
                <p className="text-xs text-gray-400">Payment progress per plot</p>
              </div>
              <div className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: "#ecfdf5", color: "#059669" }}><MapPin size={15} /></div>
            </div>
            {stats ? (
              plotsData.length > 0 ? (
                <div className="space-y-3">
                  {plotsData.map((pl) => (
                    <div key={pl.name}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-medium" style={{ color: "#374151" }}>{pl.name}</span>
                        <span className="text-xs font-bold" style={{ color: pl.pct >= 100 ? "#059669" : pl.pct > 50 ? "#3b82f6" : "#f59e0b" }}>{pl.pct}%</span>
                      </div>
                      <div className="h-2 rounded-full overflow-hidden" style={{ background: "#f1f5f9" }}>
                        <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pl.pct}%`, background: pl.pct >= 100 ? "#059669" : pl.pct > 50 ? "#3b82f6" : "#f59e0b" }} />
                      </div>
                      <div className="flex items-center justify-between mt-0.5">
                        <span className="text-[10px] text-gray-400">Paid {fmtKES(pl.paid)}</span>
                        {pl.remaining > 0 && <span className="text-[10px] text-gray-400">Rem. {fmtKES(pl.remaining)}</span>}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-28 text-center">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center mb-2 mx-auto" style={{ background: "#ecfdf5", color: "#059669" }}><MapPin size={16} /></div>
                  <p className="text-xs text-gray-400">No plots assigned yet</p>
                </div>
              )
            ) : <ChartSkeleton />}
          </div>
          </>)}
        </div>

        {/* Row 3: Financial Summary */}
        {stats && (
          <div className="bg-white rounded-2xl border p-5" style={{ borderColor: "var(--card-border)" }}>
            <p className="text-sm font-bold mb-4" style={{ color: "#1a202c" }}>Financial Summary</p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              {isSH && (
                <>
                  <div className="text-center p-3 rounded-xl" style={{ background: "#fdf2f8" }}>
                    <div className="text-lg font-bold" style={{ color: "#ec4899" }}>{fmtKESFull(stats.totalContributed)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">Net Savings</div>
                  </div>
                  <div className="text-center p-3 rounded-xl" style={{ background: "#fff7ed" }}>
                    <div className="text-lg font-bold" style={{ color: "#f97316" }}>{fmtKESFull(stats.thisMonth)}</div>
                    <div className="text-[11px] text-gray-400 mt-0.5">This Month</div>
                  </div>
                </>
              )}
              <div className="text-center p-3 rounded-xl" style={{ background: "#ecfdf5" }}>
                <div className="text-lg font-bold" style={{ color: "#059669" }}>{stats.plotCount}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">Plots Owned</div>
              </div>
              <div className="text-center p-3 rounded-xl" style={{ background: stats.pendingPayments > 0 ? "#fffbeb" : "#f0fdfa" }}>
                <div className="text-lg font-bold" style={{ color: stats.pendingPayments > 0 ? "#f59e0b" : "#14b8a6" }}>{stats.pendingPayments > 0 ? stats.pendingPayments : "✓"}</div>
                <div className="text-[11px] text-gray-400 mt-0.5">{stats.pendingPayments > 0 ? "Pending Profits" : "Profits Clear"}</div>
              </div>
              {!isSH && (
                <div className="text-center p-3 rounded-xl" style={{ background: "#eff6ff" }}>
                  <div className="text-lg font-bold" style={{ color: "#3b82f6" }}>{stats.paymentCount}</div>
                  <div className="text-[11px] text-gray-400 mt-0.5">Total Profits</div>
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </div>

    {/* ── Click to Pay: choice modal ─────────────────────────────── */}
    {showPayChoice && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="px-6 py-5 text-center" style={{ background: "linear-gradient(135deg,#15803d,#22c55e)" }}>
            <div className="w-14 h-14 rounded-2xl mx-auto mb-3 flex items-center justify-center" style={{ background: "rgba(255,255,255,0.2)" }}>
              <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
                <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.15)" />
                <text x="16" y="22" textAnchor="middle" fontSize="18" fill="white" fontWeight="900" fontFamily="Arial">M</text>
                <circle cx="24" cy="10" r="5" fill="#ef4444" />
                <text x="24" y="13" textAnchor="middle" fontSize="7" fill="white" fontWeight="bold" fontFamily="Arial">P</text>
              </svg>
            </div>
            <h2 className="text-lg font-extrabold text-white">What would you like to pay?</h2>
            <p className="text-xs mt-1" style={{ color: "rgba(255,255,255,0.75)" }}>Secure M-Pesa payment via STK Push</p>
          </div>
          <div className="p-5 space-y-3">
            {isSH && (
              <button onClick={startContribPay}
                className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl border-2 hover:shadow-md transition-all text-left"
                style={{ borderColor: "#ec4899", background: "#fdf2f8" }}>
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fbcfe8" }}>
                  <Link2 size={22} color="#db2777" />
                </div>
                <div>
                  <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Pay Contribution</p>
                  <p className="text-xs text-gray-400">Monthly SACCO contribution</p>
                </div>
                <ChevronRight size={16} className="ml-auto text-gray-300" />
              </button>
            )}
            {memberPlots.length > 0 ? (() => {
              const allPaid = memberPlots.every((p) => Number(p.paid_amount) >= Number(p.price) && Number(p.price) > 0);
              const singlePaidFull = memberPlots.length === 1 && allPaid;
              return (
                <button
                  onClick={allPaid ? undefined : startPlotPay}
                  disabled={allPaid}
                  className="w-full flex items-center gap-4 px-5 py-4 rounded-2xl border-2 transition-all text-left"
                  style={{
                    borderColor: allPaid ? "#e5e7eb" : "#059669",
                    background: allPaid ? "#f9fafb" : "#ecfdf5",
                    cursor: allPaid ? "default" : "pointer",
                    opacity: allPaid ? 1 : 1,
                  }}>
                  <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: allPaid ? "#f3f4f6" : "#a7f3d0" }}>
                    <MapPin size={22} color={allPaid ? "#9ca3af" : "#059669"} />
                  </div>
                  <div className="flex-1">
                    <p className="font-bold text-sm" style={{ color: allPaid ? "#9ca3af" : "#1a202c" }}>Pay Plot</p>
                    <p className="text-xs" style={{ color: allPaid ? "#dc2626" : "#6b7280" }}>
                      {allPaid
                        ? (memberPlots.length === 1 ? `${memberPlots[0].plot_number} — Paid in Full` : "All plots paid in full")
                        : (memberPlots.length === 1 ? memberPlots[0].plot_number : `${memberPlots.length} plots — choose one`)}
                    </p>
                  </div>
                  {!allPaid && <ChevronRight size={16} className="ml-auto text-gray-300" />}
                </button>
              );
            })() : (
              <div className="flex items-center gap-3 px-5 py-4 rounded-2xl border" style={{ borderColor: "var(--border)", background: "#f9fafb" }}>
                <MapPin size={18} className="text-gray-300 flex-shrink-0" />
                <p className="text-xs text-gray-400">No plots allocated to you yet</p>
              </div>
            )}
            <button onClick={closeAllPay}
              className="w-full py-3 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
          </div>
        </div>
      </div>
    )}

    {/* ── Click to Pay: Plot — select plot (if multiple) ─────────── */}
    {payFlowType === "plot" && plotPayStep === "select" && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Select Plot to Pay</p>
            <button onClick={closeAllPay} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>
          <div className="p-4 space-y-2">
            {memberPlots.map((p) => {
              const due = Math.max(0, Number(p.price) - Number(p.paid_amount));
              const paidFull = Number(p.price) > 0 && Number(p.paid_amount) >= Number(p.price);
              return (
                <button key={p.id}
                  onClick={paidFull ? undefined : () => { setPlotPayTarget(p); setPlotPayStep("amount"); }}
                  disabled={paidFull}
                  className="w-full flex items-center gap-3 px-4 py-3.5 rounded-xl border-2 text-left transition-all"
                  style={{
                    borderColor: paidFull ? "#e5e7eb" : "var(--border)",
                    background: paidFull ? "#f9fafb" : "#fff",
                    cursor: paidFull ? "default" : "pointer",
                  }}>
                  <MapPin size={16} className="flex-shrink-0" style={{ color: paidFull ? "#d1d5db" : "#22c55e" }} />
                  <div className="flex-1 min-w-0">
                    <p className="font-bold text-sm" style={{ color: paidFull ? "#9ca3af" : "#1a202c" }}>{p.plot_number}</p>
                    {paidFull
                      ? <p className="text-xs font-semibold" style={{ color: "#dc2626" }}>Paid in Full</p>
                      : <p className="text-xs text-gray-400">Outstanding: <span className="font-semibold text-red-500">{fmtKESFull(due)}</span></p>
                    }
                  </div>
                  {!paidFull && <ChevronRight size={14} className="text-gray-300" />}
                </button>
              );
            })}
            <button onClick={closeAllPay}
              className="w-full py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
          </div>
        </div>
      </div>
    )}

    {/* ── Click to Pay: Plot — enter amount ──────────────────────── */}
    {payFlowType === "plot" && plotPayStep === "amount" && plotPayTarget && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
            <div>
              <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Pay Plot — {plotPayTarget.plot_number}</p>
              <p className="text-xs text-gray-400 mt-0.5">{memberInfo?.name}</p>
            </div>
            <button onClick={closeAllPay} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
          </div>
          <div className="p-5 space-y-4">
            <p className="text-xs text-gray-500">Outstanding: <span className="font-bold text-red-500">{fmtKESFull(plotDue)}</span></p>
            <input type="number" value={plotPayAmount} onChange={(e) => setPlotPayAmount(e.target.value)}
              placeholder="Amount (KES)" autoFocus
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
              style={{ borderColor: "var(--border)" }} />
            <div className="flex gap-2">
              <button onClick={() => setPlotPayStep(memberPlots.length > 1 ? "select" : null)}
                className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                style={{ borderColor: "var(--border)" }}>Back</button>
              <button onClick={() => setPlotPayStep("method")} disabled={!parsedPlotAmt || parsedPlotAmt <= 0}
                className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
                style={{ background: "#16a34a" }}>Choose Payment →</button>
            </div>
          </div>
        </div>
      </div>
    )}

    {/* ── Click to Pay: Plot — PaymentModal ──────────────────────── */}
    {payFlowType === "plot" && plotPayStep === "method" && plotPayTarget && (
      <PaymentModal
        amount={parsedPlotAmt}
        description={`Plot ${plotPayTarget.plot_number}`}
        memberName={memberInfo?.name}
        memberPhone={profile.role === "shareholder" ? memberShareholder?.phone : undefined}
        accountRef={(plotPayTarget.project?.project_name ? `${plotPayTarget.project.project_name}/Plot ${plotPayTarget.plot_number}` : `Plot ${plotPayTarget.plot_number}`).slice(0, 12)}
        onClose={closeAllPay}
        onComplete={handlePlotPayComplete}
      />
    )}

    {/* ── Click to Pay: Contribution — RecordContributionModal ───── */}
    {payFlowType === "contribution" && isSH && memberShareholder && (
      <RecordContributionModal
        shareholders={[memberShareholder]}
        initial={{ shareholder_id: memberShareholder.id }}
        onClose={closeAllPay}
        onSave={() => { closeAllPay(); setReloadKey((k) => k + 1); }}
      />
    )}
    {payFlowType === "contribution" && isSH && !memberShareholder && (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
        <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-xs text-center">
          <Loader2 size={24} className="animate-spin text-green-500 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Loading your account…</p>
        </div>
      </div>
    )}
    {/* ── Net Profits modal ───────────────────────────────────────── */}
    {showNetProfits && (
      <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
        onClick={(e) => { if (e.target === e.currentTarget) setShowNetProfits(false); }}>
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
            <div>
              <p className="font-bold text-base" style={{ color: "#1a202c" }}>Net Profits</p>
              <p className="text-xs text-gray-400">Allocated per project</p>
            </div>
            <button onClick={() => setShowNetProfits(false)} className="w-8 h-8 rounded-full flex items-center justify-center hover:bg-gray-100"><X size={16} /></button>
          </div>
          <div className="px-5 py-4 max-h-96 overflow-y-auto">
            {profitLoading ? (
              <div className="flex items-center justify-center py-10"><Loader2 size={22} className="animate-spin" style={{ color: "#ca8a04" }} /></div>
            ) : profitDists.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-8">No profit distributions yet</p>
            ) : (() => {
              const byProject = profitDists.reduce<Record<string, { name: string; total: number; count: number; firstDate: string; isActive: boolean }>>((acc, d) => {
                const key = String(d.project_id);
                const name = d.project?.project_name ?? `Project #${d.project_id}`;
                const date = d.distributed_at ?? "";
                const isActive = !(d.project as any)?.date_completed;
                if (!acc[key]) acc[key] = { name, total: 0, count: 0, firstDate: date, isActive };
                else if (date && date < acc[key].firstDate) acc[key].firstDate = date;
                acc[key].total += Number(d.amount);
                acc[key].count += 1;
                return acc;
              }, {} as Record<string, { name: string; total: number; count: number; firstDate: string; isActive: boolean }>);
              const rows = Object.entries(byProject).sort(([idA], [idB]) => Number(idA) - Number(idB)).map(([, v]) => v);
              const grandTotal = rows.reduce((s, r) => s + r.total, 0);
              return (
                <>
                  {rows.map((r, i) => (
                    <div key={i} className={`flex items-center justify-between py-3 ${i < rows.length - 1 ? "border-b" : ""}`} style={{ borderColor: "var(--border)" }}>
                      <div>
                        <p className="text-sm font-semibold" style={{ color: "#1a202c" }}>{r.name}</p>
                        <p className="text-xs font-semibold" style={{ color: r.isActive ? "#dc2626" : "#9ca3af" }}>
                          {r.isActive ? "Estimated Profit" : `${r.count} distribution${r.count !== 1 ? "s" : ""}`}
                        </p>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <p className="text-sm font-bold" style={{ color: r.isActive ? "#dc2626" : "#ca8a04" }}>{fmtKESFull(r.total)}</p>
                        {r.isActive && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#fef2f2", color: "#dc2626" }}>Estimated</span>}
                      </div>
                    </div>
                  ))}
                  <div className="mt-3 pt-3 border-t flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
                    <p className="text-sm font-bold" style={{ color: "#1a202c" }}>Total</p>
                    <p className="text-base font-extrabold" style={{ color: "#ca8a04" }}>{fmtKESFull(grandTotal)}</p>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      </div>
    )}
    </>
  );
}

function DashboardPage({ onNavigate }: { onNavigate: (m: Module) => void }) {
  const profile = useProfile();
  if (!profile) return null;
  if (profile.role === "admin" || profile.role === "reception") return <AdminDashboard onNavigate={onNavigate} />;
  return <MemberDashboard onNavigate={onNavigate} />;
}

// ─── My Plots Page ────────────────────────────────────────────────────────────

// Parse JSON notes from plot_payments into structured fields
function parsePlotPaymentNotes(raw: string | null): { method: string; ref: string; paidBy: string; phone: string; fine: string; status: string; note: string } {
  const blank = { method: "—", ref: "—", paidBy: "—", phone: "—", fine: "—", status: "—", note: "—" };
  if (!raw) return blank;
  try {
    const p = JSON.parse(raw);
    if (p && typeof p === "object") {
      return {
        method: p.method || "—",
        ref:    p.ref    || "—",
        paidBy: p.paidBy || "—",
        phone:  p.phone  || "—",
        fine:   p.fine   || "—",
        status: p.status || "—",
        note:   p.note   || "—",
      };
    }
  } catch { /* plain-text legacy notes */ }
  return { ...blank, note: raw };
}

// Inline payment history table — matches admin view style
interface PlotPaymentsInlineProps {
  plotId: number;
  refreshKey: number;
  plotNumber?: string;
  projectName?: string;
  memberName?: string;
  plotPrice?: number;
  paidAmount?: number;
}

function PlotPaymentsInline({ plotId, refreshKey, plotNumber, projectName, memberName, plotPrice, paidAmount }: PlotPaymentsInlineProps) {
  const [payments, setPayments] = useState<PlotPayment[]>([]);
  const [loading, setLoading]   = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setLoading(true);
    plotPaymentsApi.listByPlot(plotId)
      .then(setPayments)
      .catch(() => setPayments([]))
      .finally(() => setLoading(false));
  }, [plotId, refreshKey]);

  const COLS = "1fr 1fr 1.4fr 1fr 1fr 0.8fr 1fr";

  const handleExportPdf = async () => {
    setExporting(true);
    try {
      const co = await getCompanyDetails();
      const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
      const pageW = doc.internal.pageSize.getWidth();
      let y = 14;

      // Company header
      doc.setFontSize(14).setFont("helvetica", "bold");
      doc.text(co?.name ?? "SACCO", pageW / 2, y, { align: "center" });
      y += 6;
      if (co?.address || co?.phone) {
        doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(100);
        doc.text([co?.address, co?.phone].filter(Boolean).join("  |  "), pageW / 2, y, { align: "center" });
        y += 5;
      }
      doc.setDrawColor(180).line(14, y, pageW - 14, y);
      y += 6;

      // Statement title
      doc.setFontSize(12).setFont("helvetica", "bold").setTextColor(30, 58, 95);
      doc.text("PLOT PAYMENT STATEMENT", pageW / 2, y, { align: "center" });
      y += 7;

      // Plot meta
      doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(50);
      const metaLeft  = [`Plot: ${plotNumber ?? plotId}`, `Project: ${projectName ?? "—"}`];
      const metaRight = [
        `Member: ${memberName ?? "—"}`,
        `Total Price: ${plotPrice != null ? fmtKESFull(plotPrice) : "—"}`,
        `Amount Paid: ${paidAmount != null ? fmtKESFull(paidAmount) : "—"}`,
        `Balance: ${plotPrice != null && paidAmount != null ? fmtKESFull(Math.max(0, plotPrice - paidAmount)) : "—"}`,
      ];
      metaLeft.forEach((t, i)  => doc.text(t, 14, y + i * 5));
      metaRight.forEach((t, i) => doc.text(t, pageW / 2 + 5, y + i * 5));
      y += metaLeft.length * 5 + 4;

      doc.setDrawColor(200).line(14, y, pageW - 14, y);
      y += 4;

      // Payments table
      const total = payments.reduce((s, p) => s + Number(p.amount), 0);
      const rows = payments.map((pmt) => {
        const f = parsePlotPaymentNotes(pmt.notes);
        return [
          new Date(pmt.payment_date || pmt.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
          fmtKESFull(Number(pmt.amount)),
          f.method,
          f.ref,
          f.paidBy,
          f.phone,
          f.note,
        ];
      });

      autoTable(doc, {
        startY: y,
        head: [["Date", "Amount", "PMT Method", "TXN Code", "Paid By", "Phone", "Notes"]],
        body: rows,
        foot: [["Total", fmtKESFull(total), "", "", "", "", ""]],
        headStyles: { fillColor: [30, 58, 95], textColor: 255, fontSize: 8, fontStyle: "bold" },
        footStyles: { fillColor: [240, 253, 244], textColor: [22, 163, 74], fontStyle: "bold", fontSize: 9 },
        bodyStyles: { fontSize: 8, textColor: 50 },
        alternateRowStyles: { fillColor: [219, 234, 254] },
        columnStyles: { 1: { fontStyle: "bold", textColor: [5, 150, 105] } },
        margin: { left: 14, right: 14 },
      });

      // Footer
      const pageCount = (doc.internal as any).getNumberOfPages();
      for (let i = 1; i <= pageCount; i++) {
        doc.setPage(i);
        doc.setFontSize(7).setTextColor(160);
        doc.text(`Generated ${new Date().toLocaleString("en-KE")} · Page ${i} of ${pageCount}`, pageW / 2, doc.internal.pageSize.getHeight() - 6, { align: "center" });
      }

      const filename = `Plot-${plotNumber ?? plotId}-Statement.pdf`;
      const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);
      if (isMobile) {
        const blob = doc.output("blob");
        const url = URL.createObjectURL(blob);
        const w = window.open(url, "_blank");
        if (!w) doc.save(filename);
        setTimeout(() => URL.revokeObjectURL(url), 5000);
      } else {
        doc.save(filename);
      }
    } catch (e) {
      console.error("PDF export error", e);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return (
    <div className="flex justify-center py-5 border-t" style={{ borderColor: "var(--border)" }}>
      <Loader2 size={16} className="animate-spin" style={{ color: "#6366f1" }} />
    </div>
  );

  if (payments.length === 0) return (
    <div className="border-t px-4 py-5 text-center" style={{ borderColor: "var(--border)", background: "#f8fafc" }}>
      <p className="text-xs text-gray-400">No payments recorded yet.</p>
    </div>
  );

  const total = payments.reduce((s, p) => s + Number(p.amount), 0);

  return (
    <div className="border-t" style={{ borderColor: "var(--border)" }}>
      {/* PDF Export bar */}
      <div className="flex items-center justify-between px-3 py-2 border-b" style={{ background: "#f8fafc", borderColor: "#e2e8f0" }}>
        <p className="text-[11px] text-gray-400 font-medium">{payments.length} payment{payments.length !== 1 ? "s" : ""}</p>
        <button
          onClick={handleExportPdf}
          disabled={exporting}
          className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors hover:bg-red-50 disabled:opacity-60"
          style={{ color: "#dc2626", borderColor: "#fecaca", background: "#fff" }}>
          {exporting
            ? <><Loader2 size={12} className="animate-spin" /> Exporting…</>
            : <><FileDown size={13} /> Export PDF</>}
        </button>
      </div>

      {/* Table header — dark like admin */}
      <div className="overflow-x-auto">
        <div className="grid px-3 py-2 text-white text-[10px] font-semibold min-w-[520px]"
          style={{ background: "#1e3a5f", gridTemplateColumns: COLS }}>
          <span>Date</span>
          <span>Amount</span>
          <span>PMT Method</span>
          <span>TXN Code</span>
          <span>Paid By</span>
          <span>Phone</span>
          <span>Comments</span>
        </div>
        {/* Rows */}
        <div className="min-w-[520px]">
          {payments.map((pmt, i) => {
            const f = parsePlotPaymentNotes(pmt.notes);
            return (
              <div key={pmt.id} className="grid px-3 py-2 items-center text-xs"
                style={{ gridTemplateColumns: COLS, background: i % 2 === 0 ? "#dbeafe" : "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                <span className="text-gray-600">
                  {new Date(pmt.payment_date || pmt.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                </span>
                <span className="font-bold text-green-600">{fmtKESFull(Number(pmt.amount))}</span>
                <span className="text-gray-500 truncate pr-1">{f.method}</span>
                <span className="text-gray-500 truncate pr-1 font-mono">{f.ref}</span>
                <span className="text-gray-500 truncate pr-1">{f.paidBy}</span>
                <span className="text-gray-500 truncate pr-1">{f.phone}</span>
                <span className="text-gray-500 truncate pr-1">{f.note}</span>
              </div>
            );
          })}
        </div>
        {/* Footer total */}
        <div className="grid px-3 py-2 min-w-[520px]"
          style={{ gridTemplateColumns: COLS, background: "#f0fdf4", borderTop: "1px solid #e2e8f0" }}>
          <span className="text-xs font-bold text-gray-500">Total</span>
          <span className="text-sm font-extrabold" style={{ color: "#16a34a" }}>{fmtKESFull(total)}</span>
          <span /><span /><span /><span /><span />
        </div>
      </div>
    </div>
  );
}

function MyPlotsPage() {
  const profile = useProfile()!;
  const [plots, setPlots]             = useState<any[]>([]);
  const [loading, setLoading]         = useState(true);
  const [payPlot, setPayPlot]         = useState<any | null>(null);
  const [expandedId, setExpandedId]   = useState<number | null>(null);
  const [refreshKeys, setRefreshKeys] = useState<Record<number, number>>({});

  const loadPlots = useCallback(() => {
    if (!profile.member_id || profile.role === "investor") { setLoading(false); return; }
    plotsApi.listByMember(profile.member_id, profile.role as "shareholder" | "client")
      .then((data) => setPlots(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [profile.member_id, profile.role]);

  useEffect(() => { loadPlots(); }, [loadPlots]);

  if (loading) return <div className="flex items-center justify-center h-40"><Loader2 size={24} className="animate-spin" style={{ color: "#6366f1" }} /></div>;
  if (!plots.length) return (
    <div className="flex flex-col items-center justify-center h-64 text-center px-8">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#ecfdf5", color: "#059669" }}><MapPin size={32} /></div>
      <h3 className="font-bold text-lg mb-1" style={{ color: "#1a202c" }}>No plots assigned</h3>
      <p className="text-sm text-gray-400">You have no plots allocated yet. Contact your administrator.</p>
    </div>
  );

  return (
    <>
    <div className="p-4 md:p-6 space-y-3 max-w-3xl">
      <p className="text-xs text-gray-400 font-medium">{plots.length} plot{plots.length !== 1 ? "s" : ""} assigned to you</p>
      {plots.map((p) => {
        const pct     = p.price > 0 ? Math.min(100, Math.round((p.paid_amount / p.price) * 100)) : 0;
        const due     = Math.max(0, Number(p.price) - Number(p.paid_amount));
        const isExpanded = expandedId === p.id;
        const isInstalment = p.payment_mode === "installment";
        return (
          <div key={p.id} className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
            {/* ── Card header — matches admin AssignedPlotCard style ── */}
            <div className="px-4 py-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-sm" style={{ color: "#1a202c" }}>{p.plot_number}</p>
                  {((p.project as any)?.project_name) && (
                    <p className="text-xs text-gray-400">{(p.project as any).project_name}{(p.project as any).location ? ` · ${(p.project as any).location}` : ""}</p>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <p className="font-bold text-sm" style={{ color: "#6366f1" }}>{fmtKESFull(p.price)}</p>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isInstalment ? "bg-blue-50 text-blue-600" : "bg-green-50 text-green-600"}`}>
                    {isInstalment ? "Instalments" : "Cash"}
                  </span>
                </div>
              </div>

              <p className="text-xs mt-2">
                <span className="text-green-600 font-semibold">Paid: {fmtKESFull(p.paid_amount)}</span>
                {" · "}
                <span className="text-red-500 font-semibold">Due: {fmtKESFull(due)}</span>
              </p>
              <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: "#e2e8f0" }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "#22c55e" }} />
              </div>
              <div className="flex items-center justify-between mt-1">
                <p className="text-[10px] text-gray-400">{pct}%</p>
                <button
                  onClick={() => setExpandedId(isExpanded ? null : p.id)}
                  className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md hover:bg-gray-100 transition-colors"
                  style={{ color: "#6366f1" }}>
                  <List size={10} />
                  {isExpanded ? "Hide" : "View"} Payments
                  <ChevronDown size={10} style={{ transform: isExpanded ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />
                </button>
              </div>
            </div>

            {/* ── Inline payment history table ── */}
            {isExpanded && (
              <PlotPaymentsInline
                plotId={p.id}
                refreshKey={refreshKeys[p.id] ?? 0}
                plotNumber={p.plot_number}
                projectName={p.project?.name}
                memberName={profile.full_name}
                plotPrice={Number(p.price)}
                paidAmount={Number(p.paid_amount)}
              />
            )}

            {/* ── Make Payment button ── */}
            <div className="border-t" style={{ borderColor: "var(--border)" }}>
              <button onClick={() => setPayPlot(p)}
                className="flex w-full items-center justify-center gap-2 py-3 text-sm font-semibold hover:bg-green-50 transition-colors"
                style={{ color: "#16a34a" }}>
                <CreditCard size={15} />
                Make Payment
              </button>
            </div>
          </div>
        );
      })}
    </div>

    {payPlot && (
      <PlotPaymentModal
        plot={payPlot}
        projectName={payPlot.project?.project_name}
        assignedName={profile.full_name}
        memberPhone={payPlot.member_phone ?? undefined}
        onClose={() => setPayPlot(null)}
        onSave={async (amount, method, reference, _viaStk, phone, extras) => {
          const today = new Date().toISOString().split("T")[0];

          // extras.paidBy overrides for manual; for STK try resolving from callback
          let payerName = extras?.paidBy || profile.full_name;
          let payerPhone = phone ?? "";
          if (method === "mpesa" && reference && !extras) {
            try {
              const { data: cbRow } = await supabase
                .from("app_settings").select("value").eq("key", "mpesa_callback_last").maybeSingle();
              if (cbRow?.value) {
                const stkCb = (cbRow.value as any)?.Body?.stkCallback ?? cbRow.value;
                const cbItems: { Name: string; Value?: string | number }[] = stkCb?.CallbackMetadata?.Item ?? [];
                const cbPhone = String(cbItems.find((i) => i.Name === "PhoneNumber")?.Value ?? "");
                if (cbPhone) {
                  payerPhone = cbPhone;
                  const norm = cbPhone.replace(/^254/, "0");
                  const [shRows, clRows] = await Promise.all([
                    supabase.from("shareholders").select("name").or(`phone.eq.${cbPhone},phone.eq.${norm}`).limit(1),
                    supabase.from("clients").select("name").or(`phone.eq.${cbPhone},phone.eq.${norm}`).limit(1),
                  ]);
                  const found = shRows.data?.[0]?.name ?? clRows.data?.[0]?.name;
                  if (found) payerName = found;
                }
              }
            } catch { /* best-effort */ }
          }

          const structuredNotes = JSON.stringify({
            method: method === "mpesa" ? "Mpesa" : method === "bank" ? "Bank Transfer" : method === "cheque" ? "Cheque" : "Cash",
            ref: reference ?? "",
            paidBy: payerName,
            phone: payerPhone,
            fine: "",
            status: "",
            note: extras?.comment ?? "",
          });
          await plotPaymentsApi.insert(payPlot.id, amount, structuredNotes, today);
          await plotsApi.recordPayment(payPlot.id, amount);
          if (method === "mpesa" && reference) {
            const baseComment = `PHONE:${payerPhone}|ACCOUNT:${payPlot.plot_number}`;
            await paymentsApi.create({
              payment_id: reference,
              date_paid: today,
              amount,
              paid_by: payerName,
              purpose: "Plot Payment",
              mode: "Mpesa",
              comment: extras?.comment ? `${baseComment} · ${extras.comment}` : baseComment,
            });
          }
          logActivity({ category: "plot", action: "payment", description: `Plot ${payPlot.plot_number} payment of KES ${amount.toLocaleString()} via ${method}${reference ? ` (${reference})` : ""}`, actor_name: payerName, meta: { plot_id: payPlot.id, amount, method, ref: reference } });
          toast.success("Payment recorded successfully.");
          loadPlots();
          setRefreshKeys((prev) => ({ ...prev, [payPlot.id]: (prev[payPlot.id] ?? 0) + 1 }));
          setExpandedId(payPlot.id);
        }}
      />
    )}
    </>
  );
}

// ─── Help & Support Page ──────────────────────────────────────────────────────

function HelpPage() {
  return (
    <div className="p-4 md:p-6 max-w-md space-y-4">
      <p className="text-sm text-gray-500 mb-2">For assistance, contact your SACCO administrator.</p>
      {[
        { icon: <Phone size={18} />, label: "Call Us",    value: "Contact your administrator", bg: "#ecfdf5", color: "#059669" },
        { icon: <Mail size={18} />,  label: "Email Us",   value: "Contact your administrator", bg: "#eff6ff", color: "#3b82f6" },
      ].map((item) => (
        <div key={item.label} className="bg-white rounded-xl border p-4 flex items-center gap-4" style={{ borderColor: "var(--card-border)" }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: item.bg, color: item.color }}>{item.icon}</div>
          <div>
            <p className="text-xs font-semibold text-gray-400">{item.label}</p>
            <p className="text-sm font-medium" style={{ color: "#1a202c" }}>{item.value}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Refunds Page ────────────────────────────────────────────────────────────

function RefundsPage() {
  const profile  = useProfile();
  const viewOnly = useIsViewOnly();
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [editTarget, setEditTarget] = useState<Refund | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Refund | null>(null);
  const [deleting, setDeleting] = useState(false);

  const reload = () => {
    refundsApi.list().then(setRefunds).catch(() => setRefunds([]));
  };

  useEffect(() => {
    refundsApi.list()
      .then(setRefunds)
      .catch(() => setRefunds([]))
      .finally(() => setLoading(false));
  }, []);

  const memberRefunds = viewOnly && profile?.member_id
    ? refunds.filter((r: any) => r.shareholder_id === profile.member_id || r.client_id === profile.member_id)
    : refunds;

  const filtered = memberRefunds.filter((r) => {
    if (search) {
      const q = search.toLowerCase();
      const match = r.shareholder?.name.toLowerCase().includes(q) ||
        String(r.shareholder?.member_number).includes(q) ||
        r.notes?.toLowerCase().includes(q);
      if (!match) return false;
    }
    if (dateFrom && r.refund_date < dateFrom) return false;
    if (dateTo   && r.refund_date > dateTo)   return false;
    return true;
  });

  const totalRefunded = filtered.reduce((s, r) => s + Number(r.amount), 0);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b flex-shrink-0" style={{ background: "#7f1d1d", borderColor: "#991b1b" }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <RotateCcw size={18} color="#fca5a5" />
            <h1 className="text-lg font-bold text-white">Refunds</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={async () => {
              const co = await getCompanyDetails();
              downloadRefundsPdf(
                filtered.map((r) => ({
                  member: r.shareholder?.name ?? "Unknown",
                  member_no: `EW#${r.shareholder?.member_number ?? "—"}`,
                  amount: Number(r.amount),
                  refund_date: fmtDate(r.refund_date),
                  notes: r.notes ?? "—",
                })), co);
            }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90"
              style={{ background: "rgba(255,255,255,0.15)", color: "#fca5a5" }}>
              <FileDown size={13} /> PDF
            </button>
            <span className="text-xs font-semibold px-3 py-1 rounded-full" style={{ background: "rgba(255,255,255,0.12)", color: "#fca5a5" }}>
              {filtered.length} record{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
        <p className="text-xs" style={{ color: "#fca5a5" }}>Total refunded: <strong className="text-white">{fmtKESFull(totalRefunded)}</strong></p>
      </div>

      {/* Filters */}
      <div className="px-4 py-3 border-b flex-shrink-0 bg-white flex flex-wrap gap-2 items-center" style={{ borderColor: "var(--card-border)" }}>
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name or member number…"
            className="w-full pl-8 pr-3 py-2 text-sm border rounded-xl focus:outline-none focus:ring-2 focus:ring-red-200"
            style={{ borderColor: "var(--border)" }} />
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <label className="text-xs text-gray-400 whitespace-nowrap">From</label>
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
            className="border rounded-xl px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-200"
            style={{ borderColor: "var(--border)" }} />
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <label className="text-xs text-gray-400 whitespace-nowrap">To</label>
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
            className="border rounded-xl px-2.5 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-red-200"
            style={{ borderColor: "var(--border)" }} />
        </div>
        {(dateFrom || dateTo) && (
          <button onClick={() => { setDateFrom(""); setDateTo(""); }}
            className="flex items-center gap-1 text-xs font-semibold px-2.5 py-2 rounded-xl hover:bg-gray-100 flex-shrink-0"
            style={{ color: "#ef4444" }}>
            <X size={12} /> Clear dates
          </button>
        )}
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={22} className="animate-spin text-gray-300" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <RotateCcw size={32} className="text-gray-200" />
            <p className="text-sm text-gray-400">No refunds recorded yet</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left" style={{ background: "#1e3a5f" }}>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">Member</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">Amount</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">Date</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">Notes</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">Status</th>
                <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr key={r.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                  <td className="px-3 py-1.5">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0"
                        style={{ background: r.shareholder?.avatar_color ?? "#ef4444" }}>
                        {r.shareholder ? initials(r.shareholder.name) : "?"}
                      </div>
                      <div>
                        <div className="font-semibold text-sm" style={{ color: "#1a202c" }}>{r.shareholder?.name ?? "Unknown"}</div>
                        <div className="text-xs text-gray-400">EW#{r.shareholder?.member_number ?? "—"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-1.5 font-bold text-red-600">{fmtKESFull(Number(r.amount))}</td>
                  <td className="px-3 py-1.5 text-gray-500">{fmtDate(r.refund_date)}</td>
                  <td className="px-3 py-1.5 text-gray-400 text-xs max-w-[180px] truncate">{r.notes || "—"}</td>
                  <td className="px-3 py-1.5">
                    <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-500">
                      <span className="w-1.5 h-1.5 rounded-full bg-gray-400" /> Inactive
                    </span>
                  </td>
                  {!viewOnly && (
                  <td className="px-3 py-1.5">
                    <div className="flex items-center justify-end gap-1.5">
                      <button onClick={() => setEditTarget(r)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80 transition-opacity"
                        style={{ background: "#eff6ff", color: "#2563eb" }}>
                        <Edit2 size={11} /> Edit
                      </button>
                      <button onClick={() => setDeleteTarget(r)}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80 transition-opacity"
                        style={{ background: "#fef2f2", color: "#ef4444" }}>
                        <X size={11} /> Delete
                      </button>
                    </div>
                  </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Delete confirmation */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
              <p className="font-bold text-red-600 text-sm">Delete Refund?</p>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">
                Remove the refund of <strong className="text-red-600">{fmtKESFull(Number(deleteTarget.amount))}</strong> for{" "}
                <strong>{deleteTarget.shareholder?.name ?? "this member"}</strong>? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)}
                  className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button disabled={deleting} onClick={async () => {
                  setDeleting(true);
                  try {
                    await refundsApi.remove(deleteTarget.id);
                    logActivity({ category: "refund", action: "delete", description: `Refund #${deleteTarget.id} of KES ${Number(deleteTarget.amount).toLocaleString()} deleted`, meta: { id: deleteTarget.id } });
                    setRefunds((prev) => prev.filter((r) => r.id !== deleteTarget.id));
                    setDeleteTarget(null);
                  } finally { setDeleting(false); }
                }}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit refund modal */}
      {editTarget && (
        <RefundEditModal
          refund={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={async (patch) => {
            const updated = await refundsApi.update(editTarget.id, patch);
            logActivity({ category: "refund", action: "update", description: `Refund #${updated.id} updated — KES ${Number(updated.amount).toLocaleString()}`, meta: { id: updated.id } });
            setRefunds((prev) => prev.map((r) => r.id === updated.id ? { ...r, ...updated } : r));
            setEditTarget(null);
          }}
        />
      )}
    </div>
  );
}

function RefundEditModal({ refund, onClose, onSave }: {
  refund: Refund;
  onClose: () => void;
  onSave: (patch: { amount: number; refund_date: string; notes: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(Number(refund.amount)));
  const [notes, setNotes] = useState(refund.notes ?? "");
  const [refundDate, setRefundDate] = useState(refund.refund_date.slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt < 0) { setErr("Enter a valid amount"); return; }
    setSaving(true);
    try {
      await onSave({ amount: amt, refund_date: refundDate, notes });
    } catch (e: any) {
      setErr(e.message);
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#eff6ff", borderColor: "#bfdbfe" }}>
          <div className="flex items-center gap-2">
            <Edit2 size={16} color="#2563eb" />
            <span className="font-bold text-blue-700 text-sm">Edit Refund</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Amount (KES)</label>
            <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
              className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              style={{ borderColor: "var(--border)" }} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Refund Date</label>
            <input type="date" value={refundDate} onChange={(e) => setRefundDate(e.target.value)}
              className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
              style={{ borderColor: "var(--border)" }} />
          </div>
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Notes</label>
            <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none"
              style={{ borderColor: "var(--border)" }} />
          </div>
          {err && <p className="text-xs text-red-500 font-medium">{err}</p>}
          <div className="flex gap-2 pt-1">
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: "#2563eb" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Edit2 size={14} />} Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── M-Pesa Transactions Page (Admin only) ───────────────────────────────────

interface MpesaTx {
  transactionId?: string;
  trxDate?: string;
  msisdn?: string;
  sender?: string;
  transactionStatus?: string;
  amount?: string | number;
  organizationAccountReference?: string;
  thirdPartyTransId?: string;
  [key: string]: unknown;
}

function MpesaTransactionsPage() {
  const [tab, setTab] = useState<"local" | "safaricom">("local");

  // ── Local (recorded payments) ──────────────────────────────────────────────
  const [localPayments, setLocalPayments] = useState<Payment[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localSearch, setLocalSearch] = useState("");
  const [localMonth, setLocalMonth] = useState("");

  useEffect(() => {
    paymentsApi.list({ mode: "Mpesa" })
      .then(setLocalPayments)
      .catch(() => {})
      .finally(() => setLocalLoading(false));
  }, []);

  const localMonths = Array.from(new Set(
    localPayments.map((p) => (p.date_paid ?? "").slice(0, 7)).filter(Boolean)
  )).sort().reverse();

  const localFiltered = localPayments.filter((p) => {
    if (localMonth && !(p.date_paid ?? "").startsWith(localMonth)) return false;
    if (localSearch) {
      const q = localSearch.toLowerCase();
      return (
        String(p.payment_id ?? "").toLowerCase().includes(q) ||
        String(p.paid_by ?? "").toLowerCase().includes(q) ||
        String(p.comment ?? "").toLowerCase().includes(q) ||
        String(p.purpose ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });
  const localTotal = localFiltered.reduce((s, p) => s + Number(p.amount), 0);

  const exportLocalPdf = async () => {
    const co = await getCompanyDetails();
    await downloadPaymentsPdf(
      localFiltered.map((p) => ({
        payment_id: p.payment_id ?? "—",
        date_paid: fmtDate(p.date_paid),
        amount: Number(p.amount),
        paid_by: p.paid_by ?? "—",
        purpose: p.purpose ?? "—",
        mode: p.mode ?? "Mpesa",
        comment: p.comment ?? "",
      })),
      co,
      localMonth ? `Month: ${localMonth}` : "All M-Pesa · Last 3 months",
    );
  };

  // ── Safaricom Pull ─────────────────────────────────────────────────────────
  const [txs, setTxs] = useState<MpesaTx[]>([]);
  const [pullLoading, setPullLoading] = useState(false);
  const [pullError, setPullError] = useState("");
  const [pullDebug, setPullDebug] = useState<string>("");
  const [pulled, setPulled] = useState(false);
  const [meta, setMeta] = useState<{ startDate: string; endDate: string; environment: string; shortCode: string } | null>(null);
  const [sfSearch, setSfSearch] = useState("");
  const [sfMonth, setSfMonth] = useState("");

  const pull = async () => {
    setPullLoading(true);
    setPullError("");
    setPullDebug("");
    try {
      const { data, error: fnErr } = await supabase.functions.invoke("mpesa-pull", { body: {} });
      if (fnErr) throw new Error(fnErr.message);
      if (data?._debug) setPullDebug(JSON.stringify(data._debug, null, 2));
      if (!data?.success) throw new Error(data?.error ?? "Pull failed");
      setTxs(data.transactions ?? []);
      setMeta({ startDate: data.startDate, endDate: data.endDate, environment: data.environment, shortCode: data.shortCode });
      setPulled(true);
    } catch (e: any) {
      setPullError(e.message ?? "Unknown error");
    } finally {
      setPullLoading(false);
    }
  };

  const sfMonths = Array.from(new Set(
    txs.map((t) => (t.trxDate ?? "").slice(0, 7)).filter(Boolean)
  )).sort().reverse();

  const sfFiltered = txs.filter((t) => {
    if (sfMonth && !(t.trxDate ?? "").startsWith(sfMonth)) return false;
    if (sfSearch) {
      const q = sfSearch.toLowerCase();
      return (
        String(t.transactionId ?? "").toLowerCase().includes(q) ||
        String(t.sender ?? "").toLowerCase().includes(q) ||
        String(t.msisdn ?? "").toLowerCase().includes(q) ||
        String(t.organizationAccountReference ?? "").toLowerCase().includes(q)
      );
    }
    return true;
  });
  const sfTotal = sfFiltered.reduce((s, t) => s + (parseFloat(String(t.amount ?? 0)) || 0), 0);

  const exportSfPdf = async () => {
    const co = await getCompanyDetails();
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const w = doc.internal.pageSize.getWidth();
    doc.setFont("helvetica", "bold"); doc.setFontSize(13); doc.setTextColor(30, 45, 74);
    doc.text(co.name || "SACCO", 14, 14);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8.5); doc.setTextColor(80, 80, 80);
    doc.text("M-Pesa Transactions — Safaricom Pull", w / 2, 22, { align: "center" });
    if (meta) doc.text(`${meta.startDate} → ${meta.endDate}  ·  Short Code: ${meta.shortCode}  ·  ${meta.environment.toUpperCase()}`, w / 2, 27, { align: "center" });
    doc.setDrawColor(30, 45, 74); doc.setLineWidth(0.5); doc.line(14, 31, w - 14, 31);
    autoTable(doc, {
      startY: 35,
      head: [["Date","Sender","Phone","Account Ref","Amount (KES)","Status"]],
      body: sfFiltered.map((t) => [t.trxDate ?? "—", t.sender ?? "—", t.msisdn ?? "—", t.organizationAccountReference ?? "—", parseFloat(String(t.amount ?? 0)).toLocaleString("en-KE"), t.transactionStatus ?? "—"]),
      foot: [["","","","TOTAL", sfTotal.toLocaleString("en-KE"),""]],
      headStyles: { fillColor: [14, 165, 233], textColor: 255, fontStyle: "bold", fontSize: 7.5 },
      footStyles: { fillColor: [240, 249, 255], textColor: [14, 165, 233], fontStyle: "bold", fontSize: 8 },
      bodyStyles: { fontSize: 7 }, alternateRowStyles: { fillColor: [240, 249, 255] },
      columnStyles: { 5: { halign: "right" } },
      margin: { left: 14, right: 14 },
    });
    doc.save(`mpesa-safaricom-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b flex-shrink-0" style={{ background: "#0c4a6e", borderColor: "#075985" }}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <RefreshCw size={18} color="#7dd3fc" />
            <h1 className="text-lg font-bold text-white">M-Pesa Transactions</h1>
            <span className="text-[10px] font-bold px-2 py-0.5 rounded-full" style={{ background: "rgba(255,255,255,0.15)", color: "#bae6fd" }}>ADMIN ONLY</span>
          </div>
          <div className="flex items-center gap-2">
            {tab === "local" && localFiltered.length > 0 && (
              <button onClick={exportLocalPdf} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90" style={{ background: "rgba(255,255,255,0.15)", color: "#bae6fd" }}>
                <FileDown size={13} /> PDF
              </button>
            )}
            {tab === "safaricom" && pulled && sfFiltered.length > 0 && (
              <button onClick={exportSfPdf} className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90" style={{ background: "rgba(255,255,255,0.15)", color: "#bae6fd" }}>
                <FileDown size={13} /> PDF
              </button>
            )}
            {tab === "safaricom" && (
              <button onClick={pull} disabled={pullLoading} className="flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-bold hover:opacity-90 disabled:opacity-60" style={{ background: "#0ea5e9", color: "#fff" }}>
                {pullLoading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                {pullLoading ? "Pulling…" : pulled ? "Refresh" : "Pull 3 Months"}
              </button>
            )}
          </div>
        </div>
        {/* Tabs */}
        <div className="flex gap-1 mt-3">
          {([["local","Recorded Payments"],["safaricom","Safaricom Pull"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className="px-4 py-1.5 rounded-lg text-xs font-bold transition-all"
              style={tab === id
                ? { background: "#0ea5e9", color: "#fff" }
                : { background: "rgba(255,255,255,0.1)", color: "#bae6fd" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Local tab ── */}
      {tab === "local" && (
        <>
          <div className="px-4 py-3 border-b flex-shrink-0 bg-white flex flex-wrap gap-2 items-center" style={{ borderColor: "var(--card-border)" }}>
            <div className="relative flex-1 min-w-[180px]">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={localSearch} onChange={(e) => setLocalSearch(e.target.value)}
                placeholder="Search ID, name, purpose…"
                className="w-full pl-8 pr-3 py-2 text-sm border rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-200"
                style={{ borderColor: "var(--border)" }} />
            </div>
            {localMonths.length > 1 && (
              <select value={localMonth} onChange={(e) => setLocalMonth(e.target.value)}
                className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-200"
                style={{ borderColor: "var(--border)" }}>
                <option value="">All months ({localPayments.length})</option>
                {localMonths.map((m) => <option key={m} value={m}>{m} ({localPayments.filter((p) => (p.date_paid ?? "").startsWith(m)).length})</option>)}
              </select>
            )}
            {(localSearch || localMonth) && (
              <button onClick={() => { setLocalSearch(""); setLocalMonth(""); }} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-2 rounded-xl hover:bg-gray-100" style={{ color: "#0ea5e9" }}>
                <X size={12} /> Clear
              </button>
            )}
            <span className="text-xs text-gray-400 ml-auto">{localFiltered.length} records · KES {localTotal.toLocaleString("en-KE")}</span>
          </div>
          <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
            {localLoading ? (
              <div className="flex items-center justify-center h-40"><Loader2 size={24} className="animate-spin" style={{ color: "#0ea5e9" }} /></div>
            ) : localFiltered.length === 0 ? (
              <div className="flex items-center justify-center h-40"><p className="text-sm text-gray-400">No M-Pesa payments recorded yet.</p></div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[750px]">
                  <thead>
                    <tr style={{ background: "#1e3a5f" }}>
                      {[
                        { label: "Date",            tip: "From M-Pesa" },
                        { label: "Amount",          tip: "From M-Pesa" },
                        { label: "Name",            tip: "From M-Pesa message" },
                        { label: "Number",          tip: "From M-Pesa message" },
                        { label: "Notes (Account)", tip: "" },
                        { label: "Paid For",        tip: "" },
                      ].map(({ label }) => (
                        <th key={label} className="px-3 py-2.5 text-left font-semibold whitespace-nowrap text-white text-[11px]">{label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {localFiltered.map((p, i) => {
                      const comment = p.comment ?? "";
                      // Parse PHONE:xxx|ACCOUNT:xxx comment format
                      const phone = comment.match(/PHONE:([^|]+)/)?.[1]?.trim() ?? "";
                      const acct  = (comment.match(/ACCOUNT:([^|\n]+)/)?.[1]?.trim()
                        ?? comment.replace(/PHONE:[^|]+\|?/g, "").replace(/ACCOUNT:[^|]+\|?/g, "").trim())
                        || "";
                      return (
                        <tr key={p.id} className="border-b hover:bg-sky-50 transition-colors"
                          style={{ borderColor: "#e2e8f0", background: i % 2 === 0 ? "#dbeafe" : "#ffffff" }}>
                          {/* Date — from M-Pesa */}
                          <td className="px-3 py-2.5 whitespace-nowrap text-gray-600">{fmtDate(p.date_paid)}</td>
                          {/* Amount — from M-Pesa */}
                          <td className="px-3 py-2.5 font-bold whitespace-nowrap" style={{ color: "#059669" }}>
                            Ksh {Number(p.amount).toLocaleString("en-KE")}
                          </td>
                          {/* Name — from M-Pesa message */}
                          <td className="px-3 py-2.5" style={{ color: "#1a202c" }}>
                            <div className="font-semibold">{p.paid_by || "—"}</div>
                            {p.shareholder && (
                              <div className="text-[10px] text-gray-400">EW#{p.shareholder.member_number}</div>
                            )}
                          </td>
                          {/* Number — from M-Pesa message */}
                          <td className="px-3 py-2.5 font-mono text-[11px] text-gray-600 whitespace-nowrap">
                            {phone || "—"}
                          </td>
                          {/* Notes (Account) */}
                          <td className="px-3 py-2.5 text-gray-500 text-[11px]">{acct || "—"}</td>
                          {/* Paid For */}
                          <td className="px-3 py-2.5 text-gray-500">{p.purpose ?? "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#dbeafe", borderTop: "2px solid #93c5fd" }}>
                      <td className="px-3 py-2.5 font-bold text-xs" style={{ color: "#1e3a5f" }}>TOTAL</td>
                      <td />
                      <td className="px-3 py-2.5 font-extrabold text-xs whitespace-nowrap" style={{ color: "#059669" }}>
                        Ksh {localTotal.toLocaleString("en-KE")}
                      </td>
                      <td colSpan={4} className="px-3 py-2.5 text-[11px] text-gray-400">{localFiltered.length} record{localFiltered.length !== 1 ? "s" : ""}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {/* ── Safaricom Pull tab ── */}
      {tab === "safaricom" && (
        <>
          {pulled && (
            <div className="px-4 py-3 border-b flex-shrink-0 bg-white flex flex-wrap gap-2 items-center" style={{ borderColor: "var(--card-border)" }}>
              <div className="relative flex-1 min-w-[180px]">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={sfSearch} onChange={(e) => setSfSearch(e.target.value)}
                  placeholder="Search ID, name, phone, account…"
                  className="w-full pl-8 pr-3 py-2 text-sm border rounded-xl focus:outline-none focus:ring-2 focus:ring-sky-200"
                  style={{ borderColor: "var(--border)" }} />
              </div>
              {sfMonths.length > 1 && (
                <select value={sfMonth} onChange={(e) => setSfMonth(e.target.value)}
                  className="border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-200"
                  style={{ borderColor: "var(--border)" }}>
                  <option value="">All months ({txs.length})</option>
                  {sfMonths.map((m) => <option key={m} value={m}>{m} ({txs.filter((t) => (t.trxDate ?? "").startsWith(m)).length})</option>)}
                </select>
              )}
              {(sfSearch || sfMonth) && (
                <button onClick={() => { setSfSearch(""); setSfMonth(""); }} className="flex items-center gap-1 text-xs font-semibold px-2.5 py-2 rounded-xl hover:bg-gray-100" style={{ color: "#0ea5e9" }}>
                  <X size={12} /> Clear
                </button>
              )}
              <span className="text-xs text-gray-400 ml-auto">{sfFiltered.length} shown · KES {sfTotal.toLocaleString("en-KE")}</span>
            </div>
          )}
          <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
            {!pulled && !pullLoading && !pullError && (
              <div className="flex flex-col items-center justify-center h-64 text-center px-8">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#e0f2fe", color: "#0ea5e9" }}><RefreshCw size={32} /></div>
                <h3 className="font-bold text-lg mb-1" style={{ color: "#1a202c" }}>Pull from Safaricom</h3>
                <p className="text-sm text-gray-400 mb-1">Fetch the last 3 months directly from Safaricom.</p>
                <p className="text-xs text-amber-600 mb-4">Requires <strong>Pull Transactions API</strong> product enabled on your Daraja app.</p>
                <button onClick={pull} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white hover:opacity-90" style={{ background: "#0ea5e9" }}>
                  <RefreshCw size={15} /> Pull Transactions
                </button>
              </div>
            )}
            {pullLoading && (
              <div className="flex flex-col items-center justify-center h-64 gap-3">
                <Loader2 size={28} className="animate-spin" style={{ color: "#0ea5e9" }} />
                <p className="text-sm text-gray-400">Fetching from Safaricom…</p>
              </div>
            )}
            {pullError && !pullLoading && (
              <div className="m-5 space-y-3">
                <div className="p-4 rounded-xl border flex items-start gap-3" style={{ background: "#fff1f2", borderColor: "#fecdd3" }}>
                  <XCircle size={18} className="flex-shrink-0 mt-0.5" style={{ color: "#ef4444" }} />
                  <div className="flex-1">
                    <p className="text-sm font-bold" style={{ color: "#b91c1c" }}>Pull failed</p>
                    <p className="text-sm text-gray-600 mt-0.5">{pullError}</p>
                  </div>
                  <button onClick={pull} className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white" style={{ background: "#0ea5e9" }}>
                    <RefreshCw size={12} /> Retry
                  </button>
                </div>
                {pullDebug && (
                  <details className="rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
                    <summary className="px-4 py-2.5 text-xs font-bold cursor-pointer bg-gray-50 text-gray-500">Diagnostic info (share with support)</summary>
                    <pre className="px-4 py-3 text-[11px] text-gray-500 overflow-x-auto bg-white">{pullDebug}</pre>
                  </details>
                )}
                <div className="p-4 rounded-xl border text-xs text-gray-500 space-y-1" style={{ borderColor: "var(--border)", background: "#fffbeb" }}>
                  <p className="font-bold text-amber-700">Common fixes for "Invalid Access Token":</p>
                  <p>1. Go to <strong>developer.safaricom.co.ke</strong> → My Apps → add <strong>Pull Transactions API</strong> product</p>
                  <p>2. Your shortcode must be <strong>registered</strong> for the C2B Pull service with Safaricom</p>
                  <p>3. Contact Safaricom Business support to activate Pull API on your shortcode</p>
                  <p>4. In the meantime, use the <strong>Recorded Payments</strong> tab for reconciliation</p>
                </div>
              </div>
            )}
            {pulled && !pullLoading && sfFiltered.length === 0 && (
              <div className="flex items-center justify-center h-40"><p className="text-sm text-gray-400">No transactions found for this period.</p></div>
            )}
            {pulled && !pullLoading && sfFiltered.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs min-w-[700px]">
                  <thead>
                    <tr style={{ background: "#f0f9ff", borderBottom: "2px solid #bae6fd" }}>
                      {["Date & Time","Sender","Phone","Account Ref","Amount (KES)","Status"].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-left font-bold whitespace-nowrap" style={{ color: "#0369a1" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sfFiltered.map((t, i) => {
                      const amt = parseFloat(String(t.amount ?? 0)) || 0;
                      const ok = String(t.transactionStatus ?? "").toLowerCase().includes("complet") || String(t.transactionStatus ?? "").toLowerCase() === "success";
                      return (
                        <tr key={t.transactionId ?? i} className="border-b hover:bg-sky-50 transition-colors" style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#f8fafc" }}>
                          <td className="px-3 py-2.5 whitespace-nowrap text-gray-500">{t.trxDate ?? "—"}</td>
                          <td className="px-3 py-2.5 font-medium" style={{ color: "#1a202c" }}>{t.sender ?? "—"}</td>
                          <td className="px-3 py-2.5 text-gray-500">{t.msisdn ?? "—"}</td>
                          <td className="px-3 py-2.5 font-semibold" style={{ color: "#4338ca" }}>{t.organizationAccountReference ?? "—"}</td>
                          <td className="px-3 py-2.5 font-bold text-right" style={{ color: "#059669" }}>{amt.toLocaleString("en-KE")}</td>
                          <td className="px-3 py-2.5"><span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${ok ? "bg-green-100 text-green-700" : "bg-gray-100 text-gray-500"}`}>{t.transactionStatus ?? "—"}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#e0f2fe", borderTop: "2px solid #7dd3fc" }}>
                      <td colSpan={4} className="px-3 py-2.5 font-bold text-xs" style={{ color: "#0369a1" }}>{sfFiltered.length} transactions</td>
                      <td className="px-3 py-2.5 font-extrabold text-right text-xs" style={{ color: "#0369a1" }}>{sfTotal.toLocaleString("en-KE")}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Payments Page ────────────────────────────────────────────────────────────

function PaymentsPage() {
  const profile       = useProfile();
  const viewOnly      = useIsViewOnly();
  const canAddPayment = useCanMakePayment();
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [editTarget, setEditTarget] = useState<Payment | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Payment | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Filters
  const [yearF, setYearF] = useState<number | "all">("all");
  const [purposeF, setPurposeF] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await paymentsApi.list({
        year:    yearF === "all" ? undefined : yearF,
        mode:    "Mpesa",
        purpose: purposeF || undefined,
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo || undefined,
      });
      setPayments(data);
    } catch { setPayments([]); }
    finally { setLoading(false); }
  }, [yearF, purposeF, dateFrom, dateTo]);

  useEffect(() => { load(); }, [load]);

  const memberPayments = viewOnly && profile?.member_id
    ? payments.filter((p: any) => p.member_id === profile.member_id || p.shareholder_id === profile.member_id || p.client_id === profile.member_id)
    : payments;

  const filtered = memberPayments.filter((p) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return (
      p.paid_by.toLowerCase().includes(q) ||
      (p.payment_id ?? "").toLowerCase().includes(q) ||
      p.purpose.toLowerCase().includes(q) ||
      (p.comment ?? "").toLowerCase().includes(q)
    );
  });

  const total = filtered.reduce((s, p) => s + Number(p.amount), 0);

  const handleDownloadPdf = async () => {
    const co = await getCompanyDetails();
    const filterStr = [
      yearF !== "all" && `Year: ${yearF}`,
      purposeF && `Purpose: ${purposeF}`,
      dateFrom && `From: ${dateFrom}`,
      dateTo && `To: ${dateTo}`,
    ].filter(Boolean).join(" · ") || "All records";
    downloadPaymentsPdf(
      filtered.map((p) => ({
        payment_id: p.payment_id ?? "—",
        date_paid:  fmtDate(p.date_paid),
        amount:     Number(p.amount),
        paid_by:    p.paid_by,
        purpose:    p.purpose,
        mode:       p.mode,
        comment:    p.comment ?? "—",
      })),
      co, filterStr
    );
  };


  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b flex-shrink-0" style={{ background: "#14b8a6", borderColor: "#0d9488" }}>
        <div className="flex items-center justify-between mb-1">
          <div className="flex items-center gap-2">
            <CreditCard size={18} color="#ccfbf1" />
            <h1 className="text-lg font-bold text-white">Mpesa Payments</h1>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleDownloadPdf}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-teal-800 hover:opacity-90"
              style={{ background: "rgba(255,255,255,0.85)" }}>
              <FileDown size={13} /> PDF
            </button>
            {canAddPayment && <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold hover:opacity-90"
              style={{ background: "#fff", color: "#0d9488" }}>
              <Plus size={13} /> Add Payment
            </button>}
          </div>
        </div>
        <p className="text-xs" style={{ color: "#ccfbf1" }}>
          {filtered.length} record{filtered.length !== 1 ? "s" : ""} · Total: <strong className="text-white">{fmtKESFull(total)}</strong>
        </p>
      </div>

      {/* Filters */}
      <div className="px-4 py-3 border-b flex-shrink-0 bg-white flex flex-wrap gap-2 items-center" style={{ borderColor: "var(--card-border)" }}>
        <Filter size={13} className="text-gray-400 flex-shrink-0" />
        {/* Search */}
        <div className="relative flex-1 min-w-[160px]">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, phone, notes…"
            className="w-full pl-7 pr-2 py-1.5 border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-teal-200"
            style={{ borderColor: "var(--border)" }} />
        </div>
        {/* Year */}
        <select value={String(yearF)} onChange={(e) => setYearF(e.target.value === "all" ? "all" : parseInt(e.target.value))}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white"
          style={{ borderColor: "var(--border)" }}>
          <option value="all">All Years</option>
          {YEAR_OPTS.map((y) => <option key={y} value={y}>{y}</option>)}
        </select>
        {/* Purpose */}
        <select value={purposeF} onChange={(e) => setPurposeF(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white"
          style={{ borderColor: "var(--border)" }}>
          <option value="">All Purposes</option>
          {PAYMENT_PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        {/* Date range */}
        <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white"
          style={{ borderColor: "var(--border)" }} placeholder="From" />
        <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
          className="border rounded-lg px-2 py-1.5 text-xs focus:outline-none bg-white"
          style={{ borderColor: "var(--border)" }} placeholder="To" />
        {(yearF !== "all" || purposeF || dateFrom || dateTo || search) && (
          <button onClick={() => { setYearF("all"); setPurposeF(""); setDateFrom(""); setDateTo(""); setSearch(""); }}
            className="text-xs text-teal-600 hover:underline flex-shrink-0">Clear</button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto pb-20 md:pb-0">
        {loading ? (
          <div className="flex items-center justify-center py-16"><Loader2 size={22} className="animate-spin text-teal-400" /></div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 gap-2">
            <CreditCard size={32} className="text-gray-200" />
            <p className="text-sm text-gray-400">No payments found</p>
          </div>
        ) : (
          <table className="w-full text-sm min-w-[900px]">
            <thead style={{ background: "#1e3a5f" }}>
              <tr>
                {["Date", "Amount", "Name", "Number", "Notes (Account)", "Paid For", ""].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((p, i) => {
                const comment = p.comment ?? "";
                const phoneMatch = comment.match(/PHONE:([^\|]+)/);
                const accountMatch = comment.match(/ACCOUNT:([^\|]+)/);
                const phone = phoneMatch ? phoneMatch[1] : "—";
                const account = accountMatch ? accountMatch[1] : (comment.replace(/PHONE:[^\|]+\|?/, "").replace(/ACCOUNT:[^\|]+\|?/, "").trim() || "—");
                return (
                  <tr key={p.id} className="border-t hover:bg-gray-50 transition-colors"
                    style={{ borderColor: "var(--border)", background: i % 2 === 0 ? "#fff" : "#f0fdf4" }}>
                    <td className="px-3 py-2 text-gray-500 text-xs whitespace-nowrap">{fmtDate(p.date_paid)}</td>
                    <td className="px-3 py-2 font-bold whitespace-nowrap" style={{ color: "#14b8a6" }}>{fmtKESFull(Number(p.amount))}</td>
                    <td className="px-3 py-2">
                      <div className="font-semibold text-xs" style={{ color: "#1a202c" }}>{p.paid_by}</div>
                      {p.shareholder && <div className="text-[10px] text-gray-400">EW#{p.shareholder.member_number}</div>}
                    </td>
                    <td className="px-3 py-2 text-xs font-mono text-gray-600">{phone}</td>
                    <td className="px-3 py-2 text-xs text-gray-500 max-w-[130px] truncate">{account}</td>
                    <td className="px-3 py-2">
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold text-white"
                        style={{ background: "#14b8a6" }}>{p.purpose}</span>
                    </td>
                    <td className="px-3 py-2">
                      {!viewOnly && <div className="flex items-center gap-1.5">
                        <button onClick={() => setEditTarget(p)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80"
                          style={{ background: "#eff6ff", color: "#2563eb" }}>
                          <Edit2 size={11} />
                        </button>
                        <button onClick={() => setDeleteTarget(p)}
                          className="px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80"
                          style={{ background: "#fef2f2", color: "#ef4444" }}>
                          <X size={11} />
                        </button>
                      </div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ background: "#f0fdfa" }}>
                <td colSpan={2} className="px-3 py-2 text-xs font-bold text-teal-700 uppercase">Total</td>
                <td className="px-3 py-2 font-bold text-teal-800">{fmtKESFull(total)}</td>
                <td colSpan={5} />
              </tr>
            </tfoot>
          </table>
        )}
      </div>

      {/* Modals */}
      {showAdd && (
        <AddPaymentModal
          onClose={() => setShowAdd(false)}
          onSave={async (p) => {
            await paymentsApi.create(p);
            logActivity({ category: "payment", action: "create", description: `Payment of KES ${Number(p.amount).toLocaleString()} by "${p.paid_by}" recorded`, meta: { amount: p.amount, purpose: p.purpose } });
            setShowAdd(false);
            load();
          }}
        />
      )}
      {editTarget && (
        <AddPaymentModal
          initial={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={async (p) => {
            await paymentsApi.update(editTarget.id, p);
            logActivity({ category: "payment", action: "update", description: `Payment #${editTarget.id} updated — KES ${Number(p.amount).toLocaleString()} by "${p.paid_by}"`, meta: { id: editTarget.id } });
            setEditTarget(null);
            load();
          }}
        />
      )}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
              <p className="font-bold text-red-600 text-sm">Delete Payment?</p>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">
                Remove payment of <strong className="text-teal-700">{fmtKESFull(Number(deleteTarget.amount))}</strong> by <strong>{deleteTarget.paid_by}</strong>?
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)}
                  className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button disabled={deleting} onClick={async () => {
                  setDeleting(true);
                  await paymentsApi.remove(deleteTarget.id);
                  logActivity({ category: "payment", action: "delete", description: `Payment #${deleteTarget.id} of KES ${Number(deleteTarget.amount).toLocaleString()} by "${deleteTarget.paid_by}" deleted`, meta: { id: deleteTarget.id } });
                  setPayments((prev) => prev.filter((p) => p.id !== deleteTarget.id));
                  setDeleteTarget(null);
                  setDeleting(false);
                }}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AddPaymentModal({ initial, onClose, onSave }: {
  initial?: Payment;
  onClose: () => void;
  onSave: (p: PaymentPayload) => Promise<void>;
}) {
  const [form, setForm] = useState<PaymentPayload>({
    payment_id: initial?.payment_id ?? "",
    date_paid:  initial?.date_paid.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    amount:     initial?.amount ?? 0,
    paid_by:    initial?.paid_by ?? "",
    purpose:    initial?.purpose ?? PAYMENT_PURPOSES[0],
    mode:       initial?.mode ?? "Cash",
    comment:    initial?.comment ?? "",
    shareholder_id: initial?.shareholder_id ?? undefined,
  });
  const [mpesaMsg, setMpesaMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const parseMpesa = () => {
    if (!mpesaMsg.trim()) return;
    const parsed = parseMpesaMessage(mpesaMsg);
    setForm((f) => ({
      ...f,
      payment_id: parsed.txnCode ?? f.payment_id,
      amount:     parsed.amount  ?? f.amount,
      paid_by:    parsed.paidBy  ?? f.paid_by,
      mode:       "Mpesa",
    }));
  };

  const handleSave = async () => {
    if (!form.paid_by.trim()) { setErr("Paid By is required"); return; }
    if (!form.amount || form.amount <= 0) { setErr("Enter a valid amount"); return; }
    setSaving(true);
    try {
      await onSave(form);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  const lbl = "text-xs font-semibold text-gray-500 mb-1 block";
  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-200";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden max-h-[90vh] overflow-y-auto">
        <div className="px-5 py-4 flex items-center justify-between border-b flex-shrink-0"
          style={{ background: "#f0fdfa", borderColor: "#99f6e4" }}>
          <div className="flex items-center gap-2">
            <CreditCard size={16} color="#0d9488" />
            <span className="font-bold text-sm text-teal-800">{initial ? "Edit Payment" : "Add Payment"}</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Mpesa auto-parse */}
          {!initial && (
            <div className="border rounded-xl p-4 space-y-2" style={{ borderColor: "#99f6e4", background: "#f0fdfa" }}>
              <p className="text-xs font-bold text-teal-700">📱 Auto-parse Mpesa Confirmation</p>
              <textarea rows={2} value={mpesaMsg} onChange={(e) => setMpesaMsg(e.target.value)}
                placeholder="Paste Mpesa confirmation SMS here to auto-fill fields…"
                className="w-full border rounded-lg px-3 py-2 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-teal-300"
                style={{ borderColor: "#99f6e4" }} />
              <button onClick={parseMpesa}
                className="px-3 py-1.5 rounded-lg text-xs font-bold text-white"
                style={{ background: "#0d9488" }}>Parse Message</button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={lbl}>Payment ID / TXN Code</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={form.payment_id ?? ""} onChange={(e) => setForm((f) => ({ ...f, payment_id: e.target.value }))}
                placeholder="e.g. QRS456TU" />
            </div>
            <div>
              <label className={lbl}>Date Paid *</label>
              <input type="date" className={inp} style={{ borderColor: "var(--border)" }}
                value={form.date_paid} onChange={(e) => setForm((f) => ({ ...f, date_paid: e.target.value }))} />
            </div>
            <div>
              <label className={lbl}>Amount (KES) *</label>
              <input type="number" min="0" className={inp} style={{ borderColor: "var(--border)" }}
                value={form.amount || ""} onChange={(e) => setForm((f) => ({ ...f, amount: parseFloat(e.target.value) || 0 }))} />
            </div>
            <div>
              <label className={lbl}>Paid By *</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={form.paid_by} onChange={(e) => setForm((f) => ({ ...f, paid_by: e.target.value }))}
                placeholder="Full name" />
            </div>
            <div>
              <label className={lbl}>Purpose *</label>
              <select className={inp} style={{ borderColor: "var(--border)" }}
                value={form.purpose} onChange={(e) => setForm((f) => ({ ...f, purpose: e.target.value }))}>
                {PAYMENT_PURPOSES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className={lbl}>Mode *</label>
              <select className={inp} style={{ borderColor: "var(--border)" }}
                value={form.mode} onChange={(e) => setForm((f) => ({ ...f, mode: e.target.value }))}>
                {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <label className={lbl}>Comment</label>
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={form.comment ?? ""} onChange={(e) => setForm((f) => ({ ...f, comment: e.target.value }))}
                placeholder="Optional notes…" />
            </div>
          </div>

          {err && <p className="text-xs text-red-500 font-medium bg-red-50 rounded-lg px-3 py-2">{err}</p>}

          <div className="flex gap-2 pt-1">
            <button onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={handleSave} disabled={saving}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
              style={{ background: "#0d9488" }}>
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              {initial ? "Save Changes" : "Add Payment"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Universal Payment Modal ──────────────────────────────────────────────────

type PayMethod = "cash" | "mpesa" | "bank" | "cheque";

interface PaymentModalProps {
  amount: number;
  description: string;
  memberName?: string;
  memberPhone?: string;
  accountRef?: string;
  onComplete: (method: PayMethod, reference?: string, viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => Promise<void>;
  onClose: () => void;
}

const METHOD_META: Record<PayMethod, { label: string; icon: string; color: string; bg: string }> = {
  cash:   { label: "Cash",   icon: "💵", color: "#16a34a", bg: "#f0fdf4" },
  mpesa:  { label: "M-Pesa", icon: "📱", color: "#22c55e", bg: "#f0fdf4" },
  bank:   { label: "Bank",   icon: "🏦", color: "#2563eb", bg: "#eff6ff" },
  cheque: { label: "Cheque", icon: "📝", color: "#7c3aed", bg: "#f5f3ff" },
};

function PaymentModal({ amount, description, memberName, memberPhone, accountRef, onComplete, onClose }: PaymentModalProps) {
  const profile = useProfile();
  const isAdmin = profile?.role === "admin";
  const [availableMethods, setAvailableMethods] = useState<PayMethod[]>(() => {
    if (!isAdmin) return ["mpesa"];
    const cfg = getPaymentSettings();
    const extra = (["cash", "bank", "cheque"] as const).filter((m) => cfg.methods[m]);
    return [...new Set(["mpesa", ...extra])] as PayMethod[];
  });
  useEffect(() => {
    if (!isAdmin) { setAvailableMethods(["mpesa"]); return; }
    getEnabledPaymentMethodKeys().then((keys) => setAvailableMethods(keys as PayMethod[])).catch(() => {});
  }, [isAdmin]);
  const [method, setMethod] = useState<PayMethod>(isAdmin ? "cash" : "mpesa");
  const [reference, setReference] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [bankName, setBankName] = useState("");
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState("");

  // M-Pesa sub-mode
  const [mpesaMode, setMpesaMode] = useState<"stk" | "manual">("stk");
  const [manualRef, setManualRef] = useState("");
  const [manualPaidBy, setManualPaidBy] = useState(memberName ?? "");
  const [manualPhone, setManualPhone] = useState(memberPhone ?? "");
  const [manualComment, setManualComment] = useState("");

  // STK Push state
  const [stkPhone, setStkPhone] = useState(memberPhone ?? "");
  const [stkState, setStkState] = useState<"idle" | "pushing" | "waiting" | "success" | "failed">("idle");
  const [stkError, setStkError] = useState("");
  const [stkReceipt, setStkReceipt] = useState("");
  const [checkoutId, setCheckoutId] = useState("");
  const [stkDebugUrl, setStkDebugUrl] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCount = useRef(0);
  const [waitCountdown, setWaitCountdown]       = useState(3);
  const [closeCountdown, setCloseCountdown]     = useState(5);
  const waitCountRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeCountRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Store receipt + phone for deferred onComplete call
  const pendingComplete = useRef<{ receipt: string; phone: string } | null>(null);

  // ── STK Push ────────────────────────────────────────────────────────────────
  const sendStk = async () => {
    if (!stkPhone.trim()) { setErr("Enter a phone number"); return; }
    setErr(""); setStkState("pushing");
    try {
      const { data, error } = await supabase.functions.invoke("mpesa-stk", {
        body: {
          action: "push",
          phone: stkPhone.trim(),
          amount: Math.round(amount),
          accountRef: accountRef ?? "SACCO",
          description: description.slice(0, 50),
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "STK push failed");
      setCheckoutId(data.CheckoutRequestID ?? "");
      setStkDebugUrl(data._debug?.apiBase ?? "");
      // Start 3-second "waiting" countdown
      setWaitCountdown(3);
      if (waitCountRef.current) clearInterval(waitCountRef.current);
      waitCountRef.current = setInterval(() => {
        setWaitCountdown((n) => {
          if (n <= 1) { clearInterval(waitCountRef.current!); return 0; }
          return n - 1;
        });
      }, 1000);
      setStkState("waiting");
    } catch (e: any) {
      setStkState("failed");
      setStkError(e.message ?? "STK push failed");
    }
  };

  // ── Poll status ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (stkState !== "waiting" || !checkoutId) return;
    pollCount.current = 0;

    const poll = async () => {
      pollCount.current += 1;
      if (pollCount.current > 18) {
        clearInterval(pollRef.current!);
        setStkState("failed");
        setStkError("Timed out after 90 s. Try again or use Manual Code.");
        return;
      }
      try {
        const { data } = await supabase.functions.invoke("mpesa-stk", {
          body: { action: "query", checkoutRequestId: checkoutId },
        });
        const rc = String(data?.ResultCode ?? data?.errorCode ?? "");
        if (rc === "0") {
          clearInterval(pollRef.current!);

          // 1. Receipt from query response (edge fn injects it when callback is already stored)
          const queryItems: { Name: string; Value?: string | number }[] = data?.CallbackMetadata?.Item ?? [];
          let receipt = String(queryItems.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");

          // 2. Read directly from stored Safaricom callback in app_settings
          if (!receipt) {
            try {
              const { data: cbRow } = await supabase
                .from("app_settings").select("value").eq("key", "mpesa_callback_last").maybeSingle();
              if (cbRow?.value) {
                const stkCb = (cbRow.value as any)?.Body?.stkCallback ?? cbRow.value;
                const cbItems: { Name: string; Value?: string | number }[] = stkCb?.CallbackMetadata?.Item ?? [];
                receipt = String(cbItems.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");
              }
            } catch { /* best-effort */ }
          }

          // 3. Strip the ws_CO_ date-time prefix, keep just the unique numeric tail
          if (!receipt) {
            receipt = checkoutId.replace(/^ws_CO_\d{14}/, "").replace(/\D/g, "").slice(-10)
              || checkoutId.replace(/\D/g, "").slice(-10);
          }

          setStkReceipt(receipt);
          setStkState("success");
          pendingComplete.current = { receipt, phone: stkPhone };
          // Start 5-second close countdown
          setCloseCountdown(5);
          if (closeCountRef.current) clearInterval(closeCountRef.current);
          closeCountRef.current = setInterval(() => {
            setCloseCountdown((n) => {
              if (n <= 1) {
                clearInterval(closeCountRef.current!);
                const p = pendingComplete.current;
                if (p) onComplete("mpesa", p.receipt, true, p.phone);
                return 0;
              }
              return n - 1;
            });
          }, 1000);
        } else if (rc === "1032" || rc === "2001") {
          clearInterval(pollRef.current!);
          setStkState("failed");
          setStkError(data?.ResultDesc ?? "Payment cancelled or wrong PIN.");
        }
      } catch { /* keep polling */ }
    };

    pollRef.current = setInterval(poll, 5000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [stkState, checkoutId]);

  const resetStk = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (waitCountRef.current) clearInterval(waitCountRef.current);
    if (closeCountRef.current) clearInterval(closeCountRef.current);
    pendingComplete.current = null;
    setStkState("idle"); setStkError(""); setStkReceipt(""); setCheckoutId("");
    setWaitCountdown(3); setCloseCountdown(5);
  };

  const handlePay = async () => {
    setErr(""); setProcessing(true);
    try {
      let ref: string | undefined;
      if (method === "cheque") ref = chequeNo || undefined;
      else if (method === "bank") ref = `${bankName} ${reference}`.trim() || undefined;
      else ref = reference || undefined;
      await onComplete(method, ref);
    } catch (e: any) { setErr(e.message); setProcessing(false); }
  };

  const handleManualPay = async () => {
    if (!manualRef.trim()) { setErr("Enter M-Pesa transaction code"); return; }
    setErr(""); setProcessing(true);
    try {
      await onComplete("mpesa", manualRef.trim().toUpperCase(), false, manualPhone || undefined, {
        paidBy: manualPaidBy || undefined,
        comment: manualComment || undefined,
      });
    } catch (e: any) { setErr(e.message); setProcessing(false); }
  };

  const isStkBusy = stkState === "pushing" || stkState === "waiting" || stkState === "success";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>Select Payment Method</p>
            {memberName && <p className="text-xs text-gray-400 mt-0.5">{memberName} · {fmtKESFull(amount)}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Amount */}
          <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</span>
            <span className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(amount)}</span>
          </div>

          {/* Method tabs */}
          <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${availableMethods.length}, 1fr)` }}>
            {availableMethods.map((m) => {
              const meta = METHOD_META[m];
              return (
                <button key={m} onClick={() => { setMethod(m); setErr(""); if (m !== "mpesa") resetStk(); }}
                  className="flex flex-col items-center gap-1.5 py-3 rounded-xl border-2 transition-all"
                  style={{ borderColor: method === m ? meta.color : "var(--border)", background: method === m ? meta.bg : "#fff" }}>
                  <span className="text-xl">{meta.icon}</span>
                  <span className="text-[10px] font-bold" style={{ color: method === m ? meta.color : "#64748b" }}>{meta.label}</span>
                </button>
              );
            })}
          </div>

          {/* M-Pesa */}
          {method === "mpesa" && (
            <div>
              {/* STK / Manual sub-tabs — Manual Code only for admin */}
              {isAdmin && (
                <div className="flex rounded-xl overflow-hidden border mb-3" style={{ borderColor: "var(--border)" }}>
                  <button onClick={() => { setMpesaMode("stk"); setErr(""); resetStk(); }}
                    className="flex-1 py-2 text-xs font-bold transition-colors"
                    style={{ background: mpesaMode === "stk" ? "#16a34a" : "#f9fafb", color: mpesaMode === "stk" ? "#fff" : "#64748b" }}>
                    📱 STK Push
                  </button>
                  <button onClick={() => { setMpesaMode("manual"); setErr(""); }}
                    className="flex-1 py-2 text-xs font-bold transition-colors"
                    style={{ background: mpesaMode === "manual" ? "#16a34a" : "#f9fafb", color: mpesaMode === "manual" ? "#fff" : "#64748b" }}>
                    ✍️ Manual Code
                  </button>
                </div>
              )}

              {/* STK Push */}
              {mpesaMode === "stk" && (
                <div className="space-y-3">
                  {(stkState === "idle" || stkState === "failed") && (
                    <>
                      <div>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">Phone Number</label>
                        <input value={stkPhone} onChange={(e) => setStkPhone(e.target.value)}
                          placeholder="e.g. 0712345678"
                          className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                          style={{ borderColor: "var(--border)" }} />
                        <p className="text-xs text-gray-400 mt-1">An M-Pesa PIN prompt will be sent to this number</p>
                      </div>
                      {stkState === "failed" && stkError && (
                        <div className="flex items-start gap-2 text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">
                          <XCircle size={13} className="mt-0.5 flex-shrink-0" /><span>{stkError}</span>
                        </div>
                      )}
                      {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
                      <button onClick={sendStk}
                        className="w-full py-2.5 rounded-xl text-sm font-bold text-white"
                        style={{ background: "#16a34a" }}>
                        {stkState === "failed" ? "Retry STK Push" : "Send STK Push"}
                      </button>
                    </>
                  )}
                  {stkState === "pushing" && (
                    <div className="flex flex-col items-center py-8 gap-3">
                      <Loader2 size={30} className="animate-spin text-green-500" />
                      <p className="text-sm font-medium text-gray-600">Sending push notification…</p>
                    </div>
                  )}
                  {stkState === "waiting" && (
                    <div className="flex flex-col items-center py-8 gap-3">
                      {/* Spinner with countdown ring */}
                      <div className="relative w-20 h-20">
                        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                          <circle cx="40" cy="40" r="34" fill="none" stroke="#dcfce7" strokeWidth="6" />
                          <circle cx="40" cy="40" r="34" fill="none" stroke="#22c55e" strokeWidth="6"
                            strokeDasharray={`${2 * Math.PI * 34}`}
                            strokeDashoffset={`${2 * Math.PI * 34 * (1 - waitCountdown / 3)}`}
                            style={{ transition: "stroke-dashoffset 0.9s linear" }}
                            strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          {waitCountdown > 0
                            ? <span className="text-2xl font-black" style={{ color: "#16a34a" }}>{waitCountdown}</span>
                            : <div className="w-8 h-8 rounded-full border-4 border-green-200 border-t-green-500 animate-spin" />
                          }
                        </div>
                      </div>
                      <p className="text-sm font-bold text-gray-700">M-Pesa Prompt Sent</p>
                      <p className="text-xs font-semibold text-green-600 text-center px-4">
                        {waitCountdown > 0 ? `Check your phone in ${waitCountdown}s…` : "Waiting for confirmation…"}
                      </p>
                      <p className="text-xs text-gray-400 text-center px-4">Enter your M-Pesa PIN on your phone to confirm</p>
                      {stkDebugUrl && (
                        <span className="text-[10px] font-mono px-2 py-0.5 rounded-full"
                          style={{ background: stkDebugUrl.includes("sandbox") ? "#fee2e2" : "#dcfce7", color: stkDebugUrl.includes("sandbox") ? "#dc2626" : "#16a34a" }}>
                          🌐 {stkDebugUrl.replace("https://", "")}
                        </span>
                      )}
                      <button onClick={resetStk} className="text-xs text-gray-400 underline mt-1">Cancel</button>
                    </div>
                  )}
                  {stkState === "success" && (
                    <div className="flex flex-col items-center py-8 gap-3">
                      {/* Success ring with countdown */}
                      <div className="relative w-20 h-20">
                        <svg className="w-20 h-20 -rotate-90" viewBox="0 0 80 80">
                          <circle cx="40" cy="40" r="34" fill="none" stroke="#dcfce7" strokeWidth="6" />
                          <circle cx="40" cy="40" r="34" fill="none" stroke="#22c55e" strokeWidth="6"
                            strokeDasharray={`${2 * Math.PI * 34}`}
                            strokeDashoffset={`${2 * Math.PI * 34 * (closeCountdown / 5)}`}
                            style={{ transition: "stroke-dashoffset 0.9s linear" }}
                            strokeLinecap="round" />
                        </svg>
                        <div className="absolute inset-0 flex items-center justify-center">
                          <CheckCircle size={28} className="text-green-500" />
                        </div>
                      </div>
                      <p className="text-sm font-bold text-green-700">Payment Confirmed!</p>
                      {stkReceipt && <p className="text-xs text-gray-500 font-mono">Receipt: {stkReceipt}</p>}
                      <p className="text-xs text-gray-400">
                        Closing in <span className="font-bold text-green-600">{closeCountdown}s</span>…
                      </p>
                    </div>
                  )}
                  {!isStkBusy && (
                    <button onClick={onClose} className="w-full py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
                  )}
                </div>
              )}

              {/* Manual Code — admin only */}
              {isAdmin && mpesaMode === "manual" && (
                <div className="space-y-3">
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">M-Pesa Transaction Code</label>
                    <input value={manualRef} onChange={(e) => setManualRef(e.target.value.toUpperCase())}
                      placeholder="e.g. QHX4XXXXXXX"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                      style={{ borderColor: "var(--border)" }} />
                    <p className="text-xs text-gray-400 mt-1">Enter the M-Pesa confirmation code from the customer's SMS</p>
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">Paid By</label>
                    <input value={manualPaidBy} onChange={(e) => setManualPaidBy(e.target.value)}
                      placeholder="Name of payer"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                      style={{ borderColor: "var(--border)" }} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">Phone</label>
                    <input value={manualPhone} onChange={(e) => setManualPhone(e.target.value)}
                      placeholder="e.g. 0712345678"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                      style={{ borderColor: "var(--border)" }} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-gray-500 mb-1 block">Comments</label>
                    <input value={manualComment} onChange={(e) => setManualComment(e.target.value)}
                      placeholder="Optional note"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                      style={{ borderColor: "var(--border)" }} />
                  </div>
                  {err && <p className="text-xs font-medium text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
                  <div className="flex gap-2">
                    <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
                    <button onClick={handleManualPay} disabled={processing}
                      className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{ background: "#16a34a" }}>
                      {processing ? <Loader2 size={15} className="animate-spin" /> : null}
                      Confirm Payment
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Cash / Bank / Cheque */}
          {method === "bank" && (
            <div className="space-y-2">
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Bank Name</label>
                <input value={bankName} onChange={(e) => setBankName(e.target.value)} placeholder="e.g. KCB, Equity…"
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" style={{ borderColor: "var(--border)" }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1 block">Transaction Reference</label>
                <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Bank slip / transaction ID"
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200" style={{ borderColor: "var(--border)" }} />
              </div>
            </div>
          )}
          {method === "cheque" && (
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1 block">Cheque Number</label>
              <input value={chequeNo} onChange={(e) => setChequeNo(e.target.value)} placeholder="e.g. 000123"
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-200" style={{ borderColor: "var(--border)" }} />
            </div>
          )}
          {method === "cash" && (
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1 block">Receipt / Reference (optional)</label>
              <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Receipt number…"
                className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-100" style={{ borderColor: "var(--border)" }} />
            </div>
          )}

          {method !== "mpesa" && (
            <>
              {err && <p className="text-xs font-medium text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
              <div className="flex gap-2 pt-1">
                <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button onClick={handlePay} disabled={processing}
                  className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                  style={{ background: METHOD_META[method].color }}>
                  {processing ? <Loader2 size={15} className="animate-spin" /> : null}
                  Record Payment
                </button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  );
}

// ─── Contributions Page ───────────────────────────────────────────────────────


function RecordContributionModal({
  shareholders,
  initial,
  onClose,
  onSave,
}: {
  shareholders: Shareholder[];
  initial?: { shareholder_id: number };
  onClose: () => void;
  onSave: (c: Contribution) => void;
}) {
  const today = new Date();
  const billing = getBillingPeriod(today);
  const [form, setForm] = useState({
    shareholder_id: initial?.shareholder_id ?? (shareholders[0]?.id ?? 0),
    amount: "",
    month: billing.month,
    year: billing.year,
    payment_date: today.toISOString().slice(0, 10),
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [showPayment, setShowPayment] = useState(false);
  const [rules, setRules] = useState<PaymentRules | null>(null);

  useEffect(() => { getPaymentRules().then(setRules); }, []);

  const selectedSh = shareholders.find((s) => s.id === form.shareholder_id);
  const amt = parseFloat(form.amount);

  // Billing period month — day 1–10 maps to previous month, day 11+ to current month
  const billingMonth = billing.month;
  const billingYear  = billing.year;
  const availableMonths = form.year === billingYear
    ? [{ label: MONTHS[billingMonth - 1], month: billingMonth }]
    : [];

  // When year changes, lock to billing month if same year
  useEffect(() => {
    if (form.year === billingYear) {
      setForm((f) => ({ ...f, month: billingMonth }));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.year]);

  // Deadline = 10th of month after the contribution month
  const contributionDeadline = new Date(form.year, form.month, 10);
  const isAfterDeadline = today > contributionDeadline;

  const handleProceed = () => {
    if (!form.shareholder_id) { setErr("Select a shareholder"); return; }
    if (!amt || amt <= 0) { setErr("Enter a valid amount"); return; }
    if (isAfterDeadline) {
      setErr(`Deadline for ${MONTHS[form.month - 1]} ${form.year} has passed (10 ${MONTHS[form.month] ?? "of next month"}). Payment recording is disabled after the deadline.`);
      return;
    }
    setErr("");
    setShowPayment(true);
  };

  const handleSave = async (method: PayMethod, reference?: string, _viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => {
    setSaving(true); setErr("");
    try {
      const monthName = MONTHS[(form.month - 1)];
      const today = new Date().toISOString().slice(0, 10);
      const c = await contributionsApi.record({
        shareholder_id: form.shareholder_id,
        amount: amt,
        month: form.month,
        year: form.year,
        payment_date: today,
        notes: [form.notes, method !== "mpesa" && reference ? `Ref: ${reference}` : "", method ? `via ${method}` : ""].filter(Boolean).join(" · ") || undefined,
      });
      // Record in M-Pesa Payments for any mpesa payment
      if (method === "mpesa") {
        const memberNo = selectedSh?.member_number ? String(selectedSh.member_number) : undefined;
        const phoneVal = phone ?? selectedSh?.phone ?? "";
        const baseComment = `PHONE:${phoneVal}|ACCOUNT:${memberNo ?? ""}|Contribution ${monthName} ${form.year}`;
        await paymentsApi.create({
          payment_id: reference ?? undefined,
          date_paid: today,
          amount: amt,
          paid_by: extras?.paidBy || selectedSh?.name || "Unknown",
          purpose: "Contribution",
          mode: "Mpesa",
          comment: extras?.comment ? `${baseComment} · ${extras.comment}` : baseComment,
          shareholder_id: form.shareholder_id,
        });
      }
      if (selectedSh?.phone) {
        const monthName = MONTHS[(form.month - 1)];
        sendSms(
          selectedSh.phone,
          smsTemplates.contribReceipt(selectedSh.name.split(" ")[0], `KES ${amt.toLocaleString()}`, `${monthName} ${form.year}`, reference),
          SMS_TRIGGERS.contribReceipt,
        ).catch(() => {});
      }
      logActivity({ category: "contribution", action: "create", description: `Contribution of KES ${amt.toLocaleString()} recorded for ${selectedSh?.name ?? "member"}`, actor_name: selectedSh?.name, meta: { shareholder_id: form.shareholder_id, amount: amt } });
      onSave(c);
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
          <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--border)" }}>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Record Contribution</h2>
            <button onClick={onClose} className="p-1.5 rounded-full hover:bg-gray-100"><X size={16} /></button>
          </div>
          <div className="px-6 py-5 space-y-4">
            {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Shareholder</label>
              <select value={form.shareholder_id} onChange={(e) => setForm((f) => ({ ...f, shareholder_id: parseInt(e.target.value) }))}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" style={{ borderColor: "var(--border)" }}>
                {shareholders.map((s) => (
                  <option key={s.id} value={s.id}>EW#{s.member_number} — {s.name}</option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Month</label>
                <select value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: parseInt(e.target.value) }))}
                  className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none" style={{ borderColor: "var(--border)" }}
                  disabled={availableMonths.length === 0}>
                  {availableMonths.length === 0
                    ? <option value="">No months available</option>
                    : availableMonths.map(({ label, month }) => <option key={month} value={month}>{label}</option>)}
                </select>
                {availableMonths.length === 0 && (
                  <p className="text-xs text-red-500 mt-1">All months for {form.year} are past their deadline.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-gray-500 mb-1">Year</label>
                <select value={form.year} onChange={(e) => setForm((f) => ({ ...f, year: parseInt(e.target.value) }))}
                  className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none" style={{ borderColor: "var(--border)" }}>
                  {YEAR_RANGE.filter((y) => today <= new Date(y, 12, 10)).map((y) => <option key={y} value={y}>{y}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Amount (KES)</label>
              <input type="number" min="1" placeholder="0.00" value={form.amount}
                onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" style={{ borderColor: "var(--border)" }} />
            </div>

            <div>
              <label className="block text-xs font-semibold text-gray-500 mb-1">Notes (optional)</label>
              <input type="text" placeholder="e.g. Cash payment" value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none" style={{ borderColor: "var(--border)" }} />
            </div>

            {/* Deadline-passed banner */}
            {isAfterDeadline && (
              <div className="flex items-start gap-2.5 px-3.5 py-3 rounded-xl text-xs leading-relaxed"
                style={{ background: "#fef2f2", border: "1px solid #fecaca", color: "#991b1b" }}>
                <AlertCircle size={14} className="flex-shrink-0 mt-0.5" color="#dc2626" />
                <div>
                  <p className="font-bold">Deadline Passed</p>
                  <p>The deadline for <strong>{MONTHS[form.month - 1]} {form.year}</strong> (10 {MONTHS[form.month] ?? "of next month"}) has passed. Payment recording is disabled.</p>
                </div>
              </div>
            )}
          </div>
          <div className="flex gap-3 px-6 pb-6">
            <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={handleProceed} disabled={saving || isAfterDeadline || availableMonths.length === 0}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              style={{ background: isAfterDeadline || availableMonths.length === 0 ? "#94a3b8" : "#6366f1" }}>
              {saving ? "Processing…" : isAfterDeadline ? "Deadline Passed" : "Choose Payment Method →"}
            </button>
          </div>
        </div>
      </div>
      {showPayment && (
        <PaymentModal
          amount={isNaN(amt) ? 0 : amt}
          description={`Contribution ${MONTHS[form.month - 1]} ${form.year}`}
          memberName={selectedSh?.name}
          memberPhone={selectedSh?.phone}
          accountRef={selectedSh?.member_number ? `#${selectedSh.member_number}` : undefined}
          onClose={() => setShowPayment(false)}
          onComplete={handleSave}
        />
      )}
    </>
  );
}

function ContributionDetail({
  s, isFiltered, viewOnly, displayTotal, displayCount, onBack, onShowRecord, onChanged,
  yearFilter, monthFilter,
}: {
  s: ShareholderContributionSummary;
  isFiltered: boolean;
  viewOnly: boolean;
  displayTotal: (s: ShareholderContributionSummary) => number;
  displayCount: (s: ShareholderContributionSummary) => number;
  onBack: () => void;
  onShowRecord: () => void;
  onChanged?: () => void;
  yearFilter?: number | "all";
  monthFilter?: number | "all";
}) {
  const [fallbackPayments, setFallbackPayments] = useState<any[]>([]);
  const [loadingFallback, setLoadingFallback] = useState(false);
  const [refunds, setRefunds] = useState<any[]>([]);
  const [allContribs, setAllContribs] = useState<typeof s.contributions | null>(null);
  const [viewC, setViewC] = useState<any | null>(null);
  const [editC, setEditC] = useState<any | null>(null);
  const [deleteC, setDeleteC] = useState<any | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [tick, setTick] = useState(0);
  const reloadLocal = useCallback(() => setTick((n) => n + 1), []);
  const [memberProfitDists, setMemberProfitDists] = useState<(ProfitDistribution & { project?: any })[]>([]);

  useEffect(() => {
    profitDistributionsApi.listByShareholder(s.shareholder.id)
      .then(setMemberProfitDists).catch(() => {});
  }, [s.shareholder.id]);

  // When ALL filter: fetch every contribution for this member.
  // When a period filter is active: s.contributions already has the filtered subset.
  const effectiveContribs = isFiltered ? s.contributions : (allContribs ?? s.contributions);
  const needsFallback = effectiveContribs.length === 0 && !isFiltered && Number(s.shareholder.net_savings) > 0;

  useEffect(() => {
    if (isFiltered) return; // filtered data comes from parent
    supabase
      .from("contributions")
      .select("id, amount, year, month, payment_date, status, notes")
      .eq("shareholder_id", s.shareholder.id)
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .then(({ data }) => setAllContribs((data as any) ?? []));
  }, [s.shareholder.id, isFiltered, tick]);

  useEffect(() => {
    supabase
      .from("refunds")
      .select("id, amount, refund_date, notes, created_at")
      .eq("shareholder_id", s.shareholder.id)
      .order("refund_date", { ascending: false })
      .then(({ data }) => setRefunds(data ?? []));
  }, [s.shareholder.id]);

  useEffect(() => {
    if (!needsFallback) return;
    setLoadingFallback(true);
    supabase
      .from("payments")
      .select("id, amount, purpose, created_at, payment_date, status, method, reference")
      .eq("member_id", s.shareholder.id)
      .order("created_at", { ascending: false })
      .then(({ data }) => { setFallbackPayments(data ?? []); })
      .finally(() => setLoadingFallback(false));
  }, [s.shareholder.id, needsFallback]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-white border-b flex-shrink-0" style={{ borderColor: "var(--card-border)" }}>
        <button onClick={onBack} className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mr-1 md:hidden">
          <ArrowLeft size={14} /> Back
        </button>
        {!viewOnly && (
          <button onClick={onShowRecord}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold hover:opacity-80"
            style={{ background: "#eef2ff", color: "#6366f1" }}>
            <Plus size={13} /> Record Contribution
          </button>
        )}
        <button
          className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold hover:opacity-80"
          style={{ background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0" }}
          onClick={async () => {
            const co = await getCompanyDetails();
            const pdfRefunds = isFiltered ? [] : refunds;

            const stRows: StatementRow[] = ([
              ...effectiveContribs.map((c): StatementRow => ({
                kind: "contrib",
                label: `${MONTHS[c.month - 1]} ${c.year}`,
                date: c.payment_date ? fmtDate(c.payment_date) : "",
                amount: Number(c.amount),
                badge: c.status === "late" ? "Late" : "On time",
                notes: parseContribComment(c.notes),
                method: parseContribMethod(c.notes),
              })),
              ...pdfRefunds.map((r): StatementRow => ({
                kind: "refund",
                label: "Refund",
                date: r.refund_date ? fmtDate(r.refund_date) : (r.created_at ? fmtDate(r.created_at) : ""),
                amount: Number(r.amount),
                badge: "Refund",
                notes: r.notes ?? "",
              })),
            ] as SR[]).sort((a, b) => {
              const da = a.date ? new Date(a.date).getTime() : 0;
              const db = b.date ? new Date(b.date).getTime() : 0;
              return db - da;
            });

            // Net balance: when filtered use the exact sum of the PDF rows;
            // when unfiltered use net_savings (authoritative — deducts refunds).
            const pdfContribSum = stRows.filter((r) => r.kind === "contrib").reduce((s, r) => s + Number(r.amount), 0);
            const pdfRefundSum  = stRows.filter((r) => r.kind === "refund").reduce((s, r) => s + Number(r.amount), 0);
            const nsRaw = s.shareholder.net_savings;
            const netBal = isFiltered
              ? pdfContribSum - pdfRefundSum
              : (nsRaw != null ? Math.max(0, Number(nsRaw)) : pdfContribSum - pdfRefundSum);

            await downloadMemberStatementPdf(
              s.shareholder.name,
              `EW#${s.shareholder.member_number}`,
              stRows,
              netBal,
              co,
              buildProfitRows(memberProfitDists, yearFilter, monthFilter),
            );
          }}>
          <FileDown size={13} /> Export PDF
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-3">
        {/* Profile header */}
        <div className="bg-white rounded-xl border p-4 flex items-center gap-3" style={{ borderColor: "var(--card-border)" }}>
          <MemberAvatar photoUrl={s.shareholder.photo_url} name={s.shareholder.name} color={s.shareholder.avatar_color} size={48} />
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>{s.shareholder.name}</h2>
            <p className="text-xs font-bold" style={{ color: "#6366f1" }}>EW#{s.shareholder.member_number}</p>
          </div>
          <div className="ml-auto text-right">
            <div className="text-lg font-bold" style={{ color: "#22c55e" }}>{fmtKESFull(displayTotal(s))}</div>
            <div className="text-xs text-gray-400">{displayCount(s)} payment{displayCount(s) !== 1 ? "s" : ""}</div>
          </div>
        </div>

        {/* Contributions / Fallback payments table */}
        <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--card-border)" }}>
          <div className="px-4 py-3 border-b" style={{ borderColor: "var(--border)" }}>
            <h3 className="text-xs font-bold uppercase tracking-widest text-gray-400">Payment and Refund History</h3>
          </div>

          {effectiveContribs.length > 0 || (!isFiltered && refunds.length > 0) ? (() => {
            const sorted = [...effectiveContribs].sort((a, b) => b.year - a.year || b.month - a.month);
            const contribTotal   = sorted.reduce((sum, c) => sum + Number(c.amount), 0);
            const visibleRefunds = isFiltered ? [] : refunds;
            const refundTotal    = visibleRefunds.reduce((sum, r) => sum + Number(r.amount), 0);
            const nsRaw          = s.shareholder.net_savings;
            const netTotal       = isFiltered
              ? contribTotal
              : (nsRaw != null ? Math.max(0, Number(nsRaw)) : contribTotal - refundTotal);

            type StatRow =
              | { kind: "contrib"; id: number; label: string; date: string; amount: number; status: string; notes: string; month: number; year: number; payment_date: string | null }
              | { kind: "refund";  id: number; label: string; date: string; amount: number; notes: string; month: 0; year: 0; payment_date: null };

            const rows: StatRow[] = [
              ...sorted.map((c): StatRow => ({
                kind: "contrib", id: c.id,
                label: `${MONTHS[c.month - 1]} ${c.year}`,
                date: c.payment_date ?? "",
                amount: Number(c.amount),
                status: c.status ?? "on_time",
                notes: c.notes ?? "",
                month: c.month,
                year: c.year,
                payment_date: c.payment_date ?? null,
              })),
              ...visibleRefunds.map((r): StatRow => ({
                kind: "refund", id: r.id,
                label: "Refund",
                date: r.refund_date ?? r.created_at ?? "",
                amount: Number(r.amount),
                notes: r.notes ?? "",
                month: 0 as const,
                year: 0 as const,
                payment_date: null,
              })),
            ].sort((a, b) => {
              const da = a.date ? new Date(a.date).getTime() : 0;
              const db = b.date ? new Date(b.date).getTime() : 0;
              return db - da;
            });

            return (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead style={{ background: "#1e3a5f" }}>
                    <tr>
                      {["Month / Type", "Date", "Amount", "PmtMethod", "Status", "Comments", "Actions"].map((h) => (
                        <th key={h} className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
                    {rows.map((row, i) => {
                      const isRefund = row.kind === "refund";
                      const isLate = (row as any).status === "late";
                      const comment = parseContribComment(row.notes);
                      return (
                        <tr key={`${row.kind}-${row.id}`} className="hover:opacity-90 transition-colors"
                          style={{ background: isRefund ? "#fff1f2" : i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                          {/* Month / Type */}
                          <td className="px-3 py-1.5 font-semibold text-xs whitespace-nowrap" style={{ color: isRefund ? "#dc2626" : "#1a202c" }}>
                            {isRefund && <span className="mr-1">↩</span>}{row.label}
                          </td>
                          {/* Date */}
                          <td className="px-3 py-1.5 text-xs text-gray-500 whitespace-nowrap">{row.date ? fmtDate(row.date) : "—"}</td>
                          {/* Amount */}
                          <td className="px-3 py-1.5 font-bold text-xs whitespace-nowrap" style={{ color: isRefund ? "#dc2626" : "#22c55e" }}>
                            {isRefund ? `− ${fmtKESFull(row.amount)}` : fmtKESFull(row.amount)}
                          </td>
                          {/* PmtMethod */}
                          <td className="px-3 py-1.5">
                            {!isRefund ? <ContribMethodLabel notes={row.notes} /> : <span className="text-[10px] text-gray-400">—</span>}
                          </td>
                          {/* Status */}
                          <td className="px-3 py-1.5">
                            {isRefund
                              ? <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-red-50 text-red-500">Refund</span>
                              : <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isLate ? "bg-red-50 text-red-500" : "bg-green-50 text-green-600"}`}>
                                  {isLate ? "Late" : "On time"}
                                </span>
                            }
                          </td>
                          {/* Comments */}
                          <td className="px-3 py-1.5 text-[11px] text-gray-500 max-w-[160px]">
                            <span className="block truncate" title={comment || row.notes || ""}>{comment || "—"}</span>
                          </td>
                          {/* Actions */}
                          <td className="px-3 py-1.5">
                            {isRefund ? (
                              <span className="text-[10px] text-gray-300">—</span>
                            ) : viewOnly ? (
                              <span className="text-[10px] text-gray-300">—</span>
                            ) : (
                              <div className="flex items-center gap-1">
                                <button onClick={() => setViewC(row)} title="View"
                                  className="p-1 rounded hover:bg-indigo-50 text-indigo-300 hover:text-indigo-600 transition-colors">
                                  <Eye size={12} />
                                </button>
                                <button onClick={() => setEditC(row)} title="Edit"
                                  className="p-1 rounded hover:bg-amber-50 text-amber-300 hover:text-amber-600 transition-colors">
                                  <Edit2 size={12} />
                                </button>
                                <button onClick={() => setDeleteC(row)} title="Delete"
                                  className="p-1 rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors">
                                  <Trash2 size={12} />
                                </button>
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#f0fdf4" }}>
                      <td className="px-3 py-1.5 text-xs font-bold uppercase tracking-wider" style={{ color: "#1e3a5f" }}>
                        {sorted.length} contribution{sorted.length !== 1 ? "s" : ""}
                        {visibleRefunds.length > 0 && ` · ${visibleRefunds.length} refund${visibleRefunds.length !== 1 ? "s" : ""}`}
                      </td>
                      <td className="px-3 py-1.5 text-xs text-gray-400">Net Balance</td>
                      <td className="px-3 py-1.5 font-bold text-sm" style={{ color: netTotal <= 0 ? "#dc2626" : "#16a34a" }}>
                        {fmtKESFull(netTotal)}
                      </td>
                      <td colSpan={4} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          })() : needsFallback ? (
            loadingFallback ? (
              <div className="flex justify-center py-6"><Loader2 size={16} className="animate-spin text-gray-300" /></div>
            ) : fallbackPayments.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead style={{ background: "#1e3a5f" }}>
                    <tr>
                      {["Date", "Amount", "Purpose", "Method", "Status"].map((h) => (
                        <th key={h} className="px-3 py-1.5 text-left text-xs font-semibold uppercase tracking-wider text-white">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y" style={{ borderColor: "var(--border)" }}>
                    {fallbackPayments.map((p, i) => (
                      <tr key={p.id} style={{ background: i % 2 === 0 ? "#fff" : "#dbeafe" }}>
                        <td className="px-3 py-1.5 text-xs text-gray-600">{fmtDate(p.payment_date || p.created_at)}</td>
                        <td className="px-3 py-1.5 font-bold text-sm" style={{ color: "#22c55e" }}>{fmtKESFull(Number(p.amount))}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-500">{p.purpose || "—"}</td>
                        <td className="px-3 py-1.5 text-xs text-gray-500 capitalize">{p.method || "—"}</td>
                        <td className="px-3 py-1.5 text-xs">
                          <span className={`px-2 py-0.5 rounded-full font-semibold text-[10px] ${p.status === "completed" ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-500"}`}>
                            {p.status || "—"}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: "#f0fdf4" }}>
                      <td className="px-3 py-2 text-xs font-bold uppercase tracking-wider" style={{ color: "#1e3a5f" }}>
                        Total · {fallbackPayments.length} payment{fallbackPayments.length !== 1 ? "s" : ""}
                      </td>
                      <td className="px-3 py-2 font-bold text-sm" style={{ color: "#16a34a" }}>
                        {fmtKESFull(fallbackPayments.reduce((sum, p) => sum + Number(p.amount), 0))}
                      </td>
                      <td colSpan={3} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            ) : (
              <div className="px-4 py-6 text-center space-y-3">
                <p className="text-xs font-semibold text-amber-600">
                  This member has <strong>{fmtKESFull(Number(s.shareholder.net_savings))}</strong> in net savings but no individual payment records.
                </p>
                <p className="text-[11px] text-gray-400">
                  The total was set directly. Use <strong>Contributions Upload</strong> in Settings → Data Upload to add individual monthly records for this member.
                </p>
                {!viewOnly && (
                  <button onClick={onShowRecord}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold text-white"
                    style={{ background: "#6366f1" }}>
                    <Plus size={12} /> Record a Contribution
                  </button>
                )}
              </div>
            )
          ) : (
            <p className="px-4 py-6 text-xs text-gray-400 text-center">
              {isFiltered ? "No contributions in this period." : "No contributions recorded yet."}
            </p>
          )}
        </div>
      </div>

      {/* View modal (admin) */}
      {viewC && !viewC.kind?.includes("refund") && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}
          onClick={(e) => { if (e.target === e.currentTarget) setViewC(null); }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#eef2ff", borderColor: "#c7d2fe" }}>
              <div>
                <p className="font-bold text-sm" style={{ color: "#3730a3" }}>Contribution Details</p>
                <p className="text-xs" style={{ color: "#6366f1" }}>{viewC.label}</p>
              </div>
              <button onClick={() => setViewC(null)} className="p-1.5 rounded-full hover:bg-indigo-100 text-indigo-400"><X size={15} /></button>
            </div>
            <div className="px-5 py-4 space-y-2.5">
              {([
                ["Member", s.shareholder.name],
                ["Member No.", `EW#${s.shareholder.member_number}`],
                ["Period", viewC.label],
                ["Date Paid", viewC.date ? fmtDate(viewC.date) : "—"],
                ["Amount", fmtKESFull(Number(viewC.amount))],
                ["Status", (viewC.status === "late") ? "Late" : "On Time"],
                ["Method", parseContribMethod(viewC.notes) || "—"],
                ["Comment", parseContribComment(viewC.notes) || "—"],
              ] as [string, string][]).map(([label, val]) => (
                <div key={label} className="flex items-start justify-between gap-3">
                  <span className="text-xs text-gray-400 flex-shrink-0 w-28">{label}</span>
                  <span className="text-xs font-semibold text-right" style={{ color: label === "Amount" ? "#16a34a" : "#1a202c" }}>{val}</span>
                </div>
              ))}
            </div>
            <div className="px-5 pb-5">
              <button onClick={() => setViewC(null)}
                className="w-full py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                style={{ borderColor: "var(--border)" }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Edit modal (admin) */}
      {editC && (
        <ContribEditModal
          contrib={editC}
          onClose={() => setEditC(null)}
          onSave={async (patch) => {
            await contributionsApi.update(editC.id, patch);
            logActivity({ category: "contribution", action: "update", description: `Contribution #${editC.id} updated for ${s.shareholder.name}`, actor_name: s.shareholder.name, meta: { id: editC.id } });
            setEditC(null);
            reloadLocal();
            onChanged?.();
            toast.success("Contribution updated");
          }}
        />
      )}

      {/* Delete modal (admin) */}
      {deleteC && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
              <p className="font-bold text-sm text-red-600">Delete Contribution?</p>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">
                Delete <strong>{deleteC.label}</strong> — <strong className="text-green-700">{fmtKESFull(Number(deleteC.amount))}</strong> for <strong>{s.shareholder.name}</strong>?{" "}
                Net savings will be reduced accordingly.
              </p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteC(null)} disabled={deleting}
                  className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-50"
                  style={{ borderColor: "var(--border)" }}>Cancel</button>
                <button disabled={deleting} onClick={async () => {
                  setDeleting(true);
                  try {
                    await contributionsApi.remove(deleteC.id);
                    logActivity({ category: "contribution", action: "delete", description: `Contribution #${deleteC.id} deleted for ${s.shareholder.name}`, actor_name: s.shareholder.name, meta: { id: deleteC.id } });
                    setDeleteC(null);
                    reloadLocal();
                    onChanged?.();
                    toast.success("Contribution deleted");
                  } catch (e: any) { toast.error(e.message); }
                  finally { setDeleting(false); }
                }}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
                  style={{ background: "#ef4444" }}>
                  {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

function ContributionsPage() {
  const profile  = useProfile();
  const viewOnly = useIsViewOnly();
  const [summaries, setSummaries] = useState<ShareholderContributionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [yearFilter, setYearFilter] = useState<number | "all">("all");
  const [monthFilter, setMonthFilter] = useState<number | "all">("all");
  const [search, setSearch] = useState("");
  const [showRecord, setShowRecord] = useState(false);
  const [selected, setSelected] = useState<ShareholderContributionSummary | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await contributionsApi.summaryByShareholder({
        year:  yearFilter  === "all" ? undefined : yearFilter,
        month: monthFilter === "all" ? undefined : monthFilter,
      });
      setSummaries(data);
    } catch { setSummaries([]); }
    finally { setLoading(false); }
  }, [yearFilter, monthFilter]);

  useEffect(() => { load(); }, [load]);

  const allShareholders = summaries.map((s) => s.shareholder);

  const memberSummaries = viewOnly && profile?.member_id && profile.role === "shareholder"
    ? summaries.filter((s) => s.shareholder.id === profile.member_id)
    : summaries;

  const filtered = memberSummaries.filter((s) =>
    s.shareholder.name.toLowerCase().includes(search.toLowerCase()) ||
    `EW#${s.shareholder.member_number}`.includes(search)
  );

  const isFiltered = yearFilter !== "all" || monthFilter !== "all";
  // When unfiltered, use authoritative net_savings from shareholders table (captures contributions
  // recorded outside the contributions table, e.g. direct DB imports or pre-migration data).
  // net_savings is the authoritative balance (admin deducts refunds from it directly).
  // Only fall back to the contributions sum when net_savings has never been set (null).
  const displayTotal = (s: ShareholderContributionSummary) => {
    if (isFiltered) return s.total;
    const ns = s.shareholder.net_savings;
    return ns != null ? Math.max(0, Number(ns)) : s.total;
  };
  const displayCount = (s: ShareholderContributionSummary) =>
    isFiltered ? s.count : Math.max(s.count, s.shareholder.contributions_count);
  const totalCollected = summaries.reduce((sum, s) => sum + displayTotal(s), 0);
  const activeShareholders = summaries.filter((s) => s.shareholder.status === "Active").length;

  const handleNewContribution = (c: Contribution) => {
    setShowRecord(false);
    load();
  };

  const renderDetail = (s: ShareholderContributionSummary) => (
    <ContributionDetail
      s={s}
      isFiltered={isFiltered}
      viewOnly={viewOnly}
      displayTotal={displayTotal}
      displayCount={displayCount}
      onBack={() => setMobileDetail(false)}
      onShowRecord={() => setShowRecord(true)}
      onChanged={load}
      yearFilter={yearFilter}
      monthFilter={monthFilter}
    />
  );

  // Non-admin shareholder: skip the list, show their own contributions directly
  if (viewOnly && profile?.role === "shareholder") {
    const mySummary = summaries.find((s) => s.shareholder.id === profile.member_id);
    return (
      <div className="flex flex-col h-full overflow-hidden">
        <div className="flex-shrink-0 px-5 pt-4 pb-4" style={{ background: "#1e2d4a" }}>
          <h1 className="font-bold text-lg text-white">Contributions</h1>
          <p className="text-xs" style={{ color: "#94a3b8" }}>Your savings history</p>
        </div>
        {/* Year + month filters */}
        <div className="flex-shrink-0 border-b px-3 pt-3 pb-2 space-y-2" style={{ background: "var(--background)", borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <div className="flex gap-1.5 overflow-x-auto flex-1">
              {(["all", ...YEAR_RANGE] as (number | "all")[]).map((y) => (
                <button key={String(y)} onClick={() => setYearFilter(y)}
                  className="px-3 py-1 rounded-full text-xs font-semibold flex-shrink-0 transition-all"
                  style={{ background: yearFilter === y ? "#1e2d4a" : "#e2e8f0", color: yearFilter === y ? "#fff" : "#475569" }}>
                  {y === "all" ? "All" : y}
                </button>
              ))}
            </div>
            <button
              onClick={async () => {
                if (!mySummary) return;
                const co = await getCompanyDetails();
                // Only include refunds when showing all-time (unfiltered) view
                const pdfRefs = isFiltered ? [] : await supabase
                  .from("refunds").select("amount,refund_date,notes")
                  .eq("shareholder_id", mySummary.shareholder.id)
                  .then(({ data }) => data ?? []);
                const stRows: StatementRow[] = ([
                  ...mySummary.contributions.map((c): StatementRow => ({
                    kind: "contrib",
                    label: `${MONTHS[c.month - 1]} ${c.year}`,
                    date: c.payment_date ? fmtDate(c.payment_date) : "",
                    amount: Number(c.amount),
                    badge: c.status === "late" ? "Late" : "On time",
                    notes: parseContribComment(c.notes),
                    method: parseContribMethod(c.notes),
                  })),
                  ...(pdfRefs as any[]).map((r): StatementRow => ({
                    kind: "refund",
                    label: "Refund",
                    date: r.refund_date ? fmtDate(r.refund_date) : "",
                    amount: Number(r.amount),
                    badge: "Refund",
                    notes: r.notes ?? "",
                  })),
                ]).sort((a, b) => (b.date ? new Date(b.date).getTime() : 0) - (a.date ? new Date(a.date).getTime() : 0));
                // Filtered: use exact sum of PDF rows; unfiltered: use authoritative net_savings
                const pdfContribSum = stRows.filter((r) => r.kind === "contrib").reduce((s, r) => s + r.amount, 0);
                const pdfRefundSum  = stRows.filter((r) => r.kind === "refund").reduce((s, r) => s + r.amount, 0);
                const nsRaw = mySummary.shareholder.net_savings;
                const netBal = isFiltered
                  ? pdfContribSum
                  : (nsRaw != null ? Math.max(0, Number(nsRaw)) : pdfContribSum - pdfRefundSum);
                const myProfitDists = await profitDistributionsApi.listByShareholder(mySummary.shareholder.id);
                await downloadMemberStatementPdf(
                  mySummary.shareholder.name,
                  `EW#${mySummary.shareholder.member_number}`,
                  stRows, netBal, co,
                  buildProfitRows(myProfitDists, yearFilter, monthFilter),
                );
              }}
              disabled={!mySummary}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold flex-shrink-0 hover:opacity-90 transition-opacity disabled:opacity-40"
              style={{ background: "#1e2d4a", color: "#fff" }}
            >
              <FileDown size={13} /> Export PDF
            </button>
          </div>
          <select value={monthFilter === "all" ? "all" : monthFilter}
            onChange={(e) => setMonthFilter(e.target.value === "all" ? "all" : parseInt(e.target.value))}
            className="border rounded-xl px-3 py-1.5 text-xs focus:outline-none bg-white"
            style={{ borderColor: "var(--border)" }}>
            <option value="all">All months</option>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div className="flex-1 overflow-y-auto" style={{ background: "var(--background)" }}>
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
          ) : mySummary ? (
            renderDetail(mySummary)
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center px-8 py-16">
              <p className="text-sm text-gray-400">No contribution records found for your account.</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Full-width header */}
      <div className="flex-shrink-0 px-5 pt-4 pb-4" style={{ background: "#1e2d4a" }}>
        <div className="flex items-center justify-between mb-3">
          <div>
            <h1 className="font-bold text-lg text-white">Contributions</h1>
            <p className="text-xs" style={{ color: "#94a3b8" }}>Monthly savings payments</p>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={async () => {
              const co = await getCompanyDetails();
              // If a member is selected in the detail pane, export their statement
              if (selected) {
                // Use already-filtered contributions from the summary (respects active year/month filter)
                const contribs = selected.contributions;
                // Only include refunds when no filter is active (refunds have no month/year, include all-time)
                const refs: any[] = isFiltered ? [] : await supabase
                  .from("refunds")
                  .select("id, amount, refund_date, notes, created_at")
                  .eq("shareholder_id", selected.shareholder.id)
                  .order("refund_date", { ascending: false })
                  .then(({ data }) => data ?? []);
                const stRows: StatementRow[] = ([
                  ...contribs.map((c: any): StatementRow => ({
                    kind: "contrib",
                    label: `${MONTHS[c.month - 1]} ${c.year}`,
                    date: c.payment_date ? fmtDate(c.payment_date) : "",
                    amount: Number(c.amount),
                    badge: c.status === "late" ? "Late" : "On time",
                    notes: parseContribComment(c.notes),
                    method: parseContribMethod(c.notes),
                  })),
                  ...refs.map((r: any): StatementRow => ({
                    kind: "refund",
                    label: "Refund",
                    date: r.refund_date ? fmtDate(r.refund_date) : (r.created_at ? fmtDate(r.created_at) : ""),
                    amount: Number(r.amount),
                    badge: "Refund",
                    notes: r.notes ?? "",
                  })),
                ]).sort((a, b) => {
                  const da = a.date ? new Date(a.date).getTime() : 0;
                  const db = b.date ? new Date(b.date).getTime() : 0;
                  return db - da;
                });
                // Filtered: exact sum of filtered rows; unfiltered: authoritative net_savings
                const pdfCSum = stRows.filter((r) => r.kind === "contrib").reduce((s, r) => s + Number(r.amount), 0);
                const pdfRSum = stRows.filter((r) => r.kind === "refund").reduce((s, r) => s + Number(r.amount), 0);
                const nsRaw   = selected.shareholder.net_savings;
                const netBal  = isFiltered
                  ? pdfCSum
                  : (nsRaw != null ? Math.max(0, Number(nsRaw)) : pdfCSum - pdfRSum);
                const selProfitDists = await profitDistributionsApi.listByShareholder(selected.shareholder.id);
                await downloadMemberStatementPdf(
                  selected.shareholder.name,
                  `EW#${selected.shareholder.member_number}`,
                  stRows, netBal, co,
                  buildProfitRows(selProfitDists, yearFilter, monthFilter),
                );
                return;
              }
              // No member selected — export all contributions (admin overview)
              const rows: ContribRow[] = summaries.flatMap((s) =>
                s.contributions.map((c) => ({
                  member: s.shareholder.name,
                  memberNo: `EW#${s.shareholder.member_number}`,
                  month: MONTHS[c.month - 1],
                  year: c.year,
                  date_paid: c.payment_date ? fmtDate(c.payment_date) : "—",
                  amount: Number(c.amount),
                  status: c.status,
                  notes: c.notes ?? "—",
                }))
              );
              const filterStr = [yearFilter !== "all" && `Year: ${yearFilter}`, monthFilter !== "all" && `Month: ${MONTHS[(monthFilter as number)-1]}`].filter(Boolean).join(" · ") || "All";
              downloadContributionsPdf(rows, co, filterStr);
            }}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold hover:opacity-90"
              style={{ background: "rgba(255,255,255,0.15)", color: "#fff" }}>
              <FileDown size={13} /> PDF
            </button>
            {!viewOnly && (
              <button onClick={() => setShowRecord(true)}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white hover:opacity-90 transition-opacity"
                style={{ background: "#6366f1" }}>
                <Plus size={13} /> Record
              </button>
            )}
          </div>
        </div>
        {/* Summary cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: "Total Collected", value: fmtKES(totalCollected) },
            { label: "Shareholders", value: String(activeShareholders) },
          ].map((s) => (
            <div key={s.label} className="rounded-xl px-3 py-2.5" style={{ background: "rgba(255,255,255,0.07)" }}>
              <div className="text-xs mb-0.5" style={{ color: "#94a3b8" }}>{s.label}</div>
              <div className="text-sm font-bold text-white">{s.value}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Two-panel row: list + detail */}
      <div className="flex flex-1 overflow-hidden">
      {/* List panel */}
      <div className={`flex flex-col w-full md:w-80 lg:w-96 flex-shrink-0 border-r overflow-hidden ${mobileDetail ? "hidden md:flex" : "flex"}`}
        style={{ background: "var(--background)", borderColor: "var(--border)" }}>

        {/* Year filter pills */}
        <div className="flex gap-1.5 px-3 pt-3 pb-1 overflow-x-auto flex-shrink-0">
          {(["all", ...YEAR_RANGE] as (number | "all")[]).map((y) => (
            <button key={String(y)} onClick={() => setYearFilter(y)}
              className="px-3 py-1 rounded-full text-xs font-semibold flex-shrink-0 transition-all"
              style={{
                background: yearFilter === y ? "#1e2d4a" : "#e2e8f0",
                color: yearFilter === y ? "#fff" : "#475569",
              }}>
              {y === "all" ? "All" : y}
            </button>
          ))}
        </div>

        {/* Search + month filter */}
        <div className="flex gap-2 px-3 py-2 flex-shrink-0">
          <div className="relative flex-1">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search shareholder…"
              className="w-full pl-8 pr-3 py-2 rounded-xl border text-xs focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white"
              style={{ borderColor: "var(--border)" }} />
          </div>
          <select value={monthFilter === "all" ? "all" : monthFilter}
            onChange={(e) => setMonthFilter(e.target.value === "all" ? "all" : parseInt(e.target.value))}
            className="border rounded-xl px-2 py-2 text-xs focus:outline-none bg-white flex-shrink-0"
            style={{ borderColor: "var(--border)" }}>
            <option value="all">All months</option>
            {MONTHS.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 size={22} className="animate-spin text-indigo-400" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">No shareholders found.</div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {filtered.map((s, i) => (
                <button key={s.shareholder.id} onClick={() => { setSelected(s); setMobileDetail(true); }}
                  className={`w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 transition-colors ${selected?.shareholder.id === s.shareholder.id ? "bg-indigo-50" : ""}`}>
                  <span className="text-xs text-gray-400 w-5 flex-shrink-0 text-right">{i + 1}</span>
                  <MemberAvatar photoUrl={s.shareholder.photo_url} name={s.shareholder.name} color={s.shareholder.avatar_color} size={36} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>{s.shareholder.name}</div>
                    <div className="text-xs font-bold" style={{ color: "#6366f1" }}>EW#{s.shareholder.member_number}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-bold" style={{ color: "#22c55e" }}>{fmtKES(displayTotal(s))}</div>
                    <div className="text-xs text-gray-400">{displayCount(s)} pmt{displayCount(s) !== 1 ? "s" : ""}</div>
                  </div>
                  <ChevronRight size={14} className="text-gray-300 flex-shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail panel */}
      <div className={`flex-1 overflow-hidden ${mobileDetail ? "flex" : "hidden md:flex"} flex-col`} style={{ background: "var(--background)" }}>
        {selected ? renderDetail(selected) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#eef2ff" }}>
              <Link2 size={28} color="#6366f1" />
            </div>
            <h3 className="font-bold text-base mb-1" style={{ color: "#1a202c" }}>Select a shareholder</h3>
            <p className="text-sm text-gray-400">Click a shareholder to view their contribution history.</p>
          </div>
        )}
      </div>
      </div>{/* end two-panel row */}

      {showRecord && (
        <RecordContributionModal
          shareholders={allShareholders}
          initial={selected ? { shareholder_id: selected.shareholder.id } : undefined}
          onClose={() => setShowRecord(false)}
          onSave={handleNewContribution}
        />
      )}

    </div>
  );
}

// ─── Placeholder pages ────────────────────────────────────────────────────────

const moduleLabels: Record<Module, string> = {
  dashboard: "Dashboard", shareholders: "Shareholders", clients: "Clients",
  contributions: "Contributions", projects: "Projects", investors: "Ext. Investors",
  payments: "Payments", refunds: "Refunds", reports: "Reports",
  settings: "Settings", "my-plots": "My Plots", help: "Help & Support",
};

const moduleIconMap: Record<Module, { icon: React.ReactNode; bg: string; color: string }> = {
  dashboard:     { icon: <LayoutDashboard size={36} />,  bg: "#fff7ed", color: "#f97316" },
  shareholders:  { icon: <Users size={36} />,            bg: "#eef2ff", color: "#6366f1" },
  clients:       { icon: <UserCircle2 size={36} />,      bg: "#faf5ff", color: "#a855f7" },
  contributions: { icon: <Link2 size={36} />,            bg: "#fdf2f8", color: "#ec4899" },
  projects:      { icon: <FolderOpen size={36} />,       bg: "#f0fdf4", color: "#22c55e" },
  investors:     { icon: <CircleDollarSign size={36} />, bg: "#fefce8", color: "#eab308" },
  payments:      { icon: <CreditCard size={36} />,       bg: "#f0fdfa", color: "#14b8a6" },
  refunds:       { icon: <RotateCcw size={36} />,        bg: "#fef2f2", color: "#ef4444" },
  reports:       { icon: <BarChart2 size={36} />,        bg: "#eff6ff", color: "#3b82f6" },
  settings:      { icon: <SlidersHorizontal size={36} />,bg: "#f8fafc", color: "#64748b" },
  "my-plots":    { icon: <MapPin size={36} />,           bg: "#ecfdf5", color: "#059669" },
  help:          { icon: <HelpCircle size={36} />,       bg: "#f5f3ff", color: "#8b5cf6" },
};

function PlaceholderPage({ module }: { module: Module }) {
  const { icon, bg, color } = moduleIconMap[module];
  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8">
      <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-5" style={{ background: bg, color }}>{icon}</div>
      <h2 className="text-xl font-bold mb-2" style={{ color: "#1a202c" }}>{moduleLabels[module]}</h2>
      <p className="text-sm text-gray-400 max-w-xs">This module is under construction.</p>
    </div>
  );
}

// ─── Shared: get visible nav for current role ─────────────────────────────────

function useVisibleNav(): NavItem[] {
  const profile = useProfile();
  const role = profile?.role ?? "admin";
  const hiddenModules = useHiddenModules(role);
  if (!profile || role === "admin") {
    return navItems.filter((n) => !hiddenModules.includes(n.id) && n.id !== "my-plots" && n.id !== "help");
  }
  // Use per-user allowed_modules if set (reception with custom access), else fall back to role default
  const allowed = (
    (profile.allowed_modules?.length ? profile.allowed_modules : null)
    ?? ROLE_NAV[role]
    ?? ROLE_NAV["investor"]
  ) as Module[];
  return allowed
    .filter((id) => !hiddenModules.includes(id))
    .map((id) => navItems.find((n) => n.id === id))
    .filter(Boolean) as NavItem[];
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

function Sidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const active = (location.pathname.replace("/", "") || "dashboard") as Module;
  const visible = useVisibleNav();

  const [hovered, setHovered] = useState(false);
  const [isDesktop, setIsDesktop] = useState(() => window.innerWidth >= 768);
  const [companyName, setCompanyName] = useState("Egemeo Ardhi");
  const [logoUrl, setLogoUrl] = useState("");

  useEffect(() => {
    getCompanyDetails().then((co) => {
      if (co.name) setCompanyName(co.name);
      if (co.logo_data_url) setLogoUrl(co.logo_data_url);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const handler = (e: MediaQueryListEvent) => setIsDesktop(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const expanded = isDesktop || hovered;

  return (
    <aside
      onMouseEnter={() => !isDesktop && setHovered(true)}
      onMouseLeave={() => !isDesktop && setHovered(false)}
      className="flex flex-col h-full flex-shrink-0 border-r overflow-y-auto overflow-x-hidden"
      style={{
        width: expanded ? 248 : 60,
        transition: "width 0.2s ease",
        background: "var(--sidebar)",
        borderColor: "var(--sidebar-border)",
        fontFamily: "'Plus Jakarta Sans', sans-serif",
      }}>
      <div className="flex items-center gap-2.5 px-3 pt-5 pb-4 overflow-hidden">
        {logoUrl ? (
          <img src={logoUrl} alt={companyName} className="w-9 h-9 rounded-full object-contain flex-shrink-0 bg-white" style={{ border: "1px solid #e2e8f0" }} />
        ) : (
          <div className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white flex-shrink-0" style={{ background: "#22c55e" }}>
            {companyName.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "EA"}
          </div>
        )}
        {expanded && <span className="font-bold text-sm whitespace-nowrap" style={{ color: "#1a202c" }}>{companyName}</span>}
      </div>
      <nav className="flex-1 px-2 pb-2 space-y-0.5">
        {visible.map((item) => {
          const isActive = active === item.id;
          return (
            <button key={item.id} onClick={() => navigate(item.id === "dashboard" ? "/" : `/${item.id}`)}
              title={!expanded ? item.label : undefined}
              className="w-full flex items-center gap-2.5 px-2 py-2 rounded-xl text-sm font-medium transition-colors duration-100"
              style={{ background: isActive ? "var(--sidebar-accent)" : "transparent", color: isActive ? "var(--sidebar-accent-foreground)" : "var(--sidebar-foreground)" }}>
              <span className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: item.iconBg }}>{item.icon}</span>
              {expanded && (
                <>
                  <span className="flex-1 text-left whitespace-nowrap text-sm">{item.label}</span>
                  {item.hasChevron && <ChevronRight size={13} className="opacity-40 flex-shrink-0" />}
                </>
              )}
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

// ─── Mobile Bottom Nav ────────────────────────────────────────────────────────

function BottomNav() {
  const navigate = useNavigate();
  const location = useLocation();
  const active = (location.pathname.replace("/", "") || "dashboard") as Module;
  const [othersOpen, setOthersOpen] = useState(false);
  const visible = useVisibleNav();
  const nav = (m: Module) => { navigate(m === "dashboard" ? "/" : `/${m}`); setOthersOpen(false); };
  const visiblePrimary = visible.slice(0, 4);
  const visibleOthers  = visible.slice(4);

  return (
    <>
      {othersOpen && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={() => setOthersOpen(false)} />
          <div className="fixed bottom-16 left-0 right-0 z-50 rounded-t-2xl bg-white shadow-2xl" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="flex items-center justify-between px-5 pt-4 pb-3">
              <span className="text-sm font-semibold" style={{ color: "#1a202c" }}>More Modules</span>
              <button onClick={() => setOthersOpen(false)} className="p-1.5 rounded-full bg-gray-100 text-gray-500"><X size={15} /></button>
            </div>
            <div className="grid grid-cols-3 gap-1 px-3 pb-4">
              {visibleOthers.map((item) => (
                <button key={item.id} onClick={() => nav(item.id)}
                  className="flex flex-col items-center gap-1.5 py-3 px-2 rounded-xl transition-colors"
                  style={{ background: active === item.id ? "var(--accent)" : "transparent" }}>
                  <span className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background: item.iconBg }}>{item.icon}</span>
                  <span className="text-xs font-medium text-center leading-tight" style={{ color: active === item.id ? "var(--accent-foreground)" : "#374151" }}>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
      <nav className="fixed bottom-0 left-0 right-0 z-40 flex items-stretch bg-white border-t"
        style={{ borderColor: "var(--border)", paddingBottom: "env(safe-area-inset-bottom)" }}>
        {visiblePrimary.map((item) => {
          const isActive = active === item.id;
          return (
            <button key={item.id} onClick={() => nav(item.id)} className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5 relative">
              {isActive && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-t-full" style={{ background: item.iconBg }} />}
              <span className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: item.iconBg }}>
                {item.icon}
              </span>
              <span className="text-[10px] font-medium leading-none" style={{ color: isActive ? item.iconBg : "#64748b" }}>{item.label}</span>
            </button>
          );
        })}
        <button onClick={() => setOthersOpen((v) => !v)} className="flex-1 flex flex-col items-center justify-center gap-1 py-2.5 relative">
          {othersOpen && <span className="absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-t-full" style={{ background: "#1e2d4a" }} />}
          <span className="w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: othersOpen ? "#1e2d4a" : "#64748b" }}>
            {othersOpen ? <X size={19} color="#fff" /> : <MoreHorizontal size={19} color="#fff" />}
          </span>
          <span className="text-[10px] font-medium leading-none" style={{ color: othersOpen ? "#1e2d4a" : "#64748b" }}>Others</span>
        </button>
      </nav>
    </>
  );
}

// ─── App Shell ────────────────────────────────────────────────────────────────

function AppShell() {
  const navigate   = useNavigate();
  const location   = useLocation();
  const active     = (location.pathname.replace("/", "") || "dashboard") as Module;
  const currentNav = navItems.find((n) => n.id === active);
  const isAdmin    = !useIsViewOnly();
  const profile    = useProfile();
  const systemLive = useSystemLive();

  // Guard: redirect to dashboard if non-admin navigates to a module outside their role OR that is hidden for their role
  const hiddenForRole = useHiddenModules(profile?.role ?? "investor");
  useEffect(() => {
    if (!profile || profile.role === "admin") return;
    const allowed = (
      (profile.allowed_modules?.length ? profile.allowed_modules : null)
      ?? ROLE_NAV[profile.role]
      ?? ROLE_NAV["investor"]
    );
    const blocked =
      active !== "dashboard" &&
      (!allowed.includes(active) || hiddenForRole.includes(active));
    if (blocked) navigate("/", { replace: true });
  }, [active, profile, navigate, hiddenForRole]);

  const [firstName, setFirstName] = useState<string>("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (!session?.user) return;
      // Try user_profiles table first, fall back to auth metadata
      const { data } = await supabase
        .from("user_profiles")
        .select("full_name")
        .eq("id", session.user.id)
        .single();
      const name = data?.full_name || session.user.user_metadata?.full_name || session.user.email || "";
      setFirstName(name.split(" ")[0]);
    });
  }, []);

  const handleLogout = async () => {
    setLoggingOut(true);
    await supabase.auth.signOut();
    window.location.reload();
  };

  return (
    <>
    <div className="size-full flex flex-col overflow-hidden" style={{ fontFamily: "'Plus Jakarta Sans', sans-serif" }}>
      <Toaster position="top-right" richColors />
      {systemLive === false && isAdmin && (
        <div className="flex-shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 text-xs font-bold text-amber-900"
          style={{ background: "#fef08a", borderBottom: "2px solid #fde047" }}>
          <span>🔴</span>
          <span>SYSTEM IN DEVELOPMENT / TESTING MODE — Not yet live to users</span>
          <span>🔴</span>
        </div>
      )}
      <div className="flex-1 flex overflow-hidden min-h-0">
        <div className="hidden md:flex">
          <Sidebar />
        </div>

      <div className="flex-1 flex flex-col overflow-hidden" style={{ background: "var(--background)" }}>
        <header className="flex items-center gap-3 px-4 md:px-6 py-3 border-b bg-white flex-shrink-0" style={{ borderColor: "var(--card-border)" }}>
          {active !== "dashboard" && (
            <button
              onClick={() => navigate("/")}
              className="flex md:hidden items-center gap-1 text-xs font-semibold mr-1 px-2 py-1.5 rounded-lg transition-colors hover:bg-gray-100"
              style={{ color: "#6366f1" }}
            >
              <ArrowLeft size={15} />
              <span>Back</span>
            </button>
          )}
          {currentNav && (
            <span className="w-6 h-6 rounded-md flex items-center justify-center" style={{ background: currentNav.iconBg }}>{currentNav.icon}</span>
          )}
          <span className="font-semibold text-sm" style={{ color: "#1a202c" }}>{moduleLabels[active] ?? moduleLabels["dashboard"]}</span>
          <div className="flex-1" />
          {firstName && (
            <span className="text-xs font-semibold hidden sm:block" style={{ color: "#16a34a" }}>{firstName}</span>
          )}
          <button
            onClick={() => setConfirmLogout(true)}
            disabled={loggingOut}
            className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50"
            style={{ color: "#16a34a", borderColor: "#16a34a", background: "#f0fdf4" }}
          >
            {loggingOut ? <Loader2 size={13} className="animate-spin" /> : <LogOut size={13} />}
            <span className="hidden sm:inline">Logout</span>
          </button>
        </header>

        <main className="flex-1 overflow-hidden min-h-0">
          {active === "dashboard" ? (
            <div className="h-full overflow-auto pb-20 md:pb-0">
              <DashboardPage onNavigate={(m) => navigate(m === "dashboard" ? "/" : `/${m}`)} />
            </div>
          ) : active === "my-plots" ? (
            <div className="h-full overflow-auto pb-20 md:pb-0"><MyPlotsPage /></div>
          ) : active === "help" ? (
            <div className="h-full overflow-auto pb-20 md:pb-0"><HelpPage /></div>
          ) : active === "shareholders" ? (
            <ShareholdersPage />
          ) : active === "clients" ? (
            <ClientsPage />
          ) : active === "investors" ? (
            <InvestorsPage />
          ) : active === "contributions" ? (
            <ContributionsPage />
          ) : active === "projects" ? (
            <ProjectsPage isAdmin={isAdmin} currentMemberId={profile?.member_id} currentMemberType={profile?.role} />
          ) : active === "reports" ? (
            <ReportsPage />
          ) : active === "payments" ? (
            <PaymentsPage />
          ) : active === "mpesa-transactions" ? (
            <MpesaTransactionsPage />
          ) : active === "refunds" ? (
            <RefundsPage />
          ) : active === "settings" ? (
            <SettingsPage isAdmin={isAdmin} />
          ) : (
            <PlaceholderPage module={active} />
          )}
        </main>

        {/* Support footer */}
        <a
          href="https://wa.me/254725689199?text=I%20need%20help%20with%20Sacco%20Management%20System"
          target="_blank"
          rel="noopener noreferrer"
          className="flex-shrink-0 items-center justify-center gap-2 px-4 py-1.5 transition-opacity hover:opacity-80 hidden md:flex"
          style={{ background: "#f0fdf4", borderTop: "1px solid #bbf7d0" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="#25D366">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
          </svg>
          <span className="text-xs font-semibold" style={{ color: "#15803d" }}>
            Sacco Management System by <strong>Make IT Digital</strong>
          </span>
          <span className="text-xs" style={{ color: "#16a34a" }}>· +254 725 689 199</span>
        </a>
      </div>

      <div className="md:hidden">
        <BottomNav />
      </div>

      </div>
    </div>

    {/* ── Logout confirmation ── */}
    {confirmLogout && (
      <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/40">
        <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs p-6 flex flex-col items-center gap-4">
          <div className="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "#fef2f2" }}>
            <LogOut size={22} color="#dc2626" />
          </div>
          <div className="text-center">
            <p className="font-bold text-base" style={{ color: "#1a202c" }}>Confirm Logout</p>
            <p className="text-xs text-gray-400 mt-1">Are you sure you want to log out?</p>
          </div>
          <div className="flex gap-3 w-full">
            <button
              onClick={() => setConfirmLogout(false)}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50 transition-colors"
              style={{ borderColor: "var(--border)" }}>
              Cancel
            </button>
            <button
              onClick={() => { setConfirmLogout(false); handleLogout(); }}
              disabled={loggingOut}
              className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white transition-opacity hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-1.5"
              style={{ background: "#dc2626" }}>
              {loggingOut ? <Loader2 size={14} className="animate-spin" /> : <LogOut size={14} />}
              Logout
            </button>
          </div>
        </div>
      </div>
    )}
    </>
  );
}

// ─── Router ───────────────────────────────────────────────────────────────────

const router = createBrowserRouter([
  {
    path: "/",
    Component: AppShell,
  },
  {
    path: "/:module",
    Component: AppShell,
  },
]);

// ─── Auth-gated root ─────────────────────────────────────────────────────────

export default function App() {
  const [authReady, setAuthReady]   = useState(false);
  const [session,   setSession]     = useState<any>(null);
  const [profile,   setProfile]     = useState<UserProfile | null>(null);
  const [splashName, setSplashName] = useState(() => localStorage.getItem("sacco_splash_name") || "Egemeo Ardhi");
  const [splashLogo, setSplashLogo] = useState(() => localStorage.getItem("sacco_splash_logo") || "");

  useEffect(() => {
    getCompanyDetails().then((co) => {
      if (co.name) { setSplashName(co.name); localStorage.setItem("sacco_splash_name", co.name); }
      if (co.logo_data_url) { setSplashLogo(co.logo_data_url); localStorage.setItem("sacco_splash_logo", co.logo_data_url); }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    // Pull module visibility + view settings from Supabase on every app load
    syncVisibilitySettingsFromCloud().catch(() => {});

    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        const p = await fetchProfile(s.user.id, s.user.email ?? "");
        setProfile(p);
      }
      setAuthReady(true);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(async (event, s) => {
      setSession(s);
      if (s?.user) {
        const p = await fetchProfile(s.user.id, s.user.email ?? "");
        setProfile(p);
      } else {
        setProfile(null);
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  const handleLoggedIn = async (s: any, p: UserProfile) => {
    setSession(s);
    setProfile(p);
    logActivity({ category: "auth", action: "login", description: `${p.full_name} logged in`, actor_name: p.full_name, actor_role: p.role });
  };

  const handleLogout = async () => {
    if (profile) logActivity({ category: "auth", action: "logout", description: `${profile.full_name} logged out`, actor_name: profile.full_name, actor_role: profile.role });
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
  };

  const handlePasswordSet = async () => {
    if (session?.user) {
      const p = await fetchProfile(session.user.id, session.user.email ?? "");
      setProfile(p ? { ...p, password_changed: true } : null);
    }
  };

  if (!authReady) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center"
        style={{ background: "#1e2d4a" }}>
        <style>{`
          @keyframes ea-pulse { 0%,100%{transform:scale(1);opacity:1} 50%{transform:scale(1.08);opacity:0.85} }
          @keyframes ea-bar { 0%{width:0%} 60%{width:75%} 85%{width:88%} 100%{width:95%} }
          @keyframes ea-fade-in { from{opacity:0;transform:translateY(12px)} to{opacity:1;transform:translateY(0)} }
          .ea-logo-pulse { animation: ea-pulse 2s ease-in-out infinite; }
          .ea-bar { animation: ea-bar 2.5s cubic-bezier(.4,0,.2,1) forwards; }
          .ea-fade-in { animation: ea-fade-in 0.6s ease-out forwards; }
        `}</style>

        <div className="flex flex-col items-center gap-6 ea-fade-in">
          {/* Logo mark */}
          <div className="ea-logo-pulse relative">
            {splashLogo ? (
              <img src={splashLogo} alt={splashName}
                className="w-24 h-24 rounded-3xl object-contain shadow-2xl bg-white"
                style={{ padding: "6px" }} />
            ) : (
              <div className="w-24 h-24 rounded-3xl flex items-center justify-center shadow-2xl"
                style={{ background: "linear-gradient(135deg, #22c55e 0%, #16a34a 100%)" }}>
                <span className="text-white font-black text-4xl tracking-tight select-none">
                  {splashName.split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "EA"}
                </span>
              </div>
            )}
            {/* Glow ring */}
            <div className="absolute inset-0 rounded-3xl"
              style={{ boxShadow: "0 0 40px rgba(34,197,94,0.35)", pointerEvents: "none" }} />
          </div>

          {/* Brand name */}
          <div className="text-center">
            <h1 className="text-white font-black text-2xl tracking-wide">{splashName}</h1>
            <p className="text-xs mt-1 font-medium" style={{ color: "#64748b" }}>Sacco Management System</p>
          </div>

          {/* Loading bar */}
          <div className="w-48 h-1 rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.1)" }}>
            <div className="ea-bar h-full rounded-full" style={{ background: "linear-gradient(90deg, #22c55e, #4ade80)" }} />
          </div>
        </div>
      </div>
    );
  }

  // Not logged in
  if (!session) {
    return <LoginPage onLoggedIn={handleLoggedIn} />;
  }

  // Session exists but profile is still loading — show spinner to prevent admin flash
  if (!profile) {
    return (
      <div className="fixed inset-0 flex items-center justify-center bg-white">
        <Loader2 size={28} className="animate-spin" style={{ color: "#cbd5e1" }} />
      </div>
    );
  }

  // Logged in but must change password first
  if (!profile.password_changed) {
    return <SetPasswordPage profile={profile} onComplete={handlePasswordSet} />;
  }

  // All roles — same shell with role-filtered nav via ProfileCtx
  return (
    <ProfileCtx.Provider value={profile}>
      <RouterProvider router={router} />
    </ProfileCtx.Provider>
  );
}
