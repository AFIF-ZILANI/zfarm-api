import { z } from "zod";

/** Whole paisa, and no more than the numeric(10,2) columns hold. */
const MAX = 99_999_999.99;
export const taka = z.coerce
    .number()
    .positive("Amount must be positive")
    .max(MAX, "That's more than one payment can hold")
    .multipleOf(0.01, "Use at most two decimals");

const common = {
    amount: taka,
    payment_date: z.coerce.date(),
    transaction_ref: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).optional(),
};

export const payInput = z.object({
    ...common,
    from_instrument_id: z.string().uuid(),
    /** What the amount settles; whatever it doesn't name is kept as an advance. Omitted: oldest dues first. */
    split: z
        .object({
            opening: taka.optional(),
            bills: z.array(z.object({ purchase_id: z.string().uuid(), amount: taka })).max(500),
        })
        .optional(),
});

/** Money a supplier gives back, out of the advance they hold. */
export const refundSchema = z.object({ ...common, to_instrument_id: z.string().uuid() });

export const removePaymentSchema = z.object({
    reason: z.string().trim().min(3, "Say why it's removed"),
});

/** Owed from before FMS. 0 clears it. */
export const openingSchema = z.object({
    opening_due: z.coerce.number().min(0).max(MAX).multipleOf(0.01, "Use at most two decimals"),
    opening_date: z.coerce.date(),
    opening_note: z.string().trim().min(1).optional(),
});

const day = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
    .optional();
export const statementQuerySchema = z.object({ from: day, to: day });

export type StatementQuery = z.infer<typeof statementQuerySchema>;
export type PaySupplierInput = z.infer<typeof payInput> & { recorded_by_id: string };
export type RefundInput = z.infer<typeof refundSchema> & { recorded_by_id: string };
export type RemovePaymentInput = z.infer<typeof removePaymentSchema>;
export type OpeningInput = z.infer<typeof openingSchema>;
