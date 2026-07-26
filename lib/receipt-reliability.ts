import type { ReceiptExtraction, ReceiptEvidenceKind } from "@/lib/receipt-parser";
import type { ExtractionSource, ReceiptLineItem } from "@/lib/types";

export type FieldTrust = "verified" | "unverified" | "missing" | "conflict";
export type ReceiptReviewOutcome = "complete" | "essentials_only" | "manual_assistance";
export type CartTrust = "verified" | "unverified" | "empty";
export type CartReason = "reconciled" | "count_mismatch" | "sum_mismatch" | "duplicate_risk" | "not_found";

export interface AssessedField<T> {
  /** Private assessment value. The review projection removes it unless verified. */
  value: T | null;
  trust: FieldTrust;
  evidence: ReceiptEvidenceKind[];
}

export interface ReceiptReliability {
  outcome: ReceiptReviewOutcome;
  amount: AssessedField<number>;
  date: AssessedField<string>;
  merchant: AssessedField<string>;
  cart: {
    trust: CartTrust;
    reason: CartReason;
    verifiedItems: ReceiptLineItem[];
  };
  reasons: string[];
}

/** The only OCR-derived object the normal receipt-review screen may consume. */
export interface ReceiptReviewModel {
  outcome: ReceiptReviewOutcome;
  amountMinor: number | null;
  date: string | null;
  merchant: string | null;
  preTaxMinor: number | null;
  taxMinor: number | null;
  categoryId: null;
  description: string;
  lineItems: ReceiptLineItem[];
  /** Safe verdict explanations only; never raw alternatives or rejected rows. */
  reasons: string[];
}

const VERIFIED_AMOUNT_EVIDENCE = new Set<ReceiptEvidenceKind>([
  "strong_label",
  "cart_reconciliation",
]);

function assessAmount(extraction: ReceiptExtraction): AssessedField<number> {
  if (extraction.amountMinor === null) {
    return { value: null, trust: "missing", evidence: [extraction.evidence.amount] };
  }
  return {
    value: extraction.amountMinor,
    trust: VERIFIED_AMOUNT_EVIDENCE.has(extraction.evidence.amount) ? "verified" : "unverified",
    evidence: [extraction.evidence.amount],
  };
}

function assessDate(extraction: ReceiptExtraction): AssessedField<string> {
  if (extraction.evidence.date === "conflicting_date") {
    return { value: null, trust: "conflict", evidence: [extraction.evidence.date] };
  }
  if (!extraction.date || extraction.evidence.date === "missing") {
    return { value: null, trust: "missing", evidence: [extraction.evidence.date] };
  }
  return {
    value: extraction.date,
    trust: extraction.evidence.date === "literal_date" ? "verified" : "unverified",
    evidence: [extraction.evidence.date],
  };
}

function assessMerchant(extraction: ReceiptExtraction): AssessedField<string> {
  if (extraction.evidence.merchant === "conflicting_merchant") {
    return { value: null, trust: "conflict", evidence: [extraction.evidence.merchant] };
  }
  if (!extraction.merchant || extraction.evidence.merchant === "missing") {
    return { value: null, trust: "missing", evidence: [extraction.evidence.merchant] };
  }
  return {
    value: extraction.merchant,
    trust: extraction.evidence.merchant === "known_merchant" ? "verified" : "unverified",
    evidence: [extraction.evidence.merchant],
  };
}

function assessCart(extraction: ReceiptExtraction, verifiedAmountMinor: number | null): ReceiptReliability["cart"] {
  if (!extraction.lineItems.length) {
    return { trust: "empty", reason: "not_found", verifiedItems: [] };
  }
  if (verifiedAmountMinor === null || extraction.lineItems.some((item) => !item.lineTotalMinor || item.lineTotalMinor <= 0)) {
    return { trust: "unverified", reason: "sum_mismatch", verifiedItems: [] };
  }
  if (
    extraction.declaredItemCount !== null &&
    extraction.declaredItemCount !== undefined &&
    extraction.declaredItemCount !== extraction.lineItems.length
  ) {
    return { trust: "unverified", reason: "count_mismatch", verifiedItems: [] };
  }
  if (extraction.cartDuplicateRisk) {
    return { trust: "unverified", reason: "duplicate_risk", verifiedItems: [] };
  }
  const cartTotalMinor = extraction.lineItems.reduce(
    (total, item) => total + (item.lineTotalMinor ?? 0),
    0,
  );
  if (Math.abs(cartTotalMinor - verifiedAmountMinor) > 1) {
    return { trust: "unverified", reason: "sum_mismatch", verifiedItems: [] };
  }
  return { trust: "verified", reason: "reconciled", verifiedItems: extraction.lineItems };
}

