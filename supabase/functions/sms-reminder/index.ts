import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function normalisePhone(phone: string): string {
  return phone.trim().replace(/\s+/g, "")
    .replace(/^\+254/, "254")
    .replace(/^07/, "2547")
    .replace(/^7(\d{8})$/, "2547$1");
}

async function sendViaAfricasTalking(cfg: any, to: string, message: string) {
  const body = new URLSearchParams({ username: cfg.username, to, message });
  if (cfg.senderId) body.set("from", cfg.senderId);
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: { "apiKey": cfg.apiKey, "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Africa's Talking error ${res.status}: ${await res.text()}`);
}


serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Load SMS settings from app_settings table
  const { data: row } = await supabase.from("app_settings").select("value").eq("key", "sms_settings").single();
  const settings = row?.value as any;

  if (!settings?.smsEnabled) {
    return new Response(JSON.stringify({ skipped: true, reason: "SMS disabled" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (!settings?.providerConfig?.provider) {
    return new Response(JSON.stringify({ skipped: true, reason: "No provider configured" }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  const dueDay: number = settings.contributionDueDay ?? 5;
  const now = new Date();
  const today = now.getDate();

  // Determine which month we're reminding about
  let reminderMonth: number;
  let reminderYear: number;
  if (today <= dueDay + 5) {
    reminderMonth = now.getMonth() === 0 ? 12 : now.getMonth(); // 1-indexed, previous month
    reminderYear  = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  } else {
    reminderMonth = now.getMonth() + 1; // 1-indexed, current month
    reminderYear  = now.getFullYear();
  }

  // Days until due date
  const dueMonth = reminderMonth === 12 ? 1 : reminderMonth + 1;
  const dueYear  = reminderMonth === 12 ? reminderYear + 1 : reminderYear;
  const dueDate  = new Date(dueYear, dueMonth - 1, dueDay);
  const diffMs   = dueDate.getTime() - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const daysUntilDue = Math.round(diffMs / (1000 * 60 * 60 * 24));

  // Only fire on trigger days
  const triggerMap: Record<number, string> = { 5: "sms_reminder_5d", 2: "sms_reminder_2d", 1: "sms_reminder_1d", 0: "sms_reminder_0d" };
  const triggerId = triggerMap[daysUntilDue];
  if (!triggerId) {
    return new Response(JSON.stringify({ skipped: true, reason: `No reminder on day ${daysUntilDue} before due` }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
  if (settings.smsTriggers?.[triggerId] === false) {
    return new Response(JSON.stringify({ skipped: true, reason: `Trigger ${triggerId} disabled` }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }

  // Shareholders who haven't paid for the reminder month
  const { data: shareholders } = await supabase.from("shareholders").select("id, name, phone").eq("status", "Active");
  const { data: paid } = await supabase.from("contributions").select("shareholder_id").eq("month", reminderMonth).eq("year", reminderYear);
  const paidIds = new Set((paid ?? []).map((p: any) => p.shareholder_id));
  const unpaid = (shareholders ?? []).filter((s: any) => s.phone && !paidIds.has(s.id));

  const monthLabel = `${MONTHS[reminderMonth - 1]} ${reminderYear}`;
  const buildMsg = (name: string) => {
    const firstName = name.split(" ")[0];
    if (daysUntilDue === 0) return `Dear ${firstName}, your ${monthLabel} contribution is due TODAY. Pay now to avoid being marked late. - Egemeo Ardhi SACCO`;
    if (daysUntilDue === 1) return `Dear ${firstName}, your ${monthLabel} contribution is due TOMORROW. Please pay today to avoid being marked late. - Egemeo Ardhi SACCO`;
    return `Dear ${firstName}, your ${monthLabel} contribution is due in ${daysUntilDue} days. Pay on time to avoid late fees. - Egemeo Ardhi SACCO`;
  };

  const atCfg = settings.providerConfig?.africastalking;
  let sent = 0, failed = 0;
  for (const sh of unpaid) {
    try {
      await sendViaAfricasTalking(atCfg, normalisePhone(sh.phone), buildMsg(sh.name));
      sent++;
    } catch {
      failed++;
    }
  }

  return new Response(JSON.stringify({ ok: true, sent, failed, daysUntilDue, reminderMonth, reminderYear }), {
    headers: { ...cors, "Content-Type": "application/json" },
  });
});
