import { supabase } from "@/lib/supabase";

export interface CompanyDetails {
  name: string;
  phone: string;
  email: string;
  website: string;
  location: string;
  logo_data_url: string;
}

const SETTINGS_KEY = "company_details";

export const DEFAULT_COMPANY: CompanyDetails = {
  name: "Egemeo Ardhi SACCO",
  phone: "",
  email: "",
  website: "",
  location: "",
  logo_data_url: "",
};

export async function getCompanyDetails(): Promise<CompanyDetails> {
  try {
    const { data } = await supabase
      .from("app_settings")
      .select("value")
      .eq("key", SETTINGS_KEY)
      .maybeSingle();
    if (!data?.value) return { ...DEFAULT_COMPANY };
    return { ...DEFAULT_COMPANY, ...(data.value as Partial<CompanyDetails>) };
  } catch {
    return { ...DEFAULT_COMPANY };
  }
}

export async function saveCompanyDetails(details: CompanyDetails): Promise<void> {
  const { error } = await supabase.from("app_settings").upsert(
    { key: SETTINGS_KEY, value: details, updated_at: new Date().toISOString() },
    { onConflict: "key" }
  );
  if (error) throw new Error(error.message);
}
