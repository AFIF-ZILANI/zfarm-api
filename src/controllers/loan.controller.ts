import type { Context } from "hono";
import { getActorId } from "@lib/current-actor";
import { withHandler } from "@lib/helper";
import { sendSuccess } from "@lib/response";
import { getValid } from "@lib/valid";
import { LoanService } from "@services/loan.service";
import type { CreateLoanInput, PayInstallmentInput } from "@validators/loan.validator";

export const LoanController = {
    async getAll(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(c, await LoanService.getAll(), "Loans fetched successfully"),
        );
    },

    async getById(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(
                c,
                await LoanService.getById(c.req.param("id") ?? ""),
                "Loan fetched successfully",
            ),
        );
    },

    async create(c: Context) {
        return withHandler(c, async () => {
            const body = {
                ...getValid<CreateLoanInput>(c, "json"),
                recorded_by_id: await getActorId(c),
            };
            return sendSuccess(c, await LoanService.create(body), "Loan recorded", 201);
        });
    },

    async payInstallment(c: Context) {
        return withHandler(c, async () => {
            const body = {
                ...getValid<PayInstallmentInput>(c, "json"),
                handled_by_id: await getActorId(c),
            };
            const result = await LoanService.payInstallment(c.req.param("id") ?? "", body);
            return sendSuccess(c, result, "Installment recorded", 201);
        });
    },

    async remove(c: Context) {
        return withHandler(c, async () => {
            await LoanService.remove(c.req.param("id") ?? "", await getActorId(c));
            return sendSuccess(c, null, "Loan removed");
        });
    },
};
