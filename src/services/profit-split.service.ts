import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { audit } from "@lib/audit";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import { settleLoss, splitProfit, type Pct } from "@lib/profit-split";
import { getItemAvgCosts } from "@lib/stock-value";
import { BatchPnlService } from "@services/batch-pnl.service";
import { getSplit } from "@services/farm-settings.service";
import { balancesAt } from "@services/finance.service";
import { writePayment } from "@services/payment.service";
import { SharedCostService } from "@services/shared-cost.service";
import { Prisma } from "../../prisma/generated/prisma/client";
import type {
    DecideInput,
    MoveInput,
    ReasonInput,
    SkipInput,
} from "@validators/profit-split.validator";

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

// ── writes ── each inside a transaction holding lockSplit, so no two decisions or moves read the same figures

const lockSplit = (tx: Tx) =>
    tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('profit-split', 0))`;

/** Closed batches with no decision yet, oldest first: a loss can't be passed over for a later profit. */
const undecided = (db: Tx) =>
    db.batches.findMany({
        where: { status: "CLOSED", profitSplit: null },
        orderBy: [{ actual_end_date: "asc" }, { created_at: "asc" }],
        select: { id: true, batch_code: true, actual_end_date: true },
    });

async function requireNext(tx: Tx, batch_id: string) {
    const batch = await tx.batches.findUnique({
        where: { id: batch_id },
        select: { status: true, batch_code: true, profitSplit: { select: { id: true } } },
    });
    if (!batch) throw AppError.notFound("Batch");
    if (batch.status !== "CLOSED")
        throw AppError.conflict(`Batch ${batch.batch_code} isn't closed yet`);
    if (batch.profitSplit) throw AppError.conflict(`Batch ${batch.batch_code} is already decided`);
    const [next] = await undecided(tx);
    if (next && next.id !== batch_id)
        throw AppError.conflict(`Decide batch ${next.batch_code} first`);
}

export async function decide(
    tx: Tx,
    d: { batch_id: string; profit: Decimal; pct: Pct; actor_id: string },
) {
    await requireNext(tx, d.batch_id);
    const state = await fundState(tx);
    const common = {
        batch_id: d.batch_id,
        net_profit: d.profit,
        pct_reinvest: d.pct.reinvest,
        pct_reserve: d.pct.reserve,
        pct_owner: d.pct.owner,
        pct_tax: d.pct.tax,
        approved_by_id: d.actor_id,
        approved_at: new Date(),
    };
    if (d.profit.isNegative()) {
        const { covered } = settleLoss({
            loss: d.profit.negated(),
            available: state.reserve.available,
        });
        return tx.profitSplit.create({ data: { ...common, kind: "LOSS", loss_covered: covered } });
    }
    const { recovered, reinvest, reserve, owner, tax, principal_taken } = splitProfit({
        profit: d.profit,
        carried: state.carried_loss,
        principal: state.principal_waiting,
        pct: d.pct,
    });
    return tx.profitSplit.create({
        data: {
            ...common,
            kind: "PROFIT",
            recovered,
            reinvest,
            reserve,
            owner,
            tax,
            principal_taken,
        },
    });
}

/** Leaves out a batch from before the split was used. Not once there is a real decision: that would be a way past a loss. */
export async function skip(
    tx: Tx,
    d: { batch_id: string; profit: Decimal; reason: string; actor_id: string },
) {
    if ((await tx.profitSplit.count({ where: { kind: { not: "SKIPPED" } } })) > 0)
        throw AppError.conflict("Batches can't be skipped once one has been split");
    await requireNext(tx, d.batch_id);
    return tx.profitSplit.create({
        data: {
            batch_id: d.batch_id,
            kind: "SKIPPED",
            net_profit: d.profit,
            reason: d.reason,
            approved_by_id: d.actor_id,
            approved_at: new Date(),
        },
    });
}

const latestDecision = (db: Tx) => db.profitSplit.findFirst({ orderBy: { approved_at: "desc" } });

