/** An item's conversions with the unit's current name, so a client (the field app can't read /units)
 * shows "Choto Bag" after a rename, not the code it was created with. */
export const itemUnitsWithLabel = {
    include: { unitRef: { select: { label: true } } },
    orderBy: { created_at: "asc" },
} as const;
