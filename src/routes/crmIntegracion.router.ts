import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import {
  cambiarRevisionCrm,
  conectarCrm,
  desconectarCrm,
  getIntegraciones,
  getMetricasCrm,
  probarCrmGuardado,
  recalcularMetricasCrm,
  revisarCrmManual,
} from "../controllers/crmIntegracion.controller";

/**
 * Integraciones del entorno (por ahora, el CRM GoHighLevel del cliente).
 * Mismo control que la facturacion del portal: sesion + acceso al entorno.
 * El middleware va por ruta y no con .use() para no tocar otras rutas que
 * pasan por /api/workspaces.
 */
const crmIntegracionRouter = Router();

crmIntegracionRouter.get("/:workspaceId/integraciones", authMiddleware, workspaceAccessMiddleware, getIntegraciones);
crmIntegracionRouter.put("/:workspaceId/integraciones/crm", authMiddleware, workspaceAccessMiddleware, conectarCrm);
crmIntegracionRouter.post("/:workspaceId/integraciones/crm/probar", authMiddleware, workspaceAccessMiddleware, probarCrmGuardado);
// Solo equipo de Bakano (se valida en el controlador: 403 para clientes).
crmIntegracionRouter.patch("/:workspaceId/integraciones/crm/revision", authMiddleware, workspaceAccessMiddleware, cambiarRevisionCrm);
crmIntegracionRouter.post("/:workspaceId/integraciones/crm/revisar", authMiddleware, workspaceAccessMiddleware, revisarCrmManual);
crmIntegracionRouter.get("/:workspaceId/integraciones/crm/metricas", authMiddleware, workspaceAccessMiddleware, getMetricasCrm);
crmIntegracionRouter.post("/:workspaceId/integraciones/crm/metricas/recalcular", authMiddleware, workspaceAccessMiddleware, recalcularMetricasCrm);
crmIntegracionRouter.delete("/:workspaceId/integraciones/crm", authMiddleware, workspaceAccessMiddleware, desconectarCrm);

export default crmIntegracionRouter;
