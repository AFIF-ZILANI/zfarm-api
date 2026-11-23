import { Prisma } from "../../prisma/generated/prisma/client";

/**
 * The 50/30/20 split of batch profits (docs/superpowers/specs/2026-11-23-profit-split-design.md).
 *
 * A ProfitSplit is the one decision about a closed batch, with its profit frozen. Where each fund stands is
 * worked out on read from those decisions and from payments; a split never changes profit or any batch's P&L.
 */

type Tx = Prisma.TransactionClient;
type Decimal = Prisma.Decimal;
const D = (v: Decimal | number | null | undefined) => new Prisma.Decimal(v ?? 0);
const atLeastZero = (v: Decimal) => Prisma.Decimal.max(v, D(0));

/** What sits in the accounts of one fund, active or not. */
async function fundBalance(db: Tx, fund: "OPERATING" | "REINVEST" | "RESERVE") {
    const [into, out] = await Promise.all([
        db.payment.aggregate({ where: { to_instrument: { fund } }, _sum: { amount: true } }),
        db.payment.aggregate({ where: { from_instrument: { fund } }, _sum: { amount: true } }),
    ]);
    return D(into._sum.amount).minus(D(out._sum.amount));
}

/**
 * Debt Operating has paid down: loan principal, and supplier balances from before FMS. The reinvestment share pays
 * this back by staying in Operating. What was paid straight from another fund isn't Operating's to get back.
 */
async function principalRepaid(db: Tx) {
    const operating = { from_instrument: { fund: "OPERATING" as const } };
    const [installments, openings] = await Promise.all([
        db.payment.findMany({
            where: { ref_type: "LOAN", direction: "OUTGOING", ...operating },
            select: { ref_id: true, amount: true, loan_interest: { select: { amount: true } } },
        }),
        db.payment.aggregate({
            where: { ref_type: "SUPPLIER_OPENING", ...operating },
            _sum: { amount: true },
        }),
    ]);
    const batchLoans = new Map(
        (
            await db.loan.findMany({
                where: { id: { in: installments.map((p) => p.ref_id) }, purpose: "BATCH" },
                select: { id: true, principal: true, total_payable: true },
            })
        ).map((l) => [l.id, l]),
    );
    let principal = D(openings._sum.amount);
    const paidOnBatchLoan = new Map<string, Decimal>();
    for (const p of installments)
        if (batchLoans.has(p.ref_id))
            paidOnBatchLoan.set(p.ref_id, D(paidOnBatchLoan.get(p.ref_id)).plus(p.amount));
        else principal = principal.plus(p.amount).minus(D(p.loan_interest?.amount));
    // A batch loan's interest was booked whole when it was recorded, so each payment is principal in the same
    // proportion as the loan is. From the running total, so a loan paid off has repaid exactly its principal.
    for (const [id, paid] of paidOnBatchLoan) {
        const loan = batchLoans.get(id)!;
        principal = principal.plus(
            paid
                .times(loan.principal)
                .dividedBy(loan.total_payable)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP),
        );
    }
    return principal;
}

/** What is set aside, moved and still to move in each fund, and what the next decision has to take into account. */
export async function fundState(db: Tx) {
    const [decided, losses, moves, kinds, reinvestBalance, reserveBalance, repaid] =
        await Promise.all([
            db.profitSplit.aggregate({
                _sum: {
                    reinvest: true,
                    reserve: true,
                    owner: true,
                    tax: true,
                    principal_taken: true,
                    recovered: true,
                    loss_covered: true,
                },
            }),
            db.profitSplit.aggregate({ where: { kind: "LOSS" }, _sum: { net_profit: true } }),
            db.payment.groupBy({
                by: ["split_move"],
                where: { split_move: { not: null } },
                _sum: { amount: true },
            }),
            db.payment.groupBy({
                by: ["ref_type"],
                where: { ref_type: { in: ["OWNER_DRAW", "TAX_PAID"] } },
                _sum: { amount: true },
            }),
            fundBalance(db, "REINVEST"),
            fundBalance(db, "RESERVE"),
            principalRepaid(db),
        ]);
    const s = decided._sum;
    const moved = (m: string) => D(moves.find((x) => x.split_move === m)?._sum.amount);
    const paid = (t: string) => D(kinds.find((x) => x.ref_type === t)?._sum.amount);

    const reinvestAside = D(s.reinvest).minus(D(s.principal_taken));
    const reserveMoved = moved("TO_RESERVE").minus(moved("FROM_RESERVE"));
    const covered = D(s.loss_covered);
    const reserveToMove = D(s.reserve).minus(covered).minus(reserveMoved);
    const taxHeld = atLeastZero(D(s.tax).minus(paid("TAX_PAID")));
    const drawn = paid("OWNER_DRAW");
    return {
        reinvest: {
            set_aside: reinvestAside,
            moved: moved("TO_REINVEST"),
            to_move: reinvestAside.minus(moved("TO_REINVEST")),
            balance: reinvestBalance,
        },
        reserve: {
            set_aside: D(s.reserve),
            covered,
            moved: reserveMoved,
            /** Below zero: the reserve still has to give this back to Operating for a loss. */
            to_move: reserveToMove,
            balance: reserveBalance,
            tax_held: taxHeld,
            /** What a loss may use: in the account, or still in Operating waiting to be moved -- never the tax. */
            available: atLeastZero(reserveBalance.plus(reserveToMove).minus(taxHeld)),
        },
        owner: { set_aside: D(s.owner), drawn, to_draw: D(s.owner).minus(drawn) },
        carried_loss: D(0).minus(D(losses._sum.net_profit)).minus(covered).minus(D(s.recovered)),
        principal_waiting: atLeastZero(repaid.minus(D(s.principal_taken))),
    };
}
