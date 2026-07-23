import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import type { Category } from "@/lib/types";

const CUSTOM_COLORS = ["#176B5B", "#5267A8", "#B87918", "#B75145", "#7E22CE", "#0369A1"];

export default function CategoriesScreen() {
  const colors = useColors();
  const { categories, transactions, addCategory } = useAccounting();
  const [isAdding, setIsAdding] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(CUSTOM_COLORS[0]);
  const [isSaving, setIsSaving] = useState(false);

  const counts = useMemo(() => {
    const next = new Map<string, number>();
    for (const transaction of transactions) {
      next.set(transaction.categoryId, (next.get(transaction.categoryId) ?? 0) + 1);
    }
    return next;
  }, [transactions]);

  const predefined = categories.filter((category) => !category.isCustom);
  const custom = categories.filter((category) => category.isCustom);
  const data: ({ type: "header"; title: string; subtitle: string } | { type: "category"; category: Category })[] = [
    { type: "header", title: "Built-in", subtitle: "Ready to use and protected" },
    ...predefined.map((category) => ({ type: "category" as const, category })),
    { type: "header", title: "Custom", subtitle: custom.length ? `${custom.length} created by you` : "Add categories for your workflow" },
    ...custom.map((category) => ({ type: "category" as const, category })),
  ];

  const save = async () => {
    if (name.trim().length < 2) {
      Alert.alert("Name required", "Enter at least two characters for the category name.");
      return;
    }
    setIsSaving(true);
    try {
      await addCategory(name, color);
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setName("");
      setColor(CUSTOM_COLORS[0]);
      setIsAdding(false);
    } catch (error) {
      Alert.alert(
        "Could not add category",
        error instanceof Error ? error.message : "Use a unique category name and try again.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ScreenContainer>
      <FlatList
        data={data}
        keyExtractor={(item, index) =>
          item.type === "category" ? item.category.id : `header-${index}`
        }
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          <View style={styles.top}>
            <View style={styles.titleRow}>
              <View>
                <Text style={[styles.eyebrow, { color: colors.primary }]}>ORGANIZE</Text>
                <Text style={[styles.title, { color: colors.text }]}>Categories</Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={isAdding ? "Cancel adding category" : "Add category"}
                onPress={() => setIsAdding((value) => !value)}
                style={({ pressed }) => [
                  styles.addButton,
                  { backgroundColor: isAdding ? colors.surface : colors.primary, borderColor: isAdding ? colors.border : colors.primary },
                  pressed && styles.pressed,
                ]}
              >
                <MaterialIcons name={isAdding ? "close" : "add"} size={23} color={isAdding ? colors.text : "#FFFFFF"} />
              </Pressable>
            </View>

            <View style={[styles.privacyCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.privacyIcon, { backgroundColor: `${colors.primary}16` }]}>
                <MaterialIcons name="category" size={22} color={colors.primary} />
              </View>
              <View style={styles.privacyCopy}>
                <Text style={[styles.privacyTitle, { color: colors.text }]}>Your own filing system</Text>
                <Text style={[styles.privacyBody, { color: colors.muted }]}>
                  Categories and transaction links stay in the local Ledgerly database.
                </Text>
              </View>
            </View>

            {isAdding && (
              <View style={[styles.editor, { backgroundColor: colors.surface, borderColor: colors.border }]}>
                <View style={styles.editorTitleRow}>
                  <View style={[styles.editorPreview, { backgroundColor: `${color}1C` }]}>
                    <MaterialIcons name="label" size={22} color={color} />
                  </View>
                  <View style={styles.editorCopy}>
                    <Text style={[styles.editorTitle, { color: colors.text }]}>New category</Text>
                    <Text style={[styles.editorSubtitle, { color: colors.muted }]}>Choose a clear name and color.</Text>
                  </View>
                </View>
                <View style={[styles.nameField, { backgroundColor: colors.background, borderColor: colors.border }]}>
                  <TextInput
                    autoFocus
                    value={name}
                    onChangeText={setName}
                    placeholder="e.g. Business supplies"
                    placeholderTextColor={colors.muted}
                    autoCapitalize="words"
                    returnKeyType="done"
                    onSubmitEditing={() => void save()}
                    style={[styles.nameInput, { color: colors.text }]}
                  />
                </View>
                <View style={styles.palette}>
                  {CUSTOM_COLORS.map((item) => (
                    <Pressable
                      key={item}
                      accessibilityRole="button"
                      accessibilityLabel={`Use color ${item}`}
                      accessibilityState={{ selected: color === item }}
                      onPress={() => setColor(item)}
                      style={({ pressed }) => [
                        styles.swatch,
                        { backgroundColor: item },
                        color === item && styles.selectedSwatch,
                        pressed && styles.pressed,
                      ]}
                    >
                      {color === item && <MaterialIcons name="check" size={18} color="#FFFFFF" />}
                    </Pressable>
                  ))}
                </View>
                <Pressable
                  disabled={isSaving}
                  onPress={() => void save()}
                  style={({ pressed }) => [
                    styles.saveButton,
                    { backgroundColor: colors.primary },
                    isSaving && styles.disabled,
                    pressed && styles.primaryPressed,
                  ]}
                >
                  <Text style={styles.saveText}>{isSaving ? "Adding…" : "Add category"}</Text>
                </Pressable>
              </View>
            )}
          </View>
        }
        renderItem={({ item }) => {
          if (item.type === "header") {
            return (
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>{item.title}</Text>
                <Text style={[styles.sectionSubtitle, { color: colors.muted }]}>{item.subtitle}</Text>
              </View>
            );
          }
          const category = item.category;
          const count = counts.get(category.id) ?? 0;
          return (
            <View style={[styles.categoryRow, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.categoryIcon, { backgroundColor: `${category.color}1B` }]}>
                <MaterialIcons
                  name={category.icon as keyof typeof MaterialIcons.glyphMap}
                  size={22}
                  color={category.color}
                />
              </View>
              <View style={styles.categoryCopy}>
                <Text style={[styles.categoryName, { color: colors.text }]}>{category.name}</Text>
                <Text style={[styles.categoryMeta, { color: colors.muted }]}>
                  {count} {count === 1 ? "transaction" : "transactions"}
                </Text>
              </View>
              <View style={[styles.typeBadge, { backgroundColor: colors.background }]}>
                <Text style={[styles.typeBadgeText, { color: colors.muted }]}>
                  {category.isCustom ? "Custom" : "Built-in"}
                </Text>
              </View>
            </View>
          );
        }}
      />
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, gap: 9 },
  top: { gap: 14, marginBottom: 10 },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.5 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  addButton: { width: 46, height: 46, borderRadius: 16, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  privacyCard: { minHeight: 82, borderRadius: 17, borderWidth: 1, padding: 13, flexDirection: "row", alignItems: "center", gap: 11 },
  privacyIcon: { width: 44, height: 44, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  privacyCopy: { flex: 1, gap: 3 },
  privacyTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  privacyBody: { fontSize: 12, lineHeight: 17 },
  editor: { borderRadius: 18, borderWidth: 1, padding: 14, gap: 13 },
  editorTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  editorPreview: { width: 42, height: 42, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  editorCopy: { flex: 1 },
  editorTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800" },
  editorSubtitle: { fontSize: 12, lineHeight: 17 },
  nameField: { minHeight: 48, borderRadius: 13, borderWidth: 1, paddingHorizontal: 12, justifyContent: "center" },
  nameInput: { fontSize: 15, lineHeight: 21, paddingVertical: 0 },
  palette: { flexDirection: "row", gap: 11 },
  swatch: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  selectedSwatch: { borderWidth: 3, borderColor: "#FFFFFF" },
  saveButton: { minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  saveText: { color: "#FFFFFF", fontSize: 15, lineHeight: 20, fontWeight: "800" },
  disabled: { opacity: 0.55 },
  pressed: { opacity: 0.64 },
  primaryPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  sectionHeader: { marginTop: 9, marginBottom: 1, paddingHorizontal: 3 },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: "800" },
  sectionSubtitle: { fontSize: 12, lineHeight: 17 },
  categoryRow: { minHeight: 69, borderRadius: 16, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 11 },
  categoryIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  categoryCopy: { flex: 1, gap: 2 },
  categoryName: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  categoryMeta: { fontSize: 12, lineHeight: 17 },
  typeBadge: { minHeight: 28, borderRadius: 14, paddingHorizontal: 9, alignItems: "center", justifyContent: "center" },
  typeBadgeText: { fontSize: 11, lineHeight: 15, fontWeight: "700" },
});
