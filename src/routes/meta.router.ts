import { Router } from "express";
import * as metaController from "../controllers/meta.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { workspaceAdminMiddleware } from "../middlewares/workspaceAdmin.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";

const metaRouter = Router();

// Facebook redirects here without the app's JWT; state validation happens in MetaService.
metaRouter.get("/global/oauth/callback", metaController.completeGlobalOAuth);

// Apply auth for all meta routes
metaRouter.use(authMiddleware);

// Endpoint to start authentication (exchange token)
metaRouter.post("/authenticate", metaController.authenticateMeta);

// Diagnostico: que permisos tiene de verdad el token guardado de un entorno.
metaRouter.get(
  "/:workspaceId/diagnose",
  workspaceAccessMiddleware,
  metaController.diagnoseMetaConnection
);

// Endpoint to save selected page/account (Admin/Superadmin only)
metaRouter.post("/save-integration", workspaceAdminMiddleware, metaController.saveMetaIntegration);

// Global Business Manager integration (never exposes the System User token)
metaRouter.post("/global/auto-match", superadminMiddleware, metaController.autoMatchGlobalAccounts);
metaRouter.get("/global/oauth-url", superadminMiddleware, metaController.getGlobalOAuthUrl);
metaRouter.get("/global/status", superadminMiddleware, metaController.getGlobalConnectionStatus);
metaRouter.get("/global/pending", superadminMiddleware, metaController.getPendingGlobalAccounts);
metaRouter.get("/global/linked", superadminMiddleware, metaController.getLinkedGlobalAccounts);
metaRouter.get("/global/all-accounts", superadminMiddleware, metaController.getAllGlobalAccounts);
metaRouter.post("/global/manual-link", superadminMiddleware, metaController.manuallyLinkGlobalAccount);
metaRouter.post("/global/unlink", superadminMiddleware, metaController.unlinkGlobalAccount);
metaRouter.post("/global/refresh-tokens", superadminMiddleware, metaController.refreshGlobalTokens);

// Read-only endpoints for Ads data (Access to Collaborators)
metaRouter.get("/:workspaceId/adaccounts", workspaceAccessMiddleware, metaController.getAdAccounts);
metaRouter.get("/:workspaceId/ads-insights", workspaceAccessMiddleware, metaController.getAdsInsights);
metaRouter.get("/:workspaceId/organic-insights", workspaceAccessMiddleware, metaController.getOrganicInsights);
metaRouter.get("/:workspaceId/unified-dashboard", workspaceAccessMiddleware, metaController.getUnifiedDashboard);

export default metaRouter;
