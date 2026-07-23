import { describe, expect, it } from "vitest";

import { calculateSummary } from "../lib/db";
import {
  HIGH_CONFIDENCE_THRESHOLD,
  mergeReceiptSections,
  parseReceiptText,
} from "../lib/receipt-parser";
import { parseAmountToMinor, type Transaction } from "../lib/types";

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

  it("flags incomplete OCR text instead of inventing a total", () => {
    const result = parseReceiptText("THANK YOU\nCustomer copy\nCard approved");

    expect(result.amountMinor).toBeNull();
    expect(result.overallConfidence).toBeLessThan(HIGH_CONFIDENCE_THRESHOLD);
    expect(result.warnings).toContain("No reliable total was found.");
    expect(result.warnings).toContain("Check the receipt date.");
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
