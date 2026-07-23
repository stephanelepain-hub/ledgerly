import { createId, todayIsoDate, type ReceiptLineItem } from "@/lib/types";

export interface ReceiptFieldConfidence {
  amount: number;
  date: number;
  merchant: number;
  category: number;
}

export interface ReceiptExtraction {
  amountMinor: number | null;
  date: string;
  merchant: string;
  description: string;
  categoryId: string;
  fieldConfidence: ReceiptFieldConfidence;
  overallConfidence: number;
  warnings: string[];
  lineItems: ReceiptLineItem[];
}

interface AmountCandidate {
  amountMinor: number;
  confidence: number;
  lineIndex: number;
}

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  groceries: [
    "grocery",
    "groceries",
    "supermarket",
    "market",
    "foods",
    "produce",
    "walmart",
    "target",
    "costco",
    "aldi",
    "kroger",
    "whole foods",
    "trader joe",
  ],
  fuel: ["fuel", "gas", "gasoline", "diesel", "petrol", "shell", "chevron", "exxon", "mobil", "bp"],
  dining: [
    "restaurant",
    "cafe",
    "coffee",
    "kitchen",
    "grill",
    "pizza",
    "burger",
    "bakery",
    "diner",
    "starbucks",
    "mcdonald",
    "doordash",
    "ubereats",
  ],
  utilities: ["electric", "electricity", "water bill", "utility", "utilities", "internet", "mobile plan", "broadband", "energy"],
  entertainment: ["cinema", "movie", "theater", "netflix", "spotify", "ticket", "concert", "streaming", "game"],
  health: ["pharmacy", "clinic", "hospital", "medical", "dental", "doctor", "health", "cvs", "walgreens"],
  transport: ["taxi", "uber", "lyft", "transit", "metro", "bus", "train", "parking", "toll", "airline"],
  shopping: ["store", "shop", "retail", "clothing", "apparel", "hardware", "electronics", "amazon", "best buy"],
  rent: ["rent", "lease", "property management", "landlord"],
};

const MERCHANT_NOISE = [
  "receipt",
  "invoice",
  "tax invoice",
  "thank you",
  "thanks",
  "welcome",
  "subtotal",
  "total",
  "amount due",
  "balance",
  "change",
  "cash",
  "credit",
  "debit",
  "date",
  "time",
  "transaction",
  "order",
  "customer copy",
];

export const HIGH_CONFIDENCE_THRESHOLD = 0.72;

function normalizedLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

/**
 * Joins close-up OCR passes of a long receipt without duplicating the lines
 * deliberately overlapped between adjacent photos. It never uploads images
 * or text; callers keep the source images in the in-memory receipt draft.
 */
export function mergeReceiptSections(sections: string[]): string {
  const merged: string[] = [];
  for (const section of sections) {
    const incoming = section.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (!incoming.length) continue;

    const maximumOverlap = Math.min(12, merged.length, incoming.length);
    let overlap = 0;
    for (let size = maximumOverlap; size > 0; size -= 1) {
      const prior = merged.slice(-size).map(normalizedLine);
      const next = incoming.slice(0, size).map(normalizedLine);
      if (prior.every((line, index) => line === next[index])) {
        overlap = size;
        break;
      }
    }
    merged.push(...incoming.slice(overlap));
  }
  return merged.join("\n");
}

const ITEM_NOISE = /\b(sub\s*total|grand\s*total|total|tax|tva|vat|t\.?(?:t\.?)?c\.?|h\.?(?:t\.?)?|hors\s*taxe?|toutes?\s+taxes?\s+comprises?|change|cash|card|visa|mastercard|payment|amount\s*due|balance\s*due|discount|coupon|loyalty|thank\s*you)\b/i;

/**
 * Finds conservative item-and-price candidates. The receipt total remains
 * authoritative: items are suggestions for the user to edit, not a second
 * calculation of the transaction amount.
 */
