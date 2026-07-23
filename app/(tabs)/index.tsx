import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { router } from "expo-router";
import { useMemo, useState } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { TransactionRow } from "@/components/transaction-row";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import { formatMoney, type SummaryPeriod } from "@/lib/types";

const PERIODS: { value: SummaryPeriod; label: string }[] = [
  { value: "month", label: "Month" },
  { value: "year", label: "Year" },
  { value: "all", label: "All time" },
];

export default function HomeScreen() {
  const colors = useColors();
  const { transactions, getSummary, isLoading, error } = useAccounting();
  const [period, setPeriod] = useState<SummaryPeriod>("month");
  const summary = useMemo(() => getSummary(period), [getSummary, period]);
  const recent = transactions.slice(0, 4);

  const tap = (callback: () => void) => {
    if (Platform.OS !== "web") void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    callback();
  };

  return (
    <ScreenContainer>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.headerRow}>
          <View>
            <Text style={[styles.eyebrow, { color: colors.primary }]}>LOCAL LEDGER</Text>
            <Text style={[styles.largeTitle, { color: colors.text }]}>Overview</Text>
          </View>
          <View style={[styles.localBadge, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <MaterialIcons name="lock-outline" size={15} color={colors.primary} />
            <Text style={[styles.localBadgeText, { color: colors.muted }]}>On device</Text>
          </View>
        </View>

        <View style={[styles.segment, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {PERIODS.map((item) => {
            const selected = item.value === period;
            return (
              <Pressable
                key={item.value}
                accessibilityRole="button"
                accessibilityState={{ selected }}
                onPress={() => setPeriod(item.value)}
                style={({ pressed }) => [
                  styles.segmentItem,
                  selected && { backgroundColor: colors.primary },
                  pressed && styles.pressed,
                ]}
              >
                <Text style={[styles.segmentText, { color: selected ? "#FFFFFF" : colors.muted }]}>
                  {item.label}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.balanceCard, { backgroundColor: colors.primary }]}>
          <View style={styles.balanceTopRow}>
            <Text style={styles.balanceLabel}>Net balance</Text>
            <MaterialIcons name="account-balance-wallet" size={22} color="#D8EFE8" />
          </View>
          <Text style={styles.balanceValue}>{formatMoney(summary.balanceMinor)}</Text>
          <Text style={styles.balanceCaption}>
            {summary.transactionCount === 0
              ? "No transactions in this period"
              : `${summary.transactionCount} transaction${summary.transactionCount === 1 ? "" : "s"} included`}
          </Text>
        </View>

        <View style={styles.metricRow}>
          <View style={[styles.metricCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.metricIcon, { backgroundColor: `${colors.success}1A` }]}>
              <MaterialIcons name="south-west" size={18} color={colors.success} />
            </View>
            <Text style={[styles.metricLabel, { color: colors.muted }]}>Income</Text>
            <Text style={[styles.metricValue, { color: colors.success }]}>{formatMoney(summary.incomeMinor)}</Text>
          </View>
          <View style={[styles.metricCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <View style={[styles.metricIcon, { backgroundColor: `${colors.error}16` }]}>
              <MaterialIcons name="north-east" size={18} color={colors.error} />
            </View>
            <Text style={[styles.metricLabel, { color: colors.muted }]}>Expenses</Text>
            <Text style={[styles.metricValue, { color: colors.text }]}>{formatMoney(summary.expenseMinor)}</Text>
          </View>
        </View>

        <View style={styles.quickRow}>
          <Pressable
            onPress={() => tap(() => router.push("/transaction-form"))}
            style={({ pressed }) => [
              styles.quickPrimary,
              { backgroundColor: colors.primary },
              pressed && styles.primaryPressed,
            ]}
          >
            <MaterialIcons name="add" size={22} color="#FFFFFF" />
            <Text style={styles.quickPrimaryText}>Add transaction</Text>
          </Pressable>
          <Pressable
            onPress={() => tap(() => router.push("/(tabs)/scan"))}
            style={({ pressed }) => [
              styles.quickSecondary,
              { backgroundColor: colors.surface, borderColor: colors.border },
              pressed && styles.pressed,
            ]}
          >
            <MaterialIcons name="document-scanner" size={22} color={colors.primary} />
            <Text style={[styles.quickSecondaryText, { color: colors.text }]}>Scan</Text>
          </Pressable>
        </View>

        {!!error && (
          <View style={[styles.notice, { backgroundColor: `${colors.error}12`, borderColor: `${colors.error}55` }]}>
            <MaterialIcons name="error-outline" size={20} color={colors.error} />
            <Text style={[styles.noticeText, { color: colors.text }]}>{error}</Text>
          </View>
        )}

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Spending by category</Text>
          <Text style={[styles.sectionMeta, { color: colors.muted }]}>{PERIODS.find((item) => item.value === period)?.label}</Text>
        </View>
        <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {summary.categorySpending.length === 0 ? (
            <EmptyState
              icon="donut-large"
              title={isLoading ? "Loading summary" : "No spending yet"}
              body="Expenses you add will appear here by category."
            />
          ) : (
            summary.categorySpending.slice(0, 4).map((item, index) => (
              <View key={item.categoryId} style={[styles.categoryRow, index > 0 && { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth }]}>
                <View style={[styles.smallCategoryIcon, { backgroundColor: `${item.categoryColor}1C` }]}>
                  <MaterialIcons
                    name={item.categoryIcon as keyof typeof MaterialIcons.glyphMap}
                    size={18}
                    color={item.categoryColor}
                  />
                </View>
                <View style={styles.categoryCopy}>
                  <View style={styles.categoryLabels}>
                    <Text style={[styles.categoryName, { color: colors.text }]}>{item.categoryName}</Text>
                    <Text style={[styles.categoryAmount, { color: colors.text }]}>{formatMoney(item.amountMinor)}</Text>
                  </View>
                  <View style={[styles.track, { backgroundColor: colors.background }]}>
                    <View
                      style={[
                        styles.fill,
                        {
                          backgroundColor: item.categoryColor,
                          width: `${Math.max(4, Math.round(item.percentage * 100))}%`,
                        },
                      ]}
                    />
                  </View>
                </View>
              </View>
            ))
          )}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: colors.text }]}>Recent activity</Text>
          <Pressable onPress={() => router.push("/(tabs)/transactions")} hitSlop={12}>
            <Text style={[styles.link, { color: colors.primary }]}>View all</Text>
          </Pressable>
        </View>
        <View style={[styles.sectionCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {recent.length === 0 ? (
            <EmptyState
              icon="receipt-long"
              title={isLoading ? "Loading records" : "Your ledger is ready"}
              body="Add a transaction or scan a receipt to get started."
            />
          ) : (
            recent.map((transaction, index) => (
              <View key={transaction.id} style={index > 0 ? { borderTopColor: colors.border, borderTopWidth: StyleSheet.hairlineWidth } : undefined}>
                <TransactionRow
                  compact
                  transaction={transaction}
                  onPress={() => router.push({ pathname: "/transaction-form", params: { id: transaction.id } })}
                />
              </View>
            ))
          )}
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

function EmptyState({
  icon,
  title,
  body,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  title: string;
  body: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.empty}>
      <View style={[styles.emptyIcon, { backgroundColor: colors.background }]}>
        <MaterialIcons name={icon} size={24} color={colors.primary} />
      </View>
      <Text style={[styles.emptyTitle, { color: colors.text }]}>{title}</Text>
      <Text style={[styles.emptyBody, { color: colors.muted }]}>{body}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, gap: 16 },
  headerRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.5 },
  largeTitle: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  localBadge: { minHeight: 36, borderWidth: 1, borderRadius: 18, paddingHorizontal: 11, flexDirection: "row", alignItems: "center", gap: 5 },
  localBadgeText: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  segment: { height: 42, borderWidth: 1, borderRadius: 13, padding: 3, flexDirection: "row" },
  segmentItem: { flex: 1, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  segmentText: { fontSize: 13, lineHeight: 17, fontWeight: "700" },
  balanceCard: { borderRadius: 22, padding: 20, gap: 6 },
  balanceTopRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  balanceLabel: { color: "#D8EFE8", fontSize: 14, lineHeight: 19, fontWeight: "600" },
  balanceValue: { color: "#FFFFFF", fontSize: 34, lineHeight: 42, fontWeight: "800", letterSpacing: -0.8, fontVariant: ["tabular-nums"] },
  balanceCaption: { color: "#D8EFE8", fontSize: 13, lineHeight: 18 },
  metricRow: { flexDirection: "row", gap: 12 },
  metricCard: { flex: 1, borderWidth: 1, borderRadius: 17, padding: 14, gap: 7 },
  metricIcon: { width: 32, height: 32, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  metricLabel: { fontSize: 12, lineHeight: 16, fontWeight: "600" },
  metricValue: { fontSize: 19, lineHeight: 25, fontWeight: "800", fontVariant: ["tabular-nums"] },
  quickRow: { flexDirection: "row", gap: 10 },
  quickPrimary: { flex: 1, minHeight: 50, borderRadius: 15, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  quickPrimaryText: { color: "#FFFFFF", fontSize: 15, lineHeight: 20, fontWeight: "800" },
  quickSecondary: { minWidth: 102, minHeight: 50, paddingHorizontal: 16, borderRadius: 15, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  quickSecondaryText: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  primaryPressed: { transform: [{ scale: 0.97 }], opacity: 0.9 },
  pressed: { opacity: 0.65 },
  notice: { borderWidth: 1, borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "center", gap: 9 },
  noticeText: { flex: 1, fontSize: 13, lineHeight: 18 },
  sectionHeader: { marginTop: 4, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { fontSize: 20, lineHeight: 26, fontWeight: "800", letterSpacing: -0.25 },
  sectionMeta: { fontSize: 12, lineHeight: 16 },
  link: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  sectionCard: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 14, overflow: "hidden" },
  categoryRow: { minHeight: 68, flexDirection: "row", alignItems: "center", gap: 11 },
  smallCategoryIcon: { width: 36, height: 36, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  categoryCopy: { flex: 1, gap: 7 },
  categoryLabels: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  categoryName: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  categoryAmount: { fontSize: 13, lineHeight: 18, fontWeight: "700", fontVariant: ["tabular-nums"] },
  track: { height: 6, borderRadius: 3, overflow: "hidden" },
  fill: { height: 6, borderRadius: 3 },
  empty: { minHeight: 150, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingVertical: 22 },
  emptyIcon: { width: 48, height: 48, borderRadius: 16, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  emptyTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800", textAlign: "center" },
  emptyBody: { marginTop: 4, fontSize: 13, lineHeight: 18, textAlign: "center" },
});
