import prisma from "@lib/db";
import { AppError } from "@lib/app-error";
import { audit } from "@lib/audit";
import { assertBatchOpen } from "@lib/batch-guards";
import { LOAN_INTEREST } from "@lib/paid-at-create";
import { handlePrismaWriteError } from "@lib/prisma-errors";
import { writeExpense } from "@services/expense.service";
import { writePayment } from "@services/payment.service";
import { Prisma } from "../../prisma/generated/prisma/client";
import type { CreateLoanInput, PayInstallmentInput } from "@validators/loan.validator";

/**
 * Money the farm owes a lender (docs/profit-allocation.md for why it matters to the split).
 *
 * Principal is never a cost; only interest is, as an Expense LOAN_INTEREST tied to the loan:
 *   - BATCH loan: the whole scheduled interest, DIRECT on that batch, booked once when recorded --
 *     installments often run past the batch's CLOSED date, and CLOSED refuses new cost rows.
 *   - FARM / LOSS / OLD_DEBT: each installment's interest part, SHARED_PERIOD on its payment date, so
 *     the shared-cost split spreads it over the batches running then by bird-days.
 *
 * The money borrowed is an INCOMING Payment (ref LOAN) into the account named; an old debt has none.
 * Installments are OUTGOING Payments (ref LOAN) through writePayment, which refuses an overpayment.
 */

const D = (v: Prisma.Decimal | number | string | null | undefined) => new Prisma.Decimal(v ?? 0);
const money = (d: Prisma.Decimal) => d.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
const PERIODS_PER_YEAR = { MONTHLY: 12, WEEKLY: 52 } as const;

/** The repayment schedule's totals from the loan's terms. */
export function loanSchedule(d: {
    principal: number;
    terms: "EMI" | "FLAT" | "NONE";
    annual_rate?: number | undefined;
    total_payable?: number | undefined;
    installment_count: number;
    frequency: "MONTHLY" | "WEEKLY" | "ONE_OFF";
}) {
    const p = D(d.principal);
    const n = d.installment_count;
    if (d.terms === "EMI") {
        // Reducing-balance EMI: P*r / (1 - (1+r)^-n), r the rate per installment period.
        const r = D(d.annual_rate!)
            .dividedBy(100)
            .dividedBy(PERIODS_PER_YEAR[d.frequency as "MONTHLY" | "WEEKLY"]);
        const installment = money(p.times(r).dividedBy(D(1).minus(D(1).plus(r).pow(-n))));
        return { installment_amount: installment, total_payable: installment.times(n) };
    }
    const total = d.terms === "FLAT" ? D(d.total_payable!) : p;
    // ponytail: rounded per installment; the last one is simply whatever is left.
    return { installment_amount: money(total.dividedBy(n)), total_payable: total };
}

/** Date of installment number k (0-based). */
function dueOn(first: Date, frequency: string, k: number) {
    const d = new Date(first);
    if (frequency === "MONTHLY") d.setUTCMonth(d.getUTCMonth() + k);
    else if (frequency === "WEEKLY") d.setUTCDate(d.getUTCDate() + 7 * k);
    return d;
}

type LoanRow = Prisma.LoanGetPayload<{ include: { batch: { select: { batch_code: true } } } }>;

/** Paid, left and the next due date, from what has been repaid so far. */
function withStanding(loan: LoanRow, paid: Prisma.Decimal, interest: Prisma.Decimal) {
    const left = D(loan.total_payable).minus(paid);
    // Installments covered so far; the next one is due after them.
    const covered = Math.floor(paid.dividedBy(loan.installment_amount).toNumber() + 1e-9);
    return {
        ...loan,
        paid: paid.toFixed(2),
        left: left.toFixed(2),
        interest_total: D(loan.total_payable).minus(loan.principal).toFixed(2),
        interest_booked: interest.toFixed(2),
        next_due_on: left.greaterThan(0)
            ? dueOn(
                  loan.first_due_on,
                  loan.frequency,
                  Math.min(covered, loan.installment_count - 1),
              )
            : null,
    };
}

async function standing(loans: LoanRow[]) {
    const ids = loans.map((l) => l.id);
    const [paid, interest] = await Promise.all([
        prisma.payment.groupBy({
            by: ["ref_id"],
            where: { ref_type: "LOAN", direction: "OUTGOING", ref_id: { in: ids } },
            _sum: { amount: true },
        }),
        prisma.expense.groupBy({
            by: ["loan_id"],
            where: { loan_id: { in: ids } },
            _sum: { amount: true },
        }),
    ]);
    const paidBy = new Map(paid.map((p) => [p.ref_id, D(p._sum.amount)]));
    const interestBy = new Map(interest.map((e) => [e.loan_id, D(e._sum.amount)]));
    return loans.map((l) =>
        withStanding(l, paidBy.get(l.id) ?? D(0), interestBy.get(l.id) ?? D(0)),
    );
}

const includeBatch = { batch: { select: { batch_code: true } } } as const;

