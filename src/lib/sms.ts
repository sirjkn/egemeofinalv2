import { projectId, publicAnonKey } from "../../utils/supabase/info";

const SMS_KEY = "sacco_sms_settings";
const EDGE_BASE = `https://${projectId}.supabase.co/functions/v1`;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SmsProviderConfig {
  provider: "africastalking" | "oramobile";
  africastalking: { apiKey: string; username: string; senderId: string };
  oramobile: { username: string; password: string; apiKey: string; senderId: string };
}

export interface SmsSettings {
  smsEnabled: boolean;
  providerConfig: SmsProviderConfig;
  smsTriggers: Record<string, boolean>;
  contributionDueDay: number;
  messageTemplates: Record<string, string>;
}

// ─── Trigger IDs ──────────────────────────────────────────────────────────────

export const SMS_TRIGGERS = {
  newUser:          "sms_new_user",
  contribReceipt:   "sms_contrib_receipt",
  plotAssigned:     "sms_plot_assigned",
  reminder5d:       "sms_reminder_5d",
  reminder2d:       "sms_reminder_2d",
  reminder1d:       "sms_reminder_1d",
  reminderToday:    "sms_reminder_0d",
  passwordReminder: "sms_password_reminder",
} as const;

// ─── Default message templates ────────────────────────────────────────────────

export const DEFAULT_TEMPLATES: Record<string, string> = {
  sms_new_user:
    "Welcome to Egemeo Ardhi SACCO, {name}! Your login phone: {phone}. Your password is your phone number — please change it after first login. - Egemeo Ardhi SACCO",
  sms_contrib_receipt:
    "Dear {name}, your contribution of {amount} for {month} has been received.{ref} Thank you. - Egemeo Ardhi SACCO",
  sms_plot_assigned:
    "Dear {name}, plot {plotNo} in {project} has been assigned to you. Total: {amount}. Welcome! - Egemeo Ardhi SACCO",
  sms_password_reminder:
    "Dear {name}, your password is your phone number: {phone}. Please log in and change it. - Egemeo Ardhi SACCO",
  sms_reminder_5d:
    "Dear {name}, your {month} contribution is due in 5 days. Pay on time to avoid late fees. - Egemeo Ardhi SACCO",
  sms_reminder_2d:
    "Dear {name}, your {month} contribution is due in 2 days. Pay on time to avoid late fees. - Egemeo Ardhi SACCO",
  sms_reminder_1d:
    "Dear {name}, your {month} contribution is due TOMORROW. Please pay today to avoid being marked late. - Egemeo Ardhi SACCO",
  sms_reminder_0d:
    "Dear {name}, your {month} contribution is due TODAY. Pay now to avoid being marked late. - Egemeo Ardhi SACCO",
};

// Substitute {variable} placeholders in a template string
export function interpolate(template: string, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (t, [key, val]) => t.replace(new RegExp(`\\{${key}\\}`, "g"), val),
    template,
  );
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

function defaults(): SmsSettings {
  const triggers: Record<string, boolean> = {};
  Object.values(SMS_TRIGGERS).forEach((id) => { triggers[id] = true; });
  return {
    smsEnabled: false,
    providerConfig: {
      provider: "africastalking",
      africastalking: { apiKey: "", username: "", senderId: "EgemeoArdhi" },
      oramobile: { username: "", password: "", apiKey: "", senderId: "EgemeoArdhi" },
    },
    smsTriggers: triggers,
    contributionDueDay: 5,
    messageTemplates: {},
  };
}

// ─── Load / save ──────────────────────────────────────────────────────────────

export function mergeSmsSettings(saved: any): SmsSettings {
  const d = defaults();
  if (!saved || typeof saved !== "object") return d;
  return {
    ...d,
    ...saved,
    providerConfig: {
      ...d.providerConfig,
      ...(saved.providerConfig ?? {}),
      africastalking: { ...d.providerConfig.africastalking, ...(saved.providerConfig?.africastalking ?? {}) },
      oramobile: { ...d.providerConfig.oramobile, ...(saved.providerConfig?.oramobile ?? {}) },
    },
    smsTriggers: { ...d.smsTriggers, ...(saved.smsTriggers ?? {}) },
    messageTemplates: { ...(saved.messageTemplates ?? {}) },
  };
}

