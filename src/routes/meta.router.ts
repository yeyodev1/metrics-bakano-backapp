import { Router } from "express";
import * as metaController from "../controllers/meta.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { workspaceAdminMiddleware } from "../middlewares/workspaceAdmin.middleware";

const metaRouter = Router();

// Apply auth for all meta routes
metaRouter.use(authMiddleware);

// Endpoint to start authentication (exchange token)
metaRouter.post("/authenticate", metaController.authenticateMeta);

// Endpoint to save selected page/account (Admin/Superadmin only)
metaRouter.post("/save-integration", workspaceAdminMiddleware, metaController.saveMetaIntegration);

// Read-only endpoints for Ads data (Access to Collaborators)
metaRouter.get("/:workspaceId/adaccounts", workspaceAccessMiddleware, metaController.getAdAccounts);
metaRouter.get("/:workspaceId/ads-insights", workspaceAccessMiddleware, metaController.getAdsInsights);
metaRouter.get("/:workspaceId/organic-insights", workspaceAccessMiddleware, metaController.getOrganicInsights);

export default metaRouter;
