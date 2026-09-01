import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import { type CompanyDetails, DEFAULT_COMPANY } from "@/lib/company";

// Mobile-safe save: opens PDF in new tab on mobile where anchor-download is blocked
function mobileSave(doc: jsPDF, filename: string) {
  const isMobile = /Android|iPhone|iPad|iPod|Opera Mini|IEMobile/i.test(navigator.userAgent);
  if (isMobile) {
    const blob = doc.output("blob");
    const url = URL.createObjectURL(blob);
    const w = window.open(url, "_blank");
    if (!w) {
      // If popup blocked, fall back to data URI
      const uri = doc.output("datauristring");
      const a = document.createElement("a");
      a.href = uri;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } else {
    doc.save(filename);
  }
}

const ACCENT     = [30, 45, 74]   as [number, number, number];
const ACCENT_MID = [50, 75, 120]  as [number, number, number];
const FALLBACK_ADDRESS = "Bypass Arcade, First Floor Room 1";

// ─── Shared header (company letterhead) ──────────────────────────────────────

function addCompanyHeader(doc: jsPDF, company: CompanyDetails, reportTitle: string, subtitle?: string): number {
  const w = doc.internal.pageSize.getWidth();

  // Logo (left side) — white background, no colour band
  let textX = 14;
  if (company.logo_data_url) {
    try {
      const fmt = company.logo_data_url.startsWith("data:image/png") ? "PNG" : "JPEG";
      doc.addImage(company.logo_data_url, fmt, 10, 6, 30, 30);
      textX = 46;
    } catch { /* ignore bad image data */ }
  }

  const name    = company.name     || DEFAULT_COMPANY.name;
  const address = company.location || FALLBACK_ADDRESS;

  // Company name
  doc.setTextColor(...ACCENT);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(14);
  doc.text(name, textX, 14);

  // Address
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(80, 80, 80);
  doc.text(address, textX, 21);

  // Phone · Email · Website
  const contactParts = [company.phone, company.email, company.website].filter(Boolean);
  if (contactParts.length > 0) {
    doc.setFontSize(8);
    doc.setTextColor(100, 100, 100);
    doc.text(contactParts.join("   ·   "), textX, 28);
  }

  // Generated date (top right)
  const dateStr = new Date().toLocaleDateString("en-KE", { day: "2-digit", month: "short", year: "numeric" });
  doc.setFontSize(7.5);
  doc.setTextColor(150, 150, 150);
  doc.text(`Generated: ${dateStr}`, w - 14, 14, { align: "right" });

  // Divider line
  const lineY = 36;
  doc.setDrawColor(...ACCENT);
  doc.setLineWidth(0.5);
  doc.line(14, lineY, w - 14, lineY);

  // Report title below divider — centred
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...ACCENT);
  doc.text(reportTitle, w / 2, lineY + 7, { align: "center" });
  if (subtitle) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8.5);
    doc.setTextColor(100, 100, 100);
    doc.text(subtitle, w / 2, lineY + 13, { align: "center" });
  }

  doc.setTextColor(0, 0, 0);
  return subtitle ? lineY + 19 : lineY + 13; // startY for first table
}

function addPageFooter(doc: jsPDF, company: CompanyDetails) {
  const pages = doc.getNumberOfPages();
  const name = company.name || DEFAULT_COMPANY.name;
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    const w = doc.internal.pageSize.getWidth();
    const h = doc.internal.pageSize.getHeight();
    doc.setFillColor(245, 247, 250);
    doc.rect(0, h - 10, w, 10, "F");
    doc.setFontSize(7);
    doc.setTextColor(140);
    doc.text(`${name}`, 14, h - 4);
    doc.text(`Page ${i} of ${pages}`, w - 14, h - 4, { align: "right" });
  }
}

// ─── Member Contribution Statement PDF ───────────────────────────────────────
// Mirrors the on-screen view: Month/Type · Date · Amount · Notes/Method
// Refund rows rendered with red text

export interface StatementRow {
  kind: "contrib" | "refund";
  label: string;   // "Jan 2024" or "Refund"
  date: string;
  amount: number;
  badge: string;   // "On time" | "Late" | "Refund"
  notes: string;   // plain-text comment (not raw JSON)
  method?: string; // "M-Pesa" | "Cash" | "Bank" | "Cheque" | ""
}

export interface ProfitRow {
  date: string;    // "May 2026"
  project: string; // "Project 4"
  amount: number;
}

