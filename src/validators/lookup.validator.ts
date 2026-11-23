import { z } from "zod";
import { paginationQuerySchema } from "@lib/pagination";
import { itemBaseUnitSchema } from "@lib/enums";

export const createLookupSchema = z.object({
    label: z.string().trim().min(1, "Label is required"),
});

export const updateLookupSchema = createLookupSchema;

export const unitLabelSchema = z
    .string()
    .trim()
    .min(1, "Name is required")
    .max(40, "Keep the name to 40 characters")
    .transform((s) => s.replace(/\s+/g, " "));

export const updateUnitSchema = z.object({ label: unitLabelSchema });

/** base_unit: the base-unit family a custom unit converts to. */
export const createUnitSchema = updateUnitSchema.extend({
    base_unit: itemBaseUnitSchema.optional(),
});

export const listLookupQuerySchema = paginationQuerySchema.extend({
    active: z.enum(["true", "false"]).optional(),
    // Pickers load a whole lookup table at once: past 100 units, page one would leave out Kg and Liter.
    limit: z.coerce.number().int().min(1).max(1000).default(20),
});

export type CreateLookupInput = z.infer<typeof createLookupSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateUnitInput = z.infer<typeof updateUnitSchema>;
export type UpdateLookupInput = z.infer<typeof updateLookupSchema>;
export type ListLookupQuery = z.infer<typeof listLookupQuerySchema>;
