import { describe, test, expect, afterAll } from "bun:test";
import prisma from "@lib/db";
import {
    createItemSchema,
    updateItemSchema,
    createItemUnitSchema,
} from "@validators/item.validator";
import { createUnitSchema, listLookupQuerySchema } from "@validators/lookup.validator";
import { generateUnitCode } from "@lib/code-gen";
import { ItemService } from "./item.service";
import { UnitService } from "./unit.service";

const tag = crypto.randomUUID().slice(0, 8);
const { code: category } = await prisma.itemCategory.findFirstOrThrow();

const input = (name: string, unit: string, units: unknown[]) =>
    createItemSchema.parse({ name: `${name} ${tag}`, category, unit, units });
const factors = async (item_id: string) =>
    Object.fromEntries(
        (await prisma.itemUnit.findMany({ where: { item_id } })).map((u) => [
            u.unit,
            u.factor_to_base.toNumber(),
        ]),
    );
const row = (over: object) => ({
    factor_to_base: 25,
    is_purchasable: true,
    is_usable: true,
    ...over,
});

afterAll(async () => {
    await prisma.item.deleteMany({ where: { name: { endsWith: tag } } });
    await prisma.unit.deleteMany({ where: { label: { contains: tag } } });
});

describe("generateUnitCode", () => {
    test.each([
        ["Small Bag", "SMALL_BAG"],
        ["  small-bag ", "SMALL_BAG"],
        ["Mon (40kg)", "MON_40KG"],
        ["Bag 12.5kg", "BAG_12.5KG"],
        ["Bag 125kg", "BAG_125KG"],
        ["Bag no. 5", "BAG_NO_5"],
        ["ছোট বস্তা ১২.৫", "ছোট_বস্তা_১২.৫"],
        ["র‍্যাক", "র্যাক"],
        ["🐔 ...", ""],
    ])("%s -> %s", (label, code) => expect(generateUnitCode(label)).toBe(code.normalize("NFC")));
});