export function extractReceiptLineItems(lines: string[]): ReceiptLineItem[] {
  const items: ReceiptLineItem[] = [];
  const seen = new Set<string>();
  const cleanedLines = lines.map((rawLine) => rawLine.replace(/\s+/g, " ").trim());
  const amountToken = "(?:[€$£]\\s*)?(\\d{1,3}(?:[ ,]\\d{3})*[.,]\\d{2}|\\d+[.,]\\d{2})";
  const inlinePrice = new RegExp(`^(.*?)(?:\\s+)${amountToken}\\s*$`, "u");
  const standalonePrice = new RegExp(`^${amountToken}\\s*$`, "u");
  const quantityPrice = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*${amountToken}\\s*$`, "iu");

  const addItem = (rawName: string, lineTotalMinor: number | null, quantity: number | null, unitPriceMinor: number | null, confidence: number) => {
    const name = rawName.replace(/^[-*•\d\s]+/, "").trim();
    if (!lineTotalMinor || ITEM_NOISE.test(name) || !/[\p{L}]/u.test(name) || name.length > 100) return;
    const key = `${normalizedLine(name)}|${lineTotalMinor}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ id: createId("item"), name, quantity, unitPriceMinor, lineTotalMinor, confidence });
  };

  for (let index = 0; index < cleanedLines.length; index += 1) {
    const line = cleanedLines[index];
    if (line.length < 3 || ITEM_NOISE.test(line)) continue;

    // Several tills put a product on one OCR line and its price on the next.
    // Pair only an isolated price (or quantity × isolated unit price) with the
    // immediately preceding product-looking line to avoid inventing entries.
    const previous = cleanedLines[index - 1] ?? "";
    const hasProductPrevious = !!previous && !ITEM_NOISE.test(previous) && /[\p{L}]/u.test(previous);
    const multiplied = quantityPrice.exec(line);
    if (multiplied && hasProductPrevious) {
      const quantity = Number(multiplied[1].replace(",", "."));
      const unitPriceMinor = normalizeAmount(multiplied[2]);
      const lineTotalMinor = quantity > 0 && unitPriceMinor ? Math.round(quantity * unitPriceMinor) : null;
      addItem(previous, lineTotalMinor, quantity > 0 ? quantity : null, unitPriceMinor, 0.48);
      continue;
    }

    const inline = inlinePrice.exec(line);
    if (inline && /[\p{L}]/u.test(inline[1])) {
      const lineTotalMinor = normalizeAmount(inline[2]);
      const quantityMatch = /(?:^|\s)(\d+(?:[.,]\d+)?)\s*[x×]/iu.exec(inline[1]);
      const quantity = quantityMatch ? Number(quantityMatch[1].replace(",", ".")) : null;
      addItem(inline[1], lineTotalMinor, quantity && quantity > 0 ? quantity : null, quantity && quantity > 0 && lineTotalMinor ? Math.round(lineTotalMinor / quantity) : null, 0.62);
      continue;
    }

    if (!hasProductPrevious) continue;
    const single = standalonePrice.exec(line);
    if (single) addItem(previous, normalizeAmount(single[1]), null, null, 0.5);
  }
  return items;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function normalizeAmount(raw: string): number | null {
  let value = raw.replace(/[$€£\s]/g, "");
  const commaCount = (value.match(/,/g) ?? []).length;
  const dotCount = (value.match(/\./g) ?? []).length;

  if (commaCount === 1 && dotCount === 0 && /,\d{2}$/.test(value)) {
    value = value.replace(",", ".");
  } else {
    value = value.replace(/,/g, "");
  }

  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000_000) return null;
  return Math.round(parsed * 100);
}

function amountLabelConfidence(line: string): number {
  const normalized = line.toLocaleLowerCase();
  if (/grand\s*total|amount\s*due|total\s*due|balance\s*due/.test(normalized)) return 0.98;
  if (/\btotal\b/.test(normalized) && !/sub\s*total/.test(normalized)) return 0.93;
  if (/\bpaid\b|card\s*(?:total|payment)|payment/.test(normalized)) return 0.78;
  if (/sub\s*total/.test(normalized)) return 0.58;
  if (/tax|tip|change|cash/.test(normalized)) return 0.32;
  return 0.46;
}

function extractAmount(lines: string[]): { value: number | null; confidence: number } {
  const candidates: AmountCandidate[] = [];
  const pattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;

  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(pattern)) {
      const amountMinor = normalizeAmount(match[0]);
      if (!amountMinor) continue;
      let confidence = amountLabelConfidence(line);
      if (/[$€£]/.test(match[0])) confidence += 0.05;
      if (lineIndex >= Math.floor(lines.length * 0.45)) confidence += 0.03;
      candidates.push({ amountMinor, confidence: clamp(confidence), lineIndex });
    }
  });

  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    if (b.amountMinor !== a.amountMinor) return b.amountMinor - a.amountMinor;
    return b.lineIndex - a.lineIndex;
  });

  const best = candidates[0];
  if (!best) return { value: null, confidence: 0 };
  const duplicateSupport = candidates.some(
    (candidate, index) => index > 0 && candidate.amountMinor === best.amountMinor,
  );
  return {
    value: best.amountMinor,
    confidence: clamp(best.confidence + (duplicateSupport ? 0.04 : 0)),
  };
}

