import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { canAccess } from "@lib/permissions";
import { sendError } from "@lib/response";
import { purgeAuditLog } from "@lib/test-fixtures";
import { loanRoutes } from "./loan.routes";
import { paymentRoutes } from "./payment.routes";

// The routes in-process behind a fixture identity -- what authenticate would have set.
let profileId: string;
let account: string;
const app = new Hono();
app.use("*", async (c, next) => {
    c.set(
        "auth" as never,
        { profile_id: profileId, role: "ADMIN", employee_role: null, employee_id: null } as never,
    );
    await next();
});
// Same rule as App.ts: an AppError is its own status, anything else a 500.
app.onError((e, c) =>
    e instanceof AppError ? sendError(c, e) : c.json({ message: e.message }, 500),
);
app.route("/loans", loanRoutes);
app.route("/payments", paymentRoutes);

const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, {
        method,
        ...(body !== undefined && {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
        }),
    });
    return {
        status: res.status,
        body: (await res.json()) as { data: Record<string, never> & { id: string } },
    };
};

beforeAll(async () => {
    profileId = (
        await prisma.profiles.create({
            data: {
                name: "Loan Routes",
                mobile: `+880${Math.floor(1e9 + Math.random() * 8e9)}`,
                role: "ADMIN",
            },
        })
    ).id;
    account = (
        await prisma.paymentInstrument.create({ data: { type: "CASH", label: "Loan routes" } })
    ).id;
});
afterAll(async () => {
    await prisma.expense.deleteMany({ where: { recorded_by_id: profileId } });
    await prisma.payment.deleteMany({
        where: { OR: [{ from_instrument_id: account }, { to_instrument_id: account }] },
    });
    await prisma.loan.deleteMany({ where: { recorded_by_id: profileId } });
    await prisma.paymentInstrument.delete({ where: { id: account } });
    await purgeAuditLog({ where: { changed_by_id: profileId } });
    await prisma.profiles.delete({ where: { id: profileId } });
});

const body = (over = {}) => ({
    lender: "Route Bank",
    purpose: "FARM",
    principal: 10000,
    terms: "FLAT",
    total_payable: 12000,
    installment_count: 4,
    frequency: "MONTHLY",
    received_on: "2003-01-01",
    first_due_on: "2003-02-01",
    to_instrument_id: account,
    ...over,
});

describe("/loans", () => {
    test("record, list, read, pay, refuse removal", async () => {
        const made = await call("POST", "/loans", body());
        expect(made.status).toBe(201);
        const id = made.body.data.id;
        const row = await prisma.loan.findUniqueOrThrow({ where: { id } });
        expect(row.recorded_by_id).toBe(profileId);

        const list = await call("GET", "/loans");
        expect((list.body.data as unknown as { id: string }[]).some((l) => l.id === id)).toBe(true);
        const paid = await call("POST", `/loans/${id}/installments`, {
            amount: 3000,
            payment_date: "2003-02-01",
            from_instrument_id: account,
        });
        expect(paid.status).toBe(201);
        expect((paid.body.data as unknown as { interest: string }).interest).toBe("500.00");
        const one = await call("GET", `/loans/${id}`);
        expect((one.body.data as unknown as { left: string }).left).toBe("9000.00");
        expect((await call("DELETE", `/loans/${id}`)).status).toBe(409);
    });
    test("a caller can't choose who recorded it", async () => {
        const made = await call("POST", "/loans", body({ recorded_by_id: crypto.randomUUID() }));
        const row = await prisma.loan.findUniqueOrThrow({ where: { id: made.body.data.id } });
        expect(row.recorded_by_id).toBe(profileId);
        expect((await call("DELETE", `/loans/${made.body.data.id}`)).status).toBe(200);
    });
    test("bad input is a 4xx, never a 500", async () => {
        const bodies = [
            {},
            body({ principal: "abc" }),
            body({ principal: 1e12 }),
            body({ installment_count: 1e9 }),
            body({ received_on: "nope" }),
            body({ principal: 1, total_payable: 1, installment_count: 600 }),
        ];
        for (const b of bodies) {
            const s = (await call("POST", "/loans", b)).status;
            expect(s).toBeGreaterThanOrEqual(400);
            expect(s).toBeLessThan(500);
        }
        expect((await call("GET", "/loans/unknown")).status).toBe(404);
        expect((await call("DELETE", "/loans/unknown")).status).toBe(404);
        expect(
            (
                await call("POST", "/loans/unknown/installments", {
                    amount: 1,
                    payment_date: "2003-02-01",
                    from_instrument_id: account,
                })
            ).status,
        ).toBe(404);
    });
});

describe("/payments", () => {
    test("owner capital goes in without a bill; a loan installment can't be authored here", async () => {
        const ok = await call("POST", "/payments", {
            ref_type: "OWNER_CAPITAL",
            amount: 50,
            payment_date: "2003-01-05",
            to_instrument_id: account,
        });
        expect(ok.status).toBe(201);
        const bad = await call("POST", "/payments", {
            ref_type: "LOAN",
            ref_id: crypto.randomUUID(),
            amount: 50,
            payment_date: "2003-01-05",
            from_instrument_id: account,
        });
        expect(bad.status).toBeGreaterThanOrEqual(400);
        expect(bad.status).toBeLessThan(500);
    });
    test("asking what's outstanding on a no-bill kind doesn't crash", async () => {
        expect((await call("GET", "/payments/outstanding?ref_type=TRANSFER")).status).toBeLessThan(
            500,
        );
        expect(
            (
                await call(
                    "GET",
                    `/payments/total-paid?ref_type=OWNER_DRAW&ref_id=${crypto.randomUUID()}`,
                )
            ).status,
        ).toBeLessThan(500);
    });
});

describe("who may touch loans", () => {
    const who = (role: "ADMIN" | "EMPLOYEE", employee_role: string | null) => ({
        profile_id: "p",
        role,
        employee_role,
        employee_id: "e",
    });
    test("admins only: workers and managers are denied every loan route", () => {
        for (const [m, p] of [
            ["GET", "/loans"],
            ["GET", "/loans/x"],
            ["POST", "/loans"],
            ["POST", "/loans/x/installments"],
            ["DELETE", "/loans/x"],
        ] as const) {
            expect(canAccess(who("ADMIN", null), m, p, () => undefined)).toBe(true);
            expect(canAccess(who("EMPLOYEE", "MANAGER"), m, p, () => undefined)).toBe(false);
            expect(canAccess(who("EMPLOYEE", "WORKER"), m, p, () => undefined)).toBe(false);
        }
    });
});
