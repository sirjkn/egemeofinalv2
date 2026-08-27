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
    const { userId } = await req.json();
    if (!userId) return json({ success: false, error: "userId is required" }, 400);

    const { error } = await supabase.auth.admin.deleteUser(userId);
    if (error) return json({ success: false, error: error.message }, 400);

    return json({ success: true });
  } catch (err: any) {
    return json({ success: false, error: err.message }, 500);
  }
});
