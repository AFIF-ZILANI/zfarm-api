import { describe, test, expect } from "bun:test";
import { Prisma } from "../../prisma/generated/prisma/client";
import { account, closedBatch, rolledBack, splitProfile } from "@lib/profit-split-fixtures";
import { decide, fundState, move, removeMove, skip, undo } from "./profit-split.service";
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

const D = (n: number) => new Prisma.Decimal(n);
const PCT = { reinvest: D(50), reserve: D(30), owner: D(20), tax: D(10) };
const go = async (tx: Tx, batch_id: string, profit: number, actor_id: string, pct = PCT) => {
    await Bun.sleep(3); // decisions are ordered by when they were made
    return decide(tx, { batch_id, profit: D(profit), pct, actor_id });
};
const status = (p: Promise<unknown>) =>
    p.then(
        () => "ok",
        (e: { status?: number; message: string }) => e.status ?? `raw: ${e.message}`,
    );
const moveIt = (
    tx: Tx,
    by: string,
    op: string,
    m: "TO_REINVEST" | "TO_RESERVE" | "FROM_RESERVE",
    amount: number,
) =>
    move(tx, { move: m, amount, payment_date: day(25), operating_instrument_id: op, actor_id: by });

describe("deciding", () => {
    test("the owner's example: the reserve pays what it can without the tax, the rest comes off the next profit", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            await account(tx, "RESERVE");
            // 60,000 in the reserve, 20,000 of it tax: one earlier split of 2,00,000.
            await go(tx, await closedBatch(tx, 1), 200000, by);
            await moveIt(tx, by, op, "TO_RESERVE", 60000);
            expect((await state(tx)).reserve).toMatchObject({
                balance: 60000,
                tax_held: 20000,
                available: 40000,
            });
            const loss = await go(tx, await closedBatch(tx, 2), -100000, by);
            expect([loss.kind, loss.loss_covered.toNumber()]).toEqual(["LOSS", 40000]);
            let s = await state(tx);
            expect([s.carried_loss, s.reserve.to_move, s.reserve.available]).toEqual([
                60000, -40000, 0,
            ]);
            const next = await go(tx, await closedBatch(tx, 3), 200000, by);
            expect([next.recovered, next.reinvest, next.reserve, next.owner].map(Number)).toEqual([
                60000, 70000, 42000, 28000,
            ]);
            s = await state(tx);
            expect([s.carried_loss, s.reserve.to_move]).toEqual([0, 2000]);
        }));
    test("with nothing in reserve the whole loss is carried", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await go(tx, await closedBatch(tx, 1), -500, by);
            expect((await state(tx)).carried_loss).toBe(500);
        }));
    test("reserve money still in Operating pays too", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await go(tx, await closedBatch(tx, 1), 1000, by); // 300 to reserve, 100 of it tax
            await go(tx, await closedBatch(tx, 2), -150, by);
            const s = await state(tx);
            expect([s.carried_loss, s.reserve.to_move, s.reserve.available]).toEqual([0, 150, 50]);
        }));
    test("a part-filled reserve and several losses: never more than it has", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await go(tx, await closedBatch(tx, 1), 1000, by);
            await go(tx, await closedBatch(tx, 2), -150, by);
            await go(tx, await closedBatch(tx, 3), -150, by);
            const s = await state(tx);
            expect([s.carried_loss, s.reserve.covered, s.reserve.available]).toEqual([100, 200, 0]);
        }));
    test("loan principal comes off reinvestment once, over two splits", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const l = await loan(tx, by, {
                purpose: "OLD_DEBT",
                terms: "NONE",
                total_payable: 10000,
            });
            await installment(tx, l, by, 800, 0, await account(tx));
            const a = await go(tx, await closedBatch(tx, 1), 1000, by);
            const b = await go(tx, await closedBatch(tx, 2), 1000, by);
            const c = await go(tx, await closedBatch(tx, 3), 1000, by);
            expect([a, b, c].map((x) => x.principal_taken.toNumber())).toEqual([500, 300, 0]);
            const s = await state(tx);
            expect([s.principal_waiting, s.reinvest.to_move]).toEqual([0, 700]);
        }));
    test("a zero profit is a decision with nothing to share", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            expect((await go(tx, await closedBatch(tx, 1), 0, by)).kind).toBe("PROFIT");
        }));
    test("a profit of minus zero is no loss", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            expect((await go(tx, await closedBatch(tx, 1), -0, by)).kind).toBe("PROFIT");
        }));
    test("percentages for this batch only", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const r = await go(tx, await closedBatch(tx, 1), 1000, by, {
                reinvest: D(60),
                reserve: D(40),
                owner: D(0),
                tax: D(5),
            });
            expect([r.reinvest, r.reserve, r.owner, r.tax].map(Number)).toEqual([600, 400, 0, 50]);
        }));
});

