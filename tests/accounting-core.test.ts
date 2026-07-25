import { describe, expect, it } from "vitest";

import { calculateSummary, findDuplicateTransaction } from "../lib/db";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  mergeReceiptSections,
  parseReceiptText,
} from "../lib/receipt-parser";
import {
  getPeriodRange,
  isDateInPeriodRange,
  parseAmountToMinor,
  todayIsoDate,
  type Transaction,
} from "../lib/types";

function transaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: "tx-1",
    type: "expense",
    amountMinor: 1_000,
    date: "2026-07-01",
    categoryId: "groceries",
    categoryName: "Groceries",
    categoryIcon: "shopping-cart",
    categoryColor: "#21C7A8",
    merchant: "Market",
    description: "Purchase",
    notes: "",
    receiptUri: null,
    ocrText: null,
    extractionSource: "manual",
    lineItems: [],
    createdAt: "2026-07-01T10:00:00.000Z",
    updatedAt: "2026-07-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("receipt parser", () => {
  it("extracts a labeled total, ISO date, merchant, and grocery category with high confidence", () => {
    const result = parseReceiptText(`WHOLE FOODS MARKET\n123 Main Street\n2026-07-12 18:42\nSubtotal $49.10\nTax $5.13\nTOTAL $54.23\nVISA $54.23`);

    expect(result.amountMinor).toBe(5_423);
    expect(result.date).toBe("2026-07-12");
    expect(result.merchant).toBe("Whole Foods Market");
    expect(result.categoryId).toBe("groceries");
    expect(result.overallConfidence).toBeGreaterThanOrEqual(HIGH_CONFIDENCE_THRESHOLD);
    expect(result.warnings).toEqual([]);
  });

  it("extracts grocery line items without treating totals as cart entries", () => {
    const result = parseReceiptText(`CITY MARKET\nApples Gala 2.50\nPasta 1.20\nSubtotal 3.70\nTax 0.30\nTOTAL 4.00`);

    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["Apples Gala", 250],
      ["Pasta", 120],
    ]);
  });

  it("extracts item prices placed on the following OCR line", () => {
    const result = parseReceiptText(`FRESH SHOP\nFREE RANGE EGGS\n3.25\nBANANAS\n2 x 0.80\nTOTAL 4.85`);

    expect(result.lineItems.map((item) => [item.name, item.quantity, item.lineTotalMinor])).toEqual([
      ["FREE RANGE EGGS", null, 325],
      ["BANANAS", 2, 160],
    ]);
  });

  it("uses ML Kit visual rows rather than flattened receipt columns", () => {
    const result = parseReceiptText(
      `OEUFS SOL X30\n1 X\nBAC PISTACHE\n1 X\n6,99 € 1\n6,99 €\n2,69 € 1\n2,69 €\nA PAYER 14,82 €`,
      [
        { text: "OEUFS SOL X30", top: 10, bottom: 18, left: 0, elements: [{ text: "OEUFS SOL X30", left: 0 }] },
        { text: "6,99 € 1", top: 11, bottom: 19, left: 220, elements: [{ text: "6,99 € 1", left: 220 }] },
        { text: "1 X", top: 28, bottom: 36, left: 20, elements: [{ text: "1 X", left: 20 }] },
        { text: "6,99 €", top: 29, bottom: 37, left: 220, elements: [{ text: "6,99 €", left: 220 }] },
        { text: "BAC PISTACHE", top: 48, bottom: 56, left: 0, elements: [{ text: "BAC PISTACHE", left: 0 }] },
        { text: "2,69 € 1", top: 49, bottom: 57, left: 220, elements: [{ text: "2,69 € 1", left: 220 }] },
        { text: "1 X", top: 66, bottom: 74, left: 20, elements: [{ text: "1 X", left: 20 }] },
        { text: "2,69 €", top: 67, bottom: 75, left: 220, elements: [{ text: "2,69 €", left: 220 }] },
        { text: "A PAYER", top: 88, bottom: 96, left: 0, elements: [{ text: "A PAYER", left: 0 }] },
        { text: "14,82 €", top: 89, bottom: 97, left: 220, elements: [{ text: "14,82 €", left: 220 }] },
      ],
    );

    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["OEUFS SOL X30", 699],
      ["BAC PISTACHE", 269],
    ]);
  });

  it("reconstructs the captured ALDI receipt without merging adjacent rows", () => {
    const result = parseReceiptText(
      `ZAC de la Poutche, ALDI 32220 Lombez, France\n0EUFS SOL X30\n1x\nBAC PISTACHE\n1x 2,69 €\nCHAOURCE AOP 250G\n6,99 €\n1x 3,55 €\nJAMBON SANS NÍ TRITE 1406\n1x 1,59 e\nÅ PAYER\nTOTAL HI\nTOTAL TVA\nC8\n6,99 e 1\n2,69 € 1\n3,55 1\n14,82 e\n14,05 €\n0,77 €\n1,59 e 1`,
      [
        { text: "ZAC de la Poutche, ALDI 32220 Lombez, France", top: 1100, bottom: 1170, left: 500, elements: [{ text: "ZAC de la Poutche, ALDI 32220 Lombez, France", left: 500 }] },
        { text: "0EUFS SOL X30", top: 1528, bottom: 1601, left: 717, elements: [{ text: "0EUFS SOL X30", left: 717 }] },
        { text: "6,99 e 1", top: 1565, bottom: 1629, left: 1797, elements: [{ text: "6,99", left: 1797 }, { text: "e", left: 1969 }, { text: "1", left: 2041 }] },
        { text: "1x", top: 1603, bottom: 1677, left: 932, elements: [{ text: "1x", left: 932 }] },
        { text: "6,99 €", top: 1610, bottom: 1686, left: 1154, elements: [{ text: "6,99 €", left: 1154 }] },
        { text: "BAC PISTACHE", top: 1668, bottom: 1743, left: 712, elements: [{ text: "BAC PISTACHE", left: 712 }] },
        { text: "2,69 € 1", top: 1705, bottom: 1771, left: 1804, elements: [{ text: "2,69 € 1", left: 1804 }] },
        { text: "1x 2,69 €", top: 1746, bottom: 1822, left: 931, elements: [{ text: "1x 2,69 €", left: 931 }] },
        { text: "CHAOURCE AOP 250G", top: 1813, bottom: 1890, left: 708, elements: [{ text: "CHAOURCE AOP 250G", left: 708 }] },
        { text: "3,55 1", top: 1844, bottom: 1916, left: 1848, elements: [{ text: "3,55 1", left: 1848 }] },
        { text: "JAMBON SANS NÍ TRITE 1406", top: 1956, bottom: 2046, left: 707, elements: [{ text: "JAMBON SANS NÍ TRITE 1406", left: 707 }] },
        { text: "1,59 e 1", top: 1990, bottom: 2060, left: 1830, elements: [{ text: "1,59 e 1", left: 1830 }] },
        { text: "Å PAYER", top: 2291, bottom: 2367, left: 735, elements: [{ text: "Å PAYER", left: 735 }] },
        { text: "14,82 e", top: 2313, bottom: 2383, left: 1811, elements: [{ text: "14,82 e", left: 1811 }] },
        { text: "14,05 €", top: 2374, bottom: 2460, left: 1810, elements: [{ text: "14,05 €", left: 1810 }] },
        { text: "TOTAL HI", top: 2375, bottom: 2448, left: 691, elements: [{ text: "TOTAL HI", left: 691 }] },
        { text: "TOTAL TVA", top: 2456, bottom: 2530, left: 688, elements: [{ text: "TOTAL TVA", left: 688 }] },
        { text: "0,77 €", top: 2472, bottom: 2545, left: 1844, elements: [{ text: "0,77 €", left: 1844 }] },
        { text: "C8", top: 2550, bottom: 2620, left: 690, elements: [{ text: "C8", left: 690 }] },
        { text: "14,82 €", top: 2560, bottom: 2630, left: 1810, elements: [{ text: "14,82 €", left: 1810 }] },
      ],
    );

    expect(result.merchant).toBe("ALDI");
    expect(result.merchantAddress).toBe("ZAC de la Poutche, 32220 Lombez, France");
    expect(result.description).toBe("Receipt from ALDI — ZAC de la Poutche, 32220 Lombez, France");
    expect(result.amountMinor).toBe(1482);
    expect(result.preTaxMinor).toBe(1405);
    expect(result.taxMinor).toBe(77);
    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["OEUFS SOL X30", 699],
      ["BAC PISTACHE", 269],
      ["CHAOURCE AOP 250G", 355],
      ["JAMBON SANS NÍ TRITE 1406", 159],
    ]);
  });

  it("extracts French EUR/VAT-class rows and rejects an absurd address amount", () => {
    const result = parseReceiptText(`MARCHE LOCAL\nZAC DE LA FOURCHETTE 40769.00\nRAISIN NOIR VRAC\n0,315 kg X 6,39EURO/kg 2,01 EUR A\nFREED WHIT.MENT.FORT 2,18 EUR B\nHARICOT VERT VRAC\n0,100 kg X 4,99EURO/kg 0,50 EUR A\nMONTANT DU 19,77 EUR\n2 10E=2Vignettes\nMONTANT DU 19,77 EUR\nCARTE TRD CB 7,69 EUR`);

    expect(result.amountMinor).toBe(1977);
    expect(result.lineItems.map((item) => [item.name, item.quantity, item.lineTotalMinor])).toEqual([
      ["RAISIN NOIR VRAC", 0.315, 201],
      ["FREED WHIT.MENT.FORT", null, 218],
      ["HARICOT VERT VRAC", 0.1, 50],
    ]);
  });

  it("extracts French till items with a trailing article count", () => {
    const result = parseReceiptText(`OEUFS SOL X30 6,99 € 1\n1 x 6,99 €\nBAC PISTACHE 2,69 € 1\n1 x 2,69 €\nCHAOURCE AOP 250G 3,55 € 1\n1 x 3,55 €\nJAMBON SANS NITRITE 140G 1,59 € 1\n1 x 1,59 €\nNombre de lignes d'articles 4\nA PAYER 14,82 €\nTOTAL HT 14,05 €\nTOTAL TVA 0,77 €\nTIC 14,82 €`);

    expect(result.amountMinor).toBe(1482);
    expect(result.taxMinor).toBe(77);
    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["OEUFS SOL X30", 699],
      ["BAC PISTACHE", 269],
      ["CHAOURCE AOP 250G", 355],
      ["JAMBON SANS NITRITE 140G", 159],
    ]);
  });

  it("does not add French pre-tax, VAT, or tax-inclusive totals to the cart", () => {
    const result = parseReceiptText(`MARCHE LOCAL\nOEUFS FERMIERS\n3,25\nTOTAL HT\n14,05\nTVA 5,5%\n0,77\nTOTAL TTC\n14,82`);

    expect(result.preTaxMinor).toBe(1405);
    expect(result.taxMinor).toBe(77);
    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["OEUFS FERMIERS", 325],
    ]);
  });

  it("does not treat a VAT percentage as the transaction amount", () => {
    const result = parseReceiptText(`SHOP\nTVA 5,50%\nCustomer copy`);

    expect(result.amountMinor).toBeNull();
  });

  it("joins overlapping long-receipt OCR sections once", () => {
    expect(mergeReceiptSections([
      "Market\nApples 2.50\nPasta 1.20",
      "Apples 2.50\nPasta 1.20\nMilk 1.80\nTOTAL 5.50",
    ])).toBe("Market\nApples 2.50\nPasta 1.20\nMilk 1.80\nTOTAL 5.50");
  });

  it("keeps a distinct item whose only difference from the previous line is its price", () => {
    // Regression: similarity-based overlap deleted "LAIT 1,85" because it
    // scored ~0.89 against "LAIT 1,05". On receipts the price is often the
    // only distinguishing content, so digits must be significant.
    expect(mergeReceiptSections([
      "CARREFOUR\nPAIN 1,20\nLAIT 1,05",
      "LAIT 1,85\nOEUFS 2,99\nTOTAL 7,09",
    ])).toBe("CARREFOUR\nPAIN 1,20\nLAIT 1,05\nLAIT 1,85\nOEUFS 2,99\nTOTAL 7,09");
  });

  it("still merges an overlapped region read with letter-level OCR noise", () => {
    expect(mergeReceiptSections([
      "Market\nOEUFS SOL X30 6,99\nBAC PISTACHE 2,69",
      "0EUFS S0L X30 6,99\nBAC PlSTACHE 2,69\nMilk 1,80\nTOTAL 11,48",
    ])).toBe("Market\nOEUFS SOL X30 6,99\nBAC PISTACHE 2,69\nMilk 1,80\nTOTAL 11,48");
  });

  it("never merges away a differing date or total", () => {
    expect(mergeReceiptSections([
      "ALDI\n12/03/2026\nTOTAL 14,82",
      "12/08/2026\nTOTAL 14,92",
    ])).toBe("ALDI\n12/03/2026\nTOTAL 14,82\n12/08/2026\nTOTAL 14,92");
  });

  it("joins overlapping sections even when OCR reads the shared lines slightly differently", () => {
    expect(mergeReceiptSections([
      "Market\nOEUFS SOL X30 6,99\nBAC PISTACHE 2,69",
      "0EUFS SOL X30 6,99\nBAC P1STACHE 2,69\nMilk 1,80\nTOTAL 11,48",
    ])).toBe("Market\nOEUFS SOL X30 6,99\nBAC PISTACHE 2,69\nMilk 1,80\nTOTAL 11,48");
  });

  it("does not duplicate cart items from the overlapped region between sections", () => {
    const sectionOne = [
      { text: "CITY MARKET", top: 10, bottom: 18, left: 0, elements: [{ text: "CITY MARKET", left: 0 }] },
      { text: "OEUFS SOL X30 6,99 €", top: 30, bottom: 38, left: 0, elements: [{ text: "OEUFS SOL X30 6,99 €", left: 0 }] },
      { text: "BAC PISTACHE 2,69 €", top: 50, bottom: 58, left: 0, elements: [{ text: "BAC PISTACHE 2,69 €", left: 0 }] },
    ];
    // The second close-up photo restarts at the top of its own frame and
    // re-reads the overlapped row with a typical OCR variation (O → 0).
    const sectionTwo = [
      { text: "BAC P1STACHE 2,69 €", top: 8, bottom: 16, left: 0, elements: [{ text: "BAC P1STACHE 2,69 €", left: 0 }] },
      { text: "CHAOURCE AOP 250G 3,55 €", top: 28, bottom: 36, left: 0, elements: [{ text: "CHAOURCE AOP 250G 3,55 €", left: 0 }] },
      { text: "A PAYER 13,23 €", top: 48, bottom: 56, left: 0, elements: [{ text: "A PAYER 13,23 €", left: 0 }] },
    ];

    const result = parseReceiptText(
      mergeReceiptSections([
        "CITY MARKET\nOEUFS SOL X30 6,99 €\nBAC PISTACHE 2,69 €",
        "BAC P1STACHE 2,69 €\nCHAOURCE AOP 250G 3,55 €\nA PAYER 13,23 €",
      ]),
      [sectionOne, sectionTwo],
    );

    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["OEUFS SOL X30", 699],
      ["BAC PISTACHE", 269],
      ["CHAOURCE AOP 250G", 355],
    ]);
  });

  it("drops a re-scanned item whose name OCR differs but price matches", () => {
    const result = parseReceiptText(
      "MARKET\nJAMBON SANS NITRITE 140G 1,59 €\nCHAOURCE AOP 250G 3,55 €\nJAMBON SANS NÍ TRITE 1406 1,59 €\nTOTAL 5,14 €",
    );

    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["JAMBON SANS NITRITE 140G", 159],
      ["CHAOURCE AOP 250G", 355],
    ]);
  });

  it("keeps genuinely repeated same-price different products", () => {
    const result = parseReceiptText(
      "MARKET\nAPPLES GALA 1,99\nPEARS WILLIAMS 1,99\nTOTAL 3,98",
    );

    expect(result.lineItems.map((item) => [item.name, item.lineTotalMinor])).toEqual([
      ["APPLES GALA", 199],
      ["PEARS WILLIAMS", 199],
    ]);
  });

  it("parses ambiguous numeric dates day-first for European receipts", () => {
    const ambiguous = parseReceiptText("ALDI\n05/07/2026\nTOTAL 14,82");
    expect(ambiguous.date).toBe("2026-07-05");

    const dayFirst = parseReceiptText("ALDI\n25/12/2026\nTOTAL 14,82");
    expect(dayFirst.date).toBe("2026-12-25");

    const monthFirstOnly = parseReceiptText("US STORE\n12/25/2026\nTOTAL $14.82");
    expect(monthFirstOnly.date).toBe("2026-12-25");
  });

  it("flags incomplete OCR text instead of inventing a total", () => {
    const result = parseReceiptText("THANK YOU\nCustomer copy\nCard approved");

    expect(result.amountMinor).toBeNull();
    expect(result.overallConfidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD);
    expect(result.warnings).toContain("No reliable total was found.");
    expect(result.warnings.some((w) => w.startsWith("No date found."))).toBe(true);
  });
});

