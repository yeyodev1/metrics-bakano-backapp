import { Router, Request, Response } from "express";
import { tumeseroService, getTodayEcuador } from "../services/tumesero.service";
import { florindaSalesService } from "../services/florindaSales.service";

const cronRouter = Router();

const BOLONCITY_WORKSPACE_ID = "69bdadc67386136fc3682734";

// GET /api/cron/tumesero-sync
// Called by Vercel Cron Jobs at 04:00 UTC (= 11PM Ecuador) every day.
// Vercel automatically sends: Authorization: Bearer $CRON_SECRET
cronRouter.get("/tumesero-sync", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  const authHeader = req.headers["authorization"];

  if (!secret || authHeader !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const today = getTodayEcuador();
  console.log(`[Cron] Tumesero daily sync triggered for ${today}`);

  try {
    const result = await tumeseroService.syncDailyData(BOLONCITY_WORKSPACE_ID, today);
    console.log(
      `[Cron] Sync OK — Sessions: ${result.totalSessions}, Orders: ${result.totalOrders}, ` +
        `Revenue: $${result.totalRevenue}. API calls today: ${result.apiCallsUsedToday}/50`
    );
    res.json({ ok: true, date: today, result });
  } catch (err: any) {
    console.error("[Cron] Tumesero sync failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

cronRouter.get("/florinda-sales-sync", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await florindaSalesService.syncCurrentYear();
    console.log(`[Cron] Florinda sales sync OK: ${result.daysSynced} days, ${result.lineItems} lines`);
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error("[Cron] Florinda sales sync failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default cronRouter;
