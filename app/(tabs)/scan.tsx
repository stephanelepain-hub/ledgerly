import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router, useFocusEffect } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { saveLatestReceiptOcrDiagnostic } from "@/lib/receipt-debug";
import { launchReceiptDocumentScanner } from "@/lib/receipt-document-scanner";
import { createReceiptDraft, getReceiptDraft, removeReceiptDraft, updateReceiptDraft } from "@/lib/receipt-draft-store";
import { mergeReceiptSections, parseReceiptText } from "@/lib/receipt-parser";
import { recognizeReceiptText, type ReceiptOcrLine } from "@/lib/receipt-ocr";

interface ReceiptSection {
  uri: string;
  text: string;
  lines: ReceiptOcrLine[];
}

export default function ScanScreen() {
  const colors = useColors();
  const cameraRef = useRef<CameraView>(null);
  const openedOnce = useRef(false);
  const activeDraftId = useRef<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [cameraReady, setCameraReady] = useState(false);
  const [working, setWorking] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [sections, setSections] = useState<ReceiptSection[]>([]);
  // Google's ML Kit document scanner (edge detection, crop, deskew, shadow
  // and contrast cleanup) dramatically improves OCR on low-grade cameras.
  // It is Android-only and needs Google Play services; the manual camera
  // flow remains as the fallback.
  const [docScannerAvailable, setDocScannerAvailable] = useState(Platform.OS === "android");
  const [status, setStatus] = useState(
    Platform.OS === "android" ? "Ready to scan a receipt" : "Preparing scanner…",
  );

  const openCamera = useCallback(async () => {
    const result = permission?.granted ? permission : await requestPermission();
    if (!result.granted) {
      setStatus("Camera access is needed to scan a receipt");
      setCameraOpen(false);
      return;
    }
    setCameraReady(false);
    setStatus("Starting camera and autofocus…");
    setCameraOpen(true);
  }, [permission, requestPermission]);

  useEffect(() => {
    if (openedOnce.current || docScannerAvailable) return;
    openedOnce.current = true;
    void openCamera();
  }, [openCamera, docScannerAvailable]);

  // When the reviewed draft was consumed (saved), clear the captured sections.
  // The Scan tab stays mounted, so stale sections would otherwise leak into
  // the next capture and duplicate cart items. Backing out of review keeps
  // the draft alive, so in-progress sections survive for editing.
  useFocusEffect(
    useCallback(() => {
      if (activeDraftId.current && !getReceiptDraft(activeDraftId.current)) {
        activeDraftId.current = null;
        setSections([]);
        setPreviewUri(null);
        setStatus("Position the top of the receipt inside the frame");
      }
    }, []),
  );

  const processSection = async (uri: string) => {
    setPreviewUri(uri);
    setWorking(true);
    setStatus("Reading this section on your device…");
    try {
      const result = await recognizeReceiptText(uri);
      const readableCharacters = result.text.replace(/\s/g, "").length;
      if (result.lines.length < 3 || readableCharacters < 20) {
        throw new Error("Not enough receipt text was recognized. Keep the phone parallel to the receipt, move closer, and avoid glare.");
      }
      setSections((current) => [...current, { uri, text: result.text, lines: result.lines }]);
      setStatus("Section read. Add the next section with overlap, or review the receipt.");
    } catch (error) {
      setStatus("Could not read this section");
      Alert.alert(
        "Could not scan this section",
        error instanceof Error ? error.message : "Try a clearer, closer photo or enter the transaction manually.",
      );
    } finally {
      setWorking(false);
    }
  };

  /**
   * Retrying a bad read is the common case, so a fresh scanner session
   * replaces what was captured. ML Kit already captures multiple pages in one
   * session, so silently appending each session's pages was what produced
   * duplicated cart items whenever the user re-scanned.
   */
  const confirmScanIntent = async (): Promise<"replace" | "add" | "cancel"> => {
    if (!sections.length) return "replace";
    return new Promise((resolve) => {
      Alert.alert(
        "Scan again",
        `You already captured ${sections.length === 1 ? "1 page" : `${sections.length} pages`}. Replace them with this new scan, or add more pages to the same receipt?`,
        [
          { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
          { text: "Add pages", onPress: () => resolve("add") },
          { text: "Replace", style: "destructive", onPress: () => resolve("replace") },
        ],
        { cancelable: true, onDismiss: () => resolve("cancel") },
      );
    });
  };

  const scanReceipt = async () => {
    if (working) return;
    const intent = await confirmScanIntent();
    if (intent === "cancel") return;
    if (intent === "replace") {
      if (activeDraftId.current) {
        removeReceiptDraft(activeDraftId.current);
        activeDraftId.current = null;
      }
      setSections([]);
      setPreviewUri(null);
    }
    setCameraOpen(false);
    setWorking(true);
    setStatus("Opening Google's on-device document scanner…");
    try {
      const outcome = await launchReceiptDocumentScanner({ pageLimit: 5 });

      if (outcome.status === "unsupported") {
        // Genuinely impossible on this build/device, so stop offering it.
        setDocScannerAvailable(false);
        setStatus("The document scanner is unavailable on this device — use the manual camera.");
        return;
      }
      if (outcome.status === "failed") {
        // Play services delivers the scanner on demand and can fail once while
        // it downloads. Keep the scanner button so the user can simply retry
        // instead of being pushed into the manual camera.
        setStatus("The scanner did not open. Tap Scan receipt to try again.");
        Alert.alert(
          "Scanner did not open",
          `${outcome.reason}\n\nThis is usually temporary while Google Play services finishes preparing the scanner. Try again, or use the manual camera.`,
        );
        return;
      }
      if (outcome.status === "cancelled") {
        setStatus(sections.length
          ? "Scan cancelled. Review the captured pages or scan again."
          : "Scan cancelled");
        return;
      }

      setWorking(false);
      for (const uri of outcome.pages) {
        await processSection(uri);
      }
    } catch (error) {
      setStatus("Could not scan the receipt");
      Alert.alert("Could not scan", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setWorking(false);
    }
  };

  const capture = async () => {
    if (!cameraRef.current || !cameraReady || working) return;
    try {
      setWorking(true);
      setStatus("Capturing section…");
      const photo = await cameraRef.current.takePictureAsync({ quality: 1, exif: false });
      if (!photo?.uri) throw new Error("The camera did not return a photo.");
      setCameraOpen(false);
      await processSection(photo.uri);
    } catch (error) {
      setStatus("Ready to scan");
      Alert.alert("Could not take photo", error instanceof Error ? error.message : "Please try again.");
      setWorking(false);
    }
  };

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 0.9 });
    if (!result.canceled && result.assets[0]?.uri) {
      setCameraOpen(false);
      await processSection(result.assets[0].uri);
    }
  };

  const removeSection = (index: number) => {
    setSections((current) => {
      const next = current.filter((_, sectionIndex) => sectionIndex !== index);
      setPreviewUri(next.at(-1)?.uri ?? null);
      setStatus(next.length
        ? "Section removed. Add the next section or review the receipt."
        : "Position the top of the receipt inside the frame");
      return next;
    });
  };

  const reviewReceipt = async () => {
    if (!sections.length) return;
    // A draft abandoned via review's back button must not linger once the
    // user re-reviews; replace it so only one draft exists per scan flow.
    if (activeDraftId.current) removeReceiptDraft(activeDraftId.current);
    const draft = createReceiptDraft(sections.map((section) => section.uri));
    activeDraftId.current = draft.id;
    const ocrText = mergeReceiptSections(sections.map((section) => section.text));
    // ML Kit's plain text can flatten left/right receipt columns into an
    // incorrect reading order. Keep its visual rows, grouped per captured
    // section so the overlap between adjacent photos is merged, not doubled.
    const extraction = parseReceiptText(ocrText, sections.map((section) => section.lines));
    updateReceiptDraft(draft.id, {
      status: "ready",
      ocrText,
      extraction,
      extractionSource: "local_ocr",
    });
    try {
      await saveLatestReceiptOcrDiagnostic({
        draftId: draft.id,
        mergedText: ocrText,
        sections,
        extraction,
      });
    } catch (error) {
      console.warn("Could not save the local OCR diagnostic", error);
    }
    router.push({ pathname: "/receipt-review" as never, params: { draftId: draft.id } });
  };

  const startOver = () => {
    if (activeDraftId.current) {
      removeReceiptDraft(activeDraftId.current);
      activeDraftId.current = null;
    }
    setSections([]);
    setPreviewUri(null);
    setStatus("Position the top of the receipt inside the frame");
    void openCamera();
  };

  const permissionBlocked = permission && !permission.granted;
  const openSettings = () => void Linking.openSettings();
  const sectionLabel = sections.length === 1 ? "1 section" : `${sections.length} sections`;

  return (
    <ScreenContainer>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View>
          <Text style={[styles.eyebrow, { color: colors.primary }]}>RECEIPT CAPTURE</Text>
          <Text style={[styles.title, { color: colors.text }]}>Scan receipt</Text>
          <Text style={[styles.subtitle, { color: colors.muted }]}>Scanning auto-crops, straightens, and cleans the receipt before on-device text recognition. For a long receipt, capture sections top to bottom with a slight overlap.</Text>
        </View>
        <View style={[styles.cameraCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {cameraOpen ? (
            <CameraView
              ref={cameraRef}
              style={styles.camera}
              facing="back"
              autofocus="on"
              onCameraReady={() => {
                setCameraReady(true);
                setStatus(sections.length
                  ? "Keep the phone parallel and capture the next overlapping section"
                  : "Keep the phone parallel, fill the frame, and hold steady");
              }}
            />
          ) : previewUri ? <Image source={{ uri: previewUri }} style={styles.camera} contentFit="cover" /> : (
            <View style={[styles.camera, styles.emptyCamera, { backgroundColor: colors.background }]}>
              <MaterialIcons name="document-scanner" size={50} color={colors.primary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>Ready to scan</Text>
              <Text style={[styles.emptyBody, { color: colors.muted }]}>Take clear, close sections instead of one distant photo.</Text>
            </View>
          )}
          {cameraOpen && (
            <View pointerEvents="none" style={styles.frame}>
              <View style={styles.frameShade} />
              <View style={[styles.frameBox, { borderColor: "#FFFFFF" }]} />
              <Text style={styles.frameHint}>PARALLEL • CLOSE • NO GLARE</Text>
            </View>
          )}
        </View>
        <View style={[styles.status, { backgroundColor: `${colors.primary}12` }]}>
          {working ? <ActivityIndicator size="small" color={colors.primary} /> : <MaterialIcons name={permissionBlocked ? "no-photography" : "auto-awesome"} size={19} color={colors.primary} />}
          <View style={styles.statusCopy}>
            <Text style={[styles.statusText, { color: colors.text }]}>{status}</Text>
            {!!sections.length && <Text style={[styles.sectionCount, { color: colors.muted }]}>{sectionLabel} recognized locally</Text>}
          </View>
        </View>
        {docScannerAvailable && !cameraOpen && (
          <Pressable disabled={working} onPress={() => void scanReceipt()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, (pressed || working) && styles.pressed]}>
            <MaterialIcons name="document-scanner" size={22} color="#FFFFFF" /><Text style={styles.primaryText}>{sections.length ? "Scan again" : "Scan receipt"}</Text>
          </Pressable>
        )}
        {cameraOpen ? (
          <Pressable disabled={working || !cameraReady} onPress={capture} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, (pressed || working || !cameraReady) && styles.pressed]}>
            <MaterialIcons name="photo-camera" size={22} color="#FFFFFF" /><Text style={styles.primaryText}>Capture section</Text>
          </Pressable>
        ) : permissionBlocked ? (
          docScannerAvailable ? (
            <Pressable onPress={permission.canAskAgain ? () => void openCamera() : openSettings} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, backgroundColor: colors.surface }, pressed && styles.pressed]}>
              <MaterialIcons name="photo-camera" size={21} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.text }]}>{permission.canAskAgain ? "Use manual camera" : "Allow camera in Android settings"}</Text>
            </Pressable>
          ) : (
            <Pressable onPress={permission.canAskAgain ? () => void openCamera() : openSettings} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
              <MaterialIcons name="settings" size={21} color="#FFFFFF" /><Text style={styles.primaryText}>{permission.canAskAgain ? "Allow camera access" : "Open Android settings"}</Text>
            </Pressable>
          )
        ) : docScannerAvailable ? (
          <Pressable disabled={working} onPress={() => void openCamera()} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, backgroundColor: colors.surface }, (pressed || working) && styles.pressed]}>
            <MaterialIcons name="photo-camera" size={21} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.text }]}>Use manual camera</Text>
          </Pressable>
        ) : (
          <Pressable disabled={working} onPress={() => void openCamera()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, (pressed || working) && styles.pressed]}>
            <MaterialIcons name="add-a-photo" size={22} color="#FFFFFF" /><Text style={styles.primaryText}>{sections.length ? "Add next section" : "Open scanner"}</Text>
          </Pressable>
        )}
        <Pressable disabled={working} onPress={() => void pickImage()} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, backgroundColor: colors.surface }, (pressed || working) && styles.pressed]}>
          <MaterialIcons name="photo-library" size={21} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.text }]}>{sections.length ? "Add section from gallery" : "Choose from gallery"}</Text>
        </Pressable>
        {!!sections.length && (
          <View style={[styles.sectionList, { borderColor: colors.border, backgroundColor: colors.surface }]}>
            {sections.map((section, index) => (
              <View key={`${section.uri}-${index}`} style={styles.sectionThumbWrap}>
                <Image source={{ uri: section.uri }} style={[styles.sectionThumb, { borderColor: colors.border }]} contentFit="cover" />
                <Text style={[styles.sectionThumbLabel, { color: colors.muted }]}>{index + 1}</Text>
                <Pressable
                  disabled={working}
                  onPress={() => removeSection(index)}
                  hitSlop={8}
                  accessibilityLabel={`Remove section ${index + 1}`}
                  accessibilityHint="Removes this captured receipt section so you can retake it"
                  style={[styles.sectionRemove, { backgroundColor: colors.background, borderColor: colors.border }]}
                >
                  <MaterialIcons name="close" size={14} color={colors.text} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        {!!sections.length && (
          <View style={styles.receiptActions}>
            <Pressable disabled={working} onPress={() => void reviewReceipt()} style={({ pressed }) => [styles.reviewButton, { backgroundColor: colors.surface, borderColor: colors.primary }, (pressed || working) && styles.pressed]}>
              <MaterialIcons name="fact-check" size={21} color={colors.primary} /><Text style={[styles.reviewText, { color: colors.primary }]}>Review {sectionLabel}</Text>
            </Pressable>
            <Pressable disabled={working} onPress={startOver} hitSlop={8} style={styles.restartButton}>
              <Text style={[styles.restartText, { color: colors.muted }]}>Start over</Text>
            </Pressable>
          </View>
        )}
        <View style={[styles.tip, { borderColor: colors.border }]}>
          <MaterialIcons name="privacy-tip" size={20} color={colors.primary} />
          <Text style={[styles.tipText, { color: colors.muted }]}>Text recognition and section merging run on this device. Review every value and every detected shopping item before saving.</Text>
        </View>
      </ScrollView>
    </ScreenContainer>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 12, paddingBottom: 32, gap: 14 },
  eyebrow: { fontSize: 11, lineHeight: 15, fontWeight: "800", letterSpacing: 1.5 },
  title: { fontSize: 34, lineHeight: 40, fontWeight: "800", letterSpacing: -0.8 },
  subtitle: { marginTop: 4, fontSize: 13, lineHeight: 19 },
  cameraCard: { height: 330, borderWidth: 1, borderRadius: 22, overflow: "hidden" }, camera: { flex: 1 },
  emptyCamera: { alignItems: "center", justifyContent: "center", padding: 32, gap: 8 }, emptyTitle: { fontSize: 18, lineHeight: 24, fontWeight: "800" }, emptyBody: { fontSize: 13, lineHeight: 19, textAlign: "center", maxWidth: 250 },
  frame: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" }, frameShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "#00000022" }, frameBox: { width: "82%", height: "70%", borderWidth: 2, borderRadius: 16 }, frameHint: { position: "absolute", bottom: 14, color: "#FFFFFF", fontSize: 10, lineHeight: 14, fontWeight: "900", letterSpacing: 1.1, textShadowColor: "#000000AA", textShadowRadius: 4 },
  status: { minHeight: 56, borderRadius: 14, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 9 }, statusCopy: { flex: 1, gap: 1 }, statusText: { fontSize: 13, lineHeight: 18, fontWeight: "600" }, sectionCount: { fontSize: 11, lineHeight: 15 },
  primary: { minHeight: 54, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 9 }, primaryText: { color: "#FFFFFF", fontSize: 16, lineHeight: 21, fontWeight: "800" },
  secondary: { minHeight: 52, borderWidth: 1, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, secondaryText: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  sectionList: { borderWidth: 1, borderRadius: 14, padding: 10, flexDirection: "row", flexWrap: "wrap", gap: 10 }, sectionThumbWrap: { width: 56 }, sectionThumb: { width: 56, height: 74, borderWidth: 1, borderRadius: 9 }, sectionThumbLabel: { marginTop: 2, fontSize: 10, lineHeight: 14, fontWeight: "800", textAlign: "center" }, sectionRemove: { position: "absolute", top: -7, right: -7, width: 24, height: 24, borderRadius: 12, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  receiptActions: { alignItems: "center", gap: 8 }, reviewButton: { width: "100%", minHeight: 52, borderWidth: 1, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, reviewText: { fontSize: 15, lineHeight: 20, fontWeight: "800" }, restartButton: { minHeight: 32, justifyContent: "center", paddingHorizontal: 14 }, restartText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  tip: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4, paddingTop: 15, flexDirection: "row", gap: 9 }, tipText: { flex: 1, fontSize: 12, lineHeight: 17 }, pressed: { opacity: 0.7 },
});
