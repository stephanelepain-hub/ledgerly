import { createId, formatLongDate, formatMoney, todayIsoDate, type ReceiptLineItem } from "@/lib/types";
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
  /**
   * The item count the receipt states about itself, when it prints one. Used
   * to detect a scan that only covers part of a long receipt.
   */
  declaredItemCount?: number | null;
  /**
   * Every distinct date read from the receipt when the copies disagreed, best
   * supported first. Empty when the date was unambiguous.
   */
  conflictingDates?: string[];
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
    "intermarch",
    "carrefour",
    "lidl",
    "leclerc",
    "auchan",
    "monoprix",
    "casino",
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

/**
 * Collapses the letter shapes OCR routinely confuses (O/0, I/l/1, S/5, B/8)
 * while keeping every digit significant.
 *
 * Similarity alone is unsafe here: on a receipt the price is often the only
 * thing separating two lines, so "LAIT 1,05" and "LAIT 1,85" score ~0.89 and
 * a similarity threshold silently deletes a real purchase. Digits must match
 * exactly; only ambiguous letter glyphs may vary.
 */
function overlapKey(value: string): string {
  return normalizedLine(value)
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .replace(/[o]/g, "0")
    .replace(/[il]/g, "1")
    .replace(/[s]/g, "5")
    .replace(/[b]/g, "8");
}

/**
 * Exact equality of the canonical key. No similarity tolerance: a missed
 * merge merely repeats a line, which item de-duplication then catches, but a
 * false merge deletes a real purchase and cannot be recovered. Erring toward
 * keeping data is the only safe direction here.
 */
function isSameReceiptLine(a: string, b: string): boolean {
  const left = overlapKey(a);
  const right = overlapKey(b);
  return !!left && left === right;
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

// "montant" alone is the French total, and meal-voucher/payment tender lines
// carry the receipt total too. Both were being banked as shopping items,
// which double-counted the total inside the cart.
const ITEM_NOISE = /\b(sub\s*total|sous\s*total|grand\s*total|total|tax|tva|vat|t\.?(?:t\.?)?c\.?|tic|h\.?[ti1]\.?|hors\s*taxe?|toutes?\s+taxes?\s+comprises?|a\s*payer|net\s+a\s+payer|montant|h[o0]ntant|tant\s+d[uû]|nombre\s+de\s+lignes?|change|cash|card|c[b8]|visa|mastercard|payment|paiement|titre[s]?\s*restaurant|ticket[s]?\s*restaurant|esp[eè]ces|monnaie|rendu|reste\s+a\s+payer|amount\s*due|balance\s*due|discount|remise|coupon|loyalty|thank\s*you)\b/i;

function isItemNoise(value: string): boolean {
  const plain = value.normalize("NFD").replace(/\p{M}/gu, "");
  // OCR splits words inside a printed line: a real scan produced "Titre
  // restaur ant" for a meal-voucher tender, which defeated the phrase patterns
  // and banked the payment as a €19.81 product. Every phrase above tolerates
  // zero spaces, so testing a whitespace-free variant catches the mangled
  // spellings without widening the vocabulary.
  return ITEM_NOISE.test(plain) || ITEM_NOISE.test(plain.replace(/\s+/gu, ""));
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
  // The VAT class often arrives glued to the currency ("2,18 EURB"), which cost
  // a real €2.18 product its price and left the cart short of the total.
  const priceSuffix = "(?:\\s*(?:EURO|EUR|[€$£]|e))?(?:\\s*[A-Z]|\\s+\\d+)?";
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
      // Strip a price still attached to the description. When a till prints the
      // article count hard against the currency ("12,87 €1") the inline price
      // pattern cannot claim it, so the quantity line below supplies the total
      // and the raw row keeps its price text, e.g.
      // "CAFE MOULU EXCELL 250G 12,87 €1".
      .replace(/\s*\d{1,3}(?:[ ,]\d{3})*[.,]\d{2}\s*(?:EUR|EURO|[€$£]|e)?\s*\d*\s*$/i, "")
      .trim();
    // A product name needs at least two letters and some substance. Stray OCR
    // fragments such as "|x" (a misread "1x") otherwise became cart entries,
    // borrowing the price of the line next to them.
    const letterCount = (name.match(/\p{L}/gu) ?? []).length;
    // A weight/unit-price continuation line such as "0,686 kg x 3.99 €/kg"
    // describes the product above it; it is not a product of its own.
    const isMeasurementLine =
      /^\d*[.,]?\d*\s*(?:kg|g|l|ml|cl)\b/i.test(name) ||
      /(?:€|eur|euro)\s*\/\s*(?:kg|g|l|ml|cl)\b/i.test(name) ||
      /\b(?:kg|g|l|ml|cl)\s*[x×]\s*\d/i.test(name);
    if (
      !lineTotalMinor ||
      lineTotalMinor > 1_000_000 ||
      isItemNoise(name) ||
      isMeasurementLine ||
      letterCount < 2 ||
      name.length < 3 ||
      name.length > 100
    ) {
      return;
    }
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
    // Compare vertical centres, not overlap, and always against the row's
    // first fragment so rows cannot merge transitively into one giant row.
    //
    // Overlap was not scale-invariant. On tightly printed receipts (small text
    // from a lower-resolution camera) neighbouring rows overlapped by ~0.28 of
    // their height, just past the old 0.25 cutoff, so a price was absorbed
    // into the row above and its product silently lost its price and was
    // dropped. Measured on real scans, centres separate cleanly: fragments of
    // one printed row sit within 0.21 of a line height, the next printed row
    // starts beyond 0.74. 0.6 sits inside that gap at both text sizes.
    const minimumHeight = previous
      ? Math.max(1, Math.min(previous.anchorBottom - previous.anchorTop, line.bottom - line.top))
      : 1;
    const centreDistance = previous
      ? Math.abs(
          (line.top + line.bottom) / 2 - (previous.anchorTop + previous.anchorBottom) / 2,
        )
      : Number.POSITIVE_INFINITY;
    const samePrintedRow = !!previous && centreDistance / minimumHeight <= 0.6;
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
  // The decimal separator is whichever of "." or "," comes last and is followed
  // by exactly two digits; anything earlier is a thousands mark. This reads
  // "1.234,56" and "1,234.56" alike as 1234.56. Without it the French form lost
  // its leading thousands group.
  const decimalIndex = Math.max(value.lastIndexOf(","), value.lastIndexOf("."));
  if (decimalIndex >= 0 && /^[.,]\d{2}$/.test(value.slice(decimalIndex))) {
    const whole = value.slice(0, decimalIndex).replace(/[^0-9-]/g, "");
    value = `${whole || "0"}.${value.slice(decimalIndex + 1)}`;
  } else {
    value = value.replace(/,/g, "");
  }

  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100_000_000) return null;
  return Math.round(parsed * 100);
}

