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

// Read-only endpoints for Ads data
metaRouter.get("/:workspaceId/adaccounts", workspaceAccessMiddleware, metaController.getAdAccounts);
metaRouter.get("/:workspaceId/ads-insights", workspaceAccessMiddleware, metaController.getAdsInsights);
metaRouter.get("/:workspaceId/organic-insights", workspaceAccessMiddleware, metaController.getOrganicInsights);

export default metaRouter;
