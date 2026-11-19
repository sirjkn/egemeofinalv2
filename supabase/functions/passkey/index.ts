// ─── passkey: biometric (fingerprint / face) login via WebAuthn ──────────────
//
// Actions (POST JSON { action, ... }):
//   register-options  (signed in)  → WebAuthn creation options for this device
//   register-verify   (signed in)  → verify the new credential and store its public key
//   login-options     (public)     → WebAuthn request options (discoverable passkeys)
//   login-verify      (public)     → verify the signature, return a one-time token_hash
//                                    the browser exchanges for a session (verifyOtp)
//   list              (signed in)  → this user's registered devices
//   delete            (signed in)  → remove one of this user's devices
//
// Requires tables from supabase/passkeys_migration.sql.
// Deploy: supabase functions deploy passkey --no-verify-jwt
//   (login-options / login-verify are called before the user has a session.)

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "npm:@simplewebauthn/server@13";
import { isoBase64URL } from "npm:@simplewebauthn/server@13/helpers";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// Sites allowed to use passkeys. The relying-party ID is the site's hostname.
// Override with PASSKEY_ALLOWED_ORIGINS="https://a.com,https://b.com" if needed.
const ALLOWED_ORIGINS = (Deno.env.get("PASSKEY_ALLOWED_ORIGINS")
  ?? "https://app.egemeoardhi.com,http://localhost:5173")
  .split(",").map((o) => o.trim()).filter(Boolean);
const RP_NAME = Deno.env.get("PASSKEY_RP_NAME") ?? "Egemeo Ardhi";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

function relyingParty(req: Request) {
  const origin = req.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.includes(origin)) throw new HttpError(403, `Origin not allowed: ${origin || "(none)"}`);
  return { origin, rpID: new URL(origin).hostname };
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function requireUser(req: Request) {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in first.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "Your session has expired. Sign in again.");
  return data.user;
}

async function saveChallenge(kind: "register" | "login", challenge: string, rp: { rpID: string; origin: string }, userId: string | null) {
  // Housekeeping: drop expired challenges.
  await admin.from("passkey_challenges").delete().lt("expires_at", new Date().toISOString());
  const { data, error } = await admin.from("passkey_challenges")
    .insert({ kind, challenge, rp_id: rp.rpID, origin: rp.origin, user_id: userId })
    .select("id").single();
  if (error) throw new HttpError(500, error.message);
  return data.id as string;
}

