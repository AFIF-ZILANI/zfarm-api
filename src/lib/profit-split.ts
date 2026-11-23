import { Prisma } from "../../prisma/generated/prisma/client";

type Decimal = Prisma.Decimal;
/** Shares in percent: the first three make 100, tax is inside the reserve. */
export type Pct = { reinvest: Decimal; reserve: Decimal; owner: Decimal; tax: Decimal };

const ZERO = new Prisma.Decimal(0);
const min = (a: Decimal, b: Decimal) => Prisma.Decimal.min(a, b);
const max = (a: Decimal, b: Decimal) => Prisma.Decimal.max(a, b);
const share = (base: Decimal, pct: Decimal) =>
    base.times(pct).dividedBy(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

/**
 * A batch's profit: carried losses first, then the shares of what's left, then loan principal off reinvestment
 * (Operating already paid it, so that much stays there). Rounding never loses or makes a paisa: the reserve and the
 * owner are rounded, the last of them never past what's left, and reinvestment is the remainder.
 */
export function splitProfit(p: {
    profit: Decimal;
    carried: Decimal;
    principal: Decimal;
    pct: Pct;
}) {
    const recovered = min(p.profit, max(p.carried, ZERO));
    const base = p.profit.minus(recovered);
    const reserve = share(base, p.pct.reserve);
    const owner = min(share(base, p.pct.owner), base.minus(reserve));
    const reinvest = base.minus(reserve).minus(owner);
    const principal_taken = min(reinvest, max(p.principal, ZERO));
    return {
        recovered,
        base,
        reinvest,
        reserve,
        owner,
        tax: min(share(base, p.pct.tax), reserve),
        principal_taken,
        reinvest_to_move: reinvest.minus(principal_taken),
    };
}

/** A batch's loss: the reserve pays what it can, the rest comes out of the next profit. */
export function settleLoss(p: { loss: Decimal; available: Decimal }) {
    const covered = min(p.loss, max(p.available, ZERO));
    return { covered, carried: p.loss.minus(covered) };
}
