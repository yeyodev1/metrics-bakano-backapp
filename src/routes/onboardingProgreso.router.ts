import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { listarProgreso, detalleProgreso, marcarPaso, recordarPaso } from "../controllers/onboardingProgreso.controller";

const onboardingProgresoRouter = Router();

// El avance del onboarding y los motivos de bloqueo son datos del equipo.
onboardingProgresoRouter.use(authMiddleware, internalOrSuperadminMiddleware);

onboardingProgresoRouter.get("/", listarProgreso);
onboardingProgresoRouter.get("/:workspaceId", detalleProgreso);
onboardingProgresoRouter.patch("/:workspaceId/:paso", marcarPaso);
onboardingProgresoRouter.post("/:workspaceId/:paso/recordar", recordarPaso);

export default onboardingProgresoRouter;
