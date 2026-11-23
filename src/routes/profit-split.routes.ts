import { Hono } from "hono";
import { zValidatorRfc7807 } from "@lib/validator";
import { ProfitSplitController } from "@controllers/profit-split.controller";
import {
    decideSchema,
    moveSchema,
    reasonSchema,
    skipSchema,
} from "@validators/profit-split.validator";

// Admin only: no employee rule in lib/permissions.ts names /profit-splits.
export const profitSplitRoutes = new Hono();

profitSplitRoutes.get("/", ProfitSplitController.overview);
profitSplitRoutes.post("/", zValidatorRfc7807("json", decideSchema), ProfitSplitController.decide);
profitSplitRoutes.post("/skip", zValidatorRfc7807("json", skipSchema), ProfitSplitController.skip);
profitSplitRoutes.post("/moves", zValidatorRfc7807("json", moveSchema), ProfitSplitController.move);
profitSplitRoutes.post(
    "/moves/:paymentId/remove",
    zValidatorRfc7807("json", reasonSchema),
    ProfitSplitController.removeMove,
);
profitSplitRoutes.post(
    "/:id/undo",
    zValidatorRfc7807("json", reasonSchema),
    ProfitSplitController.undo,
);
