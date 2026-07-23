export type TransactionType = "expense" | "income";
export type ExtractionSource = "manual" | "local_ocr" | "cloud_llm";

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

export function todayIsoDate(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
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
  const normalized = value.replace(/[^0-9.,-]/g, "").replace(/,/g, "");
  if (!normalized || normalized === "-" || normalized === ".") return null;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 100);
}
