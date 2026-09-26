import type { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { CustomError } from "../errors/customError.error";
import { crmIntegracionService } from "../services/crmIntegracion.service";

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
    const data = await crmIntegracionService.obtener(String(req.params.workspaceId));
    res.status(200).json(data);
  } catch (error) {
    handleError(res, error, "No se pudieron obtener las integraciones.");
  }
}

/** PUT /api/workspaces/:workspaceId/integraciones/crm — body: { locationId, token } */
export async function conectarCrm(req: AuthRequest, res: Response): Promise<void> {
  try {
    const { locationId, token } = req.body ?? {};
    const vista = await crmIntegracionService.conectar(String(req.params.workspaceId), { locationId, token }, req.user!._id);
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