export const LoanService = {
    /** Every loan, open ones first (few rows: unpaginated). */
    async getAll() {
        const loans = await prisma.loan.findMany({
            include: includeBatch,
            orderBy: { received_on: "desc" },
        });
        const rows = await standing(loans);
        return rows.sort(
            (a, b) => Number(D(b.left).greaterThan(0)) - Number(D(a.left).greaterThan(0)),
        );
    },

    async getById(id: string) {
        const loan = await prisma.loan.findUnique({ where: { id }, include: includeBatch });
        if (!loan) throw AppError.notFound("Loan");
        const [[row], payments, interest] = await Promise.all([
            standing([loan]),
            prisma.payment.findMany({
                where: { ref_type: "LOAN", ref_id: id },
                orderBy: { payment_date: "desc" },
            }),
            prisma.expense.findMany({ where: { loan_id: id }, orderBy: { date: "desc" } }),
        ]);
        return { ...row!, payments, interest };
    },

    async create(data: CreateLoanInput) {
        const schedule = loanSchedule(data);
        try {
            return await prisma.$transaction(async (tx) => {
                if (data.batch_id !== undefined) await assertBatchOpen(tx, data.batch_id);
                const loan = await tx.loan.create({
                    data: {
                        lender: data.lender,
                        purpose: data.purpose,
                        principal: data.principal,
                        terms: data.terms,
                        total_payable: schedule.total_payable,
                        installment_amount: schedule.installment_amount,
                        installment_count: data.installment_count,
                        frequency: data.frequency,
                        first_due_on: data.first_due_on,
                        received_on: data.received_on,
                        recorded_by_id: data.recorded_by_id,
                        ...(data.batch_id !== undefined && { batch_id: data.batch_id }),
                        ...(data.annual_rate !== undefined && { annual_rate: data.annual_rate }),
                        ...(data.note !== undefined && { note: data.note }),
                    },
                });
                if (data.purpose !== "OLD_DEBT") {
                    const account = await tx.paymentInstrument.findUnique({
                        where: { id: data.to_instrument_id! },
                        select: { is_active: true, label: true },
                    });
                    if (!account) throw AppError.badRequest("The account named does not exist");
                    if (!account.is_active)
                        throw AppError.badRequest(
                            `${account.label} is inactive -- pick an active account`,
                        );
                    await tx.payment.create({
                        data: {
                            amount: data.principal,
                            payment_date: data.received_on,
                            direction: "INCOMING",
                            ref_type: "LOAN",
                            ref_id: loan.id,
                            to_instrument_id: data.to_instrument_id!,
                            handled_by_id: data.recorded_by_id,
                            note: `Loan from ${data.lender}`,
                            ...(data.transaction_ref !== undefined && {
                                transaction_ref: data.transaction_ref,
                            }),
                        },
                    });
                }
                const interest = schedule.total_payable.minus(data.principal);
                if (data.purpose === "BATCH" && interest.greaterThan(0)) {
                    await writeExpense(tx, {
                        category: LOAN_INTEREST,
                        cost_type: "DIRECT",
                        batch_id: data.batch_id!,
                        loan_id: loan.id,
                        amount: interest.toNumber(),
                        date: data.received_on,
                        remarks: `Interest on loan from ${data.lender}`,
                        recorded_by_id: data.recorded_by_id,
                    });
                }
                return loan;
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    /** An installment, and for a farm-wide loan its interest part as a shared cost of that day. */
    async payInstallment(id: string, data: PayInstallmentInput) {
        try {
            return await prisma.$transaction(async (tx) => {
                const loan = await tx.loan.findUnique({ where: { id } });
                if (!loan) throw AppError.notFound("Loan");
                if (loan.purpose === "BATCH" && data.interest !== undefined)
                    throw AppError.badRequest(
                        "A batch loan's interest was booked on its batch when the loan was recorded",
                    );
                const payment = await writePayment(tx, {
                    ref_type: "LOAN",
                    ref_id: id,
                    amount: data.amount,
                    payment_date: data.payment_date,
                    from_instrument_id: data.from_instrument_id,
                    handled_by_id: data.handled_by_id,
                    ...(data.transaction_ref !== undefined && {
                        transaction_ref: data.transaction_ref,
                    }),
                    ...(data.note !== undefined && { note: data.note }),
                });
                if (loan.purpose === "BATCH") return { payment, interest: "0.00" };

                // ponytail: default interest = the loan's interest share of every taka repaid -- exact for
                // FLAT, close for EMI (which front-loads interest). The statement's figure overrides it.
                const total = D(loan.total_payable);
                const interest =
                    data.interest !== undefined
                        ? money(D(data.interest))
                        : money(D(data.amount).times(total.minus(loan.principal)).dividedBy(total));
                if (interest.greaterThan(0)) {
                    await writeExpense(tx, {
                        category: LOAN_INTEREST,
                        cost_type: "SHARED_PERIOD",
                        loan_id: id,
                        amount: interest.toNumber(),
                        date: data.payment_date,
                        remarks: `Interest on loan from ${loan.lender}`,
                        recorded_by_id: data.handled_by_id,
                    });
                }
                return { payment, interest: interest.toFixed(2) };
            });
        } catch (err) {
            return handlePrismaWriteError(err);
        }
    },

    /** A loan recorded by mistake, before any installment: removed with its receipt and booked interest. */
    async remove(id: string, actor_id: string) {
        return prisma.$transaction(async (tx) => {
            const loan = await tx.loan.findUnique({ where: { id }, include: { expenses: true } });
            if (!loan) throw AppError.notFound("Loan");
            const installments = await tx.payment.count({
                where: { ref_type: "LOAN", ref_id: id, direction: "OUTGOING" },
            });
            if (installments > 0)
                throw AppError.conflict(
                    "Installments have been paid on this loan -- it can't be removed",
                );
            if (loan.batch_id) await assertBatchOpen(tx, loan.batch_id);
            const receipt = await tx.payment.findFirst({ where: { ref_type: "LOAN", ref_id: id } });
            await tx.payment.deleteMany({ where: { ref_type: "LOAN", ref_id: id } });
            await tx.expense.deleteMany({ where: { loan_id: id } });
            await tx.loan.delete({ where: { id } });
            await audit(tx, {
                table: "Loan",
                record_id: id,
                action: "DELETE",
                actor_id,
                note: `Removed loan from ${loan.lender}`,
                before: JSON.parse(JSON.stringify({ loan, receipt })),
            });
        });
    },
};
