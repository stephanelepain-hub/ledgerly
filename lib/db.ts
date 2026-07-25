import type { SQLiteDatabase } from "expo-sqlite";

import {
  createId,
  getPeriodRange,
  isDateInPeriodRange,
  type Category,
  type DashboardSummary,
  type SummaryPeriod,
  type ReceiptLineItem,
  type Transaction,
  type TransactionInput,
  type TransactionType,
} from "@/lib/types";

const DATABASE_VERSION = 2;

export const PREDEFINED_CATEGORIES: Omit<Category, "createdAt">[] = [
  { id: "groceries", name: "Groceries", icon: "shopping-cart", color: "#0F766E", isCustom: false },
  { id: "fuel", name: "Fuel", icon: "local-gas-station", color: "#B45309", isCustom: false },
  { id: "dining", name: "Dining", icon: "restaurant", color: "#C2410C", isCustom: false },
  { id: "utilities", name: "Utilities", icon: "bolt", color: "#0369A1", isCustom: false },
  { id: "entertainment", name: "Entertainment", icon: "movie", color: "#7E22CE", isCustom: false },
  { id: "health", name: "Health", icon: "favorite", color: "#BE123C", isCustom: false },
  { id: "transport", name: "Transport", icon: "directions-bus", color: "#4338CA", isCustom: false },
  { id: "shopping", name: "Shopping", icon: "shopping-bag", color: "#A21CAF", isCustom: false },
  { id: "rent", name: "Rent", icon: "home", color: "#475569", isCustom: false },
  { id: "salary", name: "Salary", icon: "payments", color: "#15803D", isCustom: false },
  { id: "other", name: "Other", icon: "category", color: "#64748B", isCustom: false },
];

interface CategoryRow {
  id: string;
  name: string;
  icon: string;
  color: string;
  is_custom: number;
  created_at: string;
}

interface TransactionRow {
  id: string;
  type: TransactionType;
  amount_minor: number;
  date: string;
  category_id: string;
  category_name: string;
  category_icon: string;
  category_color: string;
  merchant: string;
  description: string;
  notes: string;
  receipt_uri: string | null;
  ocr_text: string | null;
  extraction_source: Transaction["extractionSource"];
  line_items_json: string | null;
  created_at: string;
  updated_at: string;
}

function mapCategory(row: CategoryRow): Category {
  return {
    id: row.id,
    name: row.name,
    icon: row.icon,
    color: row.color,
    isCustom: row.is_custom === 1,
    createdAt: row.created_at,
  };
}

function parseLineItems(value: string | null): ReceiptLineItem[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is ReceiptLineItem =>
      !!item && typeof item.id === "string" && typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

function mapTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    type: row.type,
    amountMinor: row.amount_minor,
    date: row.date,
    categoryId: row.category_id,
    categoryName: row.category_name,
    categoryIcon: row.category_icon,
    categoryColor: row.category_color,
    merchant: row.merchant,
    description: row.description,
    notes: row.notes,
    receiptUri: row.receipt_uri,
    ocrText: row.ocr_text,
    extractionSource: row.extraction_source,
    lineItems: parseLineItems(row.line_items_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function migrateDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const current = await db.getFirstAsync<{ user_version: number }>("PRAGMA user_version");
  let version = current?.user_version ?? 0;

  if (version === 0) {
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS categories (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        icon TEXT NOT NULL,
        color TEXT NOT NULL,
        is_custom INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('expense', 'income')),
        amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
        date TEXT NOT NULL,
        category_id TEXT NOT NULL,
        merchant TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        receipt_uri TEXT,
        ocr_text TEXT,
        extraction_source TEXT NOT NULL DEFAULT 'manual',
        line_items_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE RESTRICT
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
      CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_type ON transactions(type);
    `);

    const createdAt = new Date().toISOString();
    for (const category of PREDEFINED_CATEGORIES) {
      await db.runAsync(
        `INSERT OR IGNORE INTO categories (id, name, icon, color, is_custom, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
        category.id,
        category.name,
        category.icon,
        category.color,
        createdAt,
      );
    }
    version = 2;
  }

  if (version < 2) {
    await db.execAsync("ALTER TABLE transactions ADD COLUMN line_items_json TEXT NOT NULL DEFAULT '[]';");
    version = 2;
  }

  if (version < DATABASE_VERSION) {
    throw new Error(`Unsupported Ledgerly database version ${version}`);
  }

  await db.execAsync(`PRAGMA user_version = ${DATABASE_VERSION}`);
}

export async function listCategories(db: SQLiteDatabase): Promise<Category[]> {
  const rows = await db.getAllAsync<CategoryRow>(
    "SELECT * FROM categories ORDER BY is_custom ASC, name COLLATE NOCASE ASC",
  );
  return rows.map(mapCategory);
}

