// ─── admin-reset-password ─────────────────────────────────────────────────────
//
// Two ways to change a password — both are authorised on the server:
//
// 1. Signed-in caller   POST { userId, newPassword }
//    Allowed only for an admin, or for a user changing their own password.
//
// 2. Forgot password    POST { action: "send-otp", email }
//                       POST { action: "reset-with-otp", email, code, newPassword }
//    The 6-digit code is generated, stored (hashed) and checked here — never in
//    the browser. Codes expire after 10 minutes and allow 5 attempts.
//
// Requires the password_reset_otps table (supabase/password_reset_otp_migration.sql).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const admin = createClient(SUPABASE_URL, SERVICE_KEY);

const OTP_TTL_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function normalisePhone(phone: string): string {
  return phone.trim().replace(/\s+/g, "").replace(/^\+254/, "254").replace(/^07/, "2547").replace(/^01/, "2541").replace(/^7(\d{8})$/, "2547$1");
}

function maskPhone(phone: string): string {
  const p = phone.replace(/\s+/g, "");
  return p.length > 4 ? `${"*".repeat(Math.max(0, p.length - 3))}${p.slice(-3)}` : p;
}

async function findUserByEmail(email: string) {
  const { data } = await admin.from("user_profiles")
    .select("id,email,phone,role,member_id,is_active,full_name")
    .eq("email", email.trim().toLowerCase()).maybeSingle();
  return data as { id: string; email: string; phone?: string | null; role: string; member_id: number | null; is_active?: boolean | null; full_name?: string | null } | null;
}

async function phoneFor(profile: NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>): Promise<string | null> {
  if (profile.phone) return profile.phone;
  const table = profile.role === "shareholder" ? "shareholders" : profile.role === "client" ? "clients" : profile.role === "investor" ? "investors" : null;
  if (table && profile.member_id) {
    const { data } = await admin.from(table).select("phone").eq("id", profile.member_id).maybeSingle();
    if (data?.phone) return data.phone as string;
  }
  const prefix = profile.email.split("@")[0];
  return /^[0+]?\d{9,15}$/.test(prefix) ? prefix : null;
}

async function sendSms(to: string, message: string) {
  const { data } = await admin.from("app_settings").select("value").eq("key", "sms_settings").maybeSingle();
  const providerConfig = (data?.value as any)?.providerConfig;
  if (!providerConfig) throw new Error("SMS is not configured. Contact your administrator.");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/sms-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ to: normalisePhone(to), message, providerConfig }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) throw new Error(out.error ?? "Could not send the SMS.");
}

async function setPassword(userId: string, newPassword: string) {
  const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
  if (error) throw new Error(error.message);
  await admin.from("user_profiles").update({ password_changed: true }).eq("id", userId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    // ── Forgot password: send code ───────────────────────────────────────────
    if (action === "send-otp") {
      const profile = body.email ? await findUserByEmail(String(body.email)) : null;
      if (!profile) return json({ success: false, error: "Account not found." }, 404);
      if (profile.is_active === false) return json({ success: false, error: "This account has been deactivated. Contact your administrator." }, 403);
      const phone = await phoneFor(profile);
      if (!phone) return json({ success: false, error: "No phone number on this account. Contact your administrator." }, 400);

      const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 900000 + 100000);
      await admin.from("password_reset_otps").delete().eq("user_id", profile.id);
      const { error: insErr } = await admin.from("password_reset_otps").insert({
        user_id: profile.id,
        code_hash: await sha256(`${profile.id}:${code}`),
        expires_at: new Date(Date.now() + OTP_TTL_MINUTES * 60_000).toISOString(),
      });
      if (insErr) return json({ success: false, error: insErr.message }, 500);

      await sendSms(phone, `Your Egemeo Ardhi password reset code is: ${code}. Valid for ${OTP_TTL_MINUTES} minutes. Do not share this code.`);
      return json({ success: true, sentTo: maskPhone(phone) });
    }

    // ── Forgot password: verify code and reset ───────────────────────────────
    if (action === "reset-with-otp") {
      const { email, code, newPassword } = body;
      if (!email || !code || !newPassword) return json({ success: false, error: "email, code and newPassword are required" }, 400);
      if (String(newPassword).length < 6) return json({ success: false, error: "Password must be at least 6 characters" }, 400);
      const profile = await findUserByEmail(String(email));
      if (!profile) return json({ success: false, error: "Account not found." }, 404);

      const { data: otp } = await admin.from("password_reset_otps").select("*").eq("user_id", profile.id).maybeSingle();
      if (!otp || new Date(otp.expires_at).getTime() < Date.now()) {
        if (otp) await admin.from("password_reset_otps").delete().eq("id", otp.id);
        return json({ success: false, error: "Code expired. Please request a new one." }, 400);
      }
      if (Number(otp.attempts) >= OTP_MAX_ATTEMPTS) {
        await admin.from("password_reset_otps").delete().eq("id", otp.id);
        return json({ success: false, error: "Too many wrong attempts. Please request a new code." }, 429);
      }
      if ((await sha256(`${profile.id}:${String(code).trim()}`)) !== otp.code_hash) {
        await admin.from("password_reset_otps").update({ attempts: Number(otp.attempts) + 1 }).eq("id", otp.id);
        return json({ success: false, error: "Incorrect code. Please try again." }, 400);
      }

      await admin.from("password_reset_otps").delete().eq("id", otp.id); // single use
      await setPassword(profile.id, String(newPassword));
      return json({ success: true });
    }

    // ── Signed-in caller: admin, or the user themself ────────────────────────
    const { userId, newPassword } = body;
    if (!userId || !newPassword)
      return json({ success: false, error: "userId and newPassword are required" }, 400);
    if (String(newPassword).length < 6)
      return json({ success: false, error: "Password must be at least 6 characters" }, 400);

    const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data: caller, error: callerErr } = token ? await admin.auth.getUser(token) : { data: { user: null }, error: null };
    if (callerErr || !caller?.user) return json({ success: false, error: "Sign in first." }, 401);

    if (caller.user.id !== userId) {
      const { data: callerProfile } = await admin.from("user_profiles").select("role,is_active").eq("id", caller.user.id).maybeSingle();
      if (callerProfile?.role !== "admin" || callerProfile?.is_active === false)
        return json({ success: false, error: "Only an administrator can reset another user's password." }, 403);
    }

    await setPassword(String(userId), String(newPassword));
    return json({ success: true });
  } catch (err: any) {
    return json({ success: false, error: err?.message ?? "Server error" }, 500);
  }
});