describe("cart noise from a real ALDI scan", () => {
  it("keeps the receipt total and meal-voucher tender out of the cart", () => {
    const result = parseReceiptText(
      "A L Di\nBANANE 5 FRUITS 0,99\nJAMBON SANS NITRITE 140G 1,59\nCHAOURCE AOP 250G 3,55\nTitre restaurant 19,81\nMONTANT 19,81",
    );

    expect(result.lineItems.map((item) => item.name)).toEqual([
      "BANANE 5 FRUITS",
      "JAMBON SANS NITRITE 140G",
      "CHAOURCE AOP 250G",
    ]);
    expect(result.amountMinor).toBe(1981);
  });

  it("rejects a stray OCR fragment that would borrow a neighbouring price", () => {
    const result = parseReceiptText("MARKET\nJAMBON SANS NITRITE 140G 1,59\n|x\n1,59\nMONTANT 1,59");

    expect(result.lineItems.map((item) => item.name)).toEqual(["JAMBON SANS NITRITE 140G"]);
  });

  it("recovers a shop name split into single glyphs", () => {
    const result = parseReceiptText("A L Di\nZAC DE LA POUTCHE\nBANANE 5 FRUITS 0,99\nMONTANT 0,99");

    expect(result.merchant).toBe("ALDI");
  });
});

