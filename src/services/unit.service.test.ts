import { describe, test, expect, afterAll } from "bun:test";
import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { createUnitSchema } from "@validators/lookup.validator";
import { UnitService } from "./unit.service";
import { ItemUnitService } from "./item.service";

const tag = crypto.randomUUID().slice(0, 8);
const unitIds: string[] = [];
const itemIds: string[] = [];

const makeItem = async (unit: string) => {
    const name = `Custom Unit Test ${unit} ${tag}`;
    const category = await prisma.itemCategory.findFirstOrThrow();
    const item = await prisma.item.create({
        data: { name, normalized_key: name.toLowerCase(), category: category.code, unit },
    });
    itemIds.push(item.id);
    return item;
};

describe("UnitService.create", () => {
    afterAll(async () => {
        await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
        await prisma.unit.deleteMany({ where: { id: { in: unitIds } } });
    });

    test("two custom bag sizes work side by side on one kg item, each with its own factor", async () => {
        const item = await makeItem("KG");
        for (const [label, factor] of [
            ["Small Bag", 25],
            ["Big Bag", 50],
        ] as const) {
            const unit = await UnitService.create({ label: `${label} ${tag}`, base_unit: "KG" });
            unitIds.push(unit.id);
            expect(unit).toMatchObject({ base_unit: "KG", is_base: false, fixed_factor: null });
            const link = await ItemUnitService.create({
                item_id: item.id,
                unit: unit.code,
                factor_to_base: factor,
                is_purchasable: true,
                is_usable: true,
            });
            expect(link!.factor_to_base.toNumber()).toBe(factor);
        }
    });

    test("a custom kg unit is still refused on a liter item", async () => {
        const unit = await UnitService.create({ label: `Kg Only ${tag}`, base_unit: "KG" });
        unitIds.push(unit.id);
        const item = await makeItem("LITER");
        await expect(
            ItemUnitService.create({
                item_id: item.id,
                unit: unit.code,
                factor_to_base: 2,
                is_purchasable: true,
                is_usable: false,
            }),
        ).rejects.toBeInstanceOf(AppError);
    });

    test("a taken name is a 409 that says why", async () => {
        const unit = await UnitService.create({ label: `Taken ${tag}`, base_unit: "KG" });
        unitIds.push(unit.id);
        await expect(
            UnitService.create({ label: `taken ${tag}`, base_unit: "LITER" }),
        ).rejects.toMatchObject({
            status: 409,
            message: expect.stringContaining("already exists"),
        });

        await prisma.unit.update({ where: { id: unit.id }, data: { is_active: false } });
        await expect(
            UnitService.create({ label: `taken ${tag}`, base_unit: "KG" }),
        ).rejects.toMatchObject({ status: 409, message: expect.stringContaining("deactivated") });
    });

    test("a label with no letters or digits is refused", async () => {
        await expect(UnitService.create({ label: "!!!", base_unit: "KG" })).rejects.toMatchObject({
            status: 400,
        });
    });

    test("without base_unit it stays a plain lookup create (Settings)", async () => {
        const unit = await UnitService.create({ label: `Plain ${tag}` });
        unitIds.push(unit.id);
        expect(unit.base_unit).toBeNull();
    });

    test("base_unit must be one of the base units", () => {
        expect(createUnitSchema.safeParse({ label: "x", base_unit: "BAG" }).success).toBe(false);
    });
});
