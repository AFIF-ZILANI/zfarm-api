import type { Context } from "hono";
import { UnitService } from "@services/unit.service";
import { withHandler } from "@lib/helper";
import { sendSuccess } from "@lib/response";
import { getValid } from "@lib/valid";
import type { CreateUnitInput, UpdateUnitInput } from "@validators/lookup.validator";

export const UnitController = {
    async create(c: Context) {
        return withHandler(c, async () => {
            const row = await UnitService.create(getValid<CreateUnitInput>(c, "json"));
            return sendSuccess(c, row, "Created", 201);
        });
    },

    async update(c: Context) {
        return withHandler(c, async () => {
            const { label } = getValid<UpdateUnitInput>(c, "json");
            const row = await UnitService.update(c.req.param("id") ?? "", label);
            return sendSuccess(c, row, "Updated");
        });
    },
};
