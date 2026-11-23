-- CreateEnum
CREATE TYPE "Fund" AS ENUM ('OPERATING', 'REINVEST', 'RESERVE');

-- CreateEnum
CREATE TYPE "SplitKind" AS ENUM ('PROFIT', 'LOSS', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SplitMove" AS ENUM ('TO_REINVEST', 'TO_RESERVE', 'FROM_RESERVE');

-- AlterEnum
ALTER TYPE "PaymentRefType" ADD VALUE 'TAX_PAID';

-- AlterTable
ALTER TABLE "FarmSettings" ADD COLUMN     "split_owner" DECIMAL(5,2) NOT NULL DEFAULT 20,
ADD COLUMN     "split_reinvest" DECIMAL(5,2) NOT NULL DEFAULT 50,
ADD COLUMN     "split_reserve" DECIMAL(5,2) NOT NULL DEFAULT 30,
ADD COLUMN     "split_tax" DECIMAL(5,2) NOT NULL DEFAULT 10;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "split_move" "SplitMove";

-- AlterTable
ALTER TABLE "PaymentInstrument" ADD COLUMN     "fund" "Fund" NOT NULL DEFAULT 'OPERATING';

-- CreateTable
CREATE TABLE "ProfitSplit" (
    "id" TEXT NOT NULL,
    "batch_id" TEXT NOT NULL,
    "kind" "SplitKind" NOT NULL,
    "net_profit" DECIMAL(12,2) NOT NULL,
    "recovered" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pct_reinvest" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "pct_reserve" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "pct_owner" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "pct_tax" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "reinvest" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reserve" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "owner" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "principal_taken" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "loss_covered" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "approved_by_id" TEXT NOT NULL,
    "approved_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfitSplit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProfitSplit_batch_id_key" ON "ProfitSplit"("batch_id");

-- CreateIndex
CREATE INDEX "ProfitSplit_approved_at_idx" ON "ProfitSplit"("approved_at");

-- AddForeignKey
ALTER TABLE "ProfitSplit" ADD CONSTRAINT "ProfitSplit_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "Batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfitSplit" ADD CONSTRAINT "ProfitSplit_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "Profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ── Hand-written ── ref_type as text: a value added above can't be an enum literal in this transaction.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_split_move_is_transfer"
  CHECK ("split_move" IS NULL OR "ref_type"::text = 'TRANSFER');
-- The reinvestment and the reserve money each sit in one account at a time.
-- An expression index, not a partial one: Prisma would see a partial index as drift and drop it next time.
CREATE UNIQUE INDEX "PaymentInstrument_one_active_fund" ON "PaymentInstrument"
  ((CASE WHEN "is_active" AND "fund" <> 'OPERATING' THEN "fund" END));
ALTER TABLE "ProfitSplit" ADD CONSTRAINT "ProfitSplit_parts_add_up" CHECK (
  "kind" <> 'PROFIT' OR (
    "net_profit" >= 0 AND "recovered" >= 0 AND "reinvest" >= 0 AND "reserve" >= 0 AND "owner" >= 0
    AND "reinvest" + "reserve" + "owner" = "net_profit" - "recovered"
    AND "pct_reinvest" + "pct_reserve" + "pct_owner" = 100
    AND "tax" >= 0 AND "tax" <= "reserve" AND "pct_tax" <= "pct_reserve"
    AND "principal_taken" >= 0 AND "principal_taken" <= "reinvest" AND "loss_covered" = 0
  )
);
ALTER TABLE "ProfitSplit" ADD CONSTRAINT "ProfitSplit_loss_sane" CHECK (
  "kind" <> 'LOSS' OR (
    "net_profit" < 0 AND "loss_covered" >= 0 AND "loss_covered" <= -"net_profit"
    AND "reinvest" = 0 AND "reserve" = 0 AND "owner" = 0 AND "tax" = 0 AND "recovered" = 0 AND "principal_taken" = 0
  )
);
ALTER TABLE "ProfitSplit" ADD CONSTRAINT "ProfitSplit_skip_has_reason" CHECK (
  "kind" <> 'SKIPPED' OR (
    "reason" IS NOT NULL AND "reinvest" = 0 AND "reserve" = 0 AND "owner" = 0 AND "tax" = 0
    AND "recovered" = 0 AND "principal_taken" = 0 AND "loss_covered" = 0
  )
);
ALTER TABLE "FarmSettings" ADD CONSTRAINT "FarmSettings_split_sums" CHECK (
  "split_reinvest" >= 0 AND "split_reserve" >= 0 AND "split_owner" >= 0 AND "split_tax" >= 0
  AND "split_reinvest" + "split_reserve" + "split_owner" = 100 AND "split_tax" <= "split_reserve"
);
