import { createId, todayIsoDate, type ReceiptLineItem } from "@/lib/types";
import type { ReceiptOcrLine } from "@/lib/receipt-ocr";

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
  merchantAddress?: string | null;
  /** Total before VAT/TVA, when it can be identified locally. */
  preTaxMinor?: number | null;
  /** TVA/VAT included in the total, when it can be identified locally. */
  taxMinor?: number | null;
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
  "alt",
  "ctrl",
  "control",
  "shift",
  "tab",
];

export const HIGH_CONFIDENCE_THRESHOLD = 0.72;

function normalizedLine(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function similarityKey(value: string): string {
  return normalizedLine(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * OCR reads the same printed line slightly differently on every pass
 * ("OEUFS" vs "0EUFS"). Duplicate detection must therefore be fuzzy, not
 * exact, or re-captured receipt regions produce duplicated cart items.
 */
export function receiptLineSimilarity(a: string, b: string): number {
  const left = similarityKey(a);
  const right = similarityKey(b);
  if (!left && !right) return 1;
  if (!left || !right) return 0;
  if (left === right) return 1;
  const distance = levenshteinDistance(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

const SECTION_OVERLAP_SIMILARITY = 0.8;

function isSameReceiptLine(a: string, b: string): boolean {
  return receiptLineSimilarity(a, b) >= SECTION_OVERLAP_SIMILARITY;
}

function mergeSectionLineArrays(sections: string[][]): string[] {
  const merged: string[] = [];
  for (const section of sections) {
    const incoming = section.map((line) => line.trim()).filter(Boolean);
    if (!incoming.length) continue;

    const maximumOverlap = Math.min(12, merged.length, incoming.length);
    let overlap = 0;
    for (let size = maximumOverlap; size > 0; size -= 1) {
      const prior = merged.slice(-size);
      const next = incoming.slice(0, size);
      if (prior.every((line, index) => isSameReceiptLine(line, next[index]))) {
        overlap = size;
        break;
      }
    }
    merged.push(...incoming.slice(overlap));
  }
  return merged;
}

/**
 * Joins close-up OCR passes of a long receipt without duplicating the lines
 * deliberately overlapped between adjacent photos. It never uploads images
 * or text; callers keep the source images in the in-memory receipt draft.
 */
export function mergeReceiptSections(sections: string[]): string {
  return mergeSectionLineArrays(sections.map((section) => section.split(/\r?\n/))).join("\n");
}

const ITEM_NOISE = /\b(sub\s*total|grand\s*total|total|tax|tva|vat|t\.?(?:t\.?)?c\.?|tic|h\.?[ti1]\.?|hors\s*taxe?|toutes?\s+taxes?\s+comprises?|a\s*payer|net\s+a\s+payer|montant\s+du|nombre\s+de\s+lignes?|change|cash|card|c[b8]|visa|mastercard|payment|amount\s*due|balance\s*due|discount|coupon|loyalty|thank\s*you)\b/i;

function isItemNoise(value: string): boolean {
  return ITEM_NOISE.test(value.normalize("NFD").replace(/\p{M}/gu, ""));
}

/**
 * Finds conservative item-and-price candidates. The receipt total remains
 * authoritative: items are suggestions for the user to edit, not a second
 * calculation of the transaction amount.
 */
export function extractReceiptLineItems(lines: string[], visualRowLines?: string[]): ReceiptLineItem[] {
  const items: ReceiptLineItem[] = [];
  const seen = new Set<string>();
  // ML Kit's result.text may flatten columns (all descriptions followed by all
  // prices). Callers pass printed rows rebuilt from positioned line fragments.
  const sourceLines = visualRowLines?.length ? visualRowLines : lines;
  const cleanedLines = sourceLines.map((rawLine) => rawLine.replace(/\s+/g, " ").trim());
  const amountToken = "(?:[€$£]\\s*)?(\\d{1,3}(?:[ ,]\\d{3})*[.,]\\d{2}|\\d+[.,]\\d{2})";
  const priceSuffix = "(?:\\s*(?:EUR|EURO|[€$£]|e))?(?:\\s+(?:[A-Z]|\\d+))?";
  // French tills commonly append a VAT class or article count after a price:
  // "FROMAGE 2,18 EUR B" or "OEUFS 6,99 € 1".
  const inlinePrice = new RegExp(`^(.*?)(?:\\s+)${amountToken}${priceSuffix}\\s*$`, "iu");
  const standalonePrice = new RegExp(`^${amountToken}${priceSuffix}\\s*$`, "iu");
  const quantityPrice = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*[x×]\\s*${amountToken}${priceSuffix}\\s*$`, "iu");
  const measuredPrice = new RegExp(`^(\\d+(?:[.,]\\d+)?)\\s*(?:kg|g|l)\\b.+?${amountToken}${priceSuffix}\\s*$`, "iu");

  const addItem = (rawName: string, lineTotalMinor: number | null, quantity: number | null, unitPriceMinor: number | null, confidence: number) => {
    const name = rawName
      .replace(/^0(?=\p{L})/u, "O")
      .replace(/^[-*•\d\s]+/, "")
      .trim();
    if (!lineTotalMinor || lineTotalMinor > 1_000_000 || isItemNoise(name) || !/[\p{L}]/u.test(name) || name.length > 100) return;
    const key = `${normalizedLine(name)}|${lineTotalMinor}`;
    if (seen.has(key)) return;
    // Same price plus a nearly identical name is the signature of the same
    // printed row read twice (overlapping sections or a re-scanned region).
    const ITEM_DUPLICATE_SIMILARITY = 0.8;
    if (items.some((existing) =>
      existing.lineTotalMinor === lineTotalMinor &&
      receiptLineSimilarity(existing.name, name) >= ITEM_DUPLICATE_SIMILARITY,
    )) {
      return;
    }
    seen.add(key);
    items.push({ id: createId("item"), name, quantity, unitPriceMinor, lineTotalMinor, confidence });
  };

  for (let index = 0; index < cleanedLines.length; index += 1) {
    const line = cleanedLines[index];
    if (line.length < 3 || isItemNoise(line)) continue;

    // Several tills put a product on one OCR line and its price on the next.
    // Pair only an isolated price (or quantity × isolated unit price) with the
    // immediately preceding product-looking line to avoid inventing entries.
    const previous = cleanedLines[index - 1] ?? "";
    const previousAlreadyHasPrice = inlinePrice.test(previous);
    const hasProductPrevious = !!previous && !previousAlreadyHasPrice && !isItemNoise(previous) && /[\p{L}]/u.test(previous);
    const measured = measuredPrice.exec(line);
    if (measured && hasProductPrevious) {
      const quantity = Number(measured[1].replace(",", "."));
      addItem(previous, normalizeAmount(measured[2]), quantity > 0 ? quantity : null, null, 0.56);
      continue;
    }

    const multiplied = quantityPrice.exec(line);
    if (multiplied) {
      if (hasProductPrevious) {
        const quantity = Number(multiplied[1].replace(",", "."));
        const unitPriceMinor = normalizeAmount(multiplied[2]);
        const lineTotalMinor = quantity > 0 && unitPriceMinor ? Math.round(quantity * unitPriceMinor) : null;
        addItem(previous, lineTotalMinor, quantity > 0 ? quantity : null, unitPriceMinor, 0.48);
      }
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

export function rebuildReceiptVisualRows(lines: ReceiptOcrLine[]): string[] {
  const rows: { anchorTop: number; anchorBottom: number; fragments: { left: number; text: string }[] }[] = [];
  for (const line of lines) {
    const previous = rows.at(-1);
    const overlap = previous
      ? Math.max(0, Math.min(previous.anchorBottom, line.bottom) - Math.max(previous.anchorTop, line.top))
      : 0;
    const minimumHeight = previous
      ? Math.max(1, Math.min(previous.anchorBottom - previous.anchorTop, line.bottom - line.top))
      : 1;
    // Compare with the first fragment's fixed vertical bounds. Expanding the
    // row bounds caused adjacent receipt lines to merge transitively into one
    // giant row. Description and price fragments overlap; the next printed
    // line generally does not overlap the original anchor.
    const samePrintedRow = !!previous && overlap / minimumHeight >= 0.25;
    const fragments = line.elements.length
      ? line.elements.map((element) => ({ left: element.left, text: element.text }))
      : [{ left: line.left, text: line.text }];
    if (samePrintedRow) {
      previous.fragments.push(...fragments);
    } else {
      rows.push({ anchorTop: line.top, anchorBottom: line.bottom, fragments });
    }
  }
  return rows.map((row) => row.fragments
    .sort((a, b) => a.left - b.left)
    .map((fragment) => fragment.text)
    .join(" "));
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
  const normalized = line.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  if (/grand\s*total|amount\s*due|total\s*due|balance\s*due|[aà]\s*payer|net\s+[aà]\s+payer|montant\s+d[uû]/.test(normalized)) return 0.98;
  if (/total\s*(?:h\.?[ti1]\.?|tva|vat)|montant\s+tva|\btax\b/.test(normalized)) return 0.3;
  if (/\btotal\b/.test(normalized) && !/sub\s*total/.test(normalized)) return 0.9;
  if (/\bpaid\b|card\s*(?:total|payment)|payment/.test(normalized)) return 0.78;
  if (/sub\s*total/.test(normalized)) return 0.58;
  if (/tax|tip|change|cash/.test(normalized)) return 0.32;
  return 0.46;
}

function extractPreTax(lines: string[]): number | null {
  const amountPattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;
  const isPreTaxLabel = /\b(?:total\s*)?h\.?[ti1]\.?\b|hors\s*taxe?/i;

  for (let index = 0; index < lines.length; index += 1) {
    if (!isPreTaxLabel.test(lines[index])) continue;
    const values = [...lines[index].matchAll(amountPattern)]
      .map((match) => normalizeAmount(match[0]))
      .filter((value): value is number => value !== null);
    if (values.length) return values.at(-1) ?? null;

    const next = lines[index + 1] ?? "";
    if (!ITEM_NOISE.test(next) && /^\s*(?:[€$£]\s*)?\d+(?:[.,]\d{2})\s*$/u.test(next)) {
      return normalizeAmount(next);
    }
  }
  return null;
}

function extractTax(lines: string[]): number | null {
  const amountPattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;
  const isTaxLabel = /\b(?:tva|vat|taxe?s?)\b/i;

  for (let index = 0; index < lines.length; index += 1) {
    if (!isTaxLabel.test(lines[index])) continue;
    const values = [...lines[index].matchAll(amountPattern)]
      .map((match) => normalizeAmount(match[0]))
      .filter((value): value is number => value !== null);
    if (values.length) return values.at(-1) ?? null;

    const next = lines[index + 1] ?? "";
    if (!ITEM_NOISE.test(next) && /^\s*(?:[€$£]\s*)?\d+(?:[.,]\d{2})\s*$/u.test(next)) {
      return normalizeAmount(next);
    }
  }
  return null;
}

function extractAmount(lines: string[]): { value: number | null; confidence: number } {
  const candidates: AmountCandidate[] = [];
  const pattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;

  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(pattern)) {
      const matchEnd = (match.index ?? 0) + match[0].length;
      if (line.slice(matchEnd).trimStart().startsWith("%")) continue;
      const amountMinor = normalizeAmount(match[0]);
      if (!amountMinor) continue;
      let confidence = amountLabelConfidence(line);
      if (/[$€£]/.test(match[0])) confidence += 0.05;
      if (lineIndex >= Math.floor(lines.length * 0.45)) confidence += 0.03;
      candidates.push({ amountMinor, confidence: clamp(confidence), lineIndex });
    }
  });

  const frequencies = new Map<number, number>();
  for (const candidate of candidates) {
    frequencies.set(candidate.amountMinor, (frequencies.get(candidate.amountMinor) ?? 0) + 1);
  }
  for (const candidate of candidates) {
    if ((frequencies.get(candidate.amountMinor) ?? 0) > 1) candidate.confidence = clamp(candidate.confidence + 0.05);
  }
  candidates.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return b.lineIndex - a.lineIndex;
  });

  const best = candidates[0];
  if (!best || (best.amountMinor > 1_000_000 && best.confidence < 0.72)) {
    return { value: null, confidence: 0 };
  }
  return { value: best.amountMinor, confidence: best.confidence };
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

  const numeric = text.match(/\b(0?[1-9]|[12]\d|3[01])[\-/.](0?[1-9]|[12]\d|3[01])[\-/.](20\d{2}|\d{2})\b/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    const rawYear = Number(numeric[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    // European receipts print day-first. Treat ambiguous dates as DD/MM and
    // fall back to MM/DD only when the second value cannot be a month.
    const monthFirstOnly = second > 12 && first <= 12;
    const day = monthFirstOnly ? second : first;
    const month = monthFirstOnly ? first : second;
    const unambiguous = first > 12 || second > 12;
    const value = isoDate(year, month, day);
    if (value) return { value, confidence: unambiguous ? 0.88 : 0.68 };
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
  if (/^(aldi|lidl)$/i.test(cleaned)) return cleaned.toLocaleUpperCase();
  const mostlyUpper = cleaned.replace(/[^A-Z]/g, "").length > cleaned.replace(/[^A-Za-z]/g, "").length * 0.75;
  if (!mostlyUpper) return cleaned;
  return cleaned
    .toLocaleLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase());
}

function extractMerchant(lines: string[]): { value: string; confidence: number } {
  const knownMerchants: { pattern: RegExp; name: string }[] = [
    { pattern: /\baldi\b/i, name: "ALDI" },
    { pattern: /\blidl\b/i, name: "LIDL" },
    { pattern: /\bcarrefour\b/i, name: "Carrefour" },
    { pattern: /\be\.?\s*leclerc\b/i, name: "E.Leclerc" },
    { pattern: /\bintermarch[eé]\b/i, name: "Intermarché" },
    { pattern: /\bauchan\b/i, name: "Auchan" },
  ];
  for (const line of lines.slice(0, 14)) {
    const known = knownMerchants.find((merchant) => merchant.pattern.test(line));
    if (known) return { value: known.name, confidence: 0.96 };
  }

  const candidates = lines
    .slice(0, 14)
    .map((line) => line.trim())
    .filter((line) => !isMerchantNoise(line))
    .map((line, index) => ({ line, index }));

  const best = candidates[0];
  if (!best) return { value: "", confidence: 0 };
  const hasBusinessCue = /market|store|restaurant|cafe|pharmacy|shop|mart|foods|fuel|gas|aldi|lidl|carrefour|leclerc|intermarch[eé]|auchan/i.test(best.line);
  const confidence = clamp(0.8 - best.index * 0.055 + (hasBusinessCue ? 0.08 : 0));
  return { value: titleCaseMerchant(best.line), confidence };
}

function extractMerchantAddress(lines: string[], merchant: string): string | null {
  const addressCue = /\b\d{5}\b|\b(?:zac|rue|avenue|av\.?|boulevard|bd\.?|route|chemin|place|street|road|lane|drive)\b/i;
  const candidate = lines.slice(0, 16).find((line) => addressCue.test(line));
  if (!candidate) return null;

  const escapedMerchant = merchant.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const withoutMerchant = merchant
    ? candidate.replace(new RegExp(`\\b${escapedMerchant}\\b`, "i"), "")
    : candidate;
  const cleaned = withoutMerchant
    .replace(/\s+,/g, ",")
    .replace(/,{2,}/g, ",")
    .replace(/^\s*,\s*|\s*,\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length >= 6 ? cleaned : null;
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

export function parseReceiptText(
  rawText: string,
  visualRows?: ReceiptOcrLine[] | ReceiptOcrLine[][],
): ReceiptExtraction {
  const text = rawText.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  // Rebuild printed rows per captured section, then merge the sections while
  // dropping the deliberately overlapped region between adjacent photos.
  // Flattening all sections' rows together duplicated every overlapped item.
  const visualSections: ReceiptOcrLine[][] = !visualRows?.length
    ? []
    : Array.isArray(visualRows[0])
      ? (visualRows as ReceiptOcrLine[][]).filter((section) => section.length)
      : [visualRows as ReceiptOcrLine[]];
  const visualLines = mergeSectionLineArrays(visualSections.map(rebuildReceiptVisualRows));
  const analysisLines = [...lines, ...visualLines];
  const amount = extractAmount(analysisLines);
  const date = extractDate(text);
  const merchantLines = visualLines.length ? visualLines : lines;
  const merchant = extractMerchant(merchantLines);
  const merchantAddress = extractMerchantAddress(merchantLines, merchant.value);
  const category = extractCategory(text, merchant.value);
  const preTaxMinor = extractPreTax(analysisLines);
  const taxMinor = extractTax(analysisLines);
  const lineItems = extractReceiptLineItems(lines, visualLines);
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
    description: merchant.value
      ? `Receipt from ${merchant.value}${merchantAddress ? ` — ${merchantAddress}` : ""}`
      : "Receipt purchase",
    categoryId: category.value,
    fieldConfidence,
    overallConfidence,
    warnings,
    merchantAddress,
    preTaxMinor,
    taxMinor,
    lineItems,
  };
}
