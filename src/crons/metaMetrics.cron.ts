import cron from "node-cron";
import { VideoPlanningService } from "../services/videoPlanning.service";

const videoPlanningService = new VideoPlanningService();

/** How far back to re-sync. Older posts barely move and cost quota. */
export const METRICS_WINDOW_DAYS = 90;

export async function runMetaMetricsSync() {
  console.log("[MetaMetricsCron] Starting daily video metrics sync...");
  const result = await videoPlanningService.syncRecentMetrics({
    windowDays: METRICS_WINDOW_DAYS,
  });
  console.log(
    `[MetaMetricsCron] Done — scanned: ${result.scanned}, synced: ${result.synced}, failed: ${result.failed}`
  );
  return result;
}

export function initMetaMetricsCrons() {
  // 12AM Ecuador (UTC-5) = 05:00 UTC. 04:00 and 04:15 are already taken by the
  // Tumesero and Florinda syncs.
  cron.schedule("0 5 * * *", async () => {
    try {
      await runMetaMetricsSync();
    } catch (err: any) {
      console.error("[MetaMetricsCron] Sync failed:", err.message);
    }
  });

  console.log(
    "[MetaMetricsCron] Daily video metrics sync registered at 05:00 UTC (12AM Ecuador)."
  );
}
