import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import type { ReceiptOcrLine } from "@/lib/receipt-ocr";
import { rebuildReceiptVisualRows, type ReceiptExtraction } from "@/lib/receipt-parser";

export const OCR_DIAGNOSTIC_FILENAME = "ledgerly-ocr-diagnostic.json";

interface OcrDiagnosticSection {
  text: string;
  lines: ReceiptOcrLine[];
}

function diagnosticFileUri(): string {
  if (!FileSystem.documentDirectory) throw new Error("App document storage is unavailable.");
  return `${FileSystem.documentDirectory}${OCR_DIAGNOSTIC_FILENAME}`;
}

/** True when a diagnostic from a previous scan is available to share. */
export async function hasLatestReceiptOcrDiagnostic(): Promise<boolean> {
  try {
    return (await FileSystem.getInfoAsync(diagnosticFileUri())).exists;
  } catch {
    return false;
  }
}

/**
 * Hands the local text-only diagnostic to the Android share sheet so the user
 * chooses its destination. Release APKs are not debuggable, so `adb run-as`
 * cannot reach the app sandbox; this is the supported retrieval path and it
 * needs no developer tooling. Nothing is uploaded by Ledgerly itself.
 */
export async function shareLatestReceiptOcrDiagnostic(): Promise<void> {
  const source = diagnosticFileUri();
  if (!(await FileSystem.getInfoAsync(source)).exists) {
    throw new Error("No OCR diagnostic has been recorded yet. Scan a receipt, then try again.");
  }
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error("Sharing is not available on this device.");
  }
  if (!FileSystem.cacheDirectory) {
    throw new Error("Ledgerly could not access temporary storage.");
  }
  // Share from the cache directory, matching the CSV/PDF export path.
  const shareable = `${FileSystem.cacheDirectory}${OCR_DIAGNOSTIC_FILENAME}`;
  await FileSystem.deleteAsync(shareable, { idempotent: true });
  await FileSystem.copyAsync({ from: source, to: shareable });
  await Sharing.shareAsync(shareable, {
    mimeType: "application/json",
    dialogTitle: "Share Ledgerly OCR diagnostic (text only)",
  });
}

/**
 * Keeps one local, text-only OCR troubleshooting report. Receipt images are
 * deliberately excluded. Retrieve it with `shareLatestReceiptOcrDiagnostic`;
 * it is never uploaded by Ledgerly.
 */
export async function saveLatestReceiptOcrDiagnostic(input: {
  draftId: string;
  mergedText: string;
  sections: OcrDiagnosticSection[];
  extraction: ReceiptExtraction;
}): Promise<void> {
  if (!FileSystem.documentDirectory) throw new Error("App document storage is unavailable.");
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    draftId: input.draftId,
    privacy: "Local text-only diagnostic; receipt images are not included.",
    mergedText: input.mergedText,
    sections: input.sections.map((section, sectionIndex) => ({
      sectionIndex,
      rawText: section.text,
      visualLines: section.lines,
      reconstructedRows: rebuildReceiptVisualRows(section.lines),
    })),
    extraction: input.extraction,
  };
  await FileSystem.writeAsStringAsync(
    `${FileSystem.documentDirectory}${OCR_DIAGNOSTIC_FILENAME}`,
    JSON.stringify(report, null, 2),
    { encoding: FileSystem.EncodingType.UTF8 },
  );
}