describe("what can't be decided", () => {
    test("a batch that isn't closed, an unknown one, one already decided", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            for (const st of ["RUNNING", "SOLD"])
                expect(
                    await status(go(tx, await closedBatch(tx, 1, { status: st }), 100, by)),
                ).toBe(409);
            expect(await status(go(tx, crypto.randomUUID(), 100, by))).toBe(404);
            const b = await closedBatch(tx, 1);
            await go(tx, b, 100, by);
            expect(await status(go(tx, b, 100, by))).toBe(409);
        }));
    test("a later batch before an earlier one", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [late, early] = [await closedBatch(tx, 9), await closedBatch(tx, 3)];
            expect(await status(go(tx, late, 100, by))).toBe(409);
            await go(tx, early, 100, by);
            expect(await status(go(tx, late, 100, by))).toBe("ok");
        }));
    test("a batch while one that ended before it is sold but not final: that one may be a loss", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const open = await closedBatch(tx, 2, { status: "SOLD" });
            const late = await closedBatch(tx, 5);
            expect(await status(go(tx, await closedBatch(tx, 1), 100, by))).toBe("ok");
            expect(await status(go(tx, late, 100, by))).toBe(409);
            await tx.batches.update({ where: { id: open }, data: { status: "CLOSED" } });
            await go(tx, open, -50, by);
            expect(await status(go(tx, late, 100, by))).toBe("ok");
        }));
    test("shares other than the ones on the screen", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            await go(tx, await closedBatch(tx, 1), -80, by);
            const ask = async (expected: {
                recovered: number;
                principal_taken: number;
                loss_covered: number;
            }) =>
                decide(tx, {
                    batch_id: next,
                    profit: D(1000),
                    pct: PCT,
                    expected,
                    actor_id: by,
                });
            const next = await closedBatch(tx, 2);
            const seen = { recovered: 0, principal_taken: 0, loss_covered: 0 };
            await Bun.sleep(3);
            expect(await status(ask(seen))).toBe(409);
            expect(await tx.profitSplit.count({ where: { batch_id: next } })).toBe(0);
            expect(await status(ask({ ...seen, recovered: 80 }))).toBe("ok");
        }));
    test("skipping: with a reason, in order, and never after a real decision", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [a, b, c] = [
                await closedBatch(tx, 1),
                await closedBatch(tx, 2),
                await closedBatch(tx, 3),
            ];
            const sk = async (batch_id: string) => {
                await Bun.sleep(3);
                return skip(tx, {
                    batch_id,
                    profit: D(-700),
                    reason: "Before FMS split",
                    actor_id: by,
                });
            };
            expect(await status(sk(b))).toBe(409);
            const r = await sk(a);
            expect([r.kind, Number(r.net_profit)]).toEqual(["SKIPPED", -700]);
            expect((await state(tx)).carried_loss).toBe(0);
            await go(tx, b, 100, by);
            expect(await status(sk(c))).toBe(409);
        }));
});

describe("undo", () => {
    test("only the latest; everything goes back; the batch waits again; audited", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [a, b] = [await closedBatch(tx, 1), await closedBatch(tx, 2)];
            const first = await go(tx, a, 1000, by);
            const before = await state(tx);
            const second = await go(tx, b, -150, by);
            const un = (id: string) => undo(tx, { id, reason: "Wrong figures", actor_id: by });
            expect(await status(un(first.id))).toBe(409);
            await un(second.id);
            expect(await state(tx)).toEqual(before);
            const log = await tx.auditLog.findFirstOrThrow({
                where: { table_name: "ProfitSplit", record_id: second.id, action: "DELETE" },
            });
            expect([
                log.note?.includes("Wrong figures"),
                JSON.stringify(log.before_data).includes(b),
            ]).toEqual([true, true]);
            await go(tx, b, 300, by);
            expect(await status(un(crypto.randomUUID()))).toBe(404);
        }));
    test("money already moved shows as moved ahead", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op] = [await account(tx), await account(tx, "REINVEST")];
            const r = await go(tx, await closedBatch(tx, 1), 1000, by);
            await moveIt(tx, by, op, "TO_REINVEST", 500);
            await undo(tx, { id: r.id, reason: "Redo", actor_id: by });
            expect((await state(tx)).reinvest).toMatchObject({
                set_aside: 0,
                moved: 500,
                to_move: -500,
            });
        }));
});

