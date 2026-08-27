import { supabase } from "./supabase";

// ─── Health check ─────────────────────────────────────────────────────────────

export async function checkDbHealth(): Promise<{ connected: boolean; error?: string }> {
  try {
    const { error } = await supabase.from("shareholders").select("id").limit(1);
    if (error) return { connected: false, error: error.message };
    return { connected: true };
  } catch (err: any) {
    return { connected: false, error: err.message };
  }
}

// ─── Photo upload ─────────────────────────────────────────────────────────────

export async function uploadPhoto(file: File): Promise<string> {
  const ext = file.name.split(".").pop() || "jpg";
  const path = `photos/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
  const { error } = await supabase.storage.from("member-photos").upload(path, file, { upsert: true });
  if (error) throw new Error(error.message);
  const { data } = supabase.storage.from("member-photos").getPublicUrl(path);
  return data.publicUrl;
}

// ─── Shared types ─────────────────────────────────────────────────────────────

export interface MemberPayload {
  name: string;
  phone: string;
  email?: string;
  id_passport?: string;
  joined_date?: string;
  status?: "Active" | "Inactive";
  photo_url?: string;
  member_number?: number | string;
}

const AVATAR_COLORS = [
  "#14b8a6","#6366f1","#8b5cf6","#f59e0b","#ef4444",
  "#22c55e","#f97316","#3b82f6","#ec4899","#0ea5e9",
];

function randomColor(count: number) {
  return AVATAR_COLORS[count % AVATAR_COLORS.length];
}

async function nextMemberNumber(table: string): Promise<number> {
  const { data } = await supabase
    .from(table)
    .select("member_number")
    .order("member_number", { ascending: false })
    .limit(1);
  const max = data?.[0]?.member_number;
  const n = Number(max);
  return isFinite(n) && n > 0 ? n + 1 : 1;
}

async function checkPhoneConflict(phone: string, excludeTable?: string, excludeId?: number) {
  const tables = ["shareholders", "clients", "investors"];
  for (const table of tables) {
    if (table === excludeTable) continue;
    let q = supabase.from(table).select("id").eq("phone", phone);
    const { data } = await q;
    if (data && data.length > 0) return table.slice(0, -1); // 'shareholder' | 'client' | 'investor'
  }
  if (excludeTable && excludeId) {
    const { data } = await supabase.from(excludeTable).select("id").eq("phone", phone).neq("id", excludeId);
    if (data && data.length > 0) return excludeTable.slice(0, -1);
  }
  return null;
}

// ─── Shareholder ──────────────────────────────────────────────────────────────

export interface Shareholder {
  id: number;
  member_number: number;
  name: string;
  phone: string;
  email: string;
  id_passport: string;
  joined_date: string;
  status: "Active" | "Inactive";
  avatar_color: string;
  photo_url: string | null;
  net_savings: number;
  total_profits: number;
  contributions_count: number;
}

export const shareholdersApi = {
  list: async (params?: { status?: string; search?: string }): Promise<Shareholder[]> => {
    let q = supabase.from("shareholders").select("*").order("member_number");
    if (params?.status) q = q.eq("status", params.status);
    if (params?.search) q = q.or(`name.ilike.%${params.search}%,phone.ilike.%${params.search}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  get: async (id: number): Promise<Shareholder> => {
    const { data, error } = await supabase.from("shareholders").select("*").eq("id", id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  create: async (p: MemberPayload): Promise<Shareholder> => {
    if (!p.name?.trim()) throw new Error("Name is required");
    if (!p.phone?.trim()) throw new Error("Phone is required");
    const conflict = await checkPhoneConflict(p.phone.trim());
    if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);
    const { data: existing } = await supabase.from("shareholders").select("id").eq("phone", p.phone.trim());
    if (existing && existing.length > 0) throw new Error("Phone already exists");

    const { count } = await supabase.from("shareholders").select("*", { count: "exact", head: true });
    const nextNum = await nextMemberNumber("shareholders");

    const { data, error } = await supabase.from("shareholders").insert({
      member_number: p.member_number ?? nextNum,
      name: p.name.trim(),
      phone: p.phone.trim(),
      email: p.email?.trim() || null,
      id_passport: p.id_passport?.trim() || null,
      joined_date: p.joined_date || new Date().toISOString().slice(0, 10),
      status: p.status || "Active",
      avatar_color: randomColor(count ?? 0),
      photo_url: p.photo_url || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  update: async (id: number, p: Partial<MemberPayload>): Promise<Shareholder> => {
    if (p.phone) {
      const conflict = await checkPhoneConflict(p.phone.trim(), "shareholders", id);
      if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);
    }
    const patch: any = {};
    if (p.name !== undefined)        patch.name         = p.name.trim();
    if (p.phone !== undefined)       patch.phone        = p.phone.trim();
    if (p.email !== undefined)       patch.email        = p.email?.trim() || null;
    if (p.id_passport !== undefined) patch.id_passport  = p.id_passport?.trim() || null;
    if (p.joined_date !== undefined) patch.joined_date  = p.joined_date;
    if (p.status !== undefined)      patch.status       = p.status;
    if (p.photo_url !== undefined)   patch.photo_url    = p.photo_url;
    if (p.member_number !== undefined) patch.member_number = p.member_number;
    const { data, error } = await supabase.from("shareholders").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  setStatus: async (id: number, status: "Active" | "Inactive"): Promise<Shareholder> => {
    const { data, error } = await supabase.from("shareholders").update({ status }).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    // Find auth profile before deleting (need userId to delete auth account)
    const { data: profile } = await supabase
      .from("user_profiles").select("id").eq("member_id", id).maybeSingle();

    // Delete all contributions and related savings data
    await supabase.from("contributions").delete().eq("shareholder_id", id);
    await supabase.from("refunds").delete().eq("shareholder_id", id);
    await supabase.from("payments").delete().eq("member_id", id);

    // Delete project memberships and profit distributions
    await supabase.from("project_shareholders").delete().eq("shareholder_id", id);
    await supabase.from("profit_distributions").delete().eq("shareholder_id", id);

    // Delete plot co-ownerships
    await supabase.from("plot_co_owners")
      .delete().eq("member_id", id).eq("member_type", "shareholder");

    // Delete plot payments and unassign plots owned by this shareholder
    const { data: ownedPlots } = await supabase
      .from("plots").select("id").eq("assigned_to_id", id).eq("assigned_to_type", "shareholder");
    if (ownedPlots?.length) {
      const plotIds = ownedPlots.map((p: any) => p.id);
      await supabase.from("plot_payments").delete().in("plot_id", plotIds);
      await supabase.from("plots")
        .update({ assigned_to_id: null, assigned_to_type: null, paid_amount: 0, status: "available" })
        .in("id", plotIds);
    }

    // Delete user profile and Supabase auth account
    if (profile) {
      await supabase.from("user_profiles").delete().eq("id", profile.id);
      await supabase.functions.invoke("delete-auth-user", { body: { userId: profile.id } }).catch(() => {});
    }

    // Finally delete the member record
    const { error } = await supabase.from("shareholders").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  checkPhone: async (phone: string) => {
    const conflict = await checkPhoneConflict(phone);
    return { available: !conflict, conflict: conflict ? { phone, member_type: conflict } : null };
  },
};

// ─── Client ───────────────────────────────────────────────────────────────────

export interface Client {
  id: number;
  member_number: string;
  name: string;
  phone: string;
  email: string;
  id_passport: string;
  joined_date: string;
  status: "Active" | "Inactive";
  avatar_color: string;
  photo_url: string | null;
  loan_balance: number;
}

const CLIENT_AVATAR_COLORS = [
  "#a855f7","#14b8a6","#6366f1","#8b5cf6","#f59e0b",
  "#ef4444","#22c55e","#f97316","#3b82f6","#ec4899",
];

export const clientsApi = {
  list: async (params?: { status?: string; search?: string }): Promise<Client[]> => {
    let q = supabase.from("clients").select("*").order("member_number");
    if (params?.status) q = q.eq("status", params.status);
    if (params?.search) q = q.or(`name.ilike.%${params.search}%,phone.ilike.%${params.search}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  get: async (id: number): Promise<Client> => {
    const { data, error } = await supabase.from("clients").select("*").eq("id", id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  create: async (p: MemberPayload): Promise<Client> => {
    if (!p.name?.trim()) throw new Error("Name is required");
    if (!p.phone?.trim()) throw new Error("Phone is required");
    const conflict = await checkPhoneConflict(p.phone.trim());
    if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);

    const { count } = await supabase.from("clients").select("*", { count: "exact", head: true });

    // Auto-generate client number as "EC001", "EC002", …
    let clientNumber: string;
    if (p.member_number !== undefined && p.member_number !== null && String(p.member_number).trim() !== "") {
      clientNumber = String(p.member_number).trim();
    } else {
      const { data: maxRow } = await supabase.from("clients").select("member_number").order("created_at", { ascending: false }).limit(1);
      const last = maxRow?.[0]?.member_number ?? "EC000";
      const lastNum = parseInt(String(last).replace(/\D/g, ""), 10);
      const next = isFinite(lastNum) ? lastNum + 1 : (count ?? 0) + 1;
      clientNumber = `EC${String(next).padStart(3, "0")}`;
    }

    const { data, error } = await supabase.from("clients").insert({
      member_number: clientNumber,
      name: p.name.trim(),
      phone: p.phone.trim(),
      email: p.email?.trim() || null,
      id_passport: p.id_passport?.trim() || null,
      joined_date: p.joined_date || new Date().toISOString().slice(0, 10),
      status: p.status || "Active",
      avatar_color: CLIENT_AVATAR_COLORS[count ?? 0 % CLIENT_AVATAR_COLORS.length],
      photo_url: p.photo_url || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  update: async (id: number, p: Partial<MemberPayload>): Promise<Client> => {
    if (p.phone) {
      const conflict = await checkPhoneConflict(p.phone.trim(), "clients", id);
      if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);
    }
    const patch: any = {};
    if (p.name !== undefined)        patch.name         = p.name.trim();
    if (p.phone !== undefined)       patch.phone        = p.phone.trim();
    if (p.email !== undefined)       patch.email        = p.email?.trim() || null;
    if (p.id_passport !== undefined) patch.id_passport  = p.id_passport?.trim() || null;
    if (p.joined_date !== undefined) patch.joined_date  = p.joined_date;
    if (p.status !== undefined)      patch.status       = p.status;
    if (p.photo_url !== undefined)   patch.photo_url    = p.photo_url;
    if (p.member_number !== undefined) patch.member_number = p.member_number;
    const { data, error } = await supabase.from("clients").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  setStatus: async (id: number, status: "Active" | "Inactive"): Promise<Client> => {
    const { data, error } = await supabase.from("clients").update({ status }).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    // Find auth profile before deleting
    const { data: profile } = await supabase
      .from("user_profiles").select("id").eq("member_id", id).maybeSingle();

    // Delete payments
    await supabase.from("payments").delete().eq("member_id", id);

    // Delete plot co-ownerships
    await supabase.from("plot_co_owners")
      .delete().eq("member_id", id).eq("member_type", "client");

    // Delete plot payments and unassign plots owned by this client
    const { data: ownedPlots } = await supabase
      .from("plots").select("id").eq("assigned_to_id", id).eq("assigned_to_type", "client");
    if (ownedPlots?.length) {
      const plotIds = ownedPlots.map((p: any) => p.id);
      await supabase.from("plot_payments").delete().in("plot_id", plotIds);
      await supabase.from("plots")
        .update({ assigned_to_id: null, assigned_to_type: null, paid_amount: 0, status: "available" })
        .in("id", plotIds);
    }

    // Delete user profile and Supabase auth account
    if (profile) {
      await supabase.from("user_profiles").delete().eq("id", profile.id);
      await supabase.functions.invoke("delete-auth-user", { body: { userId: profile.id } }).catch(() => {});
    }

    // Finally delete the member record
    const { error } = await supabase.from("clients").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  checkPhone: async (phone: string) => {
    const conflict = await checkPhoneConflict(phone);
    return { available: !conflict, conflict: conflict ? { phone, member_type: conflict } : null };
  },
};

// ─── Investor ─────────────────────────────────────────────────────────────────

export interface Investor {
  id: number;
  member_number: number;
  name: string;
  phone: string;
  email: string;
  id_passport: string;
  joined_date: string;
  status: "Active" | "Inactive";
  avatar_color: string;
  photo_url: string | null;
  investment_amount: number;
}

const INVESTOR_AVATAR_COLORS = [
  "#eab308","#f97316","#14b8a6","#6366f1","#8b5cf6",
  "#f59e0b","#ef4444","#22c55e","#3b82f6","#ec4899",
];

// ─── Contributions ────────────────────────────────────────────────────────────

export interface Contribution {
  id: number;
  shareholder_id: number;
  amount: number;
  month: number;
  year: number;
  payment_date: string | null;
  status: "paid" | "late";
  notes: string | null;
  created_at: string;
  penalty_amount?: number;
  penalty_status?: "unpaid" | "paid" | "waived" | "none";
}

export interface ContributionPayload {
  shareholder_id: number;
  amount: number;
  month: number;
  year: number;
  payment_date?: string;
  status?: "paid" | "late";
  notes?: string;
}

export interface ShareholderContributionSummary {
  shareholder: Shareholder;
  total: number;
  count: number;
  contributions: Contribution[];
}

export const contributionsApi = {
  listByShareholder: async (shareholder_id: number): Promise<Contribution[]> => {
    const { data, error } = await supabase.from("contributions").select("*")
      .eq("shareholder_id", shareholder_id)
      .order("year", { ascending: false })
      .order("month", { ascending: false })
      .order("payment_date", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  list: async (params?: { year?: number; month?: number; shareholder_id?: number }): Promise<Contribution[]> => {
    let q = supabase.from("contributions").select("*").order("year", { ascending: false }).order("month", { ascending: false });
    if (params?.year)           q = q.eq("year", params.year);
    if (params?.month)          q = q.eq("month", params.month);
    if (params?.shareholder_id) q = q.eq("shareholder_id", params.shareholder_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  summaryByShareholder: async (params?: { year?: number; month?: number }): Promise<ShareholderContributionSummary[]> => {
    // fetch shareholders + contributions together
    const [shareholders, contributions] = await Promise.all([
      supabase.from("shareholders").select("*").order("member_number"),
      (() => {
        let q = supabase.from("contributions").select("*");
        if (params?.year)  q = q.eq("year", params.year);
        if (params?.month) q = q.eq("month", params.month);
        return q;
      })(),
    ]);
    if (shareholders.error) throw new Error(shareholders.error.message);
    if (contributions.error) throw new Error(contributions.error.message);

    const contribMap = new Map<number, Contribution[]>();
    for (const c of (contributions.data ?? [])) {
      const arr = contribMap.get(c.shareholder_id) ?? [];
      arr.push(c);
      contribMap.set(c.shareholder_id, arr);
    }

    return (shareholders.data ?? []).map((s) => {
      const cs = contribMap.get(s.id) ?? [];
      return {
        shareholder: s,
        total: cs.reduce((sum, c) => sum + Number(c.amount), 0),
        count: cs.length,
        contributions: cs,
      };
    });
  },

  record: async (p: ContributionPayload): Promise<Contribution> => {
    const safeAmount = Math.max(0, isFinite(Number(p.amount)) ? Number(p.amount) : 0);

    // Late rule: payment for month M is due by the 10th of month M+1.
    // JS months are 0-indexed, so new Date(year, month, 10) where month is 1-12
    // gives the 10th of month M+1 (e.g. month=7 → Aug 10).
    const today = new Date();
    const payDate = p.payment_date ? new Date(p.payment_date) : today;
    const deadline = new Date(p.year, p.month, 10); // 10th of month after contribution month
    const isLate = payDate > deadline;
    const status = p.status ?? (isLate ? "late" : "paid");

    // Penalty is NOT auto-calculated; admin adds manually via addPenalty()
    const { data: inserted, error: insertErr } = await supabase.from("contributions").insert({
      shareholder_id: p.shareholder_id,
      amount: safeAmount,
      month: p.month,
      year: p.year,
      payment_date: p.payment_date || today.toISOString().slice(0, 10),
      status,
      notes: p.notes || null,
      penalty_amount: 0,
      penalty_status: "none",
    }).select().single();

    if (insertErr) throw new Error(insertErr.message);

    const result = inserted;

    // Update shareholder net_savings + contributions_count
    const { data: sh } = await supabase.from("shareholders").select("net_savings,contributions_count").eq("id", p.shareholder_id).single();
    if (sh) {
      await supabase.from("shareholders").update({
        net_savings: Number(sh.net_savings) + safeAmount,
        contributions_count: Number(sh.contributions_count) + 1,
      }).eq("id", p.shareholder_id);
    }
    return result;
  },

  updatePenaltyStatus: async (id: number, penalty_status: "unpaid" | "paid" | "waived"): Promise<void> => {
    const { error } = await supabase.from("contributions").update({ penalty_status }).eq("id", id);
    if (error) throw new Error(error.message);
  },

  addPenalty: async (id: number, amount: number): Promise<void> => {
    const { error } = await supabase.from("contributions").update({
      penalty_amount: amount,
      penalty_status: "unpaid",
    }).eq("id", id);
    if (error) throw new Error(error.message);
  },

  getOutstandingPenalties: async (shareholder_id: number): Promise<{ id: number; month: number; year: number; penalty_amount: number }[]> => {
    const { data, error } = await supabase.from("contributions")
      .select("id, month, year, penalty_amount")
      .eq("shareholder_id", shareholder_id)
      .eq("penalty_status", "unpaid")
      .gt("penalty_amount", 0);
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  update: async (id: number, p: Partial<ContributionPayload>): Promise<void> => {
    const { data: old } = await supabase.from("contributions").select("shareholder_id,amount,month,year").eq("id", id).single();
    // Recompute late status: deadline is 10th of the month after the contribution month
    let autoStatus: "paid" | "late" | undefined;
    if (p.payment_date) {
      const payDate = new Date(p.payment_date);
      const month = p.month ?? old?.month ?? 1;
      const year = p.year ?? old?.year ?? payDate.getFullYear();
      const deadline = new Date(year, month, 10); // JS month is 0-indexed, so month (1-12) → following month
      autoStatus = payDate > deadline ? "late" : "paid";
    }
    const { error } = await supabase.from("contributions").update({
      ...(p.amount    !== undefined && { amount: Math.max(0, Number(p.amount)) }),
      ...(p.month     !== undefined && { month: p.month }),
      ...(p.year      !== undefined && { year: p.year }),
      ...(p.payment_date !== undefined && { payment_date: p.payment_date }),
      status: p.status ?? autoStatus,
      ...(p.notes !== undefined && { notes: p.notes || null }),
    }).eq("id", id);
    if (error) throw new Error(error.message);
    if (old && p.amount !== undefined && Number(p.amount) !== Number(old.amount)) {
      const diff = Number(p.amount) - Number(old.amount);
      const { data: sh } = await supabase.from("shareholders").select("net_savings").eq("id", old.shareholder_id).single();
      if (sh) {
        await supabase.from("shareholders").update({
          net_savings: Math.max(0, Number(sh.net_savings) + diff),
        }).eq("id", old.shareholder_id);
      }
    }
  },

  remove: async (id: number): Promise<void> => {
    const { data: c } = await supabase.from("contributions").select("shareholder_id,amount").eq("id", id).single();
    const { error } = await supabase.from("contributions").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (c) {
      const { data: sh } = await supabase.from("shareholders").select("net_savings,contributions_count").eq("id", c.shareholder_id).single();
      if (sh) {
        await supabase.from("shareholders").update({
          net_savings: Math.max(0, Number(sh.net_savings) - Number(c.amount)),
          contributions_count: Math.max(0, Number(sh.contributions_count) - 1),
        }).eq("id", c.shareholder_id);
      }
    }
  },
};

// ─── Payments ─────────────────────────────────────────────────────────────────

export interface Payment {
  id: number;
  payment_id: string | null;
  date_paid: string;
  amount: number;
  paid_by: string;
  purpose: string;
  mode: string;
  comment: string | null;
  shareholder_id: number | null;
  created_at: string;
  shareholder?: Shareholder;
}

export interface PaymentPayload {
  payment_id?: string;
  date_paid: string;
  amount: number;
  paid_by: string;
  purpose: string;
  mode: string;
  comment?: string;
  shareholder_id?: number;
}

export const PAYMENT_PURPOSES = ["Contribution", "Plot Payment", "Registration Fee", "Loan Repayment", "Penalty", "Other"] as const;
export const PAYMENT_MODES    = ["Cash", "Mpesa", "Bank", "Cheque"] as const;

export const paymentsApi = {
  list: async (params?: {
    dateFrom?: string; dateTo?: string;
    year?: number; mode?: string; purpose?: string;
  }): Promise<Payment[]> => {
    let q = supabase.from("payments").select("*").order("date_paid", { ascending: false });
    if (params?.dateFrom) q = q.gte("date_paid", params.dateFrom);
    if (params?.dateTo)   q = q.lte("date_paid", params.dateTo);
    if (params?.year)     q = q.gte("date_paid", `${params.year}-01-01`).lte("date_paid", `${params.year}-12-31`);
    if (params?.mode)     q = q.ilike("mode", params.mode);
    if (params?.purpose)  q = q.ilike("purpose", params.purpose);
    const { data, error } = await q;
    if (error) throw new Error(error.message);

    const ids = [...new Set((data ?? []).map((r) => r.shareholder_id).filter(Boolean))];
    let shareholders: Shareholder[] = [];
    if (ids.length > 0) {
      const { data: sh } = await supabase.from("shareholders").select("*").in("id", ids);
      shareholders = sh ?? [];
    }
    const shMap = new Map(shareholders.map((s) => [s.id, s]));
    return (data ?? []).map((r) => ({ ...r, shareholder: r.shareholder_id ? shMap.get(r.shareholder_id) : undefined }));
  },

  create: async (p: PaymentPayload): Promise<Payment> => {
    const safeAmount = Math.max(0, isFinite(Number(p.amount)) ? Number(p.amount) : 0);
    const { data, error } = await supabase.from("payments").insert({
      payment_id:    p.payment_id?.trim() || null,
      date_paid:     p.date_paid,
      amount:        safeAmount,
      paid_by:       p.paid_by.trim(),
      purpose:       p.purpose,
      mode:          p.mode,
      comment:       p.comment?.trim() || null,
      shareholder_id: p.shareholder_id || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  update: async (id: number, p: Partial<PaymentPayload>): Promise<Payment> => {
    const patch: any = {};
    if (p.payment_id  !== undefined) patch.payment_id  = p.payment_id?.trim() || null;
    if (p.date_paid   !== undefined) patch.date_paid   = p.date_paid;
    if (p.amount      !== undefined) patch.amount      = p.amount;
    if (p.paid_by     !== undefined) patch.paid_by     = p.paid_by.trim();
    if (p.purpose     !== undefined) patch.purpose     = p.purpose;
    if (p.mode        !== undefined) patch.mode        = p.mode;
    if (p.comment     !== undefined) patch.comment     = p.comment?.trim() || null;
    const { data, error } = await supabase.from("payments").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    // Fetch payment first so we can cascade-sync linked records
    const { data: payment } = await supabase
      .from("payments")
      .select("shareholder_id,purpose,date_paid,amount")
      .eq("id", id)
      .single();

    const { error } = await supabase.from("payments").delete().eq("id", id);
    if (error) throw new Error(error.message);

    if (!payment?.shareholder_id) return;
    const shId = payment.shareholder_id as number;

    // If it was a contribution payment, delete the matching contribution row
    if (payment.purpose?.toLowerCase() === "contribution" && payment.date_paid) {
      await supabase
        .from("contributions")
        .delete()
        .eq("shareholder_id", shId)
        .eq("payment_date", payment.date_paid);
    }

    // Recalculate shareholder net_savings and contributions_count from source of truth
    const [{ data: contribs }, { data: refs }] = await Promise.all([
      supabase.from("contributions").select("amount").eq("shareholder_id", shId),
      supabase.from("refunds").select("amount").eq("shareholder_id", shId),
    ]);
    const totalContrib = (contribs ?? []).reduce((s: number, c: any) => s + Number(c.amount), 0);
    const totalRefunds = (refs ?? []).reduce((s: number, r: any) => s + Number(r.amount), 0);
    await supabase.from("shareholders").update({
      net_savings: Math.max(0, totalContrib - totalRefunds),
      contributions_count: (contribs ?? []).length,
    }).eq("id", shId);
  },
};

// ─── Refunds ──────────────────────────────────────────────────────────────────

export interface Refund {
  id: number;
  shareholder_id: number;
  amount: number;
  refund_date: string;
  notes: string | null;
  processed_by: string | null;
  created_at: string;
  shareholder?: Shareholder;
}

export const refundsApi = {
  list: async (): Promise<Refund[]> => {
    const { data: refunds, error } = await supabase
      .from("refunds")
      .select("*")
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);

    const ids = [...new Set((refunds ?? []).map((r) => r.shareholder_id))];
    let shareholders: Shareholder[] = [];
    if (ids.length > 0) {
      const { data } = await supabase.from("shareholders").select("*").in("id", ids);
      shareholders = data ?? [];
    }
    const shMap = new Map(shareholders.map((s) => [s.id, s]));
    return (refunds ?? []).map((r) => ({ ...r, shareholder: shMap.get(r.shareholder_id) }));
  },

  update: async (id: number, p: { amount?: number; refund_date?: string; notes?: string }): Promise<Refund> => {
    const patch: any = {};
    if (p.amount !== undefined)      patch.amount      = p.amount;
    if (p.refund_date !== undefined) patch.refund_date = p.refund_date;
    if (p.notes !== undefined)       patch.notes       = p.notes;
    const { data, error } = await supabase.from("refunds").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    const { data: refund } = await supabase.from("refunds").select("shareholder_id, amount").eq("id", id).single();
    const { error } = await supabase.from("refunds").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (refund) {
      const { data: sh } = await supabase.from("shareholders").select("net_savings").eq("id", refund.shareholder_id).single();
      if (sh) {
        await supabase.from("shareholders").update({
          net_savings: Number(sh.net_savings) + Number(refund.amount),
        }).eq("id", refund.shareholder_id);
      }
    }
  },

  create: async (p: {
    shareholder_id: number;
    amount: number;
    refund_date?: string;
    notes?: string;
    processed_by?: string;
  }): Promise<Refund> => {
    const { data, error } = await supabase.from("refunds").insert({
      shareholder_id: p.shareholder_id,
      amount: p.amount,
      refund_date: p.refund_date || new Date().toISOString().slice(0, 10),
      notes: p.notes || null,
      processed_by: p.processed_by || null,
    }).select().single();
    if (error) throw new Error(error.message);

    // deduct amount from net_savings, adjust contributions_count, mark Inactive
    const { data: sh } = await supabase.from("shareholders").select("net_savings, contributions_count").eq("id", p.shareholder_id).single();
    if (sh) {
      const newSavings = Math.max(0, Number(sh.net_savings) - Number(p.amount));
      // Estimate how many contributions the refund covers (floor, min 0)
      const avgContrib = Number(sh.contributions_count) > 0
        ? Number(sh.net_savings) / Number(sh.contributions_count)
        : 0;
      const deductCount = avgContrib > 0 ? Math.min(Number(sh.contributions_count), Math.round(Number(p.amount) / avgContrib)) : 0;
      await supabase.from("shareholders").update({
        net_savings: newSavings,
        contributions_count: Math.max(0, Number(sh.contributions_count) - deductCount),
        status: "Inactive",
      }).eq("id", p.shareholder_id);
    }
    return data;
  },
};

export const investorsApi = {
  list: async (params?: { status?: string; search?: string }): Promise<Investor[]> => {
    let q = supabase.from("investors").select("*").order("member_number");
    if (params?.status) q = q.eq("status", params.status);
    if (params?.search) q = q.or(`name.ilike.%${params.search}%,phone.ilike.%${params.search}%`);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  get: async (id: number): Promise<Investor> => {
    const { data, error } = await supabase.from("investors").select("*").eq("id", id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  create: async (p: MemberPayload): Promise<Investor> => {
    if (!p.name?.trim()) throw new Error("Name is required");
    if (!p.phone?.trim()) throw new Error("Phone is required");
    const conflict = await checkPhoneConflict(p.phone.trim());
    if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);

    const { count } = await supabase.from("investors").select("*", { count: "exact", head: true });
    const nextNum = await nextMemberNumber("investors");

    const { data, error } = await supabase.from("investors").insert({
      member_number: p.member_number ?? nextNum,
      name: p.name.trim(),
      phone: p.phone.trim(),
      email: p.email?.trim() || null,
      id_passport: p.id_passport?.trim() || null,
      joined_date: p.joined_date || new Date().toISOString().slice(0, 10),
      status: p.status || "Active",
      avatar_color: INVESTOR_AVATAR_COLORS[count ?? 0 % INVESTOR_AVATAR_COLORS.length],
      photo_url: p.photo_url || null,
    }).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  update: async (id: number, p: Partial<MemberPayload>): Promise<Investor> => {
    if (p.phone) {
      const conflict = await checkPhoneConflict(p.phone.trim(), "investors", id);
      if (conflict) throw new Error(`Phone is already registered as a ${conflict}`);
    }
    const patch: any = {};
    if (p.name !== undefined)        patch.name         = p.name.trim();
    if (p.phone !== undefined)       patch.phone        = p.phone.trim();
    if (p.email !== undefined)       patch.email        = p.email?.trim() || null;
    if (p.id_passport !== undefined) patch.id_passport  = p.id_passport?.trim() || null;
    if (p.joined_date !== undefined) patch.joined_date  = p.joined_date;
    if (p.status !== undefined)      patch.status       = p.status;
    if (p.photo_url !== undefined)   patch.photo_url    = p.photo_url;
    if (p.member_number !== undefined) patch.member_number = p.member_number;
    const { data, error } = await supabase.from("investors").update(patch).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  setStatus: async (id: number, status: "Active" | "Inactive"): Promise<Investor> => {
    const { data, error } = await supabase.from("investors").update({ status }).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    // Find auth profile before deleting
    const { data: profile } = await supabase
      .from("user_profiles").select("id").eq("member_id", id).maybeSingle();

    // Delete payments and investment records
    await supabase.from("payments").delete().eq("member_id", id);
    await supabase.from("project_investments").delete().eq("investor_id", id);
    await supabase.from("profit_distributions").delete().eq("investor_id", id);

    // Delete user profile and Supabase auth account
    if (profile) {
      await supabase.from("user_profiles").delete().eq("id", profile.id);
      await supabase.functions.invoke("delete-auth-user", { body: { userId: profile.id } }).catch(() => {});
    }

    // Finally delete the member record
    const { error } = await supabase.from("investors").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  checkPhone: async (phone: string) => {
    const conflict = await checkPhoneConflict(phone);
    return { available: !conflict, conflict: conflict ? { phone, member_type: conflict } : null };
  },
};

// ─── Projects ─────────────────────────────────────────────────────────────────

export interface Project {
  id: number;
  project_name: string;
  location: string;
  size_acres: number;
  number_of_plots: number;
  project_cost: number;
  net_profit: number;
  date_started?: string | null;
  date_completed?: string | null;
  created_at: string;
}

export interface Plot {
  id: number;
  project_id: number;
  plot_number: string;
  price: number;
  size: number;
  status: "available" | "assigned";
  assigned_to_id: number | null;
  assigned_to_type: "shareholder" | "client" | null;
  payment_mode: "cash" | "installment" | null;
  loan_duration_months: number | null;
  interest_type: "fixed" | "percentage" | null;
  interest_amount: number | null;
  min_monthly_payment: number | null;
  paid_amount: number;
  created_at: string;
  shareholder?: any;
  client?: any;
  project?: any;
}

export interface PlotAssignPayload {
  assigned_to_id: number;
  assigned_to_type: "shareholder" | "client";
  payment_mode: "cash" | "installment";
  loan_duration_months?: number;
  interest_type?: "fixed" | "percentage";
  interest_amount?: number;
  min_monthly_payment?: number;
}

export const projectsApi = {
  list: async (): Promise<Project[]> => {
    const { data, error } = await supabase.from("projects").select("*").order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  get: async (id: number): Promise<Project> => {
    const { data, error } = await supabase.from("projects").select("*").eq("id", id).single();
    if (error) throw new Error(error.message);
    return data;
  },

  create: async (p: Omit<Project, "id" | "created_at">): Promise<Project> => {
    const { data, error } = await supabase.from("projects").insert(p).select().single();
    if (error) throw new Error(error.message);
    const plots = Array.from({ length: p.number_of_plots }, (_, i) => ({
      project_id: data.id,
      plot_number: `${p.project_name}-Plot${i + 1}`,
      price: p.number_of_plots > 0 ? Math.round(p.project_cost / p.number_of_plots) : 0,
      size: p.number_of_plots > 0 ? Math.round((p.size_acres / p.number_of_plots) * 10000) / 10000 : 0,
      status: "available",
    }));
    if (plots.length > 0) await supabase.from("plots").insert(plots);
    return data;
  },

  update: async (id: number, p: Partial<Omit<Project, "id" | "created_at">>): Promise<Project> => {
    const { data, error } = await supabase.from("projects").update(p).eq("id", id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    const { error } = await supabase.from("projects").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  generatePlots: async (project: Project): Promise<void> => {
    const n = project.number_of_plots;
    if (!n) return;
    // Count existing plots so we only add the missing ones
    const { count } = await supabase.from("plots").select("id", { count: "exact", head: true }).eq("project_id", project.id);
    const existing = count ?? 0;
    if (existing >= n) return;
    const rows = Array.from({ length: n - existing }, (_, i) => ({
      project_id: project.id,
      plot_number: `${project.project_name}-Plot${existing + i + 1}`,
      price: Math.round(Number(project.project_cost) / n),
      size: Math.round((Number(project.size_acres) / n) * 10000) / 10000,
      status: "available",
    }));
    const { error } = await supabase.from("plots").insert(rows);
    if (error) throw new Error(error.message);
  },

  enrollShareholder: async (project_id: number, shareholder_id: number): Promise<void> => {
    const { error } = await supabase.from("project_shareholders")
      .insert({ project_id, shareholder_id });
    if (error && !error.message.toLowerCase().includes("duplicate") && !error.message.toLowerCase().includes("unique")) throw new Error(error.message);
  },

  getEnrolledByShareholder: async (shareholder_id: number): Promise<(any & { project: Project })[]> => {
    const { data, error } = await supabase.from("project_shareholders")
      .select("*, project:projects(*)").eq("shareholder_id", shareholder_id);
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  unenrollShareholder: async (project_id: number, shareholder_id: number): Promise<void> => {
    const { error } = await supabase.from("project_shareholders")
      .delete().eq("project_id", project_id).eq("shareholder_id", shareholder_id);
    if (error) throw new Error(error.message);
  },

  getEnrolled: async (project_id: number): Promise<any[]> => {
    const { data, error } = await supabase.from("project_shareholders")
      .select("*, shareholder:shareholders(*)").eq("project_id", project_id);
    if (error) throw new Error(error.message);
    return data ?? [];
  },
};

export const plotsApi = {
  listByProject: async (project_id: number): Promise<Plot[]> => {
    const { data, error } = await supabase.from("plots")
      .select("*")
      .eq("project_id", project_id).order("plot_number");
    if (error) throw new Error(error.message);
    // Sort numerically by the trailing number in plot_number (e.g. "PROJECT1-Plot10" → 10)
    return (data ?? []).sort((a, b) => {
      const num = (s: string) => parseInt(s.match(/(\d+)$/)?.[1] ?? "0", 10);
      return num(a.plot_number) - num(b.plot_number);
    });
  },

  listByMember: async (member_id: number, member_type: "shareholder" | "client"): Promise<(Plot & { project?: Project; isCoOwner?: boolean })[]> => {
    const { data, error } = await supabase.from("plots")
      .select("*, project:projects(*)")
      .eq("assigned_to_id", member_id).eq("assigned_to_type", member_type);
    if (error) throw new Error(error.message);
    const primary = (data ?? []) as (Plot & { project?: Project; isCoOwner?: boolean })[];
    // Also fetch co-owned plots
    const { data: coRows } = await supabase.from("plot_co_owners")
      .select("*, plot:plots(*, project:projects(*))")
      .eq("member_id", member_id).eq("member_type", member_type);
    const coPrimary = ((coRows ?? []) as any[]).map((r) => ({ ...r.plot, isCoOwner: true }));
    // Merge, deduplicating by plot id
    const seen = new Set(primary.map((p) => p.id));
    const merged = [...primary];
    for (const p of coPrimary) { if (!seen.has(p.id)) { seen.add(p.id); merged.push(p); } }
    return merged;
  },

  assign: async (plot_id: number, p: PlotAssignPayload): Promise<Plot> => {
    const { data, error } = await supabase.from("plots").update({
      status: "assigned",
      assigned_to_id: p.assigned_to_id,
      assigned_to_type: p.assigned_to_type,
      payment_mode: p.payment_mode,
      loan_duration_months: p.loan_duration_months ?? null,
      interest_type: p.interest_type ?? null,
      interest_amount: p.interest_amount ?? null,
      min_monthly_payment: p.min_monthly_payment ?? null,
    }).eq("id", plot_id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  unassign: async (plot_id: number): Promise<Plot> => {
    const { data, error } = await supabase.from("plots").update({
      status: "available", assigned_to_id: null, assigned_to_type: null,
      payment_mode: null, loan_duration_months: null,
      interest_type: null, interest_amount: null, paid_amount: 0,
    }).eq("id", plot_id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  recordPayment: async (plot_id: number, amount: number, notes?: string, payment_date?: string): Promise<Plot> => {
    const { data: plot } = await supabase.from("plots").select("paid_amount").eq("id", plot_id).single();
    const newPaid = Number(plot?.paid_amount ?? 0) + amount;
    const { data, error } = await supabase.from("plots").update({ paid_amount: newPaid }).eq("id", plot_id).select().single();
    if (error) throw new Error(error.message);

    // Penalty is NOT auto-calculated; admin adds manually via plotPaymentsApi.addPenalty()
    await supabase.from("plot_payments").insert({
      plot_id, amount, notes: notes ?? null,
      payment_date: payment_date ?? new Date().toISOString().slice(0, 10),
      penalty_amount: 0,
      penalty_status: "none",
    });
    return data;
  },

  update: async (plot_id: number, p: { price?: number; size?: number; plot_number?: string }): Promise<Plot> => {
    const { data, error } = await supabase.from("plots").update(p).eq("id", plot_id).select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (plot_id: number): Promise<void> => {
    const { error } = await supabase.from("plots").delete().eq("id", plot_id);
    if (error) throw new Error(error.message);
  },

  // Recalculate paid_amount for all plots from actual plot_payments records
  syncAllPaidAmounts: async (): Promise<number> => {
    const { data: plots } = await supabase.from("plots").select("id");
    if (!plots?.length) return 0;
    let fixed = 0;
    for (const { id } of plots) {
      const { data: pmts } = await supabase.from("plot_payments").select("amount").eq("plot_id", id);
      const total = (pmts ?? []).reduce((s: number, p: any) => s + Number(p.amount), 0);
      await supabase.from("plots").update({ paid_amount: total }).eq("id", id);
      fixed++;
    }
    return fixed;
  },
};

// ─── Plot Co-Owners ───────────────────────────────────────────────────────────
// Requires this SQL run once in Supabase SQL Editor:
// CREATE TABLE IF NOT EXISTS plot_co_owners (
//   id bigserial primary key,
//   plot_id bigint references plots(id) on delete cascade not null,
//   member_id bigint not null,
//   member_type text not null check (member_type in ('shareholder','client')),
//   created_at timestamptz default now(),
//   unique(plot_id, member_id, member_type)
// );

export interface PlotCoOwner {
  id: number;
  plot_id: number;
  member_id: number;
  member_type: "shareholder" | "client";
  created_at: string;
}

export const plotCoOwnersApi = {
  listByPlot: async (plot_id: number): Promise<(PlotCoOwner & { member?: { id: number; name: string; member_number?: any } })[]> => {
    const { data, error } = await supabase.from("plot_co_owners").select("*").eq("plot_id", plot_id);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    // Enrich with member names
    const shIds = rows.filter((r) => r.member_type === "shareholder").map((r) => r.member_id);
    const clIds = rows.filter((r) => r.member_type === "client").map((r) => r.member_id);
    const [shData, clData] = await Promise.all([
      shIds.length ? supabase.from("shareholders").select("id,name,member_number").in("id", shIds).then((r) => r.data ?? []) : [],
      clIds.length ? supabase.from("clients").select("id,name,member_number").in("id", clIds).then((r) => r.data ?? []) : [],
    ]);
    const shMap = Object.fromEntries((shData as any[]).map((s) => [s.id, s]));
    const clMap = Object.fromEntries((clData as any[]).map((c) => [c.id, c]));
    return rows.map((r) => ({ ...r, member: r.member_type === "shareholder" ? shMap[r.member_id] : clMap[r.member_id] }));
  },

  listByMember: async (member_id: number, member_type: "shareholder" | "client"): Promise<(PlotCoOwner & { plot?: Plot & { project?: Project } })[]> => {
    const { data, error } = await supabase.from("plot_co_owners")
      .select("*, plot:plots(*, project:projects(*))")
      .eq("member_id", member_id).eq("member_type", member_type);
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  add: async (plot_id: number, member_id: number, member_type: "shareholder" | "client"): Promise<PlotCoOwner> => {
    const { data, error } = await supabase.from("plot_co_owners")
      .upsert({ plot_id, member_id, member_type }, { onConflict: "plot_id,member_id,member_type" })
      .select().single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    const { error } = await supabase.from("plot_co_owners").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },

  removeAllForPlot: async (plot_id: number): Promise<void> => {
    await supabase.from("plot_co_owners").delete().eq("plot_id", plot_id);
  },
};

export interface PlotPayment {
  id: number;
  plot_id: number;
  amount: number;
  notes: string | null;
  payment_date: string;
  created_at: string;
  penalty_amount?: number;
  penalty_status?: "unpaid" | "paid" | "waived" | "none";
}

export const plotPaymentsApi = {
  listByPlot: async (plot_id: number): Promise<PlotPayment[]> => {
    const { data, error } = await supabase.from("plot_payments")
      .select("*").eq("plot_id", plot_id).order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  remove: async (id: number): Promise<void> => {
    const { data: pp } = await supabase.from("plot_payments").select("plot_id, amount").eq("id", id).single();
    const { error } = await supabase.from("plot_payments").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (pp) {
      const { data: plot } = await supabase.from("plots").select("paid_amount").eq("id", pp.plot_id).single();
      if (plot) {
        await supabase.from("plots").update({
          paid_amount: Math.max(0, Number(plot.paid_amount) - Number(pp.amount)),
        }).eq("id", pp.plot_id);
      }
    }
  },

  insert: async (plot_id: number, amount: number, notes: string, payment_date: string): Promise<void> => {
    const { error } = await supabase.from("plot_payments").insert({ plot_id, amount, notes, payment_date, penalty_amount: 0, penalty_status: "none" });
    if (error) throw new Error(error.message);
  },

  insertWithPenalty: async (plot_id: number, amount: number, notes: string, payment_date: string, _monthlyInstalment?: number): Promise<void> => {
    // Penalty is NOT auto-calculated; admin adds manually via addPenalty()
    const { error } = await supabase.from("plot_payments").insert({ plot_id, amount, notes, payment_date, penalty_amount: 0, penalty_status: "none" });
    if (error) throw new Error(error.message);
  },

  updatePenaltyStatus: async (id: number, penalty_status: "unpaid" | "paid" | "waived"): Promise<void> => {
    const { error } = await supabase.from("plot_payments").update({ penalty_status }).eq("id", id);
    if (error) throw new Error(error.message);
  },

  addPenalty: async (id: number, amount: number): Promise<void> => {
    const { error } = await supabase.from("plot_payments").update({
      penalty_amount: amount,
      penalty_status: "unpaid",
    }).eq("id", id);
    if (error) throw new Error(error.message);
  },

  update: async (id: number, fields: { amount: number; notes: string; payment_date: string }): Promise<void> => {
    const { data: old } = await supabase.from("plot_payments").select("plot_id, amount").eq("id", id).single();
    const { error } = await supabase.from("plot_payments").update({
      amount: fields.amount,
      notes: fields.notes,
      payment_date: fields.payment_date,
    }).eq("id", id);
    if (error) throw new Error(error.message);
    if (old) {
      const diff = fields.amount - Number(old.amount);
      if (diff !== 0) {
        const { data: plot } = await supabase.from("plots").select("paid_amount").eq("id", old.plot_id).single();
        if (plot) {
          await supabase.from("plots").update({
            paid_amount: Math.max(0, Number(plot.paid_amount) + diff),
          }).eq("id", old.plot_id);
        }
      }
    }
  },
};

// ─── Profit Distributions ─────────────────────────────────────────────────────

export interface ProfitDistribution {
  id: number;
  project_id: number;
  shareholder_id: number | null;
  investor_id: number | null;
  amount: number;
  distributed_at: string;
  notes?: string | null;
  shareholder?: { id: number; name: string; member_number: number } | null;
  investor?: { id: number; name: string; member_number: number } | null;
}

export type ProfitDistributionRow =
  | { project_id: number; shareholder_id: number; investor_id?: null; amount: number; distributed_at?: string; notes?: string }
  | { project_id: number; investor_id: number; shareholder_id?: null; amount: number; distributed_at?: string; notes?: string };

export const profitDistributionsApi = {
  listByShareholder: async (shareholder_id: number): Promise<(ProfitDistribution & { project?: Project })[]> => {
    const { data, error } = await supabase.from("profit_distributions")
      .select("*, project:projects(id,project_name,date_completed)").eq("shareholder_id", shareholder_id)
      .order("distributed_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  listByProject: async (project_id: number): Promise<ProfitDistribution[]> => {
    const { data, error } = await supabase.from("profit_distributions")
      .select("*, shareholder:shareholders(id,name,member_number), investor:investors(id,name,member_number)")
      .eq("project_id", project_id).order("distributed_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  create: async (rows: ProfitDistributionRow[]): Promise<void> => {
    if (!rows.length) return;
    const { error } = await supabase.from("profit_distributions").insert(rows);
    if (error) throw new Error(error.message);
    // Update total_profits on affected shareholders
    const byShareHolder = new Map<number, number>();
    for (const r of rows) {
      if (r.shareholder_id) byShareHolder.set(r.shareholder_id, (byShareHolder.get(r.shareholder_id) ?? 0) + Number(r.amount));
    }
    for (const [shId, amt] of byShareHolder) {
      const { data: sh } = await supabase.from("shareholders").select("total_profits").eq("id", shId).single();
      if (sh) await supabase.from("shareholders").update({ total_profits: Number(sh.total_profits) + amt }).eq("id", shId);
    }
    // Update total_profits on affected investors
    const byInvestor = new Map<number, number>();
    for (const r of rows) {
      if (r.investor_id) byInvestor.set(r.investor_id, (byInvestor.get(r.investor_id) ?? 0) + Number(r.amount));
    }
    for (const [invId, amt] of byInvestor) {
      const { data: inv } = await supabase.from("investors").select("total_profits").eq("id", invId).single();
      if (inv) await supabase.from("investors").update({ total_profits: Number((inv as any).total_profits ?? 0) + amt }).eq("id", invId);
    }
  },

  update: async (id: number, patch: { amount?: number; distributed_at?: string; notes?: string }): Promise<void> => {
    const { error } = await supabase.from("profit_distributions").update(patch).eq("id", id);
    if (error) throw new Error(error.message);
  },

  removeByShareholderAndProject: async (project_id: number, shareholder_id: number): Promise<void> => {
    await supabase.from("profit_distributions")
      .delete().eq("project_id", project_id).eq("shareholder_id", shareholder_id);
  },

  removeByInvestorAndProject: async (project_id: number, investor_id: number): Promise<void> => {
    await supabase.from("profit_distributions")
      .delete().eq("project_id", project_id).eq("investor_id", investor_id);
  },

  remove: async (id: number): Promise<void> => {
    // fetch first so we can reverse total_profits
    const { data: d } = await supabase.from("profit_distributions")
      .select("amount,shareholder_id,investor_id").eq("id", id).single();
    const { error } = await supabase.from("profit_distributions").delete().eq("id", id);
    if (error) throw new Error(error.message);
    if (d) {
      const amt = Number((d as any).amount ?? 0);
      if ((d as any).shareholder_id) {
        const { data: sh } = await supabase.from("shareholders").select("total_profits").eq("id", (d as any).shareholder_id).single();
        if (sh) await supabase.from("shareholders").update({ total_profits: Math.max(0, Number(sh.total_profits) - amt) }).eq("id", (d as any).shareholder_id);
      }
      if ((d as any).investor_id) {
        const { data: inv } = await supabase.from("investors").select("total_profits").eq("id", (d as any).investor_id).single();
        if (inv) await supabase.from("investors").update({ total_profits: Math.max(0, Number((inv as any).total_profits ?? 0) - amt) }).eq("id", (d as any).investor_id);
      }
    }
  },
};

// ─── Project Investments ──────────────────────────────────────────────────────

export interface ProjectInvestment {
  id: number;
  project_id: number;
  investor_id: number;
  amount: number;
  notes: string | null;
  invested_at: string;
  created_at: string;
  investor?: { id: number; name: string; member_number: number; avatar_color: string; photo_url: string | null };
}

export const projectInvestmentsApi = {
  list: async (project_id: number): Promise<ProjectInvestment[]> => {
    const { data, error } = await supabase
      .from("project_investments")
      .select("*, investor:investors(id,name,member_number,avatar_color,photo_url)")
      .eq("project_id", project_id)
      .order("invested_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  create: async (payload: {
    project_id: number;
    investor_id: number;
    amount: number;
    notes?: string;
    invested_at?: string;
  }): Promise<ProjectInvestment> => {
    const { data, error } = await supabase
      .from("project_investments")
      .insert({
        project_id: payload.project_id,
        investor_id: payload.investor_id,
        amount: payload.amount,
        notes: payload.notes ?? null,
        invested_at: payload.invested_at ?? new Date().toISOString().slice(0, 10),
      })
      .select("*, investor:investors(id,name,member_number,avatar_color,photo_url)")
      .single();
    if (error) throw new Error(error.message);
    return data;
  },

  remove: async (id: number): Promise<void> => {
    const { error } = await supabase.from("project_investments").delete().eq("id", id);
    if (error) throw new Error(error.message);
  },
};

// ─── Activity Log ─────────────────────────────────────────────────────────────

export type ActivityCategory =
  | "auth"
  | "contribution"
  | "payment"
  | "shareholder"
  | "client"
  | "investor"
  | "project"
  | "plot"
  | "profit"
  | "refund"
  | "settings"
  | "sms"
  | "other";

export interface ActivityLog {
  id: number;
  category: ActivityCategory;
  action: string;
  description: string;
  actor_name: string | null;
  actor_role: string | null;
  meta: Record<string, any> | null;
  created_at: string;
}

export const activityLogApi = {
  log: async (entry: {
    category: ActivityCategory;
    action: string;
    description: string;
    actor_name?: string;
    actor_role?: string;
    meta?: Record<string, any>;
  }): Promise<void> => {
    // Always resolve the actual logged-in user so the log shows who performed the action.
    let actorName = entry.actor_name ?? null;
    let actorRole = entry.actor_role ?? null;
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        const { data: profile } = await supabase
          .from("user_profiles")
          .select("full_name, role")
          .eq("id", user.id)
          .maybeSingle();
        if (profile?.full_name) {
          actorName = profile.full_name;
          actorRole = actorRole ?? profile.role ?? null;
        }
      }
    } catch { /* ignore — actor stays as provided */ }

    await supabase.from("activity_logs").insert({
      category: entry.category,
      action: entry.action,
      description: entry.description,
      actor_name: actorName,
      actor_role: actorRole,
      meta: entry.meta ?? null,
    });
    // fire-and-forget; never throw
  },

  list: async (filters?: {
    dateFrom?: string;
    dateTo?: string;
    actor?: string;
    category?: ActivityCategory;
    limit?: number;
  }): Promise<ActivityLog[]> => {
    let q = supabase
      .from("activity_logs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(filters?.limit ?? 500);
    if (filters?.dateFrom) q = q.gte("created_at", filters.dateFrom);
    if (filters?.dateTo)   q = q.lte("created_at", filters.dateTo + "T23:59:59");
    if (filters?.actor)    q = q.ilike("actor_name", `%${filters.actor}%`);
    if (filters?.category) q = q.eq("category", filters.category);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  },

  clear: async (): Promise<void> => {
    const { error } = await supabase.from("activity_logs").delete().neq("id", 0);
    if (error) throw new Error(error.message);
  },
};

// Convenience fire-and-forget wrapper — safe to call anywhere, never throws
export function logActivity(entry: Parameters<typeof activityLogApi.log>[0]): void {
  activityLogApi.log(entry).catch(() => {});
}
