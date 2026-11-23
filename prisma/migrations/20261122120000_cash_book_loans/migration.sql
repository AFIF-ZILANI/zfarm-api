-- CreateEnum
CREATE TYPE "LoanPurpose" AS ENUM ('BATCH', 'FARM', 'LOSS', 'OLD_DEBT');

-- CreateEnum
CREATE TYPE "LoanTerms" AS ENUM ('EMI', 'FLAT', 'NONE');

-- CreateEnum
CREATE TYPE "LoanFrequency" AS ENUM ('MONTHLY', 'WEEKLY', 'ONE_OFF');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentRefType" ADD VALUE 'LOAN';
ALTER TYPE "PaymentRefType" ADD VALUE 'OWNER_CAPITAL';
ALTER TYPE "PaymentRefType" ADD VALUE 'OWNER_DRAW';
ALTER TYPE "PaymentRefType" ADD VALUE 'OTHER_IN';
ALTER TYPE "PaymentRefType" ADD VALUE 'OTHER_OUT';
ALTER TYPE "PaymentRefType" ADD VALUE 'TRANSFER';

-- AlterTable
ALTER TABLE "Expense" ADD COLUMN     "loan_id" TEXT;

-- CreateTable
CREATE TABLE "Loan" (
    "id" TEXT NOT NULL,
    "lender" TEXT NOT NULL,
    "purpose" "LoanPurpose" NOT NULL,
    "batch_id" TEXT,
    "principal" DECIMAL(12,2) NOT NULL,
    "terms" "LoanTerms" NOT NULL,
    "annual_rate" DECIMAL(6,3),
    "total_payable" DECIMAL(12,2) NOT NULL,
    "installment_amount" DECIMAL(12,2) NOT NULL,
    "installment_count" INTEGER NOT NULL,
    "frequency" "LoanFrequency" NOT NULL,
    "first_due_on" TIMESTAMP(3) NOT NULL,
    "received_on" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "recorded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Loan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Loan_batch_id_idx" ON "Loan"("batch_id");

-- CreateIndex
CREATE INDEX "Expense_loan_id_idx" ON "Expense"("loan_id");

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_loan_id_fkey" FOREIGN KEY ("loan_id") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "Profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written ─────────────────────────────────────────────────────────────
-- ref_type is compared as text: a value added above can't be used as an enum literal in the same
-- transaction.

-- One farm account per payment on the side the money moved -- except a TRANSFER between two of the
-- farm's own accounts, which names both (and two different ones).
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_one_farm_account";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_one_farm_account" CHECK (
  ("ref_type"::text = 'TRANSFER' AND "from_instrument_id" IS NOT NULL AND "to_instrument_id" IS NOT NULL
     AND "from_instrument_id" <> "to_instrument_id")
  OR ("ref_type"::text <> 'TRANSFER' AND (
        ("direction" = 'INCOMING' AND "to_instrument_id" IS NOT NULL AND "from_instrument_id" IS NULL)
     OR ("direction" = 'OUTGOING' AND "from_instrument_id" IS NOT NULL AND "to_instrument_id" IS NULL)))
);

ALTER TABLE "Loan" ADD CONSTRAINT "Loan_batch_iff_batch_purpose"
  CHECK (("purpose" = 'BATCH') = ("batch_id" IS NOT NULL));
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_amounts_sane" CHECK (
  "principal" > 0 AND "total_payable" >= "principal" AND "installment_amount" > 0 AND "installment_count" > 0
);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_rate_iff_emi"
  CHECK (("terms" = 'EMI') = ("annual_rate" IS NOT NULL));

-- Interest is the only part of a loan that is a cost; its rows carry the loan they belong to.
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_interest_has_loan"
  CHECK (("category" = 'LOAN_INTEREST') = ("loan_id" IS NOT NULL));

INSERT INTO "ExpenseCategoryLookup" ("id", "code", "label", "is_active", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'LOAN_INTEREST', 'Loan interest', true, NOW(), NOW())
ON CONFLICT ("code") DO NOTHING;
