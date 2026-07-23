import * as FileSystem from "expo-file-system/legacy";

import type { ReceiptOcrLine } from "@/lib/receipt-ocr";
import { rebuildReceiptVisualRows, type ReceiptExtraction } from "@/lib/receipt-parser";

export const OCR_DIAGNOSTIC_FILENAME = "ledgerly-ocr-diagnostic.json";

interface OcrDiagnosticSection {
  text: string;
  lines: ReceiptOcrLine[];
}

/**
 * Keeps one local, text-only OCR troubleshooting report. Receipt images are
 * deliberately excluded. A debuggable local-test APK lets an attached ADB
 * session read this file from the app sandbox; it is never uploaded.
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
