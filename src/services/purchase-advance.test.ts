import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { sharedWarehouseId } from "@lib/test-fixtures";
import { FinanceService } from "./finance.service";
import { PaymentInstrumentService } from "./payment-instrument.service";
import { PaymentService } from "./payment.service";
import { PurchaseService } from "./purchase.service";
import { SupplierPaymentService } from "./supplier-payment.service";
import { SupplierStatementService } from "./supplier-statement.service";
import { createPurchaseSchema } from "@validators/purchase.validator";
import { payInput, refundSchema } from "@validators/supplier-payment.validator";
import {
    cleanSuppliers,
    makeAccount,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";

// 2006: a year no other fixture uses, so the finance figures for it are ours alone.
const at = (d: number, m = 0) => new Date(Date.UTC(2006, m, d));
let profileId: string;
let account: string;
let itemId: string;
let warehouse: string;
const suppliers: string[] = [];
const supplier = async () => {
    const id = await makeSupplier();
    suppliers.push(id);
    return id;
};
const body = (over: Record<string, unknown> = {}) => ({
    warehouse_id: warehouse,
    purchase_date: at(10),
    items: [{ item_id: itemId, quantity: 1, unit: "KG", unit_price: 75000 }],
    ...over,
});
const buy = async (total: number, over: Record<string, unknown> = {}) => {
    const { supplier_id, ...input } = createPurchaseSchema.parse({
        ...body(),
        supplier_id: crypto.randomUUID(),
        items: [{ item_id: itemId, quantity: 1, unit: "KG", unit_price: total }],
        ...over,
    });
    // `no_supplier`: an in-process caller that names none.
    const named = over["no_supplier"] ? {} : { supplier_id };
    return (await PurchaseService.create({ ...input, ...named, recorded_by_id: profileId }))!;
};
const pay = (id: string, amount: number, d = 1, over: Record<string, unknown> = {}) =>
    SupplierPaymentService.pay(id, {
        ...payInput.parse({ amount, payment_date: at(d), from_instrument_id: account, ...over }),
        recorded_by_id: profileId,
    });
const due = async (b: string) => (await PaymentService.outstandingForRef("PURCHASE", b)).toNumber();
const advance = async (id: string) => Number((await SupplierPaymentService.dues(id)).advance);
const cash = async () => (await PaymentInstrumentService.getBalance(account)).balance.toNumber();
const status = (p: Promise<unknown>) =>
    p.then(
        () => "ok",
        (e: { status?: number; message: string }) => e.status ?? `raw: ${e.message}`,
    );
const groupSums = async (supplier_id: string) =>
    (
        await prisma.supplierPayment.findMany({
            where: { supplier_id },
            include: { payments: true },
        })
    ).map((g) => [Number(g.amount), g.payments.reduce((s, p) => s + Number(p.amount), 0)]);

beforeAll(async () => {
    profileId = await makeProfile("Purchase Advance");
    account = await makeAccount("Advance cash");
    warehouse = await sharedWarehouseId();
    const key = `advance feed ${crypto.randomUUID()}`;
    itemId = (
        await prisma.item.create({
            data: { name: key, normalized_key: key, category: "FEED", unit: "KG" },
        })
    ).id;
});
afterAll(async () => {
    await prisma.stockLedger.deleteMany({ where: { item_id: itemId } });
    await cleanSuppliers({ suppliers, accounts: [account], profiles: [] });
    await prisma.item.delete({ where: { id: itemId } });
    await cleanSuppliers({ suppliers: [], accounts: [], profiles: [profileId] });
});

describe("a new bill uses the advance", () => {
    test("a purchase entered through the API names its supplier", () => {
        expect(createPurchaseSchema.safeParse(body()).success).toBe(false);
        expect(
            createPurchaseSchema.safeParse(body({ supplier_id: crypto.randomUUID() })).success,
        ).toBe(true);
        expect(
            createPurchaseSchema.safeParse(
                body({ supplier_id: crypto.randomUUID(), use_advance: 0.001 }),
            ).success,
        ).toBe(false);
    });
    test("due falls, the advance is used, and no cash moves again", async () => {
        const id = await supplier();
        await pay(id, 20000);
        const before = [
            await cash(),
            (await FinanceService.summary({ from: at(1), to: at(1, 6) })).current.cash,
        ];
        const p = await buy(75000, { supplier_id: id, use_advance: 20000 });
        expect([await due(p.id), await advance(id)]).toEqual([55000, 0]);
        expect([
            await cash(),
            (await FinanceService.summary({ from: at(1), to: at(1, 6) })).current.cash,
        ]).toEqual(before);
        expect(await groupSums(id)).toEqual([[20000, 20000]]);
        const s = await SupplierStatementService.statement(id, {});
        expect(s.lines.map((l) => [l.kind, l.balance])).toEqual([
            ["PAYMENT", "-20000.00"],
            ["BILL", "55000.00"],
        ]);
        const row = await prisma.payment.findFirstOrThrow({
            where: { ref_type: "PURCHASE", ref_id: p.id },
        });
        expect([row.payment_date, row.from_instrument_id]).toEqual([at(1), account]);
    });
    test("the oldest advance goes first, the last one in part", async () => {
        const id = await supplier();
        const newer = (await pay(id, 100, 5))!.id;
        const older = (await pay(id, 100, 2))!.id;
        await buy(150, { supplier_id: id, use_advance: 150 });
        const left = await prisma.payment.findMany({
            where: { ref_type: "SUPPLIER_ADVANCE", ref_id: id },
        });
        expect(left.map((r) => [r.supplier_payment_id, Number(r.amount)])).toEqual([[newer, 50]]);
        expect(older).not.toBe(newer);
        expect(await groupSums(id)).toEqual([
            [100, 100],
            [100, 100],
        ]);
    });
    test("paying part now and part from the advance", async () => {
        const id = await supplier();
        await pay(id, 60);
        const p = await buy(100, {
            supplier_id: id,
            use_advance: 60,
            paid_amount: 40,
            paid_from_instrument_id: account,
        });
        expect(await due(p.id)).toBe(0);
    });
    test("too much advance, more than the total, or no supplier: refused, nothing saved", async () => {
        const id = await supplier();
        await pay(id, 100);
        const n = () => prisma.purchase.count({ where: { recorded_by_id: profileId } });
        const before = await n();
        expect(await status(buy(500, { supplier_id: id, use_advance: 100.01 }))).toBe(400);
        expect(
            await status(
                buy(120, {
                    supplier_id: id,
                    use_advance: 100,
                    paid_amount: 21,
                    paid_from_instrument_id: account,
                }),
            ),
        ).toBe(400);
        expect(await status(buy(500, { no_supplier: true, use_advance: 10 }))).toBe(400);
        expect([await n(), await advance(id)]).toEqual([before, 100]);
    });
    test("what the supplier gave back can't be used", async () => {
        const id = await supplier();
        await pay(id, 100);
        await SupplierPaymentService.refund(id, {
            ...refundSchema.parse({ amount: 70, payment_date: at(2), to_instrument_id: account }),
            recorded_by_id: profileId,
        });
        expect(await status(buy(500, { supplier_id: id, use_advance: 31 }))).toBe(400);
        expect(await status(buy(500, { supplier_id: id, use_advance: 30 }))).toBe("ok");
        expect(await advance(id)).toBe(0);
    });
    test("two bills at once can't both use it", async () => {
        const id = await supplier();
        await pay(id, 100);
        const r = await Promise.all(
            [1, 2].map(() => status(buy(100, { supplier_id: id, use_advance: 100 }))),
        );
        expect(r.sort()).toEqual([400, "ok"] as never);
        expect(await advance(id)).toBe(0);
    });
    test("profit is the same whether or not the advance is used", async () => {
        const id = await supplier();
        const profit = async () =>
            (await FinanceService.summary({ from: at(1), to: at(1, 6) })).current.net_profit;
        const a = await profit();
        await pay(id, 500);
        const b = await profit();
        await buy(500, { supplier_id: id, use_advance: 500 });
        expect([b, await profit()]).toEqual([a, a]);
    });
});

describe("removing a purchase", () => {
    test("its part of a lump payment becomes advance, the other bill stays paid, its own payment goes", async () => {
        const id = await supplier();
        const a = await buy(500, { supplier_id: id });
        const b = await buy(200, { supplier_id: id, purchase_date: at(12) });
        await PaymentService.create({
            ref_type: "PURCHASE",
            ref_id: a.id,
            amount: 200,
            payment_date: at(13),
            from_instrument_id: account,
        });
        await pay(id, 500, 14);
        expect([await due(a.id), await due(b.id)]).toEqual([0, 0]);
        const before = await cash();
        await PurchaseService.remove(a.id, profileId);
        expect((await cash()) - before).toBe(200); // only the payment recorded on the bill itself
        expect([await advance(id), await due(b.id)]).toEqual([300, 0]);
        expect(await groupSums(id)).toEqual([[500, 500]]);
        expect((await SupplierStatementService.statement(id, {})).closing).toBe("-300.00");
        const log = await prisma.auditLog.findFirstOrThrow({
            where: { table_name: "Purchase", record_id: a.id, action: "DELETE" },
        });
        expect(JSON.stringify(log.before_data)).toContain("returned_to_advance");
    });
    test("removed while its supplier is being paid: every group adds up, nothing points at a missing bill", async () => {
        for (let i = 0; i < 12; i++) {
            const id = await supplier();
            const p = await buy(100, { supplier_id: id });
            await Promise.all([
                status(pay(id, 100, 11)),
                status(PurchaseService.remove(p.id, profileId)),
            ]);
            expect(
                await prisma.payment.count({ where: { ref_type: "PURCHASE", ref_id: p.id } }),
            ).toBe(0);
            expect(await groupSums(id)).toEqual([[100, 100]]);
            expect(await advance(id)).toBe(100);
        }
    });
});
