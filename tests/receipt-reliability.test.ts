import { describe, expect, it } from "vitest";

import { parseReceiptText, type ReceiptExtraction, type ReceiptEvidenceKind } from "../lib/receipt-parser";
import {
  assessReceiptReliability,
  createReceiptReviewModel,
} from "../lib/receipt-reliability";
import {
  buildReceiptSaveFields,
  buildReviewedLineItems,
  createReceiptReviewState,
  receiptReviewReducer,
} from "../lib/receipt-review-state";
import type { ReceiptLineItem } from "../lib/types";

const verifiedItems: ReceiptLineItem[] = [
  { id: "one", name: "Verified item", quantity: 1, unitPriceMinor: 600, lineTotalMinor: 600, confidence: 0.95 },
  { id: "two", name: "Second verified item", quantity: 1, unitPriceMinor: 400, lineTotalMinor: 400, confidence: 0.95 },
];

function extraction(overrides: Partial<ReceiptExtraction> = {}): ReceiptExtraction {
  const evidence = overrides.evidence ?? {
    amount: "strong_label" as ReceiptEvidenceKind,
    date: "literal_date" as ReceiptEvidenceKind,
    merchant: "known_merchant" as ReceiptEvidenceKind,
  };
  const base: ReceiptExtraction = {
    amountMinor: 1_000,
    date: "2026-07-25",
    merchant: "Verified Market",
    description: "OCR guessed private address and description",
    categoryId: "groceries",
    fieldConfidence: { amount: 0.98, date: 0.94, merchant: 0.96, category: 0.9 },
    overallConfidence: 0.95,
    warnings: [],
    evidence,
    merchantAddress: "Rejected private address",
    preTaxMinor: 900,
    taxMinor: 100,
    lineItems: verifiedItems,
    declaredItemCount: 2,
    conflictingDates: [],
  };
  return { ...base, ...overrides, evidence };
}

