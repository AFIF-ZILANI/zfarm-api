import { describe, test, expect } from "bun:test";
import { Prisma } from "../../prisma/generated/prisma/client";
import { settleLoss, splitProfit } from "./profit-split";

const D = (n: number) => new Prisma.Decimal(n);
const pct = (reinvest = 50, reserve = 30, owner = 20, tax = 10) => ({
    reinvest: D(reinvest),
    reserve: D(reserve),
    owner: D(owner),
    tax: D(tax),
});
const run = (profit: number, carried = 0, principal = 0, p = pct()) => {
    const r = splitProfit({
        profit: D(profit),
        carried: D(carried),
        principal: D(principal),
        pct: p,
    });
    return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toNumber()]));
};

describe("splitProfit", () => {
    test("50/30/20 with tax inside the reserve", () =>
        expect(run(173068)).toEqual({
            recovered: 0,
            base: 173068,
            reinvest: 86534,
            reserve: 51920.4,
            owner: 34613.6,
            tax: 17306.8,
            principal_taken: 0,
            reinvest_to_move: 86534,
        }));
    test("a carried loss comes off first", () =>
        expect(run(200000, 60000)).toMatchObject({
            recovered: 60000,
            base: 140000,
            reinvest: 70000,
            reserve: 42000,
            owner: 28000,
        }));
    test("loan principal comes off reinvestment only, and no more than it", () => {
        expect(run(200000, 60000, 30000)).toMatchObject({
            principal_taken: 30000,
            reinvest_to_move: 40000,
            reserve: 42000,
            owner: 28000,
        });
        expect(run(200000, 60000, 90000)).toMatchObject({
            principal_taken: 70000,
            reinvest_to_move: 0,
            owner: 28000,
        });
        expect(run(200000, 60000, -500)).toMatchObject({
            principal_taken: 0,
            reinvest_to_move: 70000,
        });
    });
    test("a loss as big as the profit leaves nothing to share", () => {
        for (const carried of [1000, 5000])
            expect(run(1000, carried, 50)).toMatchObject({
                recovered: 1000,
                base: 0,
                reinvest: 0,
                reserve: 0,
                owner: 0,
                tax: 0,
                principal_taken: 0,
            });
    });
    test("no profit at all", () =>
        expect(run(0)).toMatchObject({ base: 0, reinvest: 0, reserve: 0, owner: 0 }));
    test("odd paisa: the parts always make the whole, none below zero", () => {
        for (const p of [
            pct(33.33, 33.33, 33.34, 0),
            pct(),
            pct(0, 50, 50, 50),
            pct(100, 0, 0, 0),
            pct(0.01, 49.99, 50, 49.99),
        ])
            for (const profit of [0.01, 0.02, 0.05, 1.01, 100.01, 99999.99]) {
                const r = run(profit, 0, 0, p);
                expect(Math.round((r["reinvest"]! + r["reserve"]! + r["owner"]!) * 100)).toBe(
                    Math.round(profit * 100),
                );
                for (const k of ["reinvest", "reserve", "owner", "tax"])
                    expect(r[k]!).toBeGreaterThanOrEqual(0);
                expect(r["tax"]!).toBeLessThanOrEqual(r["reserve"]!);
            }
    });
});

describe("settleLoss", () => {
    const loss = (l: number, a: number) => {
        const r = settleLoss({ loss: D(l), available: D(a) });
        return [r.covered.toNumber(), r.carried.toNumber()];
    };
    test("the reserve pays what it can, the rest is carried", () => {
        expect(loss(100000, 40000)).toEqual([40000, 60000]);
        expect(loss(100000, 0)).toEqual([0, 100000]);
        expect(loss(100000, 200000)).toEqual([100000, 0]);
        expect(loss(100000, -5)).toEqual([0, 100000]);
    });
});
