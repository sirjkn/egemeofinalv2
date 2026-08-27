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

async function getAccessToken(consumerKey: string, consumerSecret: string, env: string) {
  const credentials = btoa(`${consumerKey}:${consumerSecret}`);
  const res = await fetch(`${getBaseUrl(env)}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${credentials}` },
  });
  if (!res.ok) throw new Error(`Daraja auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json() as { access_token: string };
  return data.access_token;
}

function getTimestamp() {
  return new Date().toISOString().replace(/[-T:.Z]/g, "").slice(0, 14);
}

function json_response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const json = await req.json().catch(() => ({}));
    const { action = "push", phone, amount, accountRef, description, checkoutRequestId } = json;

    // Load settings from DB
    const { data: row } = await supabase
      .from("app_settings").select("value").eq("key", "daraja_settings").maybeSingle();
    const s = (row?.value ?? {}) as Partial<DarajaSettings>;

    const consumerKey    = s.consumerKey    || Deno.env.get("MPESA_CONSUMER_KEY")    || "";
    const consumerSecret = s.consumerSecret || Deno.env.get("MPESA_CONSUMER_SECRET") || "";
    const shortCode      = s.shortCode      || Deno.env.get("MPESA_SHORTCODE")       || "";
    const passkey        = s.passkey        || Deno.env.get("MPESA_PASSKEY")         || "";
    const environment    = s.environment    ?? "production";
    const callbackUrl    = s.callbackUrl    || Deno.env.get("MPESA_CALLBACK_URL")    || "";

    if (!consumerKey || !consumerSecret || !shortCode || !passkey) {
      return json_response({ success: false, error: "M-Pesa credentials not configured. Go to Settings → Payment Settings." });
    }

    const token     = await getAccessToken(consumerKey, consumerSecret, environment);
    const timestamp = getTimestamp();
    const password  = btoa(`${shortCode}${passkey}${timestamp}`);
    const base      = getBaseUrl(environment);

    // ── STK Query ──────────────────────────────────────────────────────────────
    if (action === "query") {
      if (!checkoutRequestId) return json_response({ success: false, error: "checkoutRequestId required" });

      const res = await fetch(`${base}/mpesa/stkpushquery/v1/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: shortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: checkoutRequestId,
        }),
      });
      const data = await res.json().catch(() => ({})) as Record<string, unknown>;

      // STK Query does NOT return CallbackMetadata — receipt lives only in the callback.
      // When the transaction is confirmed (ResultCode 0), read the stored callback to get
      // the real short M-Pesa receipt (e.g. RGH789XYZ0).
      const resultCode = String(data?.ResultCode ?? data?.errorCode ?? "");
      if (resultCode === "0") {
        try {
          const { data: cbRow } = await supabase
            .from("app_settings")
            .select("value")
            .eq("key", "mpesa_callback_last")
            .maybeSingle();

          if (cbRow?.value) {
            const cb = cbRow.value as Record<string, unknown>;
            // Safaricom callback body wraps under Body.stkCallback
            const stkCb = (cb?.Body as any)?.stkCallback ?? cb;
            const items: { Name: string; Value?: string | number }[] =
              (stkCb?.CallbackMetadata?.Item as any[]) ?? [];
            const receipt = items.find((i) => i.Name === "MpesaReceiptNumber")?.Value;
            if (receipt) {
              data.CallbackMetadata = { Item: items };
            }
          }
        } catch { /* callback lookup is best-effort */ }
      }

      return json_response({ success: true, ...data });
    }

    // ── STK Push ───────────────────────────────────────────────────────────────
    const normalizedPhone = String(phone ?? "").replace(/^\+/, "").replace(/^0/, "254");

    const payload = {
      BusinessShortCode: shortCode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   "CustomerPayBillOnline",
      Amount:            Math.round(Number(amount)),
      PartyA:            normalizedPhone,
      PartyB:            shortCode,
      PhoneNumber:       normalizedPhone,
      CallBackURL:       callbackUrl,
      AccountReference:  String(accountRef ?? "SACCO").slice(0, 12),
      TransactionDesc:   String(description ?? "Payment").slice(0, 50),
    };

    console.log("STK payload:", JSON.stringify({ ...payload, Password: "[redacted]" }));

    const res = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({})) as {
      ResponseCode?: string;
      ResponseDescription?: string;
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    if (!res.ok || data.ResponseCode !== "0") {
      return json_response({ success: false, error: data.errorMessage ?? data.ResponseDescription ?? `STK push failed (${res.status})` });
    }

    return json_response({ success: true, _debug: { apiBase: base, environment }, _phone: normalizedPhone, _shortCode: shortCode, _env: environment, ...data });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Internal error";
    return json_response({ success: false, error: msg });
  }
});
