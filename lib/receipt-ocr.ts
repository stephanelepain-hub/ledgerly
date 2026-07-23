import { Platform } from "react-native";

export class ReceiptOcrUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptOcrUnavailableError";
  }
}

export interface ReceiptOcrElement {
  text: string;
  left: number;
}

/** A visual OCR row, retained so receipt columns are not flattened into text order. */
export interface ReceiptOcrLine {
  text: string;
  top: number;
  bottom: number;
  left: number;
  elements: ReceiptOcrElement[];
}

export interface ReceiptOcrResult {
  text: string;
  blockCount: number;
  lines: ReceiptOcrLine[];
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
    const lines = result.blocks.flatMap((block) => block.lines.map((line) => ({
      text: line.text,
      top: line.frame.top,
      bottom: line.frame.bottom,
      left: line.frame.left,
      elements: line.elements.map((element) => ({ text: element.text, left: element.frame.left })),
    }))).sort((a, b) => a.top - b.top || a.left - b.left);
    return { text, blockCount: result.blocks.length, lines };
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