export async function createCategory(
  db: SQLiteDatabase,
  name: string,
  color: string,
  icon = "label",
): Promise<Category> {
  const trimmed = name.trim();
  if (trimmed.length < 2) throw new Error("Category name must contain at least two characters.");
  const category: Category = {
    id: createId("cat"),
    name: trimmed,
    icon,
    color,
    isCustom: true,
    createdAt: new Date().toISOString(),
  };
  await db.runAsync(
    `INSERT INTO categories (id, name, icon, color, is_custom, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    category.id,
    category.name,
    category.icon,
    category.color,
    category.createdAt,
  );
  return category;
}

const TRANSACTION_SELECT = `
  SELECT
    t.*,
    c.name AS category_name,
    c.icon AS category_icon,
    c.color AS category_color
  FROM transactions t
  JOIN categories c ON c.id = t.category_id
`;

export interface TransactionFilters {
  query?: string;
  type?: TransactionType | "all";
  categoryId?: string | "all";
}

export async function listTransactions(
  db: SQLiteDatabase,
  filters: TransactionFilters = {},
): Promise<Transaction[]> {
  const clauses: string[] = [];
  const values: (string | number)[] = [];

  if (filters.type && filters.type !== "all") {
    clauses.push("t.type = ?");
    values.push(filters.type);
  }
  if (filters.categoryId && filters.categoryId !== "all") {
    clauses.push("t.category_id = ?");
    values.push(filters.categoryId);
  }
  if (filters.query?.trim()) {
    clauses.push("(t.merchant LIKE ? OR t.description LIKE ? OR t.notes LIKE ? OR c.name LIKE ?)");
    const query = `%${filters.query.trim()}%`;
    values.push(query, query, query, query);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = await db.getAllAsync<TransactionRow>(
    `${TRANSACTION_SELECT} ${where} ORDER BY t.date DESC, t.created_at DESC`,
    values,
  );
  return rows.map(mapTransaction);
}

export async function saveTransaction(
  db: SQLiteDatabase,
  input: TransactionInput,
): Promise<string> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new Error("Enter an amount greater than zero.");
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
    throw new Error("Enter a date in YYYY-MM-DD format.");
  }
  if (!input.categoryId) throw new Error("Choose a category.");

  const now = new Date().toISOString();
  const id = input.id ?? createId("txn");
  const existing = input.id
    ? await db.getFirstAsync<{ created_at: string }>(
        "SELECT created_at FROM transactions WHERE id = ?",
        input.id,
      )
    : null;

  await db.runAsync(
    `INSERT INTO transactions (
      id, type, amount_minor, date, category_id, merchant, description, notes,
      receipt_uri, ocr_text, extraction_source, line_items_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      type = excluded.type,
      amount_minor = excluded.amount_minor,
      date = excluded.date,
      category_id = excluded.category_id,
      merchant = excluded.merchant,
      description = excluded.description,
      notes = excluded.notes,
      receipt_uri = excluded.receipt_uri,
      ocr_text = excluded.ocr_text,
      extraction_source = excluded.extraction_source,
      line_items_json = excluded.line_items_json,
      updated_at = excluded.updated_at`,
    id,
    input.type,
    input.amountMinor,
    input.date,
    input.categoryId,
    input.merchant.trim(),
    input.description.trim(),
    input.notes?.trim() ?? "",
    input.receiptUri ?? null,
    input.ocrText ?? null,
    input.extractionSource ?? "manual",
    JSON.stringify(input.lineItems ?? []),
    existing?.created_at ?? now,
    now,
  );

  return id;
}

export async function deleteTransaction(db: SQLiteDatabase, id: string): Promise<void> {
  await db.runAsync("DELETE FROM transactions WHERE id = ?", id);
}

/**
 * Finds an existing expense that looks like the same receipt. Same calendar
 * date plus an identical total is a strong signal that a receipt was scanned
 * twice; two separate purchases matching to the cent on one day is rare.
 *
 * Merchant is deliberately not part of the test, because OCR reads the shop
 * name inconsistently and a mismatch there would let real duplicates through.
 * This only ever warns, so the occasional genuine same-day, same-total pair
 * can still be saved.
 */
export function findDuplicateTransaction(
  transactions: Transaction[],
  candidate: { amountMinor: number | null; date: string; excludeId?: string },
): Transaction | undefined {
  if (!candidate.amountMinor || candidate.amountMinor <= 0) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(candidate.date)) return undefined;
  return transactions.find(
    (transaction) =>
      transaction.id !== candidate.excludeId &&
      transaction.type === "expense" &&
      transaction.amountMinor === candidate.amountMinor &&
      transaction.date === candidate.date,
  );
}

export function calculateSummary(
  transactions: Transaction[],
  period: SummaryPeriod,
  now = new Date(),
): DashboardSummary {
  const range = getPeriodRange(period, now);
  const included = transactions.filter((transaction) => isDateInPeriodRange(transaction.date, range));

  const incomeMinor = included
    .filter((transaction) => transaction.type === "income")
    .reduce((sum, transaction) => sum + transaction.amountMinor, 0);
  const expenses = included.filter((transaction) => transaction.type === "expense");
  const expenseMinor = expenses.reduce((sum, transaction) => sum + transaction.amountMinor, 0);
  const categoryTotals = new Map<
    string,
    { categoryName: string; categoryIcon: string; categoryColor: string; amountMinor: number }
  >();

  for (const transaction of expenses) {
    const current = categoryTotals.get(transaction.categoryId);
    categoryTotals.set(transaction.categoryId, {
      categoryName: transaction.categoryName,
      categoryIcon: transaction.categoryIcon,
      categoryColor: transaction.categoryColor,
      amountMinor: (current?.amountMinor ?? 0) + transaction.amountMinor,
    });
  }

  const categorySpending = [...categoryTotals.entries()]
    .map(([categoryId, item]) => ({
      categoryId,
      ...item,
      percentage: expenseMinor === 0 ? 0 : item.amountMinor / expenseMinor,
    }))
    .sort((a, b) => b.amountMinor - a.amountMinor);

  return {
    incomeMinor,
    expenseMinor,
    balanceMinor: incomeMinor - expenseMinor,
    transactionCount: included.length,
    categorySpending,
  };
}
