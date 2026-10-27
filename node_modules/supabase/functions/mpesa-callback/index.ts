import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

serve(async (req) => {
  try {
    const body = await req.json().catch(() => ({}));

    // Persist the latest callback payload for inspection in the dashboard
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    await supabase
      .from("app_settings")
      .upsert(
        { key: "mpesa_callback_last", value: body, updated_at: new Date().toISOString() },
        { onConflict: "key" },
      );
  } catch (_) {
    // Never let storage errors cause a non-200 — Safaricom must always get 200
  }

  // Safaricom requires exactly this shape to mark the transaction acknowledged
  return new Response(
    JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }),
    { headers: { "Content-Type": "application/json" } },
  );
});
