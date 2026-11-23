import { z } from "zod";
import { taka } from "@validators/supplier-payment.validator";

// Plain numbers, not coerced: a blank must not become a 0 on a money approval.
const percent = z.number().min(0).max(100).multipleOf(0.01, "Use at most two decimals");
const reason = z.string().trim().min(3, "Say why");

export const decideSchema = z.object({
    batch_id: z.string().uuid(),
    /** The profit on the screen. A different figure by now is refused, so nothing unseen is approved. */
    expected_profit: z.number(),
    /** What the screen took off first. Left out, only the profit is checked. */
    expected: z
        .object({ recovered: z.number(), principal_taken: z.number(), loss_covered: z.number() })
        .optional(),
    /** For this batch only; left out, the farm's own percentages. */
    pct: z
        .object({ reinvest: percent, reserve: percent, owner: percent, tax: percent })
        .refine((p) => Math.round((p.reinvest + p.reserve + p.owner) * 100) === 10_000, {
            message: "The three shares must add up to 100",
        })
        .refine((p) => p.tax <= p.reserve, {
            message: "Tax is part of the reserve, so it can't be more",
            path: ["tax"],
        })
        .optional(),
});

export const skipSchema = z.object({ batch_id: z.string().uuid(), reason });
export const reasonSchema = z.object({ reason });

export const moveSchema = z.object({
    move: z.enum(["TO_REINVEST", "TO_RESERVE", "FROM_RESERVE"]),
    amount: taka,
    payment_date: z.coerce.date(),
    operating_instrument_id: z.string().uuid(),
    transaction_ref: z.string().trim().min(1).optional(),
    note: z.string().trim().min(1).optional(),
});

type Actor = { actor_id: string };
export type DecideInput = z.infer<typeof decideSchema> & Actor;
export type SkipInput = z.infer<typeof skipSchema> & Actor;
export type ReasonInput = z.infer<typeof reasonSchema> & Actor;
export type MoveInput = z.infer<typeof moveSchema> & Actor;
