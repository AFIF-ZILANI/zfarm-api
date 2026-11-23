import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { AnalyticsService } from "./analytics.service";
import { FinanceService } from "./finance.service";
import { PaymentService } from "./payment.service";
import { SupplierPaymentService, useAdvance } from "./supplier-payment.service";
import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";
import { payInput, refundSchema } from "@validators/supplier-payment.validator";
import {
    cleanSuppliers,
    makeAccount,
    makeBill,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";

// 2004: a year no other fixture uses. Balances are still compared as differences, test to test.
const at = (d: number, m: number) => new Date(Date.UTC(2004, m - 1, d));
let profileId: string;
let account: string;
const suppliers: string[] = [];
const supplier = async (over = {}) => {
    const id = await makeSupplier(over);
    suppliers.push(id);
    return id;
};
const pay = (id: string, amount: number, date: Date, over = {}) =>
    SupplierPaymentService.pay(id, {
        ...payInput.parse({ amount, payment_date: date, from_instrument_id: account, ...over }),
        recorded_by_id: profileId,
    });
/** Balances as of the start of `to`. */
const asOf = async (to: Date) => {
    const c = (await FinanceService.summary({ from: at(1, 1), to })).current;
    return {
        payables: c.payables,
        advances: c.supplier_advances,
        cash: c.cash,
        profit: c.net_profit,
    };
};
const minus = (a: Awaited<ReturnType<typeof asOf>>, b: Awaited<ReturnType<typeof asOf>>) => ({
    payables: a.payables - b.payables,
    advances: a.advances - b.advances,
    cash: a.cash - b.cash,
    profit: a.profit - b.profit,
});
const apply = (supplier_id: string, purchase_id: string, amount: number) =>
    prisma.$transaction((tx) =>
        useAdvance(tx, { supplier_id, purchase_id, amount: new Prisma.Decimal(amount) }),
    );

beforeAll(async () => {
    profileId = await makeProfile("Finance Suppliers");
    account = await makeAccount("Finance suppliers");
});
afterAll(() => cleanSuppliers({ suppliers, accounts: [account], profiles: [profileId] }));

describe("finance with suppliers", () => {
    test("an advance never hides the same supplier's old balance", async () => {
        const before = await asOf(at(1, 12));
        const id = await supplier({ opening_due: 1000, opening_date: at(1, 3) });
        await pay(id, 400, at(5, 3), { split: { bills: [] } });
        expect(minus(await asOf(at(1, 12)), before)).toEqual({
            payables: 1000,
            advances: 400,
            cash: -400,
            profit: 0,
        });
        const top = (await FinanceService.owed(1000)).payables.top.find((r) => r.id === id);
        expect(top?.due).toBe(1000);
    });
    test("an old balance counts from its date, and falls as it's paid", async () => {
        const [early, late] = [await asOf(at(1, 4)), await asOf(at(1, 12))];
        const id = await supplier({ opening_due: 900, opening_date: at(10, 4) });
        await pay(id, 300, at(20, 4));
        expect(minus(await asOf(at(1, 4)), early).payables).toBe(0);
        expect(minus(await asOf(at(1, 12)), late)).toMatchObject({ payables: 600, advances: 0 });
        expect((await FinanceService.owed(1000)).payables.top.find((r) => r.id === id)?.due).toBe(
            600,
        );
    });
    test("looking back: an advance used on a later bill still reads as an advance before that bill", async () => {
        const [march, may] = [await asOf(at(1, 4)), await asOf(at(1, 5))];
        const id = await supplier();
        await pay(id, 500, at(10, 3));
        const b = await makeBill(id, profileId, 500, at(10, 4));
        await apply(id, b, 500);
        expect(minus(await asOf(at(1, 4)), march)).toEqual({
            payables: 0,
            advances: 500,
            cash: -500,
            profit: 0,
        });
        expect(minus(await asOf(at(1, 5)), may)).toEqual({
            payables: 0,
            advances: 0,
            cash: -500,
            profit: 0,
        });
    });
    test("one supplier's advance doesn't reduce what another is owed", async () => {
        const before = await asOf(at(1, 12));
        await pay(await supplier(), 700, at(1, 6));
        await makeBill(await supplier(), profileId, 300, at(2, 6));
        expect(minus(await asOf(at(1, 12)), before)).toMatchObject({
            payables: 300,
            advances: 700,
        });
    });
    test("a refund lowers the advance and brings the cash back", async () => {
        const id = await supplier();
        await pay(id, 500, at(1, 7));
        const before = await asOf(at(1, 12));
        await SupplierPaymentService.refund(id, {
            ...refundSchema.parse({
                amount: 200,
                payment_date: at(2, 7),
                to_instrument_id: account,
            }),
            recorded_by_id: profileId,
        });
        expect(minus(await asOf(at(1, 12)), before)).toEqual({
            payables: 0,
            advances: -200,
            cash: 200,
            profit: 0,
        });
    });
    test("a payment on the bill itself still lowers what we owe", async () => {
        const b = await makeBill(await supplier(), profileId, 300, at(1, 8));
        const before = await asOf(at(1, 12));
        await PaymentService.create({
            ref_type: "PURCHASE",
            ref_id: b,
            amount: 120,
            payment_date: at(2, 8),
            from_instrument_id: account,
        });
        expect(minus(await asOf(at(1, 12)), before)).toMatchObject({ payables: -120, advances: 0 });
    });
    test("the dashboard's payables move exactly as Finance's do", async () => {
        const now = new Date();
        const read = async () => [
            Number((await AnalyticsService.financialDashboard({})).outstanding_payables),
            (await FinanceService.summary({ from: at(1, 1), to: now })).current.payables,
        ];
        const [a0, f0] = await read();
        const id = await supplier({ opening_due: 250, opening_date: at(1, 9) });
        await pay(id, 100, at(2, 9));
        await pay(await supplier(), 5000, at(3, 9));
        const [a1, f1] = await read();
        expect([a1! - a0!, f1! - f0!].map((n) => Number(n.toFixed(2)))).toEqual([150, 150]);
    });
});
