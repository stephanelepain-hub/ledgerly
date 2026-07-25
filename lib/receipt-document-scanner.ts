import { Platform } from "react-native";

export interface ReceiptDocumentScanOptions {
  /** Maximum number of receipt pages captured in one scanner session. */
  pageLimit?: number;
}

export type ReceiptScanOutcome =
  /** Cleaned, deskewed page images ready for text recognition. */
  | { status: "pages"; pages: string[] }
  /** The user backed out of the scanner. */
  | { status: "cancelled" }
  /** This build or device can never run the scanner. Stop offering it. */
  | { status: "unsupported"; reason: string }
  /** A one-off failure. Keep offering the scanner so the user can retry. */
  | { status: "failed"; reason: string };

/**
 * Google Play services delivers the document scanner module on demand, so the
 * first launch on a device can fail transiently while it downloads. Treating
 * that as permanent used to disable the scanner for the whole session and
 * dumped the user back into the manual camera, roughly every other scan.
 *
 * Only a genuinely missing native module counts as unsupported.
 */
function classifyScannerError(message: string): ReceiptScanOutcome {
  const missingNativeModule =
    /requirenativemodule|native module|rnmlkitdocumentscanner|cannot find native/i.test(message);
  if (missingNativeModule) {
    return {
      status: "unsupported",
      reason: "This build does not include the document scanner module.",
    };
  }
  return { status: "failed", reason: message };
}

/**
 * Launches Google's on-device ML Kit document scanner: edge detection,
 * automatic cropping, perspective correction and shadow/contrast cleanup
 * before OCR. Everything runs locally in Google Play services; receipt images
 * are never uploaded.
 */
export async function launchReceiptDocumentScanner(
  options?: ReceiptDocumentScanOptions,
): Promise<ReceiptScanOutcome> {
  if (Platform.OS !== "android") {
    return { status: "unsupported", reason: "The document scanner is Android only." };
  }

  try {
    const { launchDocumentScannerAsync, ScannerModeOptions, ResultFormatOptions } = await import(
      "@infinitered/react-native-mlkit-document-scanner"
    );
    const result = await launchDocumentScannerAsync({
      pageLimit: options?.pageLimit ?? 5,
      // Gallery import goes through the same crop/deskew/enhance flow and
      // never modifies or deletes the original gallery photo.
      galleryImportAllowed: true,
      scannerMode: ScannerModeOptions.FULL,
      resultFormats: ResultFormatOptions.JPEG,
    });
    if (result.canceled) return { status: "cancelled" };
    const pages = result.pages ?? [];
    if (!pages.length) return { status: "cancelled" };
    return { status: "pages", pages };
  } catch (error) {
    return classifyScannerError(error instanceof Error ? error.message : String(error));
  }
}
