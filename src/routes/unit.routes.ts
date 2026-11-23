import { Hono } from "hono";
import prisma from "@lib/db";
import { zValidatorRfc7807 } from "@lib/validator";
import { createLookupService, createLookupController } from "@lib/lookup-factory";
import { UnitController } from "@controllers/unit.controller";
import { createUnitSchema, updateUnitSchema, listLookupQuerySchema } from "@validators/lookup.validator";

const service = createLookupService(prisma.unit, "Unit");
const controller = createLookupController(service);

export const unitRoutes = new Hono();

unitRoutes.get("/", zValidatorRfc7807("query", listLookupQuerySchema), controller.getAll);
unitRoutes.post("/", zValidatorRfc7807("json", createUnitSchema), UnitController.create);
unitRoutes.patch("/:id", zValidatorRfc7807("json", updateUnitSchema), UnitController.update);
unitRoutes.post("/:id/deactivate", controller.deactivate);
unitRoutes.post("/:id/reactivate", controller.reactivate);
unitRoutes.delete("/:id", controller.remove);
