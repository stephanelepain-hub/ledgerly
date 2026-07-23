import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import {
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { TransactionRow } from "@/components/transaction-row";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import type { TransactionType } from "@/lib/types";

type TypeFilter = TransactionType | "all";

export default function TransactionsScreen() {
  const colors = useColors();
  const { transactions, categories, isLoading } = useAccounting();
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [categoryFilter, setCategoryFilter] = useState("all");

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return transactions.filter((transaction) => {
      if (typeFilter !== "all" && transaction.type !== typeFilter) return false;
      if (categoryFilter !== "all" && transaction.categoryId !== categoryFilter) return false;
      if (!needle) return true;
      return [
        transaction.merchant,
        transaction.description,
        transaction.notes,
        transaction.categoryName,
      ].some((value) => value.toLocaleLowerCase().includes(needle));
    });
  }, [transactions, query, typeFilter, categoryFilter]);

  return (
    <ScreenContainer>
      <FlatList
        data={filtered}
        keyExtractor={(item) => item.id}
        renderItem={({ item, index }) => (
          <View
            style={[
              styles.rowContainer,
              { backgroundColor: colors.surface },
              index > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth },
            ]}
          >
            <TransactionRow
              transaction={item}
              onPress={() =>
                router.push({
                  pathname: "/transaction-form" as never,
                  params: { id: item.id },
                })
              }
            />
          </View>
        )}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.header}>
            <View style={styles.titleRow}>
              <View>
                <Text style={[styles.eyebrow, { color: colors.primary }]}>YOUR RECORDS</Text>
                <Text style={[styles.title, { color: colors.text }]}>Transactions</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add transaction"
                onPress={() => router.push("/transaction-form" as never)}
                style={({ pressed }) => [
                  styles.addButton,
                  { backgroundColor: colors.primary },
                  pressed && styles.primaryPressed,
                ]}
              >
                <MaterialIcons name="add" size={24} color="#FFFFFF" />
              </Pressable>
            </View>

            <View style={[styles.search, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <MaterialIcons name="search" size={21} color={colors.muted} />
              <TextInput
                value={query}
                onChangeText={setQuery}
                placeholder="Search merchant or category"
                placeholderTextColor={colors.muted}
                returnKeyType="search"
                style={[styles.searchInput, { color: colors.text }]}
              />
              {!!query && (
                <Pressable onPress={() => setQuery("")} hitSlop={10}>
                  <MaterialIcons name="cancel" size={19} color={colors.muted} />
                </Pressable>
              )}
            </View>

            <View style={styles.chipRow}>
              {([
                ["all", "All"],
                ["expense", "Expenses"],
                ["income", "Income"],
              ] as const).map(([value, label]) => (
                <FilterChip
                  key={value}
                  label={label}
                  selected={typeFilter === value}
                  onPress={() => setTypeFilter(value)}
                />
              ))}
            </View>

            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.categoryChips}
            >
              <FilterChip
                label="All categories"
                selected={categoryFilter === "all"}
                onPress={() => setCategoryFilter("all")}
              />
              {categories.map((category) => (
                <FilterChip
                  key={category.id}
                  label={category.name}
                  selected={categoryFilter === category.id}
                  onPress={() => setCategoryFilter(category.id)}
                  color={category.color}
                />
              ))}
            </ScrollView>

            <View style={styles.resultRow}>
              <Text style={[styles.resultCount, { color: colors.text }]}>
                {filtered.length} {filtered.length === 1 ? "record" : "records"}
              </Text>
              {(query || typeFilter !== "all" || categoryFilter !== "all") && (
                <Pressable
                  onPress={() => {
                    setQuery("");
                    setTypeFilter("all");
                    setCategoryFilter("all");
                  }}
                  hitSlop={10}
                >
                  <Text style={[styles.clearText, { color: colors.primary }]}>Clear filters</Text>
                </Pressable>
              )}
            </View>
          </View>
        }
        ListEmptyComponent={
          <View style={[styles.empty, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.emptyIcon, { backgroundColor: colors.background }]}>
              <MaterialIcons name="receipt-long" size={27} color={colors.primary} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.text }]}>
              {isLoading ? "Loading transactions" : transactions.length ? "No matching transactions" : "No transactions yet"}
            </Text>
            <Text style={[styles.emptyBody, { color: colors.muted }]}>
              {transactions.length
                ? "Try changing your search or filters."
                : "Add one manually or scan a receipt to start your ledger."}
            </Text>
          </View>
        }
      />
    </ScreenContainer>
  );
}

function FilterChip({
  label,
  selected,
  onPress,
  color,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  color?: string;
}) {
  const colors = useColors();
  const tint = color ?? colors.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? tint : colors.surface,
          borderColor: selected ? tint : colors.border,
        },
        pressed && styles.pressed,
      ]}
    >
      {!!color && !selected && <View style={[styles.chipDot, { backgroundColor: color }]} />}
      <Text style={[styles.chipText, { color: selected ? "#FFFFFF" : colors.muted }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  listContent: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32 },
  header: { gap: 13, paddingBottom: 14 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.5 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  addButton: { width: 46, height: 46, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  primaryPressed: { opacity: 0.88, transform: [{ scale: 0.96 }] },
  pressed: { opacity: 0.65 },
  search: { minHeight: 50, borderRadius: 15, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 9 },
  searchInput: { flex: 1, fontSize: 15, lineHeight: 20, paddingVertical: 0 },
  chipRow: { flexDirection: "row", gap: 8 },
  categoryChips: { gap: 8, paddingRight: 14 },
  chip: { minHeight: 38, borderRadius: 19, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  chipText: { fontSize: 13, lineHeight: 17, fontWeight: "700" },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  resultRow: { minHeight: 28, flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 2 },
  resultCount: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  clearText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  rowContainer: { paddingHorizontal: 14 },
  empty: { marginTop: 2, minHeight: 250, borderRadius: 18, borderWidth: 1, padding: 28, alignItems: "center", justifyContent: "center" },
  emptyIcon: { width: 54, height: 54, borderRadius: 18, alignItems: "center", justifyContent: "center", marginBottom: 12 },
  emptyTitle: { fontSize: 17, lineHeight: 23, fontWeight: "800", textAlign: "center" },
  emptyBody: { marginTop: 6, fontSize: 14, lineHeight: 20, textAlign: "center", maxWidth: 280 },
});
