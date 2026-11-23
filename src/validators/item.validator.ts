import { z } from "zod";
import { paginationQuerySchema } from "@lib/pagination";
import { unitSchema, resourceCategorySchema, itemBaseUnitSchema } from "@lib/enums";
import { unitLabelSchema } from "@validators/lookup.validator";

/** 1 of the unit = this many of the item's base unit. Bounded by the Decimal(14,4) column: smaller would
 * round to 0 (stock bought by it would vanish), larger overflows. */
const itemUnitFields = {
    factor_to_base: z.coerce
        .number()
        .min(0.0001, "Size must be at least 0.0001")
        .max(1_000_000, "Size can't be more than 1,000,000"),
    is_purchasable: z.coerce.boolean().default(true),
    is_usable: z.coerce.boolean().default(false),
};
const usedSomewhere = (d: { is_purchasable: boolean; is_usable: boolean }) =>
    d.is_purchasable || d.is_usable;
const usedSomewhereMessage = {
    message: "unit must be purchasable, usable, or both",
    path: ["is_purchasable"],
};

/** One conversion sent with its item: a known unit's code, or the name of a custom one. */
const itemUnitInputSchema = z
    .object({ unit: unitSchema.optional(), label: unitLabelSchema.optional(), ...itemUnitFields })
    .refine((d) => (d.unit === undefined) !== (d.label === undefined), {
        message: "Send either unit or label",
        path: ["unit"],
    })
    .refine(usedSomewhere, usedSomewhereMessage);

export const createItemSchema = z.object({
    name: z.string().min(1, "Name is required"),
    category: resourceCategorySchema,
    unit: itemBaseUnitSchema,
    reorder_level: z.coerce.number().nonnegative().optional(),
    preferred_reorder_qty: z.coerce.number().nonnegative().optional(),
    lead_time_days: z.coerce.number().int().nonnegative().optional(),
    supplier_ids: z.array(z.string().uuid()).optional(),
    meta_data: z.record(z.string(), z.string()).optional(),
    // true = individually QR-coded (StockUnit), false = aggregate quantity only (StockLedger).
    // Gates bind() and TransferService.create() so the two mechanisms can't mix for one item.
    is_unit_tracked: z.coerce.boolean().optional(),
    // Made on the farm, never bought (litter): sold without stock, refused on purchases. Never QR-tracked.
    is_farm_made: z.coerce.boolean().optional(),
    // The item's full list of conversions, saved with the item or not at all. Left out = not touched.
    units: z.array(itemUnitInputSchema).max(50).optional(),
});

// unit is intentionally excluded -- ItemUnit conversion factors and every
// PurchaseItem/Consumption base_quantity snapshot are keyed off Item.unit at
// write time, so changing it after the fact would silently invalidate them.
export const updateItemSchema = createItemSchema.omit({ unit: true }).partial();

export const listItemsQuerySchema = paginationQuerySchema.extend({
    category: resourceCategorySchema.optional(),
    is_active: z.enum(["true", "false"]).optional(),
    // The field app's consumption form draws only aggregate items (no QR scan in
    // v1) and its stock-receiving picker only unit-tracked ones. Filtering server
    // -side rather than client-side because a paginated list filtered after the
    // fact silently drops matches past page one.
    is_unit_tracked: z.enum(["true", "false"]).optional(),
    is_farm_made: z.enum(["true", "false"]).optional(),
});

export const createItemUnitSchema = z
    .object({ item_id: z.string().uuid(), unit: unitSchema, ...itemUnitFields })
    .refine(usedSomewhere, usedSomewhereMessage);

export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;
export type CreateItemUnitInput = z.infer<typeof createItemUnitSchema>;
export type ItemUnitInput = z.infer<typeof itemUnitInputSchema>;
