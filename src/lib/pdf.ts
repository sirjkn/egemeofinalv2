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
