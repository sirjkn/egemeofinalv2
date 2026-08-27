import { projectId, publicAnonKey } from "../../utils/supabase/info";

const PAYMENT_KEY = "sacco_payment_settings";
const DARAJA_KEY = "sacco_daraja_config";
const EDGE_BASE = `https://${projectId}.supabase.co/functions/v1`;

// ─── Payment settings (cash / bank / cheque only — M-Pesa handled via Daraja) ─

export interface PaymentSettings {
  methods: { cash: boolean; bank: boolean; cheque: boolean };
}

function defaultPaymentSettings(): PaymentSettings {
  return { methods: { cash: true, bank: true, cheque: true } };
}

export function getPaymentSettings(): PaymentSettings {
  try {
    const stored = localStorage.getItem(PAYMENT_KEY);
    if (!stored) return defaultPaymentSettings();
    const parsed = JSON.parse(stored);
    return { methods: { ...defaultPaymentSettings().methods, ...parsed.methods } };
  } catch {
    return defaultPaymentSettings();
  }
}

export function savePaymentSettings(s: PaymentSettings) {
  localStorage.setItem(PAYMENT_KEY, JSON.stringify(s));
}

// ─── Daraja (M-Pesa) configuration ────────────────────────────────────────────

export interface DarajaConfig {
  consumerKey: string;
  consumerSecret: string;
  shortCode: string;
  passkey: string;
  environment: "sandbox" | "production";
  callbackUrl: string;
  transactionType: "paybill" | "till";
}

export function defaultDarajaConfig(): DarajaConfig {
  return {
    consumerKey: "",
    consumerSecret: "",
    shortCode: "",
    passkey: "",
    environment: "production",
    callbackUrl: `https://${projectId}.supabase.co/functions/v1/mpesa-callback`,
    transactionType: "paybill",
  };
}

export function getDarajaConfig(): DarajaConfig {
  try {
    const stored = localStorage.getItem(DARAJA_KEY);
    if (!stored) return defaultDarajaConfig();
    return { ...defaultDarajaConfig(), ...JSON.parse(stored) };
  } catch {
    return defaultDarajaConfig();
  }
}

export function saveDarajaConfig(c: DarajaConfig) {
  localStorage.setItem(DARAJA_KEY, JSON.stringify(c));
}

// ─── STK Push types ───────────────────────────────────────────────────────────

export interface StkPushResult {
  checkoutRequestId: string;
  ResponseCode?: string;
  ResponseDescription?: string;
  CustomerMessage?: string;
  MerchantRequestID?: string;
  _debug?: { apiBase: string; environment: string; formattedPhone?: string; shortCode?: string; transactionType?: string; callbackUrl?: string };
}

export interface StkQueryResult {
  status: "pending" | "success" | "failed";
  resultCode?: string;
  resultDesc?: string;
  receipt?: string;
}

// ─── STK Push (initiate) ──────────────────────────────────────────────────────

export async function mpesaStkPush(params: {
  config: DarajaConfig;
  amount: number;
  phone: string;
  accountRef: string;
  description: string;
}): Promise<StkPushResult> {
  const normalised = params.phone.trim().replace(/^\+/, "").replace(/^0/, "254");
  const res = await fetch(`${EDGE_BASE}/mpesa-stk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": publicAnonKey,
      "Authorization": `Bearer ${publicAnonKey}`,
    },
    body: JSON.stringify({
      action: "push",
      config: params.config,
      amount: params.amount,
      phone: normalised,
      accountRef: params.accountRef.slice(0, 12),
      description: params.description.slice(0, 50),
    }),
  });
  const data = await res.json().catch(() => ({ success: false, error: res.statusText }));
  if (!data.success) throw new Error(data.error || "STK push failed");
  return {
    checkoutRequestId:   data.CheckoutRequestID   ?? "",
    ResponseCode:        data.ResponseCode,
    ResponseDescription: data.ResponseDescription,
    CustomerMessage:     data.CustomerMessage,
    MerchantRequestID:   data.MerchantRequestID,
    _debug:              data._debug,
  };
}

// ─── STK Query (poll status) ──────────────────────────────────────────────────

export async function mpesaStkQuery(params: {
  config: DarajaConfig;
  checkoutRequestId: string;
}): Promise<StkQueryResult> {
  const res = await fetch(`${EDGE_BASE}/mpesa-stk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": publicAnonKey,
      "Authorization": `Bearer ${publicAnonKey}`,
    },
    body: JSON.stringify({
      action: "query",
      config: params.config,
      checkoutRequestId: params.checkoutRequestId,
    }),
  });
  const data = await res.json().catch(() => ({ success: false }));

  const resultCode = String(
    data.ResultCode ?? data.errorCode ?? "1037"
  );

  if (resultCode === "0") {
    const items: Array<{ Name: string; Value?: string | number }> =
      data.CallbackMetadata?.Item ?? [];
    const receiptItem = items.find((i) => i.Name === "MpesaReceiptNumber");
    return {
      status: "success",
      resultCode,
      resultDesc: data.ResultDesc,
      receipt: receiptItem?.Value ? String(receiptItem.Value) : undefined,
    };
  }

  // User cancelled or wrong PIN → terminal failure
  if (resultCode === "1032" || resultCode === "2001") {
    return { status: "failed", resultCode, resultDesc: data.ResultDesc };
  }

  // "The transaction is being processed" or other transient codes → still pending
  return { status: "pending", resultCode, resultDesc: data.ResultDesc };
}
