import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";
import { LoanService, loanSchedule } from "./loan.service";
import { PaymentService } from "./payment.service";
import { FinanceService } from "./finance.service";
import { ExpenseService, checkExpensePaid } from "./expense.service";
import { SharedCostService } from "./shared-cost.service";
import { BatchPnlService } from "./batch-pnl.service";
import { PaymentInstrumentService } from "./payment-instrument.service";
import { createLoanSchema, payInstallmentSchema } from "@validators/loan.validator";
import { createPaymentSchema } from "@validators/payment.validator";
import { purgeAuditLog } from "@lib/test-fixtures";

// Dated in 2002, a year no other fixture uses, so finance figures for it are ours alone.
const day = (d: number, month = 2) => new Date(Date.UTC(2002, month, d));
const iso = (d: Date | null) => d?.toISOString().slice(0, 10);

let profileId: string;
let openBatch: string;
let closedBatch: string;
let account: string;
let second: string;
let inactive: string;
const loanIds: string[] = [];

const base = {
    lender: "Edge Lender",
    installment_count: 4,
    frequency: "MONTHLY",
    first_due_on: day(20),
    received_on: day(1),
    principal: 10000,
};
const parse = (over: Record<string, unknown>) =>
    createLoanSchema.parse({ ...base, to_instrument_id: account, ...over });

async function loan(over: Record<string, unknown>) {
    const l = (await LoanService.create({ ...parse(over), recorded_by_id: profileId }))!;
    loanIds.push(l.id);
    return l;
}
const pay = (id: string, amount: number, over: Record<string, unknown> = {}) =>
    LoanService.payInstallment(id, {
        ...payInstallmentSchema.parse({
            amount,
            payment_date: day(20),
            from_instrument_id: account,
            ...over,
        }),
        handled_by_id: profileId,
    });
const interestRows = (id: string) =>
    prisma.expense.findMany({ where: { loan_id: id }, orderBy: { created_at: "asc" } });
const status = (p: Promise<unknown>) =>
    p.then(
        () => "ok",
        (e: { status?: number; statusCode?: number; message: string }) =>
            e.status ?? e.statusCode ?? `raw: ${e.message.split("\n").pop()}`,
    );
const batch = async (code: string, st: "RUNNING" | "CLOSED") =>
    (
        await prisma.batches.create({
            data: {
                batch_code: `${code}-${crypto.randomUUID()}`,
                breed: "CLASSIC",
                status: st,
                starting_date: day(1),
                expected_selling_date: day(28),
                initial_chick_count: 10,
            },
        })
    ).id;

beforeAll(async () => {
    profileId = (
        await prisma.profiles.create({
            data: {
                name: "Loan Edge",
                mobile: `+880${Math.floor(1e9 + Math.random() * 8e9)}`,
                role: "ADMIN",
            },
        })
    ).id;
    [openBatch, closedBatch] = [await batch("LE-O", "RUNNING"), await batch("LE-C", "CLOSED")];
    const inst = async (label: string, is_active = true) =>
        (await prisma.paymentInstrument.create({ data: { type: "CASH", label, is_active } })).id;
    account = await inst("Loan edge A");
    second = await inst("Loan edge B");
    inactive = await inst("Loan edge off", false);
});

afterAll(async () => {
    const accounts = [account, second, inactive];
    await prisma.expense.deleteMany({
        where: { OR: [{ loan_id: { in: loanIds } }, { recorded_by_id: profileId }] },
    });
    await prisma.payment.deleteMany({
        where: {
            OR: [{ from_instrument_id: { in: accounts } }, { to_instrument_id: { in: accounts } }],
        },
    });
    await prisma.loan.deleteMany({ where: { recorded_by_id: profileId } });
    await prisma.paymentInstrument.deleteMany({ where: { id: { in: accounts } } });
    await prisma.batches.deleteMany({ where: { id: { in: [openBatch, closedBatch] } } });
    await purgeAuditLog({ where: { changed_by_id: profileId } });
    await prisma.profiles.delete({ where: { id: profileId } });
});

