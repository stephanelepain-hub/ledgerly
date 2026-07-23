import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { createReceiptDraft, updateReceiptDraft } from "@/lib/receipt-draft-store";
import { recognizeReceiptText } from "@/lib/receipt-ocr";
import { parseReceiptText } from "@/lib/receipt-parser";

export default function ScanScreen() {
  const colors = useColors();
  const [isProcessing, setIsProcessing] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [status, setStatus] = useState("Waiting for a receipt");

  const openReview = (draftId: string) => {
    router.push({ pathname: "/receipt-review" as never, params: { draftId } });
  };

  const processImage = async (imageUri: string) => {
    const draft = createReceiptDraft(imageUri);
    setPreviewUri(imageUri);
    setIsProcessing(true);
    setStatus("Reading receipt on this device…");
    updateReceiptDraft(draft.id, { status: "processing" });

    try {
      const result = await recognizeReceiptText(imageUri);
      setStatus("Structuring transaction details…");
      const extraction = parseReceiptText(result.text);
      updateReceiptDraft(draft.id, {
        ocrText: result.text,
        extraction,
        status: "ready",
        error: null,
      });
      if (Platform.OS !== "web") {
        await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      openReview(draft.id);
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : "Ledgerly could not read this image on the device.";
      updateReceiptDraft(draft.id, {
        extraction: parseReceiptText(""),
        status: "error",
        error: message,
      });
      openReview(draft.id);
    } finally {
      setIsProcessing(false);
      setStatus("Waiting for a receipt");
    }
  };

  const takePhoto = async () => {
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert(
        "Camera access needed",
        "Allow camera access in Android settings to photograph receipts. You can still import from the gallery.",
      );
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ["images"],
      allowsEditing: false,
      quality: 0.9,
      exif: false,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      await processImage(result.assets[0].uri);
    }
  };

  const importPhoto = async () => {
    if (Platform.OS !== "web") {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert(
          "Photo access needed",
          "Allow photo access to import a receipt image from your gallery.",
        );
        return;
      }
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"],
      allowsMultipleSelection: false,
      allowsEditing: false,
      quality: 1,
    });
    if (!result.canceled && result.assets[0]?.uri) {
      await processImage(result.assets[0].uri);
    }
  };

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>RECEIPT CAPTURE</Text>
          <Text style={[styles.title, { color: colors.text }]}>Scan a receipt</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>
            Ledgerly reads the image on your device, then asks you to review every value before saving.
          </Text>
        </View>

        <View style={[styles.preview, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {previewUri ? (
            <Image source={{ uri: previewUri }} style={styles.previewImage} contentFit="cover" />
          ) : (
            <View style={styles.guide}>
              <View style={[styles.corner, styles.topLeft, { borderColor: colors.primary }]} />
              <View style={[styles.corner, styles.topRight, { borderColor: colors.primary }]} />
              <View style={[styles.corner, styles.bottomLeft, { borderColor: colors.primary }]} />
              <View style={[styles.corner, styles.bottomRight, { borderColor: colors.primary }]} />
              <View style={[styles.receiptGlyph, { backgroundColor: `${colors.primary}15` }]}>
                <MaterialIcons name="receipt-long" size={46} color={colors.primary} />
              </View>
              <Text style={[styles.guideTitle, { color: colors.text }]}>Keep the full receipt visible</Text>
              <Text style={[styles.guideBody, { color: colors.muted }]}>
                Use bright, even light and avoid shadows over the total.
              </Text>
            </View>
          )}
          {isProcessing && (
            <View style={styles.processingOverlay}>
              <View style={[styles.processingCard, { backgroundColor: colors.background }]}>
                <ActivityIndicator size="small" color={colors.primary} />
                <Text style={[styles.processingText, { color: colors.text }]}>{status}</Text>
              </View>
            </View>
          )}
        </View>

        <View style={styles.actions}>
          <Pressable
            disabled={isProcessing}
            onPress={() => void takePhoto()}
            style={({ pressed }) => [
              styles.primaryButton,
              { backgroundColor: colors.primary },
              isProcessing && styles.disabled,
              pressed && styles.primaryPressed,
            ]}
          >
            <MaterialIcons name="photo-camera" size={23} color="#FFFFFF" />
            <View style={styles.buttonCopy}>
              <Text style={styles.primaryTitle}>Take a photo</Text>
              <Text style={styles.primarySubtitle}>Open the device camera</Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color="#D8EFE8" />
          </Pressable>

          <Pressable
            disabled={isProcessing}
            onPress={() => void importPhoto()}
            style={({ pressed }) => [
              styles.secondaryButton,
              { backgroundColor: colors.surface, borderColor: colors.border },
              isProcessing && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            <MaterialIcons name="photo-library" size={23} color={colors.primary} />
            <View style={styles.buttonCopy}>
              <Text style={[styles.secondaryTitle, { color: colors.text }]}>Import from gallery</Text>
              <Text style={[styles.secondarySubtitle, { color: colors.muted }]}>Choose an existing image</Text>
            </View>
            <MaterialIcons name="chevron-right" size={22} color={colors.muted} />
          </Pressable>
        </View>

        <View style={[styles.flowCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Text style={[styles.flowTitle, { color: colors.text }]}>Private by default</Text>
          <FlowStep icon="document-scanner" number="1" title="Read on device" body="ML Kit recognizes the receipt without uploading the image." />
          <View style={[styles.connector, { backgroundColor: colors.border }]} />
          <FlowStep icon="tune" number="2" title="Structure locally" body="Ledgerly proposes the amount, date, merchant, and category." />
          <View style={[styles.connector, { backgroundColor: colors.border }]} />
          <FlowStep icon="verified-user" number="3" title="You confirm" body="Nothing enters your ledger until you approve it." />
        </View>

        <View style={[styles.cloudNote, { borderColor: colors.border }]}>
          <MaterialIcons name="cloud-off" size={20} color={colors.muted} />
          <Text style={[styles.cloudNoteText, { color: colors.muted }]}>
            If confidence is low, you may explicitly send only recognized text—not the receipt image—to the cloud for a retry.
          </Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

function FlowStep({
  icon,
  number,
  title,
  body,
}: {
  icon: keyof typeof MaterialIcons.glyphMap;
  number: string;
  title: string;
  body: string;
}) {
  const colors = useColors();
  return (
    <View style={styles.flowRow}>
      <View style={[styles.flowIcon, { backgroundColor: `${colors.primary}15` }]}>
        <MaterialIcons name={icon} size={21} color={colors.primary} />
      </View>
      <View style={styles.flowCopy}>
        <Text style={[styles.flowStepTitle, { color: colors.text }]}>{number}. {title}</Text>
        <Text style={[styles.flowBody, { color: colors.muted }]}>{body}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, gap: 18 },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.5 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  subtitle: { marginTop: 5, fontSize: 14, lineHeight: 20, maxWidth: 345 },
  preview: { height: 270, borderRadius: 22, borderWidth: 1, overflow: "hidden" },
  previewImage: { width: "100%", height: "100%" },
  guide: { flex: 1, paddingHorizontal: 35, alignItems: "center", justifyContent: "center" },
  corner: { position: "absolute", width: 32, height: 32 },
  topLeft: { top: 18, left: 18, borderTopWidth: 3, borderLeftWidth: 3, borderTopLeftRadius: 8 },
  topRight: { top: 18, right: 18, borderTopWidth: 3, borderRightWidth: 3, borderTopRightRadius: 8 },
  bottomLeft: { bottom: 18, left: 18, borderBottomWidth: 3, borderLeftWidth: 3, borderBottomLeftRadius: 8 },
  bottomRight: { bottom: 18, right: 18, borderBottomWidth: 3, borderRightWidth: 3, borderBottomRightRadius: 8 },
  receiptGlyph: { width: 78, height: 78, borderRadius: 24, alignItems: "center", justifyContent: "center", marginBottom: 13 },
  guideTitle: { fontSize: 17, lineHeight: 23, fontWeight: "800", textAlign: "center" },
  guideBody: { marginTop: 5, fontSize: 13, lineHeight: 18, textAlign: "center", maxWidth: 260 },
  processingOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(12, 25, 22, 0.58)", alignItems: "center", justifyContent: "center", padding: 24 },
  processingCard: { minHeight: 58, borderRadius: 16, paddingHorizontal: 18, flexDirection: "row", alignItems: "center", gap: 11 },
  processingText: { fontSize: 14, lineHeight: 19, fontWeight: "700" },
  actions: { gap: 10 },
  primaryButton: { minHeight: 68, borderRadius: 17, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 12 },
  secondaryButton: { minHeight: 68, borderRadius: 17, borderWidth: 1, paddingHorizontal: 15, flexDirection: "row", alignItems: "center", gap: 12 },
  buttonCopy: { flex: 1, gap: 2 },
  primaryTitle: { color: "#FFFFFF", fontSize: 15, lineHeight: 20, fontWeight: "800" },
  primarySubtitle: { color: "#D8EFE8", fontSize: 12, lineHeight: 17 },
  secondaryTitle: { fontSize: 15, lineHeight: 20, fontWeight: "800" },
  secondarySubtitle: { fontSize: 12, lineHeight: 17 },
  primaryPressed: { opacity: 0.88, transform: [{ scale: 0.98 }] },
  pressed: { opacity: 0.64 },
  disabled: { opacity: 0.55 },
  flowCard: { borderRadius: 18, borderWidth: 1, padding: 15, gap: 10 },
  flowTitle: { fontSize: 17, lineHeight: 23, fontWeight: "800", marginBottom: 2 },
  flowRow: { flexDirection: "row", alignItems: "center", gap: 11 },
  flowIcon: { width: 40, height: 40, borderRadius: 13, alignItems: "center", justifyContent: "center" },
  flowCopy: { flex: 1, gap: 2 },
  flowStepTitle: { fontSize: 14, lineHeight: 19, fontWeight: "800" },
  flowBody: { fontSize: 12, lineHeight: 17 },
  connector: { width: 1, height: 7, marginLeft: 20 },
  cloudNote: { borderWidth: 1, borderRadius: 15, padding: 12, flexDirection: "row", alignItems: "flex-start", gap: 9 },
  cloudNoteText: { flex: 1, fontSize: 12, lineHeight: 17 },
});
