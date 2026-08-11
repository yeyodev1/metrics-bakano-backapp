import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import {
  getByEntry,
  createPlanning,
  updatePlanning,
  updateItem,
  uploadItemMedia,
  submitClientApproval,
  reopenPlanning,
  getCalendarItems,
  getEditorCompletedItems,
  linkReelMedia,
  syncVideoItemMetrics,
  getPublishedReelsForWorkspace,
  classifyItemScript,
  getWorkspaceItems,
  getWorkspaceAds,
} from "../controllers/videoPlanning.controller";
import { generateScript, generateScriptQuick, getLLMStatus } from "../controllers/scriptGeneration.controller";
import { uploadMedia } from "../middlewares/upload.middleware";

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
// PATCH  /api/video-planning/:planningId/items/:itemId
// POST   /api/video-planning/:planningId/client-approval
// POST   /api/video-planning/:planningId/reopen
// GET    /api/video-planning/calendar
// POST   /api/video-planning/:videoItemId/generate-script
const videoPlanningRouter = Router();

videoPlanningRouter.get(
  "/editor/:editorId/edited-items",
  authMiddleware,
  internalOrSuperadminMiddleware,
  getEditorCompletedItems
);

videoPlanningRouter.get(
  "/workspace/:workspaceId/published-reels",
  authMiddleware,
  getPublishedReelsForWorkspace
);
// GET /api/video-planning/workspace/:workspaceId/items
videoPlanningRouter.get(
  "/workspace/:workspaceId/items",
  authMiddleware,
  getWorkspaceItems
);
// GET /api/video-planning/workspace/:workspaceId/ads
videoPlanningRouter.get(
  "/workspace/:workspaceId/ads",
  authMiddleware,
  getWorkspaceAds
);
videoPlanningRouter.post(
  "/:planningId/items/:itemId/link-reel",
  authMiddleware,
  internalOrSuperadminMiddleware,
  linkReelMedia
);
videoPlanningRouter.post(
  "/:planningId/items/:itemId/sync-metrics",
  authMiddleware,
  syncVideoItemMetrics
);
// POST /api/video-planning/:planningId/items/:itemId/classify
videoPlanningRouter.post(
  "/:planningId/items/:itemId/classify",
  authMiddleware,
  internalOrSuperadminMiddleware,
  classifyItemScript
);

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
videoPlanningRouter.get(
  "/calendar",
  authMiddleware,
  getCalendarItems
);
// LLM health check — registered first to avoid param route collision
videoPlanningRouter.get(
  "/llm-status",
  authMiddleware,
  getLLMStatus
);
// Media upload — registered before param routes to avoid collision
videoPlanningRouter.post(
  "/items/:itemId/upload-media",
  authMiddleware,
  internalOrSuperadminMiddleware,
  uploadMedia.single("file"),
  uploadItemMedia
);
// Must be registered before /:videoItemId/generate-script to avoid route collision
videoPlanningRouter.post(
  "/generate-script-quick",
  authMiddleware,
  internalOrSuperadminMiddleware,
  generateScriptQuick
);
videoPlanningRouter.post(
  "/:videoItemId/generate-script",
  authMiddleware,
  internalOrSuperadminMiddleware,
  generateScript
);

export { planningEntriesRouter, videoPlanningRouter };
