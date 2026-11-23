import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import {
    cleanSuppliers,
    makeAccount,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";

let profileId: string;
let account: string;
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
    accounts.push(account);
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
