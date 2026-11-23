import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { Hono } from "hono";
import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { canAccess } from "@lib/permissions";
import { sendError } from "@lib/response";
import { purgeAuditLog } from "@lib/test-fixtures";
import { BatchPnlService } from "@services/batch-pnl.service";
import { FinanceService } from "@services/finance.service";
import { ProfitSplitService } from "@services/profit-split.service";
import { profitSplitRoutes } from "./profit-split.routes";

// Commits for real, so every figure is compared before and after, and everything made is taken out again.
let by: string;
let op: string;
let reinvest: string;
let madeReinvest = false;
const batches: string[] = [];
const app = new Hono();
app.use("*", async (c, next) => {
    c.set(
        "auth" as never,
        { profile_id: by, role: "ADMIN", employee_role: null, employee_id: null } as never,
    );
    await next();
});
app.onError((e, c) =>
    e instanceof AppError ? sendError(c, e) : c.json({ detail: e.message }, 500),
);
app.route("/profit-splits", profitSplitRoutes);
const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/profit-splits${path}`, {
        method,
        ...(body !== undefined && {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
        }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
};
/** A closed 2007 batch whose only figures are one sale and one direct cost. */
const batch = async (d: number, revenue: number, cost: number) => {
    const b = await prisma.batches.create({
        data: {
            batch_code: `SPLITR-${crypto.randomUUID()}`,
            breed: "CLASSIC",
            status: "CLOSED",
            starting_date: new Date(Date.UTC(2007, 0, 1)),
            expected_selling_date: new Date(Date.UTC(2007, 4, d)),
            actual_end_date: new Date(Date.UTC(2007, 4, d)),
            initial_chick_count: 10,
        },
    });
    batches.push(b.id);
    await prisma.sale.create({
        data: {
            batch_id: b.id,
            sale_date: new Date(Date.UTC(2007, 4, d)),
            total: revenue,
            paid_amount: 0,
            due_amount: revenue,
            recorded_by_id: by,
        } as never,
    });
    if (cost) await bill(b.id, cost, d);
    return b.id;
};
const bill = (batch_id: string, amount: number, d: number) =>
    prisma.expense.create({
        data: {
            batch_id,
            category: "MISC",
            cost_type: "DIRECT",
            amount,
            date: new Date(Date.UTC(2007, 4, d)),
            recorded_by_id: by,
        },
    });
const decide = (batch_id: string, expected_profit: number, over = {}) =>
    call("POST", "", { batch_id, expected_profit, ...over });

beforeAll(async () => {
    by = (
        await prisma.profiles.create({
            data: {
                name: "Split Routes",
                mobile: `+880${Math.floor(1e9 + Math.random() * 8e9)}`,
                role: "ADMIN",
            },
        })
    ).id;
    op = (
        await prisma.paymentInstrument.create({ data: { type: "CASH", label: "Split routes op" } })
    ).id;
    const had = await prisma.paymentInstrument.findFirst({
        where: { fund: "REINVEST", is_active: true },
    });
    madeReinvest = !had;
    reinvest =
        had?.id ??
        (
            await prisma.paymentInstrument.create({
                data: { type: "CASH", label: "Split routes re", fund: "REINVEST" },
            })
        ).id;
});
afterEach(async () => {
    await prisma.payment.deleteMany({
        where: { OR: [{ from_instrument_id: op }, { to_instrument_id: op }] },
    });
    await prisma.profitSplit.deleteMany({ where: { batch_id: { in: batches } } });
    await prisma.expense.deleteMany({ where: { batch_id: { in: batches } } });
    await prisma.sale.deleteMany({ where: { batch_id: { in: batches } } });
    await prisma.batches.deleteMany({ where: { id: { in: batches } } });
    batches.length = 0;
});
afterAll(async () => {
    await prisma.paymentInstrument.deleteMany({
        where: { id: { in: madeReinvest ? [op, reinvest] : [op] } },
    });
    await purgeAuditLog({ where: { changed_by_id: by } });
    await prisma.profiles.delete({ where: { id: by } });
});

describe("/profit-splits", () => {
    test("see it waiting, split it, move some, see where it stands, take it back", async () => {
        const id = await batch(1, 1000, 400);
        const before = await ProfitSplitService.overview();
        const row = before.waiting.find((w) => w.batch_id === id)!;
        expect([row.net_profit, row.can_decide]).toEqual(["600.00", true]);
        const made = await decide(id, 600);
        expect(made.status).toBe(201);
        expect(made.body.data.approved_by_id).toBe(by);
        const reserveShare = Number(made.body.data.reserve);
        expect(Number(made.body.data.reinvest) + reserveShare + Number(made.body.data.owner)).toBe(
            600 - Number(made.body.data.recovered),
        );
        const after = await ProfitSplitService.overview();
        expect(after.waiting.some((w) => w.batch_id === id)).toBe(false);
        expect(after.done[0]).toMatchObject({
            batch_id: id,
            approved_by: "Split Routes",
            profit_now: "600.00",
            can_undo: true,
        });
        const left = Number(after.reinvest.to_move);
        if (left > 1) {
            const m = await call("POST", "/moves", {
                move: "TO_REINVEST",
                amount: 1,
                payment_date: "2007-06-01",
                operating_instrument_id: op,
            });
            expect(m.status).toBe(201);
            expect(Number((await ProfitSplitService.overview()).reinvest.to_move)).toBeCloseTo(
                left - 1,
                2,
            );
            expect(
                (await call("POST", `/moves/${m.body.data.id}/remove`, { reason: "test" })).status,
            ).toBe(200);
        }
        expect((await call("POST", `/${made.body.data.id}/undo`, { reason: "test" })).status).toBe(
            200,
        );
        const end = await ProfitSplitService.overview();
        for (const k of ["reinvest", "reserve", "owner"] as const)
            expect(end[k]).toEqual(before[k]);
        expect([end.carried_loss, end.principal_waiting]).toEqual([
            before.carried_loss,
            before.principal_waiting,
        ]);
    });
    test("a profit that changed since the screen was opened is refused, with the new figure", async () => {
        const id = await batch(1, 1000, 400);
        await bill(id, 50, 1);
        const r = await decide(id, 600);
        expect([r.status, JSON.stringify(r.body).includes("550.00")]).toEqual([409, true]);
    });
    test("a late bill leaves the frozen profit alone and shows the new one", async () => {
        const id = await batch(1, 1000, 400);
        await decide(id, 600);
        await bill(id, 75, 1);
        const row = (await ProfitSplitService.overview()).done.find((d) => d.batch_id === id)!;
        expect([Number(row.net_profit), row.profit_now]).toEqual([600, "525.00"]);
    });
    test("percentages for one batch", async () => {
        const id = await batch(1, 1000, 0);
        const r = await decide(id, 1000, { pct: { reinvest: 40, reserve: 40, owner: 20, tax: 5 } });
        expect([r.status, Number(r.body.data.pct_reserve)]).toEqual([201, 40]);
    });
    test("splitting, moving, drawing and paying tax never change profit", async () => {
        const id = await batch(1, 1000, 400);
        const range = { from: new Date(Date.UTC(2007, 0, 1)), to: new Date(Date.UTC(2008, 0, 1)) };
        const read = async () => [
            (await FinanceService.summary(range)).current.net_profit,
            (await BatchPnlService.statement(id)).net_profit,
        ];
        const before = await read();
        await decide(id, 600);
        await prisma.payment.create({
            data: {
                amount: 1,
                payment_date: new Date(Date.UTC(2007, 5, 1)),
                direction: "OUTGOING",
                ref_type: "TAX_PAID",
                ref_id: "x",
                from_instrument_id: op,
            },
        });
        await prisma.payment.create({
            data: {
                amount: 1,
                payment_date: new Date(Date.UTC(2007, 5, 1)),
                direction: "OUTGOING",
                ref_type: "OWNER_DRAW",
                ref_id: "x",
                from_instrument_id: op,
            },
        });
        await call("POST", "/moves", {
            move: "TO_REINVEST",
            amount: 1,
            payment_date: "2007-06-01",
            operating_instrument_id: op,
        });
        expect(await read()).toEqual(before);
    });
    test("two people at once: one decision, and never more moved than was left", async () => {
        const id = await batch(1, 1000, 0);
        const r = await Promise.all([decide(id, 1000), decide(id, 1000)]);
        expect(r.map((x) => x.status).sort()).toEqual([201, 409]);
        const left = Number((await ProfitSplitService.overview()).reinvest.to_move);
        if (left <= 0) return;
        const m = await Promise.all(
            [1, 2, 3].map(() =>
                call("POST", "/moves", {
                    move: "TO_REINVEST",
                    amount: left,
                    payment_date: "2007-06-01",
                    operating_instrument_id: op,
                }),
            ),
        );
        expect(m.map((x) => x.status).sort()).toEqual([201, 400, 400]);
    });
    test("bad input is a 4xx, never a 500", async () => {
        const id = await batch(1, 1000, 0);
        for (const [m, p, b] of [
            ["POST", "", {}],
            ["POST", "", { batch_id: "x", expected_profit: 1 }],
            ["POST", "", { batch_id: crypto.randomUUID(), expected_profit: 1 }],
            [
                "POST",
                "",
                {
                    batch_id: id,
                    expected_profit: 1000,
                    pct: { reinvest: 50, reserve: 30, owner: 21, tax: 1 },
                },
            ],
            [
                "POST",
                "",
                {
                    batch_id: id,
                    expected_profit: 1000,
                    pct: { reinvest: 50, reserve: 30, owner: 20, tax: 31 },
                },
            ],
            ["POST", "/skip", { batch_id: id }],
            ["POST", "/skip", { batch_id: id, reason: "  a " }],
            [
                "POST",
                "/moves",
                {
                    move: "SIDEWAYS",
                    amount: 1,
                    payment_date: "2007-06-01",
                    operating_instrument_id: op,
                },
            ],
            [
                "POST",
                "/moves",
                {
                    move: "TO_REINVEST",
                    amount: 0.001,
                    payment_date: "2007-06-01",
                    operating_instrument_id: op,
                },
            ],
            [
                "POST",
                "/moves",
                {
                    move: "TO_REINVEST",
                    amount: 99_999_999,
                    payment_date: "2007-06-01",
                    operating_instrument_id: op,
                },
            ],
            ["POST", "/nope/undo", { reason: "test" }],
            ["POST", "/nope/undo", {}],
            ["POST", "/moves/nope/remove", { reason: "test" }],
        ] as const) {
            const s = (await call(m, p, b)).status;
            expect([p, JSON.stringify(b), s >= 400 && s < 500]).toEqual([
                p,
                JSON.stringify(b),
                true,
            ]);
        }
    });
    test("admins only", () => {
        const who = (employee_role: string) => ({
            profile_id: "p",
            role: "EMPLOYEE" as const,
            employee_role,
            employee_id: "e",
        });
        for (const [m, p] of [
            ["GET", ""],
            ["POST", ""],
            ["POST", "/skip"],
            ["POST", "/moves"],
            ["POST", "/x/undo"],
        ] as const)
            for (const r of ["WORKER", "MANAGER"])
                expect(canAccess(who(r), m, `/profit-splits${p}`, () => undefined)).toBe(false);
    });
});
