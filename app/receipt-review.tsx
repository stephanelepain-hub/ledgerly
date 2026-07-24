import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
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
import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { useAccounting } from "@/lib/accounting-context";
import {
  getReceiptDraft,
  removeReceiptDraft,
  updateReceiptDraft,
} from "@/lib/receipt-draft-store";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  type ReceiptExtraction,
} from "@/lib/receipt-parser";
import { hasConfiguredCloudRetryEndpoint } from "@/constants/oauth";
import { trpc } from "@/lib/trpc";
import { createId, formatMoney, parseAmountToMinor, todayIsoDate, type ReceiptLineItem } from "@/lib/types";

export default function ReceiptReviewScreen() {
  const colors = useColors();
  const { draftId } = useLocalSearchParams<{ draftId?: string }>();
  const draft = draftId ? getReceiptDraft(draftId) : null;
  const initial = draft?.extraction;
  const { categories, upsertTransaction } = useAccounting();
  const [amount, setAmount] = useState(
    initial?.amountMinor ? (initial.amountMinor / 100).toFixed(2) : "",
  );
  const [date, setDate] = useState(initial?.date ?? todayIsoDate());
  const [merchant, setMerchant] = useState(initial?.merchant ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [categoryId, setCategoryId] = useState(initial?.categoryId ?? "other");
  const [extraction, setExtraction] = useState<ReceiptExtraction | null>(initial ?? null);
  const [source, setSource] = useState<"local_ocr" | "cloud_llm">(
    draft?.extractionSource ?? "local_ocr",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [lineItems, setLineItems] = useState<ReceiptLineItem[]>(initial?.lineItems ?? []);
  // Cart prices are edited as raw text and parsed on blur/save. Parsing and
  // re-formatting on every keystroke corrupted typed amounts (e.g. "450"
  // became 4005.00 and grew a hundredfold per digit).
  const [priceDrafts, setPriceDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (initial?.lineItems ?? []).map((item) => [
        item.id,
        item.lineTotalMinor ? (item.lineTotalMinor / 100).toFixed(2) : "",
      ]),
    ),
  );
  const [preTaxMinor, setPreTaxMinor] = useState(initial?.preTaxMinor ?? null);
  const [taxMinor, setTaxMinor] = useState(initial?.taxMinor ?? null);

  const cloudRetry = trpc.receipt.extractFromText.useMutation();
  const amountMinor = useMemo(() => parseAmountToMinor(amount), [amount]);
  const displayedPreTaxMinor = preTaxMinor ?? (
    amountMinor && taxMinor && amountMinor > taxMinor ? amountMinor - taxMinor : null
  );
  const needsCloudOffer =
    hasConfiguredCloudRetryEndpoint() &&
    !!draft?.ocrText &&
    (!extraction || extraction.overallConfidence < HIGH_CONFIDENCE_THRESHOLD);

  const applyExtraction = (next: ReceiptExtraction) => {
    setExtraction(next);
    if (next.amountMinor) setAmount((next.amountMinor / 100).toFixed(2));
    setDate(next.date);
    setMerchant(next.merchant);
    setDescription(next.description);
    setCategoryId(next.categoryId);
    setPreTaxMinor(next.preTaxMinor ?? null);
    setTaxMinor(next.taxMinor ?? null);
    setLineItems(next.lineItems);
    setPriceDrafts(Object.fromEntries(next.lineItems.map((item) => [
      item.id,
      item.lineTotalMinor ? (item.lineTotalMinor / 100).toFixed(2) : "",
    ])));
  };

  const commitPriceDraft = (id: string) => {
    updateLineItem(id, { lineTotalMinor: parseAmountToMinor(priceDrafts[id] ?? "") });
  };

  const updateLineItem = (id: string, update: Partial<ReceiptLineItem>) => {
    setLineItems((items) => items.map((item) => item.id === id ? { ...item, ...update } : item));
  };

  const addLineItem = () => {
    const id = createId("item");
    setLineItems((items) => [...items, {
      id, name: "", quantity: null, unitPriceMinor: null, lineTotalMinor: null, confidence: 0,
    }]);
    setPriceDrafts((drafts) => ({ ...drafts, [id]: "" }));
  };

  const retryWithCloud = () => {
    if (!draft?.ocrText || !draftId) return;
    Alert.alert(
      "Send recognized text to cloud?",
      "Ledgerly will send the OCR text only. The receipt image and your local ledger stay on this device. Cloud processing may use project credits.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Send text",
          onPress: async () => {
            try {
              const result = await cloudRetry.mutateAsync({
                ocrText: draft.ocrText,
                currentDate: todayIsoDate(),
              });
              const next: ReceiptExtraction = {
                amountMinor: result.amountMinor,
                date: result.date,
                merchant: result.merchant,
                description: result.description,
                categoryId: result.categoryId,
                fieldConfidence: {
                  amount: result.amountConfidence,
                  date: result.dateConfidence,
                  merchant: result.merchantConfidence,
                  category: result.categoryConfidence,
                },
                overallConfidence: result.overallConfidence,
                warnings: result.warning ? [result.warning] : [],
                lineItems,
              };
              applyExtraction(next);
              setSource("cloud_llm");
              updateReceiptDraft(draftId, {
                extraction: next,
                extractionSource: "cloud_llm",
                status: "ready",
                error: null,
              });
              if (Platform.OS !== "web") {
                await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              }
            } catch (error) {
              Alert.alert(
                "Cloud retry unavailable",
                error instanceof Error
                  ? error.message
                  : "You can continue editing the transaction manually.",
              );
            }
          },
        },
      ],
    );
  };

  const confirmAndSave = async () => {
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

    setIsSaving(true);
    try {
      await upsertTransaction({
        type: "expense",
        amountMinor,
        date,
        categoryId,
        merchant: merchant.trim(),
        description: description.trim() || `Receipt from ${merchant.trim()}`,
        notes: "",
        receiptUri: draft.imageUri,
        ocrText: draft.ocrText || null,
        extractionSource: source,
        lineItems: lineItems
          .map((item) => ({
            ...item,
            name: item.name.trim(),
            lineTotalMinor: item.id in priceDrafts
              ? parseAmountToMinor(priceDrafts[item.id])
              : item.lineTotalMinor,
          }))
          .filter((item) => item.name.length > 0),
      });
      removeReceiptDraft(draft.id);
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      router.replace("/" as never);
    } catch (error) {
      Alert.alert(
        "Could not save",
        error instanceof Error ? error.message : "The transaction was not saved.",
      );
    } finally {
      setIsSaving(false);
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

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={[styles.receiptCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Image source={{ uri: draft.imageUri }} style={styles.receiptImage} contentFit="cover" />
            <View style={styles.receiptMeta}>
              <View style={[styles.sourceBadge, { backgroundColor: `${colors.primary}18` }]}>
                <MaterialIcons name={source === "cloud_llm" ? "cloud-done" : "offline-bolt"} size={15} color={colors.primary} />
                <Text style={[styles.sourceText, { color: colors.primary }]}>{source === "cloud_llm" ? "Cloud text retry" : "On-device OCR"}</Text>
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
            {taxMinor !== null && (
              <View style={[styles.taxSummary, { borderTopColor: colors.border }]}>
                <MaterialIcons name="receipt" size={16} color={colors.muted} />
                <Text style={[styles.taxSummaryLabel, { color: colors.muted }]}>TVA</Text>
                <Text style={[styles.taxSummaryValue, { color: colors.text }]}>{formatMoney(taxMinor)}</Text>
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

          {!!draft.error && (
            <View style={[styles.warningCard, { borderColor: colors.warning, backgroundColor: `${colors.warning}12` }]}>
              <MaterialIcons name="info-outline" size={20} color={colors.warning} />
              <View style={styles.warningCopy}>
                <Text style={[styles.warningTitle, { color: colors.text }]}>Continue manually</Text>
                <Text style={[styles.warningBody, { color: colors.muted }]}>{draft.error}</Text>
              </View>
            </View>
          )}

          {needsCloudOffer && (
            <View style={[styles.cloudCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <View style={[styles.cloudIcon, { backgroundColor: `${colors.warning}18` }]}>
                <MaterialIcons name="cloud-sync" size={22} color={colors.warning} />
              </View>
              <View style={styles.cloudCopy}>
                <Text style={[styles.cloudTitle, { color: colors.text }]}>Low-confidence result</Text>
                <Text style={[styles.cloudBody, { color: colors.muted }]}>Optionally send only the recognized text to a cloud model for another extraction attempt.</Text>
              </View>
              <Pressable disabled={cloudRetry.isPending} onPress={retryWithCloud} style={({ pressed }) => [styles.cloudButton, { borderColor: colors.primary }, pressed && styles.pressed]}>
                {cloudRetry.isPending ? <ActivityIndicator size="small" color={colors.primary} /> : <Text style={[styles.cloudButtonText, { color: colors.primary }]}>Retry</Text>}
              </Pressable>
            </View>
          )}

          <View style={[styles.cartCard, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            <View style={styles.cartHeader}>
              <View>
                <Text style={[styles.cartTitle, { color: colors.text }]}>Shopping cart</Text>
                <Text style={[styles.cartBody, { color: colors.muted }]}>Items found on this receipt — edit before saving.</Text>
              </View>
              <Text style={[styles.cartCount, { color: colors.primary }]}>{lineItems.length} items</Text>
            </View>
            {lineItems.map((item) => (
              <View key={item.id} style={[styles.cartRow, { borderTopColor: colors.border }]}>
                <TextInput value={item.name} onChangeText={(name) => updateLineItem(item.id, { name })} placeholder="Item name" placeholderTextColor={colors.muted} style={[styles.cartName, { color: colors.text }]} />
                <TextInput value={priceDrafts[item.id] ?? (item.lineTotalMinor ? (item.lineTotalMinor / 100).toFixed(2) : "")} onChangeText={(value) => setPriceDrafts((drafts) => ({ ...drafts, [item.id]: value }))} onBlur={() => commitPriceDraft(item.id)} keyboardType="decimal-pad" placeholder="Price" placeholderTextColor={colors.muted} style={[styles.cartPrice, { color: colors.text, borderColor: colors.border }]} />
                <Pressable onPress={() => setLineItems((items) => items.filter((candidate) => candidate.id !== item.id))} hitSlop={9} accessibilityLabel={`Remove ${item.name || "item"}`}>
                  <MaterialIcons name="close" size={19} color={colors.muted} />
                </Pressable>
              </View>
            ))}
            {lineItems.length === 0 && (
              <View style={styles.emptyCartCopy}>
                <Text style={[styles.emptyCartMessage, { color: colors.muted }]}>No product lines could be matched with prices. Add an item manually.</Text>
                <Text style={[styles.diagnosticMessage, { color: colors.primary }]}>A text-only OCR diagnostic was saved locally for connected-device troubleshooting.</Text>
              </View>
            )}
            <View style={styles.cartFooter}>
              <Pressable onPress={addLineItem} style={({ pressed }) => [styles.addItem, pressed && styles.pressed]}><MaterialIcons name="add" size={18} color={colors.primary} /><Text style={[styles.addItemText, { color: colors.primary }]}>Add item</Text></Pressable>
            </View>
          </View>

          {!!extraction?.warnings.length && (
            <View style={styles.warningList}>
              {extraction.warnings.map((warning) => (
                <View key={warning} style={styles.warningLine}>
                  <MaterialIcons name="error-outline" size={17} color={colors.warning} />
                  <Text style={[styles.warningLineText, { color: colors.muted }]}>{warning}</Text>
                </View>
              ))}
            </View>
          )}

          <View style={styles.formSection}>
            <FieldLabel label={taxMinor !== null ? "Total TTC" : "Amount"} confidence={extraction?.fieldConfidence.amount} />
            <View style={[styles.amountInputWrap, { backgroundColor: colors.surface, borderColor: !amountMinor && amount ? colors.error : colors.border }]}>
              <Text style={[styles.currency, { color: colors.muted }]}>€</Text>
              <TextInput value={amount} onChangeText={setAmount} keyboardType="decimal-pad" placeholder="0.00" placeholderTextColor={colors.muted} style={[styles.amountInput, { color: colors.text }]} returnKeyType="done" />
            </View>

            <ReceiptDatePicker value={date} onChange={setDate} confidence={extraction?.fieldConfidence.date} />

            <FieldLabel label="Merchant" confidence={extraction?.fieldConfidence.merchant} />
            <TextInput value={merchant} onChangeText={setMerchant} placeholder="Merchant or payee" placeholderTextColor={colors.muted} style={[styles.textInput, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]} returnKeyType="next" />

            <FieldLabel label="Description" />
            <TextInput value={description} onChangeText={setDescription} placeholder="What was this for?" placeholderTextColor={colors.muted} style={[styles.textInput, { color: colors.text, backgroundColor: colors.surface, borderColor: colors.border }]} returnKeyType="done" />

            <FieldLabel label="Category" confidence={extraction?.fieldConfidence.category} />
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.categoryRow}>
              {categories.map((category) => {
                const selected = category.id === categoryId;
                return (
                  <Pressable key={category.id} onPress={() => setCategoryId(category.id)} style={({ pressed }) => [styles.categoryChip, { backgroundColor: selected ? `${category.color}20` : colors.surface, borderColor: selected ? category.color : colors.border }, pressed && styles.pressed]}>
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
          <Pressable disabled={isSaving} onPress={() => void confirmAndSave()} style={({ pressed }) => [styles.saveButton, { backgroundColor: colors.primary }, isSaving && styles.disabled, pressed && styles.savePressed]}>
            {isSaving ? <ActivityIndicator size="small" color="#FFFFFF" /> : <MaterialIcons name="check" size={22} color="#FFFFFF" />}
            <Text style={styles.saveText}>{isSaving ? "Saving…" : "Confirm and save"}</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </ScreenContainer>
  );
}

function FieldLabel({ label }: { label: string; confidence?: number }) {
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
  cartFooter: { paddingTop: 2, flexDirection: "row", alignItems: "center" },
  addItem: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 4 },
  addItemText: { fontSize: 12, lineHeight: 17, fontWeight: "800" },
  warningList: { gap: 6 },
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
  savePressed: { opacity: 0.88, transform: [{ scale: 0.985 }] },
  pressed: { opacity: 0.62 },
  disabled: { opacity: 0.55 },
  emptyIcon: { width: 72, height: 72, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 16 },
  emptyTitle: { fontSize: 21, lineHeight: 28, fontWeight: "800", textAlign: "center" },
  emptyBody: { marginTop: 6, fontSize: 14, lineHeight: 20, textAlign: "center" },
  returnButton: { marginTop: 18, minHeight: 48, borderRadius: 15, paddingHorizontal: 20, alignItems: "center", justifyContent: "center" },
  returnText: { color: "#FFFFFF", fontSize: 14, lineHeight: 19, fontWeight: "800" },
});
