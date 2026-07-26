import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import type { ReceiptReviewOutcome } from "@/lib/receipt-reliability";

type Props = {
  outcome: ReceiptReviewOutcome;
  summary: string;
  itemCount: number;
  reasons: string[];
  onContinue: () => void;
  onAddBasket: () => void;
};

const COPY: Record<ReceiptReviewOutcome, { title: string; icon: keyof typeof MaterialIcons.glyphMap }> = {
  complete: { title: "Receipt read", icon: "check-circle" },
  essentials_only: { title: "Essentials read — basket not reliable", icon: "fact-check" },
  manual_assistance: { title: "Some details need your input", icon: "edit-note" },
};

export function ReceiptVerdictCard({ outcome, summary, itemCount, reasons, onContinue, onAddBasket }: Props) {
  const colors = useColors();
  const [showReasons, setShowReasons] = useState(false);
  const copy = COPY[outcome];
  const body = outcome === "complete"
    ? `${summary}. ${itemCount} detected ${itemCount === 1 ? "item matches" : "items match"} the total.`
    : outcome === "essentials_only"
      ? `${summary}. The detected items were not reliable, so the basket was left empty.`
      : "Ledgerly only fills details it can verify. Enter the blank fields to continue; the basket starts empty.";

  return (
    <View
      accessibilityRole="summary"
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary }]}
    >
      <View style={styles.headingRow}>
        <MaterialIcons name={copy.icon} size={24} color={colors.primary} />
        <Text accessibilityRole="header" style={[styles.title, { color: colors.text }]}>{copy.title}</Text>
      </View>
      <Text style={[styles.body, { color: colors.muted }]}>{body}</Text>

      {outcome !== "complete" && (
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={outcome === "essentials_only" ? "Continue with essentials" : "Enter details manually"}
            onPress={onContinue}
            style={({ pressed }) => [styles.primaryAction, { backgroundColor: colors.primary }, pressed && styles.pressed]}
          >
            <Text style={styles.primaryText}>
              {outcome === "essentials_only" ? "Continue with essentials" : "Enter manually"}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add basket manually"
            accessibilityHint="Adds a blank item row without exposing rejected receipt rows"
            onPress={onAddBasket}
            style={({ pressed }) => [styles.secondaryAction, { borderColor: colors.border }, pressed && styles.pressed]}
          >
            <MaterialIcons name="add-shopping-cart" size={19} color={colors.primary} />
            <Text style={[styles.secondaryText, { color: colors.primary }]}>Add basket manually</Text>
          </Pressable>
        </View>
      )}

      {reasons.length > 0 && (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showReasons ? "Hide receipt verdict reasons" : "Why this receipt verdict"}
            onPress={() => setShowReasons((value) => !value)}
            style={styles.whyButton}
          >
            <Text style={[styles.whyText, { color: colors.primary }]}>{showReasons ? "Hide reasons" : "Why?"}</Text>
            <MaterialIcons name={showReasons ? "expand-less" : "expand-more"} size={20} color={colors.primary} />
          </Pressable>
          {showReasons && (
            <View accessibilityLiveRegion="polite" style={[styles.reasons, { borderTopColor: colors.border }]}>
              {reasons.map((reason) => (
                <View key={reason} style={styles.reasonRow}>
                  <MaterialIcons name="info-outline" size={16} color={colors.muted} />
                  <Text style={[styles.reasonText, { color: colors.muted }]}>{reason}</Text>
                </View>
              ))}
            </View>
          )}
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderWidth: 1.5, borderRadius: 18, padding: 14, gap: 10 },
  headingRow: { flexDirection: "row", alignItems: "center", gap: 9 },
  title: { flex: 1, fontSize: 17, lineHeight: 23, fontWeight: "900" },
  body: { fontSize: 13, lineHeight: 19 },
  actions: { gap: 8 },
  primaryAction: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", paddingHorizontal: 14 },
  primaryText: { color: "#FFFFFF", fontSize: 14, lineHeight: 19, fontWeight: "800" },
  secondaryAction: { minHeight: 48, borderWidth: 1, borderRadius: 14, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7, paddingHorizontal: 14 },
  secondaryText: { fontSize: 14, lineHeight: 19, fontWeight: "800" },
  whyButton: { alignSelf: "flex-start", minHeight: 48, flexDirection: "row", alignItems: "center", gap: 2, paddingRight: 8 },
  whyText: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  reasons: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 9, gap: 7 },
  reasonRow: { flexDirection: "row", alignItems: "flex-start", gap: 7 },
  reasonText: { flex: 1, fontSize: 12, lineHeight: 17 },
  pressed: { opacity: 0.68 },
});
