import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const json = (body: object, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, content-type",
      },
    });
  }

  try {
    const { userId, newEmail } = await req.json();

    if (!userId || !newEmail)
      return json({ success: false, error: "userId and newEmail are required" }, 400);

    // Update the Supabase Auth account email
    const { error: authErr } = await supabase.auth.admin.updateUserById(userId, { email: newEmail });
    if (authErr) return json({ success: false, error: authErr.message }, 400);

    // Keep user_profiles.email in sync so login lookups always find the right record
    await supabase.from("user_profiles").update({ email: newEmail }).eq("id", userId);

    return json({ success: true });
  } catch (err: any) {
    return json({ success: false, error: err.message }, 500);
  }
});