/** Takes back the latest decision. Money already moved isn't touched: it shows as moved ahead. */
export async function undo(tx: Tx, d: { id: string; reason: string; actor_id: string }) {
    const split = await tx.profitSplit.findUnique({ where: { id: d.id } });
    if (!split) throw AppError.notFound("Decision");
    if ((await latestDecision(tx))?.id !== d.id)
        throw AppError.conflict("Only the latest decision can be undone");
    await tx.profitSplit.delete({ where: { id: d.id } });
    await audit(tx, {
        table: "ProfitSplit",
        record_id: d.id,
        action: "DELETE",
        actor_id: d.actor_id,
        note: `Profit split undone: ${d.reason}`,
        before: JSON.parse(JSON.stringify(split)),
    });
}

/** Records money moved between Operating and a fund. It can't be more than is left to move. */
export async function move(tx: Tx, d: Omit<MoveInput, "actor_id"> & { actor_id: string }) {
    const fund = d.move === "TO_REINVEST" ? "REINVEST" : "RESERVE";
    const name = fund === "REINVEST" ? "Reinvestment" : "Reserve";
    const [fundAccount, operating, state] = await Promise.all([
        tx.paymentInstrument.findFirst({ where: { fund, is_active: true }, select: { id: true } }),
        tx.paymentInstrument.findUnique({
            where: { id: d.operating_instrument_id },
            select: { fund: true },
        }),
        fundState(tx),
    ]);
    if (!fundAccount) throw AppError.badRequest(`Add a ${name} account first`);
    if (operating?.fund !== "OPERATING")
        throw AppError.badRequest("The other side must be an operating account", {
            fields: { operating_instrument_id: "Pick an operating account" },
        });
    const back = d.move === "FROM_RESERVE";
    const left = {
        TO_REINVEST: state.reinvest.to_move,
        TO_RESERVE: state.reserve.to_move,
        FROM_RESERVE: state.reserve.to_move.negated(),
    }[d.move];
    if (D(d.amount).greaterThan(left)) {
        const shown = atLeastZero(left).toFixed(2);
        throw AppError.badRequest(`Only ${shown} is left to move`, {
            fields: { amount: `Only ${shown} is left to move` },
        });
    }
    return writePayment(tx, {
        ref_type: "TRANSFER",
        split_move: d.move,
        amount: d.amount,
        payment_date: d.payment_date,
        from_instrument_id: back ? fundAccount.id : d.operating_instrument_id,
        to_instrument_id: back ? d.operating_instrument_id : fundAccount.id,
        handled_by_id: d.actor_id,
        ...(d.transaction_ref !== undefined && { transaction_ref: d.transaction_ref }),
        ...(d.note !== undefined && { note: d.note }),
    });
}

/** A move recorded by mistake. Ordinary transfers aren't moves and stay in the cash book. */
export async function removeMove(
    tx: Tx,
    d: { payment_id: string; reason: string; actor_id: string },
) {
    const payment = await tx.payment.findFirst({
        where: { id: d.payment_id, split_move: { not: null } },
    });
    if (!payment) throw AppError.notFound("Move");
    await tx.payment.delete({ where: { id: payment.id } });
    await audit(tx, {
        table: "Payment",
        record_id: payment.id,
        action: "DELETE",
        actor_id: d.actor_id,
        note: `Profit split move removed: ${d.reason}`,
        before: JSON.parse(JSON.stringify(payment)),
    });
}

// ── the service ──

async function locked<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    try {
        return await prisma.$transaction(async (tx) => {
            await lockSplit(tx);
            return fn(tx);
        });
    } catch (err) {
        return handlePrismaWriteError(err);
    }
}

/** The batch's profit now, and that it is what the person deciding was looking at. */
async function profitShown(batch_id: string, expected: number) {
    const profit = D((await BatchPnlService.statement(batch_id)).net_profit);
    if (!profit.equals(D(expected)))
        throw AppError.conflict(
            `This batch's profit is now ${profit.toFixed(2)} -- check it and decide again`,
        );
    return profit;
}

