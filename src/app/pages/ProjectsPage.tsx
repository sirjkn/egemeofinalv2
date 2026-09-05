import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useLocation } from "react-router";
import {
  FolderOpen, MapPin, Plus, Search, X, ArrowLeft,
  Users, ChevronDown, Loader2, Wallet, UploadCloud,
  RotateCcw, AlertCircle, RefreshCw, Edit2, Trash2,
  UserPlus, TrendingUp, History, CircleDollarSign, UserCircle2, CheckCircle2,
  FileText, Download, Eye, FileDown, List,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import {
  projectsApi, plotsApi, plotPaymentsApi, shareholdersApi, clientsApi,
  profitDistributionsApi, investorsApi, projectInvestmentsApi, plotCoOwnersApi,
  logActivity,
  type Project, type Plot, type PlotPayment, type Shareholder, type Client,
  type PlotAssignPayload, type ProfitDistribution, type PlotCoOwner,
} from "@/lib/api";
import { fmtKES, fmtKESFull } from "@/app/shared";
import { getPaymentSettings } from "@/lib/mpesa";
import { getEnabledPaymentMethodKeys } from "@/lib/settingsApi";
import { sendSms, smsTemplates, SMS_TRIGGERS } from "@/lib/sms";
import { downloadPlotPaymentHistoryPdf } from "@/lib/pdf";
import { getCompanyDetails } from "@/lib/company";

// ─── Shared Confirm Modal ────────────────────────────────────────────────────

function ConfirmModal({ title, message, confirmLabel = "Delete", onConfirm, onCancel, busy = false }: {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
        <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
          <p className="font-bold text-sm" style={{ color: "#b91c1c" }}>{title}</p>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-600">{message}</p>
          <div className="flex gap-2">
            <button onClick={onCancel} disabled={busy}
              className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50 disabled:opacity-50"
              style={{ borderColor: "var(--border)" }}>Cancel</button>
            <button onClick={onConfirm} disabled={busy}
              className="flex-1 py-2.5 rounded-xl font-bold text-white flex items-center justify-center gap-1.5 disabled:opacity-50"
              style={{ background: "#ef4444" }}>
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Assign Plot Modal ────────────────────────────────────────────────────────

// ─── Add Co-Owner Modal ───────────────────────────────────────────────────────

function AddCoOwnerModal({ plot, shareholders, clients, existingCoOwners, onClose, onDone }: {
  plot: Plot;
  shareholders: Shareholder[];
  clients: Client[];
  existingCoOwners: PlotCoOwner[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [memberType, setMemberType] = useState<"shareholder" | "client">("shareholder");
  const [memberId, setMemberId] = useState<number | "">("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<PlotCoOwner | null>(null);
  const [err, setErr] = useState("");
  const list = memberType === "shareholder" ? shareholders : clients;

  const add = async () => {
    if (!memberId) { setErr("Select a member."); return; }
    setSaving(true); setErr("");
    try {
      await plotCoOwnersApi.add(plot.id, memberId as number, memberType);
      logActivity({ category: "plot", action: "update", description: `Co-owner added to plot ${plot.plot_number}`, meta: { plot_id: plot.id } });
      setMemberId("");
      onDone();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const remove = async (co: PlotCoOwner) => {
    setRemoving(co.id);
    try {
      await plotCoOwnersApi.remove(co.id);
      logActivity({ category: "plot", action: "update", description: `Co-owner removed from plot`, meta: { co_owner_id: co.id } });
      onDone();
    }
    catch { /* ignore */ }
    finally { setRemoving(null); }
  };

  const memberName = (co: PlotCoOwner) => {
    if (co.member_type === "shareholder") {
      const s = shareholders.find((x) => x.id === co.member_id);
      return s ? { num: `EW#${s.member_number}`, name: s.name } : { num: `#${co.member_id}`, name: "Unknown" };
    }
    const c = clients.find((x) => x.id === co.member_id);
    return c ? { num: c.member_number ?? `#${co.member_id}`, name: c.name } : { num: `#${co.member_id}`, name: "Unknown" };
  };

  return (
    <>
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Co-Owners — {plot.plot_number}</h2>
            <p className="text-xs text-gray-400">Add or remove co-owners for this plot</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          {/* Existing co-owners */}
          {existingCoOwners.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Current Co-Owners</p>
              {existingCoOwners.map((co) => {
                const m = memberName(co);
                return (
                  <div key={co.id} className="flex items-center gap-3 border rounded-xl px-3 py-2.5" style={{ borderColor: "var(--border)" }}>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-indigo-500">#{m.num}</span>
                        <span className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>{m.name}</span>
                      </div>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-full font-semibold"
                        style={{ background: co.member_type === "shareholder" ? "#eff6ff" : "#fef3c7", color: co.member_type === "shareholder" ? "#2563eb" : "#d97706" }}>
                        {co.member_type === "shareholder" ? "Shareholder" : "Client"}
                      </span>
                    </div>
                    <button onClick={() => setConfirmRemove(co)} disabled={removing === co.id}
                      className="text-red-400 hover:text-red-600 p-1 rounded-lg hover:bg-red-50 transition-colors disabled:opacity-50">
                      {removing === co.id ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Add new */}
          <div className="space-y-3">
            <p className="text-xs font-bold text-gray-500 uppercase tracking-wider">Add Co-Owner</p>
            <div className="grid grid-cols-2 gap-2">
              {(["shareholder", "client"] as const).map((t) => (
                <button key={t} onClick={() => { setMemberType(t); setMemberId(""); }}
                  className="py-2.5 rounded-xl text-sm font-semibold border-2 transition-all"
                  style={memberType === t ? { borderColor: "#1e2d4a", color: "#1e2d4a", background: "#f0f4ff" } : { borderColor: "#e2e8f0", color: "#64748b" }}>
                  {t === "shareholder" ? "Shareholder" : "Client"}
                </button>
              ))}
            </div>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value ? parseInt(e.target.value) : "")}
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ borderColor: "var(--border)" }}>
              <option value="">Choose member…</option>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {memberType === "shareholder" ? `EW#${(m as Shareholder).member_number}` : (m as Client).member_number} — {m.name}
                </option>
              ))}
            </select>
            {err && <p className="text-xs text-red-500">{err}</p>}
            <button onClick={add} disabled={saving || !memberId}
              className="w-full py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
              style={{ background: "#1e2d4a" }}>
              {saving ? "Adding…" : "Add Co-Owner"}
            </button>
          </div>
        </div>
      </div>
    </div>
    {confirmRemove && (
      <ConfirmModal
        title="Remove Co-Owner"
        message={<>Remove <strong>{memberName(confirmRemove).name}</strong> as a co-owner of plot <strong>{plot.plot_number}</strong>?</>}
        confirmLabel="Remove"
        busy={removing === confirmRemove.id}
        onCancel={() => setConfirmRemove(null)}
        onConfirm={() => { remove(confirmRemove); setConfirmRemove(null); }}
      />
    )}
    </>
  );
}

function AssignPlotModal({
  plot, projectName, shareholders, clients, onClose, onSave,
}: {
  plot: Plot; projectName: string;
  shareholders: Shareholder[]; clients: Client[];
  onClose: () => void; onSave: (plotId: number, p: PlotAssignPayload) => Promise<void>;
}) {
  const [assignTo, setAssignTo] = useState<"shareholder" | "client">("shareholder");
  const [memberId, setMemberId] = useState<number | "">("");
  const [payMode, setPayMode] = useState<"cash" | "installment">("cash");
  const [duration, setDuration] = useState(12);
  const [intType, setIntType] = useState<"fixed" | "percentage">("fixed");
  const [intAmount, setIntAmount] = useState("");
  const [minMonthlyPayment, setMinMonthlyPayment] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const list = assignTo === "shareholder" ? shareholders : clients;

  const submit = async () => {
    if (!memberId) { setErr("Please select a member."); return; }
    setSaving(true); setErr("");
    try {
      await onSave(plot.id, {
        assigned_to_id: memberId as number,
        assigned_to_type: assignTo,
        payment_mode: payMode,
        loan_duration_months: payMode === "installment" ? duration : undefined,
        interest_type: payMode === "installment" ? intType : undefined,
        interest_amount: payMode === "installment" && intAmount ? parseFloat(intAmount) : undefined,
        min_monthly_payment: payMode === "installment" && minMonthlyPayment ? parseFloat(minMonthlyPayment) : undefined,
      });
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Assign Plot</h2>
            <p className="text-xs text-gray-400">Configure payment terms</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto max-h-[70vh]">
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">Select Plot</p>
            <div className="border rounded-xl px-3 py-2.5 text-sm bg-gray-50" style={{ borderColor: "var(--border)" }}>
              {plot.plot_number} — {plot.price > 0 ? fmtKESFull(Number(plot.price)) : "No price set"}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">Assign To</p>
            <div className="grid grid-cols-2 gap-2">
              {(["shareholder", "client"] as const).map((t) => (
                <button key={t} onClick={() => { setAssignTo(t); setMemberId(""); }}
                  className="py-2.5 rounded-xl text-sm font-semibold border-2 transition-all"
                  style={assignTo === t ? { borderColor: "#1e2d4a", color: "#1e2d4a", background: "#f0f4ff" } : { borderColor: "#e2e8f0", color: "#64748b" }}>
                  {t === "shareholder" ? `Shareholders (${shareholders.length})` : `Clients (${clients.length})`}
                </button>
              ))}
            </div>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">Select Member</p>
            <select value={memberId} onChange={(e) => setMemberId(e.target.value ? parseInt(e.target.value) : "")}
              className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
              style={{ borderColor: "var(--border)" }}>
              <option value="">Choose a member…</option>
              {list.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name} — {assignTo === "shareholder" ? `EW#${(m as Shareholder).member_number}` : (m as Client).member_number}
                </option>
              ))}
            </select>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600 mb-2">Payment Mode</p>
            <div className="grid grid-cols-2 gap-2">
              {(["cash", "installment"] as const).map((m) => (
                <button key={m} onClick={() => setPayMode(m)}
                  className="py-2.5 rounded-xl text-sm font-semibold border-2 transition-all"
                  style={payMode === m ? { borderColor: "#1e2d4a", color: "#1e2d4a", background: "#f0f4ff" } : { borderColor: "#e2e8f0", color: "#64748b" }}>
                  {m === "installment" ? "Instalments" : "Cash"}
                </button>
              ))}
            </div>
          </div>
          {payMode === "installment" && (
            <>
              <div>
                <label className="text-xs font-semibold text-gray-600">Loan Duration (months)</label>
                <input type="number" value={duration} onChange={(e) => setDuration(parseInt(e.target.value) || 12)} min={1}
                  className="w-full mt-1 border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: "var(--border)" }} />
              </div>
              <div>
                <p className="text-xs font-semibold text-gray-600 mb-2">Interest Type</p>
                <div className="grid grid-cols-2 gap-2">
                  {(["fixed", "percentage"] as const).map((t) => (
                    <button key={t} onClick={() => setIntType(t)}
                      className="py-2 rounded-xl text-xs font-semibold border-2 transition-all"
                      style={intType === t ? { borderColor: "#1e2d4a", color: "#1e2d4a", background: "#f0f4ff" } : { borderColor: "#e2e8f0", color: "#64748b" }}>
                      {t === "fixed" ? "Fixed Amount (KES)" : "Percentage (%)"}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600">
                  {intType === "fixed" ? "Interest Amount (KES)" : "Interest Rate (%)"}
                </label>
                <input type="number" value={intAmount} onChange={(e) => setIntAmount(e.target.value)}
                  placeholder={intType === "fixed" ? "e.g. 60000" : "e.g. 10"}
                  className="w-full mt-1 border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: "var(--border)" }} />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600">Minimum Payment Per Month (KES)</label>
                <input type="number" value={minMonthlyPayment} onChange={(e) => setMinMonthlyPayment(e.target.value)}
                  placeholder="e.g. 10000"
                  className="w-full mt-1 border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                  style={{ borderColor: "var(--border)" }} />
                <p className="text-xs text-gray-400 mt-0.5">Leave blank for no minimum on this plot</p>
              </div>
            </>
          )}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="px-6 py-4 border-t" style={{ borderColor: "var(--border)" }}>
          <button onClick={submit} disabled={saving}
            className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#1e2d4a" }}>
            {saving ? "Assigning…" : "Assign Plot"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Plot Payment Modal ───────────────────────────────────────────────────────

type PayMethod = "cash" | "mpesa" | "bank" | "cheque";

const PLOT_METHOD_META: Record<PayMethod, { label: string; icon: string; color: string; bg: string }> = {
  cash:   { label: "Cash",          icon: "💵", color: "#16a34a", bg: "#f0fdf4" },
  mpesa:  { label: "M-Pesa",        icon: "📱", color: "#22c55e", bg: "#f0fdf4" },
  bank:   { label: "Bank Transfer", icon: "🏦", color: "#2563eb", bg: "#eff6ff" },
  cheque: { label: "Cheque",        icon: "📝", color: "#7c3aed", bg: "#f5f3ff" },
};

export { type PayMethod, PLOT_METHOD_META };

export function PlotPaymentModal({ plot, projectName, assignedName, memberPhone, isAdmin = false, onClose, onSave }: {
  plot: Plot;
  projectName?: string;
  assignedName?: string;
  memberPhone?: string;
  isAdmin?: boolean;
  onClose: () => void;
  onSave: (amount: number, method: PayMethod, reference?: string, viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => Promise<void>;
}) {
  const due = Math.max(0, Number(plot.price) - Number(plot.paid_amount));
  const [step, setStep] = useState<"amount" | "method">("amount");
  const [amount, setAmount] = useState("");

  const [enabledMethods, setEnabledMethods] = useState<PayMethod[]>(() => {
    if (!isAdmin) return ["mpesa"];
    const cfg = getPaymentSettings();
    const extra = (["cash", "bank", "cheque"] as const).filter((m) => cfg.methods[m]);
    return [...new Set(["mpesa", ...extra])] as PayMethod[];
  });
  useEffect(() => {
    if (!isAdmin) { setEnabledMethods(["mpesa"]); return; }
    getEnabledPaymentMethodKeys().then((keys) => setEnabledMethods(keys as PayMethod[])).catch(() => {});
  }, [isAdmin]);
  const [method, setMethod] = useState<PayMethod>("mpesa");
  const [mpesaMode, setMpesaMode] = useState<"stk" | "manual">("stk");
  const [manualRef, setManualRef] = useState("");
  const [manualPaidBy, setManualPaidBy] = useState(assignedName ?? "");
  const [manualPhone, setManualPhone] = useState(memberPhone ?? "");
  const [manualComment, setManualComment] = useState("");
  const [reference, setReference] = useState("");
  const [chequeNo, setChequeNo] = useState("");
  const [bankName, setBankName] = useState("");
  const [processing, setProcessing] = useState(false);
  const [err, setErr] = useState("");

  // STK state
  const [stkPhone, setStkPhone] = useState(memberPhone ?? "");
  const [stkState, setStkState] = useState<"idle" | "pushing" | "waiting" | "success" | "failed">("idle");
  const [stkError, setStkError] = useState("");
  const [stkReceipt, setStkReceipt] = useState("");
  const [checkoutId, setCheckoutId] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollCount = useRef(0);
  const [waitCountdown, setWaitCountdown]   = useState(3);
  const [closeCountdown, setCloseCountdown] = useState(5);
  const waitCountRef  = useRef<ReturnType<typeof setInterval> | null>(null);
  const closeCountRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingComplete = useRef<{ receipt: string; phone: string } | null>(null);

  const parsedAmount = Math.min(parseFloat(amount) || 0, due);

  const handleProceed = () => {
    if (!parsedAmount || parsedAmount <= 0) return;
    setStep("method");
  };

  const sendStk = async () => {
    if (!stkPhone.trim()) { setErr("Enter a phone number"); return; }
    setErr(""); setStkState("pushing");
    try {
      const { data, error } = await supabase.functions.invoke("mpesa-stk", {
        body: {
          action: "push",
          phone: stkPhone.trim(),
          amount: Math.round(parsedAmount),
          accountRef: (projectName ? `${projectName}/Plot ${plot.plot_number}` : `Plot ${plot.plot_number}`).slice(0, 12),
          description: (projectName ? `${projectName}/Plot ${plot.plot_number}` : `Plot ${plot.plot_number}`).slice(0, 50),
        },
      });
      if (error) throw error;
      if (!data?.success) throw new Error(data?.error ?? "STK push failed");
      setCheckoutId(data.CheckoutRequestID ?? "");
      // Start 3-second waiting countdown
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

  useEffect(() => {
    if (stkState !== "waiting" || !checkoutId) return;
    pollCount.current = 0;
    const poll = async () => {
      pollCount.current += 1;
      if (pollCount.current > 18) {
        clearInterval(pollRef.current!);
        setStkState("failed");
        setStkError("Timed out. Try again or use Manual Code.");
        return;
      }
      try {
        const { data } = await supabase.functions.invoke("mpesa-stk", {
          body: { action: "query", checkoutRequestId: checkoutId },
        });
        const rc = String(data?.ResultCode ?? data?.errorCode ?? "");
        if (rc === "0") {
          clearInterval(pollRef.current!);

          // 1. Try receipt from query response CallbackMetadata (populated by edge fn if callback already stored)
          const queryItems: { Name: string; Value?: string | number }[] = data?.CallbackMetadata?.Item ?? [];
          let receipt = String(queryItems.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");

          // 2. If not there, read the callback stored in app_settings directly from the client
          if (!receipt) {
            try {
              const { data: cbRow } = await supabase
                .from("app_settings")
                .select("value")
                .eq("key", "mpesa_callback_last")
                .maybeSingle();
              if (cbRow?.value) {
                const stkCb = (cbRow.value as any)?.Body?.stkCallback ?? cbRow.value;
                const cbItems: { Name: string; Value?: string | number }[] =
                  stkCb?.CallbackMetadata?.Item ?? [];
                receipt = String(cbItems.find((i) => i.Name === "MpesaReceiptNumber")?.Value ?? "");
              }
            } catch { /* best-effort */ }
          }

          // 3. Last resort: use the final numeric segment of the checkout ID (still unique, no long prefix)
          if (!receipt) {
            receipt = checkoutId.replace(/^ws_CO_\d{14}/, "").replace(/\D/g, "").slice(-10) || checkoutId.slice(-10);
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
                if (p) { onSave(parsedAmount, "mpesa", p.receipt, true, p.phone).then(() => onClose()).catch(() => onClose()); }
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
    setErr("");
    if (method === "mpesa" && mpesaMode === "manual" && !manualRef.trim()) { setErr("Enter M-Pesa transaction code"); return; }
    setProcessing(true);
    try {
      const ref =
        method === "mpesa" ? manualRef.trim() :
        method === "cheque" ? chequeNo :
        method === "bank" ? `${bankName} ${reference}`.trim() :
        reference;
      const isManualMpesa = method === "mpesa" && mpesaMode === "manual";
      await onSave(
        parsedAmount, method, ref || undefined, false,
        isManualMpesa ? (manualPhone || undefined) : undefined,
        isManualMpesa ? { paidBy: manualPaidBy || undefined, comment: manualComment || undefined } : undefined,
      );
      onClose();
    } catch (e: any) {
      setErr(e.message);
      setProcessing(false);
    }
  };

  const isStkBusy = stkState === "pushing" || stkState === "waiting" || stkState === "success";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 flex items-center justify-between border-b" style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#1a202c" }}>
              {step === "amount" ? `Record Payment — ${plot.plot_number}` : "Select Payment Method"}
            </p>
            {assignedName && <p className="text-xs text-gray-400 mt-0.5">{assignedName}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4">
          {step === "amount" ? (
            <>
              <p className="text-xs text-gray-500">Outstanding: <span className="font-bold text-red-500">{fmtKESFull(due)}</span></p>
              <input
                type="number" value={amount} onChange={(e) => setAmount(e.target.value)}
                placeholder="Amount (KES)"
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }}
                autoFocus
              />
              <button onClick={handleProceed} disabled={!parsedAmount || parsedAmount <= 0}
                className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-60"
                style={{ background: "#2563eb" }}>
                Proceed to Payment →
              </button>
            </>
          ) : (
            <>
              {/* Amount pill */}
              <div className="flex items-center justify-between bg-gray-50 rounded-xl px-4 py-3">
                <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Amount</span>
                <span className="text-xl font-bold" style={{ color: "#1a202c" }}>{fmtKESFull(parsedAmount)}</span>
              </div>

              {/* Method grid */}
              <div className="grid grid-cols-2 gap-2">
                {enabledMethods.map((m) => {
                  const meta = PLOT_METHOD_META[m];
                  return (
                    <button key={m} onClick={() => { setMethod(m); setErr(""); if (m !== "mpesa") resetStk(); }}
                      className="flex items-center gap-2 px-3 py-2.5 rounded-xl border-2 text-left transition-all"
                      style={{
                        borderColor: method === m ? meta.color : "var(--border)",
                        background: method === m ? meta.bg : "white",
                      }}>
                      <span className="text-lg">{meta.icon}</span>
                      <span className="text-xs font-semibold" style={{ color: meta.color }}>{meta.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* M-Pesa with STK push */}
              {method === "mpesa" && (
                <div>
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
                          </div>
                          {stkState === "failed" && stkError && (
                            <div className="text-xs text-red-600 bg-red-50 rounded-lg px-3 py-2">{stkError}</div>
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
                        <div className="flex flex-col items-center py-6 gap-3">
                          <Loader2 size={28} className="animate-spin text-green-500" />
                          <p className="text-sm font-medium text-gray-600">Sending push notification…</p>
                        </div>
                      )}
                      {stkState === "waiting" && (
                        <div className="flex flex-col items-center py-6 gap-3">
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
                          <p className="text-xs font-semibold text-green-600">
                            {waitCountdown > 0 ? `Check your phone in ${waitCountdown}s…` : "Waiting for confirmation…"}
                          </p>
                          <p className="text-xs text-gray-400 text-center px-4">Enter your M-Pesa PIN on your phone to confirm</p>
                          <button onClick={resetStk} className="text-xs text-gray-400 underline mt-1">Cancel</button>
                        </div>
                      )}
                      {stkState === "success" && (
                        <div className="flex flex-col items-center py-6 gap-3">
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
                              <CheckCircle2 size={28} className="text-green-500" />
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

                  {isAdmin && mpesaMode === "manual" && (
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">M-Pesa Transaction Code</label>
                        <input type="text" value={manualRef} onChange={(e) => setManualRef(e.target.value.toUpperCase())}
                          placeholder="e.g. QHX4XXXXXXX"
                          className="w-full border rounded-xl px-3 py-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-green-200"
                          style={{ borderColor: "var(--border)" }} />
                        <p className="text-xs text-gray-400 mt-1">Enter the M-Pesa confirmation code from the customer's SMS</p>
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">Paid By</label>
                        <input type="text" value={manualPaidBy} onChange={(e) => setManualPaidBy(e.target.value)}
                          placeholder="Name of payer"
                          className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                          style={{ borderColor: "var(--border)" }} />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">Phone</label>
                        <input type="text" value={manualPhone} onChange={(e) => setManualPhone(e.target.value)}
                          placeholder="e.g. 0712345678"
                          className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                          style={{ borderColor: "var(--border)" }} />
                      </div>
                      <div>
                        <label className="text-xs font-semibold text-gray-500 mb-1 block">Comments</label>
                        <input type="text" value={manualComment} onChange={(e) => setManualComment(e.target.value)}
                          placeholder="Optional note"
                          className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-green-200"
                          style={{ borderColor: "var(--border)" }} />
                      </div>
                      {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
                      <div className="flex gap-2">
                        <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50" style={{ borderColor: "var(--border)" }}>Cancel</button>
                        <button onClick={handlePay} disabled={processing}
                          className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                          style={{ background: "#16a34a" }}>
                          {processing ? <Loader2 size={14} className="animate-spin" /> : null}
                          Confirm
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {method !== "mpesa" && (
                <>
                  {method === "cash" && (
                    <input type="text" value={reference} onChange={(e) => setReference(e.target.value)}
                      placeholder="Reference / receipt no. (optional)"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                      style={{ borderColor: "var(--border)" }} />
                  )}
                  {method === "bank" && (
                    <div className="space-y-2">
                      <input type="text" value={bankName} onChange={(e) => setBankName(e.target.value)}
                        placeholder="Bank name"
                        className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                        style={{ borderColor: "var(--border)" }} />
                      <input type="text" value={reference} onChange={(e) => setReference(e.target.value)}
                        placeholder="Transaction / reference no."
                        className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                        style={{ borderColor: "var(--border)" }} />
                    </div>
                  )}
                  {method === "cheque" && (
                    <input type="text" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)}
                      placeholder="Cheque number"
                      className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                      style={{ borderColor: "var(--border)" }} />
                  )}
                  {err && <p className="text-xs text-red-500 font-medium bg-red-50 rounded-lg px-3 py-2">{err}</p>}
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => { setStep("amount"); setErr(""); }}
                      className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                      style={{ borderColor: "var(--border)" }}>Back</button>
                    <button onClick={handlePay} disabled={processing}
                      className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
                      style={{ background: PLOT_METHOD_META[method].color }}>
                      {processing ? <Loader2 size={14} className="animate-spin" /> : null}
                      Confirm Payment
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Edit Plot Payment Modal ─────────────────────────────────────────────────

function EditPlotPaymentModal({ payment, plotNumber, onClose, onSaved }: {
  payment: PlotPayment;
  plotNumber: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  let parsed: Record<string, string> = {};
  try { parsed = JSON.parse(payment.notes ?? "") ?? {}; } catch { /* plain text */ }

  const [date, setDate] = useState(payment.payment_date?.slice(0, 10) ?? "");
  const [amount, setAmount] = useState(String(payment.amount));
  const [method, setMethod] = useState(parsed.method ?? "");
  const [ref, setRef] = useState(parsed.ref ?? "");
  const [paidBy, setPaidBy] = useState(parsed.paidBy ?? "");
  const [phone, setPhone] = useState(parsed.phone ?? "");
  const [fine, setFine] = useState(parsed.fine ?? "");
  const [status, setStatus] = useState(parsed.status ?? "");
  const [note, setNote] = useState(parsed.note ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [enabledMethods, setEnabledMethods] = useState<PayMethod[]>(() => {
    const cfg = getPaymentSettings();
    const extra = (["cash", "bank", "cheque"] as const).filter((m) => cfg.methods[m]);
    return [...new Set(["mpesa", ...extra])] as PayMethod[];
  });
  useEffect(() => {
    getEnabledPaymentMethodKeys().then((keys) => setEnabledMethods(keys as PayMethod[])).catch(() => {});
  }, []);

  const handleSave = async () => {
    const amt = parseFloat(amount);
    if (!date || isNaN(amt) || amt <= 0) { setErr("Date and a valid amount are required."); return; }
    setSaving(true); setErr("");
    try {
      const notes = JSON.stringify({ method, ref, paidBy, phone, fine, status, note });
      await plotPaymentsApi.update(payment.id, { amount: amt, notes, payment_date: date });
      logActivity({
        category: "plot",
        action: "update",
        description: `Plot payment #${payment.id} edited on plot ${plotNumber} — KES ${amt.toLocaleString()}`,
        meta: { payment_id: payment.id, amount: amt, method, ref },
      });
      onSaved();
    } catch (e: any) {
      setErr(e.message ?? "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.55)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-3 flex items-center justify-between" style={{ background: "#1e3a5f" }}>
          <span className="font-bold text-white text-sm">Edit Payment — Plot {plotNumber}</span>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X size={16} /></button>
        </div>
        <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
          {err && <p className="text-xs text-red-600 bg-red-50 px-3 py-2 rounded-lg">{err}</p>}
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Date *</span>
              <input type="date" value={date} onChange={e => setDate(e.target.value)}
                className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Amount (KES) *</span>
              <input type="number" value={amount} onChange={e => setAmount(e.target.value)} min="0" step="0.01"
                className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide block mb-1.5">Payment Method</span>
              <div className="grid grid-cols-2 gap-1.5">
                {enabledMethods.map((m) => {
                  const meta = PLOT_METHOD_META[m];
                  return (
                    <button key={m} type="button" onClick={() => setMethod(m)}
                      className="flex items-center gap-1.5 px-2.5 py-2 rounded-lg border-2 text-left transition-all"
                      style={{ borderColor: method === m ? meta.color : "var(--border)", background: method === m ? meta.bg : "#fafafa" }}>
                      <span className="text-base leading-none">{meta.icon}</span>
                      <span className="text-[11px] font-bold" style={{ color: method === m ? meta.color : "#64748b" }}>{meta.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">TXN Code / Ref</span>
              <input value={ref} onChange={e => setRef(e.target.value)}
                className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Paid By</span>
              <input value={paidBy} onChange={e => setPaidBy(e.target.value)}
                className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
            </label>
            <label className="block">
              <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Phone</span>
              <input value={phone} onChange={e => setPhone(e.target.value)}
                className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
            </label>
          </div>
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Status</span>
            <input value={status} onChange={e => setStatus(e.target.value)}
              className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs" style={{ borderColor: "var(--border)" }} />
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wide">Comments</span>
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              className="mt-1 w-full border rounded-lg px-2 py-1.5 text-xs resize-none" style={{ borderColor: "var(--border)" }} />
          </label>
        </div>
        <div className="px-5 py-3 border-t flex gap-2 justify-end" style={{ borderColor: "var(--border)" }}>
          <button onClick={onClose} className="px-4 py-2 rounded-xl border text-xs font-semibold text-gray-500 hover:bg-gray-50"
            style={{ borderColor: "var(--border)" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="px-4 py-2 rounded-xl text-xs font-bold text-white disabled:opacity-50 flex items-center gap-1.5"
            style={{ background: "#1e3a5f" }}>
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Edit2 size={12} />}
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Assigned Plot Card (used in member dashboards) ───────────────────────────

export function AssignedPlotCard({ plot, isAdmin, onPay, onUpload, onRemove, onRefresh, onNavigatePlot, onNavigateProject }: {
  plot: Plot & { project?: Project };
  isAdmin: boolean;
  onPay?: () => void;
  onUpload?: () => void;
  onRemove?: () => void;
  onRefresh?: () => void;
  onNavigatePlot?: () => void;
  onNavigateProject?: () => void;
}) {
  const [editOpen, setEditOpen] = useState(false);

  const handleEditSave = async (data: { plot_number: string; price: number; size: number }) => {
    await plotsApi.update(plot.id, data);
    onRefresh?.();
  };
  const isInstalment = plot.payment_mode === "installment";
  const price = Number(plot.price);
  const paid = Number(plot.paid_amount);
  const due = Math.max(0, price - paid);
  const pct = price > 0 ? Math.round((paid / price) * 100) : 0;
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"schedule" | "history">(isInstalment ? "schedule" : "history");
  const [payments, setPayments] = useState<PlotPayment[]>([]);
  const [loadingPay, setLoadingPay] = useState(false);
  const [loadErr, setLoadErr] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [reconciling, setReconciling] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editPayment, setEditPayment] = useState<PlotPayment | null>(null);
  const [coOwners, setCoOwners] = useState<PlotCoOwner[]>([]);
  const [coOwnersExpanded, setCoOwnersExpanded] = useState(false);
  const [loadingCoOwners, setLoadingCoOwners] = useState(false);

  const loadCoOwners = useCallback(async () => {
    setLoadingCoOwners(true);
    try {
      const data = await plotCoOwnersApi.listByPlot(plot.id);
      setCoOwners(data);
    } catch { setCoOwners([]); }
    finally { setLoadingCoOwners(false); }
  }, [plot.id]);

  useEffect(() => {
    loadCoOwners();
  }, [loadCoOwners]);

  const handleReconcile = async () => {
    const historySum = payments.reduce((s, p) => s + Number(p.amount), 0);
    const gap = paid - historySum;
    if (gap <= 0) return;
    setReconciling(true);
    try {
      await plotPaymentsApi.insert(plot.id, gap, "Historical payment (reconciled)", new Date().toISOString().split("T")[0]);
      await loadPayments();
    } catch { /* ignore */ }
    finally { setReconciling(false); }
  };

  const loadPayments = useCallback(async () => {
    setLoadingPay(true);
    setLoadErr("");
    try {
      const data = await plotPaymentsApi.listByPlot(plot.id);
      setPayments(data);
    } catch (e: any) {
      setLoadErr(e.message ?? "Failed to load payments");
      setPayments([]);
    } finally { setLoadingPay(false); }
  }, [plot.id]);

  useEffect(() => {
    if (expanded) loadPayments();
  }, [expanded, loadPayments]);

  const handleDelete = async (id: number) => {
    setDeletingId(id);
    try {
      await plotPaymentsApi.remove(id);
      logActivity({ category: "plot", action: "delete", description: `Plot payment #${id} deleted from plot ${plot.plot_number}`, meta: { payment_id: id, plot_id: plot.id } });
      setPayments((prev) => prev.filter((p) => p.id !== id));
      onRefresh?.();
    } catch { /* ignore */ }
    finally { setDeletingId(null); setConfirmDeleteId(null); }
  };

  // ── Instalment schedule ───────────────────────────────────────────────────
  const dur = plot.loan_duration_months || 12;
  const interestAmt = plot.interest_type === "percentage"
    ? price * (Number(plot.interest_amount || 0) / 100)
    : Number(plot.interest_amount || 0);
  const totalPayable = price + interestAmt;
  const monthlyInstalment = dur > 0 ? totalPayable / dur : totalPayable;

  // Start date: earliest payment_date or today
  const startDate = (() => {
    if (payments.length > 0) {
      const sorted = [...payments].sort((a, b) =>
        new Date(a.payment_date || a.created_at).getTime() - new Date(b.payment_date || b.created_at).getTime()
      );
      const d = new Date(sorted[0].payment_date || sorted[0].created_at);
      d.setDate(1);
      return d;
    }
    const d = new Date();
    d.setDate(1);
    return d;
  })();

  const paidInstalments = monthlyInstalment > 0 ? Math.floor(paid / monthlyInstalment) : 0;
  const today = new Date();

  const schedule = Array.from({ length: dur }, (_, i) => {
    const dueDate = new Date(startDate);
    dueDate.setMonth(dueDate.getMonth() + i);
    const isPaid = i < paidInstalments;
    const isOverdue = !isPaid && dueDate < today;
    return {
      n: i + 1,
      dueDate,
      amount: monthlyInstalment,
      status: isPaid ? "paid" : isOverdue ? "overdue" : "upcoming",
    };
  });

  const TABLE_HEADER = "grid px-3 py-1.5 text-white text-[10px] font-semibold";
  const TABLE_ROW = "grid px-3 py-1.5 items-center text-xs";

  return (
    <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
      {/* ── Card header ── */}
      <div className="px-4 py-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            {onNavigatePlot ? (
              <button onClick={onNavigatePlot} className="font-bold text-sm hover:underline underline-offset-2 text-left transition-colors hover:opacity-70" style={{ color: "#6366f1" }}>{plot.plot_number}</button>
            ) : (
              <p className="font-bold text-sm" style={{ color: "#1a202c" }}>{plot.plot_number}</p>
            )}
            {onNavigateProject && (plot.project as any)?.project_name ? (
              <button onClick={onNavigateProject} className="text-xs hover:underline underline-offset-1 text-left transition-colors" style={{ color: "#22c55e" }}>{(plot.project as any).project_name}</button>
            ) : (
              <p className="text-xs text-gray-400">{(plot.project as any)?.project_name ?? "—"}</p>
            )}
          </div>
          <div className="text-right flex-shrink-0">
            <p className="font-bold text-sm" style={{ color: "#6366f1" }}>{fmtKESFull(price)}</p>
            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isInstalment ? "bg-blue-50 text-blue-600" : "bg-green-50 text-green-600"}`}>
              {isInstalment ? "Instalments" : "Cash"}
            </span>
          </div>
        </div>

        {isInstalment && (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px]">
            <span className="text-gray-400"><span className="font-semibold text-gray-600">{dur}</span> months</span>
            <span className="text-gray-400"><span className="font-semibold text-gray-600">{fmtKES(monthlyInstalment)}</span>/mo</span>
            {interestAmt > 0 && (
              <span className="text-gray-400">
                Interest: <span className="font-semibold text-amber-600">
                  {plot.interest_type === "percentage" ? `${plot.interest_amount}%` : fmtKES(interestAmt)}
                </span>
              </span>
            )}
            {plot.min_monthly_payment && plot.min_monthly_payment > 0 && (
              <span className="text-gray-400">
                Min/mo: <span className="font-semibold text-indigo-600">{fmtKES(plot.min_monthly_payment)}</span>
              </span>
            )}
          </div>
        )}

        <p className="text-xs mt-2">
          <span className="text-green-600 font-semibold">Paid: {fmtKESFull(paid)}</span>
          {" · "}
          <span className="text-red-500 font-semibold">Due: {fmtKESFull(due)}</span>
        </p>
        <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background: "#e2e8f0" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "#22c55e" }} />
        </div>
        <div className="flex items-center justify-between mt-1">
          <p className="text-[10px] text-gray-400">{pct}% {isInstalment && `· ${paidInstalments}/${dur} instalments paid`}</p>
          <div className="flex items-center gap-2">
            {coOwners.length > 0 && (
              <button
                onClick={() => setCoOwnersExpanded((v) => !v)}
                className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md hover:bg-gray-100 transition-colors"
                style={{ color: "#2563eb" }}>
                <Users size={10} />
                {coOwnersExpanded ? "Hide" : "View"} Co-Owners
                <ChevronDown size={10} className={`transition-transform ${coOwnersExpanded ? "rotate-180" : ""}`} />
              </button>
            )}
            <button
              onClick={() => setExpanded((v) => !v)}
              className="flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-md hover:bg-gray-100 transition-colors"
              style={{ color: "#6366f1" }}>
              <History size={10} />
              {expanded ? "Hide" : "View"} Payments
              <ChevronDown size={10} className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
            </button>
          </div>
        </div>

        {/* Co-owners expanded panel */}
        {coOwnersExpanded && (
          <div className="mt-2 rounded-xl border overflow-hidden" style={{ borderColor: "#dbeafe" }}>
            {loadingCoOwners ? (
              <div className="flex justify-center py-3"><Loader2 size={13} className="animate-spin text-gray-300" /></div>
            ) : (
              <>
                {/* Primary owner row */}
                <div className="grid px-3 py-2 items-center gap-2 border-b" style={{ gridTemplateColumns: "auto 1fr auto auto", borderColor: "#dbeafe", background: "#eff6ff" }}>
                  <span className="text-[10px] font-bold text-indigo-500">
                    {plot.assigned_to_type === "shareholder" ? `EW#${(plot as any).shareholder?.member_number ?? plot.assigned_to_id}` : (plot as any).client?.member_number ?? `#${plot.assigned_to_id}`}
                  </span>
                  <span className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>
                    {plot.assigned_to_type === "shareholder" ? ((plot as any).shareholder?.name ?? "—") : ((plot as any).client?.name ?? "—")}
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                    style={{ background: plot.assigned_to_type === "shareholder" ? "#dbeafe" : "#fef3c7", color: plot.assigned_to_type === "shareholder" ? "#1d4ed8" : "#b45309" }}>
                    {plot.assigned_to_type === "shareholder" ? "Shareholder" : "Client"}
                  </span>
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-green-100 text-green-700">Primary</span>
                </div>
                {/* Co-owners */}
                {coOwners.map((co, i) => {
                  const m = (co as any).member;
                  const num = m?.member_number ? `EW#${m.member_number}` : `#${co.member_id}`;
                  const name = m?.name ?? `Member #${co.member_id}`;
                  return (
                    <div key={co.id} className="grid px-3 py-2 items-center gap-2 border-b last:border-b-0"
                      style={{ gridTemplateColumns: "auto 1fr auto", borderColor: "#dbeafe", background: i % 2 === 0 ? "#fff" : "#f8fbff" }}>
                      <span className="text-[10px] font-bold text-indigo-400">{num}</span>
                      <span className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{name}</span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                        style={{ background: co.member_type === "shareholder" ? "#dbeafe" : "#fef3c7", color: co.member_type === "shareholder" ? "#1d4ed8" : "#b45309" }}>
                        {co.member_type === "shareholder" ? "Shareholder" : "Client"}
                      </span>
                    </div>
                  );
                })}
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Expanded panel ── */}
      {expanded && (
        <div className="border-t" style={{ borderColor: "var(--border)" }}>
          {/* Tabs — only shown for instalment plots */}
          {isInstalment && (
            <div className="flex border-b" style={{ borderColor: "var(--border)" }}>
              {(["schedule", "history"] as const).map((t) => (
                <button key={t} onClick={() => setTab(t)}
                  className="flex-1 py-2 text-[11px] font-bold transition-colors"
                  style={tab === t
                    ? { background: "#1e3a5f", color: "#fff" }
                    : { background: "#f8fafc", color: "#64748b" }}>
                  {t === "schedule" ? "📅 Payment Schedule" : "📋 Payment History"}
                </button>
              ))}
            </div>
          )}

          {loadingPay ? (
            <div className="flex justify-center py-4"><Loader2 size={14} className="animate-spin text-gray-300" /></div>
          ) : loadErr ? (
            <div className="px-4 py-3 flex items-center gap-2">
              <AlertCircle size={13} color="#ef4444" />
              <p className="text-xs text-red-500">{loadErr}</p>
              <button onClick={loadPayments} className="ml-auto text-xs font-semibold text-indigo-500 hover:underline">Retry</button>
            </div>
          ) : (
            <>
              {/* ── Schedule tab ── */}
              {tab === "schedule" && isInstalment && (
                <div>
                  <div className={TABLE_HEADER} style={{ background: "#1e3a5f", gridTemplateColumns: "28px 1fr 1fr 72px 72px" }}>
                    <span>#</span>
                    <span>Due Date</span>
                    <span>Amount</span>
                    <span>Status</span>
                    <span />
                  </div>
                  {schedule.map((row, i) => {
                    const statusStyle =
                      row.status === "paid"    ? { color: "#16a34a", bg: "#f0fdf4" } :
                      row.status === "overdue" ? { color: "#dc2626", bg: "#fef2f2" } :
                                                 { color: "#2563eb", bg: "#eff6ff" };
                    return (
                      <div key={row.n} className={TABLE_ROW}
                        style={{ gridTemplateColumns: "28px 1fr 1fr 72px 72px", background: i % 2 === 0 ? "#dbeafe" : "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                        <span className="font-bold text-gray-400">{row.n}</span>
                        <span className="text-gray-600">
                          {row.dueDate.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                        </span>
                        <span className="font-semibold" style={{ color: "#1a202c" }}>{fmtKES(row.amount)}</span>
                        <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full w-fit"
                          style={{ color: statusStyle.color, background: statusStyle.bg }}>
                          {row.status === "paid" ? "✓ Paid" : row.status === "overdue" ? "Overdue" : "Upcoming"}
                        </span>
                        {row.status !== "paid" ? (
                          <button onClick={onPay}
                            className="flex items-center justify-center gap-1 text-[10px] font-bold px-2 py-1 rounded-lg text-white w-full"
                            style={{ background: row.status === "overdue" ? "#dc2626" : "#22c55e" }}>
                            <Wallet size={10} /> Pay
                          </button>
                        ) : (
                          <span />
                        )}
                      </div>
                    );
                  })}
                  {/* Summary footer */}
                  <div className="px-3 py-2 flex justify-between items-center text-[10px]"
                    style={{ background: "#f0f4ff", borderTop: "1px solid #e2e8f0" }}>
                    <span className="text-gray-500">Total payable</span>
                    <span className="font-bold" style={{ color: "#1e3a5f" }}>{fmtKESFull(totalPayable)}</span>
                  </div>
                </div>
              )}

              {/* ── History tab ── */}
              {tab === "history" && (
                <div>
                  {/* Reconcile banner — shown when paid_amount > sum of history rows */}
                  {(() => {
                    const historySum = payments.reduce((s, p) => s + Number(p.amount), 0);
                    const gap = paid - historySum;
                    if (gap <= 0) return null;
                    return (
                      <div className="mx-3 mt-2 mb-1 flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                        style={{ background: "#fefce8", border: "1px solid #fde047" }}>
                        <AlertCircle size={13} color="#ca8a04" className="flex-shrink-0" />
                        <span className="text-amber-700 flex-1">
                          <strong>{fmtKESFull(gap)}</strong> paid but not in history records.
                        </span>
                        <button onClick={handleReconcile} disabled={reconciling}
                          className="flex-shrink-0 text-[10px] font-bold px-2 py-1 rounded-md text-white disabled:opacity-50"
                          style={{ background: "#ca8a04" }}>
                          {reconciling ? "Adding…" : "Add Record"}
                        </button>
                      </div>
                    );
                  })()}
                  {payments.length === 0 ? (
                    <p className="px-4 py-3 text-xs text-gray-400 italic">No payment records yet. Use "Add Record" above if payments were made previously.</p>
                  ) : (
                    <>
                      {/* Export PDF toolbar */}
                      <div className="flex justify-end px-3 py-1.5" style={{ borderBottom: "1px solid #e2e8f0" }}>
                        <button
                          onClick={async () => {
                            const co = await getCompanyDetails();
                            const rows = payments.map((p) => {
                              let method = "—", ref = "—", note = "—", paidBy = "—", phone = "—";
                              try {
                                const parsed = JSON.parse(p.notes ?? "");
                                if (parsed && typeof parsed === "object") {
                                  method = parsed.method || "—";
                                  ref = parsed.ref || "—";
                                  note = parsed.note || "—";
                                  paidBy = parsed.paidBy || "—";
                                  phone = parsed.phone || "—";
                                }
                              } catch { note = p.notes || "—"; }
                              return {
                                date: new Date(p.payment_date || p.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }),
                                amount: Number(p.amount),
                                method,
                                ref,
                                paidBy,
                                phone,
                                note,
                              };
                            });
                            await downloadPlotPaymentHistoryPdf(
                              plot.plot_number,
                              (plot.project as any)?.project_name ?? "—",
                              rows,
                              paid,
                              due,
                              co,
                            );
                          }}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold hover:opacity-80"
                          style={{ background: "#f0fdf4", color: "#16a34a", border: "1px solid #bbf7d0" }}>
                          <FileDown size={12} /> Export PDF
                        </button>
                      </div>
                      <div className={TABLE_HEADER} style={{ background: "#1e3a5f", gridTemplateColumns: "1fr 1fr 1.2fr 1fr 1fr 1fr 1fr auto", fontSize: "10px" }}>
                        <span>Date</span>
                        <span>Amount</span>
                        <span>PMTMethod</span>
                        <span>TXNCode</span>
                        <span>Paid By</span>
                        <span>Phone</span>
                        <span>Comments</span>
                        <span />
                      </div>
                      {payments.map((p, i) => {
                        let method = "—", ref = "—", note = p.notes || "—", paidBy = "—", phone = "—";
                        try {
                          const parsed = JSON.parse(p.notes ?? "");
                          if (parsed && typeof parsed === "object") {
                            method = parsed.method || "—";
                            ref = parsed.ref || "—";
                            note = parsed.note || "—";
                            paidBy = parsed.paidBy || "—";
                            phone = parsed.phone || "—";
                          }
                        } catch { /* plain-text notes from old records */ }
                        return (
                        <div key={p.id} className={TABLE_ROW}
                          style={{ gridTemplateColumns: "1fr 1fr 1.2fr 1fr 1fr 1fr 1fr auto", background: i % 2 === 0 ? "#dbeafe" : "#ffffff", borderBottom: "1px solid #e2e8f0" }}>
                          <span className="text-gray-600">
                            {new Date(p.payment_date || p.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}
                          </span>
                          <span className="font-bold text-green-600">{fmtKESFull(Number(p.amount))}</span>
                          <span className="text-gray-500 truncate pr-1">{method}</span>
                          <span className="text-gray-500 truncate pr-1">{ref}</span>
                          <span className="text-gray-500 truncate pr-1">{paidBy}</span>
                          <span className="text-gray-500 truncate pr-1">{phone}</span>
                          <span className="text-gray-500 truncate pr-2">{note}</span>
                          <div className="flex items-center gap-1">
                            <button onClick={() => setEditPayment(p)}
                              className="p-1 rounded hover:bg-blue-50 text-blue-400 hover:text-blue-600 transition-colors"
                              title="Edit payment">
                              <Edit2 size={12} />
                            </button>
                            {confirmDeleteId === p.id ? (
                              <>
                                <button onClick={() => handleDelete(p.id)} disabled={deletingId === p.id}
                                  className="text-[10px] font-bold px-1.5 py-0.5 rounded text-white disabled:opacity-50"
                                  style={{ background: "#ef4444" }}>
                                  {deletingId === p.id ? "…" : "Yes"}
                                </button>
                                <button onClick={() => setConfirmDeleteId(null)}
                                  className="text-[10px] font-bold px-1.5 py-0.5 rounded border"
                                  style={{ borderColor: "var(--border)", color: "#64748b" }}>
                                  No
                                </button>
                              </>
                            ) : (
                              <button onClick={() => setConfirmDeleteId(p.id)}
                                className="p-1 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors">
                                <Trash2 size={12} />
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
            </>
          )}
        </div>
      )}

      {/* ── Action buttons ── */}
      <div className="grid grid-cols-4 border-t" style={{ borderColor: "var(--border)" }}>
        {[
          { label: "Edit",   icon: <Edit2 size={13} />,       color: "#64748b", bg: "#f8fafc", action: isAdmin ? () => setEditOpen(true) : undefined },
          { label: "Pay",    icon: <Wallet size={13} />,      color: "#22c55e", bg: "#f0fdf4", action: onPay },
          { label: "Upload", icon: <UploadCloud size={13} />, color: "#6366f1", bg: "#eef2ff", action: isAdmin ? onUpload : undefined },
          { label: "Remove", icon: <RotateCcw size={13} />,   color: "#ef4444", bg: "#fef2f2", action: isAdmin ? () => setConfirmRemove(true) : undefined },
        ].map(({ label, icon, color, bg, action }) => (
          <button key={label} onClick={action} disabled={!action}
            className="py-2.5 flex items-center justify-center gap-1.5 text-xs font-semibold transition-colors hover:opacity-80 disabled:opacity-30 border-r last:border-r-0"
            style={{ color, background: bg, borderColor: "var(--border)" }}>
            {icon}{label}
          </button>
        ))}
      </div>

      {confirmRemove && (
        <ConfirmModal
          title="Remove Plot Assignment"
          message={`Remove plot ${plot.plot_number} from this member? The plot will become unassigned but all payment records are kept.`}
          confirmLabel="Remove"
          onConfirm={() => { onRemove?.(); setConfirmRemove(false); }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}

      {editOpen && (
        <EditPlotModal
          plot={plot}
          onClose={() => setEditOpen(false)}
          onSave={handleEditSave}
        />
      )}

      {editPayment && (
        <EditPlotPaymentModal
          payment={editPayment}
          plotNumber={plot.plot_number}
          onClose={() => setEditPayment(null)}
          onSaved={() => { setEditPayment(null); loadPayments(); onRefresh?.(); }}
        />
      )}

    </div>
  );
}

// ─── Documents Section ────────────────────────────────────────────────────────

type DocRecord = { id: number; name: string; file_path: string; file_url: string; uploaded_at: string };

function DocumentsSection({ entityType, entityId, isAdmin }: {
  entityType: "project" | "plot";
  entityId: number;
  isAdmin: boolean;
}) {
  const table = entityType === "project" ? "project_documents" : "plot_documents";
  const fkCol = entityType === "project" ? "project_id" : "plot_id";

  const [docs, setDocs] = useState<DocRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [tableReady, setTableReady] = useState(true);
  const [docName, setDocName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState("");
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDoc, setConfirmDoc] = useState<DocRecord | null>(null);

  const load = async () => {
    try {
      const { data, error } = await supabase.from(table).select("*").eq(fkCol, entityId).order("uploaded_at", { ascending: false });
      if (error) {
        if (error.message?.includes("does not exist") || error.message?.includes("relation")) {
          setTableReady(false);
        }
        setDocs([]);
      } else {
        setDocs((data ?? []) as DocRecord[]);
        setTableReady(true);
      }
    } catch { setDocs([]); }
    finally { setLoading(false); }
  };

  useEffect(() => { load(); }, [entityId]);

  const handleUpload = async () => {
    if (!docName.trim()) { setErr("Enter a document name."); return; }
    if (!file) { setErr("Select a file."); return; }
    setUploading(true); setErr("");
    try {
      const ext = file.name.split(".").pop() ?? "bin";
      const path = `${entityType}/${entityId}/${Date.now()}.${ext}`;
      const { error: uploadErr } = await supabase.storage.from("documents").upload(path, file, { upsert: false });
      if (uploadErr) {
        if (uploadErr.message?.toLowerCase().includes("bucket") || uploadErr.message?.toLowerCase().includes("not found")) {
          throw new Error("__bucket_missing__");
        }
        throw new Error(uploadErr.message);
      }
      const { data: urlData } = supabase.storage.from("documents").getPublicUrl(path);
      const { error: dbErr } = await supabase.from(table).insert({ [fkCol]: entityId, name: docName.trim(), file_path: path, file_url: urlData.publicUrl });
      if (dbErr) throw new Error(dbErr.message);
      setDocName(""); setFile(null);
      await load();
    } catch (e: any) { setErr(e.message); }
    finally { setUploading(false); }
  };

  const handleDelete = async (doc: DocRecord) => {
    setDeletingId(doc.id);
    try {
      await supabase.storage.from("documents").remove([doc.file_path]);
      await supabase.from(table).delete().eq("id", doc.id);
      setDocs((prev) => prev.filter((d) => d.id !== doc.id));
    } catch { /* ignore */ }
    finally { setDeletingId(null); }
  };

  if (!tableReady && isAdmin) {
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
        <strong>Documents</strong> table not found. Run the SQL migration to enable document uploads.
        <pre className="mt-1.5 bg-amber-100 rounded p-2 text-[10px] overflow-x-auto whitespace-pre-wrap">
{`CREATE TABLE ${table} (
  id bigserial PRIMARY KEY,
  ${fkCol} bigint NOT NULL,
  name text NOT NULL,
  file_path text NOT NULL,
  file_url text NOT NULL,
  uploaded_at timestamptz DEFAULT now()
);`}
        </pre>
      </div>
    );
  }

  return (
    <>
    <div className="space-y-3">
      {/* Upload row — admin only */}
      {isAdmin && (
        <div className="flex flex-col sm:flex-row gap-2 items-start sm:items-center bg-gray-50 rounded-xl border p-3" style={{ borderColor: "var(--border)" }}>
          <input
            type="text" value={docName} onChange={(e) => setDocName(e.target.value)}
            placeholder="Document Name"
            className="flex-1 min-w-0 border rounded-lg px-3 py-2 text-xs focus:outline-none"
            style={{ borderColor: "var(--border)" }} />
          <label className="flex items-center gap-1.5 cursor-pointer px-3 py-2 rounded-lg border text-xs font-semibold text-indigo-600 border-indigo-200 bg-white hover:bg-indigo-50 transition-colors flex-shrink-0">
            <FileText size={12} />
            {file ? file.name.slice(0, 20) + (file.name.length > 20 ? "…" : "") : "Select File"}
            <input type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button onClick={handleUpload} disabled={uploading || !file || !docName.trim()}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-bold text-white disabled:opacity-50 flex-shrink-0"
            style={{ background: "#4f46e5" }}>
            {uploading ? <Loader2 size={11} className="animate-spin" /> : <UploadCloud size={11} />}
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      )}
      {err && (
        err === "__bucket_missing__" ? (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
            <p className="font-bold mb-1">Storage bucket not found</p>
            <p className="mb-1.5">Create a bucket named <strong>documents</strong> in your Supabase project:</p>
            <p className="text-[10px] leading-relaxed">Supabase Dashboard → Storage → New bucket → Name: <code className="bg-amber-100 px-1 rounded">documents</code> → Public → Create</p>
          </div>
        ) : (
          <p className="text-xs text-red-500">{err}</p>
        )
      )}

      {/* Document list */}
      {loading ? (
        <div className="flex justify-center py-4"><Loader2 size={14} className="animate-spin text-gray-300" /></div>
      ) : docs.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-3 italic">
          {isAdmin ? "No documents yet. Upload one above." : "No documents uploaded."}
        </p>
      ) : (
        <div className="divide-y rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          {docs.map((doc) => (
            <div key={doc.id} className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#eef2ff" }}>
                <FileText size={14} color="#6366f1" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{doc.name}</p>
                <p className="text-[10px] text-gray-400">{new Date(doc.uploaded_at).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}</p>
              </div>
              <a href={doc.file_url} target="_blank" rel="noreferrer"
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-[10px] font-bold flex-shrink-0"
                style={{ background: "#f0fdf4", color: "#16a34a" }}>
                <Download size={10} /> View
              </a>
              {isAdmin && (
                <button onClick={() => setConfirmDoc(doc)} disabled={deletingId === doc.id}
                  className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors flex-shrink-0 disabled:opacity-40">
                  {deletingId === doc.id ? <Loader2 size={11} className="animate-spin" /> : <Trash2 size={11} />}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
    {confirmDoc && (
      <ConfirmModal
        title="Delete Document"
        message={<>Permanently delete <strong>{confirmDoc.name}</strong>? This cannot be undone.</>}
        confirmLabel="Delete"
        busy={deletingId === confirmDoc.id}
        onCancel={() => setConfirmDoc(null)}
        onConfirm={() => { handleDelete(confirmDoc); setConfirmDoc(null); }}
      />
    )}
    </>
  );
}

function PlotDocumentsRow({ plotId, isAdmin, canView }: { plotId: number; isAdmin: boolean; canView: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canView) return null;
  return (
    <div className="border-t" style={{ borderColor: "#e2e8f0" }}>
      <button onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2 text-[10px] font-bold hover:bg-gray-50 transition-colors"
        style={{ color: "#6366f1" }}>
        <FileText size={11} />
        Plot Documents
        <ChevronDown size={11} className={`ml-auto transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="px-3 pb-3">
          <DocumentsSection entityType="plot" entityId={plotId} isAdmin={isAdmin} />
        </div>
      )}
    </div>
  );
}

// ─── Create Project Modal ─────────────────────────────────────────────────────

function CreateProjectModal({ onClose, onSave }: {
  onClose: () => void;
  onSave: (p: Omit<Project, "id" | "created_at">) => Promise<void>;
}) {
  const [form, setForm] = useState({ project_name: "", location: "", size_acres: "", number_of_plots: "", project_cost: "", net_profit: "", date_started: "", date_completed: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.project_name.trim()) { setErr("Project name is required."); return; }
    if (!parseInt(form.number_of_plots)) { setErr("Number of plots is required."); return; }
    setSaving(true); setErr("");
    try {
      await onSave({
        project_name: form.project_name.trim(),
        location: form.location.trim(),
        size_acres: parseFloat(form.size_acres) || 0,
        number_of_plots: parseInt(form.number_of_plots) || 0,
        project_cost: parseFloat(form.project_cost) || 0,
        net_profit: parseFloat(form.net_profit) || 0,
        date_started: form.date_started || null,
        date_completed: form.date_completed || null,
      });
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const textFields = [
    { key: "project_name",    label: "Project Name",       type: "text",   placeholder: "e.g. Athi River Phase 1" },
    { key: "location",        label: "Location",           type: "text",   placeholder: "e.g. Athi River, Machakos" },
    { key: "size_acres",      label: "Size (Acres)",       type: "number", placeholder: "e.g. 5.5" },
    { key: "number_of_plots", label: "Number of Plots",    type: "number", placeholder: "e.g. 20" },
    { key: "project_cost",    label: "Project Cost (KES)", type: "number", placeholder: "e.g. 3000000" },
    { key: "net_profit",      label: "Net Profit (KES)",   type: "number", placeholder: "e.g. 500000" },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>New Project</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto max-h-[75vh]">
          {textFields.map((f) => (
            <div key={f.key}>
              <label className="text-xs font-semibold text-gray-600 block mb-1">{f.label}</label>
              <input type={f.type} value={(form as any)[f.key]} onChange={set(f.key)} placeholder={f.placeholder}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          ))}
          {/* Date fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Date Started</label>
              <input type="date" value={form.date_started} onChange={set("date_started")}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">
                Date Completed <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input type="date" value={form.date_completed} onChange={set("date_completed")}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          </div>
          <div className="flex items-center gap-2 bg-blue-50 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold" style={{ color: form.date_completed ? "#16a34a" : "#2563eb" }}>
              {form.date_completed ? "✅ Will be marked Completed" : "🔵 Will be marked Active"}
            </span>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
          <p className="text-xs text-gray-400 bg-gray-50 rounded-lg px-3 py-2">
            Plots auto-created as <strong>ProjectName-Plot1</strong>, <strong>ProjectName-Plot2</strong>…
          </p>
        </div>
        <div className="px-6 py-4 border-t" style={{ borderColor: "var(--border)" }}>
          <button onClick={submit} disabled={saving}
            className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#22c55e" }}>
            {saving ? "Creating…" : "Create Project + Generate Plots"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Project Modal ───────────────────────────────────────────────────────

function EditProjectModal({ project, onClose, onSave }: {
  project: Project;
  onClose: () => void;
  onSave: (p: Partial<Omit<Project, "id" | "created_at">>) => Promise<void>;
}) {
  const [form, setForm] = useState({
    project_name: project.project_name,
    location: project.location,
    size_acres: String(project.size_acres),
    number_of_plots: String(project.number_of_plots ?? ""),
    project_cost: String(project.project_cost),
    net_profit: String(project.net_profit),
    date_started: project.date_started ?? "",
    date_completed: project.date_completed ?? "",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.project_name.trim()) { setErr("Project name is required."); return; }
    setSaving(true); setErr("");
    try {
      await onSave({
        project_name: form.project_name.trim(),
        location: form.location.trim(),
        size_acres: parseFloat(form.size_acres) || 0,
        number_of_plots: parseInt(form.number_of_plots) || 0,
        project_cost: parseFloat(form.project_cost) || 0,
        net_profit: parseFloat(form.net_profit) || 0,
        date_started: form.date_started || null,
        date_completed: form.date_completed || null,
      });
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Edit Project</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="p-6 space-y-3 overflow-y-auto max-h-[75vh]">
          {[
            { key: "project_name",    label: "Project Name",       type: "text"   },
            { key: "location",        label: "Location",           type: "text"   },
            { key: "size_acres",      label: "Size (Acres)",       type: "number" },
            { key: "number_of_plots", label: "Number of Plots",    type: "number" },
            { key: "project_cost",    label: "Project Cost (KES)", type: "number" },
            { key: "net_profit",      label: "Net Profit (KES)",   type: "number" },
          ].map((f) => (
            <div key={f.key}>
              <label className="text-xs font-semibold text-gray-600 block mb-1">{f.label}</label>
              <input type={f.type} value={(form as any)[f.key]} onChange={set(f.key)}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          ))}
          {/* Date fields */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">Date Started</label>
              <input type="date" value={form.date_started} onChange={set("date_started")}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
            <div>
              <label className="text-xs font-semibold text-gray-600 block mb-1">
                Date Completed <span className="font-normal text-gray-400">(optional)</span>
              </label>
              <input type="date" value={form.date_completed} onChange={set("date_completed")}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          </div>
          <div className="flex items-center gap-2 bg-blue-50 rounded-lg px-3 py-2">
            <span className="text-xs font-semibold" style={{ color: form.date_completed ? "#16a34a" : "#2563eb" }}>
              {form.date_completed ? "✅ Will be marked Completed" : "🔵 Will be marked Active"}
            </span>
          </div>
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="px-6 py-4 border-t flex gap-3" style={{ borderColor: "var(--border)" }}>
          <button onClick={onClose} className="flex-1 py-3 rounded-xl text-sm font-bold border" style={{ borderColor: "var(--border)", color: "#64748b" }}>Cancel</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 py-3 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#1e2d4a" }}>
            {saving ? "Saving…" : "Save Changes"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Plot Modal ──────────────────────────────────────────────────────────

function EditPlotModal({ plot, onClose, onSave }: {
  plot: Plot;
  onClose: () => void;
  onSave: (data: { plot_number: string; price: number; size: number }) => Promise<void>;
}) {
  const [form, setForm] = useState({
    plot_number: plot.plot_number,
    price: String(plot.price),
    size: String(plot.size),
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!form.plot_number.trim()) { setErr("Plot name is required."); return; }
    setSaving(true); setErr("");
    try {
      await onSave({ plot_number: form.plot_number.trim(), price: parseFloat(form.price) || 0, size: parseFloat(form.size) || 0 });
      onClose();
    } catch (e: any) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <h2 className="font-bold text-sm" style={{ color: "#1a202c" }}>Edit Plot</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={15} /></button>
        </div>
        <div className="p-5 space-y-3">
          {[
            { key: "plot_number", label: "Plot Name", type: "text" },
            { key: "price",       label: "Price (KES)", type: "number" },
            { key: "size",        label: "Size (Acres)", type: "number" },
          ].map((f) => (
            <div key={f.key}>
              <label className="text-xs font-semibold text-gray-600 block mb-1">{f.label}</label>
              <input type={f.type} value={(form as any)[f.key]}
                onChange={(e) => setForm((p) => ({ ...p, [f.key]: e.target.value }))}
                className="w-full border rounded-xl px-3 py-2.5 text-sm focus:outline-none"
                style={{ borderColor: "var(--border)" }} />
            </div>
          ))}
          {err && <p className="text-xs text-red-500">{err}</p>}
        </div>
        <div className="px-5 pb-5 flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl text-sm font-semibold border" style={{ borderColor: "var(--border)", color: "#64748b" }}>Cancel</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#1e2d4a" }}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Enroll Members Modal ─────────────────────────────────────────────────────

function EnrollMembersModal({ project, shareholders, enrolled, onClose, onDone }: {
  project: Project;
  shareholders: Shareholder[];
  enrolled: any[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const enrolledIds = new Set(enrolled.map((e) => e.shareholder_id));
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const [err, setErr] = useState("");

  const filtered = shareholders.filter(
    (s) => !enrolledIds.has(s.id) && (!search || s.name.toLowerCase().includes(search.toLowerCase()))
  );

  const toggle = (id: number) => setSelected((prev) => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  const submit = async () => {
    if (!selected.size) return;
    setSaving(true); setErr("");
    try {
      await Promise.all([...selected].map((id) => projectsApi.enrollShareholder(project.id, id)));
      logActivity({ category: "project", action: "update", description: `${selected.size} shareholder${selected.size !== 1 ? "s" : ""} enrolled in project "${project.project_name}"`, meta: { project_id: project.id, count: selected.size } });
      await onDone();
      onClose();
    } catch (e: any) {
      setErr(e?.message ?? "Enrollment failed. Check your database connection.");
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Enroll Members</h2>
            <p className="text-xs text-gray-400">Select shareholders to enroll in {project.project_name}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>
        <div className="px-4 pt-3 flex-shrink-0 space-y-2">
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search shareholders…"
              className="w-full pl-8 pr-3 py-2 border rounded-xl text-xs focus:outline-none"
              style={{ borderColor: "var(--border)" }} />
          </div>
          {filtered.length > 0 && (
            <label className="flex items-center gap-2 px-1 cursor-pointer select-none">
              <input type="checkbox"
                className="w-4 h-4 rounded accent-indigo-600"
                checked={filtered.every((s) => selected.has(s.id))}
                onChange={() => {
                  const allSelected = filtered.every((s) => selected.has(s.id));
                  setSelected((prev) => {
                    const next = new Set(prev);
                    filtered.forEach((s) => allSelected ? next.delete(s.id) : next.add(s.id));
                    return next;
                  });
                }}
              />
              <span className="text-xs font-semibold text-gray-500">
                {filtered.every((s) => selected.has(s.id)) ? "Deselect All" : "Select All"}
                <span className="ml-1 text-gray-400 font-normal">({filtered.length})</span>
              </span>
            </label>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 pb-24 md:pb-3 space-y-1">
          {filtered.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">
              {search ? "No matches" : "All shareholders already enrolled"}
            </p>
          ) : filtered.map((s) => (
            <label key={s.id} className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={selected.has(s.id)} onChange={() => toggle(s.id)}
                className="w-4 h-4 rounded accent-indigo-600" />
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white flex-shrink-0"
                style={{ background: s.avatar_color || "#6366f1" }}>
                {s.name.split(" ").map((w: string) => w[0]).slice(0, 2).join("").toUpperCase()}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>{s.name}</p>
                <p className="text-[10px] text-gray-400">EW#{s.member_number}</p>
              </div>
            </label>
          ))}
        </div>
        <div className="px-6 py-4 border-t flex-shrink-0 space-y-2" style={{ borderColor: "var(--border)" }}>
          {err && (
            <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-3 py-2">
              <AlertCircle size={14} className="text-red-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-red-600">{err}</p>
            </div>
          )}
          <button onClick={submit} disabled={saving || !selected.size}
            className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50"
            style={{ background: "#22c55e" }}>
            {saving ? "Enrolling…" : `Enroll ${selected.size} Member${selected.size !== 1 ? "s" : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Edit Distribution Modal ──────────────────────────────────────────────────

function EditDistributionModal({ dist, onClose, onSave }: {
  dist: ProfitDistribution;
  onClose: () => void;
  onSave: (patch: { amount?: number; distributed_at?: string; notes?: string }) => Promise<void>;
}) {
  const [amount, setAmount] = useState(String(dist.amount));
  const [date, setDate] = useState(String(dist.distributed_at).split("T")[0]);
  const [notes, setNotes] = useState(dist.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const inp = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200";

  const name = dist.shareholder?.name ?? dist.investor?.name ?? "—";
  const memberNum = dist.shareholder?.member_number ?? dist.investor?.member_number;

  const save = async () => {
    if (!amount || isNaN(Number(amount)) || Number(amount) <= 0) { setErr("Enter a valid amount"); return; }
    setSaving(true); setErr("");
    try {
      await onSave({ amount: Number(amount), distributed_at: date || undefined, notes: notes.trim() || undefined });
    } catch (e: any) { setErr(e.message); setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ background: "#f0fdf4", borderColor: "#bbf7d0" }}>
          <div>
            <p className="font-bold text-sm" style={{ color: "#166534" }}>Edit Distribution</p>
            <p className="text-xs text-gray-500">{name}{memberNum ? ` · #${memberNum}` : ""}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-full hover:bg-green-100 text-green-600"><X size={15} /></button>
        </div>
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
              {saving ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Distribute Profit Modal ──────────────────────────────────────────────────

function DistributeProfitModal({ project, enrolled, investors, distributions, onClose, onDone }: {
  project: Project;
  enrolled: any[];
  investors: any[];
  distributions: ProfitDistribution[];
  onClose: () => void;
  onDone: () => void;
}) {
  const totalDistributed = distributions.reduce((s, d) => s + Number(d.amount), 0);
  const remaining = Math.max(0, Number(project.net_profit) - totalDistributed);

  const today = new Date().toISOString().split("T")[0];
  const [masterDate, setMasterDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [amounts, setAmounts] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    enrolled.forEach((e) => { init[`sh_${e.shareholder_id}`] = ""; });
    investors.forEach((inv) => { init[`inv_${inv.investor_id}`] = ""; });
    return init;
  });
  const [rowDates, setRowDates] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    enrolled.forEach((e) => { init[`sh_${e.shareholder_id}`] = today; });
    investors.forEach((inv) => { init[`inv_${inv.investor_id}`] = today; });
    return init;
  });
  const [saving, setSaving] = useState(false);
  const [applyingDates, setApplyingDates] = useState(false);
  const [err, setErr] = useState("");

  const applyMasterDate = async () => {
    setErr("");
    setRowDates((prev) => {
      const next = { ...prev };
      Object.keys(next).forEach((k) => { next[k] = masterDate; });
      return next;
    });
    if (!masterDate || distributions.length === 0) return;
    setApplyingDates(true);
    try {
      await Promise.all(distributions.map((d) => profitDistributionsApi.update(d.id, { distributed_at: masterDate })));
      onDone();
    } catch {
      // silently ignore — dates still set in form state
    } finally {
      setApplyingDates(false);
    }
  };

  const totalEntering = Object.values(amounts).reduce((s, v) => s + (parseFloat(v) || 0), 0);

  const submit = async () => {
    const shRows = enrolled
      .map((e) => {
        const key = `sh_${e.shareholder_id}`;
        return { project_id: project.id, shareholder_id: e.shareholder_id, amount: parseFloat(amounts[key] || "0") || 0, distributed_at: rowDates[key] || today, notes: notes.trim() || undefined };
      })
      .filter((r) => r.amount > 0);
    const invRows = investors
      .map((inv) => {
        const key = `inv_${inv.investor_id}`;
        return { project_id: project.id, investor_id: inv.investor_id, amount: parseFloat(amounts[key] || "0") || 0, distributed_at: rowDates[key] || today, notes: notes.trim() || undefined };
      })
      .filter((r) => r.amount > 0);
    const rows = [...shRows, ...invRows] as any[];
    if (!rows.length) { setErr("Enter at least one amount greater than 0."); return; }
    setSaving(true); setErr("");
    try {
      await profitDistributionsApi.create(rows);
      logActivity({ category: "project", action: "create", description: `Profit distributed for project "${project.project_name}" — ${rows.length} allocation${rows.length !== 1 ? "s" : ""}`, meta: { project_id: project.id } });
      onDone();
      onClose();
    } catch (e: any) {
      setErr(e.message?.includes("does not exist") ? "Run the profit_distributions SQL migration first." : (e.message ?? "Failed to distribute"));
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col overflow-hidden max-h-[92vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b flex-shrink-0" style={{ borderColor: "var(--border)" }}>
          <div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Distribute Profit — {project.project_name}</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto pb-20 md:pb-0">
          <div className="px-6 pt-4 pb-2 space-y-4">
            {/* Summary boxes */}
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: !project.date_completed ? "ESTIMATED PROFIT" : "TOTAL PROFIT", value: fmtKESFull(Number(project.net_profit)), bg: !project.date_completed ? "linear-gradient(135deg,#fee2e2,#fecaca)" : "linear-gradient(135deg,#dcfce7,#bbf7d0)", color: !project.date_completed ? "#b91c1c" : "#15803d", border: !project.date_completed ? "#fca5a5" : "#86efac" },
                { label: !project.date_completed ? "ESTIMATED DISTRIBUTED" : "DISTRIBUTED", value: fmtKESFull(totalDistributed), bg: "linear-gradient(135deg,#fef9c3,#fde68a)", color: "#92400e", border: "#fbbf24" },
                { label: "REMAINING", value: fmtKES(remaining), bg: "linear-gradient(135deg,#dbeafe,#bfdbfe)", color: "#1d4ed8", border: "#93c5fd" },
              ].map((s: any) => (
                <div key={s.label} className="rounded-xl border px-3 py-2.5 text-center" style={{ background: s.bg, borderColor: s.border }}>
                  <div className="text-[9px] font-bold uppercase tracking-wider mb-0.5" style={{ color: s.color }}>{s.label}</div>
                  <div className="font-bold text-xs" style={{ color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Set All Dates + Notes */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-600 block mb-1">Set All Dates At Once</label>
                <div className="flex gap-1.5">
                  <input type="date" value={masterDate} onChange={(e) => { setMasterDate(e.target.value); setErr(""); }}
                    className="flex-1 border rounded-xl px-3 py-2 text-sm focus:outline-none"
                    style={{ borderColor: "var(--border)" }} />
                  <button onClick={applyMasterDate} disabled={applyingDates}
                    className="px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap flex-shrink-0 disabled:opacity-60"
                    style={{ background: "#eef2ff", color: "#6366f1", border: "1px solid #c7d2fe" }}
                    title="Apply this date to all rows and save existing distributions">
                    {applyingDates ? "Saving…" : "Apply All"}
                  </button>
                </div>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-600 block mb-1">Notes (optional)</label>
                <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Any notes…"
                  className="w-full border rounded-xl px-3 py-2 text-sm focus:outline-none"
                  style={{ borderColor: "var(--border)" }} />
              </div>
            </div>

            {/* Section headers */}
            {enrolled.length > 0 && (
              <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Enrolled Shareholders</p>
            )}
          </div>

          {/* Shareholders list */}
          {enrolled.length === 0 ? (
            <div className="px-6 pb-2 text-center">
              <p className="text-sm text-gray-400">No shareholders enrolled.</p>
            </div>
          ) : (
            <div className="px-6 pb-2">
              {enrolled.map((e) => {
                const prevReceived = distributions.filter((d) => d.shareholder_id === e.shareholder_id && !d.investor_id).reduce((s, d) => s + Number(d.amount), 0);
                const key = `sh_${e.shareholder_id}`;
                return (
                  <div key={e.shareholder_id} className="flex items-center gap-2 py-1.5 border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold truncate text-[12px]" style={{ color: "#1a202c" }}><span className="text-[10px] font-bold text-indigo-500 mr-1">#{e.shareholder?.member_number}</span>{e.shareholder?.name}<span className="text-[10px] font-normal text-gray-400">, Current: {fmtKES(prevReceived)}</span></p>
                    </div>
                    <input type="date" value={rowDates[key] ?? today}
                      onChange={(ev) => { setRowDates((prev) => ({ ...prev, [key]: ev.target.value })); setErr(""); }}
                      className="border rounded-lg px-2 py-1 text-[11px] focus:outline-none flex-shrink-0"
                      style={{ borderColor: "var(--border)", color: "#374151", width: 130 }} />
                    <div className="flex items-center border rounded-lg overflow-hidden flex-shrink-0" style={{ borderColor: "var(--border)" }}>
                      <span className="px-2 text-[10px] font-semibold text-gray-400 bg-gray-50 border-r py-1" style={{ borderColor: "var(--border)" }}>KES</span>
                      <input type="number" value={amounts[key] ?? ""} onChange={(ev) => { setAmounts((prev) => ({ ...prev, [key]: ev.target.value })); setErr(""); }}
                        placeholder="0" className="w-24 px-2 py-1 text-xs focus:outline-none text-right" style={{ color: "#1a202c" }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Investors section */}
          {investors.length > 0 && (
            <>
              <div className="px-6 pt-3 pb-1">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">External Investors</p>
              </div>
              <div className="px-6 pb-2">
                {investors.map((inv) => {
                  const prevReceived = distributions.filter((d) => d.investor_id === inv.investor_id).reduce((s, d) => s + Number(d.amount), 0);
                  const key = `inv_${inv.investor_id}`;
                  return (
                    <div key={inv.investor_id} className="flex items-center gap-2 py-1.5 border-b last:border-b-0" style={{ borderColor: "var(--border)" }}>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>
                          <span className="text-[10px] font-bold text-indigo-500 mr-1">#{inv.investor?.member_number}</span>
                          {inv.investor?.name}
                          <span className="text-[10px] font-normal text-amber-500 ml-1">Investor</span>
                          <span className="text-[10px] font-normal text-gray-400">, Current: {fmtKES(prevReceived)}</span>
                        </p>
                      </div>
                      <input type="date" value={rowDates[key] ?? today}
                        onChange={(ev) => { setRowDates((prev) => ({ ...prev, [key]: ev.target.value })); setErr(""); }}
                        className="border rounded-lg px-2 py-1 text-[11px] focus:outline-none flex-shrink-0"
                        style={{ borderColor: "var(--border)", color: "#374151", width: 130 }} />
                      <div className="flex items-center border rounded-lg overflow-hidden flex-shrink-0" style={{ borderColor: "var(--border)" }}>
                        <span className="px-2 text-[10px] font-semibold text-gray-400 bg-gray-50 border-r py-1" style={{ borderColor: "var(--border)" }}>KES</span>
                        <input type="number" value={amounts[key] ?? ""} onChange={(ev) => { setAmounts((prev) => ({ ...prev, [key]: ev.target.value })); setErr(""); }}
                          placeholder="0" className="w-24 px-2 py-1 text-xs focus:outline-none text-right" style={{ color: "#1a202c" }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t flex-shrink-0 space-y-2" style={{ borderColor: "var(--border)" }}>
          {totalEntering > 0 && (
            <div className="flex justify-between items-center px-1">
              <span className="text-xs text-gray-500">Total to distribute</span>
              <span className="text-sm font-bold text-green-600">{fmtKESFull(totalEntering)}</span>
            </div>
          )}
          {err && <p className="text-xs text-red-500 bg-red-50 rounded-lg px-3 py-2">{err}</p>}
          {remaining <= 0 && (
            <p className="text-xs font-semibold text-center px-3 py-2 rounded-lg" style={{ background: "#fef2f2", color: "#dc2626" }}>
              No remaining profit to distribute.
            </p>
          )}
          {totalEntering > remaining && remaining > 0 && (
            <p className="text-xs font-semibold text-center px-3 py-2 rounded-lg" style={{ background: "#fef2f2", color: "#dc2626" }}>
              Total entered ({fmtKESFull(totalEntering)}) exceeds remaining ({fmtKESFull(remaining)}).
            </p>
          )}
          <button onClick={submit} disabled={saving || enrolled.length === 0 || remaining <= 0 || totalEntering > remaining}
            className="w-full py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ background: "#22c55e" }}>
            {saving ? "Distributing…" : "Confirm Distribution"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Delete Confirm Modal ─────────────────────────────────────────────────────

function DeleteConfirmModal({ title, message, onClose, onConfirm }: {
  title: string; message: string;
  onClose: () => void; onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);

  const go = async () => {
    setBusy(true);
    try { await onConfirm(); onClose(); }
    catch { /* ignore */ }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ background: "#fef2f2" }}>
            <AlertCircle size={20} color="#ef4444" />
          </div>
          <div>
            <h3 className="font-bold text-sm" style={{ color: "#1a202c" }}>{title}</h3>
            <p className="text-xs text-gray-500 mt-1">{message}</p>
          </div>
        </div>
        <div className="flex gap-3">
          <button onClick={onClose} disabled={busy}
            className="flex-1 py-2.5 rounded-xl text-sm font-semibold border"
            style={{ borderColor: "var(--border)", color: "#64748b" }}>Cancel</button>
          <button onClick={go} disabled={busy}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
            style={{ background: "#ef4444" }}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Add Investment Modal ─────────────────────────────────────────────────────

function AddInvestmentModal({
  projectId, onClose, onSaved,
}: { projectId: number; onClose: () => void; onSaved: () => void }) {
  const [investors, setInvestors] = useState<any[]>([]);
  const [search, setSearch] = useState("");
  const [selectedInvestor, setSelectedInvestor] = useState<any | null>(null);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    investorsApi.list().then(setInvestors).catch(() => {});
  }, []);

  const filtered = investors.filter((inv) =>
    inv.name.toLowerCase().includes(search.toLowerCase()) ||
    String(inv.member_number).includes(search)
  ).slice(0, 6);

  const handleSave = async () => {
    if (!selectedInvestor) { setErr("Please select an investor."); return; }
    const amt = parseFloat(amount);
    if (!amount || isNaN(amt) || amt <= 0) { setErr("Enter a valid amount."); return; }
    setSaving(true);
    setErr("");
    try {
      await projectInvestmentsApi.create({
        project_id: projectId,
        investor_id: selectedInvestor.id,
        amount: amt,
        notes: notes.trim() || undefined,
        invested_at: date,
      });
      logActivity({ category: "project", action: "create", description: `Investment of KES ${amt.toLocaleString()} by "${selectedInvestor.name}" added to project`, meta: { project_id: projectId, investor_id: selectedInvestor.id, amount: amt } });
      onSaved();
      onClose();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const fieldCls = "w-full border rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-200";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.45)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#fefce8" }}>
              <CircleDollarSign size={16} color="#ca8a04" />
            </div>
            <h2 className="font-bold text-base" style={{ color: "#1a202c" }}>Add Investment</h2>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100"><X size={16} /></button>
        </div>

        <div className="p-5 space-y-4">
          {/* Investor selector */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Select Investor</label>
            {selectedInvestor ? (
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border-2 cursor-pointer"
                style={{ borderColor: "#ca8a04", background: "#fefce8" }}
                onClick={() => { setSelectedInvestor(null); setSearch(""); }}>
                <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
                  style={{ background: selectedInvestor.avatar_color }}>
                  {selectedInvestor.photo_url
                    ? <img src={selectedInvestor.photo_url} alt={selectedInvestor.name} className="w-full h-full object-cover" />
                    : <UserCircle2 size={16} color="rgba(255,255,255,0.9)" strokeWidth={1.5} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold" style={{ color: "#1a202c" }}>{selectedInvestor.name}</div>
                  <div className="text-[10px] text-yellow-700">EI#{selectedInvestor.member_number} · Click to change</div>
                </div>
                <CheckCircle2 size={15} color="#ca8a04" />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="relative">
                  <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                  <input
                    className="w-full border rounded-xl pl-8 pr-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-yellow-200"
                    style={{ borderColor: "var(--border)" }}
                    placeholder="Search investors…"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    autoFocus
                  />
                </div>
                {filtered.length > 0 && (
                  <div className="border rounded-xl overflow-hidden" style={{ borderColor: "var(--border)" }}>
                    {filtered.map((inv) => (
                      <button key={inv.id} onClick={() => setSelectedInvestor(inv)}
                        className="w-full flex items-center gap-3 px-3 py-2.5 border-b last:border-0 hover:bg-yellow-50 text-left transition-colors"
                        style={{ borderColor: "var(--border)" }}>
                        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden"
                          style={{ background: inv.avatar_color }}>
                          {inv.photo_url
                            ? <img src={inv.photo_url} alt={inv.name} className="w-full h-full object-cover" />
                            : <UserCircle2 size={16} color="rgba(255,255,255,0.9)" strokeWidth={1.5} />}
                        </div>
                        <div>
                          <div className="text-sm font-semibold" style={{ color: "#1a202c" }}>{inv.name}</div>
                          <div className="text-[10px] text-gray-400">EI#{inv.member_number}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
                {search && filtered.length === 0 && (
                  <p className="text-xs text-gray-400 text-center py-2">No investors found.</p>
                )}
              </div>
            )}
          </div>

          {/* Amount */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Amount (KES)</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400">KES</span>
              <input type="number" min="0" className={fieldCls} style={{ borderColor: "var(--border)", paddingLeft: "2.75rem" }}
                placeholder="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>

          {/* Date */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Investment Date</label>
            <input type="date" className={fieldCls} style={{ borderColor: "var(--border)" }}
              value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          {/* Notes */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Notes (optional)</label>
            <textarea rows={2} className={fieldCls} style={{ borderColor: "var(--border)", resize: "none" }}
              placeholder="e.g. Second tranche payment"
              value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          {err && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-red-700 bg-red-50">
              <AlertCircle size={13} /> {err}
            </div>
          )}
        </div>

        <div className="flex gap-2 px-5 pb-5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
            style={{ borderColor: "var(--border)" }}>Cancel</button>
          <button onClick={handleSave} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60 flex items-center justify-center gap-2"
            style={{ background: "#ca8a04" }}>
            {saving ? <><Loader2 size={14} className="animate-spin" /> Saving…</> : "Record Investment"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── External Investment Page ─────────────────────────────────────────────────

function ExternalInvestmentPage({
  project, onBack,
}: { project: Project; onBack: () => void }) {
  const [investments, setInvestments] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const data = await projectInvestmentsApi.list(project.id);
      setInvestments(data);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [project.id]);

  useEffect(() => { load(); }, [load]);

  const totalInvested = investments.reduce((s, i) => s + Number(i.amount), 0);

  const handleDelete = async (id: number) => {
    setDeleting(true);
    try {
      await projectInvestmentsApi.remove(id);
      logActivity({ category: "project", action: "delete", description: `Investment #${id} deleted from project "${project.project_name}"`, meta: { investment_id: id, project_id: project.id } });
      setDeleteTarget(null);
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Breadcrumb header */}
      <div className="flex items-center gap-2 px-4 md:px-5 py-3 border-b bg-white flex-shrink-0" style={{ borderColor: "var(--border)" }}>
        <button onClick={onBack} className="flex items-center gap-1 text-xs font-semibold px-2 py-1.5 rounded-lg hover:bg-gray-100 transition-colors" style={{ color: "#22c55e" }}>
          <ArrowLeft size={13} /> Projects
        </button>
        <span className="text-gray-300 text-xs">›</span>
        <span className="text-xs font-semibold text-gray-500 truncate">{project.project_name}</span>
        <span className="text-gray-300 text-xs">›</span>
        <div className="flex items-center gap-1.5">
          <CircleDollarSign size={14} color="#ca8a04" />
          <span className="text-xs font-bold" style={{ color: "#1a202c" }}>External Investment</span>
        </div>
        <div className="flex-1" />
        <button onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white"
          style={{ background: "#ca8a04" }}>
          <Plus size={13} /> Add Investment
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-4" style={{ background: "var(--background)" }}>
        {/* Summary card */}
        <div className="grid grid-cols-2 gap-3">
          <div className="bg-white rounded-xl border p-4 text-center" style={{ borderColor: "var(--border)" }}>
            <div className="text-xl font-bold" style={{ color: "#ca8a04" }}>{fmtKES(totalInvested)}</div>
            <div className="text-[10px] text-gray-400 mt-0.5 uppercase tracking-wide">Total Invested</div>
          </div>
          <div className="bg-white rounded-xl border p-4 text-center" style={{ borderColor: "var(--border)" }}>
            <div className="text-xl font-bold" style={{ color: "#6366f1" }}>{investments.length}</div>
            <div className="text-[10px] text-gray-400 mt-0.5 uppercase tracking-wide">Records</div>
          </div>
        </div>

        {err && (
          <div className="flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold text-red-700 bg-red-50 border border-red-200">
            <AlertCircle size={14} /> {err}
            <button onClick={load} className="ml-auto underline text-xs">Retry</button>
          </div>
        )}

        {/* Investment list */}
        <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border)", background: "#1e3a5f" }}>
            <span className="text-xs font-bold text-white uppercase tracking-wide">Investments</span>
            <button onClick={load} className="p-1 text-white/60 hover:text-white transition-colors"><RefreshCw size={12} /></button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-gray-400 text-sm">
              <Loader2 size={16} className="animate-spin" /> Loading…
            </div>
          ) : investments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center px-6">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center mb-3" style={{ background: "#fefce8" }}>
                <CircleDollarSign size={22} color="#ca8a04" />
              </div>
              <p className="text-sm font-semibold text-gray-500">No investments recorded yet</p>
              <p className="text-xs text-gray-400 mt-1">Click "Add Investment" to record the first one.</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {investments.map((inv, idx) => (
                <div key={inv.id}
                  className="flex items-center gap-3 px-4 py-3"
                  style={{ background: idx % 2 === 0 ? "#fff" : "#dbeafe22" }}>
                  {/* Investor avatar */}
                  <div className="w-9 h-9 rounded-xl overflow-hidden flex items-center justify-center flex-shrink-0"
                    style={{ background: inv.investor?.avatar_color ?? "#eab308" }}>
                    {inv.investor?.photo_url
                      ? <img src={inv.investor.photo_url} alt={inv.investor.name} className="w-full h-full object-cover" />
                      : <UserCircle2 size={18} color="rgba(255,255,255,0.9)" strokeWidth={1.5} />}
                  </div>
                  {/* Details */}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>
                      {inv.investor?.name ?? "Unknown Investor"}
                    </div>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-bold" style={{ color: "#ca8a04" }}>EI#{inv.investor?.member_number}</span>
                      <span className="text-[10px] text-gray-400">·</span>
                      <span className="text-[10px] text-gray-400">
                        {new Date(inv.invested_at).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}
                      </span>
                      {inv.notes && <><span className="text-[10px] text-gray-400">·</span><span className="text-[10px] text-gray-400 truncate">{inv.notes}</span></>}
                    </div>
                  </div>
                  {/* Amount */}
                  <div className="text-right flex-shrink-0">
                    <div className="text-sm font-bold" style={{ color: "#22c55e" }}>{fmtKES(Number(inv.amount))}</div>
                  </div>
                  {/* Delete */}
                  {deleteTarget === inv.id ? (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => handleDelete(inv.id)} disabled={deleting}
                        className="px-2 py-1 rounded-lg text-[10px] font-bold text-white disabled:opacity-50"
                        style={{ background: "#ef4444" }}>
                        {deleting ? "…" : "Yes"}
                      </button>
                      <button onClick={() => setDeleteTarget(null)}
                        className="px-2 py-1 rounded-lg text-[10px] font-bold text-gray-500 hover:bg-gray-100">
                        No
                      </button>
                    </div>
                  ) : (
                    <button onClick={() => setDeleteTarget(inv.id)} className="p-1.5 rounded-lg text-gray-300 hover:text-red-400 hover:bg-red-50 transition-colors flex-shrink-0">
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showAdd && (
        <AddInvestmentModal projectId={project.id} onClose={() => setShowAdd(false)} onSaved={load} />
      )}
    </div>
  );
}

// ─── Project Detail View ──────────────────────────────────────────────────────

function ProjectDetailView({
  project: initialProject, onBack, onDeleted,
  shareholders, clients, onUpdated, isAdmin, currentMemberId, currentMemberType, highlightPlotId,
}: {
  project: Project; onBack: () => void; onDeleted: () => void;
  shareholders: Shareholder[]; clients: Client[];
  onUpdated: (p: Project) => void; isAdmin: boolean;
  currentMemberId?: number; currentMemberType?: string;
  highlightPlotId?: number;
}) {
  const [project, setProject] = useState(initialProject);
  const [plots, setPlots] = useState<Plot[]>([]);
  const [enrolled, setEnrolled] = useState<any[]>([]);
  const [projectInvestorsList, setProjectInvestorsList] = useState<any[]>([]);
  const [distributions, setDistributions] = useState<ProfitDistribution[]>([]);
  const [distReady, setDistReady] = useState(true);
  const [deletingDistId, setDeletingDistId] = useState<number | null>(null);
  const [loadingPlots, setLoadingPlots] = useState(true);
  const [flashPlotId, setFlashPlotId] = useState<number | undefined>(highlightPlotId);
  const plotCardRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const [loadErr, setLoadErr] = useState("");
  const [enrollErr, setEnrollErr] = useState("");
  const [generatingPlots, setGeneratingPlots] = useState(false);
  const [assignTarget, setAssignTarget] = useState<Plot | null>(null);
  const [addCoOwnerTarget, setAddCoOwnerTarget] = useState<Plot | null>(null);
  const [coOwnersMap, setCoOwnersMap] = useState<Record<number, PlotCoOwner[]>>({});
  const [coOwnersOpen, setCoOwnersOpen] = useState<Record<number, boolean>>({});
  const [viewPaymentsOpen, setViewPaymentsOpen] = useState<Record<number, boolean>>({});
  const [plotPaymentsMap, setPlotPaymentsMap] = useState<Record<number, PlotPayment[]>>({});
  const [loadingPlotPayments, setLoadingPlotPayments] = useState<Record<number, boolean>>({});
  const [deletingPlotPaymentId, setDeletingPlotPaymentId] = useState<number | null>(null);
  const [confirmDeletePlotPaymentId, setConfirmDeletePlotPaymentId] = useState<number | null>(null);
  const [payTarget, setPayTarget] = useState<Plot | null>(null);
  const [editPlotTarget, setEditPlotTarget] = useState<Plot | null>(null);
  const [deletePlotTarget, setDeletePlotTarget] = useState<Plot | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({ plots: false, shareholders: false, allocation: false, distributions: false, documents: false });
  const [showEditProject, setShowEditProject] = useState(false);
  const [showDeleteProject, setShowDeleteProject] = useState(false);
  const [showEnroll, setShowEnroll] = useState(false);
  const [showDistribute, setShowDistribute] = useState(false);
  const [distributeForMember, setDistributeForMember] = useState<any | null>(null);
  const [showInvestments, setShowInvestments] = useState(false);
  const [confirmUnenroll, setConfirmUnenroll] = useState<any | null>(null);
  const [unenrolling, setUnenrolling] = useState(false);
  const [confirmDeleteDist, setConfirmDeleteDist] = useState<any | null>(null);
  const [editDist, setEditDist] = useState<ProfitDistribution | null>(null);

  const load = useCallback(async () => {
    setLoadingPlots(true);
    setLoadErr("");
    setEnrollErr("");

    // Load plots
    try {
      const p = await plotsApi.listByProject(project.id);
      setPlots(p);
      // Load co-owners for all plots
      const coMap: Record<number, PlotCoOwner[]> = {};
      await Promise.all(p.map(async (plot) => {
        try {
          const co = await plotCoOwnersApi.listByPlot(plot.id);
          if (co.length > 0) coMap[plot.id] = co;
        } catch { /* table may not exist yet */ }
      }));
      setCoOwnersMap(coMap);
    } catch (e: any) {
      setLoadErr(e?.message ?? "Failed to load plots");
    }

    // Load enrolled shareholders
    try {
      const e = await projectsApi.getEnrolled(project.id);
      setEnrolled(e);
    } catch (e: any) {
      setEnrollErr(e?.message ?? "Failed to load enrolled members");
    }

    setLoadingPlots(false);

    // Distributions (table may not exist yet — silent fallback is OK)
    try {
      const d = await profitDistributionsApi.listByProject(project.id);
      setDistributions(d);
      setDistReady(true);
    } catch {
      setDistributions([]);
      setDistReady(false);
    }

    // Project investors (for profit distribution)
    try {
      const inv = await projectInvestmentsApi.list(project.id);
      setProjectInvestorsList(inv);
    } catch {
      setProjectInvestorsList([]);
    }
  }, [project.id]);

  // Regenerate plots for projects created before the plots table existed
  const handleGeneratePlots = async () => {
    setGeneratingPlots(true);
    setLoadErr("");
    try {
      await projectsApi.generatePlots(project);
      await load();
    } catch (e: any) {
      setLoadErr(e?.message ?? "Failed to generate plots");
    } finally {
      setGeneratingPlots(false);
    }
  };

  useEffect(() => { load(); }, [load]);

  // Scroll to and flash-highlight the deep-linked plot once plots load
  useEffect(() => {
    if (!flashPlotId || loadingPlots) return;
    const el = plotCardRefs.current[flashPlotId];
    if (el) {
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      const t = setTimeout(() => setFlashPlotId(undefined), 2000);
      return () => clearTimeout(t);
    }
  }, [flashPlotId, loadingPlots]);

  const toggleViewPayments = async (plotId: number) => {
    const nowOpen = !viewPaymentsOpen[plotId];
    setViewPaymentsOpen((o) => ({ ...o, [plotId]: nowOpen }));
    if (nowOpen && !plotPaymentsMap[plotId]) {
      setLoadingPlotPayments((l) => ({ ...l, [plotId]: true }));
      try {
        const data = await plotPaymentsApi.listByPlot(plotId);
        setPlotPaymentsMap((m) => ({ ...m, [plotId]: data }));
      } finally {
        setLoadingPlotPayments((l) => ({ ...l, [plotId]: false }));
      }
    }
  };

  const handleDeletePlotPayment = async (paymentId: number, plotId: number) => {
    setDeletingPlotPaymentId(paymentId);
    try {
      await plotPaymentsApi.remove(paymentId);
      setPlotPaymentsMap((m) => ({ ...m, [plotId]: (m[plotId] ?? []).filter((p) => p.id !== paymentId) }));
      await load();
    } finally {
      setDeletingPlotPaymentId(null);
      setConfirmDeletePlotPaymentId(null);
    }
  };

  const allocated = plots.filter((p) => p.status === "assigned");
  const available = plots.filter((p) => p.status === "available");
  const allocPct = plots.length > 0 ? Math.round((allocated.length / plots.length) * 100) : 0;

  const totalDistributed = distributions.reduce((s, d) => s + Number(d.amount), 0);
  const remaining = Math.max(0, Number(project.net_profit) - totalDistributed);

  const handleAssign = async (plotId: number, payload: PlotAssignPayload) => {
    await plotsApi.assign(plotId, payload);
    const assignedPlot = plots.find((p) => p.id === plotId);
    logActivity({ category: "plot", action: "update", description: `Plot ${assignedPlot?.plot_number ?? plotId} assigned in project "${project.project_name}"`, meta: { plot_id: plotId, project_id: project.id } });
    await load();
    // Fire plot-assigned SMS (non-blocking)
    const member = payload.assigned_to_type === "shareholder"
      ? shareholders.find((s) => s.id === payload.assigned_to_id)
      : clients.find((c) => c.id === payload.assigned_to_id);
    if (member?.phone) {
      const plot = plots.find((p) => p.id === plotId);
      sendSms(
        member.phone,
        smsTemplates.plotAssigned(
          member.name.split(" ")[0],
          plot?.plot_number ?? String(plotId),
          project.project_name,
          plot?.price ? `KES ${Number(plot.price).toLocaleString()}` : "",
        ),
        SMS_TRIGGERS.plotAssigned,
      ).catch(() => {});
    }
  };

  const handleUnassign = async (plotId: number) => {
    const unassignedPlot = plots.find((p) => p.id === plotId);
    await plotsApi.unassign(plotId);
    await plotCoOwnersApi.removeAllForPlot(plotId).catch(() => {});
    logActivity({ category: "plot", action: "update", description: `Plot ${unassignedPlot?.plot_number ?? plotId} unassigned in project "${project.project_name}"`, meta: { plot_id: plotId, project_id: project.id } });
    await load();
  };

  const handlePayment = async (plotId: number, amount: number, method: PayMethod = "cash", ref?: string, _viaStk?: boolean, phone?: string, extras?: { paidBy?: string; comment?: string }) => {
    const plot = plots.find((p) => p.id === plotId);
    const today = new Date().toISOString().slice(0, 10);

    // For STK: try resolving payer name/phone from Safaricom callback
    let payerName = extras?.paidBy || (plot ? assignedName(plot) : "");
    let payerPhone = phone ?? "";
    if (method === "mpesa" && ref && !extras) {
      try {
        const { data: cbRow } = await supabase.from("app_settings").select("value").eq("key", "mpesa_callback_last").maybeSingle();
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
    await plotsApi.recordPayment(plotId, amount, structuredNotes, today);
    logActivity({ category: "plot", action: "payment", description: `Plot ${plot?.plot_number ?? plotId} payment of KES ${amount.toLocaleString()} via ${method} by ${payerName} in project "${project.project_name}"`, meta: { plot_id: plotId, amount, method } });
    if (method === "mpesa" && plot) {
      const { paymentsApi } = await import("@/lib/api");
      const baseComment = `PHONE:${payerPhone}|ACCOUNT:${plot.plot_number}`;
      await paymentsApi.create({
        payment_id: ref ?? undefined,
        date_paid: today,
        amount,
        paid_by: payerName,
        purpose: "Plot Payment",
        mode: "Mpesa",
        comment: extras?.comment ? `${baseComment} · ${extras.comment}` : baseComment,
      });
    }
    await load();
  };

  const handleEditProject = async (data: Partial<Omit<Project, "id" | "created_at">>) => {
    const updated = await projectsApi.update(project.id, data);
    setProject(updated);
    onUpdated(updated);
    logActivity({ category: "project", action: "update", description: `Project "${updated.project_name}" updated`, meta: { id: updated.id } });
  };

  const handleDeleteProject = async () => {
    logActivity({ category: "project", action: "delete", description: `Project "${project.project_name}" deleted`, meta: { id: project.id } });
    await projectsApi.remove(project.id);
    onDeleted();
  };

  const handleEditPlot = async (data: { plot_number: string; price: number; size: number }) => {
    await plotsApi.update(editPlotTarget!.id, data);
    logActivity({ category: "plot", action: "update", description: `Plot ${data.plot_number} updated in project "${project.project_name}"`, meta: { plot_id: editPlotTarget!.id } });
    await load();
  };

  const handleDeletePlot = async () => {
    logActivity({ category: "plot", action: "delete", description: `Plot ${deletePlotTarget!.plot_number} deleted from project "${project.project_name}"`, meta: { plot_id: deletePlotTarget!.id } });
    await plotsApi.remove(deletePlotTarget!.id);
    setDeletePlotTarget(null);
    await load();
  };

  const handleUnenroll = async (enrollRow: any) => {
    setUnenrolling(true);
    try {
      await profitDistributionsApi.removeByShareholderAndProject(project.id, enrollRow.shareholder_id).catch(() => {});
      await projectsApi.unenrollShareholder(project.id, enrollRow.shareholder_id);
      logActivity({ category: "project", action: "update", description: `Shareholder unenrolled from project "${project.project_name}"`, meta: { project_id: project.id, shareholder_id: enrollRow.shareholder_id } });
      await load();
    } finally {
      setUnenrolling(false);
      setConfirmUnenroll(null);
    }
  };

  const handleDistributeToOne = async (enrollRow: any) => {
    const perMember = enrolled.length > 0 ? Math.floor(remaining / enrolled.length) : 0;
    if (perMember <= 0) return;
    await profitDistributionsApi.create([{ project_id: project.id, shareholder_id: enrollRow.shareholder_id, amount: perMember }]);
    await load();
    setDistributeForMember(null);
  };

  const toggle = (k: string) => setOpen((o) => {
    const isOpen = o[k];
    const allClosed = Object.fromEntries(Object.keys(o).map((key) => [key, false]));
    return { ...allClosed, [k]: !isOpen };
  });

  const assignedName = (p: Plot) => {
    if (p.assigned_to_type === "shareholder") {
      const s = shareholders.find((x) => x.id === p.assigned_to_id);
      return s ? `${s.name} (EW#${s.member_number})` : `Member #${p.assigned_to_id}`;
    }
    if (p.assigned_to_type === "client") {
      const c = clients.find((x) => x.id === p.assigned_to_id);
      return c ? c.name : `Client #${p.assigned_to_id}`;
    }
    return "—";
  };

  // Per-shareholder distributed amount map
  const distByMember: Record<number, number> = {};
  for (const d of distributions) {
    distByMember[d.shareholder_id] = (distByMember[d.shareholder_id] || 0) + Number(d.amount);
  }

  if (showInvestments) {
    return <ExternalInvestmentPage project={project} onBack={() => setShowInvestments(false)} />;
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b flex-shrink-0 bg-white" style={{ borderColor: "var(--border)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={onBack} className="flex items-center gap-1 text-xs font-semibold px-2 py-1.5 rounded-lg hover:bg-gray-100 flex-shrink-0" style={{ color: "#64748b" }}>
            <ArrowLeft size={13} /> Projects
          </button>
          <span className="text-gray-300 flex-shrink-0">›</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-bold text-sm truncate" style={{ color: "#1a202c" }}>{project.project_name}</h1>
              <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0"
                style={project.date_completed
                  ? { background: "#f0fdf4", color: "#16a34a" }
                  : { background: "#eff6ff", color: "#2563eb" }}>
                {project.date_completed ? "✓ Completed" : "● Active"}
              </span>
            </div>
            <p className="text-[10px] text-gray-400 flex items-center gap-1 mt-0.5">
              <MapPin size={9} />{project.location || "No location"}
              {project.date_started && (
                <span className="ml-1">
                  · Started {new Date(project.date_started).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}
                </span>
              )}
              {project.date_completed && (
                <span>· Completed {new Date(project.date_completed).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}</span>
              )}
            </p>
          </div>
          {isAdmin && (
            <div className="flex items-center gap-1.5 flex-shrink-0 flex-wrap">
              <button onClick={() => setShowDistribute(true)}
                disabled={remaining <= 0}
                title={remaining <= 0 ? "No remaining profit to distribute" : undefined}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: "#22c55e" }}>
                <TrendingUp size={12} /> Distribute Profit
              </button>
              <button onClick={() => setShowInvestments(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "#fefce8", color: "#ca8a04" }}>
                <CircleDollarSign size={12} /> External Investment
              </button>
              <button onClick={() => setShowEnroll(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "#eef2ff", color: "#4f46e5" }}>
                <UserPlus size={12} /> Enroll Members
              </button>
              <button onClick={() => setShowEditProject(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "#f1f5f9", color: "#475569" }}>
                <Edit2 size={12} /> Edit
              </button>
              <button onClick={() => setShowDeleteProject(true)}
                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-bold"
                style={{ background: "#fef2f2", color: "#ef4444" }}>
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 pb-24 md:pb-4 space-y-3" style={{ background: "var(--background)" }}>
        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            { label: "Total Plots",   value: plots.length || project.number_of_plots,   color: "#6366f1", bg: "#eef2ff" },
            { label: "Project Cost",  value: fmtKESFull(Number(project.project_cost)),   color: "#1e2d4a", bg: "#f8fafc" },
            { label: "Total Size",    value: `${project.size_acres} ac`,                 color: "#14b8a6", bg: "#f0fdfa" },
            { label: "Members",       value: enrolled.length,                            color: "#22c55e", bg: "#f0fdf4" },
          ].map((s) => (
            <div key={s.label} className="rounded-xl border p-3 text-center" style={{ borderColor: "var(--border)", background: s.bg }}>
              <div className="font-bold text-lg" style={{ color: s.color }}>{s.value}</div>
              <div className="text-[10px] text-gray-400 mt-0.5 uppercase tracking-wide">{s.label}</div>
            </div>
          ))}
        </div>

        {/* Error banners */}
        {loadErr && (
          <div className="flex items-start gap-2 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <AlertCircle size={15} className="text-red-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-red-700 font-semibold">Failed to load data</p>
              <p className="text-xs text-red-600 mt-0.5">{loadErr}</p>
            </div>
            <button onClick={load} className="text-xs font-bold text-red-600 hover:text-red-800 flex-shrink-0">Retry</button>
          </div>
        )}
        {enrollErr && (
          <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <AlertCircle size={15} className="text-amber-500 flex-shrink-0 mt-0.5" />
            <div className="flex-1">
              <p className="text-xs text-amber-700 font-semibold">Could not load enrolled members</p>
              <p className="text-xs text-amber-600 mt-0.5">{enrollErr}</p>
            </div>
          </div>
        )}

        {/* Generate plots prompt — admin only */}
        {isAdmin && !loadingPlots && !loadErr && plots.length === 0 && project.number_of_plots > 0 && (
          <div className="flex items-center gap-3 bg-indigo-50 border border-indigo-200 rounded-xl px-4 py-3">
            <AlertCircle size={15} className="text-indigo-500 flex-shrink-0" />
            <p className="text-xs text-indigo-700 flex-1">
              This project has <strong>{project.number_of_plots} plots</strong> defined but none exist in the database yet.
            </p>
            <button onClick={handleGeneratePlots} disabled={generatingPlots}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60"
              style={{ background: "#4f46e5" }}>
              {generatingPlots ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
              {generatingPlots ? "Generating…" : "Generate Plots"}
            </button>
          </div>
        )}
        {isAdmin && !loadingPlots && !loadErr && plots.length > 0 && project.number_of_plots > plots.length && (
          <div className="flex items-center gap-3 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <AlertCircle size={15} className="text-amber-500 flex-shrink-0" />
            <p className="text-xs text-amber-700 flex-1">
              Project is set to <strong>{project.number_of_plots} plots</strong> but only <strong>{plots.length}</strong> exist.{" "}
              {project.number_of_plots - plots.length} plot(s) missing.
            </p>
            <button onClick={handleGeneratePlots} disabled={generatingPlots}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold text-white disabled:opacity-60"
              style={{ background: "#d97706" }}>
              {generatingPlots ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />}
              {generatingPlots ? "Adding…" : `Add ${project.number_of_plots - plots.length} Plot(s)`}
            </button>
          </div>
        )}

        {/* Profit boxes */}
        {(
          <div className="grid grid-cols-3 gap-2">
            {[
              {
                label: !project.date_completed ? "ESTIMATED PROFIT" : "TOTAL PROFIT",
                value: fmtKESFull(Number(project.net_profit)),
                bg: !project.date_completed ? "linear-gradient(135deg,#fee2e2,#fecaca)" : "linear-gradient(135deg,#dcfce7,#bbf7d0)",
                color: !project.date_completed ? "#b91c1c" : "#15803d",
                border: !project.date_completed ? "#fca5a5" : "#86efac",
              },
              {
                label: !project.date_completed ? "ESTIMATED DISTRIBUTED" : "DISTRIBUTED",
                value: fmtKESFull(totalDistributed),
                bg: "linear-gradient(135deg,#fef9c3,#fde68a)",
                color: "#92400e",
                border: "#fbbf24",
              },
              {
                label: "REMAINING",
                value: fmtKESFull(remaining),
                bg: "linear-gradient(135deg,#dbeafe,#bfdbfe)",
                color: "#1d4ed8",
                border: "#93c5fd",
              },
            ].map((s) => (
              <div key={s.label} className="rounded-xl border px-3 py-3 text-center" style={{ background: s.bg, borderColor: s.border }}>
                <div className="text-[9px] font-bold uppercase tracking-wider mb-1" style={{ color: s.color }}>{s.label}</div>
                <div className="font-bold text-sm" style={{ color: s.color }}>{s.value}</div>
              </div>
            ))}
          </div>
        )}

        {isAdmin && !distReady && (
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-xs text-amber-700">
            <strong>profit_distributions</strong> table not found. Run the SQL migration to enable profit tracking.
          </div>
        )}

        {/* Plot Allocation accordion */}
        <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button onClick={() => toggle("allocation")} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#eef2ff" }}>
              <MapPin size={14} color="#6366f1" />
            </div>
            <span className="font-bold text-sm flex-1 text-left" style={{ color: "#1a202c" }}>Plot Allocation</span>
            <span className="text-xs text-gray-400">{allocated.length} allocated · {available.length} available</span>
            <ChevronDown size={15} className={`text-gray-400 transition-transform flex-shrink-0 ${open.allocation ? "rotate-180" : ""}`} />
          </button>
          {open.allocation && (
            <div className="px-4 pb-4 border-t" style={{ borderColor: "var(--border)" }}>
              <div className="h-2.5 rounded-full overflow-hidden mt-3 mb-1" style={{ background: "#e2e8f0" }}>
                <div className="h-full rounded-full transition-all" style={{ width: `${allocPct}%`, background: "#6366f1" }} />
              </div>
              <p className="text-xs text-gray-500">{allocPct}% of plots allocated ({allocated.length}/{plots.length})</p>
            </div>
          )}
        </div>

        {/* Profit Distributions accordion — admin only */}
        {isAdmin && <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button onClick={() => toggle("distributions")} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#f0fdf4" }}>
              <TrendingUp size={14} color="#22c55e" />
            </div>
            <span className="font-bold text-sm flex-1 text-left" style={{ color: "#1a202c" }}>Profit Distributions ({distributions.length})</span>
            <ChevronDown size={15} className={`text-gray-400 transition-transform flex-shrink-0 ${open.distributions ? "rotate-180" : ""}`} />
          </button>
          {open.distributions && (
            <div className="border-t" style={{ borderColor: "var(--border)" }}>
              {distributions.length === 0 ? (
                <p className="px-4 py-3 text-xs text-gray-400">No distributions recorded yet.</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {distributions.map((d) => {
                    const isInvestor = !!d.investor_id;
                    const name = isInvestor ? d.investor?.name : d.shareholder?.name;
                    const memberNum = isInvestor ? d.investor?.member_number : d.shareholder?.member_number;
                    const isDeleting = deletingDistId === d.id;
                    return (
                      <div key={d.id} className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color: "#1a202c" }}>
                            {name}
                            {isInvestor && <span className="text-[9px] font-bold px-1 py-0.5 rounded" style={{ background: "#fffbeb", color: "#d97706" }}>Investor</span>}
                          </p>
                          <p className="text-[10px] text-gray-400">#{memberNum} · {new Date(d.distributed_at).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}</p>
                          {d.notes && <p className="text-[10px] text-gray-400 truncate mt-0.5 italic" title={d.notes}>{d.notes}</p>}
                        </div>
                        <div className="flex flex-col items-end shrink-0 gap-0.5">
                          <span className="text-xs font-bold text-green-600">{fmtKESFull(Number(d.amount))}</span>
                          {!project.date_completed && (
                            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded" style={{ background: "#fef2f2", color: "#dc2626" }}>Estimated</span>
                          )}
                        </div>
                        {isAdmin && (
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              onClick={() => setEditDist(d)}
                              className="px-2 py-1 rounded-lg text-[10px] font-bold hover:opacity-80"
                              style={{ background: "#eef2ff", color: "#6366f1" }}
                              title="Edit distribution"
                            >
                              EDIT
                            </button>
                            <button
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteDist(d)}
                              className="w-6 h-6 flex items-center justify-center rounded hover:bg-red-50 text-gray-300 hover:text-red-500 transition-colors disabled:opacity-40"
                              title="Delete distribution"
                            >
                              {isDeleting ? (
                                <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="32" strokeDashoffset="10" /></svg>
                              ) : (
                                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>}

        {/* Enrolled Shareholders accordion — admin only */}
        {isAdmin && <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button onClick={() => toggle("shareholders")} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#f0fdf4" }}>
              <Users size={14} color="#22c55e" />
            </div>
            <span className="font-bold text-sm flex-1 text-left" style={{ color: "#1a202c" }}>Enrolled Shareholders ({enrolled.length})</span>
            <ChevronDown size={15} className={`text-gray-400 transition-transform flex-shrink-0 ${open.shareholders ? "rotate-180" : ""}`} />
          </button>
          {open.shareholders && (
            <div className="border-t" style={{ borderColor: "var(--border)" }}>
              {enrolled.length === 0 ? (
                <p className="px-4 py-3 text-xs text-gray-400">No shareholders enrolled. Assign plots or use "Enroll Members".</p>
              ) : (
                <div className="divide-y" style={{ borderColor: "var(--border)" }}>
                  {[...enrolled].sort((a, b) => (a.shareholder?.member_number ?? 0) - (b.shareholder?.member_number ?? 0)).map((e: any) => {
                    const received = distByMember[e.shareholder_id] || 0;
                    const alreadyDist = received > 0;
                    return (
                      <div key={e.id} className="px-4 py-2.5 flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-semibold truncate" style={{ color: "#1a202c" }}>{e.shareholder?.name}</p>
                          <p className="text-[10px] text-gray-400">
                            EW#{e.shareholder?.member_number}
                            {alreadyDist && <span className="ml-1.5 text-green-600 font-semibold">· {fmtKES(received)} Earned from this project</span>}
                          </p>
                        </div>
                        {isAdmin && (
                          <div className="flex items-center gap-1.5 flex-shrink-0">
                            <button onClick={() => setConfirmUnenroll(e)}
                              className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-bold"
                              style={{ background: "#fef2f2", color: "#ef4444" }}>
                              <X size={10} /> Remove
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>}

        {/* Plots accordion */}
        {(() => {
          const visiblePlots = isAdmin ? plots : plots.filter((p) => p.status !== "assigned");
          return (
        <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button onClick={() => toggle("plots")} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#f8fafc" }}>
              <FolderOpen size={14} color="#475569" />
            </div>
            <span className="font-bold text-sm flex-1 text-left" style={{ color: "#1a202c" }}>
              {isAdmin ? `Plots (${plots.length})` : `Available Plots (${visiblePlots.length})`}
            </span>
            {isAdmin && <span className="text-xs mr-1">
              <span className="text-gray-400">{available.length} available</span>
              <span className="mx-1 text-gray-200">·</span>
              <span className="text-indigo-500">{allocated.length} allocated</span>
            </span>}
            <ChevronDown size={15} className={`text-gray-400 transition-transform flex-shrink-0 ${open.plots ? "rotate-180" : ""}`} />
          </button>
          {open.plots && (
            <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
              {loadingPlots ? (
                <div className="flex justify-center py-6"><Loader2 size={20} className="animate-spin text-gray-300" /></div>
              ) : visiblePlots.length === 0 ? (
                <p className="text-xs text-gray-400">{isAdmin ? "No plots found." : "No available plots at this time."}</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {visiblePlots.map((p) => {
                    const price = Number(p.price);
                    const paid = Number(p.paid_amount);
                    const pct = price > 0 ? Math.round((paid / price) * 100) : 0;
                    const isAssigned = p.status === "assigned";
                    const coOwners = coOwnersMap[p.id] ?? [];
                    const isMulti = coOwners.length > 0;
                    const coOpen = coOwnersOpen[p.id] ?? false;

                    const coOwnerLabel = (co: PlotCoOwner) => {
                      if (co.member_type === "shareholder") {
                        const s = shareholders.find((x) => x.id === co.member_id);
                        return s ? { num: `EW#${s.member_number}`, name: s.name, type: "Shareholder" } : { num: `#${co.member_id}`, name: "Unknown", type: "Shareholder" };
                      }
                      const c = clients.find((x) => x.id === co.member_id);
                      return c ? { num: c.member_number ?? `#${co.member_id}`, name: c.name, type: "Client" } : { num: `#${co.member_id}`, name: "Unknown", type: "Client" };
                    };

                    return (
                      <div key={p.id} ref={(el) => { plotCardRefs.current[p.id] = el; }}
                        className="rounded-xl border overflow-hidden transition-all duration-700"
                        style={{ borderColor: flashPlotId === p.id ? "#6366f1" : "#000000", background: isAssigned ? "#fafafe" : "#fafafa", boxShadow: flashPlotId === p.id ? "0 0 0 3px rgba(99,102,241,0.25)" : undefined }}>
                        <div className="p-3 space-y-1.5">
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-bold text-sm truncate" style={{ color: "#1a202c" }}>{p.plot_number}</p>
                              <p className="text-[#050505] text-[12px]">{p.size ? `${p.size} ac · ` : ""}{fmtKESFull(price)}</p>
                            </div>
                            <span className={`font-bold px-2 py-0.5 rounded-full flex-shrink-0 ${isAssigned ? "bg-indigo-50 text-indigo-600" : "bg-green-500 text-black"} text-[11px]`}>
                              {isAssigned ? "Assigned" : "Available"}
                            </span>
                          </div>
                          {isAssigned && (
                            <>
                              {isMulti ? (
                                <button
                                  onClick={() => setCoOwnersOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
                                  className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors"
                                  style={{ background: "#eff6ff", color: "#2563eb" }}>
                                  <Users size={11} />
                                  Multiple ({coOwners.length + 1})
                                  <ChevronDown size={11} className={`transition-transform ${coOpen ? "rotate-180" : ""}`} />
                                </button>
                              ) : (
                                <p className="font-medium text-[13px] flex items-center gap-1.5 flex-wrap" style={{ color: "#374151" }}>
                                  {assignedName(p)}
                                  {p.assigned_to_type === "client" && (
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ background: "#fef3c7", color: "#b45309" }}>Client</span>
                                  )}
                                  {p.assigned_to_type === "shareholder" && (
                                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full flex-shrink-0" style={{ background: "#eff6ff", color: "#2563eb" }}>Shareholder</span>
                                  )}
                                </p>
                              )}
                              {/* Co-owners panel */}
                              {isMulti && coOpen && (
                                <div className="rounded-xl border overflow-hidden mt-1" style={{ borderColor: "#dbeafe" }}>
                                  {/* Primary owner */}
                                  <div className="flex items-center gap-2 px-3 py-2 bg-blue-50 border-b" style={{ borderColor: "#dbeafe" }}>
                                    <span className="text-[10px] font-bold text-indigo-500 w-16 shrink-0">
                                      {p.assigned_to_type === "shareholder"
                                        ? `EW#${shareholders.find((x) => x.id === p.assigned_to_id)?.member_number ?? p.assigned_to_id}`
                                        : clients.find((x) => x.id === p.assigned_to_id)?.member_number ?? `#${p.assigned_to_id}`}
                                    </span>
                                    <span className="text-xs font-semibold flex-1 truncate" style={{ color: "#1a202c" }}>{assignedName(p).split(" (")[0]}</span>
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                      style={{ background: p.assigned_to_type === "shareholder" ? "#eff6ff" : "#fef3c7", color: p.assigned_to_type === "shareholder" ? "#2563eb" : "#d97706" }}>
                                      {p.assigned_to_type === "shareholder" ? "Shareholder" : "Client"}
                                    </span>
                                  </div>
                                  {/* Co-owners */}
                                  {coOwners.map((co) => {
                                    const m = coOwnerLabel(co);
                                    return (
                                      <div key={co.id} className="flex items-center gap-2 px-3 py-2 border-b last:border-b-0" style={{ borderColor: "#dbeafe" }}>
                                        <span className="text-[10px] font-bold text-indigo-500 w-16 shrink-0">{m.num}</span>
                                        <span className="text-xs font-semibold flex-1 truncate" style={{ color: "#1a202c" }}>{m.name}</span>
                                        <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                                          style={{ background: co.member_type === "shareholder" ? "#eff6ff" : "#fef3c7", color: co.member_type === "shareholder" ? "#2563eb" : "#d97706" }}>
                                          {m.type}
                                        </span>
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              <div className="h-1 rounded-full overflow-hidden" style={{ background: "#e2e8f0" }}>
                                <div className="h-full rounded-full" style={{ width: `${pct}%`, background: "#22c55e" }} />
                              </div>
                              <p className="text-[10px] text-[#0d0d0d] font-bold">
                                Paid: {fmtKESFull(paid)} · Due: {fmtKESFull(Math.max(0, price - paid))} · {pct}%
                              </p>
                            </>
                          )}
                        </div>
                        {/* Action buttons — admin only */}
                        {isAdmin && (
                          <div className="grid border-t" style={{ borderColor: "#e2e8f0", gridTemplateColumns: isAssigned ? `1fr 1fr 1fr 1fr 1fr 1fr` : "1fr 1fr 1fr 1fr 1fr" }}>
                            <button onClick={() => setEditPlotTarget(p)}
                              className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                              style={{ borderColor: "#e2e8f0", color: "#64748b", background: "#f8fafc" }}>
                              <Edit2 size={11} /> Edit
                            </button>
                            <button onClick={() => toggleViewPayments(p.id)}
                              className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                              style={{ borderColor: "#e2e8f0", color: viewPaymentsOpen[p.id] ? "#4338ca" : "#6366f1", background: viewPaymentsOpen[p.id] ? "#e0e7ff" : "#eef2ff" }}>
                              <List size={11} /> Payments
                            </button>
                            {isAssigned ? (
                              <>
                                <button onClick={() => setPayTarget(p)}
                                  className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                                  style={{ borderColor: "#e2e8f0", color: "#16a34a", background: "#f0fdf4" }}>
                                  <Wallet size={11} /> Pay
                                </button>
                                <button onClick={() => setAddCoOwnerTarget(p)}
                                  className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                                  style={{ borderColor: "#e2e8f0", color: "#2563eb", background: "#eff6ff" }}>
                                  <Users size={11} /> Co-Own
                                </button>
                                <button onClick={() => handleUnassign(p.id)}
                                  className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                                  style={{ borderColor: "#e2e8f0", color: "#d97706", background: "#fffbeb" }}>
                                  <RotateCcw size={11} /> Unassign
                                </button>
                              </>
                            ) : (
                              <>
                                <button onClick={() => setAssignTarget(p)}
                                  className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                                  style={{ borderColor: "#e2e8f0", color: "#4f46e5", background: "#eef2ff" }}>
                                  <Users size={11} /> Assign
                                </button>
                                <button onClick={() => setAddCoOwnerTarget(p)}
                                  className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold border-r"
                                  style={{ borderColor: "#e2e8f0", color: "#2563eb", background: "#eff6ff" }}>
                                  <Users size={11} /> Co-Own
                                </button>
                              </>
                            )}
                            <button onClick={() => setDeletePlotTarget(p)}
                              className="py-2 flex items-center justify-center gap-1 text-[10px] font-bold"
                              style={{ color: "#ef4444", background: "#fef2f2" }}>
                              <Trash2 size={11} /> Delete
                            </button>
                          </div>
                        )}

                        {/* View Payments panel */}
                        {viewPaymentsOpen[p.id] && (
                          <div className="border-t" style={{ borderColor: "#e2e8f0" }}>
                            {loadingPlotPayments[p.id] ? (
                              <div className="flex justify-center py-3"><Loader2 size={13} className="animate-spin text-gray-300" /></div>
                            ) : (plotPaymentsMap[p.id] ?? []).length === 0 ? (
                              <p className="px-4 py-3 text-xs text-gray-400 italic">No payment records yet.</p>
                            ) : (
                              <>
                                <div className="grid px-3 py-1.5 text-[10px] font-semibold text-white"
                                  style={{ gridTemplateColumns: "1fr 1fr 1.5fr auto", background: "#1e3a5f" }}>
                                  <span>Date</span><span>Amount</span><span>Notes</span><span />
                                </div>
                                {(plotPaymentsMap[p.id] ?? []).map((pay, pi) => {
                                  let note = pay.notes || "—";
                                  try { const parsed = JSON.parse(pay.notes ?? ""); if (parsed?.note) note = parsed.note; else if (parsed?.method) note = parsed.method; } catch { /* plain text */ }
                                  return (
                                    <div key={pay.id} className="grid px-3 py-2 items-center text-[10px] border-b last:border-b-0"
                                      style={{ gridTemplateColumns: "1fr 1fr 1.5fr auto", background: pi % 2 === 0 ? "#f8fafc" : "#fff", borderColor: "#f1f5f9" }}>
                                      <span className="text-gray-500">{new Date(pay.payment_date || pay.created_at).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit" })}</span>
                                      <span className="font-bold text-green-600">{fmtKES(Number(pay.amount))}</span>
                                      <span className="text-gray-400 truncate pr-1">{note}</span>
                                      <div className="flex items-center gap-1">
                                        {confirmDeletePlotPaymentId === pay.id ? (
                                          <>
                                            <button onClick={() => handleDeletePlotPayment(pay.id, p.id)} disabled={deletingPlotPaymentId === pay.id}
                                              className="text-[9px] font-bold px-1.5 py-0.5 rounded text-white disabled:opacity-50" style={{ background: "#ef4444" }}>
                                              {deletingPlotPaymentId === pay.id ? "…" : "Yes"}
                                            </button>
                                            <button onClick={() => setConfirmDeletePlotPaymentId(null)}
                                              className="text-[9px] font-bold px-1.5 py-0.5 rounded border" style={{ borderColor: "#e2e8f0", color: "#64748b" }}>No</button>
                                          </>
                                        ) : (
                                          <button onClick={() => setConfirmDeletePlotPaymentId(pay.id)}
                                            className="p-0.5 rounded hover:bg-red-50 text-red-400 hover:text-red-600 transition-colors">
                                            <Trash2 size={11} />
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                                <div className="px-3 py-1.5 flex justify-between text-[10px]" style={{ background: "#f0f4ff" }}>
                                  <span className="text-gray-500">{(plotPaymentsMap[p.id] ?? []).length} record(s)</span>
                                  <span className="font-bold" style={{ color: "#1e3a5f" }}>
                                    Total: {fmtKES((plotPaymentsMap[p.id] ?? []).reduce((s, py) => s + Number(py.amount), 0))}
                                  </span>
                                </div>
                              </>
                            )}
                          </div>
                        )}

                        {/* Plot documents (collapsible) */}
                        <PlotDocumentsRow
                          plotId={p.id}
                          isAdmin={isAdmin}
                          canView={isAdmin || (p.assigned_to_id === currentMemberId && p.assigned_to_type === currentMemberType)}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
          );
        })()}
        {/* Project Documents accordion — admin only */}
        {isAdmin && <div className="bg-white rounded-xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <button onClick={() => toggle("documents")} className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: "#eef2ff" }}>
              <FileText size={14} color="#6366f1" />
            </div>
            <span className="font-bold text-sm flex-1 text-left" style={{ color: "#1a202c" }}>Project Documents</span>
            {!isAdmin && <span className="text-[10px] font-semibold text-gray-400 mr-1">View only</span>}
            <ChevronDown size={15} className={`text-gray-400 transition-transform flex-shrink-0 ${open.documents ? "rotate-180" : ""}`} />
          </button>
          {open.documents && (
            <div className="border-t p-4" style={{ borderColor: "var(--border)" }}>
              <DocumentsSection entityType="project" entityId={project.id} isAdmin={isAdmin} />
            </div>
          )}
        </div>}
      </div>

      {/* Modals */}
      {assignTarget && (
        <AssignPlotModal plot={assignTarget} projectName={project.project_name}
          shareholders={shareholders} clients={clients}
          onClose={() => setAssignTarget(null)} onSave={handleAssign} />
      )}
      {addCoOwnerTarget && (
        <AddCoOwnerModal
          plot={addCoOwnerTarget}
          shareholders={shareholders}
          clients={clients}
          existingCoOwners={coOwnersMap[addCoOwnerTarget.id] ?? []}
          onClose={() => setAddCoOwnerTarget(null)}
          onDone={async () => { await load(); }}
        />
      )}
      {payTarget && (
        <PlotPaymentModal plot={payTarget}
          projectName={project.project_name}
          assignedName={assignedName(payTarget)}
          isAdmin={true}
          memberPhone={(() => {
            if (payTarget.assigned_to_type === "shareholder") return shareholders.find((s) => s.id === payTarget.assigned_to_id)?.phone;
            if (payTarget.assigned_to_type === "client") return clients.find((c) => c.id === payTarget.assigned_to_id)?.phone;
            return undefined;
          })()}
          onClose={() => setPayTarget(null)}
          onSave={(amt, method, ref, viaStk, phone, extras) => handlePayment(payTarget.id, amt, method, ref, viaStk, phone, extras)} />
      )}
      {editPlotTarget && (
        <EditPlotModal plot={editPlotTarget}
          onClose={() => setEditPlotTarget(null)}
          onSave={handleEditPlot} />
      )}
      {deletePlotTarget && (
        <DeleteConfirmModal
          title={`Delete ${deletePlotTarget.plot_number}?`}
          message="This will permanently delete the plot and all its payment records. This cannot be undone."
          onClose={() => setDeletePlotTarget(null)}
          onConfirm={handleDeletePlot} />
      )}
      {showEditProject && (
        <EditProjectModal project={project}
          onClose={() => setShowEditProject(false)}
          onSave={handleEditProject} />
      )}
      {showDeleteProject && (
        <DeleteConfirmModal
          title={`Delete "${project.project_name}"?`}
          message="This will permanently delete the project along with all plots, assignments, payments, enrollments, and profit distributions. This cannot be undone."
          onClose={() => setShowDeleteProject(false)}
          onConfirm={handleDeleteProject} />
      )}
      {showEnroll && (
        <EnrollMembersModal project={project} shareholders={shareholders} enrolled={enrolled}
          onClose={() => setShowEnroll(false)} onDone={load} />
      )}
      {showDistribute && (
        <DistributeProfitModal project={project} enrolled={enrolled} investors={projectInvestorsList} distributions={distributions}
          onClose={() => setShowDistribute(false)} onDone={load} />
      )}
      {distributeForMember && (
        <DeleteConfirmModal
          title={`Distribute profit to ${distributeForMember.shareholder?.name}?`}
          message={`They will receive ${fmtKESFull(enrolled.length > 0 ? Math.floor(remaining / enrolled.length) : 0)} (their equal share of the remaining ${fmtKESFull(remaining)}).`}
          onClose={() => setDistributeForMember(null)}
          onConfirm={() => handleDistributeToOne(distributeForMember)} />
      )}
      {confirmUnenroll && (
        <ConfirmModal
          title="Remove Enrolled Member"
          message={<>Remove <strong>{confirmUnenroll.shareholder?.name ?? "this member"}</strong> from <strong>{project.project_name}</strong>? Their profit distributions for this project will also be deleted.</>}
          confirmLabel="Remove"
          busy={unenrolling}
          onCancel={() => setConfirmUnenroll(null)}
          onConfirm={() => handleUnenroll(confirmUnenroll)}
        />
      )}
      {editDist && (
        <EditDistributionModal
          dist={editDist}
          onClose={() => setEditDist(null)}
          onSave={async (patch) => {
            await profitDistributionsApi.update(editDist.id, patch);
            logActivity({ category: "project", action: "update", description: `Profit distribution #${editDist.id} updated for project "${project.project_name}"`, meta: { dist_id: editDist.id } });
            setDistributions((prev) => prev.map((d) => d.id === editDist.id ? { ...d, ...patch } : d));
            setEditDist(null);
          }}
        />
      )}
      {confirmDeleteDist && (
        <ConfirmModal
          title="Delete Distribution"
          message={<>Delete the {!project.date_completed ? "estimated " : ""}profit of <strong>{fmtKESFull(Number(confirmDeleteDist.amount))}</strong> allocated to <strong>{confirmDeleteDist.investor_id ? confirmDeleteDist.investor?.name : confirmDeleteDist.shareholder?.name}</strong>?</>}
          confirmLabel="Delete"
          busy={deletingDistId === confirmDeleteDist.id}
          onCancel={() => setConfirmDeleteDist(null)}
          onConfirm={async () => {
            setDeletingDistId(confirmDeleteDist.id);
            try {
              await profitDistributionsApi.remove(confirmDeleteDist.id);
              logActivity({ category: "project", action: "delete", description: `Profit distribution #${confirmDeleteDist.id} of KES ${Number(confirmDeleteDist.amount).toLocaleString()} deleted from project "${project.project_name}"`, meta: { dist_id: confirmDeleteDist.id, project_id: project.id } });
              setDistributions((prev) => prev.filter((x) => x.id !== confirmDeleteDist.id));
            } finally {
              setDeletingDistId(null);
              setConfirmDeleteDist(null);
            }
          }}
        />
      )}
    </div>
  );
}

// ─── Projects Page ────────────────────────────────────────────────────────────

function ProjectsPage({ isAdmin = true, currentMemberId, currentMemberType }: { isAdmin?: boolean; currentMemberId?: number; currentMemberType?: string }) {
  const location = useLocation();
  const deepLink = (location.state as { projectId?: number; plotId?: number } | null) ?? {};

  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [dbReady, setDbReady] = useState(true);
  const [selected, setSelected] = useState<Project | null>(null);
  const [deepLinkPlotId, setDeepLinkPlotId] = useState<number | undefined>(deepLink.plotId);
  const [showCreate, setShowCreate] = useState(false);
  const [search, setSearch] = useState("");
  const [shareholders, setShareholders] = useState<Shareholder[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [plotCounts, setPlotCounts] = useState<Record<number, { total: number; allocated: number }>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [p, sh, cl] = await Promise.all([
        projectsApi.list(),
        shareholdersApi.list(),
        clientsApi.list(),
      ]);
      setProjects(p);
      setShareholders(sh);
      setClients(cl);
      setDbReady(true);

      // Load plot allocation counts for all projects
      const { data: allPlots } = await supabase.from("plots").select("project_id, status, assigned_to_id");
      if (allPlots) {
        const counts: Record<number, { total: number; allocated: number }> = {};
        for (const plot of allPlots) {
          if (!counts[plot.project_id]) counts[plot.project_id] = { total: 0, allocated: 0 };
          counts[plot.project_id].total++;
          if (plot.assigned_to_id || plot.status === "allocated" || plot.status === "sold") {
            counts[plot.project_id].allocated++;
          }
        }
        setPlotCounts(counts);
      }
    } catch (e: any) {
      if (e.message?.includes("schema cache") || e.message?.includes("does not exist")) setDbReady(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-open project from deep-link (e.g. navigated from Allocated Plots card)
  useEffect(() => {
    if (!deepLink.projectId || projects.length === 0 || selected) return;
    const target = projects.find((p) => p.id === deepLink.projectId);
    if (target) setSelected(target);
  }, [projects, deepLink.projectId]);

  if (!dbReady) return (
    <div className="flex flex-col items-center justify-center h-full text-center px-8 py-12">
      <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#fef3c7" }}>
        <AlertCircle size={30} color="#d97706" />
      </div>
      <h2 className="font-bold text-lg mb-2" style={{ color: "#1a202c" }}>Database setup required</h2>
      <p className="text-sm text-gray-500 max-w-sm mb-4">
        The <code className="bg-gray-100 px-1 rounded text-xs">projects</code>, <code className="bg-gray-100 px-1 rounded text-xs">plots</code>, and <code className="bg-gray-100 px-1 rounded text-xs">project_shareholders</code> tables are missing.
        Run the SQL in your Supabase SQL Editor to set them up.
      </p>
      <button onClick={load} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-bold text-white" style={{ background: "#22c55e" }}>
        <RefreshCw size={14} /> Retry
      </button>
    </div>
  );

  const filtered = projects.filter((p) =>
    !search || p.project_name.toLowerCase().includes(search.toLowerCase()) || p.location.toLowerCase().includes(search.toLowerCase())
  );

  const handleCreate = async (payload: Omit<Project, "id" | "created_at">) => {
    const p = await projectsApi.create(payload);
    logActivity({ category: "project", action: "create", description: `Project "${p.project_name}" created`, meta: { id: p.id } });
    await load();
    setSelected(p);
  };

  const COLOR = "#22c55e";

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left list */}
      <div className={`flex flex-col ${selected ? "hidden md:flex" : "flex"} w-full md:w-72 flex-shrink-0 border-r bg-white overflow-hidden`}
        style={{ borderColor: "var(--border)" }}>
        <div className="px-4 py-3 border-b flex-shrink-0 flex items-center justify-between" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ background: "#f0fdf4" }}>
              <FolderOpen size={14} color={COLOR} />
            </div>
            <span className="font-bold text-sm" style={{ color: "#1a202c" }}>Projects</span>
            <span className="text-xs text-gray-400">({projects.length})</span>
          </div>
          {isAdmin && (
            <button onClick={() => setShowCreate(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-bold text-white"
              style={{ background: COLOR }}>
              <Plus size={12} /> New
            </button>
          )}
        </div>
        <div className="px-3 py-2 border-b flex-shrink-0" style={{ borderColor: "var(--border)" }}>
          <div className="relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search projects…"
              className="w-full pl-8 pr-3 py-1.5 border rounded-lg text-xs focus:outline-none"
              style={{ borderColor: "var(--border)" }} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-3 pb-24 md:pb-3 space-y-2">
          {loading ? (
            <div className="flex justify-center py-8"><Loader2 size={20} className="animate-spin text-gray-300" /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8">
              <FolderOpen size={28} className="mx-auto mb-2 text-gray-200" />
              <p className="text-sm text-gray-400">{search ? "No projects match" : "No projects yet"}</p>
              {!search && isAdmin && <button onClick={() => setShowCreate(true)} className="mt-2 text-xs font-semibold" style={{ color: COLOR }}>+ Create first project</button>}
            </div>
          ) : filtered.map((p) => (
            <button key={p.id} onClick={() => setSelected(p)}
              className="w-full text-left rounded-xl border p-3 hover:shadow-sm transition-all"
              style={{ borderColor: selected?.id === p.id ? COLOR : "#111827", background: selected?.id === p.id ? "#f0fdf4" : "#fff" }}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-sm truncate" style={{ color: "#1a202c" }}>{p.project_name}</p>
                  <p className="text-[10px] text-gray-400 flex items-center gap-0.5 mt-0.5"><MapPin size={9} />{p.location || "No location"}</p>
                </div>
                <div className="flex flex-col items-end gap-1 flex-shrink-0">
                  <span className="text-xs font-bold" style={{ color: COLOR }}>{p.number_of_plots} Plot{p.number_of_plots !== 1 ? "s" : ""}</span>
                  {p.size_acres ? <span className="text-[9px] text-gray-400 font-semibold">{p.size_acres} Acres</span> : null}
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full"
                    style={p.date_completed
                      ? { background: "#f0fdf4", color: "#16a34a" }
                      : { background: "#eff6ff", color: "#2563eb" }}>
                    {p.date_completed ? "Completed" : "Active"}
                  </span>
                </div>
              </div>
              <div className="mt-2 flex justify-between">
                <div className="text-[10px] text-gray-500"><span className="font-semibold">Cost:</span> {fmtKESFull(Number(p.project_cost))}</div>
                <div className="text-[10px] text-gray-500"><span className="font-semibold">Profit:</span> {fmtKESFull(Number(p.net_profit))}</div>
              </div>

              {/* Plot allocation progress bar */}
              {(() => {
                const counts = plotCounts[p.id];
                const total = counts?.total ?? p.number_of_plots ?? 0;
                const allocated = counts?.allocated ?? 0;
                const available = Math.max(0, total - allocated);
                const pct = total > 0 ? Math.round((allocated / total) * 100) : 0;
                return total > 0 ? (
                  <div className="mt-2">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[9px] font-semibold text-gray-500">Plot Allocation</span>
                      <span className="text-[9px] font-bold" style={{ color: COLOR }}>{pct}%</span>
                    </div>
                    <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "#e2e8f0" }}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: COLOR }} />
                    </div>
                    <div className="flex justify-between mt-1">
                      <span className="text-[9px] text-gray-400">Sold: <span className="font-bold" style={{ color: "#16a34a" }}>{allocated}</span></span>
                      <span className="text-[9px] text-gray-400">Available: <span className="font-bold" style={{ color: "#2563eb" }}>{available}</span></span>
                      <span className="text-[9px] text-gray-400">Total: <span className="font-bold text-gray-600">{total}</span></span>
                    </div>
                  </div>
                ) : null;
              })()}

              {p.date_started && (
                <div className="mt-1 text-[9px] text-gray-400">
                  Started: {new Date(p.date_started).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}
                  {p.date_completed && ` · Completed: ${new Date(p.date_completed).toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" })}`}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Right detail */}
      <div className={`flex-1 overflow-hidden ${selected ? "flex" : "hidden md:flex"} flex-col`} style={{ background: "var(--background)" }}>
        {selected ? (
          <ProjectDetailView
            key={selected.id}
            project={selected}
            onBack={() => setSelected(null)}
            onDeleted={() => { setSelected(null); load(); }}
            shareholders={shareholders}
            clients={clients}
            isAdmin={isAdmin}
            currentMemberId={currentMemberId}
            currentMemberType={currentMemberType}
            highlightPlotId={deepLinkPlotId}
            onUpdated={(updated) => {
              setSelected(updated);
              setProjects((prev) => prev.map((p) => p.id === updated.id ? updated : p));
            }}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: "#f0fdf4" }}>
              <FolderOpen size={30} color={COLOR} />
            </div>
            <h3 className="font-bold text-base mb-1" style={{ color: "#1a202c" }}>Select a project</h3>
            <p className="text-sm text-gray-400">Click a project to manage plots, enroll members, and distribute profit.</p>
          </div>
        )}
      </div>

      {isAdmin && showCreate && (
        <CreateProjectModal onClose={() => setShowCreate(false)} onSave={handleCreate} />
      )}
    </div>
  );
}

export { ProjectsPage };
