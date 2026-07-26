import type { ReceiptReviewModel, ReceiptReviewOutcome } from "@/lib/receipt-reliability";
import {
  createId,
  parseAmountToMinor,
  type ReceiptLineItem,
  type TransactionInput,
} from "@/lib/types";

export interface ReceiptReviewState {
  outcome: ReceiptReviewOutcome;
  reasons: string[];
  amount: string;
  date: string;
  merchant: string;
  description: string;
  categoryId: string;
  preTaxMinor: number | null;
  taxMinor: number | null;
  lineItems: ReceiptLineItem[];
  priceDrafts: Record<string, string>;
}

export type ReceiptReviewAction =
  | { type: "set_amount"; value: string }
  | { type: "set_date"; value: string }
  | { type: "set_merchant"; value: string }
  | { type: "set_description"; value: string }
  | { type: "set_category"; value: string }
  | { type: "add_item"; id?: string }
  | { type: "update_item"; id: string; update: Partial<ReceiptLineItem> }
  | { type: "set_item_price"; id: string; value: string }
  | { type: "commit_item_price"; id: string }
  | { type: "remove_item"; id: string };

export function createReceiptReviewState(model: ReceiptReviewModel): ReceiptReviewState {
  return {
    outcome: model.outcome,
    reasons: [...model.reasons],
    amount: model.amountMinor === null ? "" : (model.amountMinor / 100).toFixed(2),
    date: model.date ?? "",
    merchant: model.merchant ?? "",
    description: model.description,
    categoryId: model.categoryId ?? "",
    preTaxMinor: model.preTaxMinor,
    taxMinor: model.taxMinor,
    lineItems: model.lineItems.map((item) => ({ ...item })),
    priceDrafts: Object.fromEntries(
      model.lineItems.map((item) => [
        item.id,
        item.lineTotalMinor === null ? "" : (item.lineTotalMinor / 100).toFixed(2),
      ]),
    ),
  };
}

export function receiptReviewReducer(
  state: ReceiptReviewState,
  action: ReceiptReviewAction,
): ReceiptReviewState {
  switch (action.type) {
    case "set_amount":
      return { ...state, amount: action.value };
    case "set_date":
      return { ...state, date: action.value };
    case "set_merchant":
      return { ...state, merchant: action.value };
    case "set_description":
      return { ...state, description: action.value };
    case "set_category":
      return { ...state, categoryId: action.value };
    case "add_item": {
      const id = action.id ?? createId("item");
      return {
        ...state,
        lineItems: [
          ...state.lineItems,
          { id, name: "", quantity: null, unitPriceMinor: null, lineTotalMinor: null, confidence: 0 },
        ],
        priceDrafts: { ...state.priceDrafts, [id]: "" },
      };
    }
    case "update_item":
      return {
        ...state,
        lineItems: state.lineItems.map((item) =>
          item.id === action.id ? { ...item, ...action.update } : item,
        ),
      };
    case "set_item_price":
      return { ...state, priceDrafts: { ...state.priceDrafts, [action.id]: action.value } };
    case "commit_item_price":
      return {
        ...state,
        lineItems: state.lineItems.map((item) =>
          item.id === action.id
            ? { ...item, lineTotalMinor: parseAmountToMinor(state.priceDrafts[action.id] ?? "") }
            : item,
        ),
      };
    case "remove_item": {
      const priceDrafts = { ...state.priceDrafts };
      delete priceDrafts[action.id];
      return {
        ...state,
        lineItems: state.lineItems.filter((item) => item.id !== action.id),
        priceDrafts,
      };
    }
  }
}

/** Builds the only line-item payload allowed to cross from review into save. */
export function buildReviewedLineItems(state: ReceiptReviewState): ReceiptLineItem[] {
  return state.lineItems
    .map((item) => ({
      ...item,
      name: item.name.trim(),
      lineTotalMinor: item.id in state.priceDrafts
        ? parseAmountToMinor(state.priceDrafts[item.id])
        : item.lineTotalMinor,
    }))
    .filter((item) => item.name.length > 0);
}

type ReceiptSaveFields = Pick<
  TransactionInput,
  "amountMinor" | "date" | "categoryId" | "merchant" | "description" | "ocrText" | "lineItems"
>;

/**
 * Builds saveable fields exclusively from the verified projection plus explicit
 * user edits. Raw OCR text and rejected rows are impossible to include.
 */
export function buildReceiptSaveFields(state: ReceiptReviewState): ReceiptSaveFields {
  const amountMinor = parseAmountToMinor(state.amount);
  if (!amountMinor) throw new Error("A positive receipt total is required.");
  return {
    amountMinor,
    date: state.date,
    categoryId: state.categoryId,
    merchant: state.merchant.trim(),
    description: state.description.trim() || `Receipt from ${state.merchant.trim()}`,
    ocrText: null,
    lineItems: buildReviewedLineItems(state),
  };
}
