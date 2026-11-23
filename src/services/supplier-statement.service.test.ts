import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { PaymentService } from "./payment.service";
import { SupplierPaymentService } from "./supplier-payment.service";
import { SupplierStatementService } from "./supplier-statement.service";
import { payInput, refundSchema } from "@validators/supplier-payment.validator";
import {
    cleanSuppliers,
    makeAccount,
    makeBill,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";

let profileId: string;
let account: string;
const suppliers: string[] = [];
const at = (d: number, m = 0) => new Date(Date.UTC(2005, m, d));
const supplier = async (over = {}) => {
    const id = await makeSupplier(over);
    suppliers.push(id);
    return id;
};
const bill = (id: string, total: number, date: Date, over = {}) =>
    makeBill(id, profileId, total, date, over);
const pay = (id: string, amount: number, date: Date, over = {}) =>
    SupplierPaymentService.pay(id, {
        ...payInput.parse({ amount, payment_date: date, from_instrument_id: account, ...over }),
        recorded_by_id: profileId,
    });
const statement = (id: string, q = {}) => SupplierStatementService.statement(id, q);

beforeAll(async () => {
    profileId = await makeProfile("Supplier Statement");
    account = await makeAccount("Statement cash");
});
afterAll(() => cleanSuppliers({ suppliers, accounts: [account], profiles: [profileId] }));

describe("statement", () => {
    test("old balance, bill, payment: a running balance, and what the payment settled", async () => {
        const id = await supplier({ opening_due: 60000, opening_date: at(1) });
        const b = await bill(id, 75000, at(5), { invoice_no: "INV-201" });
        await pay(id, 50000, at(12), { transaction_ref: "8841" });
        const s = await statement(id);
        expect(s.lines.map((l) => [l.kind, l.adds, l.paid, l.balance])).toEqual([
            ["OPENING", "60000.00", null, "60000.00"],
            ["BILL", "75000.00", null, "135000.00"],
            ["PAYMENT", null, "50000.00", "85000.00"],
        ]);
        expect(s.lines[1]).toMatchObject({ purchase_id: b, label: "Bill INV-201" });
        expect(s.lines[2]).toMatchObject({
            account: "Statement cash",
            transaction_ref: "8841",
            settled: [{ label: "Old balance", amount: "50000.00" }],
        });
        expect([s.brought_forward, s.closing, s.bought, s.paid]).toEqual([
            "0.00",
            "85000.00",
            "75000.00",
            "50000.00",
        ]);
    });
    test("paid over several bills is one line, naming each part", async () => {
        const id = await supplier();
        await bill(id, 100, at(1), { invoice_no: "A" });
        await bill(id, 100, at(2), { invoice_no: "B" });
        await pay(id, 250, at(3));
        const line = (await statement(id)).lines.filter((l) => l.kind === "PAYMENT");
        expect(line.map((l) => [l.paid, l.settled])).toEqual([
            [
                "250.00",
                [
                    { label: "Bill A", amount: "100.00" },
                    { label: "Bill B", amount: "100.00" },
                    { label: "Advance", amount: "50.00" },
                ],
            ],
        ]);
    });
    test("a supplier holding an advance shows a negative balance", async () => {
        const id = await supplier();
        await pay(id, 20000, at(1, 1));
        await bill(id, 5000, at(10, 1));
        expect((await statement(id)).lines.map((l) => l.balance)).toEqual([
            "-20000.00",
            "-15000.00",
        ]);
    });
    test("a refund adds back", async () => {
        const id = await supplier();
        await pay(id, 500, at(1));
        await SupplierPaymentService.refund(id, {
            ...refundSchema.parse({ amount: 200, payment_date: at(2), to_instrument_id: account }),
            recorded_by_id: profileId,
        });
        const s = await statement(id);
        expect(s.lines.map((l) => [l.kind, l.adds, l.paid, l.balance])).toEqual([
            ["PAYMENT", null, "500.00", "-500.00"],
            ["REFUND", "200.00", null, "-300.00"],
        ]);
        expect(s.lines[1]!.account).toBe("Statement cash");
    });
    test("an older bill that stored what was paid on it balances to zero", async () => {
        const id = await supplier();
        await bill(id, 500, at(1), { paid_amount: 500, due_amount: 0 });
        const s = await statement(id);
        expect(s.lines.map((l) => l.kind)).toEqual(["BILL", "PAID_WITH_BILL"]);
        expect([s.closing, s.paid]).toEqual(["0.00", "500.00"]);
    });
    test("a payment recorded on the bill itself is its own line", async () => {
        const id = await supplier();
        const b = await bill(id, 500, at(1), { invoice_no: "Z" });
        await PaymentService.create({
            ref_type: "PURCHASE",
            ref_id: b,
            amount: 200,
            payment_date: at(2),
            from_instrument_id: account,
            note: "hand cash",
        });
        const line = (await statement(id)).lines[1]!;
        expect(line).toMatchObject({
            kind: "PAYMENT",
            paid: "200.00",
            note: "hand cash",
            supplier_payment_id: null,
            settled: [{ label: "Bill Z", amount: "200.00" }],
        });
    });
    test("every bill counts, however many there are", async () => {
        const id = await supplier();
        for (let i = 0; i < 120; i++) await bill(id, 10, at(1 + (i % 28)));
        const s = await statement(id);
        expect([s.lines.length, s.closing]).toEqual([120, "1200.00"]);
    });
    test("a date range brings the earlier balance forward; both ends are included", async () => {
        const id = await supplier({ opening_due: 100, opening_date: at(1) });
        await bill(id, 50, at(5));
        await pay(id, 30, at(10));
        await bill(id, 70, at(15));
        const s = await statement(id, { from: "2005-01-05", to: "2005-01-10" });
        expect([s.brought_forward, s.closing]).toEqual(["100.00", "120.00"]);
        expect(s.lines.map((l) => l.kind)).toEqual(["BILL", "PAYMENT"]);
        expect([s.bought, s.paid]).toEqual(["50.00", "30.00"]);
        const late = await statement(id, { from: "2005-01-11" });
        expect([late.brought_forward, late.closing]).toEqual(["120.00", "190.00"]);
    });
    test("on one day: old balance, bill, then payment", async () => {
        const id = await supplier({ opening_due: 1, opening_date: at(5) });
        await pay(id, 5, at(5));
        await bill(id, 9, new Date(at(5).getTime() + 3600_000));
        expect((await statement(id)).lines.map((l) => l.kind)).toEqual([
            "OPENING",
            "BILL",
            "PAYMENT",
        ]);
    });
    test("nothing yet, and an unknown supplier", async () => {
        const s = await statement(await supplier());
        expect([s.lines, s.closing]).toEqual([[], "0.00"]);
        await expect(statement(crypto.randomUUID())).rejects.toThrow(/not found/i);
    });
});

describe("balances", () => {
    test("what each is owed less the advance they hold is their statement's closing balance", async () => {
        const id = await supplier({ opening_due: 100, opening_date: at(1) });
        await bill(id, 40, at(2));
        await pay(id, 50, at(3), { split: { bills: [] } });
        const rows = await SupplierStatementService.balances();
        expect(rows.find((r) => r.supplier_id === id)).toEqual({
            supplier_id: id,
            opening_left: "100.00",
            bills_due: "40.00",
            owed: "140.00",
            advance: "50.00",
        });
        const all = await prisma.suppliers.count();
        expect(rows.length).toBe(all);
        for (const r of rows) {
            const closing = (await statement(r.supplier_id)).closing;
            expect([r.supplier_id, (Number(r.owed) - Number(r.advance)).toFixed(2)]).toEqual([
                r.supplier_id,
                closing,
            ]);
        }
    });
});