export async function downloadMemberStatementPdf(
  memberName: string,
  memberNo: string,
  rows: StatementRow[],
  netBalance: number,
  company: CompanyDetails,
  profitRows?: ProfitRow[],
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(
    doc, company,
    "Contribution Statement",
    `${memberName}  ·  ${memberNo}`,
  );

  const contribCount = rows.filter((r) => r.kind === "contrib").length;
  const refundCount  = rows.filter((r) => r.kind === "refund").length;
  const footLabel    = [
    `${contribCount} contribution${contribCount !== 1 ? "s" : ""}`,
    refundCount > 0 ? `${refundCount} refund${refundCount !== 1 ? "s" : ""}` : "",
  ].filter(Boolean).join("   ·   ");

  autoTable(doc, {
    startY,
    head: [["Month / Type", "Date", "Amount (KES)", "Method", "Status", "Comments"]],
    body: rows.map((r) => [
      r.kind === "refund" ? `[Refund] ${r.label}` : r.label,
      r.date || "—",
      r.kind === "refund"
        ? `− ${Number(r.amount).toLocaleString("en-KE")}`
        : Number(r.amount).toLocaleString("en-KE"),
      r.kind === "refund" ? "—" : (r.method || "—"),
      r.badge,
      r.notes || (r.kind === "refund" ? "Refund issued" : "—"),
    ]),
    foot: [[
      footLabel,
      "Net Balance",
      Number(netBalance).toLocaleString("en-KE"),
      "",
      "",
      "",
    ]],
    headStyles: {
      fillColor: ACCENT,
      textColor: 255,
      fontStyle: "bold",
      fontSize: 8,
    },
    footStyles: {
      fillColor: [240, 253, 244],
      textColor: [22, 163, 74] as [number, number, number],
      fontStyle: "bold",
      fontSize: 8.5,
    },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [235, 245, 255] },
    columnStyles: {
      2: { cellWidth: "wrap" },
      4: { cellWidth: "wrap" },
      5: { cellWidth: 80 },
    },
    didParseCell(data) {
      if (data.section === "body") {
        const row = rows[data.row.index];
        if (row?.kind === "refund") {
          data.cell.styles.textColor = [185, 28, 28] as [number, number, number];
          data.cell.styles.fillColor = [255, 241, 242] as [number, number, number];
        } else if (row?.badge === "Late" && data.column.index === 4) {
          data.cell.styles.textColor = [185, 28, 28] as [number, number, number];
          data.cell.styles.fontStyle = "bold";
        }
      }
    },
    didDrawPage: () => addPageFooter(doc, company),
    margin: { left: 14, right: 14 },
  });

  if (profitRows && profitRows.length > 0) {
    const prevY = (doc as any).lastAutoTable.finalY + 10;
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...ACCENT_MID);
    doc.text("Profits Distributed", 14, prevY);
    const profitTotal = profitRows.reduce((s, r) => s + r.amount, 0);
    autoTable(doc, {
      startY: prevY + 4,
      head: [["Date", "Project", "Amount (KES)"]],
      body: profitRows.map((r) => [r.date, r.project, Number(r.amount).toLocaleString("en-KE")]),
      foot: [["", "TOTAL", Number(profitTotal).toLocaleString("en-KE")]],
      headStyles: { fillColor: [21, 128, 61] as [number, number, number], textColor: 255, fontStyle: "bold", fontSize: 8 },
      footStyles: { fillColor: [240, 253, 244], textColor: [22, 163, 74] as [number, number, number], fontStyle: "bold", fontSize: 8.5 },
      bodyStyles: { fontSize: 8 },
      alternateRowStyles: { fillColor: [240, 253, 244] },
      didDrawPage: () => addPageFooter(doc, company),
      margin: { left: 14, right: 14 },
    });
  }

  mobileSave(doc, `statement-${memberName.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.pdf`);
}

// ─── Payments PDF ──────────────────────────────────────────────────────────────

export interface PaymentRow {
  payment_id: string;
  date_paid: string;
  amount: number;
  paid_by: string;
  purpose: string;
  mode: string;
  comment: string;
}

export async function downloadPaymentsPdf(rows: PaymentRow[], company: CompanyDetails, filters?: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(doc, company, "Payments Report", filters);

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  autoTable(doc, {
    startY,
    head: [["Date Paid", "Amount (KES)", "Paid By", "Purpose", "Mode", "Comment"]],
    body: rows.map((r) => [
      r.date_paid,
      Number(r.amount).toLocaleString("en-KE"),
      r.paid_by,
      r.purpose,
      r.mode,
      r.comment || "—",
    ]),
    foot: [["TOTAL", Number(total).toLocaleString("en-KE"), "", "", "", ""]],
    headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 8 },
    footStyles: { fillColor: [245, 247, 250], textColor: 50, fontStyle: "bold", fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    columnStyles: {
      1: { cellWidth: "wrap" },
      5: { cellWidth: 85 },
    },
    didDrawPage: () => addPageFooter(doc, company),
  });

  mobileSave(doc, `payments-${Date.now()}.pdf`);
}

// ─── Contributions PDF ────────────────────────────────────────────────────────

export interface ContribRow {
  member: string;
  memberNo: string;
  month: string;
  year: number;
  date_paid: string;
  amount: number;
  status: string;
  notes: string;
}

