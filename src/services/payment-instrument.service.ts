import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";
import { AppError } from "@lib/app-error";
import { toSkipTake, buildMeta } from "@lib/pagination";
import type {
    CreatePaymentInstrumentInput,
    UpdatePaymentInstrumentInput,
    ListPaymentInstrumentsQuery,
} from "@validators/payment-instrument.validator";

/** The reinvestment and reserve money each sit in one active account (index PaymentInstrument_one_active_fund). */
async function oneActivePerFund<T>(write: () => Promise<T>): Promise<T> {
    try {
        return await write();
    } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")
            throw AppError.conflict(
                "There is already an active account for that fund. To replace it, transfer its money to an operating account, deactivate it, add the new one, then transfer the money on",
                {
                    fields: { fund: "Already has an active account" },
                },
            );
        throw e;
    }
}

export const PaymentInstrumentService = {
    async getAll(query: ListPaymentInstrumentsQuery) {
        const where = {
            ...(query.is_active !== undefined && { is_active: query.is_active === "true" }),
        };
        const [instruments, total] = await Promise.all([
            prisma.paymentInstrument.findMany({
                where,
                orderBy: { created_at: "desc" },
                ...toSkipTake(query),
            }),
            prisma.paymentInstrument.count({ where }),
        ]);
        return { instruments, meta: buildMeta(total, query) };
    },

    async getById(id: string) {
        const instrument = await prisma.paymentInstrument.findUnique({ where: { id } });
        if (!instrument) throw AppError.notFound("PaymentInstrument");
        return instrument;
    },

    async create(data: CreatePaymentInstrumentInput) {
        return oneActivePerFund(() =>
            prisma.paymentInstrument.create({
                data: {
                    type: data.type,
                    label: data.label,
                    ...(data.bank_name !== undefined && { bank_name: data.bank_name }),
                    ...(data.account_no !== undefined && { account_no: data.account_no }),
                    ...(data.mobile_no !== undefined && { mobile_no: data.mobile_no }),
                    ...(data.mfs_type !== undefined && { mfs_type: data.mfs_type }),
                    ...(data.fund !== undefined && { fund: data.fund }),
                },
            }),
        );
    },

    async update(id: string, data: UpdatePaymentInstrumentInput) {
        const instrument = await prisma.paymentInstrument.findUnique({
            where: { id },
            include: { _count: { select: { payments_from: true, payments_to: true } } },
        });
        if (!instrument) throw AppError.notFound("PaymentInstrument");

        const { type, label, bank_name, account_no, mobile_no, mfs_type, fund } = data;
        if (!type && !label && !bank_name && !account_no && !mobile_no && !mfs_type && !fund) {
            throw AppError.badRequest("No update fields provided");
        }

        // Where the money goes is part of the money trail: once a payment has moved through
        // this instrument, repointing it would rewrite history. Compared with the stored value
        // because the web's edit form re-sends both fields on every save.
        const changesIdentity =
            (account_no !== undefined && account_no !== instrument.account_no) ||
            (mobile_no !== undefined && mobile_no !== instrument.mobile_no) ||
            // Past cash, loan principal and losses were worked out with this account in its fund.
            (fund !== undefined && fund !== instrument.fund);
        if (
            changesIdentity &&
            instrument._count.payments_from + instrument._count.payments_to > 0
        ) {
            throw AppError.conflict(
                "This account has payment history -- create a new instrument and deactivate this one",
            );
        }

        return oneActivePerFund(() =>
            prisma.paymentInstrument.update({
                where: { id },
                data: {
                    ...(type && { type }),
                    ...(label && { label }),
                    ...(bank_name !== undefined && { bank_name }),
                    ...(account_no !== undefined && { account_no }),
                    ...(mobile_no !== undefined && { mobile_no }),
                    ...(mfs_type !== undefined && { mfs_type }),
                    ...(fund !== undefined && { fund }),
                },
            }),
        );
    },

    /**
     * Hard delete -- a mis-created instrument (wrong account number, duplicate) only.
     * Once any Payment has moved through it, in either direction, it is part of the
     * money trail and gets deactivated instead, so every payment still resolves to
     * the account it actually used.
     */
    async remove(id: string) {
        const instrument = await prisma.paymentInstrument.findUnique({
            where: { id },
            select: { _count: { select: { payments_from: true, payments_to: true } } },
        });
        if (!instrument) throw AppError.notFound("PaymentInstrument");

        const attached = instrument._count.payments_from + instrument._count.payments_to;
        if (attached > 0) {
            throw AppError.conflict(
                "Payment instrument has payment history and cannot be deleted. Deactivate it instead.",
            );
        }

        return prisma.paymentInstrument.delete({ where: { id } });
    },

    async setActive(id: string, is_active: boolean) {
        const instrument = await prisma.paymentInstrument.findUnique({ where: { id } });
        if (!instrument) throw AppError.notFound("PaymentInstrument");
        return oneActivePerFund(() =>
            prisma.paymentInstrument.update({ where: { id }, data: { is_active } }),
        );
    },

    /** incoming (payments_to) minus outgoing (payments_from), all-time. */
    async getBalance(id: string) {
        const instrument = await prisma.paymentInstrument.findUnique({ where: { id } });
        if (!instrument) throw AppError.notFound("PaymentInstrument");

        const [incoming, outgoing] = await Promise.all([
            prisma.payment.aggregate({ where: { to_instrument_id: id }, _sum: { amount: true } }),
            prisma.payment.aggregate({ where: { from_instrument_id: id }, _sum: { amount: true } }),
        ]);

        const incomingTotal = incoming._sum.amount ?? new Prisma.Decimal(0);
        const outgoingTotal = outgoing._sum.amount ?? new Prisma.Decimal(0);
        return {
            instrument_id: id,
            incoming: incomingTotal,
            outgoing: outgoingTotal,
            balance: incomingTotal.minus(outgoingTotal),
        };
    },
};