/**
 * Till software prints version and identifier strings that look exactly like
 * money and dates: a real Intermarché receipt carried
 * "Ver:8.6.8.2-981 -1.1.12.1", from which the parser took a €1.12 total and a
 * 2012-01-01 date, beating the receipt's genuine €19.77 and 17/07/2026.
 *
 * Two signals, both structural rather than vocabulary-based: an explicit
 * version/serial cue on the line, or a numeric run broken by three or more
 * separators. Ordinary money has at most two ("1.234,56"), so thousands
 * separators stay safe.
 */
const TECHNICAL_CONTEXT = /\b(?:ver|vers|version|build|firmware|logiciel|soft|software|serial|serie|s\/?n)\b\s*[:.]?/i;

function isTechnicalNumber(source: string, start: number, end: number): boolean {
  const lineStart = source.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
  const lineBreak = source.indexOf("\n", end);
  const line = source.slice(lineStart, lineBreak === -1 ? source.length : lineBreak);
  if (TECHNICAL_CONTEXT.test(line)) return true;
  let left = start;
  while (left > lineStart && /[\d.,\-]/.test(source[left - 1])) left -= 1;
  let right = end;
  while (right < source.length && /[\d.,\-]/.test(source[right])) right += 1;
  const separators = (source.slice(left, right).match(/[.,\-](?=\d)/g) ?? []).length;
  return separators >= 3;
}

