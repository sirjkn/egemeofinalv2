import { Router, Request, Response } from "express";
import pool from "../db/connection";

const router = Router();

// ─── helpers ──────────────────────────────────────────────────────────────────

function getSupabaseConfig() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in server/.env");
  return { url, key };
}

async function adminFetch(url: string, key: string, method: string, body?: object) {
  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
      "apikey": key,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { res, json: await res.json() as any };
}

// Find auth user ID by email directly from auth.users (we have DB access)
async function findAuthUserByEmail(email: string): Promise<string | null> {
  const { rows } = await pool.query<{ id: string }>(
    "SELECT id FROM auth.users WHERE email = $1 LIMIT 1",
    [email]
  );
  return rows[0]?.id ?? null;
}

// Confirm a user's email directly in the DB (handles accounts stuck as unconfirmed)
async function confirmUserEmail(userId: string): Promise<void> {
  await pool.query(
    `UPDATE auth.users
     SET email_confirmed_at = COALESCE(email_confirmed_at, NOW()),
         confirmed_at        = COALESCE(confirmed_at,        NOW()),
         updated_at          = NOW()
     WHERE id = $1`,
    [userId]
  );
}

// ─── POST /api/auth/create-member ─────────────────────────────────────────────
// Creates or confirms a Supabase Auth user + ensures a user_profiles row exists.
// Uses the service-role key so the account is auto-confirmed with no email sent.
router.post("/create-member", async (req: Request, res: Response) => {
  const { email, password, full_name, role, member_id } = req.body as {
    email: string;
    password: string;
    full_name: string;
    role: "admin" | "shareholder" | "client" | "investor";
    member_id: number | null;
  };

  if (!email || !password || !role) {
    return res.status(400).json({ success: false, error: "email, password and role are required" });
  }

  try {
    const { url, key } = getSupabaseConfig();
    let userId: string | null = null;

    // ── 1. Try to create via Admin API ────────────────────────────────────────
    const { res: createRes, json: createJson } = await adminFetch(
      `${url}/auth/v1/admin/users`, key, "POST",
      { email, password, email_confirm: true, user_metadata: { full_name } }
    );

    if (createRes.ok) {
      userId = createJson?.id ?? null;
    } else {
      const msg: string = (createJson?.msg || createJson?.message || createJson?.error_description || "").toLowerCase();
      if (msg.includes("already registered") || msg.includes("already been registered")) {
        // User exists — find their ID from the DB
        userId = await findAuthUserByEmail(email);
      } else {
        return res.status(400).json({ success: false, error: createJson?.msg || createJson?.message || "Failed to create auth user" });
      }
    }

    if (!userId) {
      return res.status(400).json({ success: false, error: "Could not resolve auth user ID" });
    }

    // ── 2. Confirm email via direct SQL (fixes stuck-unconfirmed accounts) ────
    await confirmUserEmail(userId);

    // ── 3. Ensure user_profiles row exists ────────────────────────────────────
    await pool.query(
      `INSERT INTO user_profiles (id, role, member_id, full_name, email, is_active, password_changed)
       VALUES ($1, $2, $3, $4, $5, true, false)
       ON CONFLICT (id) DO NOTHING`,
      [userId, role, member_id ?? null, full_name || email, email]
    );

    return res.json({ success: true, user_id: userId });
  } catch (err: any) {
    console.error("[auth/create-member]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/auth/confirm-user ──────────────────────────────────────────────
// Confirms an existing unconfirmed account by email.
// Called by the login page when Supabase returns "Email not confirmed".
router.post("/confirm-user", async (req: Request, res: Response) => {
  const { email } = req.body as { email: string };
  if (!email) return res.status(400).json({ success: false, error: "email is required" });

  try {
    getSupabaseConfig(); // validates env vars are set
    const userId = await findAuthUserByEmail(email);
    if (!userId) return res.status(404).json({ success: false, error: "User not found" });
    await confirmUserEmail(userId);
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[auth/confirm-user]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POST /api/auth/reset-password ───────────────────────────────────────────
// Admin endpoint: set a new password for any user by their auth user ID.
// Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server .env.
router.post("/reset-password", async (req: Request, res: Response) => {
  const { userId, newPassword } = req.body as { userId: string; newPassword: string };
  if (!userId || !newPassword) {
    return res.status(400).json({ success: false, error: "userId and newPassword are required" });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ success: false, error: "Password must be at least 6 characters" });
  }
  try {
    const { url, key } = getSupabaseConfig();
    const { res: patchRes, json: patchJson } = await adminFetch(
      `${url}/auth/v1/admin/users/${userId}`, key, "PUT",
      { password: newPassword }
    );
    if (!patchRes.ok) {
      const msg = patchJson?.msg || patchJson?.message || patchJson?.error_description || "Failed to reset password";
      return res.status(400).json({ success: false, error: msg });
    }
    // Also clear password_changed flag so member is prompted to change on next login
    await pool.query(
      "UPDATE user_profiles SET password_changed = false WHERE id = $1",
      [userId]
    );
    return res.json({ success: true });
  } catch (err: any) {
    console.error("[auth/reset-password]", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

export default router;
