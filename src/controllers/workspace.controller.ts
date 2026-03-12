import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { WorkspaceService } from "../services/workspace.service";

const workspaceService = new WorkspaceService();

// ── Workspaces ────────────────────────────────────────────────

export async function createWorkspace(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Workspace name is required." });
      return;
    }

    const workspace = await workspaceService.createWorkspace({ name });
    res.status(HttpStatusCode.Created).send({ message: "Workspace created successfully.", workspace });
    return;
  } catch (error: any) {
    if (error.message === "WORKSPACE_NAME_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "A workspace with that name already exists." });
      return;
    }
    console.error("createWorkspace error:", error);
    next(error);
  }
}

export async function listWorkspaces(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const role = req.user?.role;
    const userId = req.user?._id;

    // Extract search and pagination params
    const search = req.query["search"] as string;
    const page = parseInt(req.query["page"] as string) || 1;
    const limit = parseInt(req.query["limit"] as string) || 10;

    if (role === 'superadmin') {
      const data = await workspaceService.listWorkspaces({ search, page, limit });
      res.status(HttpStatusCode.Ok).send({
        message: "Workspaces retrieved successfully.",
        workspaces: data.workspaces,
        metadata: {
          total: data.total,
          page: data.page,
          limit: data.limit,
          hasMore: data.hasMore
        }
      });
      return;
    } else {
      if (!userId) {
        res.status(HttpStatusCode.Unauthorized).send({ message: "No user assigned.", workspaces: [] });
        return;
      }
      // For now, we'll keep the standard list for non-superadmins or update if needed
      const workspaces = await workspaceService.listWorkspacesForUser(userId);
      res.status(HttpStatusCode.Ok).send({ message: "Workspaces retrieved successfully.", workspaces });
      return;
    }
  } catch (error) {
    console.error("listWorkspaces error:", error);
    next(error);
  }
}

export async function getWorkspace(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const userId = req.user?._id;
    const workspace = await workspaceService.getWorkspaceById(workspaceId, userId);
    res.status(HttpStatusCode.Ok).send({ message: "Workspace retrieved successfully.", workspace });
    return;
  } catch (error: any) {
    if (error.message === "INVALID_ID" || error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }
    console.error("getWorkspace error:", error);
    next(error);
  }
}

export async function updateWorkspace(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { name } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Workspace name is required and cannot be empty." });
      return;
    }

    const workspace = await workspaceService.updateWorkspaceName(workspaceId, name);
    res.status(HttpStatusCode.Ok).send({ message: "Workspace updated successfully.", workspace });
    return;
  } catch (error: any) {
    if (error.message === "INVALID_ID" || error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }
    if (error.message === "WORKSPACE_NAME_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "A workspace with that name already exists." });
      return;
    }
    console.error("updateWorkspace error:", error);
    next(error);
  }
}

// ── Users within a workspace ──────────────────────────────────

export async function listUsers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const users = await workspaceService.listUsersByWorkspace(workspaceId);
    res.status(HttpStatusCode.Ok).send({ message: "Users retrieved successfully.", users });
    return;
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace ID." });
      return;
    }
    console.error("listUsers error:", error);
    next(error);
  }
}

export async function createUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { name, email, password, role, phoneNumber, phoneExtension } = req.body;

    if (!email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Email is required." });
      return;
    }
    if (password && password.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Password must be at least 8 characters." });
      return;
    }
    if (!["admin", "colaborador"].includes(role)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Role must be 'admin' or 'colaborador'." });
      return;
    }

    const user = await workspaceService.createUser({ name, email, password, role, workspaceId, phoneNumber, phoneExtension });
    res.status(HttpStatusCode.Created).send({ message: "User created successfully.", user });
    return;
  } catch (error: any) {
    if (error.message === "PASSWORD_REQUIRED") {
      res.status(HttpStatusCode.BadRequest).send({ message: "La contraseña es requerida para usuarios nuevos." });
      return;
    }
    if (error.message === "EMAIL_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "El usuario ya existe en este entorno." });
      return;
    }
    if (error.message === "WORKSPACE_NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }
    console.error("createUser error:", error);
    next(error);
  }
}

export async function updateUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const userId = req.params["userId"] as string;
    const { name, email, password, role, phoneNumber, phoneExtension } = req.body;

    if (!name && !email && !password && !role) {
      res.status(HttpStatusCode.BadRequest).send({ message: "At least one field is required to update." });
      return;
    }
    if (password && password.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Password must be at least 8 characters." });
      return;
    }
    if (role && !["admin", "colaborador"].includes(role)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Role must be 'admin' or 'colaborador'." });
      return;
    }

    const user = await workspaceService.updateUser(workspaceId, userId, { name, email, password, role, phoneNumber, phoneExtension });
    res.status(HttpStatusCode.Ok).send({ message: "User updated successfully.", user });
    return;
  } catch (error: any) {
    if (error.message === "EMAIL_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "Email is already in use." });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }
    console.error("updateUser error:", error);
    next(error);
  }
}

export async function deleteUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const userId = req.params["userId"] as string;

    await workspaceService.deleteUser(workspaceId, userId);
    res.status(HttpStatusCode.Ok).send({ message: "User deleted successfully." });
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }
    console.error("deleteUser error:", error);
    next(error);
  }
}
