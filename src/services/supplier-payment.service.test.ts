import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { PaymentInstrumentService } from "./payment-instrument.service";
import { PaymentService } from "./payment.service";
import { SupplierPaymentService } from "./supplier-payment.service";
import {
    openingSchema,
    payInput,
    refundSchema,
    removePaymentSchema,
} from "@validators/supplier-payment.validator";
import {
    cleanSuppliers,
    makeAccount,
    makeBill,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";

let profileId: string;
let account: string;
let inactive: string;
const suppliers: string[] = [];
const accounts: string[] = [];
const supplier = async (over = {}) => {
    const id = await makeSupplier(over);
    suppliers.push(id);
    return id;
};
const at = (d: number, m = 0) => new Date(Date.UTC(2003, m, d));

beforeAll(async () => {
    profileId = await makeProfile("Supplier Pay");
    account = await makeAccount("Supplier pay A");
    inactive = await makeAccount("Supplier pay off", false);
    accounts.push(account, inactive);
});
afterAll(() => cleanSuppliers({ suppliers, accounts, profiles: [profileId] }));

describe("database checks", () => {
    // By the named CHECK, not by any error that happens to come first.
    const refused = async (p: Promise<unknown>, check: string) =>
        expect(
            await p.then(
                () => "ok",
                (e) => JSON.stringify(e) + String(e.message),
            ),
        ).toContain(check);
    test("an advance row needs its group", async () => {
        const id = await supplier();
        await refused(
            prisma.payment.create({
                data: {
                    amount: 1,
                    payment_date: at(1),
                    direction: "OUTGOING",
                    ref_type: "SUPPLIER_ADVANCE",
                    ref_id: id,
                    from_instrument_id: account,
                },
            }),
            "Payment_supplier_kind_has_group",
        );
    });
    test("a supplier payment is above zero", async () => {
        const id = await supplier();
        await refused(
            prisma.supplierPayment.create({
                data: {
                    supplier_id: id,
                    direction: "OUTGOING",
                    amount: 0,
                    payment_date: at(1),
                    instrument_id: account,
                    recorded_by_id: profileId,
                },
            }),
            "SupplierPayment_amount_positive",
        );
    });
    test("an old balance is never negative, and has a date", async () => {
        const id = await supplier();
        await refused(
            prisma.suppliers.update({
                where: { id },
                data: { opening_due: -1, opening_date: at(1) },
            }),
            "Suppliers_opening_sane",
        );
        await refused(
            prisma.suppliers.update({
                where: { id },
                data: { opening_due: 10, opening_date: null },
            }),
            "Suppliers_opening_sane",
        );
    });
});

const pay = (id: string, amount: number, over: Record<string, unknown> = {}) =>
    SupplierPaymentService.pay(id, {
        ...payInput.parse({ amount, payment_date: at(20), from_instrument_id: account, ...over }),
        recorded_by_id: profileId,
    });
const refund = (id: string, amount: number) =>
    SupplierPaymentService.refund(id, {
        ...refundSchema.parse({ amount, payment_date: at(21), to_instrument_id: account }),
        recorded_by_id: profileId,
    });
const bill = (id: string, total: number, d = 1) => makeBill(id, profileId, total, at(d));
const balance = async () => (await PaymentInstrumentService.getBalance(account)).balance.toNumber();
const due = async (b: string) => (await PaymentService.outstandingForRef("PURCHASE", b)).toNumber();
const status = (p: Promise<unknown>) =>
    p.then(
        () => "ok",
        (e: { status?: number; message: string }) => e.status ?? `raw: ${e.message}`,
    );
const groupsAddUp = async (supplier_id: string) => {
    const groups = await prisma.supplierPayment.findMany({
        where: { supplier_id },
        include: { payments: true },
    });
    for (const g of groups)
        expect(g.payments.reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0)).toBe(
            Math.round(Number(g.amount) * 100),
        );
    return groups.length;
};

