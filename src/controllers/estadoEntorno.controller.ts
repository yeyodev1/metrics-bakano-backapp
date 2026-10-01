import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { estadoMetricsService } from "../services/estadoMetrics.service";
import { crmSubcuentaService } from "../services/crmSubcuenta.service";

/** Lo que hay en Metrics del entorno, en vivo (la misma foto que ve el bot). */
export async function getEstadoMetrics(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const estado = await estadoMetricsService.de(String(req.params.workspaceId));
    if (!estado) return res.status(404).send({ message: "Entorno no encontrado." });
    res.status(200).send(estado);
  } catch (error) {
    next(error);
  }
}

export async function getCrmSubcuenta(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    res.status(200).send(await crmSubcuentaService.ver(String(req.params.workspaceId)));
  } catch (error) {
    next(error);
  }
}

export async function putCrmSubcuenta(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const vista = await crmSubcuentaService.vincular(String(req.params.workspaceId), req.body?.locationId, req.user as any);
    res.status(200).send(vista);
  } catch (error) {
    next(error);
  }
}