function reasonForCart(reason: CartReason): string {
  switch (reason) {
    case "count_mismatch":
      return "The detected item count did not match the receipt, so the basket was left empty.";
    case "duplicate_risk":
      return "Some item rows may have been read more than once, so the basket was left empty.";
    case "sum_mismatch":
      return "The detected items did not match the receipt total, so the basket was left empty.";
    case "not_found":
      return "No reliable item list was found, so the basket was left empty.";
    case "reconciled":
      return "The detected items match the verified receipt total.";
  }
}

/** Pure, deterministic, source-independent trust assessment. */
export function assessReceiptReliability(extraction: ReceiptExtraction): ReceiptReliability {
  const amount = assessAmount(extraction);
  const date = assessDate(extraction);
  const merchant = assessMerchant(extraction);
  const verifiedAmountMinor = amount.trust === "verified" ? amount.value : null;
  const cart = assessCart(extraction, verifiedAmountMinor);
  const essentialsVerified = [amount, date, merchant].every((field) => field.trust === "verified");
  const outcome: ReceiptReviewOutcome = !essentialsVerified
    ? "manual_assistance"
    : cart.trust === "verified"
      ? "complete"
      : "essentials_only";

  const reasons: string[] = [];
  if (amount.trust !== "verified") reasons.push("The receipt total could not be verified, so it was left blank.");
  if (date.trust === "conflict") reasons.push("The receipt contained conflicting dates, so the date was left blank.");
  else if (date.trust !== "verified") reasons.push("The receipt date could not be verified, so it was left blank.");
  if (merchant.trust === "conflict") reasons.push("The receipt contained conflicting merchants, so the merchant was left blank.");
  else if (merchant.trust !== "verified") reasons.push("The merchant could not be verified, so it was left blank.");
  if (outcome !== "manual_assistance" || cart.trust !== "verified") reasons.push(reasonForCart(cart.reason));

  return { outcome, amount, date, merchant, cart, reasons };
}

/**
 * One-way projection. Rejected values, alternatives, heuristic category/address/
 * description, and rejected cart rows are structurally absent from the result.
 */
export function createReceiptReviewModel(
  extraction: ReceiptExtraction,
  source: Exclude<ExtractionSource, "manual">,
): ReceiptReviewModel {
  const reliability = assessReceiptReliability(extraction);
  // Cloud retry is deliberately disabled for this reset. A generative source
  // cannot self-assert trusted evidence and populate the ledger. If re-enabled,
  // it must provide independently checkable spans that this assessor validates.
  if (source === "cloud_llm") {
    return {
      outcome: "manual_assistance",
      amountMinor: null,
      date: null,
      merchant: null,
      preTaxMinor: null,
      taxMinor: null,
      categoryId: null,
      description: "",
      lineItems: [],
      reasons: ["Cloud receipt extraction is disabled; enter the receipt details manually."],
    };
  }
  const amountMinor = reliability.amount.trust === "verified" ? reliability.amount.value : null;
  const date = reliability.date.trust === "verified" ? reliability.date.value : null;
  const merchant = reliability.merchant.trust === "verified" ? reliability.merchant.value : null;
  const vatReconciles =
    amountMinor !== null &&
    extraction.preTaxMinor !== null &&
    extraction.preTaxMinor !== undefined &&
    extraction.taxMinor !== null &&
    extraction.taxMinor !== undefined &&
    extraction.preTaxMinor > 0 &&
    extraction.taxMinor > 0 &&
    Math.abs(extraction.preTaxMinor + extraction.taxMinor - amountMinor) <= 1;

  return {
    outcome: reliability.outcome,
    amountMinor,
    date,
    merchant,
    preTaxMinor: vatReconciles ? extraction.preTaxMinor! : null,
    taxMinor: vatReconciles ? extraction.taxMinor! : null,
    categoryId: null,
    description: merchant ? `Receipt from ${merchant}` : "",
    lineItems: reliability.outcome === "complete" ? reliability.cart.verifiedItems : [],
    reasons: reliability.reasons,
  };
}
