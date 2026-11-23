import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { Hono } from "hono";
import { AppError } from "@lib/app-error";
import { canAccess } from "@lib/permissions";
import { sendError } from "@lib/response";
import {
    cleanSuppliers,
    makeAccount,
    makeProfile,
    makeSupplier,
} from "@lib/supplier-test-fixtures";
import { paymentRoutes } from "./payment.routes";
import { supplierRoutes } from "./supplier.routes";

// The routes in-process behind a fixture identity -- what authenticate would have set.
let profileId: string;
let account: string;
let id: string;
const app = new Hono();
app.use("*", async (c, next) => {
    c.set(
        "auth" as never,
        { profile_id: profileId, role: "ADMIN", employee_role: null, employee_id: null } as never,
    );
    await next();
});
app.onError((e, c) =>
    e instanceof AppError ? sendError(c, e) : c.json({ message: e.message }, 500),
);
app.route("/suppliers", supplierRoutes);
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
        body: (await res.json().catch(() => ({ data: {} }))) as {
            data: { id: string; advance: string; recorded_by_id: string };
        },
    };
};
beforeAll(async () => {
    profileId = await makeProfile("Supplier Routes");
    account = await makeAccount("Supplier routes");
    id = await makeSupplier();
});
afterAll(() => cleanSuppliers({ suppliers: [id], accounts: [account], profiles: [profileId] }));

describe("/suppliers money", () => {
    test("old balance, pay, refund, dues, remove; the caller is the recorder", async () => {
        expect(
            (
                await call("PATCH", `/suppliers/${id}/opening`, {
                    opening_due: 100,
                    opening_date: "2003-01-01",
                })
            ).status,
        ).toBe(200);
        const paid = await call("POST", `/suppliers/${id}/payments`, {
            amount: 300,
            payment_date: "2003-01-05",
            from_instrument_id: account,
            recorded_by_id: crypto.randomUUID(),
        });
        expect(paid.status).toBe(201);
        expect(paid.body.data.recorded_by_id).toBe(profileId);
        expect(
            (
                await call("POST", `/suppliers/${id}/refunds`, {
                    amount: 50,
                    payment_date: "2003-01-06",
                    to_instrument_id: account,
                })
            ).status,
        ).toBe(201);
        expect((await call("GET", `/suppliers/${id}/dues`)).body.data.advance).toBe("150.00");
        expect(
            (
                await call("POST", `/suppliers/${id}/payments/${paid.body.data.id}/remove`, {
                    reason: "wrong",
                })
            ).status,
        ).toBe(409);
        expect(
            (await call("POST", `/suppliers/${id}/payments/${paid.body.data.id}/remove`, {}))
                .status,
        ).toBe(400);
    });
    test("bad input is a 4xx, never a 500", async () => {
        for (const [m, p, b] of [
            ["POST", `/suppliers/${id}/payments`, {}],
            [
                "POST",
                `/suppliers/${id}/payments`,
                { amount: 1e12, payment_date: "2003-01-05", from_instrument_id: account },
            ],
            [
                "POST",
                `/suppliers/${id}/payments`,
                { amount: 5, payment_date: "nope", from_instrument_id: account },
            ],
            ["POST", `/suppliers/${id}/refunds`, { amount: -1 }],
            [
                "PATCH",
                `/suppliers/${id}/opening`,
                { opening_due: 1e12, opening_date: "2003-01-01" },
            ],
            ["GET", "/suppliers/unknown/dues", undefined],
            [
                "POST",
                "/suppliers/unknown/payments",
                { amount: 5, payment_date: "2003-01-05", from_instrument_id: account },
            ],
        ] as const) {
            const s = (await call(m, p, b)).status;
            expect([m, p, s >= 400 && s < 500]).toEqual([m, p, true]);
        }
    });
    test("parts of a supplier payment can't be authored as plain payments", async () => {
        for (const ref_type of ["SUPPLIER_ADVANCE", "SUPPLIER_OPENING"])
            expect(
                (
                    await call("POST", "/payments", {
                        ref_type,
                        ref_id: id,
                        amount: 5,
                        payment_date: "2003-01-05",
                        from_instrument_id: account,
                    })
                ).status,
            ).toBe(400);
        expect(
            (await call("GET", "/payments/outstanding?ref_type=SUPPLIER_ADVANCE")).status,
        ).toBeLessThan(500);
    });
    test("admins only", () => {
        const who = (employee_role: string) => ({
            profile_id: "p",
            role: "EMPLOYEE" as const,
            employee_role,
            employee_id: "e",
        });
        for (const [m, p] of [
            ["GET", "dues"],
            ["GET", "statement"],
            ["POST", "payments"],
            ["POST", "refunds"],
            ["PATCH", "opening"],
            ["POST", "payments/x/remove"],
        ] as const)
            for (const r of ["WORKER", "MANAGER"])
                expect(canAccess(who(r), m, `/suppliers/x/${p}`, () => undefined)).toBe(false);
    });
});