function isoDate(year: number, month: number, day: number): string | null {
  if (year < 2000 || year > new Date().getFullYear() + 1) return null;
  const value = new Date(year, month - 1, day, 12);
  if (
    value.getFullYear() !== year ||
    value.getMonth() !== month - 1 ||
    value.getDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function extractDate(text: string): { value: string; confidence: number } {
  const yearFirst = text.match(/\b(20\d{2})[\-/.](0?[1-9]|1[0-2])[\-/.](0?[1-9]|[12]\d|3[01])\b/);
  if (yearFirst) {
    const value = isoDate(Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3]));
    if (value) return { value, confidence: 0.94 };
  }

  const numeric = text.match(/\b(0?[1-9]|[12]\d|3[01])[\-/.](0?[1-9]|1[0-2])[\-/.](20\d{2}|\d{2})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const rawYear = Number(numeric[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    const unambiguousDayFirst = first > 12;
    const month = unambiguousDayFirst ? second : first;
    const day = unambiguousDayFirst ? first : second;
    const value = isoDate(year, month, day);
    if (value) return { value, confidence: unambiguousDayFirst ? 0.88 : 0.68 };
  }

  const monthNames =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  const named = text.match(
    new RegExp(`\\b(${monthNames})[\\s.\\-/]+(\\d{1,2})(?:st|nd|rd|th)?[,]?[\\s.\\-/]+(20\\d{2}|\\d{2})\\b`, "i"),
  );
  if (named) {
    const monthToken = named[1].slice(0, 3).toLocaleLowerCase();
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthToken) + 1;
    const rawYear = Number(named[3]);
    const value = isoDate(rawYear < 100 ? 2000 + rawYear : rawYear, month, Number(named[2]));
    if (value) return { value, confidence: 0.92 };
  }

  return { value: todayIsoDate(), confidence: 0.08 };
}

function isMerchantNoise(line: string): boolean {
  const normalized = line.toLocaleLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 2 || normalized.length > 56) return true;
  if (!/[a-z]{2,}/i.test(normalized)) return true;
  if (/^(www\.|https?:|tel:?|phone:?|address:?)/i.test(normalized)) return true;
  if (/^\d+[\s-]/.test(normalized) && /\b(st|street|ave|avenue|road|rd|blvd|drive|dr)\b/.test(normalized)) return true;
  return MERCHANT_NOISE.some((noise) => normalized === noise || normalized.startsWith(`${noise} `));
}

function titleCaseMerchant(value: string): string {
  const cleaned = value.replace(/\s+/g, " ").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").trim();
  if (!cleaned) return "";
  const mostlyUpper = cleaned.replace(/[^A-Z]/g, "").length > cleaned.replace(/[^A-Za-z]/g, "").length * 0.75;
  if (!mostlyUpper) return cleaned;
  return cleaned
    .toLocaleLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function extractMerchant(lines: string[]): { value: string; confidence: number } {
  const candidates = lines
    .slice(0, 9)
    .map((line, index) => ({ line: line.trim(), index }))
    .filter(({ line }) => !isMerchantNoise(line));

  const best = candidates[0];
  if (!best) return { value: "", confidence: 0 };
  const hasBusinessCue = /market|store|restaurant|cafe|pharmacy|shop|mart|foods|fuel|gas/i.test(best.line);
  const confidence = clamp(0.8 - best.index * 0.055 + (hasBusinessCue ? 0.08 : 0));
  return { value: titleCaseMerchant(best.line), confidence };
}

function extractCategory(text: string, merchant: string): { value: string; confidence: number } {
  const haystack = `${merchant}\n${text}`.toLocaleLowerCase();
  let bestId = "other";
  let bestScore = 0;

  for (const [categoryId, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (!haystack.includes(keyword)) continue;
      score += merchant.toLocaleLowerCase().includes(keyword) ? 2 : 1;
    }
    if (score > bestScore) {
      bestId = categoryId;
      bestScore = score;
    }
  }

  if (!bestScore) return { value: "other", confidence: 0.28 };
  return { value: bestId, confidence: clamp(0.64 + Math.min(bestScore, 4) * 0.07) };
}

export function parseReceiptText(rawText: string): ReceiptExtraction {
  const text = rawText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const amount = extractAmount(lines);
  const date = extractDate(text);
  const merchant = extractMerchant(lines);
  const category = extractCategory(text, merchant.value);
  const lineItems = extractReceiptLineItems(lines);
  const fieldConfidence: ReceiptFieldConfidence = {
    amount: amount.confidence,
    date: date.confidence,
    merchant: merchant.confidence,
    category: category.confidence,
  };
  const overallConfidence = clamp(
    fieldConfidence.amount * 0.42 +
      fieldConfidence.date * 0.23 +
      fieldConfidence.merchant * 0.22 +
      fieldConfidence.category * 0.13,
  );
  const warnings: string[] = [];

  if (!amount.value) warnings.push("No reliable total was found.");
  else if (fieldConfidence.amount < 0.72) warnings.push("Check the total amount.");
  if (fieldConfidence.date < 0.72) warnings.push("Check the receipt date.");
  if (fieldConfidence.merchant < 0.7) warnings.push("Check the merchant name.");
  if (category.value === "other" || fieldConfidence.category < 0.65) {
    warnings.push("Choose the best category.");
  }

  return {
    amountMinor: amount.value,
    date: date.value,
    merchant: merchant.value,
    description: merchant.value ? `Receipt from ${merchant.value}` : "Receipt purchase",
    categoryId: category.value,
    fieldConfidence,
    overallConfidence,
    warnings,
    lineItems,
  };
}
