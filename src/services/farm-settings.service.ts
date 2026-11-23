import prisma from "@lib/db";
import { audit } from "@lib/audit";
import { getDayStartHour, setDayStartHour } from "@lib/farm-day";
import type { UpdateFarmSettingsInput } from "@validators/farm-settings.validator";

// Held in memory next to the day-start hour; loaded at boot, replaced on save.
let settlementDays = 7;
export const getSettlementDays = (): number => settlementDays;

const SPLIT = ["split_reinvest", "split_reserve", "split_owner", "split_tax"] as const;
type Split = Record<(typeof SPLIT)[number], number>;
let split: Split = { split_reinvest: 50, split_reserve: 30, split_owner: 20, split_tax: 10 };
/** The default shares of a batch's profit, in percent. */
export const getSplit = (): Split => split;
const splitOf = (row: { [K in keyof Split]: { toNumber(): number } }): Split =>
    Object.fromEntries(SPLIT.map((k) => [k, row[k].toNumber()])) as Split;

export const FarmSettingsService = {
    get() {
        return { day_start_hour: getDayStartHour(), settlement_days: settlementDays, ...split };
    },

    /** Read the stored settings into memory; called once at boot. The row is seeded by its migration. */
    async load() {
        const row = await prisma.farmSettings.findUnique({ where: { id: 1 } });
        if (row) {
            setDayStartHour(row.day_start_hour);
            settlementDays = row.settlement_days;
            split = splitOf(row);
        }
    },

    async update(data: UpdateFarmSettingsInput, actorId: string) {
        const before = this.get();
        const changes = {
            ...(data.day_start_hour !== undefined && { day_start_hour: data.day_start_hour }),
            ...(data.settlement_days !== undefined && { settlement_days: data.settlement_days }),
            ...Object.fromEntries(SPLIT.filter((k) => data[k] !== undefined).map((k) => [k, data[k]!])),
        };
        const notes = [
            data.day_start_hour !== undefined &&
                data.day_start_hour !== before.day_start_hour &&
                `Farm day start changed from ${before.day_start_hour}:00 to ${data.day_start_hour}:00`,
            data.settlement_days !== undefined &&
                data.settlement_days !== before.settlement_days &&
                `Settlement window changed from ${before.settlement_days} to ${data.settlement_days} days`,
            SPLIT.some((k) => data[k] !== undefined && data[k] !== before[k]) &&
                `Profit split changed to ${SPLIT.map((k) => data[k]).join(" / ")} (reinvest / reserve / owner / tax)`,
        ].filter(Boolean);
        const [row] = await prisma.$transaction([
            prisma.farmSettings.upsert({ where: { id: 1 }, create: { id: 1, ...changes }, update: changes }),
            audit(prisma, {
                table: "FarmSettings",
                record_id: "1",
                action: "UPDATE",
                actor_id: actorId,
                note: notes.join("; ") || "Farm settings saved",
                before,
                after: changes,
            }),
        ]);
        setDayStartHour(row.day_start_hour);
        settlementDays = row.settlement_days;
        split = splitOf(row);
        return this.get();
    },
};