function amountLabelConfidence(line: string): number {
  const normalized = line.toLocaleLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  // OCR mangles the label itself: one real receipt printed MONTANT DU twice and
  // it was read as "HONTANT DU" and "TANT DU". Losing the label dropped the
  // labelled-total path (confidence 1.0) to the weak fallback (0.49), which let
  // a version string win. Tolerate a damaged first syllable.
  if (/grand\s*total|amount\s*due|total\s*due|balance\s*due|[aà]\s*payer|net\s+[aà]\s+payer|\w{0,3}[o0]ntant\s+d[uû]|\btant\s+d[uû]\b/.test(normalized)) return 0.98;
  if (/total\s*(?:h\.?[ti1]\.?|tva|vat)|montant\s+tva|\btax\b/.test(normalized)) return 0.3;
  if (/\btotal\b/.test(normalized) && !/sub\s*total/.test(normalized)) return 0.9;
  if (/\bpaid\b|card\s*(?:total|payment)|payment/.test(normalized)) return 0.78;
  if (/sub\s*total/.test(normalized)) return 0.58;
  if (/tax|tip|change|cash/.test(normalized)) return 0.32;
  return 0.46;
}

/**
 * Reads a labelled total, preferring a strong label that carries its value on
 * the same row.
 *
 * French receipts also print a per-VAT-rate breakdown table whose columns are
 * headed by a bare "HT" and "MONTANT TVA". Scanning the flattened OCR text
 * first matched those per-rate subtotals (HT 25,55 of 34,95) instead of the
 * receipt's own "TOTAL HT 34,95" row, so the summary understated both figures.
 */
function extractLabelledTotal(
  lines: string[],
  strongLabel: RegExp,
  weakLabel: RegExp,
): number | null {
  const amountPattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;

  const valuesOn = (line: string): number[] =>
    [...line.matchAll(amountPattern)]
      .map((match) => normalizeAmount(match[0]))
      .filter((value): value is number => value !== null);

  // Pass 1: an unambiguous label with its own value, which is what the visual
  // row rebuild reconstructs from the description and price columns.
  for (const line of lines) {
    if (!strongLabel.test(line)) continue;
    const values = valuesOn(line);
    if (values.length) return values.at(-1) ?? null;
  }

  // Pass 2: any matching label, taking a value from the row or the bare price
  // printed immediately after it.
  for (let index = 0; index < lines.length; index += 1) {
    if (!weakLabel.test(lines[index])) continue;
    const values = valuesOn(lines[index]);
    if (values.length) return values.at(-1) ?? null;

    const next = lines[index + 1] ?? "";
    if (!ITEM_NOISE.test(next) && /^\s*(?:[€$£]\s*)?\d+(?:[.,]\d{2})\s*$/u.test(next)) {
      return normalizeAmount(next);
    }
  }
  return null;
}

function extractPreTax(lines: string[]): number | null {
  return extractLabelledTotal(
    lines,
    /\btotal\s*h\.?[ti1]\.?\b|\bhors\s*taxe?\b/i,
    /\b(?:total\s*)?h\.?[ti1]\.?\b|hors\s*taxe?/i,
  );
}

function extractTax(lines: string[]): number | null {
  return extractLabelledTotal(
    lines,
    /\btotal\s*(?:tva|vat)\b/i,
    /\b(?:tva|vat|taxe?s?)\b/i,
  );
}

/**
 * `preferMinor` lets a caller say what the detected cart adds up to. A till that
 * splits payment prints several labelled totals: one real receipt showed
 * "MONTANT DU 19,77" twice and "MONTANT DU 12,08" — the balance left after a
 * €7.69 meal voucher. Both are legitimately labelled, so position alone picked
 * the payment split and understated the expense by €7.69. The goods total is the
 * one the items add up to, which is evidence no wording can contradict.
 */
