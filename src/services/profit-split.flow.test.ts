import { test, expect } from "bun:test";
import { Prisma } from "../../prisma/generated/prisma/client";
import {
    account,
    closedBatch,
    makeSupplierIn,
    rolledBack,
    splitProfile,
} from "@lib/profit-split-fixtures";
import { decide, fundState, move, undo } from "./profit-split.service";

/** One farm's whole story, every figure worked out by hand. [set aside to reinvest, to move there, to move to reserve,
 * tax held, available for a loss, owner's to draw, loss carried, principal waiting] */
test("a loan, an old balance, a profit, a loss, a recovery, moves, a draw, tax and an undo", () =>
    rolledBack(async (tx) => {
        const D = (n: number) => new Prisma.Decimal(n);
        const by = await splitProfile(tx);
        const [op, re, rs] = [
            await account(tx),
            await account(tx, "REINVEST"),
            await account(tx, "RESERVE"),
        ];
        const on = new Date(Date.UTC(2007, 5, 1));
        const pay = (data: Record<string, unknown>) =>
            tx.payment.create({
                data: {
                    payment_date: on,
                    direction: "OUTGOING",
                    ref_id: crypto.randomUUID(),
                    ...data,
                } as never,
            });
        const now = async () => {
            const s = await fundState(tx);
            return [
                s.reinvest.set_aside,
                s.reinvest.to_move,
                s.reserve.to_move,
                s.reserve.tax_held,
                s.reserve.available,
                s.owner.to_draw,
                s.carried_loss,
                s.principal_waiting,
            ].map(Number);
        };
        const go = async (d: number, profit: number) => {
            await Bun.sleep(3);
            return decide(tx, {
                batch_id: await closedBatch(tx, d),
                profit: D(profit),
                actor_id: by,
                pct: { reinvest: D(50), reserve: D(30), owner: D(20), tax: D(10) },
            });
        };
        const mv = (m: "TO_REINVEST" | "TO_RESERVE" | "FROM_RESERVE", amount: number) =>
            move(tx, {
                move: m,
                amount,
                payment_date: on,
                operating_instrument_id: op,
                actor_id: by,
            });

        // A farm loan of 10,000 to repay 12,000; 3,000 paid, 500 of it interest. An old balance: 1,500 paid.
        const loan = await tx.loan.create({
            data: {
                lender: "L",
                purpose: "FARM",
                principal: 10000,
                total_payable: 12000,
                terms: "FLAT",
                installment_amount: 3000,
                installment_count: 4,
                frequency: "MONTHLY",
                first_due_on: on,
                received_on: on,
                recorded_by_id: by,
            },
        });
        const inst = await pay({
            amount: 3000,
            ref_type: "LOAN",
            ref_id: loan.id,
            from_instrument_id: op,
        });
        await tx.expense.create({
            data: {
                category: "LOAN_INTEREST",
                cost_type: "SHARED_PERIOD",
                amount: 500,
                date: on,
                recorded_by_id: by,
                loan_id: loan.id,
                loan_payment_id: inst.id,
            },
        });
        const sup = await makeSupplierIn(tx);
        const g = await tx.supplierPayment.create({
            data: {
                supplier_id: sup,
                direction: "OUTGOING",
                amount: 1500,
                payment_date: on,
                instrument_id: op,
                recorded_by_id: by,
            },
        });
        await pay({
            amount: 1500,
            ref_type: "SUPPLIER_OPENING",
            ref_id: sup,
            from_instrument_id: op,
            supplier_payment_id: g.id,
        });
        expect(await now()).toEqual([0, 0, 0, 0, 0, 0, 0, 4000]);

        // Batch 1: +100,000 -> 50,000 (4,000 stays for the debt) / 30,000 / 20,000, tax 10,000.
        await go(1, 100000);
        expect(await now()).toEqual([46000, 46000, 30000, 10000, 20000, 20000, 0, 0]);
        await mv("TO_REINVEST", 46000);
        await mv("TO_RESERVE", 25000);
        expect(await now()).toEqual([46000, 0, 5000, 10000, 20000, 20000, 0, 0]);
        await pay({ amount: 22000, ref_type: "OWNER_DRAW", from_instrument_id: op });
        expect(await now()).toEqual([46000, 0, 5000, 10000, 20000, -2000, 0, 0]);

        // Batch 2: -70,000. The reserve has 25,000 + 5,000 coming - 10,000 tax = 20,000. It pays that; 50,000 carried.
        await go(2, -70000);
        expect(await now()).toEqual([46000, 0, -15000, 10000, 0, -2000, 50000, 0]);
        await mv("FROM_RESERVE", 15000);
        expect(await now()).toEqual([46000, 0, 0, 10000, 0, -2000, 50000, 0]);

        // Tax of 4,000 paid from the reserve; an installment paid straight from reinvestment doesn't wait for anything.
        await pay({ amount: 4000, ref_type: "TAX_PAID", from_instrument_id: rs });
        await pay({ amount: 3000, ref_type: "LOAN", ref_id: loan.id, from_instrument_id: re });
        expect(await now()).toEqual([46000, 0, 0, 6000, 0, -2000, 50000, 0]);

        // Batch 3: +90,000 -> 50,000 recovers the loss, 40,000 shared: 20,000 / 12,000 / 8,000, tax 4,000.
        const third = await go(3, 90000);
        expect(await now()).toEqual([66000, 20000, 12000, 10000, 8000, 6000, 0, 0]);

        // Undone: exactly where it was.
        await undo(tx, { id: third.id, reason: "Redo", actor_id: by });
        expect(await now()).toEqual([46000, 0, 0, 6000, 0, -2000, 50000, 0]);
    }));