describe("schedule", () => {
    const s = (o: Partial<Parameters<typeof loanSchedule>[0]>) =>
        loanSchedule({
            principal: 10000,
            terms: "NONE",
            installment_count: 4,
            frequency: "MONTHLY",
            ...o,
        });
    test("weekly EMI uses 52 periods a year", () => {
        const r = s({
            terms: "EMI",
            annual_rate: 10.4,
            installment_count: 52,
            frequency: "WEEKLY",
        });
        expect(r.installment_amount.toNumber()).toBeCloseTo(202.7, 1);
    });
    test("an EMI's rounding never makes the total less than what was borrowed", () => {
        const r = s({ principal: 100, terms: "EMI", annual_rate: 0.001, installment_count: 3 });
        expect(r.total_payable.toNumber()).toBeGreaterThanOrEqual(100);
    });
    test("an amount too small for its installments is a 400, not a crash", async () => {
        expect(
            await status(
                loan({ purpose: "FARM", principal: 1, terms: "NONE", installment_count: 600 }),
            ),
        ).toBe(400);
    });
    test("an EMI whose interest can't be stored is a 400, not a crash", async () => {
        expect(
            await status(
                loan({
                    purpose: "BATCH",
                    batch_id: openBatch,
                    principal: 99_000_000,
                    terms: "EMI",
                    annual_rate: 100,
                    installment_count: 600,
                }),
            ),
        ).toBe(400);
    });
});

describe("validation", () => {
    const ok = (over: Record<string, unknown>) =>
        createLoanSchema.safeParse({
            ...base,
            purpose: "FARM",
            terms: "NONE",
            to_instrument_id: account,
            ...over,
        }).success;
    test("a plain interest-free farm loan is accepted", () => expect(ok({})).toBe(true));
    const bad: [string, Record<string, unknown>][] = [
        ["blank lender", { lender: "  " }],
        ["zero principal", { principal: 0 }],
        ["negative principal", { principal: -5 }],
        ["principal in fractions of a paisa", { principal: 100.005 }],
        ["principal larger than a payment can hold", { principal: 100_000_000 }],
        ["EMI without a rate", { terms: "EMI" }],
        [
            "EMI paid once",
            { terms: "EMI", annual_rate: 10, frequency: "ONE_OFF", installment_count: 1 },
        ],
        ["EMI rate that rounds to zero", { terms: "EMI", annual_rate: 0.0001 }],
        ["rate on a loan without interest", { annual_rate: 10 }],
        ["FLAT without a total", { terms: "FLAT" }],
        ["FLAT total under the principal", { terms: "FLAT", total_payable: 9999 }],
        ["total on a loan without interest", { total_payable: 12000 }],
        ["batch loan without a batch", { purpose: "BATCH" }],
        ["farm loan naming a batch", { batch_id: crypto.randomUUID() }],
        ["old debt bringing money in", { purpose: "OLD_DEBT" }],
        ["loan landing nowhere", { to_instrument_id: undefined }],
        ["one-off in several installments", { frequency: "ONE_OFF" }],
        ["zero installments", { installment_count: 0 }],
        ["half an installment", { installment_count: 1.5 }],
        ["first due before the money came in", { first_due_on: new Date(Date.UTC(2002, 1, 1)) }],
    ];
    for (const [name, over] of bad) test(`refuses: ${name}`, () => expect(ok(over)).toBe(false));

    const inst = (over: Record<string, unknown>) =>
        payInstallmentSchema.safeParse({
            amount: 100,
            payment_date: day(20),
            from_instrument_id: crypto.randomUUID(),
            ...over,
        }).success;
    test("installment: accepts a normal one, refuses bad amounts and interest", () => {
        expect(inst({})).toBe(true);
        expect(inst({ interest: 100 })).toBe(true);
        expect(inst({ interest: 101 })).toBe(false);
        expect(inst({ interest: -1 })).toBe(false);
        expect(inst({ amount: 0 })).toBe(false);
        expect(inst({ amount: 0.001 })).toBe(false);
        expect(inst({ from_instrument_id: undefined })).toBe(false);
    });
    test("a payment too small or too big to store is refused before the database", () => {
        const p = (amount: number) =>
            createPaymentSchema.safeParse({
                ref_type: "OWNER_CAPITAL",
                amount,
                payment_date: day(3),
                to_instrument_id: crypto.randomUUID(),
            }).success;
        expect(p(0.01)).toBe(true);
        expect(p(0.001)).toBe(false);
        expect(p(100_000_000)).toBe(false);
    });
    test("every no-bill kind refuses a bill and the wrong account side", () => {
        const p = (b: Record<string, unknown>) =>
            createPaymentSchema.safeParse({ amount: 1, payment_date: day(3), note: "x", ...b })
                .success;
        const a = crypto.randomUUID();
        const b = crypto.randomUUID();
        for (const k of ["OWNER_CAPITAL", "OTHER_IN"]) {
            expect(p({ ref_type: k, to_instrument_id: a })).toBe(true);
            expect(p({ ref_type: k, from_instrument_id: a })).toBe(false);
            expect(p({ ref_type: k, to_instrument_id: a, from_instrument_id: b })).toBe(false);
            expect(p({ ref_type: k, to_instrument_id: a, ref_id: b })).toBe(false);
        }
        for (const k of ["OWNER_DRAW", "OTHER_OUT"]) {
            expect(p({ ref_type: k, from_instrument_id: a })).toBe(true);
            expect(p({ ref_type: k, to_instrument_id: a })).toBe(false);
        }
        expect(p({ ref_type: "TRANSFER", from_instrument_id: a })).toBe(false);
        expect(p({ ref_type: "LOAN", ref_id: a, from_instrument_id: a })).toBe(false);
        expect(p({ ref_type: "PAYROLL", ref_id: a, from_instrument_id: a })).toBe(false);
        expect(p({ ref_type: "SALE", to_instrument_id: a })).toBe(false);
    });
});

