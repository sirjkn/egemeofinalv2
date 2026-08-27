// ─── Shared utilities, constants and types used across page modules ──────────

export const THIS_YEAR = new Date().getFullYear();
export const CY = THIS_YEAR;
export const YEAR_OPTS = Array.from({ length: 10 }, (_, i) => CY - i);
export const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
export const CURRENT_YEAR = THIS_YEAR;
export const YEAR_RANGE = Array.from({ length: 8 }, (_, i) => CURRENT_YEAR - 7 + i);

export function initials(name: string) {
  return name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}
export function fmtKES(n: number) {
  if (n >= 1_000_000) return `Ksh ${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `Ksh ${(n / 1_000).toFixed(0)}K`;
  return `Ksh ${n.toLocaleString("en-US")}`;
}
export function fmtKESFull(n: number) {
  return `Ksh ${Number(n).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
export function fmtDate(iso: string) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