export function getSmsSettings(): SmsSettings {
  try {
    const stored = localStorage.getItem(SMS_KEY);
    if (!stored) return defaults();
    return mergeSmsSettings(JSON.parse(stored));
  } catch {
    return defaults();
  }
}

export function saveSmsSettings(s: SmsSettings) {
  localStorage.setItem(SMS_KEY, JSON.stringify(s));
}

// ─── Phone normalisation ──────────────────────────────────────────────────────

function normalisePhone(phone: string): string {
  return phone.trim()
    .replace(/\s+/g, "")
    .replace(/^\+254/, "254")
    .replace(/^07/, "2547")
    .replace(/^7(\d{8})$/, "2547$1");
}

// ─── Send ─────────────────────────────────────────────────────────────────────

export async function sendSms(
  phone: string,
  message: string,
  triggerId?: string,
  cfg?: SmsSettings,
): Promise<void> {
  const s = cfg ?? getSmsSettings();
  if (!s.smsEnabled) throw new Error("SMS is disabled. Enable it in Settings → SMS Notifications.");
  const p = s.providerConfig.provider;
  if (p === "oramobile") {
    const ora = s.providerConfig.oramobile;
    if (!ora.username || !ora.password) throw new Error("Oramobile credentials not configured. Go to Settings → SMS Notifications.");
  } else {
    const at = s.providerConfig.africastalking;
    if (!at.apiKey || !at.username) throw new Error("Africa's Talking credentials not configured. Go to Settings → SMS Notifications.");
  }
  if (triggerId && s.smsTriggers[triggerId] === false) throw new Error(`SMS trigger "${triggerId}" is disabled.`);

  const to = normalisePhone(phone);
  const res = await fetch(`${EDGE_BASE}/sms-send`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": publicAnonKey,
      "Authorization": `Bearer ${publicAnonKey}`,
    },
    body: JSON.stringify({
      to,
      message,
      providerConfig: s.providerConfig,
    }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: res.statusText }));
  if (!res.ok || !data.ok) throw new Error(data.error ?? `SMS failed (${res.status})`);
  if (data.warning) throw new Error(data.warning);
}

// ─── Message templates (use stored custom templates when available) ────────────

function getTpl(triggerId: string): string {
  try {
    const s = getSmsSettings();
    const custom = s.messageTemplates?.[triggerId];
    return (custom && custom.trim()) ? custom : (DEFAULT_TEMPLATES[triggerId] ?? "");
  } catch {
    return DEFAULT_TEMPLATES[triggerId] ?? "";
  }
}

export const smsTemplates = {
  newUser: (name: string, phone: string) =>
    interpolate(getTpl(SMS_TRIGGERS.newUser), { name, phone }),

  passwordReminder: (name: string, phone: string) =>
    interpolate(getTpl(SMS_TRIGGERS.passwordReminder), { name, phone }),

  contribReceipt: (name: string, amount: string, month: string, ref?: string) =>
    interpolate(getTpl(SMS_TRIGGERS.contribReceipt), {
      name, amount, month,
      ref: ref ? ` Ref: ${ref}.` : "",
    }),

  plotAssigned: (name: string, plotNo: string, project: string, amount: string) =>
    interpolate(getTpl(SMS_TRIGGERS.plotAssigned), { name, plotNo, project, amount }),

  reminder: (name: string, month: string, daysUntil: number) => {
    const id = daysUntil === 0 ? SMS_TRIGGERS.reminderToday
             : daysUntil === 1 ? SMS_TRIGGERS.reminder1d
             : daysUntil <= 2  ? SMS_TRIGGERS.reminder2d
             :                   SMS_TRIGGERS.reminder5d;
    return interpolate(getTpl(id), { name, month, days: String(daysUntil) });
  },
};