export async function downloadContributionsPdf(rows: ContribRow[], company: CompanyDetails, filters?: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(doc, company, "Contributions Report", filters);

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  autoTable(doc, {
    startY,
    head: [["Member", "Member No.", "Month", "Year", "Date Paid", "Amount (KES)", "Status", "Notes"]],
    body: rows.map((r) => [
      r.member,
      r.memberNo,
      r.month,
      r.year,
      r.date_paid || "—",
      Number(r.amount).toLocaleString("en-KE"),
      r.status,
      r.notes || "—",
    ]),
    foot: [["", "", "", "", "TOTAL", Number(total).toLocaleString("en-KE"), "", ""]],
    headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 8 },
    footStyles: { fillColor: [245, 247, 250], textColor: 50, fontStyle: "bold", fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    columnStyles: {
      5: { cellWidth: "wrap" },
      6: { cellWidth: "wrap" },
      7: { cellWidth: 75 },
    },
    didDrawPage: () => addPageFooter(doc, company),
  });

  mobileSave(doc, `contributions-${Date.now()}.pdf`);
}

// ─── Members PDF ──────────────────────────────────────────────────────────────

export interface MemberRow {
  member_no: string;
  name: string;
  phone: string;
  email: string;
  joined: string;
  status: string;
  net_savings?: string;
}

export async function downloadMembersPdf(rows: MemberRow[], title: string, company: CompanyDetails, filters?: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(doc, company, title, filters);

  autoTable(doc, {
    startY,
    head: [["Member No.", "Name", "Phone", "Email", "Joined", "Status", "Net Savings"]],
    body: rows.map((r) => [r.member_no, r.name, r.phone, r.email || "—", r.joined, r.status, r.net_savings ?? "—"]),
    headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 8 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 251, 252] },
    didDrawPage: () => addPageFooter(doc, company),
  });

  mobileSave(doc, `${title.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.pdf`);
}

// ─── Refunds PDF ──────────────────────────────────────────────────────────────

export interface RefundRow {
  member: string;
  member_no: string;
  amount: number;
  refund_date: string;
  notes: string;
}

export async function downloadRefundsPdf(rows: RefundRow[], company: CompanyDetails, filters?: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(doc, company, "Refunds Report", filters);

  const total = rows.reduce((s, r) => s + Number(r.amount), 0);

  autoTable(doc, {
    startY,
    head: [["Member", "Member No.", "Amount (KES)", "Refund Date", "Notes"]],
    body: rows.map((r) => [r.member, r.member_no, Number(r.amount).toLocaleString("en-KE"), r.refund_date, r.notes || "—"]),
    foot: [["", "TOTAL", Number(total).toLocaleString("en-KE"), "", ""]],
    headStyles: { fillColor: [127, 29, 29] as [number, number, number], textColor: 255, fontStyle: "bold", fontSize: 9 },
    footStyles: { fillColor: [254, 242, 242], textColor: 50, fontStyle: "bold", fontSize: 9 },
    bodyStyles: { fontSize: 9 },
    alternateRowStyles: { fillColor: [255, 250, 250] },
    columnStyles: { 2: { cellWidth: "wrap" } },
    didDrawPage: () => addPageFooter(doc, company),
  });

  mobileSave(doc, `refunds-${Date.now()}.pdf`);
}

// ─── Summary / Reports PDF ────────────────────────────────────────────────────

export interface SummarySection {
  title: string;
  rows: string[][];
  headers: string[];
  total?: number;
  totalLabel?: string;
}

export async function downloadReportPdf(sections: SummarySection[], reportTitle: string, company: CompanyDetails, period?: string) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  let y = addCompanyHeader(doc, company, reportTitle, period);

  for (const section of sections) {
    if (y > 240) { doc.addPage(); y = 28; }
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...ACCENT_MID);
    doc.text(section.title, 14, y);
    y += 3;

    autoTable(doc, {
      startY: y,
      head: [section.headers],
      body: section.rows,
      ...(section.total !== undefined ? {
        foot: [[...new Array(section.headers.length - 2).fill(""), "TOTAL", Number(section.total).toLocaleString("en-KE")]],
        footStyles: { fillColor: [245, 247, 250], fontStyle: "bold", fontSize: 8 },
      } : {}),
      headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 8 },
      bodyStyles: { fontSize: 8 },
      alternateRowStyles: { fillColor: [250, 251, 252] },
      didDrawPage: () => addPageFooter(doc, company),
      margin: { left: 14, right: 14 },
    });

    y = (doc as any).lastAutoTable.finalY + 8;
  }

  mobileSave(doc, `${reportTitle.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}.pdf`);
}

// ─── Shareholder Contribution History PDF ────────────────────────────────────

