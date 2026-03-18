import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import {
  getByEntry,
  createPlanning,
  updatePlanning,
  updateItem,
  submitClientApproval,
  reopenPlanning,
} from "../controllers/videoPlanning.controller";

// ── Router A: mounted at /api/planning-entries ────────────────────────────
// GET  /api/planning-entries/:entryId/video-planning
// POST /api/planning-entries/:entryId/video-planning
// PUT  /api/planning-entries/:entryId/video-planning
const planningEntriesRouter = Router();

planningEntriesRouter.get(
  "/:entryId/video-planning",
  authMiddleware,
  getByEntry
);
planningEntriesRouter.post(
  "/:entryId/video-planning",
  authMiddleware,
  internalOrSuperadminMiddleware,
  createPlanning
);
planningEntriesRouter.put(
  "/:entryId/video-planning",
  authMiddleware,
  internalOrSuperadminMiddleware,
  updatePlanning
);

// ── Router B: mounted at /api/video-planning ──────────────────────────────
// PATCH /api/video-planning/:planningId/items/:itemId
// POST  /api/video-planning/:planningId/client-approval
const videoPlanningRouter = Router();

videoPlanningRouter.patch(
  "/:planningId/items/:itemId",
  authMiddleware,
  internalOrSuperadminMiddleware,
  updateItem
);
videoPlanningRouter.post(
  "/:planningId/client-approval",
  authMiddleware,
  submitClientApproval
);
videoPlanningRouter.post(
  "/:planningId/reopen",
  authMiddleware,
  internalOrSuperadminMiddleware,
  reopenPlanning
);

export { planningEntriesRouter, videoPlanningRouter };
