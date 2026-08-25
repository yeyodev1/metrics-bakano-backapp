import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { internalPulseService } from "../services/internalPulse.service";

/**
 * Lee year/month del query cayendo en el mes actual de Ecuador. Un mes mal
 * parseado no puede quedar como NaN: la agregacion devolveria cero y parecia
 * un cliente sin facturacion.
 */
function resolvePeriod(req: AuthRequest): { year: number; month: number } | null {
  const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const year = req.query.year ? Number(req.query.year) : ahora.getUTCFullYear();
  const month = req.query.month ? Number(req.query.month) : ahora.getUTCMonth() + 1;

  if (!Number.isInteger(year) || year < 2020 || year > 2100) return null;
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { year, month };
}

/**
 * GET /api/internal-pulse/overview
 * Tablero de todos los clientes activos: meta, facturado y ritmo.
 */
export async function getPulseOverview(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = resolvePeriod(req);
    if (!period) {
      res.status(400).json({ message: "Periodo inválido. Usa year (>=2020) y month (1-12)." });
      return;
    }

    const data = await internalPulseService.getOverview(period.year, period.month);
    res.status(200).json(data);
  } catch (error: any) {
    console.error("getPulseOverview error:", error);
    res.status(500).json({ message: "Error al cargar el pulso global." });
  }
}

/**
 * GET /api/internal-pulse/:workspaceId
 * Pulso completo de un cliente: meta, avance, ritmo, equipo y alertas.
 */
export async function getWorkspacePulse(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = resolvePeriod(req);
    if (!period) {
      res.status(400).json({ message: "Periodo inválido. Usa year (>=2020) y month (1-12)." });
      return;
    }

    const data = await internalPulseService.getWorkspacePulse(
      req.params.workspaceId as string,
      period.year,
      period.month
    );
    res.status(200).json(data);
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(400).json({ message: "ID de entorno inválido." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(404).json({ message: "Entorno no encontrado." });
      return;
    }
    console.error("getWorkspacePulse error:", error);
    res.status(500).json({ message: "Error al cargar el pulso del entorno." });
  }
}

/**
 * PUT /api/internal-pulse/:workspaceId/target
 * Define o corrige la meta mensual del cliente.
 */
export async function setMonthlyTarget(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = resolvePeriod(req);
    const { targetAmount, stretchAmount, notes, source } = req.body;
    const year = req.body.year !== undefined ? Number(req.body.year) : period?.year;
    const month = req.body.month !== undefined ? Number(req.body.month) : period?.month;

    if (!year || !month || !Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      res.status(400).json({ message: "Periodo inválido. Usa year y month (1-12)." });
      return;
    }
    if (typeof targetAmount !== "number" || !Number.isFinite(targetAmount) || targetAmount <= 0) {
      res.status(400).json({ message: "La meta debe ser un número mayor a 0." });
      return;
    }
    if (stretchAmount !== undefined && stretchAmount !== null && typeof stretchAmount !== "number") {
      res.status(400).json({ message: "La meta ambiciosa debe ser numérica." });
      return;
    }

    const target = await internalPulseService.setTarget(
      req.params.workspaceId as string,
      year,
      month,
      {
        targetAmount,
        stretchAmount: stretchAmount ?? undefined,
        notes,
        source: source === "carryover" ? "carryover" : "manual",
      },
      { _id: req.user!._id, name: (req.user as any).name, email: req.user!.email }
    );

    res.status(200).json({ message: "Meta mensual guardada.", target });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(400).json({ message: "ID de entorno inválido." });
      return;
    }
    if (error.message === "INVALID_AMOUNT") {
      res.status(400).json({ message: "El monto de la meta es inválido." });
      return;
    }
    if (error.message === "STRETCH_BELOW_TARGET") {
      res.status(400).json({ message: "La meta ambiciosa no puede ser menor que la meta base." });
      return;
    }
    console.error("setMonthlyTarget error:", error);
    res.status(500).json({ message: "Error al guardar la meta mensual." });
  }
}

/**
 * GET /api/internal-pulse/:workspaceId/status
 * Estado corto de la meta: lo consume el menú lateral.
 */
export async function getTargetStatus(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = resolvePeriod(req);
    if (!period) {
      res.status(400).json({ message: "Periodo inválido. Usa year (>=2020) y month (1-12)." });
      return;
    }

    const status = await internalPulseService.getTargetStatus(
      req.params.workspaceId as string,
      period.year,
      period.month
    );
    res.status(200).json(status);
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(400).json({ message: "ID de entorno inválido." });
      return;
    }
    console.error("getTargetStatus error:", error);
    res.status(500).json({ message: "Error al consultar el estado de la meta." });
  }
}

/**
 * GET /api/internal-pulse/missing-count
 * Cuántos clientes activos siguen sin meta este mes.
 */
export async function getMissingTargetCount(req: AuthRequest, res: Response): Promise<void> {
  try {
    const period = resolvePeriod(req);
    if (!period) {
      res.status(400).json({ message: "Periodo inválido. Usa year (>=2020) y month (1-12)." });
      return;
    }

    const data = await internalPulseService.countMissingTargets(period.year, period.month);
    res.status(200).json(data);
  } catch (error: any) {
    console.error("getMissingTargetCount error:", error);
    res.status(500).json({ message: "Error al contar las metas pendientes." });
  }
}

/**
 * GET /api/internal-pulse/:workspaceId/history
 * Meta vs facturado de los últimos meses.
 */
export async function getTargetHistory(req: AuthRequest, res: Response): Promise<void> {
  try {
    const months = req.query.months ? Number(req.query.months) : 6;
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      res.status(400).json({ message: "months debe estar entre 1 y 24." });
      return;
    }

    const history = await internalPulseService.getTargetHistory(
      req.params.workspaceId as string,
      months
    );
    res.status(200).json({ history });
  } catch (error: any) {
    console.error("getTargetHistory error:", error);
    res.status(500).json({ message: "Error al cargar el histórico de metas." });
  }
}

/**
 * POST /api/internal-pulse/:workspaceId/remind
 * Dispara el recordatorio manual al equipo asignado de ese cliente.
 */
export async function sendPulseReminder(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await internalPulseService.runTargetReminders({
      onlyWorkspaceId: req.params.workspaceId as string,
      sendEmail: req.body?.sendEmail !== false,
    });

    const alerted = result.alerted[0];
    res.status(200).json({
      message: alerted
        ? `Recordatorio enviado a ${alerted.notified} persona(s) del equipo.`
        : "Nada que recordar: el cliente está en orden.",
      result,
    });
  } catch (error: any) {
    console.error("sendPulseReminder error:", error);
    res.status(500).json({ message: "Error al enviar el recordatorio." });
  }
}
