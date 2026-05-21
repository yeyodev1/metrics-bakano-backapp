import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { workspaceAdminMiddleware } from "../middlewares/workspaceAdmin.middleware";
import {
  createEntry,
  listEntries,
  updateEntry,
  deleteEntry,
  listMyWeek,
} from "../controllers/planning.controller";

const planningRouter = Router();

// Base auth required for all
planningRouter.use(authMiddleware);

// Routes nested under workspace context in app.ts or defined here
// Pattern: /workspaces/:workspaceId/planning
// Global week view — MUST be before /:workspaceId to avoid param capture
planningRouter.get("/my-week", listMyWeek);

planningRouter.get("/:workspaceId", workspaceAccessMiddleware, listEntries);
planningRouter.post("/:workspaceId", workspaceAdminMiddleware, createEntry);
planningRouter.put("/:entryId", workspaceAdminMiddleware, updateEntry);
planningRouter.delete("/:entryId", workspaceAdminMiddleware, deleteEntry);

export default planningRouter;
