import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { generateCode } from "@lib/code-gen";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import type { CreateUnitInput } from "@validators/lookup.validator";

export const UnitService = {
    /** A unit with base_unit is a custom package unit ("Small Bag" of KG): its size is entered per item
     * (ItemUnit.factor_to_base), so fixed_factor stays null. Without base_unit it can't convert to anything. */
    async create({ label, base_unit }: CreateUnitInput) {
        const code = generateCode(label);
        if (!code) throw AppError.badRequest("Label must contain at least one letter or number");
        const existing = await prisma.unit.findUnique({ where: { code } });
        if (existing) {
            throw AppError.conflict(
                existing.is_active
                    ? `A unit named "${existing.label}" already exists${existing.base_unit ? ` for ${existing.base_unit} items` : ""}. Pick another name.`
                    : `A unit named "${existing.label}" is deactivated. Reactivate it in Settings.`,
            );
        }
        try {
            return await prisma.unit.create({
                data: { code, label, ...(base_unit !== undefined && { base_unit }) },
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },
};
