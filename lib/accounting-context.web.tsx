import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { calculateSummary, PREDEFINED_CATEGORIES } from "@/lib/db";
import {
  createId,
  type Category,
  type DashboardSummary,
  type SummaryPeriod,
  type Transaction,
  type TransactionInput,
} from "@/lib/types";

const STORAGE_KEY = "ledgerly.browser.records.v1";

interface StoredRecords {
  categories: Category[];
  transactions: Transaction[];
}

interface AccountingContextValue {
  categories: Category[];
  transactions: Transaction[];
  isLoading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addCategory: (name: string, color: string) => Promise<Category>;
  upsertTransaction: (input: TransactionInput) => Promise<string>;
  deleteTransaction: (id: string) => Promise<void>;
  getSummary: (period: SummaryPeriod) => DashboardSummary;
  findTransaction: (id: string) => Transaction | undefined;
}

const AccountingContext = createContext<AccountingContextValue | null>(null);

function seedCategories(): Category[] {
  const createdAt = new Date().toISOString();
  return PREDEFINED_CATEGORIES.map((category) => ({ ...category, createdAt }));
}

function sortTransactions(transactions: Transaction[]): Transaction[] {
  return [...transactions].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate || b.createdAt.localeCompare(a.createdAt);
  });
}

async function loadRecords(): Promise<StoredRecords> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY);
  if (!raw) return { categories: seedCategories(), transactions: [] };

  const parsed = JSON.parse(raw) as Partial<StoredRecords>;
  const existing = Array.isArray(parsed.categories) ? parsed.categories : [];
  const custom = existing.filter((category) => category.isCustom);
  const customIds = new Set(custom.map((category) => category.id));
  const categories = [
    ...seedCategories(),
    ...custom.filter((category) => !PREDEFINED_CATEGORIES.some((item) => item.id === category.id)),
  ].filter((category, index, all) => all.findIndex((item) => item.id === category.id) === index || customIds.has(category.id));
  const transactions = Array.isArray(parsed.transactions) ? sortTransactions(parsed.transactions) : [];
  return { categories, transactions };
}

export function AccountingProvider({ children }: { children: ReactNode }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const applyRecords = useCallback((records: StoredRecords) => {
    setCategories(records.categories);
    setTransactions(sortTransactions(records.transactions));
  }, []);

  const refresh = useCallback(async () => {
    try {
      applyRecords(await loadRecords());
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load browser preview records.");
    } finally {
      setIsLoading(false);
    }
  }, [applyRecords]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const persist = useCallback(async (nextCategories: Category[], nextTransactions: Transaction[]) => {
    const records = { categories: nextCategories, transactions: sortTransactions(nextTransactions) };
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(records));
    applyRecords(records);
    setError(null);
  }, [applyRecords]);

  const addCategory = useCallback(async (name: string, color: string) => {
    const trimmed = name.trim();
    if (trimmed.length < 2) throw new Error("Category name must contain at least two characters.");
    if (categories.some((category) => category.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error("A category with this name already exists.");
    }
    const category: Category = {
      id: createId("cat"),
      name: trimmed,
      icon: "label",
      color,
      isCustom: true,
      createdAt: new Date().toISOString(),
    };
    await persist([...categories, category], transactions);
    return category;
  }, [categories, persist, transactions]);

  const upsertTransaction = useCallback(async (input: TransactionInput) => {
    if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new Error("Enter an amount greater than zero.");
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      throw new Error("Enter a date in YYYY-MM-DD format.");
    }
    const category = categories.find((item) => item.id === input.categoryId);
    if (!category) throw new Error("Choose a category.");

    const now = new Date().toISOString();
    const existing = input.id ? transactions.find((item) => item.id === input.id) : undefined;
    const id = input.id ?? createId("txn");
    const transaction: Transaction = {
      id,
      type: input.type,
      amountMinor: input.amountMinor,
      date: input.date,
      categoryId: category.id,
      categoryName: category.name,
      categoryIcon: category.icon,
      categoryColor: category.color,
      merchant: input.merchant.trim(),
      description: input.description.trim(),
      notes: input.notes?.trim() ?? "",
      receiptUri: input.receiptUri ?? null,
      ocrText: input.ocrText ?? null,
      extractionSource: input.extractionSource ?? "manual",
      lineItems: input.lineItems ?? existing?.lineItems ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    await persist(categories, [...transactions.filter((item) => item.id !== id), transaction]);
    return id;
  }, [categories, persist, transactions]);

  const deleteTransaction = useCallback(async (id: string) => {
    await persist(categories, transactions.filter((transaction) => transaction.id !== id));
  }, [categories, persist, transactions]);

  const getSummary = useCallback(
    (period: SummaryPeriod) => calculateSummary(transactions, period),
    [transactions],
  );

  const findTransaction = useCallback(
    (id: string) => transactions.find((transaction) => transaction.id === id),
    [transactions],
  );

  const value = useMemo<AccountingContextValue>(() => ({
    categories,
    transactions,
    isLoading,
    error,
    refresh,
    addCategory,
    upsertTransaction,
    deleteTransaction,
    getSummary,
    findTransaction,
  }), [
    categories,
    transactions,
    isLoading,
    error,
    refresh,
    addCategory,
    upsertTransaction,
    deleteTransaction,
    getSummary,
    findTransaction,
  ]);

  return <AccountingContext.Provider value={value}>{children}</AccountingContext.Provider>;
}

export function useAccounting(): AccountingContextValue {
  const context = useContext(AccountingContext);
  if (!context) throw new Error("useAccounting must be used inside AccountingProvider");
  return context;
}
