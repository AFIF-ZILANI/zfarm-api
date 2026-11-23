import type { Context } from "hono";
import { getActorId } from "@lib/current-actor";
import { withHandler } from "@lib/helper";
import { sendSuccess } from "@lib/response";
import { getValid } from "@lib/valid";
import { ProfitSplitService } from "@services/profit-split.service";
import type {
    DecideInput,
    MoveInput,
    ReasonInput,
    SkipInput,
} from "@validators/profit-split.validator";

/** The validated body, stamped with who sent it. */
const body = async <T extends { actor_id: string }>(c: Context) =>
    ({ ...getValid<T>(c, "json"), actor_id: await getActorId(c) }) as T;
const param = (c: Context, name: string) => c.req.param(name) ?? "";

export const ProfitSplitController = {
    async overview(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(c, await ProfitSplitService.overview(), "Profit split fetched"),
        );
    },
    async decide(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(
                c,
                await ProfitSplitService.decide(await body<DecideInput>(c)),
                "Batch decided",
                201,
            ),
        );
    },
    async skip(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(
                c,
                await ProfitSplitService.skip(await body<SkipInput>(c)),
                "Batch skipped",
                201,
            ),
        );
    },
    async undo(c: Context) {
        return withHandler(c, async () => {
            await ProfitSplitService.undo(param(c, "id"), await body<ReasonInput>(c));
            return sendSuccess(c, null, "Decision undone");
        });
    },
    async move(c: Context) {
        return withHandler(c, async () =>
            sendSuccess(
                c,
                await ProfitSplitService.move(await body<MoveInput>(c)),
                "Move recorded",
                201,
            ),
        );
    },
    async removeMove(c: Context) {
        return withHandler(c, async () => {
            await ProfitSplitService.removeMove(param(c, "paymentId"), await body<ReasonInput>(c));
            return sendSuccess(c, null, "Move removed");
        });
    },
};
