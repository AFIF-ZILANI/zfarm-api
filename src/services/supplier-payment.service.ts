import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { audit } from "@lib/audit";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import { splitOldestFirst } from "@lib/supplier-split";
import { writePayment } from "@services/payment.service";
import { Prisma } from "../../prisma/generated/prisma/client";
import type {
    OpeningInput,
    PaySupplierInput,
    RefundInput,
} from "@validators/supplier-payment.validator";

/**
 * Money between the farm and a supplier (docs/superpowers/specs/2026-11-23-supplier-statement-design.md).
 *
 * A SupplierPayment is what was really handed over, once. The Payment rows under it say what each part
 * settled -- a bill (PURCHASE), the old balance (SUPPLIER_OPENING) or nothing yet (SUPPLIER_ADVANCE) -- and
 * always add up to it. Every write takes the supplier's lock, then its bills' locks in id order, so two at
 * once can't spend one advance or overpay a bill.
 */

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal | number | null | undefined) => new Prisma.Decimal(v ?? 0);

export const lockSupplier = (tx: Tx, supplier_id: string) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"supplier:" + supplier_id}, 0))`;

/** The same key writePayment locks a bill on. */
async function lockBills(tx: Tx, ids: string[]) {
    for (const id of [...new Set(ids)].sort())
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}

/** Paid ahead and not used yet, less what the supplier gave back. */
export async function advanceHeld(tx: Tx, supplier_id: string) {
    const rows = await tx.payment.groupBy({
        by: ["direction"],
        where: { ref_type: "SUPPLIER_ADVANCE", ref_id: supplier_id },
        _sum: { amount: true },
    });
    const sum = (d: "INCOMING" | "OUTGOING") => D(rows.find((r) => r.direction === d)?._sum.amount);
    return sum("OUTGOING").minus(sum("INCOMING"));
}

async function openingLeft(tx: Tx, supplier_id: string, opening_due: Prisma.Decimal) {
    const paid = await tx.payment.aggregate({
        where: { ref_type: "SUPPLIER_OPENING", ref_id: supplier_id },
        _sum: { amount: true },
    });
    return opening_due.minus(D(paid._sum.amount));
}

/** The supplier's bills with something left to pay, oldest first. */
async function openBills(tx: Tx, supplier_id: string) {
    const bills = await tx.purchase.findMany({
        where: { supplier_id },
        orderBy: [{ purchase_date: "asc" }, { created_at: "asc" }],
        select: {
            id: true,
            invoice_no: true,
            purchase_date: true,
            total_amount: true,
            due_amount: true,
        },
    });
    const paid = await tx.payment.groupBy({
        by: ["ref_id"],
        where: { ref_type: "PURCHASE", ref_id: { in: bills.map((b) => b.id) } },
        _sum: { amount: true },
    });
    const paidBy = new Map(paid.map((p) => [p.ref_id, D(p._sum.amount)]));
    return bills
        .map((b) => ({ ...b, due: b.due_amount.minus(paidBy.get(b.id) ?? 0) }))
        .filter((b) => b.due.greaterThan(0));
}

async function requireSupplier(tx: Tx, id: string) {
    const supplier = await tx.suppliers.findUnique({ where: { id } });
    if (!supplier) throw AppError.notFound("Supplier");
    return supplier;
}

async function requireActiveAccount(tx: Tx, id: string) {
    const account = await tx.paymentInstrument.findUnique({
        where: { id },
        select: { is_active: true, label: true },
    });
    if (!account) throw AppError.badRequest("The account named does not exist");
    if (!account.is_active)
        throw AppError.badRequest(`${account.label} is inactive -- pick an active account`);
}

/** The parts of an edited split; refuses anything beyond the amount or what each thing is owed. */
function editedSplit(
    amount: Prisma.Decimal,
    split: NonNullable<PaySupplierInput["split"]>,
    opening_left: Prisma.Decimal,
    bills: { id: string; due: Prisma.Decimal }[],
) {
    const dueBy = new Map(bills.map((b) => [b.id, b.due]));
    const opening = D(split.opening);
    const parts = split.bills.map((b) => ({ id: b.purchase_id, amount: D(b.amount) }));
    if (opening.greaterThan(opening_left))
        throw AppError.badRequest(`Only ${opening_left.toFixed(2)} of the old balance is left`);
    if (new Set(parts.map((b) => b.id)).size !== parts.length)
        throw AppError.badRequest("A bill is named twice");
    for (const b of parts) {
        const due = dueBy.get(b.id);
        if (!due)
            throw AppError.badRequest("A bill named isn't this supplier's, or has nothing due");
        if (b.amount.greaterThan(due))
            throw AppError.badRequest(`Only ${due.toFixed(2)} is due on a bill named`);
    }
    const advance = parts.reduce((left, b) => left.minus(b.amount), amount.minus(opening));
    if (advance.isNegative())
        throw AppError.badRequest("The parts add up to more than the amount paid");
    return { opening, bills: parts, advance };
}

export const SupplierPaymentService = {
    async dues(supplier_id: string) {
        const supplier = await requireSupplier(prisma, supplier_id);
        const [left, advance, bills] = await Promise.all([
            openingLeft(prisma, supplier_id, supplier.opening_due),
            advanceHeld(prisma, supplier_id),
            openBills(prisma, supplier_id),
        ]);
        return {
            opening_left: left.toFixed(2),
            advance: advance.toFixed(2),
            bills: bills.map((b) => ({
                id: b.id,
                invoice_no: b.invoice_no,
                purchase_date: b.purchase_date,
                total: b.total_amount.toFixed(2),
                due: b.due.toFixed(2),
            })),
        };
    },

    async pay(supplier_id: string, data: PaySupplierInput) {
        try {
            return await prisma.$transaction(async (tx) => {
                await lockSupplier(tx, supplier_id);
                const supplier = await requireSupplier(tx, supplier_id);
                await requireActiveAccount(tx, data.from_instrument_id);
                // A payment on a bill itself doesn't take the supplier's lock: hold every open bill, then read.
                await lockBills(
                    tx,
                    (await openBills(tx, supplier_id)).map((b) => b.id),
                );
                const bills = await openBills(tx, supplier_id);
                const left = await openingLeft(tx, supplier_id, supplier.opening_due);
                const amount = D(data.amount);
                const parts = data.split
                    ? editedSplit(amount, data.split, left, bills)
                    : splitOldestFirst(amount, left, bills);

                const group = await tx.supplierPayment.create({
                    data: {
                        supplier_id,
                        direction: "OUTGOING",
                        amount,
                        payment_date: data.payment_date,
                        instrument_id: data.from_instrument_id,
                        recorded_by_id: data.recorded_by_id,
                        ...(data.transaction_ref !== undefined && {
                            transaction_ref: data.transaction_ref,
                        }),
                        ...(data.note !== undefined && { note: data.note }),
                    },
                });
                const row = {
                    payment_date: data.payment_date,
                    from_instrument_id: data.from_instrument_id,
                    handled_by_id: data.recorded_by_id,
                    supplier_payment_id: group.id,
                    ...(data.transaction_ref !== undefined && {
                        transaction_ref: data.transaction_ref,
                    }),
                    ...(data.note !== undefined && { note: data.note }),
                };
                if (parts.opening.greaterThan(0))
                    await writePayment(tx, {
                        ...row,
                        ref_type: "SUPPLIER_OPENING",
                        ref_id: supplier_id,
                        amount: parts.opening.toNumber(),
                    });
                for (const b of parts.bills)
                    await writePayment(tx, {
                        ...row,
                        ref_type: "PURCHASE",
                        ref_id: b.id,
                        amount: b.amount.toNumber(),
                    });
                if (parts.advance.greaterThan(0))
                    await tx.payment.create({
                        data: {
                            ...row,
                            direction: "OUTGOING",
                            ref_type: "SUPPLIER_ADVANCE",
                            ref_id: supplier_id,
                            amount: parts.advance,
                        },
                    });
                return tx.supplierPayment.findUniqueOrThrow({
                    where: { id: group.id },
                    include: { payments: true },
                });
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    async refund(supplier_id: string, data: RefundInput) {
        try {
            return await prisma.$transaction(async (tx) => {
                await lockSupplier(tx, supplier_id);
                await requireSupplier(tx, supplier_id);
                await requireActiveAccount(tx, data.to_instrument_id);
                const held = await advanceHeld(tx, supplier_id);
                if (D(data.amount).greaterThan(held))
                    throw AppError.badRequest(
                        `This supplier holds an advance of ${held.toFixed(2)}`,
                        {
                            fields: { amount: `The advance held is ${held.toFixed(2)}` },
                        },
                    );
                const shared = {
                    direction: "INCOMING" as const,
                    amount: data.amount,
                    payment_date: data.payment_date,
                    ...(data.transaction_ref !== undefined && {
                        transaction_ref: data.transaction_ref,
                    }),
                    ...(data.note !== undefined && { note: data.note }),
                };
                return tx.supplierPayment.create({
                    data: {
                        ...shared,
                        supplier_id,
                        instrument_id: data.to_instrument_id,
                        recorded_by_id: data.recorded_by_id,
                        payments: {
                            create: {
                                ...shared,
                                ref_type: "SUPPLIER_ADVANCE",
                                ref_id: supplier_id,
                                to_instrument_id: data.to_instrument_id,
                                handled_by_id: data.recorded_by_id,
                            },
                        },
                    },
                    include: { payments: true },
                });
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    /** A supplier payment (or refund) entered by mistake: taken out whole, its dues come back. */
    async remove(supplier_id: string, payment_id: string, reason: string, actor_id: string) {
        await prisma.$transaction(async (tx) => {
            await lockSupplier(tx, supplier_id);
            const group = await tx.supplierPayment.findFirst({
                where: { id: payment_id, supplier_id },
                include: { payments: true },
            });
            if (!group) throw AppError.notFound("Supplier payment");
            await lockBills(
                tx,
                group.payments.filter((p) => p.ref_type === "PURCHASE").map((p) => p.ref_id),
            );
            const advance = group.payments
                .filter((p) => p.ref_type === "SUPPLIER_ADVANCE" && p.direction === "OUTGOING")
                .reduce((s, p) => s.plus(p.amount), D(0));
            if ((await advanceHeld(tx, supplier_id)).minus(advance).isNegative())
                throw AppError.conflict(
                    "The supplier already gave some of this back -- remove that refund first",
                );
            await audit(tx, {
                table: "SupplierPayment",
                record_id: payment_id,
                action: "DELETE",
                actor_id,
                note: `Supplier payment removed: ${reason}`,
                before: JSON.parse(JSON.stringify(group)),
            });
            await tx.payment.deleteMany({ where: { supplier_payment_id: payment_id } });
            await tx.supplierPayment.delete({ where: { id: payment_id } });
        });
    },

    async setOpening(supplier_id: string, data: OpeningInput, actor_id: string) {
        return prisma.$transaction(async (tx) => {
            await lockSupplier(tx, supplier_id);
            const before = await requireSupplier(tx, supplier_id);
            const left = await openingLeft(tx, supplier_id, D(data.opening_due));
            if (left.isNegative())
                throw AppError.conflict(
                    `${D(data.opening_due).minus(left).toFixed(2)} has already been paid on this old balance`,
                );
            const opening = {
                opening_due: D(data.opening_due),
                opening_date: data.opening_date,
                opening_note: data.opening_note ?? null,
            };
            const supplier = await tx.suppliers.update({
                where: { id: supplier_id },
                data: opening,
            });
            await audit(tx, {
                table: "Suppliers",
                record_id: supplier_id,
                action: "UPDATE",
                actor_id,
                note: "Old balance set",
                before: JSON.parse(
                    JSON.stringify({
                        opening_due: before.opening_due,
                        opening_date: before.opening_date,
                        opening_note: before.opening_note,
                    }),
                ),
                after: JSON.parse(JSON.stringify(opening)),
            });
            return supplier;
        });
    },
};
