import type { Context } from "hono";
import { getActorId } from "@lib/current-actor";
import { withHandler } from "@lib/helper";
import { sendSuccess } from "@lib/response";
import { getValid } from "@lib/valid";
import { SupplierPaymentService } from "@services/supplier-payment.service";
import type {
    OpeningInput,
    PaySupplierInput,
    RefundInput,
    RemovePaymentInput,
} from "@validators/supplier-payment.validator";

const id = (c: Context) => c.req.param("id") ?? "";

export const SupplierPaymentController = {
    async dues(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(c, await SupplierPaymentService.dues(id(c)), "Supplier dues fetched"),
        );
    },

    async pay(c: Context) {
        return withHandler(c, async () => {
            const body = {
                ...getValid<PaySupplierInput>(c, "json"),
                recorded_by_id: await getActorId(c),
            };
            return sendSuccess(
                c,
                await SupplierPaymentService.pay(id(c), body),
                "Supplier paid",
                201,
            );
        });
    },

    async refund(c: Context) {
        return withHandler(c, async () => {
            const body = {
                ...getValid<RefundInput>(c, "json"),
                recorded_by_id: await getActorId(c),
            };
            return sendSuccess(
                c,
                await SupplierPaymentService.refund(id(c), body),
                "Refund recorded",
                201,
            );
        });
    },

    async remove(c: Context) {
        return withHandler(c, async () => {
            const { reason } = getValid<RemovePaymentInput>(c, "json");
            const payment = c.req.param("paymentId") ?? "";
            await SupplierPaymentService.remove(id(c), payment, reason, await getActorId(c));
            return sendSuccess(c, null, "Supplier payment removed");
        });
    },

    async setOpening(c: Context) {
        return withHandler(c, async () => {
            const body = getValid<OpeningInput>(c, "json");
            const supplier = await SupplierPaymentService.setOpening(
                id(c),
                body,
                await getActorId(c),
            );
            return sendSuccess(c, supplier, "Old balance saved");
        });
    },
};
