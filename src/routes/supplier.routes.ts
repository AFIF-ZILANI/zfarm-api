import { Hono } from "hono";
import { zValidatorRfc7807 } from "@lib/validator";
import { SupplierController } from "@controllers/supplier.controller";
import { SupplierPaymentController } from "@controllers/supplier-payment.controller";
import {
    openingSchema,
    payInput,
    refundSchema,
    removePaymentSchema,
    statementQuerySchema,
    useAdvanceSchema,
} from "@validators/supplier-payment.validator";
import {
    createSupplierSchema,
    updateSupplierSchema,
    listSuppliersQuerySchema,
} from "@validators/supplier.validator";

export const supplierRoutes = new Hono();

supplierRoutes.get(
    "/",
    zValidatorRfc7807("query", listSuppliersQuerySchema),
    SupplierController.getAll,
);
// Before /:id, which would take "balances" for an id.
supplierRoutes.get("/balances", SupplierPaymentController.balances);
supplierRoutes.get("/:id", SupplierController.getById);
supplierRoutes.post(
    "/",
    zValidatorRfc7807("json", createSupplierSchema),
    SupplierController.create,
);
supplierRoutes.patch(
    "/:id",
    zValidatorRfc7807("json", updateSupplierSchema),
    SupplierController.update,
);
supplierRoutes.post("/:id/deactivate", SupplierController.deactivate);
supplierRoutes.post("/:id/reactivate", SupplierController.reactivate);

// Money with the supplier -- admin only: no employee rule in lib/permissions.ts names /suppliers.
supplierRoutes.get("/:id/dues", SupplierPaymentController.dues);
supplierRoutes.get(
    "/:id/statement",
    zValidatorRfc7807("query", statementQuerySchema),
    SupplierPaymentController.statement,
);
supplierRoutes.post(
    "/:id/payments",
    zValidatorRfc7807("json", payInput),
    SupplierPaymentController.pay,
);
supplierRoutes.post(
    "/:id/payments/:paymentId/remove",
    zValidatorRfc7807("json", removePaymentSchema),
    SupplierPaymentController.remove,
);
supplierRoutes.post(
    "/:id/use-advance",
    zValidatorRfc7807("json", useAdvanceSchema),
    SupplierPaymentController.useAdvance,
);
supplierRoutes.post(
    "/:id/refunds",
    zValidatorRfc7807("json", refundSchema),
    SupplierPaymentController.refund,
);
supplierRoutes.patch(
    "/:id/opening",
    zValidatorRfc7807("json", openingSchema),
    SupplierPaymentController.setOpening,
);
