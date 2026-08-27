import { useState, useEffect } from "react";
import { supabase } from "@/lib/supabase";
import {
  Eye, EyeOff, Loader2, Lock, Phone, MapPin, Mail, Globe,
  CheckCircle, ArrowLeft, User, KeyRound,
} from "lucide-react";
import { getCompanyDetails, type CompanyDetails } from "@/lib/company";

export interface UserProfile {
  id: string;
  role: "admin" | "shareholder" | "client" | "investor" | "reception";
  member_id: number | null;
  full_name: string;
  email: string;
  password_changed: boolean;
  allowed_modules?: string[];
}

// ─── Phone ↔ email helpers ────────────────────────────────────────────────────

export const SACCO_DOMAIN = "sacco.co.ke";

export function phoneToEmail(phone: string): string {
  let digits = phone.trim().replace(/[\s\-()]/g, "");
  if (digits.startsWith("+254")) digits = "0" + digits.slice(4);
  else if (digits.startsWith("254") && digits.length <= 13) digits = "0" + digits.slice(3);
  // For non-Kenyan international numbers: strip leading + so the email local-part is valid
  digits = digits.replace(/^\+/, "");
  return `${digits}@${SACCO_DOMAIN}`;
}

export function isPhoneInput(value: string): boolean {
  return /^[0+]/.test(value.trim()) && !value.includes("@");
}

export function toSupabaseEmail(input: string): string {
  return isPhoneInput(input) ? phoneToEmail(input) : input.trim();
}

// ─── Fetch profile ────────────────────────────────────────────────────────────

