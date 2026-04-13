import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { tumeseroService, getTodayEcuador } from "../services/tumesero.service";
import { UserModel } from "../models/user.model";

const BOLONCITY_WORKSPACE_ID = "69bdadc67386136fc3682734";

function isBoloncityWorkspace(workspaceId: string): boolean {
  return workspaceId === BOLONCITY_WORKSPACE_ID;
}

/**
 * GET /api/sales-summary/:workspaceId/month?year=X&month=Y
 * Returns daily summaries + month aggregates for a workspace.
 */
export async function getMonthSummary(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);

    if (!isBoloncityWorkspace(workspaceId)) {
      res.status(403).json({ message: "Integración Tumesero no disponible para este workspace." });
      return;
    }

    const year = parseInt(String(req.query.year ?? "")) || new Date().getFullYear();
    const month = parseInt(String(req.query.month ?? "")) || new Date().getMonth() + 1;

    if (month < 1 || month > 12) {
      res.status(400).json({ message: "Mes inválido. Use 1-12." });
      return;
    }

    const data = await tumeseroService.getMonthSummary(workspaceId, year, month);
    res.json(data);
  } catch (error: any) {
    console.error("[SalesSummary] getMonthSummary error:", error.message);
    res.status(500).json({ message: error.message || "Error al obtener resumen mensual." });
  }
}

/**
 * POST /api/sales-summary/:workspaceId/sync
 * Manually triggers a sync for today (or an optional date in query ?date=YYYY-MM-DD).
 * Only accessible by superadmin or admin of the workspace.
 */
export async function triggerManualSync(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);

    if (!isBoloncityWorkspace(workspaceId)) {
      res.status(403).json({ message: "Integración Tumesero no disponible para este workspace." });
      return;
    }

    const userRole = req.user!.role;
    const isGlobalAdmin = userRole === "superadmin" || userRole === "admin";

    if (!isGlobalAdmin) {
      // Check workspace-level role — users with global role "user" may be "admin" in a specific workspace
      const dbUser = await UserModel.findById(req.user!._id).select("workspaces").lean();
      const wsEntry = (dbUser?.workspaces ?? []).find(
        (w: any) => String(w.workspaceId) === workspaceId
      );
      if (!wsEntry || wsEntry.role !== "admin") {
        res.status(403).json({ message: "Solo superadmin o admin puede sincronizar manualmente." });
        return;
      }
    }

    // Allow optional date override for backfill
    let targetDate: string;
    const dateParam = req.query.date;
    if (dateParam && typeof dateParam === "string") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        res.status(400).json({ message: "Fecha inválida. Use YYYY-MM-DD." });
        return;
      }
      targetDate = dateParam;
    } else {
      targetDate = getTodayEcuador();
    }

    const result = await tumeseroService.syncDailyData(workspaceId, targetDate);
    res.json({ message: "Sincronización completada.", result });
  } catch (error: any) {
    console.error("[SalesSummary] triggerManualSync error:", error.message);
    res.status(500).json({ message: error.message || "Error al sincronizar." });
  }
}

/**
 * POST /api/sales-summary/:workspaceId/sync-range?from=YYYY-MM-DD&to=YYYY-MM-DD
 * Syncs a range of dates sequentially (backfill). Max 30 days per call.
 * Same auth rules as single sync.
 */
export async function syncRange(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);

    if (!isBoloncityWorkspace(workspaceId)) {
      res.status(403).json({ message: "Integración Tumesero no disponible para este workspace." });
      return;
    }

    const userRole = req.user!.role;
    const isGlobalAdmin = userRole === "superadmin" || userRole === "admin";
    if (!isGlobalAdmin) {
      const dbUser = await UserModel.findById(req.user!._id).select("workspaces").lean();
      const wsEntry = (dbUser?.workspaces ?? []).find((w: any) => String(w.workspaceId) === workspaceId);
      if (!wsEntry || wsEntry.role !== "admin") {
        res.status(403).json({ message: "Solo superadmin o admin puede sincronizar." });
        return;
      }
    }

    const { from, to } = req.query;
    if (!from || !to || typeof from !== "string" || typeof to !== "string") {
      res.status(400).json({ message: "Parámetros requeridos: from=YYYY-MM-DD&to=YYYY-MM-DD" });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      res.status(400).json({ message: "Fechas inválidas. Use YYYY-MM-DD." });
      return;
    }

    const start = new Date(from + "T00:00:00Z");
    const end   = new Date(to   + "T00:00:00Z");
    const today = new Date(getTodayEcuador() + "T00:00:00Z");

    if (start > end) { res.status(400).json({ message: "from debe ser anterior o igual a to." }); return; }
    if (end > today)  { res.status(400).json({ message: "No puedes sincronizar fechas futuras." }); return; }

    const diffDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
    if (diffDays > 31) { res.status(400).json({ message: "Máximo 31 días por sincronización." }); return; }

    const results: Array<{ date: string; synced: boolean; error?: string }> = [];
    const cur = new Date(start);
    while (cur <= end) {
      const dateStr = cur.toISOString().slice(0, 10);
      try {
        await tumeseroService.syncDailyData(workspaceId, dateStr);
        results.push({ date: dateStr, synced: true });
      } catch (err: any) {
        results.push({ date: dateStr, synced: false, error: err.message });
      }
      cur.setUTCDate(cur.getUTCDate() + 1);
    }

    const synced = results.filter(r => r.synced).length;
    res.json({ message: `${synced} de ${diffDays} días sincronizados.`, results });
  } catch (error: any) {
    console.error("[SalesSummary] syncRange error:", error.message);
    res.status(500).json({ message: error.message || "Error al sincronizar rango." });
  }
}

/**
 * GET /api/sales-summary/:workspaceId/api-usage
 * Returns current API usage stats for today.
 */
export async function getApiUsage(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);

    if (!isBoloncityWorkspace(workspaceId)) {
      res.status(403).json({ message: "Integración Tumesero no disponible para este workspace." });
      return;
    }

    const usage = await tumeseroService.getApiUsage();
    res.json(usage);
  } catch (error: any) {
    console.error("[SalesSummary] getApiUsage error:", error.message);
    res.status(500).json({ message: error.message || "Error al obtener uso de API." });
  }
}
