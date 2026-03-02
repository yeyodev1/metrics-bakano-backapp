import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { WorkspaceService } from "../services/workspace.service";

const workspaceService = new WorkspaceService();

// ── Workspaces ────────────────────────────────────────────────

export async function createWorkspace(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { name } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Workspace name is required.",
      });
      return;
    }

    const workspace = await workspaceService.createWorkspace({ name });

    res.status(HttpStatusCode.Created).send({
      message: "Workspace created successfully.",
      workspace,
    });
    return;
  } catch (error: any) {
    if (error.message === "WORKSPACE_NAME_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({
        message: "A workspace with that name already exists.",
      });
      return;
    }
    console.error("createWorkspace error:", error);
    next(error);
  }
}

export async function listWorkspaces(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaces = await workspaceService.listWorkspaces();

    res.status(HttpStatusCode.Ok).send({
      message: "Workspaces retrieved successfully.",
      workspaces,
    });
    return;
  } catch (error) {
    console.error("listWorkspaces error:", error);
    next(error);
  }
}

export async function getWorkspace(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.params["workspaceId"] as string;

    const workspace = await workspaceService.getWorkspaceById(workspaceId);

    res.status(HttpStatusCode.Ok).send({
      message: "Workspace retrieved successfully.",
      workspace,
    });
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

// ── Admins ────────────────────────────────────────────────────

export async function createAdmin(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Email and password are required.",
      });
      return;
    }

    if (password.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Password must be at least 8 characters.",
      });
      return;
    }

    const admin = await workspaceService.createAdmin({ email, password, workspaceId });

    res.status(HttpStatusCode.Created).send({
      message: "Admin created successfully.",
      admin,
    });
    return;
  } catch (error: any) {
    if (error.message === "EMAIL_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "Email is already in use." });
      return;
    }
    if (error.message === "WORKSPACE_NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }
    console.error("createAdmin error:", error);
    next(error);
  }
}

export async function listAdmins(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.params["workspaceId"] as string;

    const admins = await workspaceService.listAdminsByWorkspace(workspaceId);

    res.status(HttpStatusCode.Ok).send({
      message: "Admins retrieved successfully.",
      admins,
    });
    return;
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace ID." });
      return;
    }
    console.error("listAdmins error:", error);
    next(error);
  }
}
