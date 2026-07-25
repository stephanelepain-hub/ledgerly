import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ReceiptDatePicker } from "@/components/receipt-date-picker";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import {
  formatMoney,
  parseAmountToMinor,
  todayIsoDate,
  type ExtractionSource,
  type TransactionType,
} from "@/lib/types";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default function TransactionFormScreen() {
  const colors = useColors();
  const params = useLocalSearchParams<{
    id?: string;
    amountMinor?: string;
    date?: string;
    merchant?: string;
    description?: string;
    categoryId?: string;
    receiptUri?: string;
    ocrText?: string;
    extractionSource?: string;
  }>();
  const { categories, transactions, findTransaction, upsertTransaction, deleteTransaction } = useAccounting();
  const transactionId = first(params.id);
  const existing = transactionId ? findTransaction(transactionId) : undefined;
  const isEditing = !!existing;

  const [type, setType] = useState<TransactionType>("expense");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(first(params.date) ?? todayIsoDate());
  const [categoryId, setCategoryId] = useState(first(params.categoryId) ?? "other");
  const [merchant, setMerchant] = useState(first(params.merchant) ?? "");
  const [description, setDescription] = useState(first(params.description) ?? "");
  const [notes, setNotes] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Two confirmation dialogs can be queued by a fast double tap, and state
  // updates are asynchronous. Only a synchronous guard prevents a second
  // write creating a duplicate transaction.
  const saveGuard = useRef(false);
  const [submitted, setSubmitted] = useState(false);
  // Guards against a first-paint flash of "Save changes" before the stored
  // record has populated the fields.
  const [hydrated, setHydrated] = useState(false);

  const receiptUri = first(params.receiptUri) ?? existing?.receiptUri ?? null;
  const ocrText = first(params.ocrText) ?? existing?.ocrText ?? null;
  const extractionSource = (first(params.extractionSource) ??
    existing?.extractionSource ??
    "manual") as ExtractionSource;
  const lineItems = useMemo(() => existing?.lineItems ?? [], [existing?.lineItems]);
  const priceHistory = useMemo(() => new Map(lineItems.map((item) => {
    const normalized = item.name.trim().toLocaleLowerCase();
    const previous = transactions
      .filter((transaction) => transaction.id !== existing?.id)
      .flatMap((transaction) => transaction.lineItems.map((candidate) => ({ ...candidate, date: transaction.date, merchant: transaction.merchant })))
      .filter((candidate) => candidate.name.trim().toLocaleLowerCase() === normalized && candidate.lineTotalMinor)
      .sort((a, b) => b.date.localeCompare(a.date))[0];
    return [item.id, previous] as const;
  })), [lineItems, transactions, existing?.id]);

  // Populate once per transaction id. The context recreates transaction
  // objects on every refresh, so depending on object identity could wipe
  // in-progress user edits.
  const populatedTransactionId = useRef<string | null>(null);
  useEffect(() => {
    if (existing) {
      if (populatedTransactionId.current === existing.id) return;
      populatedTransactionId.current = existing.id;
      setType(existing.type);
      setAmount((existing.amountMinor / 100).toFixed(2));
      setDate(existing.date);
      setCategoryId(existing.categoryId);
      setMerchant(existing.merchant);
      setDescription(existing.description);
      setNotes(existing.notes);
      setHydrated(true);
      return;
    }
    const amountMinor = Number(first(params.amountMinor));
    if (Number.isFinite(amountMinor) && amountMinor > 0) {
      setAmount((amountMinor / 100).toFixed(2));
    }
  }, [existing, params.amountMinor]);

  const amountMinor = useMemo(() => parseAmountToMinor(amount), [amount]);
  const errors = useMemo(
    () => ({
      amount: amountMinor ? "" : "Enter an amount greater than zero.",
      date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? "" : "Use YYYY-MM-DD.",
      category: categories.some((category) => category.id === categoryId)
        ? ""
        : "Choose a category.",
      details:
        merchant.trim() || description.trim()
          ? ""
          : "Enter a merchant or a short description.",
    }),
    [amountMinor, date, categories, categoryId, merchant, description],
  );
  const isValid = Object.values(errors).every((error) => !error);
  // An already-saved transaction must not offer to save itself again. Only a
  // real change to a stored field brings the save action back.
  const isDirty = useMemo(() => {
    if (!existing) return true;
    return (
      type !== existing.type ||
      amountMinor !== existing.amountMinor ||
      date !== existing.date ||
      categoryId !== existing.categoryId ||
      merchant.trim() !== existing.merchant.trim() ||
      description.trim() !== existing.description.trim() ||
      notes.trim() !== existing.notes.trim()
    );
  }, [existing, type, amountMinor, date, categoryId, merchant, description, notes]);
  const showSaveAction = !isEditing || (hydrated && isDirty);
  const selectedCategory = categories.find((category) => category.id === categoryId);
  const possibleDuplicate = useMemo(() => {
    if (!amountMinor || !date) return undefined;
    const reference = (merchant.trim() || description.trim()).toLocaleLowerCase();
    if (!reference) return undefined;
    return transactions.find((transaction) =>
      transaction.id !== existing?.id &&
      transaction.type === type &&
      transaction.amountMinor === amountMinor &&
      transaction.date === date &&
      (transaction.merchant.trim() || transaction.description.trim()).toLocaleLowerCase() === reference,
    );
  }, [amountMinor, date, merchant, description, transactions, existing?.id, type]);

  const commitSave = async () => {
    if (saveGuard.current) return;
    if (!amountMinor || !isValid) return;
    saveGuard.current = true;
    setIsSaving(true);
    try {
      await upsertTransaction({
        id: existing?.id,
        type,
        amountMinor,
        date,
        categoryId,
        merchant,
        description,
        notes,
        receiptUri,
        ocrText,
        extractionSource,
        lineItems,
      });
      // Retire the save affordance before navigating; this screen is a
      // fullScreenModal and stays mounted through the dismiss animation.
      setSaved(true);
      setIsSaving(false);
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      if (router.canGoBack()) router.back();
      else router.replace("/" as never);
    } catch (error) {
      // The write failed, so allow another attempt.
      saveGuard.current = false;
      setIsSaving(false);
      Alert.alert(
        "Could not save",
        error instanceof Error ? error.message : "Ledgerly could not save this transaction.",
      );
    }
  };

  const requestSave = () => {
    if (saveGuard.current || isSaving || saved || !showSaveAction) return;
    setSubmitted(true);
    if (!isValid || !amountMinor) return;
    const summary = `${type === "expense" ? "Expense" : "Income"} of ${formatMoney(amountMinor)}${
      merchant.trim() ? ` for ${merchant.trim()}` : ""
    } on ${date}.`;
    const confirmSave = () => {
      if (Platform.OS === "web") {
        void commitSave();
        return;
      }
      Alert.alert("Confirm transaction", `${summary}\n\nSave this to your on-device ledger?`, [
        { text: "Keep editing", style: "cancel" },
        { text: "Confirm & save", onPress: () => void commitSave() },
      ]);
    };
    if (!possibleDuplicate) {
      confirmSave();
      return;
    }
    Alert.alert(
      "Possible duplicate",
      `A matching ${possibleDuplicate.type} for ${formatMoney(possibleDuplicate.amountMinor)} on ${possibleDuplicate.date} already exists. Save this one anyway?`,
      [
        { text: "Keep editing", style: "cancel" },
        { text: "Save anyway", onPress: confirmSave },
      ],
    );
  };

  const requestDelete = () => {
    if (!existing) return;
    const commitDelete = async () => {
      try {
        await deleteTransaction(existing.id);
        if (Platform.OS !== "web") {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        router.back();
      } catch (error) {
        Alert.alert(
          "Could not delete",
          error instanceof Error ? error.message : "Ledgerly could not delete this record.",
        );
      }
    };
    if (Platform.OS === "web") {
      void commitDelete();
      return;
    }
    const isReceipt = !!existing.receiptUri;
    Alert.alert(
      isReceipt ? "Delete receipt & transaction?" : "Delete transaction?",
      isReceipt
        ? "This permanently removes this receipt record from Ledgerly. The original photo in your phone gallery is not deleted."
        : "This permanently removes it from Ledgerly on this device.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void commitDelete() },
      ],
    );
  };

  return (
    <ScreenContainer edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View style={[styles.nav, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.navAction}>
            <Text style={[styles.cancelText, { color: colors.primary }]}>Cancel</Text>
          </Pressable>
          <Text style={[styles.navTitle, { color: colors.text }]}>
            {isEditing ? "Edit transaction" : receiptUri ? "Review transaction" : "New transaction"}
          </Text>
          {isEditing ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={receiptUri ? "Delete receipt and transaction" : "Delete transaction"}
              onPress={requestDelete}
              hitSlop={10}
              style={styles.deleteNavAction}
            >
              <MaterialIcons name="delete-outline" size={22} color={colors.error} />
            </Pressable>
          ) : <View style={styles.navAction} />}
        </View>

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {receiptUri && (
            <View style={[styles.receiptBanner, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <Image source={{ uri: receiptUri }} style={styles.receiptThumb} contentFit="cover" />
              <View style={styles.receiptCopy}>
                <View style={styles.receiptTitleRow}>
                  <MaterialIcons name="receipt-long" size={18} color={colors.primary} />
                  <Text style={[styles.receiptTitle, { color: colors.text }]}>Receipt attached</Text>
                </View>
                <Text style={[styles.receiptBody, { color: colors.muted }]}>
                  {extractionSource === "cloud_llm"
                    ? "Cloud-assisted values — review before saving"
                    : "Processed on this device — review before saving"}
                </Text>
              </View>
            </View>
          )}

          {!!lineItems.length && (
            <View style={[styles.cartCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={styles.cartHeading}><Text style={[styles.cartTitle, { color: colors.text }]}>Shopping cart</Text><Text style={[styles.cartCount, { color: colors.primary }]}>{lineItems.length} items</Text></View>
              <Text style={[styles.cartBody, { color: colors.muted }]}>Saved locally from the receipt. Prices below are editable during receipt review.</Text>
              {lineItems.map((item) => {
                const previous = priceHistory.get(item.id);
                return <View key={item.id} style={[styles.cartRow, { borderTopColor: colors.border }]}>
                  <View style={styles.cartItemCopy}><Text style={[styles.cartItemName, { color: colors.text }]}>{item.name}</Text>{previous && <Text style={[styles.cartHistory, { color: colors.muted }]}>Previously {formatMoney(previous.lineTotalMinor!)} · {previous.merchant || previous.date}</Text>}</View>
                  <Text style={[styles.cartItemPrice, { color: colors.text }]}>{item.lineTotalMinor ? formatMoney(item.lineTotalMinor) : "—"}</Text>
                </View>;
              })}
            </View>
          )}

          <View style={[styles.typeControl, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {(["expense", "income"] as TransactionType[]).map((value) => {
              const selected = type === value;
              return (
                <Pressable
                  key={value}
                  onPress={() => {
                    setType(value);
                    if (value === "income" && categoryId === "other") setCategoryId("salary");
                  }}
                  style={({ pressed }) => [
                    styles.typeOption,
                    selected && { backgroundColor: value === "income" ? colors.success : colors.error },
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={[styles.typeText, { color: selected ? "#FFFFFF" : colors.muted }]}>
                    {value === "expense" ? "Expense" : "Income"}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <View style={styles.amountSection}>
            <Text style={[styles.amountLabel, { color: colors.muted }]}>AMOUNT</Text>
            <View style={styles.amountInputRow}>
              <Text style={[styles.currencyMark, { color: colors.text }]}>€</Text>
              <TextInput
                value={amount}
                onChangeText={setAmount}
                placeholder="0.00"
                placeholderTextColor={colors.border}
                keyboardType="decimal-pad"
                returnKeyType="done"
                style={[styles.amountInput, { color: colors.text }]}
                accessibilityLabel="Transaction amount"
              />
            </View>
            {submitted && errors.amount ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{errors.amount}</Text>
            ) : null}
          </View>

          <View style={styles.group}>
            <ReceiptDatePicker label="Transaction date" value={date} onChange={setDate} />
            {submitted && errors.date ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{errors.date}</Text>
            ) : null}
            <Field
              label="Merchant"
              value={merchant}
              onChangeText={setMerchant}
              placeholder="Store or payer"
              autoCapitalize="words"
            />
            <Field
              label="Description"
              value={description}
              onChangeText={setDescription}
              placeholder="What was this for?"
              error={submitted ? errors.details : ""}
            />
          </View>

          <View style={styles.sectionHeader}>
            <Text style={[styles.sectionTitle, { color: colors.text }]}>Category</Text>
            {submitted && errors.category ? (
              <Text style={[styles.errorText, { color: colors.error }]}>{errors.category}</Text>
            ) : null}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.categories}
          >
            {categories.map((category) => {
              const selected = category.id === categoryId;
              return (
                <Pressable
                  key={category.id}
                  onPress={() => setCategoryId(category.id)}
                  style={({ pressed }) => [
                    styles.categoryChip,
                    {
                      backgroundColor: selected ? category.color : colors.surface,
                      borderColor: selected ? category.color : colors.border,
                    },
                    pressed && styles.pressed,
                  ]}
                >
                  <MaterialIcons
                    name={category.icon as keyof typeof MaterialIcons.glyphMap}
                    size={18}
                    color={selected ? "#FFFFFF" : category.color}
                  />
                  <Text style={[styles.categoryText, { color: selected ? "#FFFFFF" : colors.text }]}>
                    {category.name}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={[styles.notesCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.fieldLabel, { color: colors.muted }]}>NOTES (OPTIONAL)</Text>
            <TextInput
              value={notes}
              onChangeText={setNotes}
              placeholder="Add context for later"
              placeholderTextColor={colors.muted}
              multiline
              textAlignVertical="top"
              style={[styles.notesInput, { color: colors.text }]}
            />
          </View>

          <View style={[styles.previewLine, { borderColor: colors.border }]}>
            <View style={[styles.previewIcon, { backgroundColor: `${selectedCategory?.color ?? colors.muted}1C` }]}>
              <MaterialIcons
                name={(selectedCategory?.icon ?? "category") as keyof typeof MaterialIcons.glyphMap}
                size={20}
                color={selectedCategory?.color ?? colors.muted}
              />
            </View>
            <View style={styles.previewCopy}>
              <Text style={[styles.previewTitle, { color: colors.text }]}>
                {merchant.trim() || description.trim() || "Transaction preview"}
              </Text>
              <Text style={[styles.previewMeta, { color: colors.muted }]}>
                {selectedCategory?.name ?? "No category"} · {date || "No date"}
              </Text>
            </View>
            <Text style={[styles.previewAmount, { color: type === "income" ? colors.success : colors.text }]}>
              {type === "income" ? "+" : "−"}{amountMinor ? formatMoney(amountMinor) : formatMoney(0)}
            </Text>
          </View>

          {isEditing && (
            <Pressable onPress={requestDelete} style={({ pressed }) => [styles.deleteButton, pressed && styles.pressed]}>
              <MaterialIcons name="delete-outline" size={20} color={colors.error} />
              <Text style={[styles.deleteText, { color: colors.error }]}>{receiptUri ? "Delete receipt & transaction" : "Delete transaction"}</Text>
            </Pressable>
          )}
        </ScrollView>

        <View style={[styles.footer, { backgroundColor: colors.background, borderTopColor: colors.border }]}>
          {saved ? (
            <View accessibilityRole="summary" style={[styles.savedNotice, { borderColor: colors.primary, backgroundColor: `${colors.primary}12` }]}>
              <MaterialIcons name="check-circle" size={21} color={colors.primary} />
              <Text style={[styles.savedNoticeText, { color: colors.text }]}>Saved to your ledger</Text>
            </View>
          ) : showSaveAction ? (
            <Pressable
              disabled={isSaving}
              onPress={requestSave}
              style={({ pressed }) => [
                styles.saveButton,
                { backgroundColor: colors.primary },
                isSaving && styles.disabled,
                pressed && styles.primaryPressed,
              ]}
            >
              <MaterialIcons name="check" size={21} color="#FFFFFF" />
              <Text style={styles.saveText}>{isSaving ? "Saving…" : isEditing ? "Save changes" : "Confirm & save"}</Text>
            </Pressable>
          ) : (
            <View accessibilityRole="summary" style={[styles.savedNotice, { borderColor: colors.border }]}>
              <MaterialIcons name="check-circle" size={20} color={colors.muted} />
              <Text style={[styles.savedNoticeText, { color: colors.muted }]}>Saved · no unsaved changes</Text>
            </View>
          )}
          {!saved && showSaveAction && (
            <Text style={[styles.footerNote, { color: colors.muted }]}>
              {isEditing ? "Your changes apply when you save." : "Nothing is saved until you confirm."}
            </Text>
          )}
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function Field({
  label,
  error,
  ...inputProps
}: React.ComponentProps<typeof TextInput> & { label: string; error?: string }) {
  const colors = useColors();
  return (
    <View style={[styles.field, { backgroundColor: colors.surface, borderColor: error ? colors.error : colors.border }]}>
      <Text style={[styles.fieldLabel, { color: error ? colors.error : colors.muted }]}>{label.toUpperCase()}</Text>
      <TextInput
        {...inputProps}
        placeholderTextColor={colors.muted}
        returnKeyType="done"
        style={[styles.fieldInput, { color: colors.text }]}
      />
      {!!error && <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  nav: { minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  navAction: { minWidth: 64, minHeight: 44, justifyContent: "center" },
  deleteNavAction: { minWidth: 64, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  cancelText: { fontSize: 16, lineHeight: 22, fontWeight: "600" },
  navTitle: { fontSize: 16, lineHeight: 22, fontWeight: "800" },
  content: { padding: 18, paddingBottom: 28, gap: 18 },
  receiptBanner: { minHeight: 72, borderRadius: 16, borderWidth: 1, padding: 8, flexDirection: "row", alignItems: "center", gap: 11 },
  receiptThumb: { width: 54, height: 54, borderRadius: 11, backgroundColor: "#E5E7EB" },
  receiptCopy: { flex: 1, gap: 3 },
  receiptTitleRow: { flexDirection: "row", alignItems: "center", gap: 6 },
  receiptTitle: { fontSize: 14, lineHeight: 19, fontWeight: "800" },
  receiptBody: { fontSize: 12, lineHeight: 17 },
  cartCard: { borderRadius: 16, borderWidth: 1, padding: 12, gap: 7 },
  cartHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  cartTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  cartCount: { fontSize: 12, lineHeight: 17, fontWeight: "800" },
  cartBody: { fontSize: 11, lineHeight: 16 },
  cartRow: { minHeight: 42, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 7, flexDirection: "row", alignItems: "center", gap: 10 },
  cartItemCopy: { flex: 1, minWidth: 0 },
  cartItemName: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  cartHistory: { marginTop: 1, fontSize: 10, lineHeight: 14 },
  cartItemPrice: { fontSize: 13, lineHeight: 18, fontWeight: "800", fontVariant: ["tabular-nums"] },
  typeControl: { height: 46, borderRadius: 14, borderWidth: 1, padding: 3, flexDirection: "row" },
  typeOption: { flex: 1, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  typeText: { fontSize: 14, lineHeight: 19, fontWeight: "800" },
  pressed: { opacity: 0.62 },
  primaryPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  amountSection: { alignItems: "center", paddingVertical: 5 },
  amountLabel: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.4 },
  amountInputRow: { maxWidth: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center" },
  currencyMark: { fontSize: 30, lineHeight: 52, fontWeight: "600", marginRight: 4 },
  amountInput: { minWidth: 135, maxWidth: 280, fontSize: 48, lineHeight: 58, fontWeight: "800", letterSpacing: -1.5, textAlign: "center", fontVariant: ["tabular-nums"], paddingVertical: 0 },
  group: { gap: 10 },
  field: { borderRadius: 15, borderWidth: 1, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 9, gap: 2 },
  fieldLabel: { fontSize: 10, lineHeight: 14, fontWeight: "800", letterSpacing: 1.2 },
  fieldInput: { minHeight: 27, fontSize: 16, lineHeight: 22, paddingVertical: 2 },
  errorText: { fontSize: 11, lineHeight: 16, fontWeight: "600" },
  sectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  sectionTitle: { fontSize: 18, lineHeight: 24, fontWeight: "800" },
  categories: { gap: 8, paddingRight: 16 },
  categoryChip: { minHeight: 42, borderRadius: 21, borderWidth: 1, paddingHorizontal: 13, flexDirection: "row", alignItems: "center", gap: 7 },
  categoryText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  notesCard: { minHeight: 105, borderRadius: 15, borderWidth: 1, padding: 14, gap: 5 },
  notesInput: { minHeight: 62, fontSize: 15, lineHeight: 21, padding: 0 },
  previewLine: { minHeight: 72, borderWidth: 1, borderRadius: 16, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  previewIcon: { width: 38, height: 38, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  previewCopy: { flex: 1, minWidth: 0, gap: 2 },
  previewTitle: { fontSize: 14, lineHeight: 19, fontWeight: "800" },
  previewMeta: { fontSize: 12, lineHeight: 16 },
  previewAmount: { fontSize: 14, lineHeight: 19, fontWeight: "800", fontVariant: ["tabular-nums"] },
  deleteButton: { minHeight: 48, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 7 },
  deleteText: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 18, paddingTop: 11, paddingBottom: 10, gap: 5 },
  saveButton: { minHeight: 52, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  saveText: { color: "#FFFFFF", fontSize: 16, lineHeight: 22, fontWeight: "800" },
  footerNote: { fontSize: 11, lineHeight: 15, textAlign: "center" },
  savedNotice: { minHeight: 52, borderRadius: 16, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  savedNoticeText: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  disabled: { opacity: 0.55 },
});
