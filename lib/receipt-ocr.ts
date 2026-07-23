import { Platform } from "react-native";

export class ReceiptOcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptOcrUnavailableError";
  }
}

export interface ReceiptOcrResult {
  text: string;
  blockCount: number;
}

export function canAttemptOnDeviceOcr(): boolean {
  return Platform.OS === "android" || Platform.OS === "ios";
}

export async function recognizeReceiptText(imageUri: string): Promise<ReceiptOcrResult> {
  if (!canAttemptOnDeviceOcr()) {
    throw new ReceiptOcrUnavailableError(
      "On-device receipt text recognition is available in the installed Android development build, not the browser preview.",
    );
  }

  try {
    const { recognizeText } = await import(
      "@infinitered/react-native-mlkit-text-recognition"
    );
    const result = await recognizeText(imageUri);
    const text = result.text?.trim() ?? "";
    if (!text) {
      throw new Error(
        "No readable text was detected. Try brighter, even lighting and keep the whole receipt in frame.",
      );
    }
    return { text, blockCount: result.blocks?.length ?? 0 };
  } catch (error) {
    if (error instanceof ReceiptOcrUnavailableError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (
      /native module|cannot find|not found|requireNativeModule|RNMLKitTextRecognition/i.test(
        message,
      )
    ) {
      throw new ReceiptOcrUnavailableError(
        "On-device OCR needs Ledgerly's custom Android development build. Expo Go and the browser preview do not include the ML Kit native module.",
      );
    }
    throw error;
  }
}
