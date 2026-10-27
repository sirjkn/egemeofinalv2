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
  if (!iso.includes("T")) {
    // Date-only string (e.g. "2026-07-10") — parse digits directly, no timezone shift
    const [yyyy, mm, dd] = iso.substring(0, 10).split("-");
    return `${dd}/${mm}/${yyyy}`;
  }
  // Full timestamp — convert to EAT (Africa/Nairobi = UTC+3, no DST)
  const eat = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const dd = String(eat.getUTCDate()).padStart(2, "0");
  const mm = String(eat.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${eat.getUTCFullYear()}`;
}

export function fmtDateTime(iso: string) {
  if (!iso) return "—";
  if (!iso.includes("T")) {
    // Date-only string — no real time was stored, just show the date
    return fmtDate(iso);
  }
  // Full timestamp — convert to EAT (UTC+3, no DST)
  const eat = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  const dd = String(eat.getUTCDate()).padStart(2, "0");
  const mm = String(eat.getUTCMonth() + 1).padStart(2, "0");
  const yyyy = eat.getUTCFullYear();
  let h = eat.getUTCHours();
  const min = String(eat.getUTCMinutes()).padStart(2, "0");
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return `${dd}/${mm}/${yyyy} ${String(h).padStart(2, "0")}:${min} ${ampm}`;
}
