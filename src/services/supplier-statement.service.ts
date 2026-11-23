import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { Prisma } from "../../prisma/generated/prisma/client";

/**
 * A supplier's khata, worked out on read from what's already recorded -- no stored balance to disagree with.
 * Positive = the farm owes the supplier, negative = the supplier holds an advance.
 *
 * Using an advance on a bill adds no line: the earlier payment and the bill already balance.
 *
 * ponytail: the whole history is read to run the balance, then cut to the range -- a few hundred rows per
 * supplier. Start from a stored month-end balance if one supplier ever has tens of thousands.
 */

export type StatementKind = "OPENING" | "BILL" | "PAID_WITH_BILL" | "PAYMENT" | "REFUND";
export type StatementLine = {
    id: string;
    kind: StatementKind;
    date: Date;
    label: string;
    adds: string | null;
    paid: string | null;
    balance: string;
    purchase_id: string | null;
    supplier_payment_id: string | null;
    account: string | null;
    transaction_ref: string | null;
    note: string | null;
    settled: { label: string; amount: string }[];
};

const D = (v: Prisma.Decimal | number | null | undefined) => new Prisma.Decimal(v ?? 0);
const ORDER: StatementKind[] = ["OPENING", "BILL", "PAID_WITH_BILL", "PAYMENT", "REFUND"];
/** The date shown everywhere (stored dates are UTC days). */
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

type Entry = Omit<StatementLine, "adds" | "paid" | "balance"> & {
    amount: Prisma.Decimal;
    created_at: Date;
};
const isPaid = (k: StatementKind) => k === "PAID_WITH_BILL" || k === "PAYMENT";

async function entriesFor(supplier_id: string): Promise<Entry[]> {
    const supplier = await prisma.suppliers.findUnique({ where: { id: supplier_id } });
    if (!supplier) throw AppError.notFound("Supplier");
    const bills = await prisma.purchase.findMany({ where: { supplier_id } });
    const [groups, direct] = await Promise.all([
        prisma.supplierPayment.findMany({
            where: { supplier_id },
            include: { payments: true, instrument: { select: { label: true } } },
        }),
        prisma.payment.findMany({
            where: {
                ref_type: "PURCHASE",
                ref_id: { in: bills.map((b) => b.id) },
                supplier_payment_id: null,
            },
            include: { from_instrument: { select: { label: true } } },
        }),
    ]);
    const billBy = new Map(bills.map((b) => [b.id, b]));
    const billLabel = (id: string) => {
        const no = billBy.get(id)?.invoice_no;
        return no ? `Bill ${no}` : "Bill";
    };
    const blank = {
        purchase_id: null,
        supplier_payment_id: null,
        account: null,
        transaction_ref: null,
        note: null,
        settled: [],
    };

    const out: Entry[] = [];
    if (supplier.opening_due.greaterThan(0))
        out.push({
            ...blank,
            id: `opening:${supplier.id}`,
            kind: "OPENING",
            date: supplier.opening_date!,
            label: "Old balance",
            note: supplier.opening_note,
            amount: supplier.opening_due,
            created_at: supplier.created_at,
        });
    for (const b of bills) {
        const line = {
            ...blank,
            date: b.purchase_date,
            purchase_id: b.id,
            created_at: b.created_at,
        };
        out.push({
            ...line,
            id: b.id,
            kind: "BILL",
            label: billLabel(b.id),
            amount: b.total_amount,
        });
        // Older bills stored what was paid on them, with no Payment row behind it.
        if (b.paid_amount.greaterThan(0))
            out.push({
                ...line,
                id: `${b.id}:paid`,
                kind: "PAID_WITH_BILL",
                label: "Paid with the bill",
                amount: b.paid_amount,
                settled: [{ label: billLabel(b.id), amount: b.paid_amount.toFixed(2) }],
            });
    }
    for (const g of groups) {
        const refund = g.direction === "INCOMING";
        const rank = { SUPPLIER_OPENING: 0, PURCHASE: 1, SUPPLIER_ADVANCE: 2 } as Record<
            string,
            number
        >;
        const parts = [...g.payments].sort(
            (a, b) =>
                rank[a.ref_type]! - rank[b.ref_type]! ||
                Number(billBy.get(a.ref_id)?.purchase_date ?? 0) -
                    Number(billBy.get(b.ref_id)?.purchase_date ?? 0),
        );
        out.push({
            ...blank,
            id: g.id,
            kind: refund ? "REFUND" : "PAYMENT",
            date: g.payment_date,
            label: refund ? "Refund" : "Paid",
            supplier_payment_id: g.id,
            account: g.instrument.label,
            transaction_ref: g.transaction_ref,
            note: g.note,
            amount: g.amount,
            created_at: g.created_at,
            settled: refund
                ? []
                : parts.map((p) => ({
                      label:
                          p.ref_type === "SUPPLIER_OPENING"
                              ? "Old balance"
                              : p.ref_type === "PURCHASE"
                                ? billLabel(p.ref_id)
                                : "Advance",
                      amount: p.amount.toFixed(2),
                  })),
        });
    }
    for (const p of direct)
        out.push({
            ...blank,
            id: p.id,
            kind: "PAYMENT",
            date: p.payment_date,
            label: "Paid",
            purchase_id: p.ref_id,
            account: p.from_instrument?.label ?? null,
            transaction_ref: p.transaction_ref,
            note: p.note,
            amount: p.amount,
            created_at: p.created_at,
            settled: [{ label: billLabel(p.ref_id), amount: p.amount.toFixed(2) }],
        });

    return out.sort(
        (a, b) =>
            dayOf(a.date).localeCompare(dayOf(b.date)) ||
            ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
            Number(a.created_at) - Number(b.created_at),
    );
}