describe("pay", () => {
    test("old balance first, the rest is an advance, one amount out of the account", async () => {
        const id = await supplier({ opening_due: 30000, opening_date: at(1) });
        const before = await balance();
        const p = await pay(id, 50000);
        expect(p!.payments.map((x) => [x.ref_type, x.ref_id, Number(x.amount)]).sort()).toEqual([
            ["SUPPLIER_ADVANCE", id, 20000],
            ["SUPPLIER_OPENING", id, 30000],
        ]);
        expect((await balance()) - before).toBe(-50000);
        expect(await SupplierPaymentService.dues(id)).toMatchObject({
            opening_left: "0.00",
            advance: "20000.00",
            bills: [],
        });
        await groupsAddUp(id);
    });
    test("oldest bill first by date, not by entry", async () => {
        const id = await supplier();
        const newer = await bill(id, 300, 9);
        const older = await bill(id, 300, 2);
        await pay(id, 400);
        expect([await due(older), await due(newer)]).toEqual([0, 200]);
        expect((await SupplierPaymentService.dues(id)).bills.map((b) => b.id)).toEqual([newer]);
    });
    test("an edited split pays only what it names", async () => {
        const id = await supplier();
        const older = await bill(id, 300, 2);
        const newer = await bill(id, 300, 9);
        await pay(id, 250, { split: { bills: [{ purchase_id: newer, amount: 200 }] } });
        expect([await due(older), await due(newer)]).toEqual([300, 100]);
        expect((await SupplierPaymentService.dues(id)).advance).toBe("50.00");
    });
    test("bad splits and accounts are refused and write nothing", async () => {
        const id = await supplier({ opening_due: 100, opening_date: at(1) });
        const b = await bill(id, 300);
        const other = await bill(await supplier(), 300);
        const bills = (...x: [string, number][]) => ({
            split: { bills: x.map(([purchase_id, amount]) => ({ purchase_id, amount })) },
        });
        expect(await status(pay(id, 100, bills([b, 150])))).toBe(400);
        expect(await status(pay(id, 500, bills([b, 301])))).toBe(400);
        expect(await status(pay(id, 500, bills([other, 10])))).toBe(400);
        expect(await status(pay(id, 500, bills([b, 10], [b, 10])))).toBe(400);
        expect(await status(pay(id, 500, { split: { opening: 101, bills: [] } }))).toBe(400);
        expect(await status(pay(id, 10, { from_instrument_id: inactive }))).toBe(400);
        expect(await status(pay(id, 10, { from_instrument_id: crypto.randomUUID() }))).toBe(400);
        expect(await status(pay(crypto.randomUUID(), 10))).toBe(404);
        expect(
            payInput.safeParse({ amount: 0.001, payment_date: at(1), from_instrument_id: account })
                .success,
        ).toBe(false);
        expect(
            payInput.safeParse({ amount: 1e8, payment_date: at(1), from_instrument_id: account })
                .success,
        ).toBe(false);
        expect(await groupsAddUp(id)).toBe(0);
        expect(await due(b)).toBe(300);
    });
    test("an inactive supplier can still be paid what they're owed", async () => {
        const id = await supplier({ is_active: false });
        await bill(id, 100);
        expect(await status(pay(id, 100))).toBe("ok");
    });
    test("eight at once on one bill: never overpaid, the rest is advance", async () => {
        const id = await supplier();
        const b = await bill(id, 3000);
        const r = await Promise.all(Array.from({ length: 8 }, () => status(pay(id, 1000))));
        expect(r.every((x) => x === "ok")).toBe(true);
        expect(await due(b)).toBe(0);
        expect((await SupplierPaymentService.dues(id)).advance).toBe("5000.00");
        expect(await groupsAddUp(id)).toBe(8);
    });
    test("a lump payment racing a payment on the bill itself: the bill is never overpaid", async () => {
        for (let i = 0; i < 8; i++) {
            const id = await supplier();
            const b = await bill(id, 100);
            await Promise.all([
                status(pay(id, 100)),
                status(
                    PaymentService.create({
                        ref_type: "PURCHASE",
                        ref_id: b,
                        amount: 100,
                        payment_date: at(20),
                        from_instrument_id: account,
                    }),
                ),
            ]);
            expect(await due(b)).toBe(0);
            await groupsAddUp(id);
        }
    });
});