describe("real ALDI scan captured 2026-07-25", () => {
  // Faithful to the on-device OCR diagnostic: the per-VAT-rate table prints a
  // bare "HT" and "MONTANT TVA" column, and the receipt's own totals only
  // appear once the description and price columns are rebuilt into rows.
  const receipt = [
    "ALD I",
    "NECTARINES BLANCHES VRAC 2,74",
    "0,686 kg x 3.99 \u20ac/kg",
    "BRL IS OIGNONS 200G 1,69",
    "TVA HT MONTANT TVA TTC",
    "1 5,50%",
    "HT",
    "25,55",
    "9,40",
    "MONTANT TVA",
    "1,41",
    "1,88",
    "TOTAL HT 34,95 \u20ac",
    "TOTAL TVA 3,29 \u20ac",
    "\u00c0 PAYER 38,24 \u20ac",
  ].join("\n");

  it("reads the receipt totals, not the per-rate VAT breakdown", () => {
    const result = parseReceiptText(receipt);
    expect(result.amountMinor).toBe(3_824);
    expect(result.preTaxMinor).toBe(3_495);
    expect(result.taxMinor).toBe(329);
  });

  it("treats a weight and unit-price line as part of the product above it", () => {
    const result = parseReceiptText(receipt);
    expect(result.lineItems.map((item) => item.name)).toEqual([
      "NECTARINES BLANCHES VRAC",
      "BRL IS OIGNONS 200G",
    ]);
  });

  it("recovers the shop name from a logo split as \"ALD I\"", () => {
    expect(parseReceiptText(receipt).merchant).toBe("ALDI");
  });

  it("says plainly when the receipt carried no readable date", () => {
    const result = parseReceiptText(receipt);
    expect(result.date).toBe(todayIsoDate());
    expect(result.warnings.some((w) => w.startsWith("No date found."))).toBe(true);
  });
});

