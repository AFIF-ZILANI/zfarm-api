import { describe, test, expect } from "bun:test";
import prisma from "@lib/db";
import { account, closedBatch, rolledBack, splitProfile } from "@lib/profit-split-fixtures";
import { updateFarmSettingsSchema } from "@validators/farm-settings.validator";
import { PaymentInstrumentService } from "./payment-instrument.service";
import { createPaymentSchema } from "@validators/payment.validator";

/** Refused by the named check, not by any error that happens to come first. One per transaction: a failed
 * statement ends it. */
const refusedBy = async (check: string, fn: Parameters<typeof rolledBack>[0]) => {
    let seen = "ok";
    await rolledBack(async (tx) => {
        try {
            await fn(tx);
        } catch (e) {
            seen = JSON.stringify(e) + String((e as Error).message);
        }
    }).catch(() => undefined);
    expect(seen).toContain(check);
};
const base = (batch_id: string, approved_by_id: string, over: Record<string, unknown> = {}) => ({
    batch_id,
    approved_by_id,
    kind: "PROFIT" as const,
    net_profit: 100,
    pct_reinvest: 50,
    pct_reserve: 30,
    pct_owner: 20,
    pct_tax: 10,
    reinvest: 50,
    reserve: 30,
    owner: 20,
    tax: 10,
    ...over,
});

describe("database checks", () => {
    const split = (check: string, over: Record<string, unknown>) =>
        refusedBy(check, async (tx) => {
            await tx.profitSplit.create({
                data: base(await closedBatch(tx, 1), await splitProfile(tx), over),
            });
        });
    test("a good decision is accepted", async () => {
        await rolledBack(async (tx) => {
            const p = await splitProfile(tx);
            const b = await closedBatch(tx, 1);
            expect((await tx.profitSplit.create({ data: base(b, p) })).kind).toBe("PROFIT");
            expect(await tx.profitSplit.count()).toBe(1);
        });
    });
    test("parts that don't add up to the profit", () =>
        split("ProfitSplit_parts_add_up", { owner: 21 }));
    test("percentages that aren't 100", () => split("ProfitSplit_parts_add_up", { pct_owner: 21 }));
    test("tax above the reserve", () => split("ProfitSplit_parts_add_up", { tax: 31 }));
    test("more principal than the reinvestment share", () =>
        split("ProfitSplit_parts_add_up", { principal_taken: 51 }));
    test("a loss that is a profit", () =>
        split("ProfitSplit_loss_sane", {
            kind: "LOSS",
            reinvest: 0,
            reserve: 0,
            owner: 0,
            tax: 0,
        }));
    test("a loss covered more than it is", () =>
        split("ProfitSplit_loss_sane", {
            kind: "LOSS",
            net_profit: -10,
            loss_covered: 11,
            reinvest: 0,
            reserve: 0,
            owner: 0,
            tax: 0,
        }));
    test("a skip without a reason", () =>
        split("ProfitSplit_skip_has_reason", {
            kind: "SKIPPED",
            reinvest: 0,
            reserve: 0,
            owner: 0,
            tax: 0,
        }));
    test("a split move that isn't a transfer", () =>
        refusedBy("Payment_split_move_is_transfer", async (tx) => {
            await tx.payment.create({
                data: {
                    amount: 1,
                    payment_date: new Date(),
                    direction: "OUTGOING",
                    ref_type: "OWNER_DRAW",
                    ref_id: "x",
                    from_instrument_id: await account(tx),
                    split_move: "TO_RESERVE",
                },
            });
        }));
    test("settings that don't add up", () =>
        refusedBy("FarmSettings_split_sums", async (tx) => {
            await tx.farmSettings.upsert({
                where: { id: 1 },
                create: { id: 1, split_owner: 21 },
                update: { split_owner: 21 },
            });
        }));
    test("two active reserve accounts", () =>
        refusedBy("PaymentInstrument_one_active_fund", async (tx) => {
            await account(tx, "RESERVE");
            await account(tx, "RESERVE");
        }));
    test("an inactive second one is fine, and so are many operating ones", async () => {
        await rolledBack(async (tx) => {
            await account(tx, "RESERVE");
            await account(tx, "RESERVE", { is_active: false });
            await account(tx);
            await account(tx);
            expect(await tx.paymentInstrument.count({ where: { fund: "RESERVE" } })).toBe(2);
        });
    });
});

