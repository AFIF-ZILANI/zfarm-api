import { Prisma } from "../../prisma/generated/prisma/client";

export type Due = { id: string; due: Prisma.Decimal };

/** One amount handed to a supplier: the old balance, then bills in the order given (oldest first), then advance. */
export function splitOldestFirst(
    amount: Prisma.Decimal,
    openingLeft: Prisma.Decimal,
    bills: Due[],
): {
    opening: Prisma.Decimal;
    bills: { id: string; amount: Prisma.Decimal }[];
    advance: Prisma.Decimal;
} {
    const opening = Prisma.Decimal.min(amount, openingLeft);
    let left = amount.minus(opening);
    const parts: { id: string; amount: Prisma.Decimal }[] = [];
    for (const b of bills) {
        const part = Prisma.Decimal.min(left, b.due);
        if (!part.greaterThan(0)) continue;
        parts.push({ id: b.id, amount: part });
        left = left.minus(part);
    }
    return { opening, bills: parts, advance: left };
}