describe("moving", () => {
    test("up to what's left, not a paisa more; it's an ordinary transfer in the cash book", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, re] = [await account(tx), await account(tx, "REINVEST")];
            await go(tx, await closedBatch(tx, 1), 1000, by);
            expect(await status(moveIt(tx, by, op, "TO_REINVEST", 500.01))).toBe(400);
            const p = await moveIt(tx, by, op, "TO_REINVEST", 200);
            expect([p.ref_type, p.split_move, p.from_instrument_id, p.to_instrument_id]).toEqual([
                "TRANSFER",
                "TO_REINVEST",
                op,
                re,
            ]);
            expect(await status(moveIt(tx, by, op, "TO_REINVEST", 300.01))).toBe(400);
            await moveIt(tx, by, op, "TO_REINVEST", 300);
            expect((await state(tx)).reinvest.to_move).toBe(0);
        }));
    test("needs that fund's account, and an operating account on the other side", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const op = await account(tx);
            await go(tx, await closedBatch(tx, 1), 1000, by);
            expect(await status(moveIt(tx, by, op, "TO_REINVEST", 10))).toBe(400);
            const re = await account(tx, "REINVEST");
            await account(tx, "RESERVE");
            expect(await status(moveIt(tx, by, re, "TO_RESERVE", 10))).toBe(400);
            expect(await status(moveIt(tx, by, crypto.randomUUID(), "TO_RESERVE", 10))).toBe(400);
            expect(
                await status(
                    moveIt(
                        tx,
                        by,
                        await account(tx, "OPERATING", { is_active: false }),
                        "TO_RESERVE",
                        10,
                    ),
                ),
            ).toBe(400);
        }));
    test("back from the reserve only for a loss it owes, up to that", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op] = [await account(tx), await account(tx, "RESERVE")];
            await go(tx, await closedBatch(tx, 1), 1000, by);
            await moveIt(tx, by, op, "TO_RESERVE", 300);
            expect(await status(moveIt(tx, by, op, "FROM_RESERVE", 1))).toBe(400);
            await go(tx, await closedBatch(tx, 2), -150, by);
            expect(await status(moveIt(tx, by, op, "TO_RESERVE", 1))).toBe(400);
            expect(await status(moveIt(tx, by, op, "FROM_RESERVE", 150.01))).toBe(400);
            await moveIt(tx, by, op, "FROM_RESERVE", 150);
            expect((await state(tx)).reserve).toMatchObject({
                to_move: 0,
                balance: 150,
                tax_held: 100,
                available: 50,
            });
        }));
    test("a wrong move can be taken out, with a trace; an ordinary transfer can't be taken out here", () =>
        rolledBack(async (tx) => {
            const by = await splitProfile(tx);
            const [op, re] = [await account(tx), await account(tx, "REINVEST")];
            await go(tx, await closedBatch(tx, 1), 1000, by);
            const p = await moveIt(tx, by, op, "TO_REINVEST", 200);
            const rm = (payment_id: string) =>
                removeMove(tx, { payment_id, reason: "Typed twice", actor_id: by });
            await rm(p.id);
            expect((await state(tx)).reinvest).toMatchObject({
                moved: 0,
                to_move: 500,
                balance: 0,
            });
            expect(
                await tx.auditLog.count({
                    where: { table_name: "Payment", record_id: p.id, action: "DELETE" },
                }),
            ).toBe(1);
            expect(await status(rm((await transfer(tx, 5, op, re)).id))).toBe(404);
            expect(await status(rm(crypto.randomUUID()))).toBe(404);
        }));
});
