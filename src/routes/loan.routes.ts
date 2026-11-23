import { Hono } from "hono";
import { zValidatorRfc7807 } from "@lib/validator";
import { LoanController } from "@controllers/loan.controller";
import { createLoanSchema, payInstallmentSchema } from "@validators/loan.validator";

// Admin only: no employee rule in lib/permissions.ts names /loans.
export const loanRoutes = new Hono();

loanRoutes.get("/", LoanController.getAll);
loanRoutes.get("/:id", LoanController.getById);
loanRoutes.post("/", zValidatorRfc7807("json", createLoanSchema), LoanController.create);
loanRoutes.post(
    "/:id/installments",
    zValidatorRfc7807("json", payInstallmentSchema),
    LoanController.payInstallment,
);
loanRoutes.delete("/:id", LoanController.remove);
