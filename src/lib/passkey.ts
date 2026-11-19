// ─── Biometric (fingerprint / face) login — browser side ─────────────────────
// Uses WebAuthn passkeys. The private key stays in the phone's secure hardware,
// unlocked by the user's fingerprint/face; the server (edge function `passkey`)
// only stores the public key and verifies signatures.

import { projectId, publicAnonKey } from "../../utils/supabase/info";
import { supabase } from "@/lib/supabase";

const FN_URL = `https://${projectId}.supabase.co/functions/v1/passkey`;
/** Set on a device after biometric login is enabled there, so the login page can offer it. */
const DEVICE_FLAG = "egemeo_passkey_device";

// ── base64url <-> bytes ──────────────────────────────────────────────────────
function toBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toB64url(buf: ArrayBuffer | null): string | undefined {
  if (!buf) return undefined;
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── device support ───────────────────────────────────────────────────────────
/** True when this browser has a built-in fingerprint/face authenticator. */
export async function isBiometricSupported(): Promise<boolean> {
  try {
    if (typeof window === "undefined" || !window.PublicKeyCredential || !navigator.credentials) return false;
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function isBiometricEnabledOnDevice(): boolean {
  try { return localStorage.getItem(DEVICE_FLAG) === "1"; } catch { return false; }
}
function setDeviceFlag(on: boolean) {
  try { on ? localStorage.setItem(DEVICE_FLAG, "1") : localStorage.removeItem(DEVICE_FLAG); } catch { /* ignore */ }
}

export function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? "Android" : /iPhone|iPad|iPod/i.test(ua) ? "iPhone" : /Windows/i.test(ua) ? "Windows" : /Mac/i.test(ua) ? "Mac" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /Firefox\//.test(ua) ? "Firefox" : "Browser";
  return `${os} · ${browser}`;
}

// ── edge function call ───────────────────────────────────────────────────────
async function call(action: string, body: Record<string, unknown> = {}, withSession = false) {
  let bearer = publicAnonKey;
  if (withSession) {
    const { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) throw new Error("Sign in first.");
    bearer = data.session.access_token;
  }
  let res: Response;
  try {
    res = await fetch(FN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: publicAnonKey, Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ action, ...body }),
    });
  } catch {
    throw new Error("Biometric login service is unavailable. Use your password.");
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw new Error("Biometric login is not set up on the server yet.");
  if (!res.ok || data.ok === false) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data;
}

function friendly(e: any): Error {
  const name = e?.name ?? "";
  if (name === "NotAllowedError") return new Error("Cancelled or timed out. Please try again.");
  if (name === "InvalidStateError") return new Error("Biometric login is already enabled on this device.");
  if (name === "SecurityError") return new Error("Biometric login is not allowed on this site/app.");
  if (name === "NotSupportedError") return new Error("This device does not support fingerprint/face login.");
  return e instanceof Error ? e : new Error(String(e));
}

// ── enable on this device (user must be signed in) ───────────────────────────
export async function enableBiometricLogin(deviceName = defaultDeviceName()): Promise<void> {
  const { options, challengeId } = await call("register-options", {}, true);
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.create({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        user: { ...options.user, id: toBytes(options.user.id) },
        excludeCredentials: (options.excludeCredentials ?? []).map((c: any) => ({ ...c, id: toBytes(c.id) })),
      },
    })) as PublicKeyCredential;
  } catch (e) { throw friendly(e); }
  if (!cred) throw new Error("No credential was created.");
  const r = cred.response as AuthenticatorAttestationResponse;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      attestationObject: toB64url(r.attestationObject),
      transports: typeof r.getTransports === "function" ? r.getTransports() : [],
    },
  };
  await call("register-verify", { challengeId, response, deviceName }, true);
  setDeviceFlag(true);
}

// ── log in ───────────────────────────────────────────────────────────────────
/** Prompts for fingerprint/face and signs the user in. Returns the new session. */
export async function loginWithBiometrics() {
  const { options, challengeId } = await call("login-options");
  let cred: PublicKeyCredential;
  try {
    cred = (await navigator.credentials.get({
      publicKey: {
        ...options,
        challenge: toBytes(options.challenge),
        allowCredentials: (options.allowCredentials ?? []).map((c: any) => ({ ...c, id: toBytes(c.id) })),
      },
    })) as PublicKeyCredential;
  } catch (e) { throw friendly(e); }
  if (!cred) throw new Error("No fingerprint/face login was selected.");
  const r = cred.response as AuthenticatorAssertionResponse;
  const response = {
    id: cred.id,
    rawId: toB64url(cred.rawId),
    type: cred.type,
    authenticatorAttachment: (cred as any).authenticatorAttachment ?? undefined,
    clientExtensionResults: cred.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: toB64url(r.userHandle),
    },
  };
  const { token_hash } = await call("login-verify", { challengeId, response });
  const { data, error } = await supabase.auth.verifyOtp({ token_hash, type: "magiclink" });
  if (error || !data.session) throw new Error(error?.message ?? "Could not start your session.");
  setDeviceFlag(true);
  return data.session;
}

// ── manage devices (signed in) ───────────────────────────────────────────────
export interface BiometricDevice { id: string; device_name: string | null; created_at: string; last_used_at: string | null }

export async function listBiometricDevices(): Promise<BiometricDevice[]> {
  const { devices } = await call("list", {}, true);
  return devices ?? [];
}

export async function removeBiometricDevice(id: string, isThisDevice = false): Promise<void> {
  await call("delete", { id }, true);
  if (isThisDevice) setDeviceFlag(false);
}

/** Forget the "enabled on this device" hint (the server registration is untouched). */
export function forgetBiometricOnDevice() { setDeviceFlag(false); }
