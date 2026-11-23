import prisma from "@lib/db";
import { purgeAuditLog, sharedWarehouseId } from "@lib/test-fixtures";

const mobile = () => `+880${Math.floor(1e9 + Math.random() * 8e9)}`;

export async function makeProfile(name: string) {
    return (await prisma.profiles.create({ data: { name, mobile: mobile(), role: "ADMIN" } })).id;
}
export async function makeAccount(label: string, is_active = true) {
    return (await prisma.paymentInstrument.create({ data: { type: "CASH", label, is_active } })).id;
}
export async function makeSupplier(over: Record<string, unknown> = {}) {
    const p = await prisma.profiles.create({
        data: { name: "Test Supplier", mobile: mobile(), role: "SUPPLIER" },
    });
    return (await prisma.suppliers.create({ data: { profile_id: p.id, role: "DEALER", ...over } }))
        .id;
}
/** A bill with no lines: what a supplier is owed doesn't depend on what was bought. */
export async function makeBill(
    supplier_id: string,
    recorded_by_id: string,
    total: number,
    purchase_date: Date,
    over: Record<string, unknown> = {},
) {
    return (
        await prisma.purchase.create({
            data: {
                supplier_id,
                warehouse_id: await sharedWarehouseId(),
                purchase_date,
                total_amount: total,
                paid_amount: 0,
                due_amount: total,
                recorded_by_id,
                ...over,
            },
        })
    ).id;
}
export async function cleanSuppliers(f: {
    suppliers: string[];
    accounts: string[];
    profiles: string[];
}) {
    const bills = await prisma.purchase.findMany({
        where: { supplier_id: { in: f.suppliers } },
        select: { id: true, items: { select: { id: true, item_id: true } } },
    });
    const lines = bills.flatMap((b) => b.items);
    await prisma.payment.deleteMany({
        where: {
            OR: [
                { ref_id: { in: [...bills.map((b) => b.id), ...f.suppliers] } },
                { from_instrument_id: { in: f.accounts } },
                { to_instrument_id: { in: f.accounts } },
            ],
        },
    });
    await prisma.supplierPayment.deleteMany({ where: { supplier_id: { in: f.suppliers } } });
    await prisma.stockLedger.deleteMany({ where: { ref_id: { in: lines.map((l) => l.id) } } });
    await prisma.purchaseItem.deleteMany({ where: { id: { in: lines.map((l) => l.id) } } });
    await prisma.purchase.deleteMany({ where: { id: { in: bills.map((b) => b.id) } } });
    const rows = await prisma.suppliers.findMany({
        where: { id: { in: f.suppliers } },
        select: { profile_id: true },
    });
    await prisma.suppliers.deleteMany({ where: { id: { in: f.suppliers } } });
    await prisma.paymentInstrument.deleteMany({ where: { id: { in: f.accounts } } });
    await purgeAuditLog({ where: { changed_by_id: { in: f.profiles } } });
    await prisma.profiles.deleteMany({
        where: { id: { in: [...f.profiles, ...rows.map((r) => r.profile_id)] } },
    });
}