/** Costs the rule leaves out because no batch carries them, since the last decision. */
async function notInBatches(since: Date | null) {
    const from = since ?? new Date(0);
    const [months, written, capital] = await Promise.all([
        SharedCostService.byMonth(),
        prisma.stockLedger.findMany({
            where: {
                occurred_at: { gte: from },
                direction: "OUT",
                reason: { in: ["WASTAGE", "EXPIRED"] },
            },
            select: { item_id: true, quantity: true },
        }),
        prisma.expense.aggregate({
            where: { cost_type: "SHARED_CAPITAL", date: { gte: from } },
            _sum: { amount: true },
        }),
    ]);
    const avg = await getItemAvgCosts([...new Set(written.map((w) => w.item_id))]);
    const shared = months
        .filter((m) => m.bird_days === 0)
        .flatMap((m) => m.expenses)
        .filter((e) => e.date >= from)
        .reduce((t, e) => t.plus(e.amount), D(0));
    const lost = written.reduce((t, w) => t.plus(w.quantity.times(avg.get(w.item_id) ?? 0)), D(0));
    const cap = D(capital._sum.amount);
    return {
        since,
        shared_no_birds: shared.toFixed(2),
        written_off: lost.toFixed(2),
        capital: cap.toFixed(2),
        total: shared.plus(lost).plus(cap).toFixed(2),
    };
}

/** Every Decimal as a two-place string. */
type Text<T> = { [K in keyof T]: T[K] extends Decimal ? string : Text<T[K]> };
const text = <T extends object>(o: T): Text<T> =>
    Object.fromEntries(
        Object.entries(o).map(([k, v]) => [
            k,
            v instanceof Prisma.Decimal ? v.toFixed(2) : text(v as object),
        ]),
    ) as Text<T>;

export const ProfitSplitService = {
    async overview() {
        const [state, batches, done, latest, statements, balances, moves, accounts] =
            await Promise.all([
                fundState(prisma),
                undecided(prisma),
                prisma.profitSplit.findMany({
                    orderBy: { approved_at: "desc" },
                    include: {
                        batch: { select: { batch_code: true, actual_end_date: true } },
                        approved_by: { select: { name: true } },
                    },
                }),
                latestDecision(prisma),
                BatchPnlService.all(),
                balancesAt(new Date()),
                prisma.payment.findMany({
                    where: { split_move: { not: null } },
                    orderBy: [{ payment_date: "desc" }, { created_at: "desc" }],
                    take: 50,
                }),
                prisma.paymentInstrument.findMany({
                    where: { fund: { not: "OPERATING" }, is_active: true },
                    select: { id: true, fund: true, label: true },
                }),
            ]);
        const profitNow = new Map(statements.map((s) => [s.batch.id, D(s.net_profit).toFixed(2)]));
        const canSkip = done.every((d) => d.kind === "SKIPPED");
        return {
            ...text(state),
            accounts,
            defaults: getSplit(),
            spendable_cash: balances.operating_cash.minus(balances.payables).toFixed(2),
            not_in_batches: await notInBatches(latest?.approved_at ?? null),
            waiting: batches.map((b, i) => ({
                batch_id: b.id,
                batch_code: b.batch_code,
                ended_on: b.actual_end_date,
                net_profit: profitNow.get(b.id) ?? "0.00",
                can_decide: i === 0,
                can_skip: i === 0 && canSkip,
            })),
            done: done.map(({ batch, approved_by, ...d }) => ({
                ...d,
                batch_code: batch.batch_code,
                ended_on: batch.actual_end_date,
                approved_by: approved_by.name,
                profit_now: profitNow.get(d.batch_id) ?? "0.00",
                can_undo: d.id === latest?.id,
            })),
            moves,
        };
    },

    async decide(d: DecideInput) {
        const profit = await profitShown(d.batch_id, d.expected_profit);
        const s = getSplit();
        const p = d.pct ?? {
            reinvest: s.split_reinvest,
            reserve: s.split_reserve,
            owner: s.split_owner,
            tax: s.split_tax,
        };
        const pct = {
            reinvest: D(p.reinvest),
            reserve: D(p.reserve),
            owner: D(p.owner),
            tax: D(p.tax),
        };
        return locked((tx) =>
            decide(tx, { batch_id: d.batch_id, profit, pct, actor_id: d.actor_id }),
        );
    },

    async skip(d: SkipInput) {
        const profit = D((await BatchPnlService.statement(d.batch_id)).net_profit);
        return locked((tx) => skip(tx, { ...d, profit }));
    },

    undo: (id: string, d: ReasonInput) => locked((tx) => undo(tx, { id, ...d })),
    move: (d: MoveInput) => locked((tx) => move(tx, d)),
    removeMove: (payment_id: string, d: ReasonInput) =>
        locked((tx) => removeMove(tx, { payment_id, ...d })),
};
