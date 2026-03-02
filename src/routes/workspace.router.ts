import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  createAdmin,
  listAdmins,
} from "../controllers/workspace.controller";

const workspaceRouter = Router();

// All workspace routes require: valid JWT + superadmin role
workspaceRouter.use(authMiddleware, superadminMiddleware);

// Workspace CRUD
workspaceRouter.post("/", createWorkspace);
workspaceRouter.get("/", listWorkspaces);
workspaceRouter.get("/:workspaceId", getWorkspace);

// Admins within a workspace
workspaceRouter.post("/:workspaceId/admins", createAdmin);
workspaceRouter.get("/:workspaceId/admins", listAdmins);

export default workspaceRouter;
