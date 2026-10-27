import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Africa's Talking status codes
const AT_STATUS: Record<number, string> = {
  100: "Processed",
  101: "Sent",
  102: "Queued",
  401: "RiskHold",
  402: "InvalidSenderId — sender ID not registered on AT account",
  403: "InvalidPhoneNumber",
  404: "UnsupportedNumberType",
  405: "InsufficientBalance — top up your Africa's Talking account",
  406: "UserInBlacklist",
  407: "CouldNotRoute",
  409: "DuplicateRequest",
  500: "InternalServerError",
  501: "GatewayError",
  502: "RejectedByGateway",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const body = await req.json().catch(() => ({}));
  const { to, message, providerConfig } = body;

  if (!to || !message) {
    return new Response(JSON.stringify({ ok: false, error: "Missing: to, message" }), {
      status: 400, headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const provider: string = providerConfig?.provider ?? "africastalking";

  try {
    // ── Oramobile ────────────────────────────────────────────────────────────────
    if (provider === "oramobile") {
      const ora = providerConfig?.oramobile;
      if (!ora?.apiKey && (!ora?.username || !ora?.password)) {
        return new Response(JSON.stringify({ ok: false, error: "Oramobile: provide an API Key, or both username and password" }), {
          status: 400, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      // Prefer API key auth; fall back to Basic Auth
      const authHeader = ora.apiKey
        ? `App ${ora.apiKey}`
        : `Basic ${btoa(`${ora.username}:${ora.password}`)}`;
      const res = await fetch("http://107.20.199.106/restapi/sms/1/text/single", {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json",
          "Accept": "application/json",
        },
        body: JSON.stringify({ from: ora.senderId || ora.username, to, text: message }),
      });
      const data = await res.json().catch(() => ({}));
      const status = data?.messages?.[0]?.status;
      // groupId 0=ACCEPTED, 1=PENDING (sent to carrier), 3=DELIVERED are success
      if (!res.ok || (status?.groupId !== undefined && status.groupId !== 0 && status.groupId !== 1 && status.groupId !== 3)) {
        const reason = status?.description ?? status?.groupName ?? `HTTP ${res.status}`;
        return new Response(JSON.stringify({ ok: false, error: `Oramobile: ${reason}`, groupId: status?.groupId }), {
          status: 502, headers: { ...cors, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true, groupId: status?.groupId, groupName: status?.groupName }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // ── Africa's Talking (default) ────────────────────────────────────────────
    const at = providerConfig?.africastalking;
    if (!at?.apiKey || !at?.username) {
      return new Response(JSON.stringify({ ok: false, error: "Africa's Talking: apiKey and username required" }), {
        status: 400, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const params = new URLSearchParams({ username: at.username, to, message });
    if (at.senderId) params.set("from", at.senderId);

    const res = await fetch("https://api.africastalking.com/version1/messaging", {
      method: "POST",
      headers: {
        "apiKey": at.apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: params.toString(),
    });

    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* ignore */ }

    // AT returns HTTP 200/201 even for failures — must inspect the body
    const recipient = data?.SMSMessageData?.Recipients?.[0];
    const statusCode: number | undefined = recipient?.statusCode;
    const atMessage: string = data?.SMSMessageData?.Message ?? "";

    // Successful codes: 100 (Processed) and 101 (Sent) and 102 (Queued)
    if (!res.ok || (statusCode !== undefined && statusCode > 102)) {
      const reason = statusCode ? (AT_STATUS[statusCode] ?? `Status ${statusCode}`) : (atMessage || text || `HTTP ${res.status}`);
      return new Response(JSON.stringify({ ok: false, error: `Africa's Talking: ${reason}`, statusCode, atMessage }), {
        status: 502, headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Warn if sandbox (messages won't arrive on real phones)
    const warning = at.username === "sandbox" ? "Sandbox mode — messages go to AT simulator, not real phones" : undefined;

    return new Response(JSON.stringify({ ok: true, statusCode, atMessage, warning }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 502, headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
