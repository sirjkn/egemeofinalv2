import { supabase } from "@/lib/supabase";
import { getPaymentSettings, savePaymentSettings, type PaymentSettings, getDarajaConfig, saveDarajaConfig, defaultDarajaConfig, type DarajaConfig } from "@/lib/mpesa";
import { getSmsSettings, saveSmsSettings, type SmsSettings } from "@/lib/sms";

// ─── Generic DB-backed settings ───────────────────────────────────────────────

async function dbLoad<T>(key: string): Promise<T | null> {
  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error || !data) return null;
  return data.value as T;
}

async function dbSave<T>(key: string, value: T): Promise<void> {
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

// ─── Payment settings ─────────────────────────────────────────────────────────

export async function loadPaymentSettingsFromDb(): Promise<PaymentSettings> {
  const remote = await dbLoad<PaymentSettings>("payment_settings");
  if (remote) {
    savePaymentSettings(remote); // keep localStorage in sync as cache
    return remote;
  }
  return getPaymentSettings(); // fall back to localStorage
}

export async function savePaymentSettingsToDb(cfg: PaymentSettings): Promise<void> {
  savePaymentSettings(cfg); // write to localStorage immediately (for in-session use)
  await dbSave("payment_settings", cfg);
}

// ─── Daraja (M-Pesa) configuration ────────────────────────────────────────────

export async function loadDarajaConfigFromDb(): Promise<DarajaConfig> {
  const remote = await dbLoad<DarajaConfig>("daraja_config");
  if (remote) {
    saveDarajaConfig({ ...defaultDarajaConfig(), ...remote });
    return { ...defaultDarajaConfig(), ...remote };
  }
  return getDarajaConfig();
}

export async function saveDarajaConfigToDb(cfg: DarajaConfig): Promise<void> {
  saveDarajaConfig(cfg);
  await dbSave("daraja_config", cfg);
}

// ─── Enabled payment methods helper ──────────────────────────────────────────

/** Returns the list of enabled payment method keys, always including "mpesa".
 *  Loads from DB; falls back to localStorage if DB is unreachable. */
export async function getEnabledPaymentMethodKeys(): Promise<string[]> {
  const cfg = await loadPaymentSettingsFromDb().catch(() => getPaymentSettings());
  // Explicitly enumerate cash/bank/cheque to prevent accidental mpesa duplication
  const extra = (["cash", "bank", "cheque"] as const).filter((k) => (cfg.methods as any)[k]);
  return [...new Set(["mpesa", ...extra])];
}

// ─── SMS / Notification settings ─────────────────────────────────────────────

export async function loadSmsSettingsFromDb(): Promise<SmsSettings> {
  const remote = await dbLoad<SmsSettings>("sms_settings");
  if (remote) {
    saveSmsSettings(remote);
    return remote;
  }
  return getSmsSettings();
}

export async function saveSmsSettingsToDb(cfg: SmsSettings): Promise<void> {
  saveSmsSettings(cfg); // always save locally first so it's never lost
  await dbSave("sms_settings", cfg); // then sync to DB (throws on RLS failure)
}

// ─── Reminder templates (stored separately for reliability) ──────────────────

export async function loadReminderTemplates(): Promise<{ plot: string; contribution: string }> {
  const PLOT_DEFAULT = "Dear {firstName}, please make payment for your plot {plotNumber} before deadline {deadline}. Regards, Egemeo Ardhi";
  const CONTRIB_DEFAULT = "Dear {firstName}, this is a reminder to make your contribution on or before {deadline}. Regards, Egemeo Ardhi";
  try {
    const stored = localStorage.getItem("sacco_reminder_templates");
    const local = stored ? JSON.parse(stored) : {};
    // Also try DB
    const db = await dbLoad<{ plot: string; contribution: string }>("reminder_templates").catch(() => null);
    return {
      plot: db?.plot ?? local.plot ?? PLOT_DEFAULT,
      contribution: db?.contribution ?? local.contribution ?? CONTRIB_DEFAULT,
    };
  } catch {
    return {
      plot: PLOT_DEFAULT,
      contribution: CONTRIB_DEFAULT,
    };
  }
}

export async function saveReminderTemplates(templates: { plot: string; contribution: string }): Promise<void> {
  localStorage.setItem("sacco_reminder_templates", JSON.stringify(templates));
  await dbSave("reminder_templates", templates).catch(() => null); // soft fail
}
