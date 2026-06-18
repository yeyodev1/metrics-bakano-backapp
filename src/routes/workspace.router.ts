import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { workspaceAdminMiddleware } from "../middlewares/workspaceAdmin.middleware";
import { uploadDocument } from "../middlewares/upload.middleware";
import { ghlController } from "../controllers/ghl.controller";
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  toggleWorkspaceActive,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  listAllCollaborators,
  createGlobalUser,
  updateGlobalUser,
  resendInvite,
  deleteWorkspace,
  getTeam,
} from "../controllers/workspace.controller";
import {
  getBrandProfile,
  upsertBrandProfile,
  uploadBrandProfileFile,
  deleteBrandProfileFile,
  sendBrandProfileInviteController,
} from "../controllers/brandProfile.controller";
import {
  getBranches,
  createBranch,
  updateBranch,
  deleteBranch,
} from "../controllers/branch.controller";

const workspaceRouter = Router();

// Base auth required for all
workspaceRouter.use(authMiddleware);

// ── GLOBAL Workspace Actions ───────────────────────────────────
workspaceRouter.get("/", listWorkspaces);
workspaceRouter.get("/all-users", superadminMiddleware, listAllCollaborators);
workspaceRouter.post("/global-users", superadminMiddleware, createGlobalUser);
workspaceRouter.put("/global-users/:userId", superadminMiddleware, updateGlobalUser);
workspaceRouter.post("/global-users/:userId/resend-invite", superadminMiddleware, resendInvite);
workspaceRouter.post("/", superadminMiddleware, createWorkspace);

// ── Brand Profile (accessible to all workspace members) ──────────────────
workspaceRouter.get("/:workspaceId/brand-profile", workspaceAccessMiddleware, getBrandProfile);
workspaceRouter.patch("/:workspaceId/brand-profile", workspaceAccessMiddleware, upsertBrandProfile);
workspaceRouter.post(
  "/:workspaceId/brand-profile/files",
  internalOrSuperadminMiddleware,
  uploadDocument.single("file"),
  uploadBrandProfileFile
);
workspaceRouter.delete(
  "/:workspaceId/brand-profile/files/:publicId",
  internalOrSuperadminMiddleware,
  deleteBrandProfileFile
);
workspaceRouter.post(
  "/:workspaceId/send-brand-profile-invite",
  superadminMiddleware,
  sendBrandProfileInviteController
);

// ── SPECIFIC Workspace Actions (Superadmin, Admin or Collaborator) ─────────
workspaceRouter.get("/:workspaceId", workspaceAccessMiddleware, getWorkspace);
workspaceRouter.put("/:workspaceId", workspaceAdminMiddleware, updateWorkspace);
workspaceRouter.patch("/:workspaceId/toggle-active", superadminMiddleware, toggleWorkspaceActive);
workspaceRouter.delete("/:workspaceId", superadminMiddleware, deleteWorkspace);

// Users Management
workspaceRouter.get("/:workspaceId/users", workspaceAccessMiddleware, listUsers);
workspaceRouter.get("/:workspaceId/team", workspaceAccessMiddleware, getTeam);
workspaceRouter.post("/:workspaceId/users", workspaceAdminMiddleware, createUser);
workspaceRouter.put("/:workspaceId/users/:userId", workspaceAdminMiddleware, updateUser);
workspaceRouter.delete("/:workspaceId/users/:userId", workspaceAdminMiddleware, deleteUser);

// GHL Meetings
workspaceRouter.get("/:workspaceId/meetings", workspaceAccessMiddleware, ghlController.getWorkspaceMeetings);

// Branches Management
workspaceRouter.get("/:workspaceId/branches", workspaceAccessMiddleware, getBranches);
workspaceRouter.post("/:workspaceId/branches", workspaceAdminMiddleware, createBranch);
workspaceRouter.put("/:workspaceId/branches/:id", workspaceAdminMiddleware, updateBranch);
workspaceRouter.delete("/:workspaceId/branches/:id", workspaceAdminMiddleware, deleteBranch);

export default workspaceRouter;
