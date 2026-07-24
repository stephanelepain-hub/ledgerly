import * as FileSystem from "expo-file-system/legacy";
import * as Print from "expo-print";
import * as Sharing from "expo-sharing";

import {
  formatLongDate,
  formatMoney,
  getPeriodRange,
  isDateInPeriodRange,
  isoDateFromDate,
  type Transaction,
} from "@/lib/types";

export type ExportPeriod = "month" | "year" | "all";

export function filterTransactionsForExport(
  transactions: Transaction[],
  period: ExportPeriod,
  now = new Date(),
): Transaction[] {
  const range = getPeriodRange(period, now);
  return transactions.filter((transaction) => isDateInPeriodRange(transaction.date, range));
}

export function exportPeriodLabel(period: ExportPeriod, now = new Date()): string {
  if (period === "all") return "All time";
  if (period === "year") return String(now.getFullYear());
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(now);
}

function escapeCsv(value: string | number): string {
  const normalized = String(value).replace(/"/g, '""');
  return /[",\n\r]/.test(normalized) ? `"${normalized}"` : normalized;
}

export function createTransactionsCsv(transactions: Transaction[]): string {
  const headers = [
    "Date",
    "Type",
    "Amount",
    "Currency",
    "Category",
    "Merchant",
    "Description",
    "Notes",
  ];
  const rows = transactions.map((transaction) => [
    transaction.date,
    transaction.type,
    (transaction.amountMinor / 100).toFixed(2),
    "EUR",
    transaction.categoryName,
    transaction.merchant,
    transaction.description,
    transaction.notes,
  ]);

  return [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function reportHtml(transactions: Transaction[], periodLabel: string): string {
  const incomeMinor = transactions
    .filter((transaction) => transaction.type === "income")
    .reduce((total, transaction) => total + transaction.amountMinor, 0);
  const expenseMinor = transactions
    .filter((transaction) => transaction.type === "expense")
    .reduce((total, transaction) => total + transaction.amountMinor, 0);
  const rows = transactions
    .map(
      (transaction) => `
        <tr>
          <td>${escapeHtml(formatLongDate(transaction.date))}</td>
          <td>${escapeHtml(transaction.type)}</td>
          <td class="amount ${transaction.type}">${escapeHtml(formatMoney(transaction.amountMinor))}</td>
          <td>${escapeHtml(transaction.categoryName)}</td>
          <td>${escapeHtml(transaction.merchant || "—")}</td>
          <td>${escapeHtml(transaction.description || "—")}</td>
        </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      @page { margin: 22mm 14mm; }
      body { color: #102A43; font-family: Arial, sans-serif; font-size: 10px; }
      h1 { margin: 0; font-size: 24px; }
      h2 { margin: 5px 0 20px; color: #52606D; font-size: 13px; font-weight: normal; }
      .summary { display: flex; gap: 12px; margin-bottom: 20px; }
      .metric { border: 1px solid #D9E2EC; border-radius: 8px; flex: 1; padding: 10px; }
      .metric-label { color: #52606D; font-size: 9px; text-transform: uppercase; }
      .metric-value { font-size: 16px; font-weight: bold; margin-top: 4px; }
      table { border-collapse: collapse; width: 100%; }
      th { background: #102A43; color: white; font-size: 9px; padding: 7px; text-align: left; }
      td { border-bottom: 1px solid #D9E2EC; padding: 7px; vertical-align: top; }
      .amount { font-weight: bold; white-space: nowrap; }
      .income { color: #15803D; }
      .expense { color: #B42318; }
      .footer { color: #7B8794; font-size: 8px; margin-top: 16px; }
    </style>
  </head>
  <body>
    <h1>Ledgerly export</h1>
    <h2>${escapeHtml(periodLabel)} · ${transactions.length} ${transactions.length === 1 ? "record" : "records"}</h2>
    <div class="summary">
      <div class="metric"><div class="metric-label">Income</div><div class="metric-value income">${escapeHtml(formatMoney(incomeMinor))}</div></div>
      <div class="metric"><div class="metric-label">Expenses</div><div class="metric-value expense">${escapeHtml(formatMoney(expenseMinor))}</div></div>
      <div class="metric"><div class="metric-label">Net balance</div><div class="metric-value">${escapeHtml(formatMoney(incomeMinor - expenseMinor))}</div></div>
    </div>
    <table>
      <thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Category</th><th>Merchant</th><th>Description</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="footer">Generated locally by Ledgerly on ${escapeHtml(formatLongDate(isoDateFromDate(new Date())))}. Receipt images are not included.</p>
  </body>
</html>`;
}

async function shareFile(uri: string, mimeType: string, dialogTitle: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is not available on this device.");
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle });
}

function fileUri(filename: string): string {
  if (!FileSystem.cacheDirectory) {
    throw new Error("Ledgerly could not access temporary export storage.");
  }
  return `${FileSystem.cacheDirectory}${filename}`;
}

export async function shareTransactionsCsv(
  transactions: Transaction[],
  periodLabel: string,
): Promise<void> {
  const filename = `ledgerly-${periodLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-export.csv`;
  const uri = fileUri(filename);
  await FileSystem.writeAsStringAsync(uri, `\uFEFF${createTransactionsCsv(transactions)}`, {
    encoding: FileSystem.EncodingType.UTF8,
  });
  await shareFile(uri, "text/csv", "Export Ledgerly CSV");
}

export async function shareTransactionsPdf(
  transactions: Transaction[],
  periodLabel: string,
): Promise<void> {
  const { uri } = await Print.printToFileAsync({ html: reportHtml(transactions, periodLabel) });
  await shareFile(uri, "application/pdf", "Export Ledgerly PDF report");
}
