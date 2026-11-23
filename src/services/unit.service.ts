import prisma from "@lib/db";
import { Prisma } from "../../prisma/generated/prisma/client";
import { AppError } from "@lib/app-error";
import { generateUnitCode } from "@lib/code-gen";
import { GENERIC_ITEM_UNITS } from "@lib/enums";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import type { CreateUnitInput } from "@validators/lookup.validator";

type Db = Prisma.TransactionClient;
type UnitRow = Prisma.UnitGetPayload<object>;

function unitKey(label: string): string {
    const key = generateUnitCode(label);
    if (!key) throw AppError.badRequest("A unit name needs at least one letter or number");
    return key;
}

const taken = (unit: UnitRow) =>
    AppError.conflict(
        unit.is_active
            ? `A unit named "${unit.label}" already exists${unit.base_unit ? ` for ${unit.base_unit} items` : ""}. Pick another name.`
            : `A unit named "${unit.label}" is deactivated. Reactivate it in Settings.`,
    );

/** Refuses a unit that can't convert to this base unit (a kg bag on a liter item). */
export function assertConvertsTo(unit: UnitRow, baseUnit: string) {
    if (unit.is_base) {
        throw AppError.badRequest(
            `"${unit.label}" is a base unit and can't be added as a conversion`,
        );
    }
    // GENERIC_ITEM_UNITS (Container) are valid under any family.
    if (!GENERIC_ITEM_UNITS.has(unit.code) && unit.base_unit !== baseUnit) {
        throw AppError.badRequest(
            unit.base_unit
                ? `"${unit.label}" is for ${unit.base_unit} items, this one is counted in ${baseUnit}`
                : `"${unit.label}" can't be used as a package unit`,
        );
    }
}

export const UnitService = {
    /** A unit with base_unit is a custom package unit ("Small Bag" of KG): its size is entered per item
     * (ItemUnit.factor_to_base), so fixed_factor stays null. Without base_unit it can't convert to anything. */
    async create({ label, base_unit }: CreateUnitInput, db: Db = prisma) {
        const key = unitKey(label);
        // The unit list is short, and names are compared the way codes are built, not byte for byte.
        const all = await db.unit.findMany();
        const existing = all.find((u) => generateUnitCode(u.label) === key);
        if (existing) throw taken(existing);
        // A renamed unit keeps its first code, so a free name can still have a taken code.
        const codes = new Set(all.map((u) => u.code));
        let code = key;
        for (let n = 2; codes.has(code); n++) code = `${key}_${n}`;
        try {
            return await db.unit.create({
                data: { code, label, ...(base_unit !== undefined && { base_unit }) },
            });
        } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw AppError.conflict(
                    `A unit named "${label}" already exists. Pick another name.`,
                );
            }
            return handlePrismaWriteError(err);
        }
    },

    /** Renames. The code never moves: app logic and every past record hold it. */
    async update(id: string, label: string) {
        const key = unitKey(label);
        const all = await prisma.unit.findMany();
        if (!all.some((u) => u.id === id)) throw AppError.notFound("Unit");
        const clash = all.find((u) => u.id !== id && generateUnitCode(u.label) === key);
        if (clash) throw taken(clash);
        return prisma.unit.update({ where: { id }, data: { label } });
    },

    /** The unit a name typed on the item form stands for: the one already called that, else a new one. */
    async forItem(db: Db, label: string, baseUnit: CreateUnitInput["base_unit"] & string) {
        const key = unitKey(label);
        const existing = (await db.unit.findMany()).find((u) => generateUnitCode(u.label) === key);
        if (!existing) return UnitService.create({ label, base_unit: baseUnit }, db);
        if (
            !existing.is_active ||
            existing.is_base ||
            (!GENERIC_ITEM_UNITS.has(existing.code) && existing.base_unit !== baseUnit)
        ) {
            throw taken(existing);
        }
        if (existing.fixed_factor) {
            throw AppError.badRequest(
                `"${existing.label}" has a fixed size. Pick it from the list.`,
            );
        }
        return existing;
    },
};
