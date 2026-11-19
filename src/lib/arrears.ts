// ─── Plot arrears ─────────────────────────────────────────────────────────────
//
// A plot is repaid in monthly instalments of `min_monthly_payment` (or
// price / loan_duration_months when no minimum is set). The first instalment
// falls due in the month AFTER the plot was allocated, on the day-of-month of
// the plot's `deadline`. The plots table has no allocation timestamp; the
// "Payment Deadline" picked at allocation defaults to the allocation day, so
// its month is used as the allocation month.
//
// Payments are applied oldest-first (FIFO) across instalments. An instalment
// whose deadline has passed is an ARREAR if it was not fully covered on or
// before its deadline. It stays listed once covered later, marked "paid".

export interface ArrearPlot {
  id: number;
  plot_number: string;
  price: number | string | null;
  paid_amount?: number | string | null;
  min_monthly_payment?: number | string | null;
  loan_duration_months?: number | string | null;
  deadline?: string | null;
}

export interface ArrearPayment {
  plot_id: number | string;
  amount: number | string;
  payment_date?: string | null;
  created_at?: string | null;
}

export interface Arrear {
  plotId: number;
  plotNumber: string;
  /** "YYYY-MM" of the instalment */
  period: string;
  /** e.g. "Mar 2026" */
  monthLabel: string;
  /** "YYYY-MM-DD" deadline of the instalment */
  dueDate: string;
  /** instalment amount (the monthly repayment) */
  amount: number;
  /** amount applied to this instalment so far */
  paid: number;
  /** amount still owed on this instalment */
  remaining: number;
  status: "paid" | "unpaid";
  /** date the instalment became fully covered (late), if it has been */
  clearedOn: string | null;
}

/**
 * Arrears rules apply from this date onward. Instalments whose deadline is
 * before it (i.e. 18 Nov 2026 and earlier) are never treated as arrears.
 */
export const ARREARS_START_DATE = "2026-11-19";

const MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (y: number, m0: number, d: number) => `${y}-${pad(m0 + 1)}-${pad(d)}`;

/** Today's date in Nairobi time as YYYY-MM-DD. */
export function todayEAT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
}

export function monthlyRepayment(plot: ArrearPlot): number {
  const price = Number(plot.price ?? 0);
  const min = Number(plot.min_monthly_payment ?? 0);
  if (min > 0) return min;
  return price / Math.max(1, Number(plot.loan_duration_months ?? 12) || 12);
}

/** All arrears (paid and unpaid) for one plot, oldest first. */
export function computePlotArrears(plot: ArrearPlot, payments: ArrearPayment[], today = todayEAT()): Arrear[] {
  const price = Number(plot.price ?? 0);
  const monthly = monthlyRepayment(plot);
  const anchor = String(plot.deadline ?? "").slice(0, 10);
  if (!(price > 0) || !(monthly > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return [];

  const [ay, am, ad] = anchor.split("-").map(Number);
  const deadlineDay = Math.max(1, ad);

  // Build instalments until the price is covered, stopping at those not yet due.
  const instalments: { period: string; monthLabel: string; dueDate: string; amount: number }[] = [];
  let scheduled = 0;
  for (let k = 1; scheduled < price - 0.005 && k <= 600; k++) {
    const d = new Date(ay, am - 1 + k, 1);
    const y = d.getFullYear(), m0 = d.getMonth();
    const day = Math.min(deadlineDay, new Date(y, m0 + 1, 0).getDate());
    const amount = Math.min(monthly, price - scheduled);
    scheduled += amount;
    instalments.push({ period: `${y}-${pad(m0 + 1)}`, monthLabel: `${MONTH_SHORT[m0]} ${y}`, dueDate: ymd(y, m0, day), amount });
  }

  // Payments oldest-first. If the stored paid_amount is higher than the recorded
  // payments (legacy data), treat the gap as paid on allocation.
  const pmts = payments
    .filter((p) => Number(p.plot_id) === Number(plot.id))
    .map((p) => ({ date: String(p.payment_date ?? p.created_at ?? "").slice(0, 10), amount: Number(p.amount) }))
    .filter((p) => p.amount > 0 && p.date)
    .sort((a, b) => a.date.localeCompare(b.date));
  const recorded = pmts.reduce((s, p) => s + p.amount, 0);
  const stored = Number(plot.paid_amount ?? 0);
  if (stored - recorded > 0.005) pmts.unshift({ date: anchor, amount: stored - recorded });

  // FIFO allocation. Months due before ARREARS_START_DATE only take payments made
  // before that date, so an old shortfall never consumes newer payments (earlier
  // overpayments still carry forward to later months).
  let pi = 0;
  let left = pmts[0]?.amount ?? 0;
  const result: Arrear[] = [];
  for (const inst of instalments) {
    let paid = 0;
    let clearedOn: string | null = null;
    const legacyMonth = inst.dueDate < ARREARS_START_DATE;
    while (paid < inst.amount - 0.005 && pi < pmts.length && (!legacyMonth || pmts[pi].date < ARREARS_START_DATE)) {
      const take = Math.min(left, inst.amount - paid);
      paid += take;
      left -= take;
      if (paid >= inst.amount - 0.005) clearedOn = pmts[pi].date;
      if (left <= 0.005) { pi++; left = pmts[pi]?.amount ?? 0; }
    }
    if (inst.dueDate >= today) continue; // deadline not passed yet — not an arrear
    if (inst.dueDate < ARREARS_START_DATE) continue; // before arrears rules took effect
    const onTime = clearedOn !== null && clearedOn <= inst.dueDate;
    if (onTime) continue;
    result.push({
      plotId: Number(plot.id),
      plotNumber: plot.plot_number,
      period: inst.period,
      monthLabel: inst.monthLabel,
      dueDate: inst.dueDate,
      amount: inst.amount,
      paid,
      remaining: Math.max(0, inst.amount - paid),
      status: clearedOn ? "paid" : "unpaid",
      clearedOn,
    });
  }
  return result;
}

/** Sum of what is still owed on unpaid arrears. */
export function unpaidArrearsTotal(arrears: Arrear[]): number {
  return arrears.filter((a) => a.status === "unpaid").reduce((s, a) => s + a.remaining, 0);
}
