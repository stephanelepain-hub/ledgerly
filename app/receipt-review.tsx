import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useReducer, useRef, useState } from "react";
import {
  ActivityIndicator,
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
import { ReceiptVerdictCard } from "@/components/receipt-verdict-card";
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import {
  getReceiptDraft,
  removeReceiptDraft,
} from "@/lib/receipt-draft-store";
import { persistReceiptImage } from "@/lib/receipt-storage";
import { shareLatestReceiptOcrDiagnostic } from "@/lib/receipt-debug";
import type { ReceiptReviewModel } from "@/lib/receipt-reliability";
import {
  buildReceiptSaveFields,
  createReceiptReviewState,
  receiptReviewReducer,
} from "@/lib/receipt-review-state";
import { createId, formatLongDate, formatMoney, parseAmountToMinor } from "@/lib/types";
import { findDuplicateTransaction } from "@/lib/db";

export default function ReceiptReviewScreen() {
  const colors = useColors();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
  // Snapshot the draft once. Reading the store on every render made the
  // screen flip to "Receipt review expired" the moment the saved draft was
  // removed, before the modal finished dismissing.
  const [draft] = useState(() => (draftId ? getReceiptDraft(draftId) : null));
  const emptyModel: ReceiptReviewModel = {
    outcome: "manual_assistance",
    amountMinor: null,
    date: null,
    merchant: null,
    preTaxMinor: null,
    taxMinor: null,
    categoryId: null,
    description: "",
    lineItems: [],
    reasons: ["No verified receipt details are available."],
  };
  const initialModel = draft?.reviewModel ?? emptyModel;
  const [review, dispatch] = useReducer(
    receiptReviewReducer,
    initialModel,
    createReceiptReviewState,
  );
  const { amount, date, merchant, description, categoryId, lineItems, priceDrafts } = review;
  const { categories, transactions, upsertTransaction } = useAccounting();
  const [isSaving, setIsSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // Set once the user has consciously chosen to keep a flagged duplicate.
  const duplicateAcknowledged = useRef(false);
  // React state updates are asynchronous, so the button's `disabled` prop
  // cannot stop a fast double tap. This synchronous guard can.
  const saveGuard = useRef(false);
  const scrollRef = useRef<ScrollView>(null);
  const amountInputRef = useRef<TextInput>(null);
  const itemInputRefs = useRef<Record<string, TextInput | null>>({});
  const amountMinor = useMemo(() => parseAmountToMinor(amount), [amount]);
  const duplicate = useMemo(
    () => findDuplicateTransaction(transactions, { amountMinor, date }),
    [transactions, amountMinor, date],
  );
  const vatStillReconciles = amountMinor !== null && amountMinor === initialModel.amountMinor;
  const displayedPreTaxMinor = vatStillReconciles ? review.preTaxMinor : null;
  const displayedTaxMinor = vatStillReconciles ? review.taxMinor : null;
  const verifiedSummary = [
    initialModel.merchant,
    initialModel.date ? formatLongDate(initialModel.date) : null,
    initialModel.amountMinor === null ? null : formatMoney(initialModel.amountMinor),
  ].filter((value): value is string => !!value).join(" · ") || "Verified fields are retained below";

  const shareDiagnostic = async () => {
    try {
      await shareLatestReceiptOcrDiagnostic();
    } catch (error) {
      Alert.alert(
        "Diagnostic unavailable",
        error instanceof Error ? error.message : "The OCR diagnostic could not be shared.",
      );
    }
  };

  const commitPriceDraft = (id: string) => {
    dispatch({ type: "commit_item_price", id });
  };

  const updateLineItem = (
    update: Extract<Parameters<typeof receiptReviewReducer>[1], { type: "update_item" }>,
  ) => {
    dispatch(update);
  };

  const addLineItem = () => {
    const id = createId("item");
    dispatch({ type: "add_item", id });
    requestAnimationFrame(() => itemInputRefs.current[id]?.focus());
  };

  const continueFromVerdict = () => {
    if (!amountMinor) {
      amountInputRef.current?.focus();
      return;
    }
    scrollRef.current?.scrollToEnd({ animated: true });
  };

  const confirmAndSave = async () => {
    if (saveGuard.current) return;
    if (!draft) {
      Alert.alert("Receipt no longer available", "Return to Scan and choose the image again.");
      return;
    }
    if (!amountMinor) {
      Alert.alert("Check amount", "Enter a positive transaction amount.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      Alert.alert("Check date", "Use the date format YYYY-MM-DD.");
      return;
    }
    if (!merchant.trim()) {
      Alert.alert("Merchant required", "Enter the merchant or payee shown on the receipt.");
      return;
    }
    if (!categories.some((category) => category.id === categoryId)) {
      Alert.alert("Category required", "Choose a category before saving.");
      return;
    }

    saveGuard.current = true;
    // Warn before a re-scanned receipt is counted twice. This only warns:
    // the user can still keep it, because two genuine purchases can coincide.
    if (duplicate && !duplicateAcknowledged.current) {
      Alert.alert(
        "You have already saved this one",
        `${duplicate.merchant.trim() || "A receipt"} for ${formatMoney(duplicate.amountMinor)} on ${formatLongDate(duplicate.date)} is already in your ledger. Saving it again will count it twice in your totals.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Save anyway",
            style: "destructive",
            onPress: () => {
              duplicateAcknowledged.current = true;
              void confirmAndSave();
            },
          },
        ],
      );
      return;
    }

    setIsSaving(true);
    try {
      // Copy the receipt image out of the volatile camera/picker cache before
      // referencing it from the ledger. If the copy fails, fall back to the
      // cache URI so the save itself never blocks.
      const receiptUri = await persistReceiptImage(draft.imageUri, createId("receipt-img"))
        .catch(() => draft.imageUri);
      await upsertTransaction({
        type: "expense",
        ...buildReceiptSaveFields(review),
        notes: "",
        receiptUri,
        extractionSource: draft.extractionSource,
      });
      removeReceiptDraft(draft.id);
      // Retire the save affordance before navigating. The screen is a
      // fullScreenModal, so it stays mounted through the dismiss animation
      // and must not keep offering to save an already-saved receipt.
      setSaved(true);
      setIsSaving(false);
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      // `replace` targeted the tab anchor already at the bottom of the stack
      // and left this modal presented. Dismiss the modal instead.
      if (router.canDismiss()) router.dismissTo("/" as never);
      else router.replace("/" as never);
    } catch (error) {
      // The write failed, so allow another attempt.
      saveGuard.current = false;
      setIsSaving(false);
      Alert.alert(
        "Could not save",
        error instanceof Error ? error.message : "The transaction was not saved.",
      );
    }
  };

  if (!draft) {
    return (
      <ScreenContainer edges={["top", "bottom", "left", "right"]} className="items-center justify-center px-8">
        <View style={[styles.emptyIcon, { backgroundColor: colors.surface }]}>
          <MaterialIcons name="receipt-long" size={34} color={colors.muted} />
        </View>
        <Text style={[styles.emptyTitle, { color: colors.text }]}>Receipt review expired</Text>
        <Text style={[styles.emptyBody, { color: colors.muted }]}>Choose the image again to restart on-device recognition.</Text>
        <Pressable onPress={() => router.replace("/(tabs)/scan" as never)} style={[styles.returnButton, { backgroundColor: colors.primary }]}>
          <Text style={styles.returnText}>Return to scan</Text>
        </Pressable>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer edges={["top", "bottom", "left", "right"]}>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <View style={[styles.header, { borderBottomColor: colors.border }]}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={({ pressed }) => [styles.headerButton, pressed && styles.pressed]}>
            <MaterialIcons name="close" size={24} color={colors.text} />
          </Pressable>
          <View style={styles.headerCopy}>
            <Text style={[styles.headerTitle, { color: colors.text }]}>Review receipt</Text>
            <Text style={[styles.headerSubtitle, { color: colors.muted }]}>Confirm every field before saving</Text>
          </View>
          <View style={styles.headerButton} />
        </View>

        <ScrollView ref={scrollRef} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <ReceiptVerdictCard
            outcome={review.outcome}
            summary={verifiedSummary}
            itemCount={initialModel.lineItems.length}
            reasons={review.reasons}
            onContinue={continueFromVerdict}
            onAddBasket={addLineItem}
          />

          <View style={[styles.receiptCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Image source={{ uri: draft.imageUri }} style={styles.receiptImage} contentFit="cover" />
            <View style={styles.receiptMeta}>
              <View style={[styles.sourceBadge, { backgroundColor: `${colors.primary}18` }]}>
                <MaterialIcons name="verified-user" size={15} color={colors.primary} />
                <Text style={[styles.sourceText, { color: colors.primary }]}>On-device OCR · verified only</Text>
              </View>
              {draft.imageUris.length > 1 && (
                <Text style={[styles.sectionSummary, { color: colors.muted }]}>{draft.imageUris.length} sections</Text>
              )}
            </View>
            {!!merchant.trim() && (
              <View style={[styles.taxSummary, { borderTopColor: colors.border }]}>
                <MaterialIcons name="storefront" size={16} color={colors.primary} />
                <Text style={[styles.taxSummaryLabel, { color: colors.muted }]}>Merchant</Text>
                <Text numberOfLines={1} style={[styles.merchantSummaryValue, { color: colors.text }]}>{merchant.trim()}</Text>
              </View>
            )}
            {displayedPreTaxMinor !== null && (
              <View style={[styles.taxSummary, { borderTopColor: colors.border }]}>
                <MaterialIcons name="receipt" size={16} color={colors.muted} />
                <Text style={[styles.taxSummaryLabel, { color: colors.muted }]}>Total HT</Text>
                <Text style={[styles.taxSummaryValue, { color: colors.text }]}>{formatMoney(displayedPreTaxMinor)}</Text>
              </View>
            )}
            {displayedTaxMinor !== null && (
              <View style={[styles.taxSummary, { borderTopColor: colors.border }]}>
                <MaterialIcons name="receipt" size={16} color={colors.muted} />
                <Text style={[styles.taxSummaryLabel, { color: colors.muted }]}>TVA</Text>
                <Text style={[styles.taxSummaryValue, { color: colors.text }]}>{formatMoney(displayedTaxMinor)}</Text>
              </View>
            )}
            {amountMinor !== null && (
              <View style={[styles.taxSummary, styles.totalSummary, { borderTopColor: colors.border }]}>
                <MaterialIcons name="payments" size={16} color={colors.primary} />
                <Text style={[styles.taxSummaryLabel, { color: colors.text }]}>Total TTC</Text>
                <Text style={[styles.totalSummaryValue, { color: colors.text }]}>{formatMoney(amountMinor)}</Text>
              </View>
            )}
          </View>

          {!!duplicate && (
            <View style={[styles.warningCard, { borderColor: colors.warning, backgroundColor: `${colors.warning}12` }]}>
              <MaterialIcons name="content-copy" size={20} color={colors.warning} />
              <View style={styles.warningCopy}>
                <Text style={[styles.warningTitle, { color: colors.text }]}>You have already saved this one</Text>
                <Text style={[styles.warningBody, { color: colors.muted }]}>
                  {`${duplicate.merchant.trim() || "A receipt"} for ${formatMoney(duplicate.amountMinor)} on ${formatLongDate(duplicate.date)} is already in your ledger. Saving it again would count it twice.`}
                </Text>
              </View>
            </View>
          )}

          {!!draft.error && (
            <View style={[styles.warningCard, { borderColor: colors.warning, backgroundColor: `${colors.warning}12` }]}>
              <MaterialIcons name="info-outline" size={20} color={colors.warning} />
              <View style={styles.warningCopy}>
                <Text style={[styles.warningTitle, { color: colors.text }]}>Continue manually</Text>
                <Text style={[styles.warningBody, { color: colors.muted }]}>{draft.error}</Text>
              </View>
            </View>
          )}

          <View style={[styles.cartCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.cartHeader}>
              <View>
                <Text style={[styles.cartTitle, { color: colors.text }]}>Shopping cart</Text>
                <Text style={[styles.cartBody, { color: colors.muted }]}>Verified receipt items or rows you add manually.</Text>
              </View>
              <Text style={[styles.cartCount, { color: colors.primary }]}>{lineItems.length} items</Text>
            </View>
            {lineItems.map((item) => (
              <View key={item.id} style={[styles.cartRow, { borderTopColor: colors.border }]}>
                <TextInput ref={(input) => { itemInputRefs.current[item.id] = input; }} value={item.name} onChangeText={(name) => updateLineItem({ type: "update_item", id: item.id, update: { name } })} placeholder="Item name" placeholderTextColor={colors.muted} style={[styles.cartName, { color: colors.text }]} />
                <TextInput value={priceDrafts[item.id] ?? (item.lineTotalMinor ? (item.lineTotalMinor / 100).toFixed(2) : "")} onChangeText={(value) => dispatch({ type: "set_item_price", id: item.id, value })} onBlur={() => commitPriceDraft(item.id)} keyboardType="decimal-pad" placeholder="Price" placeholderTextColor={colors.muted} style={[styles.cartPrice, { color: colors.text, borderColor: colors.border }]} />
                <Pressable onPress={() => dispatch({ type: "remove_item", id: item.id })} hitSlop={9} accessibilityLabel={`Remove ${item.name || "item"}`}>
                  <MaterialIcons name="close" size={19} color={colors.muted} />
                </Pressable>
              </View>
            ))}
            {lineItems.length === 0 && (
              <View style={styles.emptyCartCopy}>
                <Text style={[styles.emptyCartMessage, { color: colors.muted }]}>The basket is empty. Add items manually if you want to keep them.</Text>
                <Text style={[styles.diagnosticMessage, { color: colors.primary }]}>A text-only OCR diagnostic was saved on this device. Use &quot;Share OCR diagnostic&quot; below to send it for troubleshooting.</Text>
              </View>
            )}
            <View style={styles.cartFooter}>
              <Pressable onPress={addLineItem} style={({ pressed }) => [styles.addItem, pressed && styles.pressed]}><MaterialIcons name="add" size={18} color={colors.primary} /><Text style={[styles.addItemText, { color: colors.primary }]}>Add item</Text></Pressable>
              <Pressable
                onPress={() => void shareDiagnostic()}
                accessibilityLabel="Share OCR diagnostic"
                accessibilityHint="Shares a text-only recognition report for this scan. Receipt images are not included."
                style={({ pressed }) => [styles.addItem, pressed && styles.pressed]}
              >
                <MaterialIcons name="bug-report" size={16} color={colors.muted} />
                <Text style={[styles.addItemText, { color: colors.muted }]}>Share OCR diagnostic</Text>
              </Pressable>
            </View>
          </View>

          <View style={styles.formSection}>
            <FieldLabel label={displayedTaxMinor !== null ? "Total TTC" : "Amount"} />
            <View style={[styles.amountInputWrap, { backgroundColor: colors.surface, borderColor: !amountMinor && amount ? colors.error : colors.border }]}>
              <Text style={[styles.currency, { color: colors.muted }]}>€</Text>
              <TextInput ref={amountInputRef} value={amount} onChangeText={(value) => dispatch({ type: "set_amount", value })} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} accessibilityLabel="Receipt total" style={[styles.amountInput, { color: colors.text }]} returnKeyType="done" />
            </View>

            <ReceiptDatePicker value={date} onChange={(value) => dispatch({ type: "set_date", value })} />

            <FieldLabel label="Merchant" />
            <TextInput value={merchant} onChangeText={(value) => dispatch({ type: "set_merchant", value })} placeholder="Merchant or payee" placeholderTextColor={colors.muted} style={[styles.textInput, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]} returnKeyType="next" />

            <FieldLabel label="Description" />
            <TextInput value={description} onChangeText={(value) => dispatch({ type: "set_description", value })} placeholder="What was this for?" placeholderTextColor={colors.muted} style={[styles.textInput, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]} returnKeyType="done" />

            <FieldLabel label="Category" />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
              {categories.map((category) => {
                const selected = category.id === categoryId;
                return (
                  <Pressable key={category.id} onPress={() => dispatch({ type: "set_category", value: category.id })} style={({ pressed }) => [styles.categoryChip, { backgroundColor: selected ? `${category.color}20` : colors.surface, borderColor: selected ? category.color : colors.border }, pressed && styles.pressed]}>
                    <MaterialIcons name={category.icon as keyof typeof MaterialIcons.glyphMap} size={17} color={selected ? category.color : colors.muted} />
                    <Text style={[styles.categoryText, { color: selected ? category.color : colors.text }]}>{category.name}</Text>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>

          <View style={[styles.confirmNote, { backgroundColor: `${colors.primary}10` }]}>
            <MaterialIcons name="lock-outline" size={18} color={colors.primary} />
            <Text style={[styles.confirmNoteText, { color: colors.muted }]}>Saving writes this confirmed transaction to Ledgerly&apos;s on-device SQLite database.</Text>
          </View>
        </ScrollView>

        <View style={[styles.footer, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          {saved ? (
            <View accessibilityRole="summary" style={[styles.savedNotice, { borderColor: colors.primary, backgroundColor: `${colors.primary}12` }]}>
              <MaterialIcons name="check-circle" size={22} color={colors.primary} />
              <Text style={[styles.savedNoticeText, { color: colors.text }]}>Saved to your ledger</Text>
            </View>
          ) : (
            <Pressable disabled={isSaving} onPress={() => void confirmAndSave()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, isSaving && styles.disabled, pressed && styles.savePressed]}>
              {isSaving ? <ActivityIndicator size="small" color="#FFFFFF" /> : <MaterialIcons name="check" size={22} color="#FFFFFF" />}
              <Text style={styles.saveText}>{isSaving ? "Saving…" : "Confirm and save"}</Text>
            </Pressable>
          )}
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function FieldLabel({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={styles.labelRow}>
      <Text style={[styles.label, { color: colors.text }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { minHeight: 66, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, flexDirection: "row", alignItems: "center" },
  headerButton: { width: 42, height: 42, borderRadius: 21, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, alignItems: "center" },
  headerTitle: { fontSize: 17, lineHeight: 22, fontWeight: "800" },
  headerSubtitle: { fontSize: 11, lineHeight: 15, marginTop: 1 },
  content: { padding: 17, paddingBottom: 24, gap: 14 },
  receiptCard: { borderRadius: 18, borderWidth: 1, overflow: "hidden" },
  receiptImage: { width: "100%", height: 158 },
  receiptMeta: { minHeight: 48, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  sourceBadge: { minHeight: 28, borderRadius: 14, paddingHorizontal: 9, flexDirection: "row", alignItems: "center", gap: 5 },
  sourceText: { fontSize: 11, lineHeight: 15, fontWeight: "800" },
  sectionSummary: { fontSize: 11, lineHeight: 15, flexShrink: 1, textAlign: "right" },
  taxSummary: { minHeight: 38, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  taxSummaryLabel: { flex: 1, fontSize: 12, lineHeight: 17, fontWeight: "700" },
  taxSummaryValue: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  merchantSummaryValue: { maxWidth: "62%", fontSize: 13, lineHeight: 18, fontWeight: "800", textAlign: "right" },
  totalSummary: { minHeight: 44 },
  totalSummaryValue: { fontSize: 15, lineHeight: 20, fontWeight: "900" },
  warningCard: { borderWidth: 1, borderRadius: 15, padding: 12, flexDirection: "row", alignItems: "flex-start", gap: 9 },
  warningCopy: { flex: 1, gap: 2 },
  warningTitle: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  warningBody: { fontSize: 12, lineHeight: 17 },
  cloudCard: { borderRadius: 16, borderWidth: 1, padding: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  cloudIcon: { width: 42, height: 42, borderRadius: 14, alignItems: "center", justifyContent: "center" },
  cloudCopy: { flex: 1, gap: 2 },
  cloudTitle: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  cloudBody: { fontSize: 11, lineHeight: 16 },
  cloudButton: { minWidth: 58, height: 36, borderRadius: 11, borderWidth: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 10 },
  cloudButtonText: { fontSize: 12, lineHeight: 16, fontWeight: "800" },
  cartCard: { borderWidth: 1, borderRadius: 16, padding: 12, gap: 8 },
  cartHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 10 },
  cartTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  cartBody: { marginTop: 2, fontSize: 11, lineHeight: 16 },
  cartCount: { fontSize: 12, lineHeight: 17, fontWeight: "800" },
  cartRow: { minHeight: 44, borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  cartName: { flex: 1, minWidth: 0, minHeight: 36, fontSize: 14, lineHeight: 19, paddingVertical: 0 },
  cartPrice: { width: 78, minHeight: 36, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, textAlign: "right", fontSize: 13, lineHeight: 18 },
  emptyCartCopy: { gap: 5, paddingTop: 4 },
  emptyCartMessage: { fontSize: 12, lineHeight: 17 },
  diagnosticMessage: { fontSize: 10, lineHeight: 15, fontWeight: "700" },
  cartFooter: { paddingTop: 2, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10 },
  addItem: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 4 },
  addItemText: { fontSize: 12, lineHeight: 17, fontWeight: "800" },
  warningList: { gap: 6 },
  warningListIntro: { fontSize: 12, lineHeight: 17, fontWeight: "700" },
  warningLine: { flexDirection: "row", alignItems: "center", gap: 7 },
  warningLineText: { fontSize: 12, lineHeight: 17, flex: 1 },
  formSection: { gap: 8 },
  labelRow: { minHeight: 22, marginTop: 6, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  label: { fontSize: 13, lineHeight: 18, fontWeight: "800" },
  amountInputWrap: { minHeight: 66, borderRadius: 16, borderWidth: 1, paddingHorizontal: 15, flexDirection: "row", alignItems: "center" },
  currency: { fontSize: 25, lineHeight: 31, fontWeight: "700", marginRight: 8 },
  amountInput: { flex: 1, fontSize: 31, lineHeight: 38, fontWeight: "800", paddingVertical: 8 },
  textInput: { minHeight: 52, borderRadius: 14, borderWidth: 1, paddingHorizontal: 14, paddingVertical: 11, fontSize: 15, lineHeight: 20 },
  categoryRow: { gap: 8, paddingRight: 8 },
  categoryChip: { minHeight: 40, borderRadius: 20, borderWidth: 1, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6 },
  categoryText: { fontSize: 12, lineHeight: 17, fontWeight: "700" },
  confirmNote: { borderRadius: 14, padding: 12, flexDirection: "row", alignItems: "flex-start", gap: 8 },
  confirmNoteText: { flex: 1, fontSize: 11, lineHeight: 16 },
  footer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: 17, paddingTop: 12, paddingBottom: 12 },
  saveButton: { minHeight: 54, borderRadius: 16, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  saveText: { color: "#FFFFFF", fontSize: 16, lineHeight: 21, fontWeight: "800" },
  savedNotice: { minHeight: 54, borderRadius: 16, borderWidth: 1, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  savedNoticeText: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  savePressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  pressed: { opacity: 0.62 },
  disabled: { opacity: 0.55 },
  emptyIcon: { width: 72, height: 72, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  emptyTitle: { fontSize: 21, lineHeight: 28, fontWeight: "800", textAlign: "center" },
  emptyBody: { marginTop: 6, fontSize: 14, lineHeight: 20, textAlign: "center" },
  returnButton: { marginTop: 18, minHeight: 48, borderRadius: 15, paddingHorizontal: 20, alignItems: "center", justifyContent: "center" },
  returnText: { color: "#FFFFFF", fontSize: 14, lineHeight: 19, fontWeight: "800" },
});