export interface ContribHistoryRow {
  month: string;        // "Jan 2024"
  date_paid: string;
  amount: number;
  method: string;       // "M-Pesa" | "Cash" | "Bank" | "Cheque" | ""
  status: string;       // "On time" | "Late"
  notes: string;        // plain-text comment (not raw JSON)
}

export async function downloadContributionHistoryPdf(
  memberName: string,
  memberNo: string,
  rows: ContribHistoryRow[],
  company: CompanyDetails,
  netBalance?: number,
  profitRows?: ProfitRow[],
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(
    doc, company,
    "Contributions / Payments Statement",
    `${memberName}  ·  ${memberNo}`,
  );

  const rawTotal  = rows.reduce((s, r) => s + Number(r.amount), 0);
  const footTotal = netBalance != null ? netBalance : rawTotal;
  const footLabel = netBalance != null ? "Net Balance" : "Total";

  autoTable(doc, {
    startY,
    head: [["Month", "Date Paid", "Amount (KES)", "Method", "Status", "Comments"]],
    body: rows.map((r) => [
      r.month,
      r.date_paid || "—",
      Number(r.amount).toLocaleString("en-KE"),
      r.method || "—",
      r.status,
      r.notes || "—",
    ]),
    foot: [[
      `${rows.length} record${rows.length !== 1 ? "s" : ""}`,
      footLabel,
      Number(footTotal).toLocaleString("en-KE"),
      "",
      "",
      "",
    ]],
    headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 8 },
    footStyles: { fillColor: [240, 253, 244], textColor: [22, 163, 74] as [number, number, number], fontStyle: "bold", fontSize: 8.5 },
    bodyStyles: { fontSize: 8 },
    alternateRowStyles: { fillColor: [235, 245, 255] },
    columnStyles: {
      2: { cellWidth: "wrap" },
      4: { cellWidth: "wrap" },
      5: { cellWidth: 75 },
    },
    didParseCell(data) {
      if (data.section === "body") {
        const row = rows[data.row.index];
        if (row?.status === "Late" && data.column.index === 4) {
          data.cell.styles.textColor = [185, 28, 28] as [number, number, number];
          data.cell.styles.fontStyle = "bold";
        }
      }
    },
    didDrawPage: () => addPageFooter(doc, company),
    margin: { left: 14, right: 14 },
  });

  if (profitRows && profitRows.length > 0) {
    const prevY = (doc as any).lastAutoTable.finalY + 10;
    doc.setFontSize(9.5);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(...ACCENT_MID);
    doc.text("Profits Distributed", 14, prevY);
    const profitTotal = profitRows.reduce((s, r) => s + r.amount, 0);
    autoTable(doc, {
      startY: prevY + 4,
      head: [["Date", "Project", "Amount (KES)"]],
      body: profitRows.map((r) => [r.date, r.project, Number(r.amount).toLocaleString("en-KE")]),
      foot: [["", "TOTAL", Number(profitTotal).toLocaleString("en-KE")]],
      headStyles: { fillColor: [21, 128, 61] as [number, number, number], textColor: 255, fontStyle: "bold", fontSize: 8 },
      footStyles: { fillColor: [240, 253, 244], textColor: [22, 163, 74] as [number, number, number], fontStyle: "bold", fontSize: 8.5 },
      bodyStyles: { fontSize: 8 },
      alternateRowStyles: { fillColor: [240, 253, 244] },
      didDrawPage: () => addPageFooter(doc, company),
      margin: { left: 14, right: 14 },
    });
  }

  mobileSave(doc, `contributions-${memberName.replace(/\s+/g, "-").toLowerCase()}-${Date.now()}.pdf`);
}

// ─── Plot Payment History PDF ─────────────────────────────────────────────────

export interface PlotPaymentHistoryRow {
  date: string;
  amount: number;
  method: string;
  ref: string;
  paidBy: string;
  phone: string;
  note: string;
}

export async function downloadPlotPaymentHistoryPdf(
  plotNumber: string,
  projectName: string,
  rows: PlotPaymentHistoryRow[],
  paidTotal: number,
  dueTotal: number,
  company: CompanyDetails,
) {
  const doc = new jsPDF({ orientation: "landscape", unit: "mm", format: "a4" });
  const startY = addCompanyHeader(
    doc, company,
    `Plot Payment History — ${plotNumber}`,
    `${projectName}  ·  Paid: KES ${paidTotal.toLocaleString("en-KE")}  ·  Due: KES ${dueTotal.toLocaleString("en-KE")}`,
  );

  const totalPaid = rows.reduce((s, r) => s + Number(r.amount), 0);

  autoTable(doc, {
    startY,
    head: [["Date", "Amount (KES)", "Method", "TXN Code", "Paid By", "Phone", "Comments"]],
    body: rows.map((r) => [
      r.date || "—",
      Number(r.amount).toLocaleString("en-KE"),
      r.method || "—",
      r.ref || "—",
      r.paidBy || "—",
      r.phone || "—",
      r.note || "—",
    ]),
    foot: [[
      `${rows.length} payment${rows.length !== 1 ? "s" : ""}`,
      Number(totalPaid).toLocaleString("en-KE"),
      "", "", "", "", "",
    ]],
    headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: "bold", fontSize: 7.5 },
    footStyles: { fillColor: [240, 253, 244], textColor: [22, 163, 74] as [number, number, number], fontStyle: "bold", fontSize: 8 },
    bodyStyles: { fontSize: 7.5 },
    alternateRowStyles: { fillColor: [235, 245, 255] },
    columnStyles: { 1: { cellWidth: "wrap" } },
    didDrawPage: () => addPageFooter(doc, company),
    margin: { left: 14, right: 14 },
  });

  mobileSave(doc, `plot-${plotNumber.replace(/\s+/g, "-").toLowerCase()}-payments-${Date.now()}.pdf`);
}

