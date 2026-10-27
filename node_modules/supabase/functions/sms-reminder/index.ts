import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_PLOT_TEMPLATES: Record<string, string> = {
  sms_plot_reminder_5d:
    "Dear {name}, your plot {plotNumber} payment is due in 5 days ({deadlineDay}). Please pay to avoid late fees. - Egemeo Ardhi",
  sms_plot_reminder_1d:
    "Dear {name}, your plot {plotNumber} payment is due TOMORROW ({deadlineDay}). Please pay today. - Egemeo Ardhi",
  sms_plot_reminder_0d:
    "Dear {name}, your plot {plotNumber} payment is due TODAY ({deadlineDay}). Pay now to avoid being marked late. - Egemeo Ardhi",
};

function normalisePhone(phone: string): string {
  return phone.trim().replace(/\s+/g, "")
    .replace(/^\+254/, "254")
    .replace(/^07/, "2547")
    .replace(/^7(\d{8})$/, "2547$1");
}

function interpolate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (message, [key, value]) => message.replace(new RegExp(`\\{${key}\\}`, "g"), value),
    template,
  );
}

function ordinal(day: number): string {
  const mod100 = day % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${day}th`;
  if (day % 10 === 1) return `${day}st`;
  if (day % 10 === 2) return `${day}nd`;
  if (day % 10 === 3) return `${day}rd`;
  return `${day}th`;
}

async function sendViaAfricasTalking(cfg: any, to: string, message: string) {
  const body = new URLSearchParams({ username: cfg.username, to, message });
  if (cfg.senderId) body.set("from", cfg.senderId);
  const res = await fetch("https://api.africastalking.com/version1/messaging", {
    method: "POST",
    headers: {
      "apiKey": cfg.apiKey,
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Africa's Talking error ${res.status}: ${await res.text()}`);
}

async function resolveMemberPhone(
  supabase: any,
  memberId: number,
  memberRole: "shareholder" | "client",
  directPhone?: string | null,
): Promise<string | null> {
  if (directPhone?.trim()) return directPhone.trim();
  const { data: profile } = await supabase
    .from("user_profiles")
    .select("email")
    .eq("member_id", memberId)
    .eq("role", memberRole)
    .maybeSingle();
  if (!profile?.email) return null;
  return profile.email.replace(/@.*$/, "") || null;
}