describe("recording a loan", () => {
    test("a closed batch, an unknown batch, an unknown or inactive account are refused and leave nothing", async () => {
        const n = () => prisma.loan.count({ where: { recorded_by_id: profileId } });
        const before = await n();
        const flat = { purpose: "BATCH", terms: "FLAT", total_payable: 11000 };
        expect(await status(loan({ ...flat, batch_id: closedBatch }))).toBe(409);
        expect(await status(loan({ ...flat, batch_id: crypto.randomUUID() }))).toBe(400);
        expect(
            await status(
                loan({ purpose: "FARM", terms: "NONE", to_instrument_id: crypto.randomUUID() }),
            ),
        ).toBe(400);
        expect(
            await status(loan({ purpose: "FARM", terms: "NONE", to_instrument_id: inactive })),
        ).toBe(400);
        expect(await n()).toBe(before);
    });
    test("an interest-free loan on a closed batch is refused too (no interest row to catch it)", async () => {
        expect(await status(loan({ purpose: "BATCH", batch_id: closedBatch, terms: "NONE" }))).toBe(
            409,
        );
    });
    test("an interest-free batch loan books no expense", async () => {
        const l = await loan({ purpose: "BATCH", batch_id: openBatch, terms: "NONE" });
        expect(await interestRows(l.id)).toEqual([]);
    });
    test("still works if the Loan interest category was deleted in Settings", async () => {
        if ((await prisma.expense.count({ where: { category: "LOAN_INTEREST" } })) > 0) return;
        await prisma.expenseCategoryLookup.deleteMany({ where: { code: "LOAN_INTEREST" } });
        try {
            const l = await loan({ purpose: "FARM", terms: "FLAT", total_payable: 12000 });
            expect(await status(pay(l.id, 3000))).toBe("ok");
        } finally {
            await prisma.expenseCategoryLookup.upsert({
                where: { code: "LOAN_INTEREST" },
                update: {},
                create: { code: "LOAN_INTEREST", label: "Loan interest" },
            });
        }
    });
});