export const SupplierStatementService = {
    /** `from` / `to`: YYYY-MM-DD, both included. */
    async statement(
        supplier_id: string,
        q: { from?: string | undefined; to?: string | undefined },
    ) {
        let balance = D(0);
        let forward = D(0);
        let bought = D(0);
        let paid = D(0);
        const lines: StatementLine[] = [];
        for (const { amount, created_at: _, ...e } of await entriesFor(supplier_id)) {
            const day = dayOf(e.date);
            if (q.to !== undefined && day > q.to) break;
            balance = isPaid(e.kind) ? balance.minus(amount) : balance.plus(amount);
            if (q.from !== undefined && day < q.from) {
                forward = balance;
                continue;
            }
            if (e.kind === "BILL") bought = bought.plus(amount);
            if (isPaid(e.kind)) paid = paid.plus(amount);
            lines.push({
                ...e,
                adds: isPaid(e.kind) ? null : amount.toFixed(2),
                paid: isPaid(e.kind) ? amount.toFixed(2) : null,
                balance: balance.toFixed(2),
            });
        }
        return {
            brought_forward: forward.toFixed(2),
            lines,
            closing: balance.toFixed(2),
            bought: bought.toFixed(2),
            paid: paid.toFixed(2),
        };
    },

    /** Where every supplier stands now. */
    async balances() {
        const [suppliers, bills, paidOnBills, own] = await Promise.all([
            prisma.suppliers.findMany({ select: { id: true, opening_due: true } }),
            prisma.purchase.findMany({
                where: { supplier_id: { not: null } },
                select: { id: true, supplier_id: true, due_amount: true },
            }),
            prisma.payment.groupBy({
                by: ["ref_id"],
                where: { ref_type: "PURCHASE" },
                _sum: { amount: true },
            }),
            prisma.payment.groupBy({
                by: ["ref_id", "ref_type", "direction"],
                where: { ref_type: { in: ["SUPPLIER_OPENING", "SUPPLIER_ADVANCE"] } },
                _sum: { amount: true },
            }),
        ]);
        const paidBy = new Map(paidOnBills.map((p) => [p.ref_id, D(p._sum.amount)]));
        const dueBy = new Map<string, Prisma.Decimal>();
        for (const b of bills)
            dueBy.set(
                b.supplier_id!,
                D(dueBy.get(b.supplier_id!))
                    .plus(b.due_amount)
                    .minus(paidBy.get(b.id) ?? 0),
            );
        const sum = (id: string, ref_type: string, direction: string) =>
            D(
                own.find(
                    (r) => r.ref_id === id && r.ref_type === ref_type && r.direction === direction,
                )?._sum.amount,
            );
        return suppliers.map((s) => {
            const opening_left = s.opening_due.minus(sum(s.id, "SUPPLIER_OPENING", "OUTGOING"));
            const bills_due = D(dueBy.get(s.id));
            const advance = sum(s.id, "SUPPLIER_ADVANCE", "OUTGOING").minus(
                sum(s.id, "SUPPLIER_ADVANCE", "INCOMING"),
            );
            return {
                supplier_id: s.id,
                opening_left: opening_left.toFixed(2),
                bills_due: bills_due.toFixed(2),
                owed: opening_left.plus(bills_due).toFixed(2),
                advance: advance.toFixed(2),
            };
        });
    },
};