describe("receipt reliability assessor and verified-only projection", () => {
  it("classifies the three review outcomes deterministically", () => {
    expect(assessReceiptReliability(extraction()).outcome).toBe("complete");
    expect(assessReceiptReliability(extraction({ lineItems: [verifiedItems[0]] })).outcome).toBe("essentials_only");
    expect(assessReceiptReliability(extraction({ date: null, evidence: {
      amount: "strong_label", date: "missing", merchant: "known_merchant",
    } })).outcome).toBe("manual_assistance");
  });

  it("leaves missing and conflicting dates blank instead of substituting today or an alternative", () => {
    const missing = createReceiptReviewModel(extraction({
      date: null,
      conflictingDates: [],
      evidence: { amount: "strong_label", date: "missing", merchant: "known_merchant" },
    }), "local_ocr");
    const conflict = createReceiptReviewModel(extraction({
      date: null,
      conflictingDates: ["2026-01-16", "2026-07-16"],
      evidence: { amount: "strong_label", date: "conflicting_date", merchant: "known_merchant" },
    }), "local_ocr");

    expect(missing.date).toBeNull();
    expect(conflict.date).toBeNull();
    expect(JSON.stringify(conflict)).not.toContain("2026-01-16");
    expect(JSON.stringify(conflict)).not.toContain("2026-07-16");
  });

  it("keeps weak TTC and a header-only merchant private and blank", () => {
    const weak = createReceiptReviewModel(extraction({
      amountMinor: 1_234,
      merchant: "Plausible Header Guess",
      evidence: { amount: "unlabelled_number", date: "literal_date", merchant: "header_guess" },
    }), "local_ocr");

    expect(weak.outcome).toBe("manual_assistance");
    expect(weak.amountMinor).toBeNull();
    expect(weak.merchant).toBeNull();
    expect(JSON.stringify(weak)).not.toContain("1234");
    expect(JSON.stringify(weak)).not.toContain("Plausible Header Guess");
  });

  it.each([
    ["count mismatch", { declaredItemCount: 3 }, "count_mismatch"],
    ["sum mismatch", { amountMinor: 1_100 }, "sum_mismatch"],
    ["duplicate risk", { cartDuplicateRisk: true }, "duplicate_risk"],
  ] as const)("quarantines the entire cart on %s", (_label, overrides, expectedReason) => {
    const raw = extraction(overrides);
    const assessed = assessReceiptReliability(raw);
    const review = createReceiptReviewModel(raw, "local_ocr");

    expect(assessed.cart.reason).toBe(expectedReason);
    expect(assessed.cart.verifiedItems).toEqual([]);
    expect(review.outcome).toBe("essentials_only");
    expect(review.lineItems).toEqual([]);
  });

  it("does not let category, address, heuristic description, or rejected rows cross the projection", () => {
    const raw = extraction({ amountMinor: 1_100 });
    const review = createReceiptReviewModel(raw, "local_ocr");
    const serialized = JSON.stringify(review);

    expect(review.categoryId).toBeNull();
    expect(review.description).toBe("Receipt from Verified Market");
    expect(review.lineItems).toEqual([]);
    expect(serialized).not.toContain(raw.merchantAddress!);
    expect(serialized).not.toContain(raw.description);
    expect(serialized).not.toContain("Verified item");
  });

  it("does not let cloud extraction self-assert trusted evidence", () => {
    const raw = extraction({
      amountMinor: 9_999,
      merchant: "Cloud assertion",
      evidence: { amount: "strong_label", date: "literal_date", merchant: "known_merchant" },
    });
    const cloud = createReceiptReviewModel(raw, "cloud_llm");

    expect(cloud.outcome).toBe("manual_assistance");
    expect(cloud.amountMinor).toBeNull();
    expect(cloud.date).toBeNull();
    expect(cloud.merchant).toBeNull();
    expect(cloud.lineItems).toEqual([]);
  });

  it("does not verify repeated unlabelled numbers without independent spans", () => {
    const raw = parseReceiptText("UNKNOWN HEADER\n12.34\n12.34");
    const review = createReceiptReviewModel(raw, "local_ocr");

    expect(raw.evidence.amount).toBe("unlabelled_number");
    expect(review.amountMinor).toBeNull();
  });

  it("leaves TTC blank when strong totals conflict without reconciliation", () => {
    const raw = parseReceiptText("ALDI\n25/07/2026\nMONTANT DU 19,77\nMONTANT DU 12,08");
    const review = createReceiptReviewModel(raw, "local_ocr");

    expect(raw.evidence.amount).toBe("conflicting_amount");
    expect(review.amountMinor).toBeNull();
    expect(review.outcome).toBe("manual_assistance");
  });

  it("shows VAT only when it reconciles with a verified TTC", () => {
    expect(createReceiptReviewModel(extraction(), "local_ocr")).toMatchObject({
      preTaxMinor: 900,
      taxMinor: 100,
    });
    expect(createReceiptReviewModel(extraction({ taxMinor: 98 }), "local_ocr")).toMatchObject({
      preTaxMinor: null,
      taxMinor: null,
    });
  });

  it("exposes reasons only and never rejected values to UI or accessibility serialization", () => {
    const raw = extraction({
      date: null,
      conflictingDates: ["2026-01-16", "2026-07-16"],
      evidence: { amount: "strong_label", date: "conflicting_date", merchant: "known_merchant" },
    });
    const review = createReceiptReviewModel(raw, "local_ocr");
    const announced = [review.merchant, review.date, review.amountMinor, ...review.reasons].join(" ");

    expect(announced).not.toContain("2026-01-16");
    expect(announced).not.toContain("2026-07-16");
    expect(announced).not.toContain("Verified item");
  });
});

describe("receipt review state", () => {
  it("keeps scan-assisted missing dates blank", () => {
    const model = createReceiptReviewModel(extraction({
      date: null,
      evidence: { amount: "strong_label", date: "missing", merchant: "known_merchant" },
    }), "local_ocr");

    expect(createReceiptReviewState(model).date).toBe("");
  });

  it.each(["complete", "essentials_only", "manual_assistance"] as const)(
    "keeps manual item entry usable in the %s outcome",
    (outcome) => {
      const base = createReceiptReviewModel(extraction(), "local_ocr");
      const state = createReceiptReviewState({ ...base, outcome, lineItems: [] });
      const withItem = receiptReviewReducer(state, { type: "add_item", id: "manual" });
      const named = receiptReviewReducer(withItem, {
        type: "update_item",
        id: "manual",
        update: { name: "User-entered item" },
      });
      const priced = receiptReviewReducer(named, {
        type: "set_item_price",
        id: "manual",
        value: "2.50",
      });

      expect(buildReviewedLineItems(priced)).toEqual([
        expect.objectContaining({ id: "manual", name: "User-entered item", lineTotalMinor: 250 }),
      ]);
    },
  );

  it("cannot reintroduce raw OCR or quarantined rows into the save payload", () => {
    const rejected = extraction({ amountMinor: 1_100 });
    const state = createReceiptReviewState(createReceiptReviewModel(rejected, "local_ocr"));
    const ready = receiptReviewReducer(state, { type: "set_category", value: "other" });
    const save = buildReceiptSaveFields(ready);

    expect(state.lineItems).toEqual([]);
    expect(save.lineItems).toEqual([]);
    expect(save.ocrText).toBeNull();
    expect(JSON.stringify(save)).not.toContain(rejected.description);
    expect(JSON.stringify(save)).not.toContain("Verified item");
  });
});