export async function fetchProfile(userId: string, email: string): Promise<UserProfile | null> {
  const { data } = await supabase.from("user_profiles").select("*").eq("id", userId).maybeSingle();
  if (!data) return null;
  return { ...data, email };
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function phoneVariants(raw: string): string[] {
  const s = raw.trim().replace(/[\s\-()]/g, "");
  const set = new Set<string>([s]);
  if (s.startsWith("0") && s.length === 10) {
    set.add("+254" + s.slice(1));
    set.add("254" + s.slice(1));
  } else if (s.startsWith("+254")) {
    set.add("0" + s.slice(4));
    set.add("254" + s.slice(4));
  } else if (s.startsWith("254") && s.length === 12) {
    set.add("0" + s.slice(3));
    set.add("+" + s);
  }
  return [...set];
}

async function findMemberByPhone(phone: string): Promise<{
  id: number; name: string; role: "shareholder" | "client" | "investor";
} | null> {
  const variants = phoneVariants(phone);
  const [{ data: sh }, { data: cl }, { data: inv }] = await Promise.all([
    supabase.from("shareholders").select("id,name").in("phone", variants).limit(1),
    supabase.from("clients").select("id,name").in("phone", variants).limit(1),
    supabase.from("investors").select("id,name").in("phone", variants).limit(1),
  ]);
  if (sh?.[0]) return { ...sh[0], role: "shareholder" };
  if (cl?.[0]) return { ...cl[0], role: "client" };
  if (inv?.[0]) return { ...inv[0], role: "investor" };
  return null;
}

async function checkAdminByEmail(email: string): Promise<boolean> {
  const { data } = await supabase
    .from("user_profiles")
    .select("id")
    .eq("email", email.trim().toLowerCase())
    .maybeSingle();
  return !!data;
}

async function findMemberByEmail(email: string): Promise<{
  id: number; name: string; phone: string; role: "shareholder" | "client" | "investor";
} | null> {
  const e = email.trim().toLowerCase();
  const [{ data: sh }, { data: cl }, { data: inv }] = await Promise.all([
    supabase.from("shareholders").select("id,name,phone").eq("email", e).limit(1),
    supabase.from("clients").select("id,name,phone").eq("email", e).limit(1),
    supabase.from("investors").select("id,name,phone").eq("email", e).limit(1),
  ]);
  if (sh?.[0]) return { ...sh[0], phone: sh[0].phone ?? "", role: "shareholder" };
  if (cl?.[0]) return { ...cl[0], phone: cl[0].phone ?? "", role: "client" };
  if (inv?.[0]) return { ...inv[0], phone: inv[0].phone ?? "", role: "investor" };
  return null;
}

// ─── Step types ───────────────────────────────────────────────────────────────

type Step =
  | { kind: "identifier" }
  | { kind: "set-password";   email: string; name: string; role: "shareholder" | "client" | "investor"; memberId: number }
  | { kind: "enter-password"; email: string; name: string; role: "admin" | "shareholder" | "client" | "investor" };

// ─── Brand panel ──────────────────────────────────────────────────────────────

function BrandPanel({ company }: { company: CompanyDetails | null }) {
  const name = company?.name || "Egemeo Ardhi SACCO";
  return (
    <div className="hidden md:flex w-72 flex-col items-center justify-center px-8 py-10 flex-shrink-0 relative overflow-hidden"
      style={{ background: "linear-gradient(160deg, #312e81 0%, #4338ca 50%, #6366f1 100%)" }}>
      <div className="absolute -top-12 -right-12 w-44 h-44 rounded-full" style={{ background: "rgba(255,255,255,0.07)" }} />
      <div className="absolute -bottom-10 -left-10 w-36 h-36 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }} />
      <div className="relative z-10 flex flex-col items-center text-center w-full">
        {company?.logo_data_url ? (
          <div className="w-28 h-28 rounded-3xl overflow-hidden flex items-center justify-center mb-5 shadow-2xl"
            style={{ background: "rgba(255,255,255,0.12)" }}>
            <img src={company.logo_data_url} alt={name} className="w-full h-full object-contain p-2" />
          </div>
        ) : (
          <div className="w-28 h-28 rounded-3xl flex items-center justify-center mb-5 shadow-2xl"
            style={{ background: "rgba(255,255,255,0.12)" }}>
            <svg viewBox="0 0 24 24" className="w-14 h-14 fill-white" style={{ opacity: 0.9 }}>
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" opacity=".6"/>
              <path d="M9 22V12h6v10"/>
            </svg>
          </div>
        )}
        <h2 className="text-lg font-bold text-white leading-tight mb-1 px-2">{name}</h2>
        <p className="text-sm font-medium mb-6" style={{ color: "rgba(255,255,255,0.6)" }}>Sacco Management System</p>
        {(company?.location || company?.phone || company?.email || company?.website) && (
          <div className="w-full text-left mx-[50px] my-[0px] px-[20px] py-[0px]">
            {company?.location && <Row icon={<MapPin size={11}/>} text={company.location} />}
            {company?.phone    && <Row icon={<Phone size={11}/>}   text={company.phone} />}
            {company?.email    && <Row icon={<Mail size={11}/>}    text={company.email} />}
            {company?.website  && <Row icon={<Globe size={11}/>}   text={company.website} />}
          </div>
        )}
      </div>
      <p className="absolute bottom-4 text-[10px]" style={{ color: "rgba(255,255,255,0.25)" }}>
        © {new Date().getFullYear()} {name}
      </p>
    </div>
  );
}

function Row({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs" style={{ color: "rgba(255,255,255,0.65)" }}>
      <span className="flex-shrink-0">{icon}</span>
      <span className="truncate">{text}</span>
    </div>
  );
}

// ─── Shared input style ───────────────────────────────────────────────────────

const inputCls = "w-full py-3 border rounded-xl text-sm focus:outline-none transition-all";
const inputStyle: React.CSSProperties = { borderColor: "#e2e8f0" };
const onFocus = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = "#6366f1";
  e.target.style.boxShadow = "0 0 0 3px rgba(99,102,241,0.12)";
};
const onBlur = (e: React.FocusEvent<HTMLInputElement>) => {
  e.target.style.borderColor = "#e2e8f0";
  e.target.style.boxShadow = "none";
};

