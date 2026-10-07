import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import { crmIntegracionService, esEquipoBakano } from "../services/crmIntegracion.service";
import { crmRevisionService } from "../services/crmRevision.service";
import { crmMetricasService } from "../services/crmMetricas.service";

const esEquipo = (req: AuthRequest) => esEquipoBakano(req.user);

function handleError(res: Response, error: unknown, fallback: string) {
  if (error instanceof CustomError) {
    res.status(error.status).json({ message: error.message });
    return;
  }
  console.error(`[crmIntegracion] ${fallback}:`, (error as Error)?.message || error);
  res.status(500).json({ message: fallback });
}

/** GET /api/workspaces/:workspaceId/integraciones */
export async function getIntegraciones(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await crmIntegracionService.obtener(String(req.params.workspaceId), esEquipo(req));
    res.status(200).json(data);
  } catch (error) {
    handleError(res, error, "No se pudieron obtener las integraciones.");
  }
}

/**
 * PUT /api/workspaces/:workspaceId/integraciones/crm — body: { locationId, token? }
 * Sin token y con la agencia disponible (solo equipo) → modo agencia.
 */
export async function conectarCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { locationId, token } = req.body ?? {};
    const vista = await crmIntegracionService.conectar(
      String(req.params.workspaceId),
      { locationId, token },
      req.user!._id,
      esEquipo(req)
    );
    res.status(200).json(vista);
  } catch (error) {
    handleError(res, error, "No se pudo conectar el CRM.");
  }
}

/** POST /api/workspaces/:workspaceId/integraciones/crm/probar */
export async function probarCrmGuardado(req: AuthRequest, res: Response): Promise<void> {
  try {
    const vista = await crmIntegracionService.reprobar(String(req.params.workspaceId));
    res.status(200).json(vista);
  } catch (error) {
    handleError(res, error, "No se pudo probar el CRM.");
  }
}

/** DELETE /api/workspaces/:workspaceId/integraciones/crm */
export async function desconectarCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    await crmIntegracionService.desconectar(String(req.params.workspaceId));
    res.status(204).send();
  } catch (error) {
    handleError(res, error, "No se pudo desconectar el CRM.");
  }
}

/**
 * PATCH /api/workspaces/:workspaceId/integraciones/crm/revision — solo equipo.
 * body: { activa?, diasConversaciones?, diasOportunidades?, diasEstancada? } → CrmVista
 */
export async function cambiarRevisionCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!esEquipo(req)) {
      res.status(403).json({ message: "Solo el equipo de Bakano puede cambiar la revisión" });
      return;
    }
    const vista = await crmIntegracionService.cambiarRevision(String(req.params.workspaceId), req.body ?? {});
    res.status(200).json(vista);
  } catch (error) {
    handleError(res, error, "No se pudo cambiar la revisión del CRM.");
  }
}

/**
 * POST /api/workspaces/:workspaceId/integraciones/crm/revisar — solo equipo.
 * body: { desde: "YYYY-MM-DD", hasta: "YYYY-MM-DD", avisarCliente?: boolean }
 */
export async function revisarCrmManual(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!esEquipo(req)) {
      res.status(403).json({ message: "Solo el equipo de Bakano puede revisar el CRM a mano" });
      return;
    }
    const r = await crmRevisionService.revisarRango(String(req.params.workspaceId), req.body ?? {});
    res.status(200).json(r);
  } catch (error) {
    handleError(res, error, "No se pudo revisar el CRM.");
  }
}

/** GET /api/workspaces/:workspaceId/integraciones/crm/metricas?dias=7 — dashboard del CRM (dias cerrados hasta ayer). */
export async function getMetricasCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    const r = await crmMetricasService.rango(String(req.params.workspaceId), req.query.dias);
    res.status(200).json(r);
  } catch (error) {
    handleError(res, error, "No se pudieron obtener las métricas del CRM.");
  }
}

/**
 * POST /api/workspaces/:workspaceId/integraciones/crm/metricas/recalcular
 * body: { desde: "YYYY-MM-DD", hasta: "YYYY-MM-DD" } — solo equipo, máx. 31 días.
 */
export async function recalcularMetricasCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    if (!esEquipo(req)) {
      res.status(403).json({ message: "Solo el equipo de Bakano puede recalcular las métricas del CRM" });
      return;
    }
    const r = await crmMetricasService.recalcular(String(req.params.workspaceId), req.body?.desde, req.body?.hasta);
    res.status(200).json(r);
  } catch (error) {
    handleError(res, error, "No se pudieron recalcular las métricas del CRM.");
  }
}
