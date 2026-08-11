import { Router } from "express";
import * as scriptPerformanceController from "../controllers/scriptPerformance.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";

const scriptPerformanceRouter = Router();

scriptPerformanceRouter.use(authMiddleware);

// GET /api/script-performance/cross-workspace?vertical=&metric=&month=
// Declared before /:workspaceId so the literal path is not captured as an id.
scriptPerformanceRouter.get(
  "/cross-workspace",
  internalOrSuperadminMiddleware,
  scriptPerformanceController.getCrossWorkspacePerformance
);

// GET /api/script-performance/:workspaceId?metric=views|leads&month=YYYY-MM
scriptPerformanceRouter.get(
  "/:workspaceId",
  workspaceAccessMiddleware,
  scriptPerformanceController.getWorkspacePerformance
);

// GET /api/script-performance/:workspaceId/items/:itemId/timeline
scriptPerformanceRouter.get(
  "/:workspaceId/items/:itemId/timeline",
  workspaceAccessMiddleware,
  scriptPerformanceController.getItemTimeline
);

export default scriptPerformanceRouter;
