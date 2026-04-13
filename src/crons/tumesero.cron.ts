import cron from "node-cron";
import { tumeseroService, getTodayEcuador } from "../services/tumesero.service";

const BOLONCITY_WORKSPACE_ID = "69bdadc67386136fc3682734";

export function initTumeserooCron() {
  // 11PM Ecuador (UTC-5) = 04:00 UTC the next calendar day
  // cron: minute hour * * *
  cron.schedule("0 4 * * *", async () => {
    console.log("[TumeseroeCron] Running daily sales sync for Boloncity...");
    await runDailySalesSync();
  });

  console.log("[TumeseroeCron] Daily Tumesero sync cron initialized (11PM Ecuador / 04:00 UTC).");
}

async function runDailySalesSync() {
  try {
    const today = getTodayEcuador();
    console.log(`[TumeseroeCron] Syncing sales for date: ${today}`);

    const result = await tumeseroService.syncDailyData(BOLONCITY_WORKSPACE_ID, today);

    console.log(
      `[TumeseroeCron] Sync complete — ` +
        `Sessions: ${result.totalSessions}, Orders: ${result.totalOrders}, ` +
        `Conversion: ${result.conversionRate}%, Revenue: $${result.totalRevenue}. ` +
        `API calls today: ${result.apiCallsUsedToday}/${50}`
    );
  } catch (error: any) {
    console.error("[TumeseroeCron] Error during daily sales sync:", error.message);
  }
}
