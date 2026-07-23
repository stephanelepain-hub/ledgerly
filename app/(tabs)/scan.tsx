import MaterialIcons from "@expo/vector-icons/MaterialIcons";
import { CameraView, useCameraPermissions } from "expo-camera";
import { Image } from "expo-image";
import * as ImagePicker from "expo-image-picker";
import { router } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Linking, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { ScreenContainer } from "@/components/screen-container";
import { useColors } from "@/hooks/use-colors";
import { createReceiptDraft, updateReceiptDraft } from "@/lib/receipt-draft-store";
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
  const [permission, requestPermission] = useCameraPermissions();
  const [cameraOpen, setCameraOpen] = useState(false);
  const [working, setWorking] = useState(false);
  const [previewUri, setPreviewUri] = useState<string | null>(null);
  const [sections, setSections] = useState<ReceiptSection[]>([]);
  const [status, setStatus] = useState("Preparing scanner…");

  const openCamera = useCallback(async () => {
    const result = permission?.granted ? permission : await requestPermission();
    if (!result.granted) {
      setStatus("Camera access is needed to scan a receipt");
      setCameraOpen(false);
      return;
    }
    setStatus(sections.length ? "Capture the next section with a little overlap" : "Position the top of the receipt inside the frame");
    setCameraOpen(true);
  }, [permission, requestPermission, sections.length]);

  useEffect(() => {
    if (openedOnce.current) return;
    openedOnce.current = true;
    void openCamera();
  }, [openCamera]);

  const processSection = async (uri: string) => {
    setPreviewUri(uri);
    setWorking(true);
    setStatus("Reading this section on your device…");
    try {
      const result = await recognizeReceiptText(uri);
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

  const capture = async () => {
    if (!cameraRef.current || working) return;
    try {
      setWorking(true);
      setStatus("Capturing section…");
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.9, exif: false });
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

  const reviewReceipt = () => {
    if (!sections.length) return;
    const draft = createReceiptDraft(sections.map((section) => section.uri));
    const ocrText = mergeReceiptSections(sections.map((section) => section.text));
    // ML Kit's plain text can flatten left/right receipt columns into an
    // incorrect reading order. Keep its visual rows for product matching.
    const extraction = parseReceiptText(ocrText, sections.flatMap((section) => section.lines));
    updateReceiptDraft(draft.id, {
      status: "ready",
      ocrText,
      extraction,
      extractionSource: "local_ocr",
    });
    router.push({ pathname: "/receipt-review" as never, params: { draftId: draft.id } });
  };

  const startOver = () => {
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
          <Text style={[styles.subtitle, { color: colors.muted }]}>For a long receipt, take close-up sections from top to bottom and overlap each one slightly.</Text>
        </View>
        <View style={[styles.cameraCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          {cameraOpen ? (
            <CameraView ref={cameraRef} style={styles.camera} facing="back" />
          ) : previewUri ? <Image source={{ uri: previewUri }} style={styles.camera} contentFit="cover" /> : (
            <View style={[styles.camera, styles.emptyCamera, { backgroundColor: colors.background }]}>
              <MaterialIcons name="document-scanner" size={50} color={colors.primary} />
              <Text style={[styles.emptyTitle, { color: colors.text }]}>Ready to scan</Text>
              <Text style={[styles.emptyBody, { color: colors.muted }]}>Take clear, close sections instead of one distant photo.</Text>
            </View>
          )}
          {cameraOpen && <View pointerEvents="none" style={styles.frame}><View style={styles.frameShade} /><View style={[styles.frameBox, { borderColor: "#FFFFFF" }]} /></View>}
        </View>
        <View style={[styles.status, { backgroundColor: `${colors.primary}12` }]}>
          {working ? <ActivityIndicator size="small" color={colors.primary} /> : <MaterialIcons name={permissionBlocked ? "no-photography" : "auto-awesome"} size={19} color={colors.primary} />}
          <View style={styles.statusCopy}>
            <Text style={[styles.statusText, { color: colors.text }]}>{status}</Text>
            {!!sections.length && <Text style={[styles.sectionCount, { color: colors.muted }]}>{sectionLabel} recognized locally</Text>}
          </View>
        </View>
        {permissionBlocked ? (
          <Pressable onPress={permission.canAskAgain ? () => void openCamera() : openSettings} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, pressed && styles.pressed]}>
            <MaterialIcons name="settings" size={21} color="#FFFFFF" /><Text style={styles.primaryText}>{permission.canAskAgain ? "Allow camera access" : "Open Android settings"}</Text>
          </Pressable>
        ) : (
          <Pressable disabled={working} onPress={cameraOpen ? capture : () => void openCamera()} style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary }, (pressed || working) && styles.pressed]}>
            <MaterialIcons name={cameraOpen ? "photo-camera" : "add-a-photo"} size={22} color="#FFFFFF" /><Text style={styles.primaryText}>{cameraOpen ? "Capture section" : sections.length ? "Add next section" : "Open scanner"}</Text>
          </Pressable>
        )}
        <Pressable disabled={working} onPress={() => void pickImage()} style={({ pressed }) => [styles.secondary, { borderColor: colors.border, backgroundColor: colors.surface }, (pressed || working) && styles.pressed]}>
          <MaterialIcons name="photo-library" size={21} color={colors.primary} /><Text style={[styles.secondaryText, { color: colors.text }]}>{sections.length ? "Add section from gallery" : "Choose from gallery"}</Text>
        </Pressable>
        {!!sections.length && (
          <View style={styles.receiptActions}>
            <Pressable disabled={working} onPress={reviewReceipt} style={({ pressed }) => [styles.reviewButton, { backgroundColor: colors.surface, borderColor: colors.primary }, (pressed || working) && styles.pressed]}>
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
  frame: { ...StyleSheet.absoluteFillObject, alignItems: "center", justifyContent: "center" }, frameShade: { ...StyleSheet.absoluteFillObject, backgroundColor: "#00000022" }, frameBox: { width: "82%", height: "70%", borderWidth: 2, borderRadius: 16 },
  status: { minHeight: 56, borderRadius: 14, paddingHorizontal: 14, flexDirection: "row", alignItems: "center", gap: 9 }, statusCopy: { flex: 1, gap: 1 }, statusText: { fontSize: 13, lineHeight: 18, fontWeight: "600" }, sectionCount: { fontSize: 11, lineHeight: 15 },
  primary: { minHeight: 54, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 9 }, primaryText: { color: "#FFFFFF", fontSize: 16, lineHeight: 21, fontWeight: "800" },
  secondary: { minHeight: 52, borderWidth: 1, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, secondaryText: { fontSize: 15, lineHeight: 20, fontWeight: "700" },
  receiptActions: { alignItems: "center", gap: 8 }, reviewButton: { width: "100%", minHeight: 52, borderWidth: 1, borderRadius: 16, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 }, reviewText: { fontSize: 15, lineHeight: 20, fontWeight: "800" }, restartButton: { minHeight: 32, justifyContent: "center", paddingHorizontal: 14 }, restartText: { fontSize: 13, lineHeight: 18, fontWeight: "700" },
  tip: { borderTopWidth: StyleSheet.hairlineWidth, marginTop: 4, paddingTop: 15, flexDirection: "row", gap: 9 }, tipText: { flex: 1, fontSize: 12, lineHeight: 17 }, pressed: { opacity: 0.7 },
});
