import { describe, test, expect } from "bun:test";
import { Prisma } from "../../prisma/generated/prisma/client";
import { splitOldestFirst } from "./supplier-split";

const D = (n: number) => new Prisma.Decimal(n);
const run = (amount: number, opening: number, dues: number[]) => {
    const r = splitOldestFirst(
        D(amount),
        D(opening),
        dues.map((d, i) => ({ id: String(i), due: D(d) })),
    );
    return [r.opening.toNumber(), r.bills.map((b) => b.amount.toNumber()), r.advance.toNumber()];
};

describe("splitOldestFirst", () => {
    test("old balance first, the rest is advance", () =>
        expect(run(50000, 30000, [])).toEqual([30000, [], 20000]));
    test("then bills, oldest first, the last one in part", () =>
        expect(run(50000, 10000, [25000, 40000])).toEqual([10000, [25000, 15000], 0]));
    test("paisa add up exactly", () => expect(run(0.3, 0, [0.1, 0.2])).toEqual([0, [0.1, 0.2], 0]));
    test("a stray paisa is advance", () =>
        expect(run(100, 0, [33.33, 33.33, 33.33])).toEqual([0, [33.33, 33.33, 33.33], 0.01]));
    test("a settled bill takes nothing", () =>
        expect(run(500, 0, [0, 500])).toEqual([0, [500], 0]));
});
