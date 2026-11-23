import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { LoanService, loanSchedule } from "./loan.service";
import { PaymentService } from "./payment.service";
import { FinanceService } from "./finance.service";
import { ExpenseService } from "./expense.service";
import { createLoanSchema } from "@validators/loan.validator";
import { createPaymentSchema } from "@validators/payment.validator";
import { sharedInstrumentId, purgeAuditLog } from "@lib/test-fixtures";

// Everything is dated in 2001, a year no other fixture uses, so the finance figures for it are ours alone.
const day = (d: number) => new Date(Date.UTC(2001, 5, d));

let profileId: string;
let batchId: string;
let account: string;
let second: string;
const loanIds: string[] = [];
const paymentIds: string[] = [];

const base = {
    lender: "Test Lender",
    installment_count: 4,
    frequency: "MONTHLY" as const,
    first_due_on: day(20),
    received_on: day(1),
};

async function loan(over: Record<string, unknown>) {
    const input = createLoanSchema.parse({ ...base, to_instrument_id: account, ...over });
    const created = await LoanService.create({ ...input, recorded_by_id: profileId });
    loanIds.push(created!.id);
    return created!;
}

describe("LoanService", () => {
    beforeAll(async () => {
        profileId = (
            await prisma.profiles.create({
                data: {
                    name: "Loan Recorder",
                    mobile: `+880${Math.floor(1e9 + Math.random() * 8e9)}`,
                    role: "ADMIN",
                },
            })
        ).id;
        batchId = (
            await prisma.batches.create({
                data: {
                    batch_code: `LOAN-${crypto.randomUUID()}`,
                    breed: "CLASSIC",
                    expected_selling_date: day(28),
                    initial_chick_count: 10,
                },
            })
        ).id;
        account = await sharedInstrumentId();
        second = (
            await prisma.paymentInstrument.create({ data: { type: "CASH", label: "Loan test 2" } })
        ).id;
    });

    afterAll(async () => {
        await prisma.expense.deleteMany({ where: { loan_id: { in: loanIds } } });
        await prisma.payment.deleteMany({
            where: {
                OR: [{ ref_type: "LOAN", ref_id: { in: loanIds } }, { id: { in: paymentIds } }],
            },
        });
        await prisma.loan.deleteMany({ where: { id: { in: loanIds } } });
        await prisma.payment.deleteMany({
            where: { OR: [{ from_instrument_id: second }, { to_instrument_id: second }] },
        });
        await prisma.paymentInstrument.delete({ where: { id: second } });
        await prisma.batches.delete({ where: { id: batchId } });
        await purgeAuditLog({ where: { changed_by_id: profileId } });
        await prisma.profiles.delete({ where: { id: profileId } });
    });

    test("EMI schedule: 1 lakh at 12% over 12 months is 8,884.88 a month", () => {
        const s = loanSchedule({
            principal: 100000,
            terms: "EMI",
            annual_rate: 12,
            installment_count: 12,
            frequency: "MONTHLY",
        });
        expect(s.installment_amount.toNumber()).toBe(8884.88);
        expect(s.total_payable.toNumber()).toBe(106618.56);
    });

    test("batch loan: money comes in, the whole interest lands on that batch, installments add no cost", async () => {
        const l = await loan({
            purpose: "BATCH",
            batch_id: batchId,
            principal: 10000,
            terms: "FLAT",
            total_payable: 10800,
        });
        const receipt = await prisma.payment.findFirstOrThrow({
            where: { ref_type: "LOAN", ref_id: l.id },
        });
        expect([receipt.direction, receipt.amount.toNumber(), receipt.to_instrument_id]).toEqual([
            "INCOMING",
            10000,
            account,
        ]);
        const interest = await prisma.expense.findMany({ where: { loan_id: l.id } });
        expect(interest.map((e) => [e.cost_type, e.batch_id, e.amount.toNumber()])).toEqual([
            ["DIRECT", batchId, 800],
        ]);

        const paid = await LoanService.payInstallment(l.id, {
            amount: 2700,
            payment_date: day(20),
            from_instrument_id: account,
            handled_by_id: profileId,
        });
        expect(paid!.interest).toBe("0.00");
        expect(await prisma.expense.count({ where: { loan_id: l.id } })).toBe(1);
        const row = await LoanService.getById(l.id);
        expect([row.paid, row.left]).toEqual(["2700.00", "8100.00"]);
        // One installment covered: the next is due a month after the first.
        expect(row.next_due_on!.toISOString().slice(0, 10)).toBe("2001-07-20");
    });

    test("farm loan: each installment's interest share is a shared cost of its day; the statement figure wins", async () => {
        const l = await loan({
            purpose: "FARM",
            principal: 10000,
            terms: "FLAT",
            total_payable: 12000,
        });
        expect(await prisma.expense.count({ where: { loan_id: l.id } })).toBe(0);
        const a = await LoanService.payInstallment(l.id, {
            amount: 3000,
            payment_date: day(20),
            from_instrument_id: account,
            handled_by_id: profileId,
        });
        expect(a!.interest).toBe("500.00"); // 3000 x 2000/12000
        await LoanService.payInstallment(l.id, {
            amount: 3000,
            payment_date: day(21),
            from_instrument_id: account,
            interest: 640,
            handled_by_id: profileId,
        });
        const rows = await prisma.expense.findMany({
            where: { loan_id: l.id },
            orderBy: { date: "asc" },
        });
        expect(rows.map((e) => [e.cost_type, e.batch_id, e.amount.toNumber()])).toEqual([
            ["SHARED_PERIOD", null, 500],
            ["SHARED_PERIOD", null, 640],
        ]);
    });

    test("interest-free old debt: no money in, no cost, and it can't be overpaid", async () => {
        const l = await loan({
            purpose: "OLD_DEBT",
            principal: 5000,
            terms: "NONE",
            to_instrument_id: undefined,
        });
        expect(await prisma.payment.count({ where: { ref_type: "LOAN", ref_id: l.id } })).toBe(0);
        await LoanService.payInstallment(l.id, {
            amount: 1250,
            payment_date: day(20),
            from_instrument_id: account,
            handled_by_id: profileId,
        });
        expect(await prisma.expense.count({ where: { loan_id: l.id } })).toBe(0);
        await expect(
            LoanService.payInstallment(l.id, {
                amount: 3751,
                payment_date: day(21),
                from_instrument_id: account,
                handled_by_id: profileId,
            }),
        ).rejects.toThrow(/outstanding balance of 3750/);
    });

    test("a loan can be removed until an installment is paid", async () => {
        const l = await loan({
            purpose: "BATCH",
            batch_id: batchId,
            principal: 1000,
            terms: "FLAT",
            total_payable: 1100,
        });
        await LoanService.remove(l.id, profileId);
        expect(await prisma.loan.count({ where: { id: l.id } })).toBe(0);
        expect(await prisma.expense.count({ where: { loan_id: l.id } })).toBe(0);
        expect(await prisma.payment.count({ where: { ref_type: "LOAN", ref_id: l.id } })).toBe(0);

        const kept = await loan({ purpose: "FARM", principal: 1000, terms: "NONE" });
        await LoanService.payInstallment(kept.id, {
            amount: 100,
            payment_date: day(20),
            from_instrument_id: account,
            handled_by_id: profileId,
        });
        await expect(LoanService.remove(kept.id, profileId)).rejects.toThrow(
            /Installments have been paid/,
        );
    });

    test("loan interest can't be entered as an ordinary expense", async () => {
        await expect(
            ExpenseService.create({
                category: "LOAN_INTEREST",
                cost_type: "SHARED_PERIOD",
                amount: 10,
                date: day(2),
                recorded_by_id: profileId,
            }),
        ).rejects.toThrow(/installment/);
    });

    // Same fixtures (profile, accounts), so it lives inside this suite's hooks.
    describe("cash book without bills", () => {
        test("owner capital and draw move cash only; a transfer moves neither cash nor profit, but both balances", async () => {
            const before = (await FinanceService.summary({ from: day(1), to: day(30) })).current;
            const pay = async (body: Record<string, unknown>) => {
                const p = await PaymentService.create({
                    ...createPaymentSchema.parse(body),
                    handled_by_id: profileId,
                });
                paymentIds.push(p!.id);
                return p!;
            };
            const capital = await pay({
                ref_type: "OWNER_CAPITAL",
                amount: 7000,
                payment_date: day(3),
                to_instrument_id: account,
                note: "From savings",
            });
            expect([capital.direction, capital.ref_id]).toEqual(["INCOMING", capital.id]);
            await pay({
                ref_type: "OWNER_DRAW",
                amount: 2000,
                payment_date: day(4),
                from_instrument_id: account,
            });
            await pay({
                ref_type: "TRANSFER",
                amount: 1500,
                payment_date: day(5),
                from_instrument_id: account,
                to_instrument_id: second,
            });

            const after = (await FinanceService.summary({ from: day(1), to: day(30) })).current;
            expect(after.cash - before.cash).toBe(5000);
            expect(after.net_profit).toBe(before.net_profit);
            const moved = await prisma.payment.aggregate({
                where: { to_instrument_id: second },
                _sum: { amount: true },
            });
            expect(moved._sum.amount!.toNumber()).toBe(1500);
        });

        test("a transfer needs two different accounts; 'other' money needs a note", () => {
            expect(() =>
                createPaymentSchema.parse({
                    ref_type: "TRANSFER",
                    amount: 1,
                    payment_date: day(5),
                    from_instrument_id: account,
                    to_instrument_id: account,
                }),
            ).toThrow(/different account/);
            expect(() =>
                createPaymentSchema.parse({
                    ref_type: "OTHER_IN",
                    amount: 1,
                    payment_date: day(5),
                    to_instrument_id: account,
                }),
            ).toThrow(/what this money was/);
        });
    });
});
