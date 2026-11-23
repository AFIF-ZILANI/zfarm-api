import { describe, test, expect } from "bun:test";
import { Prisma } from "../../prisma/generated/prisma/client";
import { account, closedBatch, rolledBack, splitProfile } from "@lib/profit-split-fixtures";
import { fundState } from "./profit-split.service";
import { makeSupplierIn } from "@lib/profit-split-fixtures";

type Tx = Prisma.TransactionClient;
const day = (d: number) => new Date(Date.UTC(2007, 2, d));
/** Every figure as a plain number. */
const state = async (tx: Tx) => {
    const flat = (v: unknown): unknown =>
        v instanceof Prisma.Decimal
            ? v.toNumber()
            : Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, flat(x)]));
    return flat(await fundState(tx)) as {
        reinvest: { set_aside: number; moved: number; to_move: number; balance: number };
        reserve: {
            set_aside: number;
            covered: number;
            moved: number;
            to_move: number;
            balance: number;
            tax_held: number;
            available: number;
        };
        owner: { set_aside: number; drawn: number; to_draw: number };
        carried_loss: number;
        principal_waiting: number;
    };
};
const payment = (tx: Tx, data: Record<string, unknown>) =>
    tx.payment.create({
        data: {
            payment_date: day(20),
            direction: "OUTGOING",
            ref_id: crypto.randomUUID(),
            ...data,
        } as Prisma.PaymentUncheckedCreateInput,
    });
const transfer = (
    tx: Tx,
    amount: number,
    from: string,
    to: string,
    split_move?: "TO_REINVEST" | "TO_RESERVE" | "FROM_RESERVE",
) =>
    payment(tx, {
        amount,
        ref_type: "TRANSFER",
        from_instrument_id: from,
        to_instrument_id: to,
        ...(split_move && { split_move }),
    });
const loan = (tx: Tx, by: string, over: Record<string, unknown>) =>
    tx.loan.create({
        data: {
            lender: "L",
            purpose: "FARM",
            principal: 10000,
            total_payable: 12000,
            terms: "FLAT",
            installment_amount: 3000,
            installment_count: 4,
            frequency: "MONTHLY",
            first_due_on: day(1),
            received_on: day(1),
            recorded_by_id: by,
            ...over,
        } as Prisma.LoanUncheckedCreateInput,
    });
/** An installment, with its interest booked the way LoanService does for a farm loan. */
const installment = async (
    tx: Tx,
    l: { id: string; lender: string },
    by: string,
    amount: number,
    interest: number,
    from: string,
) => {
    const p = await payment(tx, {
        amount,
        ref_type: "LOAN",
        ref_id: l.id,
        from_instrument_id: from,
    });
    if (interest > 0)
        await tx.expense.create({
            data: {
                category: "LOAN_INTEREST",
                cost_type: "SHARED_PERIOD",
                amount: interest,
                date: day(20),
                recorded_by_id: by,
                loan_id: l.id,
                loan_payment_id: p.id,
            },
        });
    return p;
};
const split = (tx: Tx, batch_id: string, by: string, over: Record<string, unknown> = {}) =>
    tx.profitSplit.create({
        data: {
            batch_id,
            approved_by_id: by,
            kind: "PROFIT",
            net_profit: 173068,
            pct_reinvest: 50,
            pct_reserve: 30,
            pct_owner: 20,
            pct_tax: 10,
            reinvest: 86534,
            reserve: 51920.4,
            owner: 34613.6,
            tax: 17306.8,
            ...over,
        } as Prisma.ProfitSplitUncheckedCreateInput,
    });

