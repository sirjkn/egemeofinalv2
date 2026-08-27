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
    const { userId, newPassword } = await req.json();

    if (!userId || !newPassword)
      return json({ success: false, error: "userId and newPassword are required" }, 400);
    if (newPassword.length < 6)
      return json({ success: false, error: "Password must be at least 6 characters" }, 400);

    const { error } = await supabase.auth.admin.updateUserById(userId, { password: newPassword });
    if (error) return json({ success: false, error: error.message }, 400);

    // Clear flag so member is prompted to change on next login
    await supabase.from("user_profiles").update({ password_changed: false }).eq("id", userId);

    return json({ success: true });
  } catch (err: any) {
    return json({ success: false, error: err.message }, 500);
  }
});
