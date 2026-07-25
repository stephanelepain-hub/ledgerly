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
 * Launches Google's on-device ML Kit document scanner: edge detection,
 * automatic cropping, perspective correction and shadow/contrast cleanup
 * before OCR. Everything runs locally in Google Play services; receipt images
 * are never uploaded.
 *
 * Availability is decided by capability, never by matching words in an error
 * message. Expo wraps a native rejection as "Call to function
 * 'RNMLKitDocumentScanner.launchDocumentScannerAsync' has been rejected", so
 * the module's own name appears in *every* failure it raises. Pattern matching
 * on that name treated ordinary, retryable errors as a missing module and
 * permanently disabled the scanner mid-session, pushing the user into the
 * manual camera.
 *
 * Only two things mean genuinely unsupported: the module cannot be imported,
 * or it does not expose the entry point. Anything thrown by the call itself is
 * treated as retryable.
 */
export async function launchReceiptDocumentScanner(
  options?: ReceiptDocumentScanOptions,
): Promise<ReceiptScanOutcome> {
  if (Platform.OS !== "android") {
    return { status: "unsupported", reason: "The document scanner is Android only." };
  }

  let scannerModule: typeof import("@infinitered/react-native-mlkit-document-scanner");
  try {
    scannerModule = await import("@infinitered/react-native-mlkit-document-scanner");
  } catch (error) {
    return {
      status: "unsupported",
      reason: `The document scanner module is not part of this build (${
        error instanceof Error ? error.message : String(error)
      }).`,
    };
  }

  const { launchDocumentScannerAsync, ScannerModeOptions, ResultFormatOptions } = scannerModule;
  if (typeof launchDocumentScannerAsync !== "function") {
    return {
      status: "unsupported",
      reason: "The document scanner module did not load its native entry point.",
    };
  }

  try {
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
    const reason = error instanceof Error ? error.message : String(error);
    // Backing out of the scanner surfaces as a cancellation exception on some
    // Play services versions. That is not an error worth reporting.
    if (/cancel/i.test(reason)) return { status: "cancelled" };
    return { status: "failed", reason };
  }
}
