import { z } from "zod";
import { paginationQuerySchema } from "@lib/pagination";
import { itemBaseUnitSchema } from "@lib/enums";

export const createLookupSchema = z.object({
    label: z.string().trim().min(1, "Label is required"),
});

export const updateLookupSchema = createLookupSchema;

/** Units only: the base-unit family a custom unit converts to. */
export const createUnitSchema = createLookupSchema.extend({
    base_unit: itemBaseUnitSchema.optional(),
});

export const listLookupQuerySchema = paginationQuerySchema.extend({
    active: z.enum(["true", "false"]).optional(),
});

export type CreateLookupInput = z.infer<typeof createLookupSchema>;
export type CreateUnitInput = z.infer<typeof createUnitSchema>;
export type UpdateLookupInput = z.infer<typeof updateLookupSchema>;
export type ListLookupQuery = z.infer<typeof listLookupQuerySchema>;
