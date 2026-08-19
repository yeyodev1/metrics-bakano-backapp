import { Router, Request, Response } from "express";
import { tumeseroService, getTodayEcuador } from "../services/tumesero.service";
import { florindaSalesService, FLORINDA_WORKSPACE_ID } from "../services/florindaSales.service";
import { runMetaMetricsSync } from "../crons/metaMetrics.cron";

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
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    if ((from || to) && (!from || !to || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)) {
      res.status(400).json({ ok: false, error: "Use from y to válidos en formato YYYY-MM-DD." });
      return;
    }
    const result = from && to
      ? await florindaSalesService.syncRange(FLORINDA_WORKSPACE_ID, from, to)
      : await florindaSalesService.syncAll();
    console.log(`[Cron] Florinda sales sync OK: ${result.daysSynced} days, ${result.lineItems} lines`);
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error("[Cron] Florinda sales sync failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/cron/meta-metrics-sync
// Called by Vercel Cron Jobs at 05:00 UTC (= 12AM Ecuador) every day.
// Snapshots each linked video's Instagram/Facebook/Ads metrics for the day so
// the Pareto engine can compare videos age-normalized.
cronRouter.get("/meta-metrics-sync", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const result = await runMetaMetricsSync();
    res.json({ ok: true, result });
  } catch (err: any) {
    console.error("[Cron] Meta metrics sync failed:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/cron/video-review-reminders
// Vercel Cron cada 4 horas: insiste a los clientes con videos editados sin
// revisar. Un recordatorio por ciclo abierto, y solo si el ultimo aviso
// tiene mas de 4 horas — asi el disparo manual del equipo tambien resetea
// la cuenta y el cliente no recibe dos seguidos.
cronRouter.get("/video-review-reminders", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { videoReviewNotificationService } = await import(
      "../services/videoReviewNotification.service"
    );
    const result = await videoReviewNotificationService.recordatorios();
    console.log(
      `[Cron] Recordatorios de revision: ${result.enviados}/${result.revisados} enviados` +
        (result.errores.length ? ` — errores: ${result.errores.join(" | ")}` : "")
    );
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[Cron] Recordatorios de revision fallaron:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default cronRouter;
