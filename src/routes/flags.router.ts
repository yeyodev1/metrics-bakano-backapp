import { Router } from "express";
import * as controller from "../controllers/flags.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { projectManagerOrSuperadminMiddleware } from "../middlewares/projectManagerOrSuperadmin.middleware";

const flagsRouter = Router();

// Dashboard de banderas: PM (Génesis), Content Manager y Superadmin.
flagsRouter.use(authMiddleware, projectManagerOrSuperadminMiddleware);

// GET /api/flags/clients?from=YYYY-MM-DD&to=YYYY-MM-DD
flagsRouter.get("/clients", controller.getClientFlags);

// GET /api/flags/collaborators?from&to
flagsRouter.get("/collaborators", controller.getCollaboratorFlags);

// GET /api/flags/collaborators/:userId?etapa=contenido|edicion&from&to
flagsRouter.get("/collaborators/:userId", controller.getCollaboratorDetail);

export default flagsRouter;
