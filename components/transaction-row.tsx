import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { formatMoney, formatShortDate, type Transaction } from "@/lib/types";

interface TransactionRowProps {
  transaction: Transaction;
  onPress?: () => void;
  compact?: boolean;
}

export function TransactionRow({ transaction, onPress, compact = false }: TransactionRowProps) {
  const colors = useColors();
  const isIncome = transaction.type === "income";
  const title = transaction.merchant || transaction.description || transaction.categoryName;
  const subtitle = [transaction.categoryName, formatShortDate(transaction.date)].join(" · ");

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${isIncome ? "income" : "expense"}, ${formatMoney(transaction.amountMinor)}`}
      onPress={onPress}
      disabled={!onPress}
      style={({ pressed }) => [
        styles.row,
        compact && styles.compactRow,
        pressed && styles.pressed,
      ]}
    >
      <View style={[styles.iconWrap, { backgroundColor: `${transaction.categoryColor}1F` }]}>
        <MaterialIcons
          name={transaction.categoryIcon as keyof typeof MaterialIcons.glyphMap}
          size={21}
          color={transaction.categoryColor}
        />
      </View>
      <View style={styles.copy}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
          {title}
        </Text>
        <Text style={[styles.subtitle, { color: colors.muted }]} numberOfLines={1}>
          {subtitle}
        </Text>
      </View>
      <View style={styles.amountWrap}>
        <Text
          style={[
            styles.amount,
            { color: isIncome ? colors.success : colors.text },
          ]}
        >
          {isIncome ? "+" : "−"}{formatMoney(transaction.amountMinor)}
        </Text>
        {!!transaction.receiptUri && (
          <View style={styles.receiptTag}>
            <MaterialIcons name="receipt-long" size={13} color={colors.muted} />
            <Text style={[styles.receiptText, { color: colors.muted }]}>Receipt</Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    minHeight: 68,
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: 10,
    gap: 12,
  },
  compactRow: {
    minHeight: 60,
    paddingVertical: 7,
  },
  pressed: {
    opacity: 0.62,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  title: {
    fontSize: 16,
    lineHeight: 21,
    fontWeight: "600",
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  amountWrap: {
    alignItems: "flex-end",
    gap: 4,
  },
  amount: {
    fontSize: 15,
    lineHeight: 20,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  receiptTag: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
  },
  receiptText: {
    fontSize: 11,
    lineHeight: 14,
  },
});