describe("refund", () => {
    test("up to the advance held, into the account; not a paisa more", async () => {
        const id = await supplier();
        await pay(id, 500);
        const before = await balance();
        await refund(id, 200);
        expect((await balance()) - before).toBe(200);
        expect((await SupplierPaymentService.dues(id)).advance).toBe("300.00");
        expect(await status(refund(id, 300.01))).toBe(400);
        expect(await status(refund(id, 300))).toBe("ok");
        expect((await SupplierPaymentService.dues(id)).advance).toBe("0.00");
        await groupsAddUp(id);
    });
    test("nothing to refund when no advance is held, and four at once can't pass it", async () => {
        const id = await supplier();
        expect(await status(refund(id, 1))).toBe(400);
        await pay(id, 100);
        const r = await Promise.all(Array.from({ length: 4 }, () => status(refund(id, 60))));
        expect(r.filter((x) => x === "ok").length).toBe(1);
    });
});

describe("remove", () => {
    const remove = (id: string, payment: string, reason = "Entered twice") =>
        SupplierPaymentService.remove(id, payment, reason, profileId);
    test("dues and account go back, and the audit log keeps it with the reason", async () => {
        const id = await supplier({ opening_due: 100, opening_date: at(1) });
        const b = await bill(id, 300);
        const before = await balance();
        const p = await pay(id, 500);
        await remove(id, p!.id);
        expect((await balance()) - before).toBe(0);
        expect(await due(b)).toBe(300);
        expect(await SupplierPaymentService.dues(id)).toMatchObject({
            opening_left: "100.00",
            advance: "0.00",
        });
        const log = await prisma.auditLog.findFirstOrThrow({
            where: { table_name: "SupplierPayment", record_id: p!.id },
        });
        expect([log.action, log.note]).toEqual([
            "DELETE",
            expect.stringContaining("Entered twice"),
        ]);
        expect(JSON.stringify(log.before_data)).toContain(b);
    });
    test("refused when the supplier would be left refunded more than they were paid", async () => {
        const id = await supplier();
        const p = await pay(id, 100);
        const r = await refund(id, 60);
        expect(await status(remove(id, p!.id))).toBe(409);
        expect(await status(remove(id, r!.id))).toBe("ok");
        expect(await status(remove(id, p!.id))).toBe("ok");
    });
    test("unknown, or another supplier's, is 404; a reason is required", async () => {
        const id = await supplier();
        const p = await pay(id, 100);
        expect(await status(remove(id, crypto.randomUUID()))).toBe(404);
        expect(await status(remove(await supplier(), p!.id))).toBe(404);
        expect(removePaymentSchema.safeParse({ reason: "  a " }).success).toBe(false);
    });
    test("paid and removed at once: every group left adds up and no row is orphaned", async () => {
        const id = await supplier();
        await bill(id, 1000);
        for (let i = 0; i < 15; i++) {
            const p = await pay(id, 40);
            await Promise.all([status(pay(id, 30)), status(remove(id, p!.id))]);
        }
        expect(await groupsAddUp(id)).toBe(15);
    });
});

describe("old balance", () => {
    const set = (id: string, amount: number) =>
        SupplierPaymentService.setOpening(
            id,
            openingSchema.parse({
                opening_due: amount,
                opening_date: at(1),
                opening_note: "From the khata",
            }),
            profileId,
        );
    test("set, changed, never below what's been paid on it; audited", async () => {
        const id = await supplier();
        await set(id, 500);
        await pay(id, 200);
        expect(await status(set(id, 199.99))).toBe(409);
        expect(await status(set(id, 200))).toBe("ok");
        expect((await SupplierPaymentService.dues(id)).opening_left).toBe("0.00");
        expect(
            await prisma.auditLog.count({ where: { table_name: "Suppliers", record_id: id } }),
        ).toBe(2);
        expect(await status(set(crypto.randomUUID(), 1))).toBe(404);
        expect(openingSchema.safeParse({ opening_due: -1, opening_date: at(1) }).success).toBe(
            false,
        );
    });
});