function MobileBrandHeader({ company }: { company: CompanyDetails | null }) {
  const name = company?.name || "Egemeo Ardhi SACCO";
  return (
    <div className="md:hidden flex flex-col items-center justify-center py-8 px-6 relative overflow-hidden"
      style={{ background: "linear-gradient(160deg, #312e81 0%, #4338ca 55%, #6366f1 100%)" }}>
      <div className="absolute -top-8 -right-8 w-32 h-32 rounded-full" style={{ background: "rgba(255,255,255,0.07)" }} />
      <div className="absolute -bottom-6 -left-6 w-24 h-24 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }} />
      <div className="relative z-10 flex flex-col items-center text-center">
        {company?.logo_data_url ? (
          <div className="w-20 h-20 rounded-2xl overflow-hidden flex items-center justify-center mb-3 shadow-xl"
            style={{ background: "rgba(255,255,255,0.15)" }}>
            <img src={company.logo_data_url} alt={name} className="w-full h-full object-contain p-2" />
          </div>
        ) : (
          <div className="w-20 h-20 rounded-2xl flex items-center justify-center mb-3 shadow-xl"
            style={{ background: "rgba(255,255,255,0.15)" }}>
            <svg viewBox="0 0 24 24" className="w-10 h-10 fill-white" style={{ opacity: 0.9 }}>
              <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" opacity=".6"/>
              <path d="M9 22V12h6v10"/>
            </svg>
          </div>
        )}
        <h2 className="text-lg font-bold text-white leading-tight">{name}</h2>
      </div>
    </div>
  );
}

function PageWrap({ children, company }: { children: React.ReactNode; company: CompanyDetails | null }) {
  return (
    <div className="min-h-screen md:flex md:items-center md:justify-center md:p-4 relative"
      style={{ background: "linear-gradient(145deg, #e8f0fe 0%, #f0f4ff 40%, #e8f5f0 100%)" }}>
      {/* Mobile-only: blue pattern fills entire page background */}
      <div className="md:hidden absolute inset-0 pointer-events-none overflow-hidden"
        style={{ background: "linear-gradient(160deg, #312e81 0%, #4338ca 55%, #6366f1 100%)" }}>
        <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full" style={{ background: "rgba(255,255,255,0.07)" }} />
        <div className="absolute top-1/3 -left-12 w-36 h-36 rounded-full" style={{ background: "rgba(255,255,255,0.05)" }} />
        <div className="absolute bottom-10 right-6 w-28 h-28 rounded-full" style={{ background: "rgba(255,255,255,0.06)" }} />
        <div className="absolute -bottom-8 -left-8 w-44 h-44 rounded-full" style={{ background: "rgba(255,255,255,0.04)" }} />
        <div className="absolute bottom-1/4 left-1/2 w-20 h-20 rounded-full" style={{ background: "rgba(255,255,255,0.03)" }} />
      </div>
      {/* Desktop-only decorative blobs */}
      <div className="hidden md:block absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-0 right-0 w-[520px] h-[520px] rounded-full opacity-40"
          style={{ background: "radial-gradient(circle, #c7d7fb 0%, transparent 70%)", transform: "translate(30%,-30%)" }} />
        <div className="absolute bottom-0 left-0 w-[400px] h-[400px] rounded-full opacity-25"
          style={{ background: "radial-gradient(circle, #a7f3d0 0%, transparent 70%)", transform: "translate(-30%,30%)" }} />
      </div>
      <div className="relative w-full md:max-w-3xl md:bg-white md:rounded-3xl md:shadow-2xl overflow-hidden flex flex-col md:flex-row" style={{ minHeight: 500 }}>
        <MobileBrandHeader company={company} />
        <div className="flex-1 px-8 md:px-10 py-8 md:py-10 flex flex-col justify-center min-w-0 bg-white">
          {children}
        </div>
        <BrandPanel company={company} />
      </div>
    </div>
  );
}

