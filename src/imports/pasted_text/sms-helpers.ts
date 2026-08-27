import { action, internalAction, internalQuery, internalMutation } from "./_generated/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
// ─── Types ───────────────────────────────────────────────────────────────────

type SmsProviderConfig = {
  provider: "oramobile" | "africastalking" | "";
  oramobile: { apiKey: string; senderId: string; username: string };
  africastalking: { apiKey: string; username: string; senderId: string };
};

type NotifSettings = {
  smsEnabled?: boolean;
  smsTriggers?: Record<string, boolean>;
  providerConfig?: SmsProviderConfig;
};

// ─── Internal query: read notification settings ───────────────────────────────

export const getNotifSettingsQuery = internalQuery({
  args: {},
  handler: async (ctx): Promise<unknown> => {
    const row = await ctx.db
      .query("saccoSettings")
      .withIndex("by_key", (q) => q.eq("key", "notifications"))
      .first();
    return row ? (JSON.parse(row.value) as unknown) : null;
  },
});

// ─── Internal query: check if a member has smsEnabled ────────────────────────

export const getMemberSmsEnabled = internalQuery({
  args: {
    memberId: v.string(),
    memberTable: v.union(v.literal("shareholders"), v.literal("clients"), v.literal("externalFunders")),
  },
  handler: async (ctx, args): Promise<boolean> => {
    if (args.memberTable === "shareholders") {
      const sh = await ctx.db
        .query("shareholders")
        .filter((q) => q.eq(q.field("_id"), args.memberId))
        .first();
      return sh?.smsEnabled ?? false;
    }
    if (args.memberTable === "clients") {
      const cl = await ctx.db
        .query("clients")
        .filter((q) => q.eq(q.field("_id"), args.memberId))
        .first();
      return cl?.smsEnabled ?? false;
    }
    // externalFunders
    const ef = await ctx.db
      .query("externalFunders")
      .filter((q) => q.eq(q.field("_id"), args.memberId))
      .first();
    return ef?.smsEnabled ?? false;
  },
});

// ─── Internal action: send SMS only if member has smsEnabled ─────────────────
// Use this for all payment-related notifications

export const sendMemberSms = internalAction({
  args: {
    to: v.string(),
    message: v.string(),
    memberId: v.string(),
    memberTable: v.union(v.literal("shareholders"), v.literal("clients"), v.literal("externalFunders")),
    triggerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    // Check member's own smsEnabled toggle first
    const memberEnabled = await ctx.runQuery(internal.sms.getMemberSmsEnabled, {
      memberId: args.memberId,
      memberTable: args.memberTable,
    });
    if (!memberEnabled) return { ok: false, error: "Member SMS disabled" };
    // Delegate to the global sendSms which checks provider config
    return await ctx.runAction(internal.sms.sendSms, {
      to: args.to,
      message: args.message,
      triggerId: args.triggerId,
    });
  },
});

// ─── Provider helpers ─────────────────────────────────────────────────────────

async function sendViaOramobile(
  config: SmsProviderConfig["oramobile"],
  to: string,
  message: string
): Promise<void> {
  // Oramobile uses Infobip-based API — API keys use "App" prefix, not Basic Auth
  const res = await fetch("http://api.messaging-service.com/restapi/sms/1/text/single", {
    method: "POST",
    headers: {
      Authorization: `App ${config.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      from: config.senderId || "SACCO",
      to,
      text: message,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Oramobile error ${res.status}: ${body}`);
  }
}

async function sendViaAfricasTalking(
  config: SmsProviderConfig["africastalking"],
  to: string,
  message: string
): Promise<void> {
  const body = new URLSearchParams({
    username: config.username,
    to,
    message,
  });
  if (config.senderId) body.set("from", config.senderId);
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      apiKey: config.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Africa's Talking error ${res.status}: ${txt}`);
  }
}

// ─── Internal action: send a single SMS ──────────────────────────────────────

export const sendSms = internalAction({
  args: {
    to: v.string(),
    message: v.string(),
    /** Optional trigger id (e.g. "sms_contrib_receipt") – checked against per-trigger flags */
    triggerId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const raw = await ctx.runQuery(internal.sms.getNotifSettingsQuery, {});
    const settings = raw as NotifSettings | null;

    if (!settings?.smsEnabled) return { ok: false, error: "SMS disabled" };
    if (!settings.providerConfig?.provider) return { ok: false, error: "No provider configured" };

    // Check per-trigger toggle
    if (args.triggerId && settings.smsTriggers) {
      if (!settings.smsTriggers[args.triggerId]) return { ok: false, error: "Trigger disabled" };
    }

    const cfg = settings.providerConfig;
    try {
      if (cfg.provider === "oramobile") {
        await sendViaOramobile(cfg.oramobile, args.to, args.message);
      } else if (cfg.provider === "africastalking") {
        await sendViaAfricasTalking(cfg.africastalking, args.to, args.message);
      }
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("SMS send failed:", msg);
      return { ok: false, error: msg };
    }
  },
});

// ─── Public action: test SMS (called from frontend) ──────────────────────────

export const testSms = action({
  args: { to: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; error?: string }> => {
    const message =
      "Hello! This is a test message from your Sacco Management System. If you received this, your SMS provider is configured correctly. ✓";
    return await ctx.runAction(internal.sms.sendSms, { to: args.to, message });
  },
});
