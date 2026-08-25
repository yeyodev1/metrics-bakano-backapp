import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import {
  getPulseOverview,
  getTargetStatus,
  getMissingTargetCount,
  getWorkspacePulse,
  setMonthlyTarget,
  getTargetHistory,
  sendPulseReminder,
} from "../controllers/internalPulse.controller";

const internalPulseRouter = Router();

// Segmento interno: metas, ritmo y quien no registra son datos del equipo de
// Bakano. Ocultar el link en el sidebar no basta, la ruta tambien se cierra.
internalPulseRouter.use(authMiddleware, internalOrSuperadminMiddleware);

// Antes de "/:workspaceId": si no, "overview" se lee como un id de entorno.
internalPulseRouter.get("/overview", getPulseOverview);
internalPulseRouter.get("/missing-count", getMissingTargetCount);
internalPulseRouter.get("/:workspaceId", getWorkspacePulse);
internalPulseRouter.get("/:workspaceId/history", getTargetHistory);
internalPulseRouter.get("/:workspaceId/status", getTargetStatus);
internalPulseRouter.put("/:workspaceId/target", setMonthlyTarget);
internalPulseRouter.post("/:workspaceId/remind", sendPulseReminder);

export default internalPulseRouter;
