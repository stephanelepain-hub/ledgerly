import DateTimePicker from "@react-native-community/datetimepicker";
import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { useColors } from "@/hooks/use-colors";
import { formatLongDate, isoDateFromDate, parseIsoDate } from "@/lib/types";

type Props = {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  confidence?: number;
};

export function ReceiptDatePicker({ label = "Receipt date", value, onChange }: Props) {
  const colors = useColors();
  const [showPicker, setShowPicker] = useState(false);
  const hasDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  // A missing OCR date must remain visually and semantically blank. Today is
  // used only as the native picker's starting page after the user opens it.
  const selectedDate = hasDate ? parseIsoDate(value) : new Date();
  if (Platform.OS === "web") {
    return (
      <View style={styles.section}>
        <View style={styles.labelRow}>
          <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
        </View>
        <TextInput
          value={value}
          onChangeText={onChange}
          autoCapitalize="none"
          keyboardType="numbers-and-punctuation"
          placeholder="YYYY-MM-DD"
          placeholderTextColor={colors.muted}
          style={[styles.webInput, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]}
        />
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Choose ${label.toLocaleLowerCase()}`}
        onPress={() => setShowPicker(true)}
        style={({ pressed }) => [
          styles.dateCard,
          { backgroundColor: colors.surface, borderColor: colors.border },
          pressed && styles.pressed,
        ]}
      >
        <View style={[styles.icon, { backgroundColor: `${colors.primary}16` }]}>
          <MaterialIcons name="calendar-month" size={24} color={colors.primary} />
        </View>
        <View style={styles.copy}>
          <Text style={[styles.dateValue, { color: hasDate ? colors.text : colors.muted }]}>
            {hasDate ? formatLongDate(value) : "Choose receipt date"}
          </Text>
          <Text style={[styles.isoValue, { color: colors.muted }]}>
            {hasDate ? value : "No date selected"}
          </Text>
        </View>
        <MaterialIcons name="edit-calendar" size={22} color={colors.primary} />
      </Pressable>
      {showPicker && (
        <DateTimePicker
          value={selectedDate}
          mode="date"
          display="default"
          onChange={(event, nextDate) => {
            if (Platform.OS === "android") setShowPicker(false);
            if (event.type === "set" && nextDate) onChange(isoDateFromDate(nextDate));
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8, marginTop: 6 },
  labelRow: { minHeight: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  dateCard: { minHeight: 76, borderRadius: 16, borderWidth: 1, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 12 },
  icon: { width: 46, height: 46, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  copy: { flex: 1, gap: 2 },
  dateValue: { fontSize: 17, lineHeight: 23, fontWeight: "800" },
  isoValue: { fontSize: 12, lineHeight: 17, fontVariant: ["tabular-nums"] },
  webInput: { minHeight: 52, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, lineHeight: 20 },
  pressed: { opacity: 0.65 },
});
