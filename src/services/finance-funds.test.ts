import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import prisma from "@lib/db";
import { AnalyticsService } from "./analytics.service";
import { FinanceService } from "./finance.service";

// 2008: a year no other fixture uses. Compared as differences.
const at = (d: number, m = 0) => new Date(Date.UTC(2008, m, d));
let op: string, rs: string, re: string;
const made: string[] = [];
const read = async (to: Date) => {
    const c = (await FinanceService.summary({ from: at(1), to })).current;
    return [c.cash, c.operating_cash, c.reinvest_cash, c.reserve_cash];
};
const diff = (a: number[], b: number[]) => a.map((x, i) => Number((x - b[i]!).toFixed(2)));
const pay = (data: Record<string, unknown>) =>
    prisma.payment.create({
        data: { ref_id: crypto.randomUUID(), direction: "OUTGOING", ...data } as never,
    });

beforeAll(async () => {
    // Inactive, so they never clash with the farm's own fund accounts; a fund's cash counts either way.
    const acc = async (fund: "OPERATING" | "REINVEST" | "RESERVE") => {
        const id = (
            await prisma.paymentInstrument.create({
                data: {
                    type: "CASH",
                    label: `Funds ${fund}`,
                    fund,
                    is_active: fund === "OPERATING",
                },
            })
        ).id;
        made.push(id);
        return id;
    };
    [op, re, rs] = [await acc("OPERATING"), await acc("REINVEST"), await acc("RESERVE")];
});
afterAll(async () => {
    await prisma.payment.deleteMany({
        where: { OR: [{ from_instrument_id: { in: made } }, { to_instrument_id: { in: made } }] },
    });
    await prisma.paymentInstrument.deleteMany({ where: { id: { in: made } } });
});

describe("cash by fund", () => {
    test("a transfer to a fund leaves the total alone and takes it out of operating cash, from its date", async () => {
        const [early, late] = [await read(at(1, 2)), await read(at(1, 4))];
        await pay({
            ref_type: "TRANSFER",
            amount: 500,
            payment_date: at(10, 2),
            from_instrument_id: op,
            to_instrument_id: rs,
        });
        await pay({
            ref_type: "TRANSFER",
            amount: 200,
            payment_date: at(11, 2),
            from_instrument_id: op,
            to_instrument_id: re,
        });
        expect(diff(await read(at(1, 2)), early)).toEqual([0, 0, 0, 0]);
        expect(diff(await read(at(1, 4)), late)).toEqual([0, -700, 200, 500]);
    });
    test("money in and out counts in the account's own fund, and the three make the total", async () => {
        const before = await read(at(1, 8));
        await pay({
            ref_type: "OWNER_CAPITAL",
            direction: "INCOMING",
            amount: 1000,
            payment_date: at(5, 6),
            to_instrument_id: op,
        });
        await pay({
            ref_type: "TAX_PAID",
            amount: 90.5,
            payment_date: at(6, 6),
            from_instrument_id: rs,
        });
        const after = await read(at(1, 8));
        expect(diff(after, before)).toEqual([909.5, 1000, 0, -90.5]);
        expect(Number((after[1]! + after[2]! + after[3]!).toFixed(2))).toBe(after[0]!);
    });
    test("every account of a fund counts", async () => {
        const second = (
            await prisma.paymentInstrument.create({
                data: { type: "CASH", label: "Funds OPERATING 2" },
            })
        ).id;
        made.push(second);
        const before = await read(at(1, 11));
        for (const [to, amount] of [
            [op, 10],
            [second, 7],
        ] as const)
            await pay({
                ref_type: "OWNER_CAPITAL",
                direction: "INCOMING",
                amount,
                payment_date: at(5, 10),
                to_instrument_id: to,
            });
        expect(diff(await read(at(1, 11)), before)).toEqual([17, 17, 0, 0]);
    });
    test("the dashboard names each account's fund", async () => {
        const row = (await AnalyticsService.financialDashboard({})).cash_by_instrument.find(
            (r) => r.instrument_id === op,
        );
        expect(row?.fund).toBe("OPERATING");
    });
});
