-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "PaymentRefType" ADD VALUE 'SUPPLIER_OPENING';
ALTER TYPE "PaymentRefType" ADD VALUE 'SUPPLIER_ADVANCE';

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "supplier_payment_id" TEXT;

-- AlterTable
ALTER TABLE "Suppliers" ADD COLUMN     "opening_date" TIMESTAMP(3),
ADD COLUMN     "opening_due" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "opening_note" TEXT;

-- CreateTable
CREATE TABLE "SupplierPayment" (
    "id" TEXT NOT NULL,
    "supplier_id" TEXT NOT NULL,
    "direction" "PaymentType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL,
    "instrument_id" TEXT NOT NULL,
    "transaction_ref" TEXT,
    "note" TEXT,
    "recorded_by_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SupplierPayment_supplier_id_payment_date_idx" ON "SupplierPayment"("supplier_id", "payment_date");

-- CreateIndex
CREATE INDEX "Payment_supplier_payment_id_idx" ON "Payment"("supplier_payment_id");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_supplier_payment_id_fkey" FOREIGN KEY ("supplier_payment_id") REFERENCES "SupplierPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "Suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_instrument_id_fkey" FOREIGN KEY ("instrument_id") REFERENCES "PaymentInstrument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_recorded_by_id_fkey" FOREIGN KEY ("recorded_by_id") REFERENCES "Profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Hand-written ── ref_type as text: a value added above can't be an enum literal in this transaction.
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_supplier_kind_has_group" CHECK (
  "ref_type"::text NOT IN ('SUPPLIER_OPENING', 'SUPPLIER_ADVANCE') OR "supplier_payment_id" IS NOT NULL
);
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "Suppliers" ADD CONSTRAINT "Suppliers_opening_sane" CHECK (
  "opening_due" >= 0 AND ("opening_due" = 0 OR "opening_date" IS NOT NULL)
);
