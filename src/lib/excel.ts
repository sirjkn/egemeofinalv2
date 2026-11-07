export type ExcelCell = string | number | boolean | null | undefined;
export type ExcelSheet = {
  name: string;
  headers: string[];
  rows: ExcelCell[][];
};

function escapeXml(value: ExcelCell) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function safeSheetName(name: string) {
  return name.replace(/[\\/*?:[\]]/g, " ").slice(0, 31) || "Report";
}

/**
 * Downloads a native Excel-compatible SpreadsheetML workbook without adding a
 * large spreadsheet dependency to the client bundle. Excel opens the .xls file
 * directly and preserves separate sheets, numeric cells and bold headers.
 */
export function downloadExcelWorkbook(filename: string, sheets: ExcelSheet[]) {
  const worksheets = sheets.map((sheet) => {
    const rowXml = [sheet.headers, ...sheet.rows].map((row, rowIndex) => {
      const cells = row.map((value) => {
        const isNumber = typeof value === "number" && Number.isFinite(value);
        const type = isNumber ? "Number" : typeof value === "boolean" ? "Boolean" : "String";
        return `<Cell${rowIndex === 0 ? ' ss:StyleID="Header"' : ""}><Data ss:Type="${type}">${escapeXml(value)}</Data></Cell>`;
      }).join("");
      return `<Row>${cells}</Row>`;
    }).join("");
    return `<Worksheet ss:Name="${escapeXml(safeSheetName(sheet.name))}"><Table>${rowXml}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ActivePane>2</ActivePane></WorksheetOptions></Worksheet>`;
  }).join("");

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Center"/><Font ss:FontName="Calibri" ss:Size="11"/></Style>
  <Style ss:ID="Header"><Font ss:FontName="Calibri" ss:Size="11" ss:Bold="1" ss:Color="#FFFFFF"/><Interior ss:Color="#1E3A5F" ss:Pattern="Solid"/></Style>
 </Styles>
 ${worksheets}
</Workbook>`;
  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename.toLowerCase().endsWith(".xls") ? filename : `${filename}.xls`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadExcel(filename: string, sheetName: string, headers: string[], rows: ExcelCell[][]) {
  downloadExcelWorkbook(filename, [{ name: sheetName, headers, rows }]);
}
