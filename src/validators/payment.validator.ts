import { z } from "zod";
import { paginationQuerySchema } from "@lib/pagination";

/** Every ref a Payment row can carry, for reading. */
export const PAYMENT_REF_TYPES = [
    "SALE",
    "BIRD_SALE",
    "PURCHASE",
    "EXPENSE",
    "PAYROLL",
    "LOAN",
    "OWNER_CAPITAL",
    "OWNER_DRAW",
    "OTHER_IN",
    "OTHER_OUT",
    "TRANSFER",
] as const;

/** Cash-book rows with no bill behind them: ref_id is the payment's own id, never sent by a client. */
export const NO_BILL_REFS = [
    "OWNER_CAPITAL",
    "OWNER_DRAW",
    "OTHER_IN",
    "OTHER_OUT",
    "TRANSFER",
] as const;

/**
 * What a client may author a payment against. PAYROLL is absent on purpose: a
 * salary payment is emitted by confirming a PayrollPayout, which can require
 * proof of transfer, and Payment cannot. Queryable, not writable.
 * See docs/payroll-ledger-bridge.md. LOAN is absent too: an installment goes through
 * POST /loans/:id/installments, which also books its interest.
 */
const creatableRefType = z.enum(["SALE", "BIRD_SALE", "PURCHASE", "EXPENSE", ...NO_BILL_REFS]);
const refType = z.enum(PAYMENT_REF_TYPES);

/** Refs whose payment is money leaving the farm. Their source instrument is required. */
const OUTGOING_REFS: string[] = ["PURCHASE", "EXPENSE", "OWNER_DRAW", "OTHER_OUT"];
const isNoBill = (t: string) => (NO_BILL_REFS as readonly string[]).includes(t);

export const createPaymentSchema = z
    .object({
        amount: z.coerce.number().positive("Amount must be positive"),
        payment_date: z.coerce.date(),
        ref_type: creatableRefType,
        // ref_id is a polymorphic reference (resolved via ref_type), not a real
        // FK -- same pattern as StockLedger.ref_type/ref_id. Required for a bill, absent otherwise.
        ref_id: z.string().uuid().optional(),
        // The farm account on the side the money moved: money in names where it landed (to_instrument_id),
        // money out names where it left from (from_instrument_id). Only a TRANSFER names both.
        from_instrument_id: z.string().uuid().optional(),
        to_instrument_id: z.string().uuid().optional(),
        transaction_ref: z.string().optional(),
        note: z.string().trim().optional(),
    })
    .superRefine((d, ctx) => {
        const issue = (path: string, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message });

        if (isNoBill(d.ref_type)) {
            if (d.ref_id !== undefined) issue("ref_id", "This kind of payment has no bill");
            if ((d.ref_type === "OTHER_IN" || d.ref_type === "OTHER_OUT") && !d.note)
                issue("note", "Say what this money was");
        } else if (d.ref_id === undefined) {
            issue("ref_id", "Say which bill this pays");
        }

        if (d.ref_type === "TRANSFER") {
            if (d.from_instrument_id === undefined)
                issue("from_instrument_id", "Say which account the money left");
            if (d.to_instrument_id === undefined)
                issue("to_instrument_id", "Say which account the money went to");
            if (d.from_instrument_id !== undefined && d.from_instrument_id === d.to_instrument_id)
                issue("to_instrument_id", "Pick a different account to move the money to");
        } else if (OUTGOING_REFS.includes(d.ref_type)) {
            if (d.from_instrument_id === undefined)
                issue("from_instrument_id", "Say which account this was paid from");
            if (d.to_instrument_id !== undefined)
                issue("to_instrument_id", "Money paid out names only the account it left");
        } else {
            if (d.to_instrument_id === undefined)
                issue("to_instrument_id", "Say which account this was received into");
            if (d.from_instrument_id !== undefined)
                issue("from_instrument_id", "Money received names only the account it landed in");
        }
    });

export const listPaymentsQuerySchema = paginationQuerySchema.extend({
    ref_type: refType.optional(),
    ref_id: z.string().uuid().optional(),
    direction: z.enum(["INCOMING", "OUTGOING"]).optional(),
    instrument_id: z.string().uuid().optional(),
});

export const totalPaidQuerySchema = z.object({
    ref_type: refType,
    ref_id: z.string().uuid(),
});

export const outstandingQuerySchema = z.object({
    ref_type: refType,
});

export type OutstandingQuery = z.infer<typeof outstandingQuerySchema>;
export type CreatePaymentInput = z.infer<typeof createPaymentSchema> & { handled_by_id?: string };
export type PaymentRefType = (typeof PAYMENT_REF_TYPES)[number];
export type ListPaymentsQuery = z.infer<typeof listPaymentsQuerySchema>;
export type TotalPaidQuery = z.infer<typeof totalPaidQuerySchema>;