// ─── Mpesa message parser ─────────────────────────────────────────────────────

export interface ParsedMpesa {
  txnCode: string;
  amount: number;
  paidBy: string;
  phone: string;
}

// ─── System User Guide PDF ────────────────────────────────────────────────────

export async function downloadSystemGuidePdf(company: CompanyDetails): Promise<void> {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pw = doc.internal.pageSize.getWidth();
  const ph = doc.internal.pageSize.getHeight();
  const margin = 14;
  const col = pw - margin * 2;

  const navy: [number, number, number] = [30, 45, 74];
  const green: [number, number, number] = [22, 163, 74];
  const slate: [number, number, number] = [71, 85, 105];
  const light: [number, number, number] = [241, 245, 249];
  const white: [number, number, number] = [255, 255, 255];

  const addFooter = (page: number, total: number) => {
    doc.setPage(page);
    doc.setFontSize(7.5).setTextColor(...slate);
    doc.text(`${company.name ?? "SACCO"} — System User Guide`, margin, ph - 8);
    doc.text(`Page ${page} of ${total}`, pw - margin, ph - 8, { align: "right" });
    doc.setDrawColor(220, 220, 220);
    doc.setLineWidth(0.3);
    doc.line(margin, ph - 11, pw - margin, ph - 11);
  };

  // ── Cover page ──────────────────────────────────────────────────────────────
  doc.setFillColor(...navy);
  doc.rect(0, 0, pw, ph, "F");

  // Logo band
  doc.setFillColor(...green);
  doc.roundedRect(pw / 2 - 20, 38, 40, 40, 5, 5, "F");
  doc.setFontSize(22).setFont("helvetica", "bold").setTextColor(...white);
  const initials = (company.name ?? "SACCO").split(" ").slice(0, 2).map((w) => w[0]).join("").toUpperCase() || "SA";
  doc.text(initials, pw / 2, 63, { align: "center" });

  doc.setFontSize(20).setFont("helvetica", "bold").setTextColor(...white);
  doc.text(company.name ?? "SACCO Management System", pw / 2, 100, { align: "center" });

  doc.setFontSize(13).setFont("helvetica", "normal").setTextColor(180, 210, 180);
  doc.text("System User Guide", pw / 2, 112, { align: "center" });

  doc.setDrawColor(...green);
  doc.setLineWidth(0.6);
  doc.line(margin + 20, 120, pw - margin - 20, 120);

  doc.setFontSize(9).setTextColor(150, 190, 150);
  doc.text("Complete reference for all modules, menus, and access levels", pw / 2, 130, { align: "center" });

  if (company.address) {
    doc.setFontSize(8).setTextColor(120, 160, 120);
    doc.text(company.address, pw / 2, ph - 30, { align: "center" });
  }
  doc.setFontSize(7.5).setTextColor(100, 140, 100);
  doc.text(`Generated ${new Date().toLocaleDateString("en-KE", { day: "2-digit", month: "long", year: "numeric" })}`, pw / 2, ph - 22, { align: "center" });

  // ── Module definitions ──────────────────────────────────────────────────────
  type ModuleSection = {
    title: string;
    icon: string;
    access: string;
    description: string;
    features: { action: string; detail: string }[];
  };

  const modules: ModuleSection[] = [
    {
      title: "Dashboard",
      icon: "📊",
      access: "All roles",
      description: "The landing page after login. Shows a snapshot of the SACCO's financial health and quick-access shortcuts tailored to the logged-in role.",
      features: [
        { action: "Overview stats", detail: "Total savings, member count, active projects, and this month's collections at a glance." },
        { action: "This Month card", detail: "Shareholders see monthly contribution total; clients see plot payment amount for the current month." },
        { action: "Quick Access", detail: "One-tap buttons to the most-used actions (Record Contribution, Make Payment, View Plots, etc.)." },
        { action: "Recent Activity", detail: "Admin sees a live feed of the latest system actions across all members." },
      ],
    },
    {
      title: "Shareholders",
      icon: "👥",
      access: "Admin, Reception (view only)",
      description: "Full lifecycle management of SACCO shareholder members — from registration through contributions, plots, and profit distributions.",
      features: [
        { action: "Member list", detail: "Search, filter by Active/Inactive, and browse all registered shareholders with key stats." },
        { action: "Add Shareholder", detail: "Register a new member with name, phone, ID/passport, email, and join date." },
        { action: "Edit details", detail: "Update contact information, status, and profile photo (admin only)." },
        { action: "Contribution history", detail: "View per-month contribution records with payment date, method, and status (On Time / Late)." },
        { action: "Record Contribution", detail: "Log a monthly contribution — choose month/year, amount, payment method, and transaction code." },
        { action: "Allocated Plots", detail: "See all plots assigned to the member with payment progress and balance." },
        { action: "Profit Distributions", detail: "View dividend/profit records tied to completed projects." },
        { action: "Refunds", detail: "Initiate or view refund records for a member." },
        { action: "Password Reminder", detail: "Send an SMS to the member with their login phone number reminder." },
        { action: "Delete Member", detail: "Permanently remove a member and all linked records (admin only)." },
        { action: "Export PDF", detail: "Download a full contribution statement or plot payment history for the selected member." },
      ],
    },
    {
      title: "Clients",
      icon: "🏠",
      access: "Admin, Reception (view only)",
      description: "Management of plot-buying clients who are not full SACCO shareholders.",
      features: [
        { action: "Client list", detail: "Browse all registered clients with search and Active/Inactive filter." },
        { action: "Add Client", detail: "Register a new client with personal and contact details." },
        { action: "Edit details", detail: "Update name, phone, email, ID, and join date (admin only)." },
        { action: "Plot payments", detail: "View all plot payment records for the selected client." },
        { action: "Loan Accounts", detail: "Placeholder section for future loan tracking." },
        { action: "Delete Client", detail: "Remove a client and all associated records (admin only)." },
      ],
    },
    {
      title: "Contributions",
      icon: "💰",
      access: "Admin (full), Reception (view only), Shareholders (own records)",
      description: "Centralised view of all shareholder monthly contributions across the SACCO.",
      features: [
        { action: "Contribution list", detail: "Filterable by year, month, member, and payment status." },
        { action: "Record Contribution", detail: "Log a contribution for any shareholder — amount, period, payment method, reference." },
        { action: "Edit Contribution", detail: "Correct amount, date, or payment method on an existing entry (admin only)." },
        { action: "Delete Contribution", detail: "Remove an erroneous contribution record (admin only)." },
        { action: "Export PDF", detail: "Download a filtered contribution report with totals." },
        { action: "Receipt printing", detail: "Print a mini receipt for any individual contribution." },
      ],
    },
    {
      title: "Projects",
      icon: "🏗️",
      access: "Admin (full), Reception (view only), Members (own plots)",
      description: "Real estate project and plot management — the core of the SACCO's land investment operations.",
      features: [
        { action: "Project list", detail: "View all projects with status, total plots, and completion progress." },
        { action: "Create Project", detail: "Add a new project with name, location, date, and description." },
        { action: "Manage Plots", detail: "Add, edit, or delete plots within a project — set plot number, price, and size." },
        { action: "Assign Plot", detail: "Allocate a plot to a shareholder or client." },
        { action: "Record Plot Payment", detail: "Log a plot payment via STK Push (M-Pesa) or Manual Code (admin only). Format: ProjectName/Plot Number." },
        { action: "Payment history", detail: "View full payment statement per plot with dates, amounts, and transaction codes." },
        { action: "Co-owners", detail: "Add co-owners to a single plot — multiple members sharing one plot." },
        { action: "Profit Distributions", detail: "Record and view profit payouts to investors/shareholders from a completed project." },
        { action: "Upload Documents", detail: "Attach title deeds, agreements, and other documents to plots or projects." },
        { action: "Export PDF", detail: "Download a full plot payment statement for any plot." },
      ],
    },
    {
      title: "Ext. Investors",
      icon: "📈",
      access: "Admin (full), Reception (view only)",
      description: "External investors who fund SACCO projects in exchange for profit distributions.",
      features: [
        { action: "Investor list", detail: "Browse all registered external investors." },
        { action: "Add Investor", detail: "Register an external investor with contact and investment details." },
        { action: "Edit / Delete", detail: "Update investor records or permanently remove (admin only)." },
        { action: "Profit Distributions", detail: "View and record profit payouts to each investor from completed projects." },
      ],
    },
    {
      title: "Payments (M-Pesa)",
      icon: "📱",
      access: "Admin (full), Reception (can add), Others (view own)",
      description: "Central ledger of all M-Pesa payment transactions recorded in the system.",
      features: [
        { action: "Payment list", detail: "View all payments with filters for year, purpose, date range, and keyword search." },
        { action: "Add Payment", detail: "Record a new M-Pesa payment — available to Admin and Reception." },
        { action: "Edit / Delete", detail: "Correct or remove payment records (admin only)." },
        { action: "Export PDF", detail: "Download a filtered payments report with total." },
      ],
    },
    {
      title: "Refunds",
      icon: "↩️",
      access: "Admin (full), Reception (view only)",
      description: "Tracks refunds issued to members — for overpayments, withdrawals, or corrections.",
      features: [
        { action: "Refund list", detail: "View all refunds with member name, amount, date, and reason." },
        { action: "Issue Refund", detail: "Create a new refund record linked to a member (admin only)." },
        { action: "Export PDF", detail: "Download refund history report." },
      ],
    },
    {
      title: "Reports",
      icon: "📋",
      access: "Admin, Reception (view only)",
      description: "Financial summary reports giving a period-based view of SACCO performance.",
      features: [
        { action: "Summary Report", detail: "Overview of total contributions, payments, refunds, and member counts for a selected period." },
        { action: "Contribution Report", detail: "Breakdown of contributions by month and member." },
        { action: "Payments Report", detail: "Summary of all payments by purpose and period." },
        { action: "Export PDF", detail: "Download any report as a formatted PDF with company header." },
      ],
    },
    {
      title: "M-Pesa Transactions",
      icon: "🔄",
      access: "Admin, Reception (view only)",
      description: "Raw M-Pesa transaction log from Safaricom callbacks — useful for reconciliation.",
      features: [
        { action: "Transaction list", detail: "View all incoming M-Pesa transactions with phone, amount, reference, and timestamp." },
        { action: "Parse SMS", detail: "Paste an M-Pesa confirmation SMS to extract and record transaction details automatically." },
        { action: "Reconcile", detail: "Match transactions to members/payments for accurate records." },
      ],
    },
    {
      title: "Settings",
      icon: "⚙️",
      access: "Admin only",
      description: "System configuration — company profile, payment rules, staff accounts, and maintenance tools.",
      features: [
        { action: "Company Profile", detail: "Set organisation name, logo, address, phone, and email shown on all PDFs and receipts." },
        { action: "Payment Rules", detail: "Configure enabled payment methods (M-Pesa, Cash, Bank, Cheque) and contribution deadline day." },
        { action: "Staff Accounts", detail: "Create and manage Admin and Reception user accounts with role-based access." },
        { action: "SMS Settings", detail: "Configure SMS provider API keys and test SMS delivery." },
        { action: "Data Tools", detail: "Import members via CSV, export data backups, and manage database connection settings." },
        { action: "System Maintenance", detail: "Clear cache, reset settings, and manage system-wide toggles." },
      ],
    },
  ];

  // ── Page 2+: Module sections ────────────────────────────────────────────────
  let y = margin;

  const ensurePage = (needed: number) => {
    if (y + needed > ph - 18) {
      doc.addPage();
      y = margin;
    }
  };

  // Section header helper
  const sectionHeader = (mod: ModuleSection) => {
    ensurePage(28);
    // Coloured bar
    doc.setFillColor(...navy);
    doc.roundedRect(margin, y, col, 14, 2, 2, "F");
    doc.setFontSize(11).setFont("helvetica", "bold").setTextColor(...white);
    doc.text(`${mod.icon}  ${mod.title}`, margin + 4, y + 9.5);
    // Access badge
    doc.setFillColor(...green);
    doc.roundedRect(pw - margin - 2 - doc.getTextWidth(mod.access) - 6, y + 3, doc.getTextWidth(mod.access) + 6, 7, 2, 2, "F");
    doc.setFontSize(7).setFont("helvetica", "bold").setTextColor(...white);
    doc.text(mod.access, pw - margin - 5, y + 8, { align: "right" });
    y += 17;

    // Description
    doc.setFontSize(8.5).setFont("helvetica", "italic").setTextColor(...slate);
    const descLines = doc.splitTextToSize(mod.description, col - 4) as string[];
    descLines.forEach((line: string) => {
      ensurePage(6);
      doc.text(line, margin + 2, y);
      y += 5;
    });
    y += 2;
  };

  doc.addPage();
  y = margin;

  // ── Table of contents ─────────────────────────────────────────────────────
  doc.setFillColor(...light);
  doc.roundedRect(margin, y, col, 10, 2, 2, "F");
  doc.setFontSize(11).setFont("helvetica", "bold").setTextColor(...navy);
  doc.text("Table of Contents", margin + 4, y + 7);
  y += 14;

  modules.forEach((m, i) => {
    doc.setFontSize(9).setFont("helvetica", "normal").setTextColor(...navy);
    doc.text(`${i + 1}.  ${m.icon} ${m.title}`, margin + 4, y);
    doc.setTextColor(...slate);
    doc.setFontSize(8);
    doc.text(m.access, pw - margin, y, { align: "right" });
    y += 7;
  });

  y += 6;

  // ── Role Access Summary table ─────────────────────────────────────────────
  doc.setFillColor(...light);
  doc.roundedRect(margin, y, col, 10, 2, 2, "F");
  doc.setFontSize(11).setFont("helvetica", "bold").setTextColor(...navy);
  doc.text("Role Access Summary", margin + 4, y + 7);
  y += 12;

  autoTable(doc, {
    startY: y,
    head: [["Module", "Admin", "Reception", "Shareholder", "Client", "Investor"]],
    body: [
      ["Dashboard",           "Full",      "Full",      "Own",       "Own",       "Own"       ],
      ["Shareholders",        "Full",      "View only", "—",         "—",         "—"         ],
      ["Clients",             "Full",      "View only", "—",         "—",         "—"         ],
      ["Contributions",       "Full",      "View only", "Own",       "—",         "—"         ],
      ["Projects",            "Full",      "View only", "Own plots", "Own plots", "Own plots" ],
      ["Ext. Investors",      "Full",      "View only", "—",         "—",         "Own"       ],
      ["Payments (M-Pesa)",   "Full",      "Add + View","Own",       "Own",       "—"         ],
      ["Refunds",             "Full",      "View only", "—",         "Own",       "—"         ],
      ["Reports",             "Full",      "View only", "—",         "—",         "—"         ],
      ["M-Pesa Transactions", "Full",      "View only", "—",         "—",         "—"         ],
      ["Settings",            "Full",      "—",         "—",         "—",         "—"         ],
    ],
    headStyles: { fillColor: navy, textColor: 255, fontSize: 8, fontStyle: "bold" },
    bodyStyles: { fontSize: 7.5, textColor: 50 },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: {
      0: { fontStyle: "bold", cellWidth: 44 },
      1: { halign: "center" },
      2: { halign: "center" },
      3: { halign: "center" },
      4: { halign: "center" },
      5: { halign: "center" },
    },
    margin: { left: margin, right: margin },
    didParseCell: (data) => {
      if (data.section === "body" && data.cell.text[0] === "Full") {
        data.cell.styles.textColor = [22, 101, 52];
        data.cell.styles.fontStyle = "bold";
      }
      if (data.section === "body" && data.cell.text[0] === "—") {
        data.cell.styles.textColor = [180, 180, 180];
      }
    },
  });

  y = (doc as any).lastAutoTable.finalY + 10;

  // ── Module sections ────────────────────────────────────────────────────────
  for (const mod of modules) {
    doc.addPage();
    y = margin;
    sectionHeader(mod);

    autoTable(doc, {
      startY: y,
      head: [["Feature / Action", "Description"]],
      body: mod.features.map((f) => [f.action, f.detail]),
      headStyles: { fillColor: [50, 70, 100], textColor: 255, fontSize: 8, fontStyle: "bold" },
      bodyStyles: { fontSize: 8, textColor: 50, valign: "top" },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      columnStyles: {
        0: { fontStyle: "bold", cellWidth: 52, textColor: navy as [number,number,number] },
        1: { cellWidth: col - 52 },
      },
      margin: { left: margin, right: margin },
    });

    y = (doc as any).lastAutoTable.finalY + 6;
  }

  // ── Footer on all pages ────────────────────────────────────────────────────
  const total = (doc.internal as any).getNumberOfPages();
  for (let i = 1; i <= total; i++) addFooter(i, total);

  mobileSave(doc, `${(company.name ?? "SACCO").replace(/\s+/g, "-")}-System-Guide.pdf`);
}

