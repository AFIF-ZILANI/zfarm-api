import { z } from "zod";

const percent = z.number().min(0).max(100).multipleOf(0.01, "Use at most two decimals");

export const updateFarmSettingsSchema = z.object({
    // The four go together: three shares of a profit that make 100, and the tax inside the reserve.
    split_reinvest: percent.optional(),
    split_reserve: percent.optional(),
    split_owner: percent.optional(),
    split_tax: percent.optional(),
    // Past 06:00 a stored date (midnight UTC = 06:00 Dhaka) would slip to the day before; see farm-day.ts.
    day_start_hour: z.coerce
        .number()
        .int()
        .min(0)
        .max(6, "The farm day must start between midnight and 06:00")
        .optional(),
    // Days a sold batch stays open for late costs/income before it is finalised.
    settlement_days: z.coerce.number().int().min(0).max(60, "Keep the settlement window to 60 days or less").optional(),
}).superRefine((d, ctx) => {
    const p = [d.split_reinvest, d.split_reserve, d.split_owner, d.split_tax];
    if (p.every((x) => x === undefined)) return;
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    const [reinvest, reserve, owner, tax] = p;
    if (reinvest === undefined || reserve === undefined || owner === undefined || tax === undefined)
        return issue("split_reinvest", "Send all four percentages");
    if (Math.round((reinvest + reserve + owner) * 100) !== 10_000)
        issue("split_reinvest", "The three shares must add up to 100");
    if (tax > reserve) issue("split_tax", "Tax is part of the reserve, so it can't be more");
});

export type UpdateFarmSettingsInput = z.infer<typeof updateFarmSettingsSchema>;