describe("installments", () => {
    test("monthly due dates stay at month end: 31 Jan is followed by 28 Feb, then 31 Mar", async () => {
        const l = await loan({
            purpose: "FARM",
            terms: "NONE",
            received_on: day(1, 0),
            first_due_on: day(31, 0),
        });
        await pay(l.id, 2500);
        expect(iso((await LoanService.getById(l.id)).next_due_on)).toBe("2002-02-28");
        await pay(l.id, 2500);
        expect(iso((await LoanService.getById(l.id)).next_due_on)).toBe("2002-03-31");
    });
    test("a part payment doesn't move the due date", async () => {
        const l = await loan({ purpose: "FARM", terms: "NONE" });
        await pay(l.id, 2499);
        expect(iso((await LoanService.getById(l.id)).next_due_on)).toBe("2002-03-20");
        await pay(l.id, 1);
        expect(iso((await LoanService.getById(l.id)).next_due_on)).toBe("2002-04-20");
    });
    test("weekly due dates step seven days", async () => {
        const l = await loan({ purpose: "FARM", terms: "NONE", frequency: "WEEKLY" });
        await pay(l.id, 5000);
        expect(iso((await LoanService.getById(l.id)).next_due_on)).toBe("2002-04-03");
    });
    test("an EMI repaid to the end: nothing left, interest booked equals the schedule's, listed last", async () => {
        const l = await loan({
            purpose: "FARM",
            terms: "EMI",
            annual_rate: 12,
            installment_count: 12,
            principal: 100000,
        });
        for (let i = 0; i < 11; i++) await pay(l.id, 8884.88);
        // The bank's own figures differ early on; the last payment still has to settle exactly.
        const left = Number((await LoanService.getById(l.id)).left);
        await pay(l.id, left);
        const row = await LoanService.getById(l.id);
        expect([row.left, row.next_due_on]).toEqual(["0.00", null]);
        expect(row.interest_booked).toBe(row.interest_total);
        const all = await LoanService.getAll();
        const firstRepaid = all.findIndex((x) => x.left === "0.00");
        expect(all.slice(firstRepaid).every((x) => x.left === "0.00")).toBe(true);
    });
    test("bank-statement interest early on is made up later: the total never exceeds the loan's interest", async () => {
        const l = await loan({ purpose: "FARM", terms: "FLAT", total_payable: 12000 });
        await pay(l.id, 3000, { interest: 1200 });
        await pay(l.id, 3000, { interest: 600 });
        await pay(l.id, 3000);
        await pay(l.id, 3000);
        const row = await LoanService.getById(l.id);
        expect([row.left, row.interest_booked]).toEqual(["0.00", "2000.00"]);
    });
    test("interest beyond what the loan has left is refused, and so is a payoff that skips it", async () => {
        const l = await loan({ purpose: "FARM", terms: "FLAT", total_payable: 12000 });
        expect(await status(pay(l.id, 3000, { interest: 2500 }))).toBe(400);
        expect(await status(pay(l.id, 12000, { interest: 0 }))).toBe(400);
        expect(await prisma.payment.count({ where: { ref_id: l.id, direction: "OUTGOING" } })).toBe(
            0,
        );
    });
    test("an installment can't be dated before the loan", async () => {
        const l = await loan({ purpose: "FARM", terms: "NONE" });
        expect(
            await status(pay(l.id, 2500, { payment_date: new Date(Date.UTC(2002, 1, 20)) })),
        ).toBe(400);
        expect(await status(pay(l.id, 2500, { payment_date: day(1) }))).toBe("ok");
    });
    test("two installments on one day each keep their own interest", async () => {
        const l = await loan({ purpose: "FARM", terms: "FLAT", total_payable: 12000 });
        const a = (await pay(l.id, 3000, { interest: 0 }))!.payment.id;
        const b = (await pay(l.id, 3000, { interest: 700 }))!.payment.id;
        const payments = (await LoanService.getById(l.id)).payments as {
            id: string;
            interest?: string | null;
        }[];
        const of = (id: string) => payments.find((p) => p.id === id)?.interest ?? null;
        expect([of(a), of(b)]).toEqual([null, "700.00"]);
    });
    test("a batch loan takes no interest figure and is payable after its batch closes", async () => {
        const l = await loan({
            purpose: "BATCH",
            batch_id: openBatch,
            terms: "FLAT",
            total_payable: 12000,
        });
        expect(await status(pay(l.id, 3000, { interest: 10 }))).toBe(400);
        await prisma.batches.update({ where: { id: openBatch }, data: { status: "CLOSED" } });
        try {
            expect(await status(pay(l.id, 3000))).toBe("ok");
        } finally {
            await prisma.batches.update({ where: { id: openBatch }, data: { status: "RUNNING" } });
        }
    });
    test("unknown loan 404; unknown and inactive accounts 400", async () => {
        const l = await loan({ purpose: "FARM", terms: "NONE" });
        expect(await status(pay(crypto.randomUUID(), 10))).toBe(404);
        expect(await status(LoanService.getById("nope"))).toBe(404);
        expect(await status(pay(l.id, 10, { from_instrument_id: crypto.randomUUID() }))).toBe(400);
        expect(await status(pay(l.id, 10, { from_instrument_id: inactive }))).toBe(400);
    });
    test("eight at once on a loan that fits four: exactly four land, interest adds up", async () => {
        const l = await loan({ purpose: "FARM", terms: "FLAT", total_payable: 12000 });
        const r = await Promise.all(Array.from({ length: 8 }, () => status(pay(l.id, 3000))));
        expect(r.filter((x) => x === "ok").length).toBe(4);
        const row = await LoanService.getById(l.id);
        expect([row.left, row.interest_booked]).toEqual(["0.00", "2000.00"]);
    });
    test("what's paid on a loan never counts the money borrowed", async () => {
        const l = await loan({ purpose: "FARM", terms: "NONE" });
        await pay(l.id, 2500);
        expect((await PaymentService.getTotalPaidForRef("LOAN", l.id)).total_paid.toNumber()).toBe(
            2500,
        );
        expect(
            (await PaymentService.paidByRef("LOAN")).find((r) => r.ref_id === l.id)?.total_paid,
        ).toBe("2500");
        expect((await PaymentService.outstandingForRef("LOAN", l.id)).toNumber()).toBe(7500);
    });
});