describe("two-section ALDI rescan captured 2026-07-25", () => {
  it("keeps the price out of the description when the article count hugs the currency", () => {
    // Real row from the diagnostic: the count "1" sits hard against "\u20ac", so the
    // inline price pattern cannot claim it and the quantity line below supplies
    // the total. The description must not keep the price text.
    const result = parseReceiptText("MARCHE\nCAFE MOULU EXCELL 250G 12,87 \u20ac1\n3 x 4,29\n\u00c0 PAYER 12,87 \u20ac");

    expect(result.lineItems.map((item) => [item.name, item.quantity, item.lineTotalMinor])).toEqual([
      ["CAFE MOULU EXCELL 250G", 3, 1_287],
    ]);
  });

  it("reads the receipt date from the footer section of a two-part capture", () => {
    const result = parseReceiptText(
      "ALDI\nBANANES BIO 3,10\n\u00c0 PAYER 3,10 \u20ac\nOU77 101 005238 0160 16/07/2026 16:01:57\nle 16/07/26 a 16:01:46",
    );

    expect(result.date).toBe("2026-07-16");
    expect(result.warnings.some((w) => w.startsWith("No date found."))).toBe(false);
  });
});

describe("incomplete capture detection", () => {
  // Scan A of the real ALDI receipt stopped before the payment/fiscal block,
  // losing both printed dates and several products, while still showing the
  // receipt's own declared article count.
  it("warns when fewer items are found than the receipt declares", () => {
    const result = parseReceiptText(
      "ALDI\nNECTARINES BLANCHES VRAC 2,74\nBRL IS OIGNONS 200G 1,69\nNombre de lignes d'articles 9\n\u00c0 PAYER 38,24 \u20ac",
    );

    expect(result.declaredItemCount).toBe(9);
    expect(result.lineItems).toHaveLength(2);
    expect(result.warnings).toContain(
      "This receipt lists 9 items but 2 were detected. Check the scan covers the whole receipt.",
    );
  });

  it("stays quiet when the detected items match the declared count", () => {
    const result = parseReceiptText(
      "ALDI\n16/07/2026\nNECTARINES 2,74\nOIGNONS 1,69\nNombre de lignes d'articles 2\n\u00c0 PAYER 4,43 \u20ac",
    );

    expect(result.declaredItemCount).toBe(2);
    expect(result.warnings.some((w) => w.includes("were detected"))).toBe(false);
  });

  it("points at the uncaptured foot of the receipt when no date was read", () => {
    const result = parseReceiptText("ALDI\nNECTARINES 2,74\n\u00c0 PAYER 2,74 \u20ac");

    expect(result.warnings.some((w) => w.startsWith("No date found."))).toBe(true);
  });
});

