import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import { toSkipTake, buildMeta } from "@lib/pagination";
import { normalizeKey } from "@lib/normalize";
import type {
    CreateItemInput,
    UpdateItemInput,
    ListItemsQuery,
    CreateItemUnitInput,
    ItemUnitInput,
} from "@validators/item.validator";
import { Prisma } from "../../prisma/generated/prisma/client";
import { getItemBalances, getStockByLocation } from "@lib/stock-balance";
import type { ITEM_BASE_UNITS } from "@lib/enums";
import { itemUnitsWithLabel } from "@lib/item-units";
import { UnitService, assertConvertsTo } from "@services/unit.service";

const include = { suppliers: true, itemUnits: itemUnitsWithLabel } as const;

/** Makes the item's conversions exactly `rows`. Sizes change in place, so a unit can't be lost halfway. */
async function syncItemUnits(
    tx: Prisma.TransactionClient,
    item: { id: string; unit: string },
    rows: ItemUnitInput[],
) {
    const had = new Set(
        (await tx.itemUnit.findMany({ where: { item_id: item.id }, select: { unit: true } })).map(
            (u) => u.unit,
        ),
    );
    const wanted = new Map<
        string,
        Pick<ItemUnitInput, "is_purchasable" | "is_usable"> & {
            factor_to_base: Prisma.Decimal | number;
        }
    >();
    for (const { unit: code, label, factor_to_base, is_purchasable, is_usable } of rows) {
        const unit =
            label !== undefined
                ? await UnitService.forItem(
                      tx,
                      label,
                      item.unit as (typeof ITEM_BASE_UNITS)[number],
                  )
                : await tx.unit.findUnique({ where: { code: code! } });
        if (!unit) throw AppError.badRequest(`"${code}" does not reference a known unit code`);
        if (unit.code === item.unit) {
            throw AppError.badRequest(`"${unit.label}" already is this item's base unit`);
        }
        // Only a unit being added is checked: one from before the family rules must not block every later edit.
        if (!had.has(unit.code)) assertConvertsTo(unit, item.unit);
        if (wanted.has(unit.code)) throw AppError.badRequest(`"${unit.label}" is listed twice`);
        // A fixed_factor is a physical constant (Metric Ton = 1000): it wins over whatever was sent.
        wanted.set(unit.code, {
            factor_to_base: unit.fixed_factor ?? factor_to_base,
            is_purchasable,
            is_usable,
        });
    }
    await tx.itemUnit.deleteMany({
        where: { item_id: item.id, unit: { notIn: [...wanted.keys()] } },
    });
    for (const [unit, data] of wanted) {
        await tx.itemUnit.upsert({
            where: { item_id_unit: { item_id: item.id, unit } },
            create: { item_id: item.id, unit, ...data },
            update: data,
        });
    }
}

/** A farm-made item is never bought, so it has no lots to put QR codes on (DB CHECK Item_farm_made_not_tracked). */
const farmMadeTracked = () =>
    AppError.badRequest("An item made on the farm can't be tracked by QR code");

