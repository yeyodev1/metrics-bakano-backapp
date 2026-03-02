import { Router } from "express";
import * as metaController from "../controllers/meta.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";

const metaRouter = Router();

// Apply auth for all meta routes
metaRouter.use(authMiddleware);

// Endpoint to start authentication (exchange token)
metaRouter.post("/authenticate", metaController.authenticateMeta);

// Endpoint to save selected page/account
metaRouter.post("/save-integration", workspaceAccessMiddleware, metaController.saveMetaIntegration);

export default metaRouter;