function extractAmount(
  lines: string[],
  preferMinor?: number | null,
): { value: number | null; confidence: number } {
  const candidates: AmountCandidate[] = [];
  const pattern = /(?:[$€£]\s*)?(\d{1,3}(?:[ .,]\d{3})+[.,]\d{2}|\d{1,3}(?:[ ,]\d{3})*(?:[.,]\d{2})|\d+[.,]\d{2})\b/g;

  lines.forEach((line, lineIndex) => {
    for (const match of line.matchAll(pattern)) {
      const matchEnd = (match.index ?? 0) + match[0].length;
      if (line.slice(matchEnd).trimStart().startsWith("%")) continue;
      if (isTechnicalNumber(line, match.index ?? 0, matchEnd)) continue;
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

  if (preferMinor) {
    // Highest-confidence candidate that matches the cart. The label floor keeps
    // this from promoting a coincidental item price into the total.
    const reconciled = candidates.find(
      (candidate) => Math.abs(candidate.amountMinor - preferMinor) <= 1 && candidate.confidence >= 0.9,
    );
    if (reconciled) return { value: reconciled.amountMinor, confidence: reconciled.confidence };
  }

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

/** Every date the recognised text contains, in reading order. */
function collectDateCandidates(text: string): { value: string; confidence: number }[] {
  const found: { value: string; confidence: number }[] = [];

  for (const match of text.matchAll(
    /\b(20\d{2})[\-/.](0?[1-9]|1[0-2])[\-/.](0?[1-9]|[12]\d|3[01])\b/g,
  )) {
    if (isTechnicalNumber(text, match.index ?? 0, (match.index ?? 0) + match[0].length)) continue;
    const value = isoDate(Number(match[1]), Number(match[2]), Number(match[3]));
    if (value) found.push({ value, confidence: 0.94 });
  }

  for (const match of text.matchAll(
    /\b(0?[1-9]|[12]\d|3[01])[\-/.](0?[1-9]|[12]\d|3[01])[\-/.](20\d{2}|\d{2})\b/g,
  )) {
    if (isTechnicalNumber(text, match.index ?? 0, (match.index ?? 0) + match[0].length)) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    // European receipts print day-first. Treat ambiguous dates as DD/MM and
    // fall back to MM/DD only when the second value cannot be a month.
    const monthFirstOnly = second > 12 && first <= 12;
    const day = monthFirstOnly ? second : first;
    const month = monthFirstOnly ? first : second;
    const unambiguous = first > 12 || second > 12;
    const value = isoDate(year, month, day);
    if (value) found.push({ value, confidence: unambiguous ? 0.88 : 0.68 });
  }

  const monthNames =
    "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
  for (const match of text.matchAll(
    new RegExp(
      `\\b(${monthNames})[\\s.\\-/]+(\\d{1,2})(?:st|nd|rd|th)?[,]?[\\s.\\-/]+(20\\d{2}|\\d{2})\\b`,
      "gi",
    ),
  )) {
    if (isTechnicalNumber(text, match.index ?? 0, (match.index ?? 0) + match[0].length)) continue;
    const monthToken = match[1].slice(0, 3).toLocaleLowerCase();
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthToken) + 1;
    const rawYear = Number(match[3]);
    const value = isoDate(rawYear < 100 ? 2000 + rawYear : rawYear, month, Number(match[2]));
    if (value) found.push({ value, confidence: 0.92 });
  }

  return found;
}

function daysBetween(a: string, b: string): number {
  const left = Date.parse(`${a}T12:00:00Z`);
  const right = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return Number.POSITIVE_INFINITY;
  return Math.abs(left - right) / 86_400_000;
}

/**
 * Resolves the receipt date across every date the text contains.
 *
 * A till often prints its date more than once, and OCR can read the copies
 * differently: one real scan produced both "16/01/2026" and "16/07/26" for the
 * same purchase because a 7 was misread as a 1. Taking the first match meant
 * reporting January with 0.88 confidence and no warning — confidently wrong,
 * which is worse than uncertain.
 *
 * Conflicting copies are therefore surfaced: the best-supported value is
 * pre-filled, confidence drops below the review threshold, and the caller
 * warns with both readings so the user decides.
 */
function extractDate(text: string): {
  value: string;
  confidence: number;
  conflicting: string[];
} {
  const candidates = collectDateCandidates(text);
  if (!candidates.length) {
    return { value: todayIsoDate(), confidence: 0.08, conflicting: [] };
  }

  const tally = new Map<string, { votes: number; confidence: number }>();
  for (const candidate of candidates) {
    const entry = tally.get(candidate.value) ?? { votes: 0, confidence: 0 };
    entry.votes += 1;
    entry.confidence = Math.max(entry.confidence, candidate.confidence);
    tally.set(candidate.value, entry);
  }

  const distinct = [...tally.entries()];
  if (distinct.length === 1) {
    return { value: distinct[0][0], confidence: distinct[0][1].confidence, conflicting: [] };
  }

  // Most corroborated wins. A receipt is normally scanned soon after the
  // purchase, so break a tie toward the reading nearest the scan date; the
  // warning still asks the user to confirm, so this is only a starting point.
  const today = todayIsoDate();
  distinct.sort((a, b) => {
    if (b[1].votes !== a[1].votes) return b[1].votes - a[1].votes;
    return daysBetween(a[0], today) - daysBetween(b[0], today);
  });

  return {
    value: distinct[0][0],
    confidence: 0.5,
    conflicting: distinct.map(([value]) => value),
  };
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
  // OCR often splits a shop logo into one fragment per glyph, so the row
  // rebuilds as "A L Di". Collapse a run of very short tokens back together
  // before matching, but leave normal wording such as "A PAYER" alone.
  const collapseSpacedGlyphs = (value: string): string => {
    const tokens = value.trim().split(/\s+/);
    if (tokens.length < 3 || !tokens.every((token) => token.length <= 2)) return value;
    return tokens.join("");
  };
  // A logo can also rebuild as "ALD I" or "Ald I", which the rule above will
  // not touch. Known shop names are distinctive enough to match with every
  // space removed.
  const withoutSpaces = (value: string): string => value.replace(/\s+/g, "");

  const knownMerchants: { pattern: RegExp; name: string }[] = [
    { pattern: /\baldi\b/i, name: "ALDI" },
    { pattern: /\blidl\b/i, name: "LIDL" },
    { pattern: /\bcarrefour\b/i, name: "Carrefour" },
    { pattern: /\be\.?\s*leclerc\b/i, name: "E.Leclerc" },
    { pattern: /\bintermarch[eé]\b/i, name: "Intermarché" },
    { pattern: /\bauchan\b/i, name: "Auchan" },
  ];
  // A stylised logo defeats exact matching: "Intermarché" came back as
  // "internaRChe" (a single m→n substitution). The merchant drives duplicate
  // detection and categorisation, so it is worth recovering by edit distance
  // against the short list of known chains. Names are distinctive enough that
  // one or two edits cannot collide between them.
  const letterKey = (value: string): string =>
    value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase().replace(/[^a-z]/g, "");
  const fuzzyKnownMerchant = (line: string): string | null => {
    const key = letterKey(line);
    if (key.length < 4) return null;
    for (const merchant of knownMerchants) {
      const target = letterKey(merchant.name);
      const budget = target.length >= 8 ? 2 : 1;
      if (Math.abs(key.length - target.length) > budget) continue;
      if (levenshteinDistance(key, target) <= budget) return merchant.name;
    }
    return null;
  };

  for (const line of lines.slice(0, 14)) {
    const collapsed = collapseSpacedGlyphs(line);
    const known = knownMerchants.find(
      (merchant) =>
        merchant.pattern.test(line) ||
        merchant.pattern.test(collapsed) ||
        merchant.pattern.test(withoutSpaces(line)),
    );
    if (known) return { value: known.name, confidence: 0.96 };
    const fuzzy = fuzzyKnownMerchant(line) ?? fuzzyKnownMerchant(collapsed);
    // Slightly lower confidence than an exact hit: the name was repaired.
    if (fuzzy) return { value: fuzzy, confidence: 0.88 };
  }

  const candidates = lines
    .slice(0, 14)
    .map((line) => line.trim())
    .filter((line) => !isMerchantNoise(line))
    .map((line, index) => ({ line, index }));

  const best = candidates[0];
  if (!best) return { value: "", confidence: 0 };
  best.line = collapseSpacedGlyphs(best.line);
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

/**
 * Reads the article count a till prints about itself, e.g. the French
 * "Nombre de lignes d'articles 9". Comparing it with the number of items
 * actually recognised is the cheapest reliable way to notice that a capture
 * missed part of a long receipt.
 */
function extractDeclaredItemCount(lines: string[]): number | null {
  // OCR drops spaces into the middle of words ("d'art icles"), so the label is
  // matched against the line with all whitespace removed.
  const squashedPatterns = [
    /nombredelignes?d.{0,2}articles?:?(\d{1,3})\b/i,
    // "Nombre d'articles vendus= 6", read as "Nonbre" on a real receipt.
    /n[o0][mn]?bre?d.{0,2}articles?(?:vendus|achetes)?[:=]?(\d{1,3})\b/i,
    /nb\.?(?:d.{0,2})?articles?:?(\d{1,3})\b/i,
    /itemcount:?(\d{1,3})\b/i,
  ];
  const loosePatterns = [
    /\b(\d{1,3})\s+articles?\b/i,
    /\b(\d{1,3})\s+items?\s+(?:sold|purchased|total)\b/i,
  ];

  const accept = (raw: string): number | null => {
    const count = Number(raw);
    return Number.isFinite(count) && count > 0 && count < 300 ? count : null;
  };

  for (const line of lines) {
    const squashed = line.replace(/\s+/g, "");
    for (const pattern of squashedPatterns) {
      const match = pattern.exec(squashed);
      const count = match ? accept(match[1]) : null;
      if (count !== null) return count;
    }
  }
  for (const line of lines) {
    for (const pattern of loosePatterns) {
      const match = pattern.exec(line);
      const count = match ? accept(match[1]) : null;
      if (count !== null) return count;
    }
  }
  return null;
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
  const amountFirstPass = extractAmount(analysisLines);
  const date = extractDate(text);
  const merchantLines = visualLines.length ? visualLines : lines;
  const merchant = extractMerchant(merchantLines);
  const merchantAddress = extractMerchantAddress(merchantLines, merchant.value);
  const category = extractCategory(text, merchant.value);
  const preTaxMinor = extractPreTax(analysisLines);
  const taxMinor = extractTax(analysisLines);
  const detectedLineItems = extractReceiptLineItems(lines, visualLines);
  const declaredItemCount = extractDeclaredItemCount(analysisLines);
  // A cart line priced at exactly the receipt total is the total itself or a
  // payment tender, never a product: with two or more items, no single product
  // can equal their sum unless the rest are free. This holds whatever the till
  // calls the line, so it catches tender wording OCR has mangled past
  // recognition. Never applied when it would empty the cart, and never to a
  // genuine single-item receipt where the item legitimately is the total.
  const withoutTotalPricedLine = (items: ReceiptLineItem[], totalMinor: number | null): ReceiptLineItem[] => {
    if (totalMinor === null || items.length <= 1) return items;
    const kept = items.filter((item) => item.lineTotalMinor !== totalMinor);
    return kept.length > 0 ? kept : items;
  };
  // Resolve the total in two passes: the first pass cleans the cart, the cart
  // then arbitrates between competing labelled totals, and the final amount
  // cleans the cart again. Only a cart believed complete may arbitrate, so a
  // scan that missed items cannot drag the total down to match itself.
  const firstPassItems = withoutTotalPricedLine(detectedLineItems, amountFirstPass.value);
  const firstPassCartMinor = firstPassItems.reduce((total, item) => total + (item.lineTotalMinor ?? 0), 0);
  const cartLooksComplete = firstPassItems.length > 1
    && (declaredItemCount === null || declaredItemCount === firstPassItems.length);
  const amount = cartLooksComplete && firstPassCartMinor > 0
    ? extractAmount(analysisLines, firstPassCartMinor)
    : amountFirstPass;
  const lineItems = withoutTotalPricedLine(detectedLineItems, amount.value);
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
  // A very low score means no date was printed in the recognised text at all.
  // Tills almost always print one, near the payment details at the foot of the
  // receipt, so the usual cause is a capture that stopped short of the bottom.
  if (fieldConfidence.date < 0.2) {
    warnings.push(
      "No date found. The bottom of the receipt, where the date and payment details are printed, may not be in the scan. Add a section covering it, or set the date below.",
    );
  } else if (date.conflicting.length > 1) {
    warnings.push(
      `This receipt shows more than one date (${date.conflicting
        .map((value) => formatLongDate(value))
        .join(" and ")}). ${formatLongDate(date.value)} was used — confirm it is right.`,
    );
  } else if (fieldConfidence.date < 0.72) {
    warnings.push("Check the receipt date.");
  }

  // The receipt's own article count is authoritative about how many products
  // it lists, so a shortfall means the scan or the parse missed some.
  const itemCountMatches = declaredItemCount === null || declaredItemCount === lineItems.length;
  if (!itemCountMatches) {
    warnings.push(
      `This receipt lists ${declaredItemCount} items but ${lineItems.length} were detected. Check the scan covers the whole receipt.`,
    );
  }

  // Reconcile the cart against the receipt total. A single misread digit in a
  // price is otherwise invisible: 12,87 read as 12,67 and 3,58 as 3,53 left a
  // complete-looking nine-item cart 25 cents short of the total. Only checked
  // when the cart is believed complete, so this does not pile onto the warning
  // above.
  const cartTotalMinor = lineItems.reduce((total, item) => total + (item.lineTotalMinor ?? 0), 0);
  if (itemCountMatches && amount.value && lineItems.length > 0) {
    const difference = Math.abs(cartTotalMinor - amount.value);
    if (difference > 1) {
      warnings.push(
        `The items add up to ${formatMoney(cartTotalMinor)} but the receipt total is ${formatMoney(amount.value)}. Check the item prices; a discount or deposit can also explain the difference.`,
      );
    }
  }
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
    declaredItemCount,
    conflictingDates: date.conflicting,
  };
}