describe("validation", () => {
    const ok = (b: Record<string, unknown>) => updateFarmSettingsSchema.safeParse(b).success;
    test("the four percentages come together and add up", () => {
        const p = { split_reinvest: 50, split_reserve: 30, split_owner: 20, split_tax: 10 };
        expect(ok(p)).toBe(true);
        expect(ok({ ...p, split_owner: 21 })).toBe(false);
        expect(ok({ ...p, split_tax: 31 })).toBe(false);
        expect(ok({ split_owner: 20 })).toBe(false);
        expect(ok({ ...p, split_reinvest: -1, split_owner: 71 })).toBe(false);
        expect(
            ok({ split_reinvest: 33.33, split_reserve: 33.33, split_owner: 33.34, split_tax: 0 }),
        ).toBe(true);
        expect(ok({ settlement_days: 7 })).toBe(true);
    });
    test("tax paid is money out with no bill, and a client can't mark a split move", () => {
        const body = {
            ref_type: "TAX_PAID",
            amount: 5,
            payment_date: new Date(),
            from_instrument_id: crypto.randomUUID(),
        };
        const r = createPaymentSchema.safeParse({ ...body, split_move: "TO_RESERVE" });
        expect(r.success).toBe(true);
        expect(JSON.stringify(r.data)).not.toContain("split_move");
        expect(
            createPaymentSchema.safeParse({ ...body, to_instrument_id: crypto.randomUUID() })
                .success,
        ).toBe(false);
    });
});

describe("an account's fund", () => {
    const status = (p: Promise<unknown>) =>
        p.then(
            () => "ok",
            (e: { status?: number; message: string }) => e.status ?? e.message,
        );
    test("can be set until money moves through it; a second active one for a fund is refused", async () => {
        const made: string[] = [];
        const had = await prisma.paymentInstrument.findFirst({
            where: { fund: "RESERVE", is_active: true },
        });
        if (had) return; // the farm's own reserve account is recorded here: nothing to set up beside it
        try {
            const a = (await PaymentInstrumentService.create({
                type: "CASH",
                label: "Split fund test",
            }))!.id;
            made.push(a);
            expect((await PaymentInstrumentService.update(a, { fund: "RESERVE" }))?.fund).toBe(
                "RESERVE",
            );
            expect(
                await status(
                    PaymentInstrumentService.create({
                        type: "CASH",
                        label: "Split fund 2",
                        fund: "RESERVE",
                    }),
                ),
            ).toBe(409);
            const b = (await PaymentInstrumentService.create({
                type: "CASH",
                label: "Split fund 3",
            }))!.id;
            made.push(b);
            expect(await status(PaymentInstrumentService.update(b, { fund: "RESERVE" }))).toBe(409);
            await prisma.payment.create({
                data: {
                    amount: 1,
                    payment_date: new Date(),
                    direction: "OUTGOING",
                    ref_type: "TRANSFER",
                    ref_id: a,
                    from_instrument_id: a,
                    to_instrument_id: b,
                },
            });
            expect(await status(PaymentInstrumentService.update(a, { fund: "OPERATING" }))).toBe(
                409,
            );
            expect(
                await status(
                    PaymentInstrumentService.update(a, { fund: "RESERVE", label: "Renamed" }),
                ),
            ).toBe("ok");
            await PaymentInstrumentService.setActive(a, false);
            const c = (await PaymentInstrumentService.create({
                type: "CASH",
                label: "Split fund 4",
                fund: "RESERVE",
            }))!.id;
            made.push(c);
            expect(await status(PaymentInstrumentService.setActive(a, true))).toBe(409);
        } finally {
            await prisma.payment.deleteMany({ where: { from_instrument_id: { in: made } } });
            await prisma.paymentInstrument.deleteMany({ where: { id: { in: made } } });
            await prisma.paymentInstrument.deleteMany({
                where: { label: { startsWith: "Split fund" } },
            });
        }
    });
});