describe("cart reconciliation against the receipt total", () => {
  // Third real scan of the ALDI receipt: nine items, correct count, but OCR
  // read 12,87 as 12,67 and 3,58 as 3,53, leaving the cart 25 cents short.
  it("flags a cart that does not add up to the total", () => {
    const result = parseReceiptText(
      [
        "ALDI",
        "16/07/2026",
        "CAFE MOULU EXCELL 250G 12,67 \u20ac 1",
        "CHOC DEGUS MIX 125G 3,53 \u20ac 1",
        "Nombre de lignes d'art icles 2",
        "\u00c0 PAYER 16,45 \u20ac",
      ].join("\n"),
    );

    expect(result.declaredItemCount).toBe(2);
    expect(result.warnings.some((w) => w.startsWith("The items add up to"))).toBe(true);
  });

  it("stays quiet when the cart reconciles exactly", () => {
    const result = parseReceiptText(
      [
        "ALDI",
        "16/07/2026",
        "CAFE MOULU EXCELL 250G 12,87 \u20ac 1",
        "CHOC DEGUS MIX 125G 3,58 \u20ac 1",
        "Nombre de lignes d'articles 2",
        "\u00c0 PAYER 16,45 \u20ac",
      ].join("\n"),
    );

    expect(result.warnings.some((w) => w.startsWith("The items add up to"))).toBe(false);
  });

  it("reads the article count even when OCR splits the word", () => {
    const result = parseReceiptText("ALDI\nPAIN 1,20\nNombre de lignes d'art icles 9\n\u00c0 PAYER 1,20 \u20ac");

    expect(result.declaredItemCount).toBe(9);
    expect(result.warnings.some((w) => w.includes("were detected"))).toBe(true);
  });

  it("does not also complain about the sum when items are known to be missing", () => {
    const result = parseReceiptText("ALDI\nPAIN 1,20\nNombre de lignes d'articles 9\n\u00c0 PAYER 38,24 \u20ac");

    expect(result.warnings.some((w) => w.includes("were detected"))).toBe(true);
    expect(result.warnings.some((w) => w.startsWith("The items add up to"))).toBe(false);
  });
});

