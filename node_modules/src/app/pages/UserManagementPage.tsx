import { useState, useEffect, useCallback } from "react";
import {
  Users, Plus, X, Loader2, ShieldCheck, UserCircle2,
  CircleDollarSign, Eye, EyeOff, Trash2, CheckCircle, AlertCircle,
  RefreshCw, KeyRound, Zap, Phone,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { shareholdersApi, clientsApi, investorsApi, logActivity } from "@/lib/api";
import { phoneToEmail, toSupabaseEmail } from "@/app/pages/AuthPage";

export interface UserAccount {
  id: string;
  role: "admin" | "shareholder" | "client" | "investor";
  member_id: number | null;
  full_name: string;
  email: string;
  is_active: boolean;
  created_at: string;
}

const ROLE_META = {
  admin:       { label: "Admin",       color: "#1e2d4a", bg: "#eef2ff", icon: <ShieldCheck size={13} /> },
  shareholder: { label: "Shareholder", color: "#6366f1", bg: "#eef2ff", icon: <Users size={13} /> },
  client:      { label: "Client",      color: "#9333ea", bg: "#faf5ff", icon: <UserCircle2 size={13} /> },
  investor:    { label: "Investor",    color: "#d97706", bg: "#fffbeb", icon: <CircleDollarSign size={13} /> },
};

const DEFAULT_PASSWORD = "123456";

// Creates a Supabase Auth user via the Admin REST API (service role key),
// then upserts a user_profiles row. No email confirmation needed.
async function createMemberAccount(params: {
  email: string; password: string; full_name: string;
  role: "admin" | "shareholder" | "client" | "investor"; member_id: number | null;
}): Promise<string> {
  // Save the current admin session so we can restore it after signUp
  // (signUp auto-signs-in the new user if email confirm is disabled, replacing the admin session)
  const { data: { session: adminSession } } = await supabase.auth.getSession();

  const { data, error } = await supabase.auth.signUp({
    email: params.email,
    password: params.password,
    options: { data: { full_name: params.full_name } },
  });

  let userId: string;
  if (error) {
    const msg = error.message.toLowerCase();
    if (msg.includes("already registered")) {
      const { data: existing } = await supabase
        .from("user_profiles").select("id").eq("email", params.email).maybeSingle();
      if (!existing) throw new Error("Account already exists but profile not found.");
      userId = existing.id;
    } else if (msg.includes("confirm")) {
      throw new Error(
        "Email confirmation is ON. Go to Supabase → Authentication → Providers → Email → disable \"Confirm email\"."
      );
    } else {
      throw new Error(error.message);
    }
  } else {
    if (!data.user) throw new Error("Account creation failed.");
    userId = data.user.id;
  }

  // Restore admin session immediately before any further DB calls
  if (adminSession) {
    await supabase.auth.setSession({
      access_token: adminSession.access_token,
      refresh_token: adminSession.refresh_token,
    });
  }

  await supabase.from("user_profiles").upsert({
    id: userId,
    role: params.role,
    member_id: params.member_id,
    full_name: params.full_name,
    email: params.email,
    is_active: true,
    password_changed: params.role === "admin",
  }, { onConflict: "id", ignoreDuplicates: true });

  return userId;
}

export function UserManagementPage() {
  const [accounts, setAccounts]     = useState<UserAccount[]>([]);
  const [loading, setLoading]       = useState(true);
  const [showAdd, setShowAdd]       = useState(false);
  const [provisioning, setProvisioning] = useState(false);
  const [result, setResult]         = useState<{ type: "success" | "error"; msg: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await supabase.from("user_profiles").select("*").order("created_at", { ascending: false });
      setAccounts(data ?? []);
    } catch { setAccounts([]); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const deactivate = async (id: string, active: boolean) => {
    await supabase.from("user_profiles").update({ is_active: !active }).eq("id", id);
    const acc = accounts.find((a) => a.id === id);
    logActivity({ category: "system", action: "update", description: `User account "${acc?.full_name ?? id}" ${active ? "deactivated" : "activated"}`, meta: { user_id: id } });
    load();
  };

  const remove = (id: string) => setDeleteTarget(id);

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const acc = accounts.find((a) => a.id === deleteTarget);
    await supabase.from("user_profiles").delete().eq("id", deleteTarget);
    logActivity({ category: "system", action: "delete", description: `User account "${acc?.full_name ?? deleteTarget}" deleted`, meta: { user_id: deleteTarget } });
    setDeleteTarget(null);
    load();
  };

  // Bulk provision: create accounts for all members who don't have one yet
  const bulkProvision = async () => {
    setProvisioning(true);
    setResult(null);
    let created = 0, skipped = 0, failed = 0;
    try {
      const existingMemberIds = new Set(accounts.filter((a) => a.member_id).map((a) => a.member_id));

      const [shareholders, clients, investors] = await Promise.all([
        shareholdersApi.list(),
        clientsApi.list(),
        investorsApi.list(),
      ]);

      type MemberEntry = { id: number; name: string; phone: string; role: "shareholder" | "client" | "investor" };
      const allMembers: MemberEntry[] = [
        ...shareholders.map((s) => ({ id: s.id, name: s.name, phone: s.phone, role: "shareholder" as const })),
        ...clients.map((c)     => ({ id: c.id, name: c.name, phone: c.phone, role: "client" as const })),
        ...investors.map((i)   => ({ id: i.id, name: i.name, phone: i.phone, role: "investor" as const })),
      ];

      for (const m of allMembers) {
        if (existingMemberIds.has(m.id)) { skipped++; continue; }
        if (!m.phone?.trim()) { failed++; continue; }
        try {
          const email = phoneToEmail(m.phone);
          await createMemberAccount({
            email, password: DEFAULT_PASSWORD, full_name: m.name,
            role: m.role, member_id: m.id,
          });
          created++;
          existingMemberIds.add(m.id);
        } catch { failed++; }
      }
      setResult({ type: "success", msg: `Done — ${created} created, ${skipped} already had accounts, ${failed} failed.` });
      load();
    } catch (e: any) {
      setResult({ type: "error", msg: e.message });
    } finally {
      setProvisioning(false);
    }
  };

  return (
    <div className="h-full overflow-auto" style={{ background: "var(--background)" }}>
      <div className="max-w-3xl mx-auto p-4 md:p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-bold text-xl" style={{ color: "#1a202c" }}>User Accounts</h1>
            <p className="text-sm text-gray-400">Manage login access for members</p>
          </div>
          <div className="flex gap-2">
            <button onClick={bulkProvision} disabled={provisioning}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white disabled:opacity-60"
              style={{ background: "#14b8a6" }}>
              {provisioning ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {provisioning ? "Provisioning…" : "Bulk Create"}
            </button>
            <button onClick={() => setShowAdd(true)}
              className="flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-bold text-white"
              style={{ background: "#1e2d4a" }}>
              <Plus size={15} /> Add User
            </button>
          </div>
        </div>

        {/* Phone login info banner */}
        <div className="flex items-start gap-3 bg-indigo-50 border border-indigo-200 rounded-2xl px-4 py-3">
          <Phone size={15} className="text-indigo-500 mt-0.5 flex-shrink-0" />
          <div>
            <p className="text-xs font-bold text-indigo-800">Phone Login Enabled</p>
            <p className="text-xs text-indigo-600 mt-0.5">
              Members log in with their <strong>phone number</strong> (e.g. 0712 345 678) and default password <strong>123456</strong>.
              Admins log in with email. Use <strong>Bulk Create</strong> to auto-provision all existing members at once.
            </p>
          </div>
        </div>

        {result && (
          <div className={`flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium ${
            result.type === "success" ? "bg-green-50 text-green-700 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"
          }`}>
            {result.type === "success" ? <CheckCircle size={15} /> : <AlertCircle size={15} />}
            {result.msg}
            <button onClick={() => setResult(null)} className="ml-auto"><X size={14} /></button>
          </div>
        )}

        {/* Accounts list */}
        <div className="bg-white rounded-2xl border overflow-hidden" style={{ borderColor: "var(--border)" }}>
          <div className="px-4 py-3 border-b flex items-center justify-between" style={{ borderColor: "var(--border)", background: "#f8fafc" }}>
            <p className="text-xs font-bold uppercase tracking-wider text-gray-500">
              {accounts.length} Account{accounts.length !== 1 ? "s" : ""}
            </p>
            <div className="flex gap-2">
              {(Object.entries(ROLE_META) as [keyof typeof ROLE_META, typeof ROLE_META["admin"]][]).map(([role, meta]) => (
                <span key={role} className="flex items-center gap-1 px-2 py-1 rounded text-[10px] font-bold"
                  style={{ background: meta.bg, color: meta.color }}>
                  {meta.icon} {meta.label}
                </span>
              ))}
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={22} className="animate-spin text-gray-300" />
            </div>
          ) : accounts.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-sm text-gray-400">No user accounts yet.</p>
              <p className="text-xs text-gray-300 mt-1">Click "Bulk Create" to provision all members, or "Add User" for individual accounts.</p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {accounts.map((acc) => {
                const meta = ROLE_META[acc.role] ?? ROLE_META.admin;
                const isPhoneLogin = acc.email?.includes("@sacco.co.ke");
                const displayLogin = isPhoneLogin ? acc.email.replace("@sacco.co.ke", "") : acc.email;
                return (
                  <div key={acc.id} className="px-4 py-3 flex items-center gap-3">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                      style={{ background: meta.bg, color: meta.color }}>
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate" style={{ color: "#1a202c" }}>
                        {acc.full_name || displayLogin}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {isPhoneLogin
                          ? <Phone size={10} className="text-gray-400 flex-shrink-0" />
                          : null}
                        <p className="text-xs text-gray-400 truncate">{displayLogin}</p>
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full"
                          style={{ background: meta.bg, color: meta.color }}>
                          {meta.label}
                        </span>
                        {acc.member_id && <span className="text-[10px] text-gray-400">ID #{acc.member_id}</span>}
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                          acc.is_active !== false ? "bg-green-50 text-green-600" : "bg-gray-100 text-gray-400"
                        }`}>
                          {acc.is_active !== false ? "Active" : "Inactive"}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button onClick={() => deactivate(acc.id, acc.is_active !== false)}
                        title={acc.is_active !== false ? "Deactivate" : "Activate"}
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
                        <RefreshCw size={14} />
                      </button>
                      <button onClick={() => remove(acc.id)}
                        title="Delete account"
                        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 transition-colors">
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Instructions */}
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 space-y-2">
          <p className="text-xs font-bold text-amber-800 flex items-center gap-1.5">
            <KeyRound size={13} /> Setup Notes
          </p>
          <ul className="text-xs text-amber-700 space-y-1 list-disc list-inside">
            <li>Disable "Enable email confirmations" in Supabase → Authentication → Settings for instant access.</li>
            <li>Members login with their phone number. Default password is <strong>123456</strong>.</li>
            <li><strong>Bulk Create</strong> provisions accounts for all existing members at once.</li>
            <li>Admin accounts use email login (not phone).</li>
          </ul>
        </div>
      </div>

      {showAdd && (
        <AddUserModal
          onClose={() => setShowAdd(false)}
          onCreated={(msg) => { setResult({ type: "success", msg }); load(); }}
          onError={(msg) => setResult({ type: "error", msg })}
        />
      )}

      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xs overflow-hidden">
            <div className="px-5 py-4 border-b" style={{ background: "#fef2f2", borderColor: "#fecaca" }}>
              <p className="font-bold text-sm" style={{ color: "#b91c1c" }}>Delete User Account</p>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-gray-600">Delete this account? The member will no longer be able to log in. This cannot be undone.</p>
              <div className="flex gap-2">
                <button onClick={() => setDeleteTarget(null)}
                  className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
                  style={{ borderColor: "#e2e8f0" }}>Cancel</button>
                <button onClick={confirmDelete}
                  className="flex-1 py-2.5 rounded-xl font-bold text-white flex items-center justify-center gap-1.5"
                  style={{ background: "#ef4444" }}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Add User Modal ───────────────────────────────────────────────────────────

function AddUserModal({ onClose, onCreated, onError }: {
  onClose: () => void;
  onCreated: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [role, setRole]       = useState<"admin" | "shareholder" | "client" | "investor">("shareholder");
  const [memberId, setMemberId] = useState("");
  const [fullName, setFullName] = useState("");
  const [login, setLogin]     = useState("");       // phone or email
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [showPw, setShowPw]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState("");
  const [members, setMembers] = useState<{ id: number; name: string; member_number: number | string; phone: string }[]>([]);

  useEffect(() => { loadMembers(role); }, [role]);

  // When a member is selected, auto-fill login (phone) and name
  useEffect(() => {
    if (!memberId) return;
    const m = members.find((x) => String(x.id) === memberId);
    if (!m) return;
    setFullName(m.name);
    setLogin(m.phone ?? "");
  }, [memberId, members]);

  const loadMembers = async (r: string) => {
    if (r === "admin") { setMembers([]); return; }
    try {
      if (r === "shareholder") {
        const data = await shareholdersApi.list();
        setMembers(data.map((s) => ({ id: s.id, name: s.name, member_number: s.member_number, phone: s.phone })));
      } else if (r === "client") {
        const data = await clientsApi.list();
        setMembers(data.map((c) => ({ id: c.id, name: c.name, member_number: c.member_number, phone: c.phone })));
      } else if (r === "investor") {
        const data = await investorsApi.list();
        setMembers(data.map((i) => ({ id: i.id, name: i.name, member_number: i.member_number, phone: i.phone })));
      }
    } catch { setMembers([]); }
  };

  const submit = async () => {
    setErr("");
    if (!login.trim()) { setErr("Phone or email is required"); return; }
    if (password.length < 6) { setErr("Password must be at least 6 characters"); return; }
    if (role !== "admin" && !memberId) { setErr("Select a linked member"); return; }

    setSaving(true);
    try {
      const email = toSupabaseEmail(login);
      const displayName = fullName.trim() || login.trim();
      await createMemberAccount({
        email, password,
        full_name: displayName,
        role,
        member_id: memberId ? Number(memberId) : null,
      });
      logActivity({ category: "system", action: "create", description: `User account created for "${displayName}" (${role})`, meta: { role } });
      onCreated(`Account created — login: ${login.trim()}, password: ${password}`);
      onClose();
    } catch (e: any) {
      setErr(e.message);
      onError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const inp = "w-full px-3 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-indigo-200 bg-white";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
        <div className="px-5 py-4 flex items-center justify-between border-b"
          style={{ background: "#f8fafc", borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <Plus size={16} color="#1e2d4a" />
            <span className="font-bold text-sm" style={{ color: "#1a202c" }}>Create User Account</span>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Role */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Role *</label>
            <select className={inp} style={{ borderColor: "var(--border)" }}
              value={role} onChange={(e) => { setRole(e.target.value as any); setMemberId(""); setLogin(""); setFullName(""); }}>
              <option value="admin">Admin — Full access</option>
              <option value="shareholder">Shareholder — Personal portal</option>
              <option value="client">Client — Personal portal</option>
              <option value="investor">Investor — Personal portal</option>
            </select>
          </div>

          {/* Member link */}
          {role !== "admin" && (
            <div>
              <label className="text-xs font-semibold text-gray-500 mb-1 block">
                Link to {ROLE_META[role]?.label} *
              </label>
              <select className={inp} style={{ borderColor: "var(--border)" }}
                value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">— Select member —</option>
                {members.map((m) => (
                  <option key={m.id} value={String(m.id)}>
                    #{m.member_number} — {m.name} ({m.phone})
                  </option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">Full Name</label>
            <input className={inp} style={{ borderColor: "var(--border)" }}
              value={fullName} onChange={(e) => setFullName(e.target.value)}
              placeholder="Auto-filled from member selection" />
          </div>

          {/* Login identifier */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">
              Phone or Email (login username) *
            </label>
            <div className="relative">
              <input className={inp} style={{ borderColor: "var(--border)" }}
                value={login} onChange={(e) => setLogin(e.target.value)}
                placeholder="0712 345 678 or email@example.com" />
              {login && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-1.5 py-0.5 rounded"
                  style={login.includes("@") ? { background: "#eff6ff", color: "#3b82f6" } : { background: "#f0fdf4", color: "#16a34a" }}>
                  {login.includes("@") ? "Email" : "Phone"}
                </span>
              )}
            </div>
            {login && !login.includes("@") && (
              <p className="text-[10px] text-gray-400 mt-1">
                Stored as: {phoneToEmail(login)}
              </p>
            )}
          </div>

          {/* Password */}
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1 block">
              Password * <span className="text-gray-300 font-normal">(default: 123456)</span>
            </label>
            <div className="relative">
              <input type={showPw ? "text" : "password"} className={`${inp} pr-9`} style={{ borderColor: "var(--border)" }}
                value={password} onChange={(e) => setPassword(e.target.value)} />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400">
                {showPw ? <EyeOff size={13} /> : <Eye size={13} />}
              </button>
            </div>
          </div>

          {err && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-3 py-2.5 text-xs text-red-600 font-medium">
              {err}
            </div>
          )}
        </div>

        <div className="px-5 py-4 border-t flex gap-3" style={{ borderColor: "var(--border)" }}>
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl border text-sm font-semibold text-gray-500 hover:bg-gray-50"
            style={{ borderColor: "var(--border)" }}>Cancel</button>
          <button onClick={submit} disabled={saving}
            className="flex-1 py-2.5 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-50"
            style={{ background: "#1e2d4a" }}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            {saving ? "Creating…" : "Create Account"}
          </button>
        </div>
      </div>
    </div>
  );
}
