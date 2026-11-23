// ─── Plot arrears ─────────────────────────────────────────────────────────────
//
// Rule: EACH MONTH ON ITS OWN.
// A plot is repaid monthly: at least `min_monthly_payment` (or
// price / loan_duration_months when no minimum is set) must be paid IN each
// month, on or before that month's deadline (day-of-month of `plot.deadline`).
// Paying extra in an earlier month does NOT cover a later month.
//
// First month: the month AFTER the plot was allocated. The plots table has no
// allocation date unless `assigned_at` is recorded; without it, the allocation
// month is the earlier of the deadline's month and the first payment's month.
//
// A month whose deadline has passed without the minimum is an ARREAR. Later
// payments clear outstanding arrears first (oldest first); whatever is left
// counts toward the month the payment falls in. A cleared arrear stays listed,
// marked "paid".

export interface ArrearPlot {
  id: number;
  plot_number: string;
  price: number | string | null;
  paid_amount?: number | string | null;
  min_monthly_payment?: number | string | null;
  loan_duration_months?: number | string | null;
  deadline?: string | null;
  /** Date the plot was assigned, when recorded. */
  assigned_at?: string | null;
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
  /**
   * paid     — missed the deadline, settled later
   * unpaid   — missed the deadline, still owed (an arrear / debtor)
   * upcoming — deadline is today or later and not yet fully paid (not a default yet;
   *            only returned when `includeUpcomingUntil` is passed)
   */
  status: "paid" | "unpaid" | "upcoming";
  /** date the instalment became fully covered (late), if it has been */
  clearedOn: string | null;
}

/**
 * Arrears rules (including "pay the earliest month first") apply from this date
 * onward. Instalments whose deadline is before it (October 2026 and earlier)
 * are never treated as arrears.
 */
export const ARREARS_START_DATE = "2026-11-01";

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

/**
 * All arrears (paid and unpaid) for one plot, oldest first.
 * Pass `includeUpcomingUntil` (YYYY-MM-DD) to also get months due between today
 * and that date which are not yet fully paid, with status "upcoming".
 */
export function computePlotArrears(
  plot: ArrearPlot,
  payments: ArrearPayment[],
  today = todayEAT(),
  options: { includeUpcomingUntil?: string } = {},
): Arrear[] {
  const price = Number(plot.price ?? 0);
  const monthly = monthlyRepayment(plot);
  const anchor = String(plot.deadline ?? "").slice(0, 10);
  if (!(price > 0) || !(monthly > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return [];
  const deadlineDay = Math.max(1, Number(anchor.slice(8, 10)));

  // Payments oldest-first. If the stored paid_amount is higher than the recorded
  // payments (legacy data), treat the gap as paid on the deadline date.
  const pmts = payments
    .filter((p) => Number(p.plot_id) === Number(plot.id))
    .map((p) => ({ date: String(p.payment_date ?? p.created_at ?? "").slice(0, 10), amount: Number(p.amount) }))
    .filter((p) => p.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.date))
    .sort((a, b) => a.date.localeCompare(b.date));
  const recorded = pmts.reduce((s, p) => s + p.amount, 0);
  const stored = Number(plot.paid_amount ?? 0);
  if (stored - recorded > 0.005) {
    pmts.push({ date: anchor, amount: stored - recorded });
    pmts.sort((a, b) => a.date.localeCompare(b.date));
  }

  // Allocation month = the recorded assigning date; otherwise the earlier of the
  // deadline's month and the first payment's month.
  const assignedAt = String(plot.assigned_at ?? "").slice(0, 10);
  const firstPaymentMonth = pmts[0]?.date.slice(0, 7);
  const allocMonth = /^\d{4}-\d{2}-\d{2}$/.test(assignedAt)
    ? assignedAt.slice(0, 7)
    : firstPaymentMonth && firstPaymentMonth < anchor.slice(0, 7) ? firstPaymentMonth : anchor.slice(0, 7);
  const [ay, am] = allocMonth.split("-").map(Number);

  const until = options.includeUpcomingUntil;
  const horizon = until && until > today ? until : today;

  const result: Arrear[] = [];
  const open: Arrear[] = []; // unpaid arrears, oldest first
  let paidSoFar = 0;         // all money received so far (to know the remaining balance)
  let pi = 0;

  // A payment first clears arrears that were already overdue when it was made.
  const settle = (p: { date: string; amount: number }): number => {
    let left = p.amount;
    while (left > 0.005 && open.length && open[0].dueDate < p.date) {
      const a = open[0];
      const take = Math.min(left, a.remaining);
      a.paid += take;
      a.remaining -= take;
      left -= take;
      if (a.remaining <= 0.005) {
        a.remaining = 0;
        a.status = "paid";
        a.clearedOn = p.date;
        open.shift();
      }
    }
    return left;
  };

  for (let k = 1; k <= 600; k++) {
    const d = new Date(ay, am - 1 + k, 1);
    const y = d.getFullYear(), m0 = d.getMonth();
    const monthStart = ymd(y, m0, 1);
    const dueDate = ymd(y, m0, Math.min(deadlineDay, new Date(y, m0 + 1, 0).getDate()));
    if (dueDate > horizon) break;

    // Payments before this month (incl. those after last month's deadline) only clear arrears.
    while (pi < pmts.length && pmts[pi].date < monthStart) { paidSoFar += pmts[pi].amount; settle(pmts[pi]); pi++; }

    const required = Math.min(monthly, Math.max(0, price - paidSoFar));
    if (required <= 0.005) break; // plot fully paid

    // Payments in this month up to its deadline: arrears first, the rest counts for this month.
    let onTime = 0;
    while (pi < pmts.length && pmts[pi].date <= dueDate) { paidSoFar += pmts[pi].amount; onTime += settle(pmts[pi]); pi++; }

    const shortfall = Math.max(0, required - onTime);
    const entry = (status: Arrear["status"]): Arrear => ({
      plotId: Number(plot.id),
      plotNumber: plot.plot_number,
      period: `${y}-${pad(m0 + 1)}`,
      monthLabel: `${MONTH_SHORT[m0]} ${y}`,
      dueDate,
      amount: required,
      paid: Math.min(onTime, required),
      remaining: shortfall,
      status,
      clearedOn: null,
    });

    if (dueDate >= today) {
      // Not due yet — optionally report it as upcoming.
      if (until && dueDate <= until && shortfall > 0.005) result.push(entry("upcoming"));
      continue;
    }
    if (dueDate < ARREARS_START_DATE || shortfall <= 0.005) continue; // before the rules, or paid on time
    const arrear = entry("unpaid");
    result.push(arrear);
    open.push(arrear);
  }

  // Payments after the last scheduled month can still clear arrears.
  while (pi < pmts.length) { settle(pmts[pi]); pi++; }
  return result;
}

/** Sum of what is still owed on unpaid arrears. */
export function unpaidArrearsTotal(arrears: Arrear[]): number {
  return arrears.filter((a) => a.status === "unpaid").reduce((s, a) => s + a.remaining, 0);
}
