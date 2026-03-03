import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { workspaceAdminMiddleware } from "../middlewares/workspaceAdmin.middleware";
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

// ── GLOBAL Workspace Actions ───────────────────────────────────
workspaceRouter.get("/", listWorkspaces);
workspaceRouter.post("/", superadminMiddleware, createWorkspace);

// ── SPECIFIC Workspace Actions (Superadmin, Admin or Collaborator) ─────────
// Collaborators have read-only access (GET)
workspaceRouter.get("/:workspaceId", workspaceAccessMiddleware, getWorkspace);

// Administrative actions (PUT, POST Users, etc.) require Admin/Superadmin
workspaceRouter.put("/:workspaceId", workspaceAdminMiddleware, updateWorkspace);

// Users Management
workspaceRouter.get("/:workspaceId/users", workspaceAccessMiddleware, listUsers);
workspaceRouter.post("/:workspaceId/users", workspaceAdminMiddleware, createUser);
workspaceRouter.put("/:workspaceId/users/:userId", workspaceAdminMiddleware, updateUser);
workspaceRouter.delete("/:workspaceId/users/:userId", workspaceAdminMiddleware, deleteUser);

export default workspaceRouter;
