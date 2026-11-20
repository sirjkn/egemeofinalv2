// ─── Cross-links between records ──────────────────────────────────────────────
// Member names, projects and plots shown anywhere in the app can be clicked to
// open the matching record:
//   member  → Shareholders / Clients / Investors page, filtered to that person
//   project → Projects page with that project open
//   plot    → Projects page with the project open and the plot highlighted
// Only staff (admin / reception) get links; members see plain text because they
// cannot open other people's records.

import type { ReactNode, MouseEvent } from "react";
import { useNavigate } from "react-router";
import { useImpersonation } from "@/lib/impersonation";

export type LinkMemberType = "shareholder" | "client" | "investor";

const LINK_CLS = "text-left hover:underline underline-offset-2 hover:text-indigo-700 cursor-pointer";

/** True when the current (or previewed) user may open other members' records. */
export function useCanOpenRecords(): boolean {
  const { impersonating, realProfile } = useImpersonation();
  const role = impersonating?.role ?? realProfile?.role;
  return role === "admin" || role === "reception";
}

function useLink(go: (navigate: ReturnType<typeof useNavigate>) => void) {
  const navigate = useNavigate();
  return (e: MouseEvent) => {
    // Don't also trigger a clickable row/card underneath.
    e.stopPropagation();
    e.preventDefault();
    go(navigate);
  };
}

export function memberPath(type: LinkMemberType | string | null | undefined, name: string): string {
  const page = type === "client" ? "clients" : type === "investor" ? "investors" : "shareholders";
  return `/${page}?q=${encodeURIComponent(name)}`;
}

export function MemberLink({ type, name, className = "", children }: {
  type: LinkMemberType | string | null | undefined;
  name: string | null | undefined;
  className?: string;
  children?: ReactNode;
}) {
  const can = useCanOpenRecords();
  const onClick = useLink((navigate) => { if (name) navigate(memberPath(type, name)); });
  const label = children ?? name ?? "—";
  if (!can || !name) return <span className={className}>{label}</span>;
  const kind = type === "client" ? "client" : type === "investor" ? "investor" : "shareholder";
  return <button type="button" onClick={onClick} title={`Open ${kind}`} className={`${className} ${LINK_CLS}`}>{label}</button>;
}

export function ProjectLink({ projectId, className = "", children }: {
  projectId: number | string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const can = useCanOpenRecords();
  const id = Number(projectId);
  const onClick = useLink((navigate) => navigate("/projects", { state: { projectId: id } }));
  if (!can || !id) return <span className={className}>{children}</span>;
  return <button type="button" onClick={onClick} title="Open project" className={`${className} ${LINK_CLS}`}>{children}</button>;
}

export function PlotLink({ projectId, plotId, className = "", children }: {
  projectId: number | string | null | undefined;
  plotId: number | string | null | undefined;
  className?: string;
  children: ReactNode;
}) {
  const can = useCanOpenRecords();
  const pid = Number(projectId);
  const lid = Number(plotId);
  const onClick = useLink((navigate) => navigate("/projects", { state: lid ? { projectId: pid, plotId: lid } : { projectId: pid } }));
  if (!can || !pid) return <span className={className}>{children}</span>;
  return <button type="button" onClick={onClick} title="Open plot" className={`${className} ${LINK_CLS}`}>{children}</button>;
}