export const ItemService = {
    async getAll(query: ListItemsQuery) {
        const where = {
            ...(query.category !== undefined && { category: query.category }),
            ...(query.is_active !== undefined && { is_active: query.is_active === "true" }),
            ...(query.is_farm_made !== undefined && {
                is_farm_made: query.is_farm_made === "true",
            }),
            ...(query.is_unit_tracked !== undefined && {
                is_unit_tracked: query.is_unit_tracked === "true",
            }),
        };
        const [items, total] = await Promise.all([
            prisma.item.findMany({
                where,
                include,
                orderBy: { created_at: "desc" },
                ...toSkipTake(query),
            }),
            prisma.item.count({ where }),
        ]);
        return { items, meta: buildMeta(total, query) };
    },

    async getById(id: string) {
        // itemOrganizations only on the detail read -- the edit form prefills its manufacturer from it.
        const item = await prisma.item.findUnique({
            where: { id },
            include: { ...include, itemOrganizations: true },
        });
        if (!item) throw AppError.notFound("Item");
        return item;
    },

    async create(data: CreateItemInput) {
        if (data.is_farm_made && data.is_unit_tracked) throw farmMadeTracked();
        try {
            return await prisma.$transaction(async (tx) => {
                const item = await tx.item.create({
                    data: {
                        name: data.name,
                        normalized_key: normalizeKey(data.name),
                        category: data.category,
                        unit: data.unit,
                        ...(data.reorder_level !== undefined && {
                            reorder_level: data.reorder_level,
                        }),
                        ...(data.preferred_reorder_qty !== undefined && {
                            preferred_reorder_qty: data.preferred_reorder_qty,
                        }),
                        ...(data.lead_time_days !== undefined && {
                            lead_time_days: data.lead_time_days,
                        }),
                        ...(data.supplier_ids !== undefined && {
                            suppliers: { connect: data.supplier_ids.map((id) => ({ id })) },
                        }),
                        ...(data.meta_data !== undefined && { meta_data: data.meta_data }),
                        ...(data.is_unit_tracked !== undefined && {
                            is_unit_tracked: data.is_unit_tracked,
                        }),
                        ...(data.is_farm_made !== undefined && { is_farm_made: data.is_farm_made }),
                    },
                });
                if (data.units) await syncItemUnits(tx, item, data.units);
                return tx.item.findUniqueOrThrow({ where: { id: item.id }, include });
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    async update(id: string, data: UpdateItemInput) {
        const item = await prisma.item.findUnique({ where: { id } });
        if (!item) throw AppError.notFound("Item");

        const {
            name,
            category,
            reorder_level,
            preferred_reorder_qty,
            lead_time_days,
            supplier_ids,
            meta_data,
            is_unit_tracked,
            is_farm_made,
            units,
        } = data;
        if (
            !name &&
            !category &&
            reorder_level === undefined &&
            preferred_reorder_qty === undefined &&
            lead_time_days === undefined &&
            !supplier_ids &&
            meta_data === undefined &&
            is_unit_tracked === undefined &&
            is_farm_made === undefined &&
            units === undefined
        ) {
            throw AppError.badRequest("No update fields provided");
        }

        // Flipping the tracking mode under existing purchases would leave coded units and
        // aggregate ledger rows for the same item describing stock two different ways.
        // Farm-made is fixed the same way once bought or sold: past sales were recorded as one kind.
        if (is_unit_tracked !== undefined || is_farm_made !== undefined) {
            const current = await prisma.item.findUnique({
                where: { id },
                select: { is_unit_tracked: true, is_farm_made: true },
            });
            if (current) {
                if (
                    (is_farm_made ?? current.is_farm_made) &&
                    (is_unit_tracked ?? current.is_unit_tracked)
                )
                    throw farmMadeTracked();
                const purchases = await prisma.purchaseItem.count({ where: { item_id: id } });
                if (
                    is_unit_tracked !== undefined &&
                    current.is_unit_tracked !== is_unit_tracked &&
                    purchases > 0
                ) {
                    throw AppError.conflict(
                        "Tracking mode can't change once the item has been purchased",
                    );
                }
                if (
                    is_farm_made !== undefined &&
                    current.is_farm_made !== is_farm_made &&
                    purchases + (await prisma.saleItem.count({ where: { item_id: id } })) > 0
                ) {
                    throw AppError.conflict(
                        "Farm-made can't change once the item has been bought or sold",
                    );
                }
            }
        }

        try {
            return await prisma.$transaction(async (tx) => {
                if (units) await syncItemUnits(tx, item, units);
                return tx.item.update({
                    where: { id },
                    data: {
                        ...(name && { name, normalized_key: normalizeKey(name) }),
                        ...(category && { category }),
                        ...(reorder_level !== undefined && { reorder_level }),
                        ...(preferred_reorder_qty !== undefined && { preferred_reorder_qty }),
                        ...(lead_time_days !== undefined && { lead_time_days }),
                        ...(supplier_ids !== undefined && {
                            suppliers: { set: supplier_ids.map((id) => ({ id })) },
                        }),
                        ...(meta_data !== undefined && { meta_data }),
                        ...(is_unit_tracked !== undefined && { is_unit_tracked }),
                        ...(is_farm_made !== undefined && { is_farm_made }),
                    },
                    include,
                });
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    async setActive(id: string, is_active: boolean) {
        const item = await prisma.item.findUnique({ where: { id } });
        if (!item) throw AppError.notFound("Item");
        return prisma.item.update({ where: { id }, data: { is_active }, include });
    },

    /**
     * Hard delete -- only for an item that was never used (typo, duplicate,
     * mis-created). Refuses as soon as any history references it: deactivate
     * that one instead, so its purchases, ledger and consumption keep resolving
     * to a real row. InventoryAdjustment is onDelete: Restrict, so the database
     * refuses too (the backstop, including a delete that races the count); the explicit
     * count is what gives a readable error. ItemUnit/ItemOrganization/Suppliers links are
     * config, not history, and are allowed to cascade away with the item.
     */
    async remove(id: string) {
        const item = await prisma.item.findUnique({
            where: { id },
            select: {
                _count: {
                    select: {
                        purchaseItems: true,
                        ledgerEntries: true,
                        consumptions: true,
                        saleItems: true,
                        feedingPrograms: true,
                        inventoryAdjustments: true,
                        stockTransfers: true,
                    },
                },
            },
        });
        if (!item) throw AppError.notFound("Item");

        const attached = Object.values(item._count).reduce((sum, n) => sum + n, 0);
        if (attached > 0) {
            throw AppError.conflict(
                "Item has recorded history and cannot be deleted. Deactivate it instead.",
            );
        }

        return prisma.item.delete({ where: { id } });
    },

    /** Active items under their reorder level, balance computed from StockLedger. No pagination -- this list is meant to be short. */
    async getLowStock() {
        const items = await prisma.item.findMany({
            where: { is_active: true, reorder_level: { not: null } },
            orderBy: { name: "asc" },
        });
        const balances = await getItemBalances(items.map((i) => i.id));
        return items
            .map((item) => ({
                ...item,
                current_balance: balances.get(item.id) ?? new Prisma.Decimal(0),
            }))
            .filter((item) => item.current_balance.lessThan(item.reorder_level!));
    },

    /** Per-(item, location) on-hand stock for every item, feeding the catalog's warehouse/house
     * columns and their breakdown sheets in one call. See getStockByLocation for what's excluded. */
    async getStockByLocation() {
        return getStockByLocation();
    },
};

export const ItemUnitService = {
    async create(data: CreateItemUnitInput) {
        const item = await prisma.item.findUnique({
            where: { id: data.item_id },
            select: { unit: true },
        });
        if (!item) throw AppError.badRequest("item_id does not reference an existing record");
        if (item.unit === data.unit) {
            throw AppError.badRequest(
                "unit already is this item's base unit -- no conversion factor needed",
            );
        }

        const unitRow = await prisma.unit.findUnique({ where: { code: data.unit } });
        if (!unitRow) throw AppError.badRequest("unit does not reference a known unit code");
        assertConvertsTo(unitRow, item.unit);
        // A fixed_factor is a physical constant (Liter=1000, Ft=0.3048, ...) -- always use it over
        // whatever the client sent, so a typo can't desync an item's conversion from reality.
        const factor_to_base = unitRow.fixed_factor ?? data.factor_to_base;

        try {
            return await prisma.itemUnit.create({ data: { ...data, factor_to_base } });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    async remove(id: string) {
        const link = await prisma.itemUnit.findUnique({ where: { id } });
        if (!link) throw AppError.notFound("ItemUnit conversion");
        await prisma.itemUnit.delete({ where: { id } });
    },
};