describe("duplicate receipt detection", () => {
  const ledger = [
    transaction({ id: "aldi", amountMinor: 1_482, date: "2026-03-12", merchant: "ALDI" }),
    transaction({ id: "other-day", amountMinor: 1_482, date: "2026-03-13", merchant: "ALDI" }),
    transaction({ id: "income", type: "income", amountMinor: 1_482, date: "2026-03-12", merchant: "Refund" }),
  ];

  it("flags a receipt re-scanned with the same date and total", () => {
    const hit = findDuplicateTransaction(ledger, { amountMinor: 1_482, date: "2026-03-12" });
    expect(hit?.id).toBe("aldi");
  });

  it("ignores a different day, a different total, and income", () => {
    expect(findDuplicateTransaction(ledger, { amountMinor: 1_482, date: "2026-03-14" })).toBeUndefined();
    expect(findDuplicateTransaction(ledger, { amountMinor: 1_483, date: "2026-03-12" })).toBeUndefined();
    const incomeOnly = [transaction({ id: "i", type: "income", amountMinor: 500, date: "2026-03-12" })];
    expect(findDuplicateTransaction(incomeOnly, { amountMinor: 500, date: "2026-03-12" })).toBeUndefined();
  });

  it("never flags without a usable amount or date", () => {
    expect(findDuplicateTransaction(ledger, { amountMinor: null, date: "2026-03-12" })).toBeUndefined();
    expect(findDuplicateTransaction(ledger, { amountMinor: 1_482, date: "12/03/2026" })).toBeUndefined();
  });

  it("excludes the record being edited so it cannot flag itself", () => {
    expect(findDuplicateTransaction(ledger, { amountMinor: 1_482, date: "2026-03-12", excludeId: "aldi" })).toBeUndefined();
  });
});

