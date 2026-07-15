import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { florindaSalesService, FLORINDA_WORKSPACE_ID } from "../services/florindaSales.service";

export async function getFlorindaMonth(req: AuthRequest, res: Response): Promise<void> {
  try {
    const workspaceId = String(req.params.workspaceId);
    if (workspaceId !== FLORINDA_WORKSPACE_ID) {
      res.status(403).json({ message: "Integración Florinda no disponible para este workspace." });
      return;
    }
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ message: "Use year y month válidos." });
      return;
    }
    res.json(await florindaSalesService.getMonthSummary(workspaceId, year, month));
  } catch (error: any) {
    console.error("[FlorindaSales] month error:", error.message);
    res.status(500).json({ message: "Error al obtener las ventas de Florinda." });
  }
}

export async function syncFlorindaSales(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (req.user!.role !== "superadmin" && req.user!.role !== "admin") {
      res.status(403).json({ message: "Solo administradores pueden sincronizar manualmente." });
      return;
    }
    const workspaceId = String(req.params.workspaceId);
    const result = await florindaSalesService.syncCurrentYear(workspaceId);
    res.json({ message: "Ventas de Florinda sincronizadas.", result });
  } catch (error: any) {
    console.error("[FlorindaSales] sync error:", error.message);
    res.status(500).json({ message: error.message || "Error al sincronizar ventas de Florinda." });
  }
}