export function parseMpesaMessage(msg: string): Partial<ParsedMpesa> {
  const result: Partial<ParsedMpesa> = {};

  const txnMatch = msg.match(/^([A-Z0-9]+)\s+[Cc]onfirmed/);
  if (txnMatch) result.txnCode = txnMatch[1];

  const amountMatch = msg.match(/[Kk]sh\s?([\d,]+\.?\d*)/);
  if (amountMatch) result.amount = parseFloat(amountMatch[1].replace(/,/g, ""));

  const phoneMatch = msg.match(/(254\d{9}|07\d{8}|01\d{8})/);
  if (phoneMatch) result.phone = phoneMatch[1];

  const nameFromMatch   = msg.match(/from\s+([A-Z][A-Z ]{2,30})\s+(?:254|\d{3})/);
  const nameBeforePhone = msg.match(/([A-Z][A-Z ]{2,30})\s+(?:254\d{9}|07\d{8})/);
  const namePaid        = msg.match(/([A-Z][A-Z ]{2,30})\s+paid\s+/);

  if (nameFromMatch)   result.paidBy = nameFromMatch[1].trim();
  else if (nameBeforePhone) result.paidBy = nameBeforePhone[1].trim();
  else if (namePaid)   result.paidBy = namePaid[1].trim();

  return result;
}