function ErrorBox({ msg }: { msg: string }) {
  return (
    <div className="px-3.5 py-2.5 rounded-xl text-xs font-medium"
      style={{ background: "#fff1f2", color: "#e11d48", border: "1px solid #fecdd3" }}>
      {msg}
    </div>
  );
}

// ─── Step 1 — identifier ──────────────────────────────────────────────────────

function IdentifierStep({ onNext, company }: {
  onNext: (step: Step) => void;
  company: CompanyDetails | null;
}) {
  const [value, setValue]     = useState("");
  const [loading, setLoading] = useState(false);
  const [status, setStatus]   = useState("");
  const [err, setErr]         = useState("");
  const isPhone = isPhoneInput(value);

  const next = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value.trim()) { setErr("Enter your phone number or email"); return; }
    setLoading(true); setErr(""); setStatus("");

    try {
      if (isPhone) {
        const digits = value.trim().replace(/[\s\-()]/g, "");
        // Basic sanity check: must be a plausible phone (digits + optional leading +/0)
        if (!/^\+?\d{7,15}$/.test(digits)) {
          throw new Error("Enter a valid phone number (e.g. 0712 345 678)");
        }

        // 1. Look up in member tables first
        setStatus("Looking for your account…");
        const member = await findMemberByPhone(value);
        if (!member) {
          throw new Error("Phone number not registered. Contact your administrator.");
        }

        // 2. Look up user_profiles — primary by member_id, fallback by email.
        // The fallback handles: RLS blocking unauthenticated reads, member_id type
        // mismatches, or cases where member_id wasn't persisted on earlier logins.
        const derivedEmail = phoneToEmail(value);

        const { data: profileByMemberId } = await supabase
          .from("user_profiles")
          .select("member_id, full_name, role, is_active, email")
          .eq("member_id", member.id)
          .maybeSingle();

        const { data: profileByEmail } = profileByMemberId
          ? { data: null }
          : await supabase
              .from("user_profiles")
              .select("member_id, full_name, role, is_active, email")
              .eq("email", derivedEmail)
              .maybeSingle();

        const existingProfile = profileByMemberId ?? profileByEmail;

        if (existingProfile) {
          if (existingProfile.is_active === false)
            throw new Error("This account has been deactivated. Contact your administrator.");
          // Use the email on file so login works even after a phone number change
          onNext({ kind: "enter-password", email: existingProfile.email, name: existingProfile.full_name || member.name, role: existingProfile.role as any });
          return;
        }

        // 3. Genuinely first time — let them set their own password
        onNext({ kind: "set-password", email: derivedEmail, name: member.name, role: member.role, memberId: member.id });

      } else {
        // Email — check user_profiles first (covers any returning user: admin, member with real email)
        const email = value.trim().toLowerCase();
        setStatus("Looking for your account…");

        const { data: profileByEmail } = await supabase
          .from("user_profiles")
          .select("id, member_id, full_name, role, is_active, email")
          .eq("email", email)
          .maybeSingle();

        if (profileByEmail) {
          if (profileByEmail.is_active === false)
            throw new Error("This account has been deactivated. Contact your administrator.");
          onNext({ kind: "enter-password", email: profileByEmail.email, name: profileByEmail.full_name || "", role: profileByEmail.role as any });
          return;
        }

        // Not in user_profiles by real email — check if a member record has this email
        const member = await findMemberByEmail(email);
        if (member) {
          // Member found — look up their profile via member_id, with phone-email fallback
          // (RLS may block member_id lookup when unauthenticated)
          const { data: profileByMemberId } = await supabase
            .from("user_profiles")
            .select("id, full_name, role, is_active, email")
            .eq("member_id", member.id)
            .maybeSingle();

          // Fallback: if RLS blocked the member_id lookup, try the phone-derived email
          const { data: profileByPhone } = (!profileByMemberId && member.phone)
            ? await supabase
                .from("user_profiles")
                .select("id, full_name, role, is_active, email")
                .eq("email", phoneToEmail(member.phone))
                .maybeSingle()
            : { data: null };

          const existingProfile = profileByMemberId ?? profileByPhone;

          if (existingProfile) {
            // Already registered (with phone or otherwise) — use their existing auth email
            if (existingProfile.is_active === false)
              throw new Error("This account has been deactivated. Contact your administrator.");
            onNext({ kind: "enter-password", email: existingProfile.email, name: existingProfile.full_name || member.name, role: existingProfile.role as any });
            return;
          }

          // Genuinely first time — set up with their real email
          onNext({ kind: "set-password", email, name: member.name, role: member.role, memberId: member.id });
          return;
        }

        throw new Error("No account found for this email. Contact your administrator.");
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
      setStatus("");
    }
  };

  return (
    <PageWrap company={company}>
      <div className="max-w-sm mx-auto w-full">
        <h1 className="text-2xl font-bold mb-1" style={{ color: "#1a202c" }}>Welcome</h1>
        <p className="text-sm text-gray-400 mb-7">Enter your phone number or email to continue</p>

        <form onSubmit={next} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Phone Number or Email</label>
            <div className="relative">
              <Phone size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
              <input
                type="text" autoFocus
                value={value} onChange={(e) => { setValue(e.target.value); setErr(""); }}
                placeholder="0712 345 678 / +1 206 578 1062  or  admin@email.com"
                autoComplete="username"
                className={`${inputCls} pl-10 pr-14`} style={inputStyle}
                onFocus={onFocus} onBlur={onBlur}
              />
              {value.trim() && (
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] font-bold px-2 py-0.5 rounded-full"
                  style={isPhone
                    ? { background: "#dcfce7", color: "#16a34a" }
                    : { background: "#e0e7ff", color: "#4338ca" }}>
                  {isPhone ? "Phone" : "Email"}
                </span>
              )}
            </div>
          </div>

          {status && (
            <div className="flex items-center gap-2 text-xs text-indigo-600 font-medium">
              <Loader2 size={12} className="animate-spin" /> {status}
            </div>
          )}
          {err && <ErrorBox msg={err} />}

          <button type="submit" disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-90 transition-opacity"
            style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : null}
            {loading ? "Please wait…" : "Continue"}
          </button>
        </form>

        <div className="text-center mt-6 space-y-1.5">
          <p className="text-[11px] font-medium" style={{ color: "#1a202c" }}>
            Sign in with your registered phone number or email address.
          </p>
          {company?.phone ? (
            <a
              href={`https://wa.me/${company.phone.trim().replace(/[\s\-()]/g, "").replace(/^0/, "254").replace(/^\+/, "")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11px] font-semibold underline underline-offset-2 hover:opacity-80 transition-opacity"
              style={{ color: "#25d366" }}
            >
              Contact Admin for Help
            </a>
          ) : null}
        </div>
      </div>
    </PageWrap>
  );
}

// ─── Step 2a — set password (first-ever login) ────────────────────────────────

function SetPasswordStep({ step, onBack, onLoggedIn, onAlreadyHasAccount, company }: {
  step: Extract<Step, { kind: "set-password" }>;
  onBack: () => void;
  onLoggedIn: (session: any, profile: UserProfile) => void;
  onAlreadyHasAccount: () => void;
  company: CompanyDetails | null;
}) {
  const [pw, setPw]           = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState("");
  const [done, setDone]       = useState(false);

  const firstName = step.name.split(" ")[0] || "there";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 6)  { setErr("Password must be at least 6 characters"); return; }
    if (pw !== confirm) { setErr("Passwords do not match"); return; }
    setSaving(true); setErr("");

    try {
      // Create the Supabase auth account with the user's chosen password
      const { data: signUpData, error: signUpErr } = await supabase.auth.signUp({
        email: step.email,
        password: pw,
        options: { data: { full_name: step.name } },
      });

      if (signUpErr) {
        const msg = signUpErr.message.toLowerCase();
        if (msg.includes("already registered") || msg.includes("user already registered")) {
          // Account already exists — redirect to sign-in
          onAlreadyHasAccount();
          return;
        }
        if (msg.includes("confirm")) {
          throw new Error(
            "Email confirmation is enabled in your Supabase project. " +
            "Go to: Authentication → Providers → Email → turn OFF \"Confirm email\"."
          );
        }
        throw new Error(signUpErr.message);
      }

      if (!signUpData.user) throw new Error("Account creation failed. Please try again.");

      // Sign in with the chosen password
      const { data: siData, error: siErr } = await supabase.auth.signInWithPassword({
        email: step.email,
        password: pw,
      });
      if (siErr) throw new Error(siErr.message);
      if (!siData.session) throw new Error("Sign-in failed. Please try again.");

      // Create / update user profile
      const { error: upsertErr } = await supabase.from("user_profiles").upsert({
        id: siData.session.user.id,
        role: step.role,
        member_id: step.memberId,
        full_name: step.name,
        email: step.email,
        is_active: true,
        password_changed: true,
      }, { onConflict: "id", ignoreDuplicates: false });
      // Log upsert failures — they cause repeat "first-time login" on next sign-in
      if (upsertErr) console.warn("[auth] profile upsert failed:", upsertErr.message);

      setDone(true);
      await new Promise((r) => setTimeout(r, 800));

      const profile = await fetchProfile(siData.session.user.id, step.email);
      if (!profile) throw new Error("Profile not found after setup. Contact your administrator.");
      onLoggedIn(siData.session, profile);
    } catch (e: any) {
      setErr(e.message);
      setDone(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageWrap company={company}>
      <div className="max-w-sm mx-auto w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 mb-6 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>

        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5 text-xl font-bold text-white"
          style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
          {step.name ? step.name.charAt(0).toUpperCase() : <KeyRound size={22} />}
        </div>

        {done ? (
          <>
            <h1 className="text-2xl font-bold mb-1" style={{ color: "#1a202c" }}>All set!</h1>
            <p className="text-sm text-gray-400 mb-6">Entering your dashboard…</p>
            <div className="flex flex-col items-center py-6 gap-3">
              <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
                <CheckCircle size={28} className="text-green-500" />
              </div>
            </div>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-bold mb-1" style={{ color: "#1a202c" }}>Hi, {firstName}!</h1>
            <p className="text-sm text-gray-400 mb-1">
              Account found. Create a password to access your account.
            </p>
            <p className="text-[11px] font-semibold mb-6 px-2 py-1.5 rounded-xl inline-block"
              style={{ background: "#eff6ff", color: "#4338ca" }}>
              First-time login — choose a password you'll remember
            </p>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Create Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                  <input type={showPw ? "text" : "password"} autoFocus
                    value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }}
                    placeholder="At least 6 characters"
                    className={`${inputCls} pl-10 pr-10`} style={inputStyle}
                    onFocus={onFocus} onBlur={onBlur}
                  />
                  <button type="button" onClick={() => setShowPw((v) => !v)}
                    className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                    {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
                {pw.length > 0 && (
                  <div className="flex gap-1 mt-2">
                    {[6, 8, 10, 14].map((threshold, i) => (
                      <div key={i} className="h-1 flex-1 rounded-full transition-colors"
                        style={{ background: pw.length >= threshold ? ["#f97316","#eab308","#22c55e","#16a34a"][i] : "#e2e8f0" }} />
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Confirm Password</label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                  <input type={showPw ? "text" : "password"}
                    value={confirm} onChange={(e) => { setConfirm(e.target.value); setErr(""); }}
                    placeholder="Repeat your password"
                    className={`${inputCls} pl-10 pr-10`}
                    style={{ ...inputStyle, borderColor: confirm && confirm === pw ? "#22c55e" : "#e2e8f0" }}
                    onFocus={onFocus} onBlur={onBlur}
                  />
                  {confirm && confirm === pw && (
                    <CheckCircle size={15} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-green-500" />
                  )}
                </div>
              </div>

              {err && <ErrorBox msg={err} />}

              <button type="submit" disabled={saving || pw.length < 6 || pw !== confirm}
                className="w-full py-3 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-90 transition-opacity"
                style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Lock size={15} />}
                {saving ? "Creating account…" : "Create Account & Sign In"}
              </button>
            </form>
          </>
        )}
      </div>
    </PageWrap>
  );
}

// ─── Step 2b — enter password (returning user) ───────────────────────────────

function EnterPasswordStep({ step, onBack, onLoggedIn, company }: {
  step: Extract<Step, { kind: "enter-password" }>;
  onBack: () => void;
  onLoggedIn: (session: any, profile: UserProfile) => void;
  company: CompanyDetails | null;
}) {
  const [pw, setPw]           = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState("");

  const firstName = step.name ? step.name.split(" ")[0] : step.email;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pw) { setErr("Enter your password"); return; }
    setLoading(true); setErr("");
    try {
      const { data, error } = await supabase.auth.signInWithPassword({ email: step.email, password: pw });
      if (error) throw new Error(error.message);

      const profile = await fetchProfile(data.session!.user.id, step.email);
      if (!profile) throw new Error("Account not configured. Contact your administrator.");

      onLoggedIn(data.session, profile);
    } catch (e: any) {
      const msg = e.message?.toLowerCase() ?? "";
      if (msg.includes("invalid login credentials")) {
        setErr("Incorrect password. Please try again.");
      } else {
        setErr(e.message);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <PageWrap company={company}>
      <div className="max-w-sm mx-auto w-full">
        <button onClick={onBack} className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-gray-600 mb-6 transition-colors">
          <ArrowLeft size={13} /> Back
        </button>

        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mb-5 text-xl font-bold text-white"
          style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
          {step.name ? step.name.charAt(0).toUpperCase() : <User size={22} />}
        </div>

        <h1 className="text-2xl font-bold mb-1" style={{ color: "#1a202c" }}>
          Welcome back{step.name ? `, ${firstName}` : ""}!
        </h1>
        <p className="text-sm text-gray-400 mb-1">
          {step.role === "admin" ? step.email : step.email.replace(`@${SACCO_DOMAIN}`, "")}
        </p>
        <p className="text-xs font-semibold capitalize mb-7 px-2 py-1 rounded-full inline-block"
          style={{ background: "#eff6ff", color: "#4338ca" }}>
          {step.role}
        </p>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="text-xs font-semibold text-gray-500 mb-1.5 block">Password</label>
            <div className="relative">
              <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
              <input type={showPw ? "text" : "password"} autoFocus
                value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }}
                placeholder="••••••••"
                autoComplete="current-password"
                className={`${inputCls} pl-10 pr-10`} style={inputStyle}
                onFocus={onFocus} onBlur={onBlur}
              />
              <button type="button" onClick={() => setShowPw((v) => !v)}
                className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>

          {err && <ErrorBox msg={err} />}

          <button type="submit" disabled={loading}
            className="w-full py-3 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60 hover:opacity-90 transition-opacity"
            style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
            {loading ? <Loader2 size={15} className="animate-spin" /> : null}
            {loading ? "Signing in…" : "Sign In"}
          </button>
        </form>
      </div>
    </PageWrap>
  );
}

// ─── Main LoginPage ───────────────────────────────────────────────────────────

export function LoginPage({ onLoggedIn }: { onLoggedIn: (session: any, profile: UserProfile) => void }) {
  const [step, setStep]       = useState<Step>({ kind: "identifier" });
  const [company, setCompany] = useState<CompanyDetails | null>(null);

  useEffect(() => { getCompanyDetails().then(setCompany); }, []);

  if (step.kind === "identifier") {
    return <IdentifierStep onNext={setStep} company={company} />;
  }
  if (step.kind === "set-password") {
    return (
      <SetPasswordStep
        step={step}
        onBack={() => setStep({ kind: "identifier" })}
        onLoggedIn={onLoggedIn}
        onAlreadyHasAccount={() => setStep({ kind: "enter-password", email: step.email, name: step.name, role: step.role })}
        company={company}
      />
    );
  }
  return (
    <EnterPasswordStep
      step={step}
      onBack={() => setStep({ kind: "identifier" })}
      onLoggedIn={onLoggedIn}
      company={company}
    />
  );
}

// ─── SetPasswordPage (post-login fallback) ────────────────────────────────────

export function SetPasswordPage({ profile, onComplete }: {
  profile: UserProfile; onComplete: () => void;
}) {
  const [pw, setPw]           = useState("");
  const [confirm, setConfirm] = useState("");
  const [showPw, setShowPw]   = useState(false);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState("");
  const [done, setDone]       = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 6)  { setErr("Password must be at least 6 characters"); return; }
    if (pw !== confirm) { setErr("Passwords do not match"); return; }
    setSaving(true); setErr("");
    try {
      const { error } = await supabase.auth.updateUser({ password: pw });
      if (error) throw new Error(error.message);
      await supabase.from("user_profiles").update({ password_changed: true }).eq("id", profile.id);
      setDone(true);
      setTimeout(onComplete, 1200);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  const firstName = profile.full_name?.split(" ")[0] || "there";

  return (
    <div className="min-h-screen flex items-center justify-center p-4"
      style={{ background: "linear-gradient(145deg, #e8f0fe 0%, #f0f4ff 40%, #e8f5f0 100%)" }}>
      <div className="relative w-full max-w-sm bg-white rounded-3xl shadow-2xl p-8">
        {done ? (
          <div className="flex flex-col items-center py-6 gap-3 text-center">
            <div className="w-14 h-14 rounded-full bg-green-100 flex items-center justify-center">
              <CheckCircle size={28} className="text-green-500" />
            </div>
            <p className="font-bold text-lg" style={{ color: "#1a202c" }}>Password saved!</p>
            <p className="text-sm text-gray-400">Entering your dashboard…</p>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold mb-1" style={{ color: "#1a202c" }}>Set your password, {firstName}</h1>
            <p className="text-sm text-gray-400 mb-5">Choose a personal password to secure your account.</p>
            <form onSubmit={submit} className="space-y-4">
              <div className="relative">
                <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                <input type={showPw ? "text" : "password"} autoFocus
                  value={pw} onChange={(e) => { setPw(e.target.value); setErr(""); }}
                  placeholder="New password (min 6 chars)"
                  className={`${inputCls} pl-10 pr-10`} style={inputStyle}
                  onFocus={onFocus} onBlur={onBlur}
                />
                <button type="button" onClick={() => setShowPw((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500">
                  {showPw ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <div className="relative">
                <Lock size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-gray-300 pointer-events-none" />
                <input type={showPw ? "text" : "password"}
                  value={confirm} onChange={(e) => { setConfirm(e.target.value); setErr(""); }}
                  placeholder="Confirm password"
                  className={`${inputCls} pl-10`} style={inputStyle}
                  onFocus={onFocus} onBlur={onBlur}
                />
              </div>
              {err && <ErrorBox msg={err} />}
              <button type="submit" disabled={saving}
                className="w-full py-3 rounded-xl text-sm font-bold text-white flex items-center justify-center gap-2 disabled:opacity-60"
                style={{ background: "linear-gradient(135deg, #4338ca, #6366f1)" }}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : null}
                {saving ? "Saving…" : "Save Password & Continue"}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