describe("where each fund stands", () => {
    test("nothing decided, nothing anywhere", () =>
        rolledBack(async (tx) => {
            expect(await state(tx)).toEqual({
                reinvest: { set_aside: 0, moved: 0, to_move: 0, balance: 0 },
                reserve: {
                    set_aside: 0,
                    covered: 0,
                    moved: 0,
                    to_move: 0,
                    balance: 0,
                    tax_held: 0,
                    available: 0,
                },
                owner: { set_aside: 0, drawn: 0, to_draw: 0 },
                carried_loss: 0,
                principal_waiting: 0,
            });
        }));
    test("set aside but not moved: it still sits in Operating, and the reserve could pay a loss with all but the tax", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await split(tx, await closedBatch(tx, 1), by);
            const s = await state(tx);
            expect(s.reinvest).toEqual({ set_aside: 86534, moved: 0, to_move: 86534, balance: 0 });
            expect(s.reserve).toEqual({
                set_aside: 51920.4,
                covered: 0,
                moved: 0,
                to_move: 51920.4,
                balance: 0,
                tax_held: 17306.8,
                available: 34613.6,
            });
            expect(s.owner).toEqual({ set_aside: 34613.6, drawn: 0, to_draw: 34613.6 });
        }));
    test("moves count, ordinary transfers only change the balance", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, re, rs] = [
                await account(tx),
                await account(tx, "REINVEST"),
                await account(tx, "RESERVE"),
            ];
            await split(tx, await closedBatch(tx, 1), by);
            await transfer(tx, 80000, op, re, "TO_REINVEST");
            await transfer(tx, 50000, op, rs, "TO_RESERVE");
            await transfer(tx, 700, op, rs);
            const s = await state(tx);
            expect(s.reinvest).toMatchObject({ moved: 80000, to_move: 6534, balance: 80000 });
            expect(s.reserve).toMatchObject({
                moved: 50000,
                to_move: 1920.4,
                balance: 50700,
                available: 35313.6,
            });
        }));
    test("a covered loss lowers what's to move, below zero when the money is already in the reserve", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, rs] = [await account(tx), await account(tx, "RESERVE")];
            await split(tx, await closedBatch(tx, 1), by);
            await transfer(tx, 51920.4, op, rs, "TO_RESERVE");
            const loss = {
                kind: "LOSS",
                net_profit: -100000,
                reinvest: 0,
                reserve: 0,
                owner: 0,
                tax: 0,
                loss_covered: 34613.6,
            };
            await split(tx, await closedBatch(tx, 2), by, loss);
            expect((await state(tx)).reserve).toMatchObject({
                covered: 34613.6,
                to_move: -34613.6,
                balance: 51920.4,
                available: 0,
            });
            expect((await state(tx)).carried_loss).toBe(65386.4);
            await transfer(tx, 34613.6, rs, op, "FROM_RESERVE");
            expect((await state(tx)).reserve).toMatchObject({
                moved: 17306.8,
                to_move: 0,
                balance: 17306.8,
                tax_held: 17306.8,
                available: 0,
            });
        }));
    test("a recovered loss is carried no more", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await split(tx, await closedBatch(tx, 1), by, {
                kind: "LOSS",
                net_profit: -500,
                reinvest: 0,
                reserve: 0,
                owner: 0,
                tax: 0,
            });
            expect((await state(tx)).carried_loss).toBe(500);
            await split(tx, await closedBatch(tx, 2), by, {
                net_profit: 300,
                recovered: 300,
                reinvest: 0,
                reserve: 0,
                owner: 0,
                tax: 0,
            });
            expect((await state(tx)).carried_loss).toBe(200);
        }));
    test("tax paid lowers the tax held, never below zero, and moves nothing else", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const rs = await account(tx, "RESERVE");
            await split(tx, await closedBatch(tx, 1), by);
            await payment(tx, { amount: 5000, ref_type: "TAX_PAID", from_instrument_id: rs });
            let s = await state(tx);
            expect([s.reserve.tax_held, s.reserve.to_move]).toEqual([12306.8, 51920.4]);
            await payment(tx, { amount: 50000, ref_type: "TAX_PAID", from_instrument_id: rs });
            s = await state(tx);
            expect([s.reserve.tax_held, s.reserve.to_move]).toEqual([0, 51920.4]);
        }));
    test("every owner draw counts, past the share too", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            await split(tx, await closedBatch(tx, 1), by);
            await payment(tx, { amount: 40000, ref_type: "OWNER_DRAW", from_instrument_id: op });
            expect((await state(tx)).owner).toEqual({
                set_aside: 34613.6,
                drawn: 40000,
                to_draw: -5386.4,
            });
        }));
    test("a deactivated account's money is still the fund's", () =>
        rolledBack(async (tx) => {
            const [op, old] = [
                await account(tx),
                await account(tx, "RESERVE", { is_active: false }),
            ];
            await transfer(tx, 100, op, old);
            await transfer(tx, 50, op, await account(tx, "RESERVE"));
            expect((await state(tx)).reserve.balance).toBe(150);
        }));
});

