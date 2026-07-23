import { z } from "zod";

import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { invokeLLM } from "./_core/llm";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";

const categoryIds = [
  "groceries",
  "fuel",
  "dining",
  "utilities",
  "entertainment",
  "health",
  "transport",
  "shopping",
  "rent",
  "salary",
  "other",
] as const;

const cloudReceiptResultSchema = z.object({
  amountMinor: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  merchant: z.string().max(120),
  description: z.string().max(180),
  categoryId: z.enum(categoryIds),
  amountConfidence: z.number().min(0).max(1),
  dateConfidence: z.number().min(0).max(1),
  merchantConfidence: z.number().min(0).max(1),
  categoryConfidence: z.number().min(0).max(1),
  overallConfidence: z.number().min(0).max(1),
  warning: z.string().max(240),
});

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return { success: true } as const;
    }),
  }),
  receipt: router({
    extractFromText: publicProcedure
      .input(
        z.object({
          ocrText: z.string().trim().min(5).max(12_000),
          currentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        }),
      )
      .mutation(async ({ input }) => {
        const response = await invokeLLM({
          model: "gpt-5-mini",
          messages: [
            {
              role: "system",
              content:
                "You extract one accounting transaction from OCR receipt text. Use only evidence in the text. The amount is the final paid/due total in minor currency units (for example €12.34 is 1234). Dates must be YYYY-MM-DD. Choose exactly one allowed category. Confidence values are 0 to 1. Use the current date only to resolve a missing receipt year; never invent other values. Return an empty warning when all key fields are reliable.",
            },
            {
              role: "user",
              content: `Current date: ${input.currentDate}\nAllowed categories: ${categoryIds.join(", ")}\n\nOCR receipt text:\n${input.ocrText}`,
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "receipt_transaction",
              strict: true,
              schema: {
                type: "object",
                properties: {
                  amountMinor: { type: "integer" },
                  date: { type: "string" },
                  merchant: { type: "string" },
                  description: { type: "string" },
                  categoryId: { type: "string", enum: [...categoryIds] },
                  amountConfidence: { type: "number" },
                  dateConfidence: { type: "number" },
                  merchantConfidence: { type: "number" },
                  categoryConfidence: { type: "number" },
                  overallConfidence: { type: "number" },
                  warning: { type: "string" },
                },
                required: [
                  "amountMinor",
                  "date",
                  "merchant",
                  "description",
                  "categoryId",
                  "amountConfidence",
                  "dateConfidence",
                  "merchantConfidence",
                  "categoryConfidence",
                  "overallConfidence",
                  "warning",
                ],
                additionalProperties: false,
              },
            },
          },
        });

        const content = response.choices[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new Error("Cloud extraction returned no structured result.");
        }
        return cloudReceiptResultSchema.parse(JSON.parse(content));
      }),
  }),
});

export type AppRouter = typeof appRouter;
