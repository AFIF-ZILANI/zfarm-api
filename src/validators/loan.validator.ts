import { z } from "zod";

export const createLoanSchema = z
    .object({
        lender: z.string().trim().min(1, "Say who lent the money"),
        purpose: z.enum(["BATCH", "FARM", "LOSS", "OLD_DEBT"]),
        batch_id: z.string().uuid().optional(),
        principal: z.coerce.number().positive("Amount must be positive"),
        terms: z.enum(["EMI", "FLAT", "NONE"]),
        /** EMI: yearly percent, e.g. 12.5. */
        annual_rate: z.coerce.number().positive().max(100).optional(),
        /** FLAT: the total the lender says to repay. */
        total_payable: z.coerce.number().positive().optional(),
        installment_count: z.coerce.number().int().positive().max(600),
        frequency: z.enum(["MONTHLY", "WEEKLY", "ONE_OFF"]),
        first_due_on: z.coerce.date(),
        received_on: z.coerce.date(),
        /** The farm account the money landed in. Not for an old debt: no money comes in. */
        to_instrument_id: z.string().uuid().optional(),
        transaction_ref: z.string().optional(),
        note: z.string().trim().optional(),
    })
    .superRefine((d, ctx) => {
        const issue = (path: string, message: string) =>
            ctx.addIssue({ code: "custom", path: [path], message });
        if ((d.purpose === "BATCH") !== (d.batch_id !== undefined))
            issue(
                "batch_id",
                d.purpose === "BATCH" ? "Pick the batch" : "Only a batch loan names a batch",
            );
        if (d.terms === "EMI" && d.annual_rate === undefined)
            issue("annual_rate", "Enter the yearly rate");
        if (d.terms !== "EMI" && d.annual_rate !== undefined)
            issue("annual_rate", "Only an EMI loan has a rate");
        if (d.terms === "EMI" && d.frequency === "ONE_OFF")
            issue("frequency", "An EMI is paid monthly or weekly");
        if (d.terms === "FLAT") {
            if (d.total_payable === undefined) issue("total_payable", "Enter the total to repay");
            else if (d.total_payable < d.principal)
                issue("total_payable", "The total to repay can't be less than the amount borrowed");
        } else if (d.total_payable !== undefined) {
            issue("total_payable", "Only a flat-rate loan states its total");
        }
        if (d.frequency === "ONE_OFF" && d.installment_count !== 1)
            issue("installment_count", "A one-off repayment is one installment");
        if (d.purpose === "OLD_DEBT") {
            if (d.to_instrument_id !== undefined)
                issue("to_instrument_id", "An old debt brings no money in");
        } else if (d.to_instrument_id === undefined) {
            issue("to_instrument_id", "Say which account the money landed in");
        }
    });

export const payInstallmentSchema = z
    .object({
        amount: z.coerce.number().positive("Amount must be positive"),
        payment_date: z.coerce.date(),
        from_instrument_id: z.string().uuid(),
        /** The interest part, as on the lender's statement. Omitted: the loan's own share of interest. */
        interest: z.coerce.number().nonnegative().optional(),
        transaction_ref: z.string().optional(),
        note: z.string().trim().optional(),
    })
    .refine((d) => d.interest === undefined || d.interest <= d.amount, {
        message: "Interest can't be more than the installment",
        path: ["interest"],
    });

export type CreateLoanInput = z.infer<typeof createLoanSchema> & { recorded_by_id: string };
export type PayInstallmentInput = z.infer<typeof payInstallmentSchema> & { handled_by_id: string };
