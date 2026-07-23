import { createId } from "@/lib/types";
import type { ReceiptExtraction } from "@/lib/receipt-parser";

export type ReceiptDraftStatus = "selected" | "processing" | "ready" | "error";

export interface ReceiptDraft {
  id: string;
  /** The first image remains the preview/legacy attachment; every section stays in memory until confirmation. */
  imageUri: string;
  imageUris: string[];
  ocrText: string;
  extraction: ReceiptExtraction | null;
  status: ReceiptDraftStatus;
  error: string | null;
  extractionSource: "local_ocr" | "cloud_llm";
  createdAt: string;
}

const receiptDrafts = new Map<string, ReceiptDraft>();

export function createReceiptDraft(imageUris: string[]): ReceiptDraft {
  if (!imageUris.length) throw new Error("Add at least one receipt section before reviewing it.");
  const draft: ReceiptDraft = {
    id: createId("receipt"),
    imageUri: imageUris[0],
    imageUris: [...imageUris],
    ocrText: "",
    extraction: null,
    status: "selected",
    error: null,
    extractionSource: "local_ocr",
    createdAt: new Date().toISOString(),
  };
  receiptDrafts.set(draft.id, draft);
  return draft;
}

export function getReceiptDraft(id: string): ReceiptDraft | null {
  return receiptDrafts.get(id) ?? null;
}

export function updateReceiptDraft(
  id: string,
  update: Partial<Omit<ReceiptDraft, "id" | "createdAt">>,
): ReceiptDraft | null {
  const existing = receiptDrafts.get(id);
  if (!existing) return null;
  const next = { ...existing, ...update };
  receiptDrafts.set(id, next);
  return next;
}

export function removeReceiptDraft(id: string): void {
  receiptDrafts.delete(id);
}
