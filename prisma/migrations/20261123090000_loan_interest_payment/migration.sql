-- Which installment a loan's interest row was part of. Null on a batch loan's up-front interest.
ALTER TABLE "Expense" ADD COLUMN "loan_payment_id" TEXT;
CREATE UNIQUE INDEX "Expense_loan_payment_id_key" ON "Expense"("loan_payment_id");
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_loan_payment_id_fkey" FOREIGN KEY ("loan_payment_id") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
