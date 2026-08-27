import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { Client } from "https://deno.land/x/postgres@v0.17.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  try {
    const body = await req.json().catch(() => ({}));
    const { action, userId, newPassword } = body;

    // ── Admin API actions (no DB connection needed) ───────────────────────────

    if (action === "reset_password") {
      if (!userId || !newPassword)
        return json({ success: false, error: "userId and newPassword are required" }, 400);
      if (String(newPassword).length < 6)
        return json({ success: false, error: "Password must be at least 6 characters" }, 400);

      const supabaseUrl = Deno.env.get("SUPABASE_URL");
      const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
      if (!supabaseUrl || !serviceKey)
        return json({ success: false, error: "SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not configured" }, 500);

      const admin = createClient(supabaseUrl, serviceKey);
      const { error } = await admin.auth.admin.updateUserById(userId, { password: newPassword });
      if (error) return json({ success: false, error: error.message }, 400);

      // Clear flag so member is prompted to change on next login
      await admin.from("user_profiles").update({ password_changed: false }).eq("id", userId);

      return json({ success: true });
    }

    // ── Direct DB actions ─────────────────────────────────────────────────────

    const dbUrl = Deno.env.get("SUPABASE_DB_URL");
    if (!dbUrl) return json({ success: false, error: "SUPABASE_DB_URL not available" }, 500);

    const client = new Client(dbUrl);
    await client.connect();

    try {
      if (action === "drop_contributions_unique") {
        const TARGET_COLS = ["month", "year", "payment_date", "shareholder_id"];

        const res = await client.queryObject<{ conname: string; contype: string }>(`
          SELECT conname, contype
          FROM pg_constraint
          WHERE conrelid = 'contributions'::regclass
            AND contype = 'u'
        `);

        const dropped: string[] = [];

        const knownNames = [
          "contributions_unique_month",
          "contributions_shareholder_id_month_year_key",
          "contributions_shareholder_id_payment_date_key",
        ];
        for (const name of knownNames) {
          await client.queryArray(
            `ALTER TABLE contributions DROP CONSTRAINT IF EXISTS "${name}"`
          );
          dropped.push(name);
        }

        for (const row of res.rows) {
          const name = row.conname;
          if (knownNames.includes(name)) continue;
          const colRes = await client.queryObject<{ attname: string }>(`
            SELECT a.attname
            FROM pg_attribute a
            JOIN pg_constraint c ON a.attnum = ANY(c.conkey)
            WHERE c.conname = $1 AND c.conrelid = 'contributions'::regclass
          `, [name]);
          const cols = colRes.rows.map((r) => r.attname);
          const shouldDrop = cols.some((c) => TARGET_COLS.includes(c));
          if (shouldDrop) {
            await client.queryArray(
              `ALTER TABLE contributions DROP CONSTRAINT IF EXISTS "${name}"`
            );
            dropped.push(name);
          }
        }

        return json({ success: true, dropped });
      }

      return json({ success: false, error: `Unknown action: ${action}` }, 400);
    } finally {
      await client.end();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return json({ success: false, error: msg }, 500);
  }
});
