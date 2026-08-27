import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type DarajaSettings = {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  callbackUrl: string;
  environment: "sandbox" | "production";
};

function getBaseUrl(env: string) {
  return env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
}

async function getAccessToken(key: string, secret: string, env: string): Promise<string> {
  const creds = btoa(`${key}:${secret}`);
  const res = await fetch(`${getBaseUrl(env)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${creds}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Format date as "YYYY-MM-DD HH:MM:SS" required by Safaricom
function fmtDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const body = await req.json().catch(() => ({})) as {
      startDate?: string;
      endDate?: string;
      offset?: number;
    };

    // Load Daraja credentials from DB
    const { data: row } = await supabase
      .from("app_settings").select("value").eq("key", "daraja_settings").maybeSingle();
    const s = (row?.value ?? {}) as Partial<DarajaSettings>;

    const consumerKey    = s.consumerKey    || Deno.env.get("MPESA_CONSUMER_KEY")    || "";
    const consumerSecret = s.consumerSecret || Deno.env.get("MPESA_CONSUMER_SECRET") || "";
    const shortCode      = s.shortCode      || Deno.env.get("MPESA_SHORTCODE")       || "";
    const environment    = s.environment    ?? "production";

    if (!consumerKey || !consumerSecret || !shortCode) {
      return json({ success: false, error: "M-Pesa credentials not configured. Go to Settings → Payment Methods." });
    }

    // Default: last 3 months
    const now = new Date();
    const threeMonthsAgo = new Date(now);
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const startDate = body.startDate ?? fmtDate(threeMonthsAgo);
    const endDate   = body.endDate   ?? fmtDate(now);
    const offset    = body.offset    ?? 0;

    const token = await getAccessToken(consumerKey, consumerSecret, environment);
    const base  = getBaseUrl(environment);

    const requestBody = {
      ShortCode:   shortCode,
      StartDate:   startDate,
      EndDate:     endDate,
      OffSetValue: String(offset),
    };

    const res = await fetch(`${base}/pulltransactions/v1/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    const rawText = await res.text();
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(rawText); } catch { /* not JSON */ }

    const _debug = {
      httpStatus: res.status,
      environment,
      shortCode,
      startDate,
      endDate,
      apiBase: base,
      requestBody,
      rawResponse: rawText.slice(0, 500),
    };

    if (!res.ok || String(data.errorCode ?? "").length > 0) {
      return json({
        success: false,
        error: String(data.errorMessage ?? data.ResponseMessage ?? `HTTP ${res.status}`),
        _debug,
      });
    }

    // Pull API returns ResponseCode "1000" for success
    const rc = String(data.ResponseCode ?? "");
    if (rc && rc !== "1000" && rc !== "0") {
      return json({
        success: false,
        error: String(data.ResponseMessage ?? `Safaricom error code: ${rc}`),
        _debug,
      });
    }

    const transactions = Array.isArray(data.Data) ? data.Data : [];
    return json({
      success: true,
      transactions,
      startDate,
      endDate,
      environment,
      shortCode,
      total: transactions.length,
      _debug,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    return json({ success: false, error: msg });
  }
});