describe("removing a loan", () => {
    test("unknown is 404; a batch loan on a closed batch is refused; a removal is audited", async () => {
        expect(await status(LoanService.remove(crypto.randomUUID(), profileId))).toBe(404);
        const l = await loan({
            purpose: "BATCH",
            batch_id: openBatch,
            terms: "FLAT",
            total_payable: 11000,
        });
        await prisma.batches.update({ where: { id: openBatch }, data: { status: "CLOSED" } });
        expect(await status(LoanService.remove(l.id, profileId))).toBe(409);
        await prisma.batches.update({ where: { id: openBatch }, data: { status: "RUNNING" } });
        expect(await status(LoanService.remove(l.id, profileId))).toBe("ok");
        expect(
            await prisma.auditLog.count({
                where: { table_name: "Loan", record_id: l.id, action: "DELETE" },
            }),
        ).toBe(1);
    });
    test("removed and paid at the same moment: never a payment without its loan", async () => {
        for (let i = 0; i < 15; i++) {
            const l = await loan({
                purpose: "OLD_DEBT",
                terms: "NONE",
                to_instrument_id: undefined,
            });
            await Promise.all([
                status(pay(l.id, 100)),
                status(LoanService.remove(l.id, profileId)),
            ]);
            const [loans, payments] = await Promise.all([
                prisma.loan.count({ where: { id: l.id } }),
                prisma.payment.count({ where: { ref_type: "LOAN", ref_id: l.id } }),
            ]);
            expect([loans, payments]).toEqual(loans ? [1, 1] : [0, 0]);
        }
    });
});