describe("unit names", () => {
    test("a decimal and a whole number are different units; Bangla names work", async () => {
        const codes = [];
        for (const label of [`${tag} 12.5`, `${tag} 125`, `ছোট বস্তা ${tag}`, `বড় বস্তা ${tag}`])
            codes.push((await UnitService.create({ label, base_unit: "KG" })).code);
        expect(new Set(codes).size).toBe(4);
    });

    test("after a rename the old name is free again and the new one is taken", async () => {
        const a = await UnitService.create({ label: `Old ${tag}`, base_unit: "KG" });
        await UnitService.update(a.id, `New ${tag}`);
        expect((await prisma.unit.findUniqueOrThrow({ where: { id: a.id } })).code).toBe(a.code);
        const b = await UnitService.create({ label: `Old ${tag}`, base_unit: "KG" });
        expect(b.code).not.toBe(a.code);
        await expect(UnitService.update(b.id, `new-${tag}`)).rejects.toMatchObject({ status: 409 });
        // Its own name, differently cased, is not a clash with itself.
        expect((await UnitService.update(b.id, `OLD ${tag}`)).label).toBe(`OLD ${tag}`);
    });

    test("names are capped at 40 characters", () => {
        expect(createUnitSchema.safeParse({ label: "A".repeat(41) }).success).toBe(false);
    });

    test("simultaneous creates: one wins, the rest get a readable 409", async () => {
        const all = await Promise.allSettled(
            Array.from({ length: 5 }, () =>
                UnitService.create({ label: `Race ${tag}`, base_unit: "KG" }),
            ),
        );
        expect(all.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        for (const r of all)
            if (r.status === "rejected") {
                expect(r.reason.status).toBe(409);
                expect(r.reason.message).toContain("already exists");
            }
    });

    test("the whole unit list fits in one request", () => {
        expect(listLookupQuerySchema.safeParse({ limit: "1000" }).success).toBe(true);
    });
});

describe("item saved with its units", () => {
    test("custom names become units, sizes are per item, the name is shared", async () => {
        const a = await ItemService.create(
            input("Feed A", "KG", [
                row({ label: `Sack ${tag}` }),
                row({ label: `Big ${tag}`, factor_to_base: 50 }),
            ]),
        );
        const b = await ItemService.create(
            input("Feed B", "KG", [row({ label: `sack ${tag}`, factor_to_base: 20 })]),
        );
        const code = generateUnitCode(`Sack ${tag}`);
        expect((await factors(a.id))[code]).toBe(25);
        expect((await factors(b.id))[code]).toBe(20);
        expect(a.itemUnits.find((u) => u.unit === code)!.unitRef.label).toBe(`Sack ${tag}`);
    });

    test("a refused unit saves nothing: no item, no new unit", async () => {
        await expect(
            ItemService.create(
                input("Nope", "LITER", [row({ label: `Ghost ${tag}` }), row({ unit: "BAG" })]),
            ),
        ).rejects.toMatchObject({ status: 400 });
        expect(await prisma.item.count({ where: { name: `Nope ${tag}` } })).toBe(0);
        expect(await prisma.unit.count({ where: { label: `Ghost ${tag}` } })).toBe(0);
    });

    test("editing a size keeps the same row; left-out units go; units omitted = untouched", async () => {
        const item = await ItemService.create(
            input("Edit", "KG", [
                row({ unit: "BAG", factor_to_base: 50 }),
                row({ unit: "SACHETS", factor_to_base: 1 }),
            ]),
        );
        const before = await prisma.itemUnit.findFirstOrThrow({
            where: { item_id: item.id, unit: "BAG" },
        });
        await ItemService.update(
            item.id,
            updateItemSchema.parse({ units: [row({ unit: "BAG", factor_to_base: 40 })] }),
        );
        const after = await prisma.itemUnit.findFirstOrThrow({
            where: { item_id: item.id, unit: "BAG" },
        });
        expect(after.id).toBe(before.id);
        expect(await factors(item.id)).toEqual({ BAG: 40 });
        await ItemService.update(item.id, updateItemSchema.parse({ lead_time_days: 3 }));
        expect(await factors(item.id)).toEqual({ BAG: 40 });
    });

    test("a failed edit loses nothing", async () => {
        const item = await ItemService.create(
            input("Keep", "KG", [row({ unit: "BAG", factor_to_base: 50 })]),
        );
        await expect(
            ItemService.update(
                item.id,
                updateItemSchema.parse({
                    lead_time_days: 9,
                    units: [row({ unit: "SACHETS" }), row({ unit: "ML" })],
                }),
            ),
        ).rejects.toMatchObject({ status: 400 });
        expect(await factors(item.id)).toEqual({ BAG: 50 });
        expect(
            (await prisma.item.findUniqueOrThrow({ where: { id: item.id } })).lead_time_days,
        ).toBeNull();
    });

    test("a unit the item already had is not re-judged, so old data stays editable", async () => {
        const item = await ItemService.create(input("Legacy", "KG", []));
        await prisma.itemUnit.create({
            data: { item_id: item.id, unit: "BOTTLE", factor_to_base: 2 },
        });
        await ItemService.update(
            item.id,
            updateItemSchema.parse({ units: [row({ unit: "BOTTLE", factor_to_base: 3 })] }),
        );
        expect(await factors(item.id)).toEqual({ BOTTLE: 3 });
    });

    test("clashing names are refused with the reason", async () => {
        const cases: [string, RegExp][] = [
            ["liter", /already exists/],
            ["metric ton", /fixed size/],
            ["Bottle", /already exists for LITER/],
        ];
        for (const [label, message] of cases)
            await expect(
                ItemService.create(input(`Clash ${label}`, "KG", [row({ label })])),
            ).rejects.toMatchObject({
                message: expect.stringMatching(message),
            });
        await expect(
            ItemService.create(input("Twice", "KG", [row({ unit: "BAG" }), row({ label: "bag" })])),
        ).rejects.toMatchObject({ message: expect.stringMatching(/twice/) });
        const off = await UnitService.create({ label: `Off ${tag}`, base_unit: "KG" });
        await prisma.unit.update({ where: { id: off.id }, data: { is_active: false } });
        await expect(
            ItemService.create(input("Off", "KG", [row({ label: `off ${tag}` })])),
        ).rejects.toMatchObject({ message: expect.stringMatching(/deactivated/) });
    });

    test("bad rows never reach the database", () => {
        const bad = (r: object) =>
            createItemSchema.safeParse({ name: "x", category, unit: "KG", units: [r] }).success;
        expect(bad(row({ unit: "BAG" }))).toBe(true);
        expect(bad(row({ unit: "BAG", label: "Bag" }))).toBe(false);
        expect(bad(row({}))).toBe(false);
        expect(bad(row({ unit: "BAG", is_purchasable: false, is_usable: false }))).toBe(false);
        for (const f of [0, -1, 0.00001, 1e11, ""])
            expect(bad(row({ unit: "BAG", factor_to_base: f }))).toBe(false);
        const direct = (f: number) =>
            createItemUnitSchema.safeParse({
                item_id: crypto.randomUUID(),
                unit: "BAG",
                factor_to_base: f,
            }).success;
        expect([direct(50), direct(1e11), direct(0.00001)]).toEqual([true, false, false]);
    });
});
