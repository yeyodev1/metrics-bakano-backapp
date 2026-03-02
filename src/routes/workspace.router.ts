import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
} from "../controllers/workspace.controller";

const workspaceRouter = Router();

// Base auth required for all
workspaceRouter.use(authMiddleware);

// ── GLOBAL Workspace Actions (Superadmin Only) ────────────────
workspaceRouter.get("/", superadminMiddleware, listWorkspaces);
workspaceRouter.post("/", superadminMiddleware, createWorkspace);

// ── SPECIFIC Workspace Actions (Superadmin or Admin) ─────────
// Must use workspaceAccessMiddleware to check permissions
workspaceRouter.get("/:workspaceId", workspaceAccessMiddleware, getWorkspace);
workspaceRouter.put("/:workspaceId", workspaceAccessMiddleware, updateWorkspace);

// Users Management
workspaceRouter.get("/:workspaceId/users", workspaceAccessMiddleware, listUsers);
workspaceRouter.post("/:workspaceId/users", workspaceAccessMiddleware, createUser);
workspaceRouter.put("/:workspaceId/users/:userId", workspaceAccessMiddleware, updateUser);
workspaceRouter.delete("/:workspaceId/users/:userId", workspaceAccessMiddleware, deleteUser);

export default workspaceRouter;
