import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";
import { getItemAvgCosts } from "@lib/stock-value";
import { chargeRatios, landedTotal } from "@lib/purchase-charges";
import { isNonDepleting } from "@lib/coded-stock";
import { NEVER_OWED_EXPENSE_CATEGORIES } from "@lib/paid-at-create";

/**
 * The farm's money, for the Finance overview. Profit counts what was *used*, not what was bought, the same
 * rules as the batch P&L, so the two pages agree:
 *   revenue = sales + bird sales, net of discounts
 *   costs   = chicks bought onto a batch + stock consumed (avg purchase cost; equipment excluded, it reaches
 *             a batch through depreciation) + every expense (salaries included) + depreciation + stock
 *             written off (wastage / expired / disposed)
 * Cash, receivables and payables are balances "as of" an instant, so two periods can be compared.
 *
 * ponytail: every figure is a handful of aggregate queries per period, and the monthly series repeats them
 * per month -- fine at farm scale (hundreds of rows a month). Precompute monthly rollups if it ever drags.
 */

const D = (v: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(v ?? 0);
const n = (d: Prisma.Decimal) => Number(d.toFixed(2));

export type CostLine = {
    kind: "CHICKS" | "STOCK" | "EXPENSE" | "DEPRECIATION" | "STOCK_LOSS";
    code: string;
    label: string;
    amount: number;
};

type Range = { from: Date; to: Date }; // [from, to)

async function categoryLabels() {
    const [items, expenses] = await Promise.all([
        prisma.itemCategory.findMany({ select: { code: true, label: true } }),
        prisma.expenseCategoryLookup.findMany({ select: { code: true, label: true } }),
    ]);
    return {
        item: new Map(items.map((c) => [c.code, c.label])),
        expense: new Map(expenses.map((c) => [c.code, c.label])),
    };
}

async function revenueIn({ from, to }: Range) {
    const [bird, regular] = await Promise.all([
        prisma.birdSale.aggregate({
            where: { sale_date: { gte: from, lt: to } },
            _sum: { total_amount: true, discount_amount: true },
        }),
        prisma.sale.aggregate({
            where: { sale_date: { gte: from, lt: to } },
            _sum: { total: true },
        }),
    ]);
    return D(bird._sum.total_amount)
        .minus(D(bird._sum.discount_amount))
        .plus(D(regular._sum.total));
}

async function costsIn(
    { from, to }: Range,
    labels: Awaited<ReturnType<typeof categoryLabels>>,
): Promise<CostLine[]> {
    const [chicks, consumed, expenses, depreciation, losses] = await Promise.all([
        prisma.purchaseItem.findMany({
            where: { batch_id: { not: null }, purchase: { purchase_date: { gte: from, lt: to } } },
            select: { purchase_id: true, total_price: true, item: { select: { category: true } } },
        }),
        prisma.consumption.findMany({
            where: { date: { gte: from, lt: to } },
            select: { item_id: true, base_quantity: true, item: { select: { category: true } } },
        }),
        prisma.expense.groupBy({
            by: ["category"],
            // A purchase charge (STOCK) is already inside stock cost via the landed average -- not again here.
            where: { date: { gte: from, lt: to }, cost_type: { not: "STOCK" } },
            _sum: { amount: true },
        }),
        prisma.assetDepreciation.aggregate({
            where: { computed_at: { gte: from, lt: to } },
            _sum: { amount: true },
        }),
        prisma.stockLedger.findMany({
            where: {
                occurred_at: { gte: from, lt: to },
                direction: "OUT",
                reason: { in: ["WASTAGE", "EXPIRED"] },
            },
            select: { item_id: true, quantity: true },
        }),
    ]);
    const avg = await getItemAvgCosts([
        ...new Set([...consumed.map((c) => c.item_id), ...losses.map((l) => l.item_id)]),
    ]);

    const ratios = await chargeRatios(chicks.map((p) => p.purchase_id));

    const lines = new Map<string, CostLine>();
    const add = (kind: CostLine["kind"], code: string, label: string, amount: Prisma.Decimal) => {
        if (amount.isZero()) return;
        const key = `${kind}:${code}`;
        const line = lines.get(key) ?? { kind, code, label, amount: 0 };
        line.amount = n(D(line.amount).plus(amount));
        lines.set(key, line);
    };
    for (const p of chicks)
        add(
            "CHICKS",
            p.item.category,
            labels.item.get(p.item.category) ?? p.item.category,
            landedTotal(p, ratios),
        );
    for (const c of consumed) {
        const cost = avg.get(c.item_id);
        if (!cost || isNonDepleting(c.item.category)) continue;
        add(
            "STOCK",
            c.item.category,
            labels.item.get(c.item.category) ?? c.item.category,
            c.base_quantity.times(cost),
        );
    }
    for (const e of expenses)
        add("EXPENSE", e.category, labels.expense.get(e.category) ?? e.category, D(e._sum.amount));
    add("DEPRECIATION", "DEPRECIATION", "Equipment depreciation", D(depreciation._sum.amount));
    const lost = losses.reduce(
        (sum, l) => sum.plus(l.quantity.times(avg.get(l.item_id) ?? 0)),
        D(0),
    );
    add("STOCK_LOSS", "STOCK_LOSS", "Stock written off", lost);
    return [...lines.values()].sort((a, b) => b.amount - a.amount);
}

/** Money paid to suppliers before `at`, split by what it was *then*: settling a bill or old balance that
 * already existed, or an advance. Using an advance re-points its earlier payment at the later bill, so what
 * the row points at today isn't enough -- the bill's own date decides. */
async function supplierMoneyAt(at: Date) {
    // Stored timestamps have no zone (UTC): compare without one, whatever the session's zone is.
    const before = at.toISOString().replace("Z", "");
    const [row] = await prisma.$queryRaw<{ settled: Prisma.Decimal; advances: Prisma.Decimal }[]>`
        SELECT
            COALESCE(SUM(p.amount) FILTER (
                WHERE b.purchase_date < ${before}::timestamp OR s.opening_date < ${before}::timestamp
            ), 0) AS settled,
            COALESCE(SUM(CASE WHEN p.direction = 'INCOMING' THEN -p.amount ELSE p.amount END) FILTER (
                WHERE p.ref_type = 'SUPPLIER_ADVANCE'
                   OR b.purchase_date >= ${before}::timestamp
                   OR s.opening_date >= ${before}::timestamp
            ), 0) AS advances
        FROM "Payment" p
        LEFT JOIN "Purchase" b ON p.ref_type = 'PURCHASE' AND b.id = p.ref_id
        LEFT JOIN "Suppliers" s ON p.ref_type = 'SUPPLIER_OPENING' AND s.id = p.ref_id
        WHERE p.ref_type IN ('PURCHASE', 'SUPPLIER_OPENING', 'SUPPLIER_ADVANCE')
          AND p.payment_date < ${before}::timestamp`;
    return row!;
}

/** Cash in each fund's accounts at an instant. A transfer counts here: it is what moves money between them. */
async function cashByFund(at: Date) {
    const before = at.toISOString().replace("Z", "");
    const rows = await prisma.$queryRaw<{ fund: string; cash: Prisma.Decimal }[]>`
        SELECT i.fund::text AS fund, SUM(m.amount) AS cash
        FROM (
            SELECT to_instrument_id AS account, amount FROM "Payment"
            WHERE to_instrument_id IS NOT NULL AND payment_date < ${before}::timestamp
            UNION ALL
            SELECT from_instrument_id, -amount FROM "Payment"
            WHERE from_instrument_id IS NOT NULL AND payment_date < ${before}::timestamp
        ) m
        JOIN "PaymentInstrument" i ON i.id = m.account
        GROUP BY i.fund`;
    return (fund: string) => D(rows.find((r) => r.fund === fund)?.cash);
}

/** Balances at an instant: everything dated before `at`. */
export async function balancesAt(at: Date) {
    const before = { lt: at };
    const [
        moneyIn,
        moneyOut,
        sales,
        birdSales,
        purchases,
        expenses,
        salesPaid,
        expensesPaid,
        openings,
        supplierMoney,
        loansTaken,
        loansRepaid,
        cashIn,
    ] = await Promise.all([
        prisma.payment.aggregate({
            where: { direction: "INCOMING", payment_date: before, ref_type: { not: "TRANSFER" } },
            _sum: { amount: true },
        }),
        prisma.payment.aggregate({
            where: { direction: "OUTGOING", payment_date: before, ref_type: { not: "TRANSFER" } },
            _sum: { amount: true },
        }),
        prisma.sale.aggregate({ where: { sale_date: before }, _sum: { due_amount: true } }),
        prisma.birdSale.aggregate({ where: { sale_date: before }, _sum: { due_amount: true } }),
        prisma.purchase.aggregate({
            where: { purchase_date: before },
            _sum: { due_amount: true },
        }),
        // Payroll's own expenses are settled by their payout, never owed as an expense.
        prisma.expense.aggregate({
            where: { date: before, category: { notIn: NEVER_OWED_EXPENSE_CATEGORIES } },
            _sum: { amount: true },
        }),
        prisma.payment.aggregate({
            where: { ref_type: { in: ["SALE", "BIRD_SALE"] }, payment_date: before },
            _sum: { amount: true },
        }),
        prisma.payment.aggregate({
            where: { ref_type: "EXPENSE", payment_date: before },
            _sum: { amount: true },
        }),
        // Owed to suppliers from before FMS.
        prisma.suppliers.aggregate({
            where: { opening_date: before },
            _sum: { opening_due: true },
        }),
        supplierMoneyAt(at),
        // A loan owes its total (principal + interest); installments are its OUTGOING payments.
        prisma.loan.aggregate({ where: { received_on: before }, _sum: { total_payable: true } }),
        prisma.payment.aggregate({
            where: { ref_type: "LOAN", direction: "OUTGOING", payment_date: before },
            _sum: { amount: true },
        }),
        cashByFund(at),
    ]);
    return {
        cash: D(moneyIn._sum.amount).minus(D(moneyOut._sum.amount)),
        // The three make the total; only operating cash is the farm's to spend.
        operating_cash: cashIn("OPERATING"),
        reinvest_cash: cashIn("REINVEST"),
        reserve_cash: cashIn("RESERVE"),
        receivables: D(sales._sum.due_amount)
            .plus(D(birdSales._sum.due_amount))
            .minus(D(salesPaid._sum.amount)),
        payables: D(purchases._sum.due_amount)
            .plus(D(openings._sum.opening_due))
            .plus(D(expenses._sum.amount))
            .minus(D(expensesPaid._sum.amount))
            .minus(D(supplierMoney.settled)),
        // Never netted off payables: money with one supplier doesn't pay another.
        supplier_advances: D(supplierMoney.advances),
        loans_owed: D(loansTaken._sum.total_payable).minus(D(loansRepaid._sum.amount)),
    };
}

async function periodFigures(range: Range) {
    const labels = await categoryLabels();
    const [revenue, costLines, end] = await Promise.all([
        revenueIn(range),
        costsIn(range, labels),
        balancesAt(range.to),
    ]);
    const costs = costLines.reduce((sum, l) => sum.plus(l.amount), D(0));
    const profit = revenue.minus(costs);
    return {
        from: range.from,
        to: range.to,
        revenue: n(revenue),
        costs: n(costs),
        net_profit: n(profit),
        margin: revenue.isZero() ? null : Number(profit.dividedBy(revenue).toFixed(4)),
        cash: n(end.cash),
        operating_cash: n(end.operating_cash),
        reinvest_cash: n(end.reinvest_cash),
        reserve_cash: n(end.reserve_cash),
        receivables: n(end.receivables),
        payables: n(end.payables),
        loans_owed: n(end.loans_owed),
        supplier_advances: n(end.supplier_advances),
        cost_breakdown: costLines,
    };
}

const DAY = 86_400_000;
const monthStart = (y: number, m: number) => new Date(Date.UTC(y, m, 1));
type OwedRow = { id: string; name: string; due: number; oldest: Date; records: number };

export const FinanceService = {
    /** The period and the one it's compared with -- by default the same length immediately before it. */
    async summary(q: {
        from: Date;
        to: Date;
        compare_from?: Date | undefined;
        compare_to?: Date | undefined;
    }) {
        const current: Range = { from: q.from, to: q.to };
        const len = q.to.getTime() - q.from.getTime();
        const previous: Range =
            q.compare_from && q.compare_to
                ? { from: q.compare_from, to: q.compare_to }
                : { from: new Date(q.from.getTime() - len), to: q.from };
        const [cur, prev] = await Promise.all([periodFigures(current), periodFigures(previous)]);
        return { current: cur, previous: prev };
    },

    /** One row per calendar month, oldest first, ending with the current month. */
    async monthly(months: number) {
        const now = new Date();
        const ranges = Array.from({ length: months }, (_, i) => {
            const y = now.getUTCFullYear();
            const m = now.getUTCMonth() - (months - 1 - i);
            return { from: monthStart(y, m), to: monthStart(y, m + 1) };
        });
        const labels = await categoryLabels();
        return Promise.all(
            ranges.map(async (r) => {
                const [revenue, costLines, flows, end] = await Promise.all([
                    revenueIn(r),
                    costsIn(r, labels),
                    prisma.payment.groupBy({
                        by: ["direction"],
                        // A transfer between the farm's own accounts is neither money in nor out.
                        where: {
                            payment_date: { gte: r.from, lt: r.to },
                            ref_type: { not: "TRANSFER" },
                        },
                        _sum: { amount: true },
                    }),
                    balancesAt(r.to),
                ]);
                const costs = costLines.reduce((sum, l) => sum.plus(l.amount), D(0));
                const flow = (d: "INCOMING" | "OUTGOING") =>
                    n(D(flows.find((f) => f.direction === d)?._sum.amount));
                return {
                    month: r.from.toISOString().slice(0, 7),
                    revenue: n(revenue),
                    costs: n(costs),
                    profit: n(revenue.minus(costs)),
                    cash_in: flow("INCOMING"),
                    cash_out: flow("OUTGOING"),
                    cash_end: n(end.cash),
                };
            }),
        );
    },

    /** What is owed right now, both ways, grouped by who and by age (days since the bill's date). */
    async owed(top: number) {
        const now = Date.now();
        const [sales, birdSales, purchases, expenses, paid, customers, suppliers, expenseLabels] =
            await Promise.all([
                prisma.sale.findMany({
                    select: { id: true, customer_id: true, sale_date: true, due_amount: true },
                }),
                prisma.birdSale.findMany({
                    select: { id: true, customer_id: true, sale_date: true, due_amount: true },
                }),
                prisma.purchase.findMany({
                    select: { id: true, supplier_id: true, purchase_date: true, due_amount: true },
                }),
                prisma.expense.findMany({
                    where: { category: { notIn: NEVER_OWED_EXPENSE_CATEGORIES } },
                    select: { id: true, category: true, date: true, amount: true },
                }),
                // By kind as well as id: an old balance and an advance both carry the supplier's id.
                prisma.payment.groupBy({ by: ["ref_type", "ref_id"], _sum: { amount: true } }),
                prisma.customers.findMany({
                    select: { id: true, profile: { select: { name: true } } },
                }),
                prisma.suppliers.findMany({
                    select: {
                        id: true,
                        opening_due: true,
                        opening_date: true,
                        profile: { select: { name: true } },
                    },
                }),
                prisma.expenseCategoryLookup.findMany({ select: { code: true, label: true } }),
            ]);
        const paidBy = new Map(paid.map((p) => [`${p.ref_type}:${p.ref_id}`, D(p._sum.amount)]));
        const customerName = new Map(customers.map((c) => [c.id, c.profile.name]));
        const supplierName = new Map(suppliers.map((s) => [s.id, s.profile.name]));
        const expenseName = new Map(expenseLabels.map((e) => [e.code, e.label]));

        const tally = (
            records: { key: string; name: string; date: Date; due: Prisma.Decimal }[],
        ) => {
            const buckets = { d0_30: D(0), d31_60: D(0), d60_plus: D(0) };
            const byWho = new Map<string, OwedRow>();
            for (const r of records) {
                if (!r.due.greaterThan(0)) continue;
                const age = (now - r.date.getTime()) / DAY;
                const bucket = age <= 30 ? "d0_30" : age <= 60 ? "d31_60" : "d60_plus";
                buckets[bucket] = buckets[bucket].plus(r.due);
                const row = byWho.get(r.key) ?? {
                    id: r.key,
                    name: r.name,
                    due: 0,
                    oldest: r.date,
                    records: 0,
                };
                row.due = n(D(row.due).plus(r.due));
                row.records += 1;
                if (r.date < row.oldest) row.oldest = r.date;
                byWho.set(r.key, row);
            }
            const rows = [...byWho.values()].sort((a, b) => b.due - a.due);
            return {
                total: n(buckets.d0_30.plus(buckets.d31_60).plus(buckets.d60_plus)),
                buckets: {
                    d0_30: n(buckets.d0_30),
                    d31_60: n(buckets.d31_60),
                    d60_plus: n(buckets.d60_plus),
                },
                count: rows.length,
                top: rows.slice(0, top),
            };
        };

        const left = (ref_type: string, id: string, due: Prisma.Decimal) =>
            due.minus(paidBy.get(`${ref_type}:${id}`) ?? 0);
        return {
            receivables: tally(
                [
                    ...sales.map((s) => ({ ...s, ref: "SALE", date: s.sale_date })),
                    ...birdSales.map((s) => ({ ...s, ref: "BIRD_SALE", date: s.sale_date })),
                ].map((s) => ({
                    key: s.customer_id ?? "walk-in",
                    name: s.customer_id
                        ? (customerName.get(s.customer_id) ?? "Unknown customer")
                        : "Walk-in buyers",
                    date: s.date,
                    due: left(s.ref, s.id, s.due_amount),
                })),
            ),
            payables: tally([
                ...purchases.map((p) => ({
                    key: p.supplier_id ?? "no-supplier",
                    name: p.supplier_id
                        ? (supplierName.get(p.supplier_id) ?? "Unknown supplier")
                        : "No supplier named",
                    date: p.purchase_date,
                    due: left("PURCHASE", p.id, p.due_amount),
                })),
                ...suppliers
                    .filter((s) => s.opening_due.greaterThan(0))
                    .map((s) => ({
                        key: s.id,
                        name: s.profile.name,
                        date: s.opening_date!,
                        due: left("SUPPLIER_OPENING", s.id, s.opening_due),
                    })),
                ...expenses.map((e) => ({
                    key: `expense:${e.category}`,
                    name: `${expenseName.get(e.category) ?? e.category} (expense)`,
                    date: e.date,
                    due: left("EXPENSE", e.id, e.amount),
                })),
            ]),
        };
    },
};
