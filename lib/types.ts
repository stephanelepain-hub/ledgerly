export type TransactionType = "expense" | "income";
export type ExtractionSource = "manual" | "local_ocr" | "cloud_llm";

/** A locally recognized receipt line, always subject to user review. */
export interface ReceiptLineItem {
  id: string;
  name: string;
  quantity: number | null;
  unitPriceMinor: number | null;
  lineTotalMinor: number | null;
  confidence: number;
}

export interface Category {
  id: string;
  name: string;
  icon: string;
  color: string;
  isCustom: boolean;
  createdAt: string;
}

export interface Transaction {
  id: string;
  type: TransactionType;
  amountMinor: number;
  date: string;
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  merchant: string;
  description: string;
  notes: string;
  receiptUri: string | null;
  ocrText: string | null;
  extractionSource: ExtractionSource;
  lineItems: ReceiptLineItem[];
  createdAt: string;
  updatedAt: string;
}

export interface TransactionInput {
  id?: string;
  type: TransactionType;
  amountMinor: number;
  date: string;
  categoryId: string;
  merchant: string;
  description: string;
  notes?: string;
  receiptUri?: string | null;
  ocrText?: string | null;
  extractionSource?: ExtractionSource;
  lineItems?: ReceiptLineItem[];
}

export interface DashboardSummary {
  incomeMinor: number;
  expenseMinor: number;
  balanceMinor: number;
  transactionCount: number;
  categorySpending: CategorySpending[];
}

export interface CategorySpending {
  categoryId: string;
  categoryName: string;
  categoryIcon: string;
  categoryColor: string;
  amountMinor: number;
  percentage: number;
}

export type SummaryPeriod = "month" | "year" | "all";

export const DEFAULT_CURRENCY = "EUR";

export function createId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function isoDateFromDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function todayIsoDate(): string {
  return isoDateFromDate(new Date());
}

export function parseIsoDate(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
}

export function formatLongDate(isoDate: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(parseIsoDate(isoDate));
}

export function formatMoney(amountMinor: number, currency = DEFAULT_CURRENCY): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}

export function formatShortDate(isoDate: string): string {
  const parsed = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return isoDate;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: parsed.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
  }).format(parsed);
}

export function getPeriodStart(period: SummaryPeriod, now = new Date()): string | null {
  if (period === "all") return null;
  const year = now.getFullYear();
  const month = period === "month" ? now.getMonth() : 0;
  const local = new Date(year, month, 1);
  return [
    local.getFullYear(),
    String(local.getMonth() + 1).padStart(2, "0"),
    "01",
  ].join("-");
}

export function parseAmountToMinor(value: string): number | null {
  const normalized = value.replace(/[^0-9.,]/g, "");
  if (!/\d/.test(normalized)) return null;

  const lastComma = normalized.lastIndexOf(",");
  const lastDot = normalized.lastIndexOf(".");
  let decimalIndex = -1;

  if (lastComma >= 0 && lastDot >= 0) {
    decimalIndex = Math.max(lastComma, lastDot);
  } else {
    const separatorIndex = Math.max(lastComma, lastDot);
    if (separatorIndex >= 0) {
      const fractionLength = normalized.length - separatorIndex - 1;
      // A single separator followed by one or two digits is a decimal mark.
      // Three digits is treated as a thousands group: 1,234 or 1.234.
      if (fractionLength > 0 && fractionLength <= 2) decimalIndex = separatorIndex;
    }
  }

  const whole = (decimalIndex >= 0 ? normalized.slice(0, decimalIndex) : normalized).replace(/[.,]/g, "");
  const fraction = decimalIndex >= 0 ? normalized.slice(decimalIndex + 1).replace(/[.,]/g, "") : "";
  const parsed = Number(`${whole || "0"}.${fraction || "0"}`);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}
