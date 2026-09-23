import { Router, Request, Response } from "express";
import { tumeseroService, getTodayEcuador } from "../services/tumesero.service";
import { florindaSalesService, FLORINDA_WORKSPACE_ID } from "../services/florindaSales.service";
import { runMetaMetricsSync } from "../crons/metaMetrics.cron";

const cronRouter = Router();

// GET /api/cron/facturacion-telegram — una vez al dia (14:10 UTC = 09:10 Ecuador).
// Le recuerda por el chat a cada cliente que no registro su facturacion, y a
// los 3 dias seguidos avisa al equipo. Solo clientes: los chats del equipo
// interno no reciben nada.
cronRouter.get("/facturacion-telegram", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { recordatorioFacturacionService } = await import("../services/recordatorioFacturacion.service");
    const r = await recordatorioFacturacionService.enviarRecordatorios();
    console.log(`[Cron] Facturación — avisados: ${r.avisados}, escalados: ${r.escalados} · ${r.detalle.join(" | ")}`);
    res.status(200).json(r);
  } catch (error: any) {
    console.error("[Cron] Facturación:", error?.message || error);
    res.status(500).json({ error: error?.message || "error" });
  }
});

// GET /api/cron/onboarding-sync — cada 30 min.
// Marca las sesiones de onboarding que el cliente agendo por el link del CRM
// y manda el correo de arranque de los entornos nuevos.
cronRouter.get("/onboarding-sync", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const { onboardingBotService } = await import("../services/onboardingBot.service");
    const [sync, bienvenidas] = await Promise.all([
      onboardingBotService.sincronizarDesdeCrm(),
      onboardingBotService.enviarBienvenidasPendientes(),
    ]);
    console.log(
      `[Cron] Onboarding — citas revisadas: ${sync.revisadas}, marcadas: ${sync.marcadas}, ` +
        `cumplidas desde el CRM: ${sync.cumplidas}, bienvenidas: ${bienvenidas.enviadas}, ` +
        `sin entorno: ${sync.sinResolver.length}`
    );
    // El cron corre cada 30 min; el digest de las que no se pudieron asociar
    // sale UNA vez al día (13:10 UTC = 08:10 en Ecuador) para no ser ruido.
    const ahora = new Date();
    if (ahora.getUTCHours() === 13 && ahora.getUTCMinutes() < 30 && sync.sinResolver.length) {
      await onboardingBotService.avisarSesionesSinEntorno(sync.sinResolver);
    }
    res.json({ ok: true, sync, bienvenidas });
  } catch (err: any) {
    console.error("[Cron] Onboarding sync falló:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

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

// GET /api/cron/monthly-target-reminders
// Vercel Cron 13:00 UTC (= 8AM Ecuador) cada dia
// laborable: avisa al equipo asignado de cada cliente si falta la meta del mes,
// si el ritmo va atrasado o si nadie registra facturacion.
cronRouter.get("/monthly-target-reminders", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { internalPulseService } = await import("../services/internalPulse.service");
    const result = await internalPulseService.runTargetReminders({ sendEmail: true });
    console.log(
      `[Cron] Recordatorios de meta mensual: ${result.alerted.length}/${result.reviewed} clientes avisados`
    );
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[Cron] Recordatorios de meta mensual fallaron:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/cron/ghl-production-sync
// Vercel Cron cada 30 min: reconcilia el Planificador con los calendarios de
// produccion del CRM. El webhook es el camino rapido; esto cubre los que no
// llegaron (citas movidas o borradas sin disparar el workflow).
cronRouter.get("/ghl-production-sync", async (req: Request, res: Response) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers["authorization"] !== `Bearer ${secret}`) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  try {
    const { crmProductionSyncService } = await import("../services/crmProductionSync.service");
    const result = await crmProductionSyncService.sincronizarDesdeCrm();
    if (result.omitido) {
      console.log(`[Cron] Sync producciones CRM omitido: ${result.omitido}`);
    } else {
      console.log(
        `[Cron] Sync producciones CRM: ${result.revisadas} revisadas, ${result.creadas} creadas, ` +
          `${result.reprogramadas} reprogramadas, ${result.canceladas} canceladas, ${result.sinEntorno} sin entorno` +
          (result.errores.length ? ` — errores: ${result.errores.join(" | ")}` : "")
      );
    }
    res.json({ ok: true, ...result });
  } catch (err: any) {
    console.error("[Cron] Sync producciones CRM falló:", err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default cronRouter;
