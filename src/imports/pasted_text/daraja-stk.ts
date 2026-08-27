"use node";
/**
 * Daraja (M-Pesa) STK Push — Node.js actions only
 * Mutations/queries are in daraja-internal.ts (V8 runtime)
 */
import { action, internalAction } from "./_generated/server";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";

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
  const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
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

// ── Initiate STK Push for Plot Payment ───────────────────────────────────────

export const initiateSTKForPlot = action({
  args: {
    phone: v.string(),
    amount: v.number(),
    memberId: v.string(),
    memberNumber: v.string(),
    memberName: v.string(),
    memberType: v.union(v.literal("client"), v.literal("shareholder")),
    plotId: v.string(),
    plotNumber: v.string(),
    plotProjectId: v.string(),
    plotProjectName: v.string(),
    clientId: v.optional(v.string()),
    clientName: v.optional(v.string()),
    shareholderId: v.optional(v.string()),
    shareholderName: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ stkRequestId: string; message: string }> => {
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;
    const callbackUrl = process.env.MPESA_CALLBACK_URL ?? `${process.env.CONVEX_SITE_URL}/daraja/callback`;

    if (!consumerKey || !consumerSecret || !shortCode || !passkey) {
      throw new Error("M-Pesa credentials not configured. Add MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY to Secrets.");
    }

    const token = await getAccessToken(consumerKey, consumerSecret, "production");
    const timestamp = getTimestamp();
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");
    const phone = args.phone.replace(/^\+/, "").replace(/^0/, "254");
    const label = `Plot ${args.plotNumber} - ${args.plotProjectName}`;

    const payload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(args.amount),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: args.plotNumber.slice(0, 12),
      TransactionDesc: label.slice(0, 50),
    };

    const res = await fetch("https://api.safaricom.co.ke/mpesa/stkpush/v1/processrequest", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json() as {
      ResponseCode?: string;
      ResponseDescription?: string;
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    if (!res.ok || data.ResponseCode !== "0") {
      throw new Error(data.errorMessage ?? data.ResponseDescription ?? `STK push failed (${res.status})`);
    }

    const stkRequestId = await ctx.runMutation(internal.darajaInternal.createStkRequest, {
      checkoutRequestId: data.CheckoutRequestID!,
      merchantRequestId: data.MerchantRequestID!,
      memberId: args.memberId,
      memberNumber: args.memberNumber,
      memberName: args.memberName,
      kind: "plot_payment",
      label,
      amount: args.amount,
      phone,
      plotId: args.plotId,
      plotNumber: args.plotNumber,
      plotProjectId: args.plotProjectId,
      plotProjectName: args.plotProjectName,
      clientId: args.clientId,
      clientName: args.clientName,
      shareholderId: args.shareholderId,
      shareholderName: args.shareholderName,
      memberType: args.memberType,
    });

    return { stkRequestId, message: "STK push sent! Check your phone and enter your M-Pesa PIN." };
  },
});

// ── Initiate STK Push ─────────────────────────────────────────────────────────

export const initiateSTK = action({
  args: {
    phone: v.string(),
    amount: v.number(),
    memberId: v.string(),
    memberNumber: v.string(),
    memberName: v.string(),
    contributionId: v.optional(v.string()),
    projectId: v.optional(v.string()),
    kind: v.union(v.literal("monthly"), v.literal("project"), v.literal("project_instalment"), v.literal("project_contribution")),
    label: v.string(),
    accountReference: v.optional(v.string()),
    penaltyPaid: v.optional(v.boolean()),
    penaltyAmount: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ stkRequestId: string; message: string }> => {
    const rawSettings = await ctx.runQuery(api.settings.get, { key: "daraja_settings" });
    const settings = rawSettings as DarajaSettings | null;

    // Fall back to env var secrets if DB settings are missing/incomplete
    const consumerKey = settings?.consumerKey || process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = settings?.consumerSecret || process.env.MPESA_CONSUMER_SECRET;
    const shortCode = settings?.shortCode || process.env.MPESA_SHORTCODE;
    const passkey = settings?.passkey || process.env.MPESA_PASSKEY;
    const environment = settings?.environment ?? "production";

    if (!consumerKey || !consumerSecret || !shortCode || !passkey) {
      throw new Error("M-Pesa credentials not configured. Add them in Settings → Payment Settings or in Secrets.");
    }

    // Callback URL: prefer DB setting, then env var, then derive from CONVEX_SITE_URL
    const isPlaceholder = (u?: string) => !u || u.includes("placeholder");
    const callbackUrl = (!isPlaceholder(settings?.callbackUrl) ? settings!.callbackUrl : null)
      ?? process.env.MPESA_CALLBACK_URL
      ?? `${process.env.CONVEX_SITE_URL}/daraja/callback`;

    const token = await getAccessToken(consumerKey, consumerSecret, environment);
    const timestamp = getTimestamp();
    const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");

    // Normalize phone: +2547XX → 2547XX
    const phone = args.phone.replace(/^\+/, "").replace(/^0/, "254");

    const payload = {
      BusinessShortCode: shortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: Math.round(args.amount),
      PartyA: phone,
      PartyB: shortCode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: (args.accountReference ?? args.memberNumber).slice(0, 12),
      TransactionDesc: args.label.slice(0, 50),
    };

    const res = await fetch(`${getBaseUrl(environment)}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const data = await res.json() as {
      ResponseCode?: string;
      ResponseDescription?: string;
      MerchantRequestID?: string;
      CheckoutRequestID?: string;
      errorCode?: string;
      errorMessage?: string;
    };

    if (!res.ok || data.ResponseCode !== "0") {
      throw new Error(data.errorMessage ?? data.ResponseDescription ?? `STK push failed (${res.status})`);
    }

    const stkRequestId = await ctx.runMutation(internal.darajaInternal.createStkRequest, {
      checkoutRequestId: data.CheckoutRequestID!,
      merchantRequestId: data.MerchantRequestID!,
      memberId: args.memberId,
      memberNumber: args.memberNumber,
      memberName: args.memberName,
      contributionId: args.contributionId,
      projectId: args.projectId,
      kind: args.kind,
      label: args.label,
      amount: args.amount,
      phone,
      penaltyPaid: args.penaltyPaid,
      penaltyAmount: args.penaltyAmount,
    });

    return {
      stkRequestId,
      message: "STK push sent! Check your phone and enter your M-Pesa PIN.",
    };
  },
});

// ── Query STK Push Status (Safaricom Query API) ───────────────────────────────
// Used as a fallback when Safaricom doesn't fire the callback

export const querySTKStatus = action({
  args: { stkRequestId: v.string() },
  handler: async (ctx, args): Promise<{ status: "pending" | "success" | "failed"; resultDesc?: string; mpesaReceiptNumber?: string }> => {
    const req = await ctx.runQuery(internal.darajaInternal.getStkRequest, { id: args.stkRequestId as import("./_generated/dataModel.d.ts").Id<"stkRequests"> });

    // Re-use env vars (same as initiateSTKForPlot)
    const consumerKey = process.env.MPESA_CONSUMER_KEY;
    const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
    const shortCode = process.env.MPESA_SHORTCODE;
    const passkey = process.env.MPESA_PASSKEY;

    if (!req) return { status: "failed", resultDesc: "Request not found" };
    if (req.status !== "pending") return { status: req.status as "success" | "failed", mpesaReceiptNumber: req.mpesaReceiptNumber };
    if (!consumerKey || !consumerSecret || !shortCode || !passkey) {
      return { status: "pending", resultDesc: "Credentials not configured" };
    }

    try {
      const token = await getAccessToken(consumerKey, consumerSecret, "production");
      const timestamp = getTimestamp();
      const password = Buffer.from(`${shortCode}${passkey}${timestamp}`).toString("base64");

      const res = await fetch("https://api.safaricom.co.ke/mpesa/stkpushquery/v1/query", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          BusinessShortCode: shortCode,
          Password: password,
          Timestamp: timestamp,
          CheckoutRequestID: req.checkoutRequestId,
        }),
      });

      const data = await res.json() as {
        ResultCode?: string;
        ResultDesc?: string;
        CallbackMetadata?: { Item?: Array<{ Name: string; Value?: string | number }> };
      };

      const resultCode = String(data.ResultCode ?? "1");
      const resultDesc = data.ResultDesc ?? "";
      const items = data.CallbackMetadata?.Item ?? [];
      const receiptItem = items.find((i) => i.Name === "MpesaReceiptNumber");
      const mpesaReceiptNumber = receiptItem?.Value ? String(receiptItem.Value) : undefined;

      if (resultCode === "0") {
        await ctx.runMutation(internal.darajaInternal.resolveStkRequest, {
          id: req._id,
          status: "success",
          resultCode,
          resultDesc,
          mpesaReceiptNumber,
        });
        return { status: "success", mpesaReceiptNumber };
      } else if (resultCode === "1032" || resultCode === "2001") {
        // 1032 = cancelled by user, 2001 = wrong PIN
        await ctx.runMutation(internal.darajaInternal.resolveStkRequest, {
          id: req._id,
          status: "failed",
          resultCode,
          resultDesc,
        });
        return { status: "failed", resultDesc };
      } else {
        // Still pending (e.g. 1037 = DS timeout, request still in flight)
        return { status: "pending", resultDesc };
      }
    } catch {
      return { status: "pending", resultDesc: "Query failed, retrying…" };
    }
  },
});

// ── HTTP Callback handler ─────────────────────────────────────────────────────

export const handleCallback = internalAction({
  args: { body: v.string() },
  handler: async (ctx, args): Promise<void> => {
    let parsed: {
      Body?: {
        stkCallback?: {
          CheckoutRequestID?: string;
          ResultCode?: number;
          ResultDesc?: string;
          CallbackMetadata?: {
            Item?: Array<{ Name: string; Value?: string | number }>;
          };
        };
      };
    };

    try {
      parsed = JSON.parse(args.body) as typeof parsed;
    } catch {
      return;
    }

    const cb = parsed?.Body?.stkCallback;
    if (!cb?.CheckoutRequestID) return;

    const req = await ctx.runQuery(internal.darajaInternal.getStkRequestByCheckoutId, {
      checkoutRequestId: cb.CheckoutRequestID,
    });
    if (!req) return;

    const resultCode = String(cb.ResultCode ?? "1");
    const resultDesc = cb.ResultDesc ?? "";
    const items = cb.CallbackMetadata?.Item ?? [];
    const receiptItem = items.find((i) => i.Name === "MpesaReceiptNumber");
    const mpesaReceiptNumber = receiptItem?.Value ? String(receiptItem.Value) : undefined;

    if (resultCode === "0") {
      await ctx.runMutation(internal.darajaInternal.resolveStkRequest, {
        id: req._id,
        status: "success",
        resultCode,
        resultDesc,
        mpesaReceiptNumber,
      });
    } else {
      await ctx.runMutation(internal.darajaInternal.resolveStkRequest, {
        id: req._id,
        status: "failed",
        resultCode,
        resultDesc,
      });
    }
  },
});