describe("where it shows up", () => {
    test("finance: borrowing adds cash and debt, not profit; an installment's interest is the only cost", async () => {
        // July 2002: nothing else here is dated in it.
        const range = { from: day(1, 6), to: day(1, 7) };
        const read = async () => (await FinanceService.summary(range)).current;
        const a = await read();
        const l = await loan({
            purpose: "FARM",
            terms: "FLAT",
            total_payable: 12000,
            received_on: day(2, 6),
            first_due_on: day(20, 6),
        });
        const b = await read();
        expect([b.cash - a.cash, b.loans_owed - a.loans_owed, b.net_profit - a.net_profit]).toEqual(
            [10000, 12000, 0],
        );
        await pay(l.id, 3000, { payment_date: day(20, 6) });
        const c = await read();
        expect([c.cash - b.cash, c.loans_owed - b.loans_owed, c.net_profit - b.net_profit]).toEqual(
            [-3000, -3000, -500],
        );
        expect(c.payables - a.payables).toBe(0);
        expect(c.cost_breakdown.find((x) => x.code === "LOAN_INTEREST")?.amount).toBe(500);
        const month = (await SharedCostService.byMonth()).find((m) => m.month === "2002-07");
        expect(month?.expenses.map((e) => [e.category, e.amount])).toEqual([
            ["LOAN_INTEREST", 500],
        ]);
    });
    test("batch P&L carries a batch loan's interest, and only that batch's", async () => {
        await loan({ purpose: "BATCH", batch_id: openBatch, terms: "FLAT", total_payable: 10777 });
        const rows = await prisma.expense.findMany({
            where: { batch_id: openBatch, category: "LOAN_INTEREST" },
        });
        const total = rows.reduce((s, r) => s + Number(r.amount), 0);
        const line = async (id: string) =>
            (JSON.stringify(await BatchPnlService.statement(id)).match(
                /\{"section":"DIRECT","label":"Loan interest","amount":([\d.]+)\}/,
            ) ?? [])[1];
        expect(Number(await line(openBatch))).toBe(total);
        expect(await line(closedBatch)).toBeUndefined();
    });
    test("expenses: interest counts as paid, can't be paid again, can't be a purchase charge", async () => {
        const l = await loan({
            purpose: "FARM",
            terms: "FLAT",
            total_payable: 12000,
            received_on: day(2, 8),
            first_due_on: day(20, 8),
        });
        await pay(l.id, 3000, { payment_date: day(20, 8) });
        const s = await ExpenseService.summary({
            category: "LOAN_INTEREST",
            date_from: day(1, 8),
            date_to: day(30, 8),
        });
        expect([s.total, s.paid, s.unpaid]).toEqual([500, 500, 0]);
        const [row] = await interestRows(l.id);
        expect(
            await status(
                PaymentService.create({
                    ref_type: "EXPENSE",
                    ref_id: row!.id,
                    amount: 10,
                    payment_date: day(21, 8),
                    from_instrument_id: account,
                }),
            ),
        ).toBe(400);
        const charge = { category: "LOAN_INTEREST" };
        // The guard both PurchaseService.create and addCharge run on every charge.
        expect(() => checkExpensePaid(charge)).toThrow(/installment/);
    });
    test("a transfer: both balances move; not in cash flow; not listed as money in or out", async () => {
        const bal = async (id: string) =>
            (await PaymentInstrumentService.getBalance(id)).balance.toNumber();
        const [a0, b0] = [await bal(account), await bal(second)];
        const t = (await PaymentService.create({
            ref_type: "TRANSFER",
            amount: 700,
            payment_date: new Date(),
            from_instrument_id: account,
            to_instrument_id: second,
        }))!;
        expect([(await bal(account)) - a0, (await bal(second)) - b0]).toEqual([-700, 700]);
        const list = async (direction?: "INCOMING" | "OUTGOING") =>
            (
                await PaymentService.getAll({
                    page: 1,
                    limit: 100,
                    instrument_id: second,
                    ...(direction && { direction }),
                })
            ).payments.map((p) => p.id);
        expect(await list()).toContain(t.id);
        expect(await list("OUTGOING")).not.toContain(t.id);
        const before = (await FinanceService.monthly(1))[0]!;
        await PaymentService.create({
            ref_type: "TRANSFER",
            amount: 900,
            payment_date: new Date(),
            from_instrument_id: second,
            to_instrument_id: account,
        });
        const after = (await FinanceService.monthly(1))[0]!;
        expect([after.cash_in, after.cash_out, after.cash_end]).toEqual([
            before.cash_in,
            before.cash_out,
            before.cash_end,
        ]);
    });
    test("a transfer through an inactive account, or to itself, is refused by the service too", async () => {
        const t = (to: string) =>
            status(
                PaymentService.create({
                    ref_type: "TRANSFER",
                    amount: 1,
                    payment_date: day(3),
                    from_instrument_id: account,
                    to_instrument_id: to,
                }),
            );
        expect(await t(inactive)).toBe(400);
        expect(await t(account)).toBe(400);
    });
});

describe("database checks hold even past the service", () => {
    const refused = async (p: Promise<unknown>) => expect(await status(p)).toMatch(/^raw/);
    test("a transfer naming one account; a loan interest row without a loan; a batch loan without a batch", async () => {
        await refused(
            prisma.payment.create({
                data: {
                    amount: 1,
                    payment_date: day(3),
                    direction: "OUTGOING",
                    ref_type: "TRANSFER",
                    ref_id: "x",
                    from_instrument_id: account,
                },
            }),
        );
        await refused(
            prisma.payment.create({
                data: {
                    amount: 1,
                    payment_date: day(3),
                    direction: "INCOMING",
                    ref_type: "OWNER_CAPITAL",
                    ref_id: "x",
                    from_instrument_id: account,
                    to_instrument_id: second,
                },
            }),
        );
        await refused(
            prisma.expense.create({
                data: {
                    category: "LOAN_INTEREST",
                    cost_type: "SHARED_PERIOD",
                    amount: 1,
                    date: day(3),
                    recorded_by_id: profileId,
                },
            }),
        );
        await refused(
            prisma.loan.create({
                data: {
                    lender: "x",
                    purpose: "BATCH",
                    principal: 1,
                    terms: "NONE",
                    total_payable: 1,
                    installment_amount: 1,
                    installment_count: 1,
                    frequency: "ONE_OFF",
                    first_due_on: day(3),
                    received_on: day(3),
                    recorded_by_id: profileId,
                } satisfies Prisma.LoanUncheckedCreateInput,
            }),
        );
    });
});
