import { Platform } from "react-native";

export interface ReceiptDocumentScanOptions {
  /** Maximum number of receipt sections/pages captured in one scanner session. */
  pageLimit?: number;
}

/**
 * Launches Google's on-device ML Kit document scanner: edge detection,
 * automatic cropping, perspective/skew correction, and shadow/contrast
 * cleanup before OCR. Everything runs locally in Google Play services on the
 * device; receipt images are never uploaded. Play services may download the
 * scanner component itself on first use, which contains no user data.
 *
 * Returns the cleaned page image URIs, an empty array when the user cancels,
 * or `null` when the scanner is unavailable (non-Android platform, missing
 * native module, or a device without Google Play services).
 */
export async function launchReceiptDocumentScanner(
  options?: ReceiptDocumentScanOptions,
): Promise<string[] | null> {
  if (Platform.OS !== "android") return null;

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
    if (result.canceled) return [];
    return result.pages ?? [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      /native module|cannot find|not found|requireNativeModule|RNMLKitDocumentScanner|play services|unavailable|not supported/i.test(
        message,
      )
    ) {
      return null;
    }
    throw error;
  }
}
