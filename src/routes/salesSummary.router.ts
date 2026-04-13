import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getMonthSummary,
  triggerManualSync,
  syncRange,
  getApiUsage,
} from "../controllers/salesSummary.controller";

const salesSummaryRouter = Router();

// All routes require authentication
salesSummaryRouter.use(authMiddleware);

// GET /api/sales-summary/:workspaceId/month?year=X&month=Y
salesSummaryRouter.get("/:workspaceId/month", getMonthSummary);

// GET /api/sales-summary/:workspaceId/api-usage
salesSummaryRouter.get("/:workspaceId/api-usage", getApiUsage);

// POST /api/sales-summary/:workspaceId/sync?date=YYYY-MM-DD (optional date)
salesSummaryRouter.post("/:workspaceId/sync", triggerManualSync);

// POST /api/sales-summary/:workspaceId/sync-range?from=YYYY-MM-DD&to=YYYY-MM-DD
salesSummaryRouter.post("/:workspaceId/sync-range", syncRange);

export default salesSummaryRouter;
