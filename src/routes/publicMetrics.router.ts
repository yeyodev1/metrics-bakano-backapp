import { Router } from "express";
import { apiKeyMiddleware } from "../middlewares/apiKey.middleware";
import { getAllMetrics, getWorkspaceMetrics, getBillingAlerts } from "../controllers/publicMetrics.controller";

const publicMetricsRouter = Router();

publicMetricsRouter.use(apiKeyMiddleware);

publicMetricsRouter.get("/metrics", getAllMetrics);
publicMetricsRouter.get("/metrics/:workspaceId", getWorkspaceMetrics);
publicMetricsRouter.get("/billing-alerts", getBillingAlerts);

export default publicMetricsRouter;