async function takeChallenge(id: string, kind: "register" | "login") {
  const { data } = await admin.from("passkey_challenges").select("*").eq("id", id).eq("kind", kind).maybeSingle();
  if (!data) throw new HttpError(400, "This request has expired. Please try again.");
  await admin.from("passkey_challenges").delete().eq("id", id); // single use
  if (new Date(data.expires_at).getTime() < Date.now()) throw new HttpError(400, "This request has expired. Please try again.");
  return data as { challenge: string; rp_id: string; origin: string; user_id: string | null };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  try {
    const body = await req.json().catch(() => ({}));
    const action = String(body.action ?? "");

    // ── Enable on this device ────────────────────────────────────────────────
    if (action === "register-options") {
      const user = await requireUser(req);
      const rp = relyingParty(req);
      const { data: existing } = await admin.from("user_passkeys").select("credential_id,transports").eq("user_id", user.id);
      const { data: profile } = await admin.from("user_profiles").select("full_name").eq("id", user.id).maybeSingle();
      const options = await generateRegistrationOptions({
        rpName: RP_NAME,
        rpID: rp.rpID,
        userID: new TextEncoder().encode(user.id),
        userName: user.email ?? user.id,
        userDisplayName: profile?.full_name ?? user.email ?? "Member",
        attestationType: "none",
        excludeCredentials: (existing ?? []).map((c: any) => ({ id: c.credential_id, transports: c.transports ?? [] })),
        authenticatorSelection: { residentKey: "required", userVerification: "required", authenticatorAttachment: "platform" },
      });
      const challengeId = await saveChallenge("register", options.challenge, rp, user.id);
      return json({ options, challengeId });
    }

    if (action === "register-verify") {
      const user = await requireUser(req);
      const ch = await takeChallenge(String(body.challengeId ?? ""), "register");
      if (ch.user_id !== user.id) throw new HttpError(403, "Challenge does not belong to this user.");
      const verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: ch.origin,
        expectedRPID: ch.rp_id,
        requireUserVerification: true,
      });
      if (!verification.verified || !verification.registrationInfo) throw new HttpError(400, "Could not verify this device.");
      const { credential } = verification.registrationInfo;
      const { error } = await admin.from("user_passkeys").insert({
        user_id: user.id,
        credential_id: credential.id,
        public_key: isoBase64URL.fromBuffer(credential.publicKey),
        counter: credential.counter ?? 0,
        transports: credential.transports ?? body.response?.response?.transports ?? [],
        device_name: String(body.deviceName ?? "").slice(0, 80) || null,
      });
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true });
    }

    // ── Log in ───────────────────────────────────────────────────────────────
    if (action === "login-options") {
      const rp = relyingParty(req);
      const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
      const challengeId = await saveChallenge("login", options.challenge, rp, null);
      return json({ options, challengeId });
    }

    if (action === "login-verify") {
      const ch = await takeChallenge(String(body.challengeId ?? ""), "login");
      const credentialId = String(body.response?.id ?? "");
      const { data: pk } = await admin.from("user_passkeys").select("*").eq("credential_id", credentialId).maybeSingle();
      if (!pk) throw new HttpError(400, "This fingerprint/face login is not registered. Sign in with your password and enable it again.");

      const verification = await verifyAuthenticationResponse({
        response: body.response,
        expectedChallenge: ch.challenge,
        expectedOrigin: ch.origin,
        expectedRPID: ch.rp_id,
        requireUserVerification: true,
        credential: {
          id: pk.credential_id,
          publicKey: isoBase64URL.toBuffer(pk.public_key),
          counter: Number(pk.counter ?? 0),
          transports: pk.transports ?? [],
        },
      });
      if (!verification.verified) throw new HttpError(401, "Fingerprint/face check failed.");
      await admin.from("user_passkeys")
        .update({ counter: verification.authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
        .eq("id", pk.id);

      // Same account rules as password login.
      const { data: profile } = await admin.from("user_profiles").select("is_active").eq("id", pk.user_id).maybeSingle();
      if (profile?.is_active === false) throw new HttpError(403, "This account has been deactivated. Contact your administrator.");

      // Issue a one-time sign-in token; the browser exchanges it with verifyOtp.
      const { data: u, error: uErr } = await admin.auth.admin.getUserById(pk.user_id);
      if (uErr || !u.user?.email) throw new HttpError(400, "Account not found.");
      const { data: link, error: linkErr } = await admin.auth.admin.generateLink({ type: "magiclink", email: u.user.email });
      if (linkErr || !link.properties?.hashed_token) throw new HttpError(500, linkErr?.message ?? "Could not start session.");
      return json({ ok: true, token_hash: link.properties.hashed_token, email: u.user.email });
    }

    // ── Manage devices ───────────────────────────────────────────────────────
    if (action === "list") {
      const user = await requireUser(req);
      const { data } = await admin.from("user_passkeys")
        .select("id,device_name,created_at,last_used_at").eq("user_id", user.id).order("created_at");
      return json({ devices: data ?? [] });
    }

    if (action === "delete") {
      const user = await requireUser(req);
      const { error } = await admin.from("user_passkeys").delete().eq("id", String(body.id ?? "")).eq("user_id", user.id);
      if (error) throw new HttpError(500, error.message);
      return json({ ok: true });
    }

    throw new HttpError(400, `Unknown action: ${action}`);
  } catch (err: any) {
    const status = err instanceof HttpError ? err.status : 500;
    return json({ ok: false, error: err?.message ?? "Server error" }, status);
  }
});
