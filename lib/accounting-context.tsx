import { useSQLiteContext } from "expo-sqlite";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  calculateSummary,
  createCategory as insertCategory,
  deleteTransaction as removeTransaction,
  listCategories,
  listTransactions,
  saveTransaction,
} from "@/lib/db";
import { deleteReceiptImage } from "@/lib/receipt-storage";
import type {
  Category,
  DashboardSummary,
  SummaryPeriod,
  Transaction,
  TransactionInput,
} from "@/lib/types";

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

export function AccountingProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [categories, setCategories] = useState<Category[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextCategories, nextTransactions] = await Promise.all([
        listCategories(db),
        listTransactions(db),
      ]);
      setCategories(nextCategories);
      setTransactions(nextTransactions);
      setError(null);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Could not load local records.");
    } finally {
      setIsLoading(false);
    }
  }, [db]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addCategory = useCallback(
    async (name: string, color: string) => {
      const category = await insertCategory(db, name, color);
      await refresh();
      return category;
    },
    [db, refresh],
  );

  const upsertTransaction = useCallback(
    async (input: TransactionInput) => {
      const id = await saveTransaction(db, input);
      await refresh();
      return id;
    },
    [db, refresh],
  );

  const deleteTransaction = useCallback(
    async (id: string) => {
      const target = transactions.find((transaction) => transaction.id === id);
      await removeTransaction(db, id);
      // Best-effort cleanup of the app-owned receipt image copy; ledger
      // deletion never fails because of the file system.
      await deleteReceiptImage(target?.receiptUri).catch(() => undefined);
      await refresh();
    },
    [db, refresh, transactions],
  );

  const getSummary = useCallback(
    (period: SummaryPeriod) => calculateSummary(transactions, period),
    [transactions],
  );

  const findTransaction = useCallback(
    (id: string) => transactions.find((transaction) => transaction.id === id),
    [transactions],
  );

  const value = useMemo<AccountingContextValue>(
    () => ({
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
    }),
    [
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
    ],
  );

  return <AccountingContext.Provider value={value}>{children}</AccountingContext.Provider>;
}

export function useAccounting(): AccountingContextValue {
  const context = useContext(AccountingContext);
  if (!context) throw new Error("useAccounting must be used inside AccountingProvider");
  return context;
}