async function runPlotReminders(supabase: any, settings: any, atCfg: any, eatNow: Date) {
  const eatYear = eatNow.getUTCFullYear();
  const eatMonth = eatNow.getUTCMonth();
  const eatDay = eatNow.getUTCDate();
  const todayMs = Date.UTC(eatYear, eatMonth, eatDay);
  const todayStr = `${eatYear}-${String(eatMonth + 1).padStart(2, "0")}-${String(eatDay).padStart(2, "0")}`;
  const thresholds = new Set([5, 1, 0]);
  const triggerMap: Record<number, string> = {
    5: "sms_plot_reminder_5d",
    1: "sms_plot_reminder_1d",
    0: "sms_plot_reminder_0d",
  };

  const { data: plots, error: plotsError } = await supabase
    .from("plots")
    .select("id, plot_number, price, paid_amount, assigned_to_id, assigned_to_type, deadline")
    .eq("status", "assigned")
    .not("assigned_to_id", "is", null)
    .not("deadline", "is", null)
    .gt("price", 0);
  if (plotsError) throw plotsError;
  if (!plots?.length) return { sent: 0, failed: 0, skipped: 0, noPhone: 0 };

  // Reconcile from payment history where rows exist while retaining stored
  // totals for legacy plots whose historical payments predate plot_payments.
  const plotIds = plots.map((plot: any) => Number(plot.id));
  const { data: payments } = await supabase
    .from("plot_payments")
    .select("plot_id, amount")
    .in("plot_id", plotIds);
  const paidByPlot: Record<number, number> = {};
  for (const payment of payments ?? []) {
    const plotId = Number(payment.plot_id);
    paidByPlot[plotId] = (paidByPlot[plotId] ?? 0) + Number(payment.amount);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;
  let noPhone = 0;

  for (const plot of plots) {
    // Use the same rule as Project Debt Management and the dashboard:
    // payment-history sum when present, otherwise the stored legacy total.
    const paid = paidByPlot[Number(plot.id)] ?? Number(plot.paid_amount ?? 0);
    const balance = Number(plot.price) - paid;
    if (balance <= 0 || !plot.deadline) {
      skipped++;
      continue;
    }

    const deadlineDay = Number(String(plot.deadline).split("-")[2] ?? "0");
    if (!deadlineDay) {
      skipped++;
      continue;
    }

    let dueMs = Date.UTC(eatYear, eatMonth, deadlineDay);
    if (todayMs > dueMs) dueMs = Date.UTC(eatYear, eatMonth + 1, deadlineDay);
    const daysLeft = Math.round((dueMs - todayMs) / DAY_MS);
    if (!thresholds.has(daysLeft)) {
      skipped++;
      continue;
    }

    const triggerId = triggerMap[daysLeft];
    if (settings.smsTriggers?.[triggerId] === false) {
      skipped++;
      continue;
    }

    const memberRole = plot.assigned_to_type === "shareholder" ? "shareholder" : "client";
    const memberTable = memberRole === "shareholder" ? "shareholders" : "clients";
    const { data: member } = await supabase
      .from(memberTable)
      .select("id, name, phone")
      .eq("id", plot.assigned_to_id)
      .maybeSingle();
    if (!member) {
      skipped++;
      continue;
    }

    const phone = await resolveMemberPhone(supabase, Number(member.id), memberRole, member.phone);
    if (!phone) {
      noPhone++;
      continue;
    }

    // app_settings.key is unique, making this an atomic cross-session and
    // cross-invocation claim: one client/member, one plot, one reminder type,
    // one EAT calendar day.
    const claimKey = `plot_reminder:${todayStr}:${triggerId}:${plot.id}:${memberRole}:${member.id}`;
    const { error: claimError } = await supabase.from("app_settings").insert({
      key: claimKey,
      value: {
        plot_id: plot.id,
        member_id: member.id,
        member_role: memberRole,
        reminder_date: todayStr,
        trigger: triggerId,
        status: "sending",
      },
      updated_at: new Date().toISOString(),
    });
    if (claimError) {
      skipped++;
      continue;
    }

    const template = settings.messageTemplates?.[triggerId]?.trim()
      || DEFAULT_PLOT_TEMPLATES[triggerId];
    const message = interpolate(template, {
      name: member.name.split(" ")[0],
      plotNumber: plot.plot_number ?? String(plot.id),
      deadlineDay: ordinal(deadlineDay),
      days: String(daysLeft),
    });

    try {
      await sendViaAfricasTalking(atCfg, normalisePhone(phone), message);
      sent++;
      await supabase.from("app_settings").update({
        value: {
          plot_id: plot.id,
          member_id: member.id,
          member_role: memberRole,
          reminder_date: todayStr,
          trigger: triggerId,
          status: "sent",
          sent_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      }).eq("key", claimKey);
    } catch {
      failed++;
      // A failed delivery must not block a later retry on the same day.
      await supabase.from("app_settings").delete().eq("key", claimKey);
    }
  }

  return { sent, failed, skipped, noPhone };
}

async function runContributionReminders(supabase: any, settings: any, atCfg: any, eatNow: Date) {
  const dueDay: number = settings.contributionDueDay ?? 10;
  const eatYear = eatNow.getUTCFullYear();
  const eatMonth = eatNow.getUTCMonth();
  const eatDay = eatNow.getUTCDate();
  const todayMs = Date.UTC(eatYear, eatMonth, eatDay);

  let dueMs = Date.UTC(eatYear, eatMonth, dueDay);
  if (todayMs > dueMs) dueMs = Date.UTC(eatYear, eatMonth + 1, dueDay);
  const daysUntilDue = Math.round((dueMs - todayMs) / DAY_MS);
  const triggerMap: Record<number, string> = {
    5: "sms_reminder_5d",
    2: "sms_reminder_2d",
    1: "sms_reminder_1d",
    0: "sms_reminder_0d",
  };
  const triggerId = triggerMap[daysUntilDue];
  if (!triggerId || settings.smsTriggers?.[triggerId] === false) {
    return { sent: 0, failed: 0, skipped: true, daysUntilDue };
  }

  const dueDate = new Date(dueMs);
  const billingMonth0 = dueDate.getUTCMonth() - 1;
  const reminderYear = billingMonth0 < 0 ? dueDate.getUTCFullYear() - 1 : dueDate.getUTCFullYear();
  const reminderMonth = ((billingMonth0 % 12) + 12) % 12 + 1;

  const { data: shareholders } = await supabase
    .from("shareholders")
    .select("id, name, phone")
    .eq("status", "Active");
  const { data: paid } = await supabase
    .from("contributions")
    .select("shareholder_id")
    .eq("month", reminderMonth)
    .eq("year", reminderYear);
  const paidIds = new Set((paid ?? []).map((payment: any) => payment.shareholder_id));
  const monthLabel = `${MONTHS[reminderMonth - 1]} ${reminderYear}`;

  let sent = 0;
  let failed = 0;
  for (const shareholder of shareholders ?? []) {
    if (paidIds.has(shareholder.id)) continue;
    const phone = await resolveMemberPhone(supabase, shareholder.id, "shareholder", shareholder.phone);
    if (!phone) continue;
    const firstName = shareholder.name.split(" ")[0];
    const message = daysUntilDue === 0
      ? `Dear ${firstName}, your ${monthLabel} contribution is due TODAY. Pay now to avoid being marked late. - Egemeo Ardhi SACCO`
      : daysUntilDue === 1
        ? `Dear ${firstName}, your ${monthLabel} contribution is due TOMORROW. Please pay today to avoid being marked late. - Egemeo Ardhi SACCO`
        : `Dear ${firstName}, your ${monthLabel} contribution is due in ${daysUntilDue} days. Pay on time to avoid late fees. - Egemeo Ardhi SACCO`;
    try {
      await sendViaAfricasTalking(atCfg, normalisePhone(phone), message);
      sent++;
    } catch {
      failed++;
    }
  }
  return { sent, failed, daysUntilDue, reminderMonth, reminderYear };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: row } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", "sms_settings")
      .single();
    const settings = row?.value as any;

    if (!settings?.smsEnabled) {
      return new Response(JSON.stringify({ skipped: true, reason: "SMS disabled" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }
    if (settings?.providerConfig?.provider !== "africastalking") {
      return new Response(JSON.stringify({ skipped: true, reason: "Scheduled reminders currently require Africa's Talking" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const atCfg = settings.providerConfig.africastalking;
    if (!atCfg?.apiKey || !atCfg?.username) {
      return new Response(JSON.stringify({ skipped: true, reason: "Africa's Talking credentials are incomplete" }), {
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    // Shift UTC to EAT and then use UTC getters, making calendar calculations
    // deterministic regardless of the Edge Function host timezone.
    const eatNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
    const [plots, contributions] = await Promise.all([
      runPlotReminders(supabase, settings, atCfg, eatNow),
      runContributionReminders(supabase, settings, atCfg, eatNow),
    ]);

    return new Response(JSON.stringify({ ok: true, plots, contributions }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});