describe("accounting summaries", () => {
  it("calculates current-month income, expenses, balance, and category percentages", () => {
    const rows = [
      transaction({ id: "income", type: "income", amountMinor: 10_000, categoryId: "salary", categoryName: "Salary", date: "2026-07-02" }),
      transaction({ id: "grocery", amountMinor: 2_000, date: "2026-07-03" }),
      transaction({ id: "dining", amountMinor: 1_000, date: "2026-07-04", categoryId: "dining", categoryName: "Dining" }),
      transaction({ id: "old", amountMinor: 9_000, date: "2026-06-30" }),
    ];

    const summary = calculateSummary(rows, "month", new Date(2026, 6, 13, 12));

    expect(summary.incomeMinor).toBe(10_000);
    expect(summary.expenseMinor).toBe(3_000);
    expect(summary.balanceMinor).toBe(7_000);
    expect(summary.transactionCount).toBe(3);
    expect(summary.categorySpending[0]).toMatchObject({ categoryId: "groceries", amountMinor: 2_000 });
    expect(summary.categorySpending[0].percentage).toBeCloseTo(2 / 3);
  });

  it("excludes future-dated records from month and year summaries", () => {
    const rows = [
      transaction({ id: "now", amountMinor: 1_000, date: "2026-07-03" }),
      transaction({ id: "future-month", amountMinor: 2_000, date: "2026-08-01" }),
      transaction({ id: "future-year", amountMinor: 4_000, date: "2027-01-01" }),
    ];

    const month = calculateSummary(rows, "month", new Date(2026, 6, 13, 12));
    expect(month.expenseMinor).toBe(1_000);
    expect(month.transactionCount).toBe(1);

    const year = calculateSummary(rows, "year", new Date(2026, 6, 13, 12));
    expect(year.expenseMinor).toBe(3_000);
    expect(year.transactionCount).toBe(2);

    const all = calculateSummary(rows, "all", new Date(2026, 6, 13, 12));
    expect(all.expenseMinor).toBe(7_000);
  });

  it("bounds period ranges at both ends and rolls over December correctly", () => {
    const july = getPeriodRange("month", new Date(2026, 6, 13, 12));
    expect(july).toEqual({ start: "2026-07-01", endExclusive: "2026-08-01" });
    expect(isDateInPeriodRange("2026-07-03", july)).toBe(true);
    expect(isDateInPeriodRange("2026-08-01", july)).toBe(false);
    expect(isDateInPeriodRange("2026-06-30", july)).toBe(false);

    const december = getPeriodRange("month", new Date(2026, 11, 15, 12));
    expect(december).toEqual({ start: "2026-12-01", endExclusive: "2027-01-01" });
    expect(isDateInPeriodRange("2026-12-31", december)).toBe(true);
    expect(isDateInPeriodRange("2027-01-01", december)).toBe(false);

    const year = getPeriodRange("year", new Date(2026, 6, 13, 12));
    expect(year).toEqual({ start: "2026-01-01", endExclusive: "2027-01-01" });

    const all = getPeriodRange("all", new Date(2026, 6, 13, 12));
    expect(all).toEqual({ start: null, endExclusive: null });
    expect(isDateInPeriodRange("1999-01-01", all)).toBe(true);
  });
});

describe("amount input", () => {
  it("stores valid decimal values in minor units and rejects non-positive values", () => {
    expect(parseAmountToMinor("$1,234.56")).toBe(123_456);
    expect(parseAmountToMinor("12,34")).toBe(1_234);
    expect(parseAmountToMinor("1 234,56")).toBe(123_456);
    expect(parseAmountToMinor("1.234,56")).toBe(123_456);
    expect(parseAmountToMinor("0")).toBeNull();
    expect(parseAmountToMinor("not an amount")).toBeNull();
  });
});