describe("principal waiting", () => {
    const waiting = async (tx: Tx) => (await state(tx)).principal_waiting;
    test("a farm loan's installment less its interest; from Reinvestment it doesn't count", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, re] = [await account(tx), await account(tx, "REINVEST")];
            const l = await loan(tx, by, {});
            await installment(tx, l, by, 3000, 500, op);
            expect(await waiting(tx)).toBe(2500);
            await installment(tx, l, by, 3000, 500, re);
            expect(await waiting(tx)).toBe(2500);
        }));
    test("borrowing isn't repaying", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const l = await loan(tx, by, {});
            await payment(tx, {
                amount: 10000,
                direction: "INCOMING",
                ref_type: "LOAN",
                ref_id: l.id,
                to_instrument_id: await account(tx),
            });
            expect(await waiting(tx)).toBe(0);
        }));
    test("a batch loan, its interest booked up front, ends exactly on its principal", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            const l = await loan(tx, by, {
                purpose: "BATCH",
                batch_id: await closedBatch(tx, 1),
                principal: 10000,
                total_payable: 10700,
            });
            for (const a of [3333.33, 3333.33]) await installment(tx, l, by, a, 0, op);
            expect(await waiting(tx)).toBeCloseTo(6230.52, 2);
            await installment(tx, l, by, 4033.34, 0, op);
            expect(await waiting(tx)).toBe(10000);
        }));
    test("a batch loan paid partly from Reinvestment counts only Operating's share", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, re] = [await account(tx), await account(tx, "REINVEST")];
            const l = await loan(tx, by, { purpose: "BATCH", batch_id: await closedBatch(tx, 1) });
            await installment(tx, l, by, 6000, 0, re);
            await installment(tx, l, by, 6000, 0, op);
            expect(await waiting(tx)).toBe(5000);
        }));
    test("old debts count in full: a loan of that kind, and a supplier's old balance", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            const l = await loan(tx, by, {
                purpose: "OLD_DEBT",
                terms: "NONE",
                total_payable: 10000,
            });
            await installment(tx, l, by, 1000, 0, op);
            const s = await makeSupplierIn(tx);
            const g = await tx.supplierPayment.create({
                data: {
                    supplier_id: s,
                    direction: "OUTGOING",
                    amount: 400,
                    payment_date: day(1),
                    instrument_id: op,
                    recorded_by_id: by,
                },
            });
            const p = await payment(tx, {
                amount: 400,
                ref_type: "SUPPLIER_OPENING",
                ref_id: s,
                from_instrument_id: op,
                supplier_payment_id: g.id,
            });
            expect(await waiting(tx)).toBe(1400);
            await tx.payment.delete({ where: { id: p.id } });
            expect(await waiting(tx)).toBe(1000);
        }));
    test("taken once: what a split took is gone, and a removed payment leaves no debt to the farm", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            const l = await loan(tx, by, {
                purpose: "OLD_DEBT",
                terms: "NONE",
                total_payable: 10000,
            });
            const p = await installment(tx, l, by, 1000, 0, op);
            await split(tx, await closedBatch(tx, 1), by, { principal_taken: 1000 });
            expect([await waiting(tx), (await state(tx)).reinvest.set_aside]).toEqual([0, 85534]);
            await tx.payment.delete({ where: { id: p.id } });
            expect(await waiting(tx)).toBe(0);
            await installment(tx, l, by, 1500, 0, op); // 1000 of it was already taken
            expect(await waiting(tx)).toBe(500);
        }));
});
