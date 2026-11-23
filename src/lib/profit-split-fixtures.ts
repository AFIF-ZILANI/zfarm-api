import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";

type Tx = Prisma.TransactionClient;
const ROLLBACK = new Error("rolled back");

/**
 * Runs `fn` in a transaction that is always rolled back, starting from a farm with no split history. Funds,
 * carried losses and the order of batches are farm-wide, so a suite sharing the dev database would otherwise
 * read (and disturb) whatever is really recorded there.
 */
export async function rolledBack(fn: (tx: Tx) => Promise<void>) {
    try {
        await prisma.$transaction(
            async (tx) => {
                await tx.profitSplit.deleteMany();
                await tx.payment.updateMany({
                    where: { split_move: { not: null } },
                    data: { split_move: null },
                });
                await tx.expense.deleteMany({ where: { loan_id: { not: null } } });
                await tx.payment.deleteMany({
                    where: {
                        ref_type: { in: ["OWNER_DRAW", "TAX_PAID", "LOAN", "SUPPLIER_OPENING"] },
                    },
                });
                await tx.paymentInstrument.updateMany({ data: { fund: "OPERATING" } });
                await fn(tx);
                throw ROLLBACK;
            },
            { timeout: 60_000, maxWait: 20_000 },
        );
    } catch (e) {
        if (e !== ROLLBACK) throw e;
    }
}

const mobile = () => `+880${Math.floor(1e9 + Math.random() * 8e9)}`;

export async function splitProfile(tx: Tx) {
    return (
        await tx.profiles.create({
            data: { name: "Split Tester", mobile: mobile(), role: "ADMIN" },
        })
    ).id;
}
export async function account(
    tx: Tx,
    fund: "OPERATING" | "REINVEST" | "RESERVE" = "OPERATING",
    over = {},
) {
    return (
        await tx.paymentInstrument.create({
            data: { type: "CASH", label: `Split ${fund}`, fund, ...over },
        })
    ).id;
}
/** A finalised batch; dated 2007 so it comes before any real one. */
export async function closedBatch(tx: Tx, day: number, over: Record<string, unknown> = {}) {
    return (
        await tx.batches.create({
            data: {
                batch_code: `SPLIT-${crypto.randomUUID()}`,
                breed: "CLASSIC",
                status: "CLOSED",
                starting_date: new Date(Date.UTC(2007, 0, 1)),
                expected_selling_date: new Date(Date.UTC(2007, 1, day)),
                actual_end_date: new Date(Date.UTC(2007, 1, day)),
                initial_chick_count: 10,
                ...over,
            },
        })
    ).id;
}
