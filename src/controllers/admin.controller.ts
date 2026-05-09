import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import crypto from "crypto";
import { AuthRequest } from "../types/AuthRequest";
import { WorkspaceService } from "../services/workspace.service";
import { InternalRole } from "../models/user.model";
import models from "../models";

const VALID_INTERNAL_ROLES: InternalRole[] = [
  'director', 'estratega', 'project_manager', 'content_manager', 'account_manager',
  'community_manager', 'productor', 'asistente_produccion', 'editor',
  'disenador', 'copywriter', 'analista', 'desarrollador', 'trafficker',
];

const workspaceService = new WorkspaceService();

export async function listSuperadmins(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const admins = await workspaceService.listSuperadmins();

    res.status(HttpStatusCode.Ok).send({
      message: "Superadmins retrieved successfully.",
      admins,
    });
    return;
  } catch (error) {
    console.error("listSuperadmins error:", error);
    next(error);
  }
}

export async function createSuperadmin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name, email, password } = req.body;

    if (!email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Email is required." });
      return;
    }
    if (!password || password.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Password must be at least 8 characters." });
      return;
    }

    const user = await workspaceService.createSuperadmin({ name, email, password });

    res.status(HttpStatusCode.Created).send({
      message: "Superadmin created successfully.",
      user,
    });
    return;
  } catch (error: any) {
    if (error.message === "EMAIL_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "An account with that email already exists." });
      return;
    }
    console.error("createSuperadmin error:", error);
    next(error);
  }
}

export async function deleteSuperadmin(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const requestingUserId = req.user!._id.toString();
    const userId = req.params["userId"] as string;

    await workspaceService.deleteSuperadmin(requestingUserId, userId);

    res.status(HttpStatusCode.Ok).send({ message: "Superadmin deleted successfully." });
    return;
  } catch (error: any) {
    if (error.message === "CANNOT_DELETE_SELF") {
      res.status(HttpStatusCode.BadRequest).send({ message: "You cannot delete your own superadmin account." });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Superadmin not found." });
      return;
    }
    console.error("deleteSuperadmin error:", error);
    next(error);
  }
}

export async function listInternalUsers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const users = await workspaceService.listInternalUsers();
    res.status(HttpStatusCode.Ok).send({ message: "Internal users retrieved successfully.", users });
    return;
  } catch (error) {
    console.error("listInternalUsers error:", error);
    next(error);
  }
}

export async function createInternalUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { name, email, password, internalRole } = req.body;

    if (!email) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Email is required." });
      return;
    }
    if (!password || password.length < 8) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Password must be at least 8 characters." });
      return;
    }
    if (!internalRole || !VALID_INTERNAL_ROLES.includes(internalRole)) {
      res.status(HttpStatusCode.BadRequest).send({
        message: `internalRole is required and must be one of: ${VALID_INTERNAL_ROLES.join(', ')}.`,
      });
      return;
    }

    const user = await workspaceService.createInternalUser({ name, email, password, internalRole });
    res.status(HttpStatusCode.Created).send({ message: "Internal user created successfully.", user });
    return;
  } catch (error: any) {
    if (error.message === "EMAIL_TAKEN") {
      res.status(HttpStatusCode.Conflict).send({ message: "An account with that email already exists." });
      return;
    }
    console.error("createInternalUser error:", error);
    next(error);
  }
}

export async function deleteInternalUser(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const requestingUserId = req.user!._id.toString();
    const userId = req.params["userId"] as string;

    await workspaceService.deleteInternalUser(requestingUserId, userId);
    res.status(HttpStatusCode.Ok).send({ message: "Internal user deleted successfully." });
    return;
  } catch (error: any) {
    if (error.message === "CANNOT_DELETE_SELF") {
      res.status(HttpStatusCode.BadRequest).send({ message: "You cannot delete your own account." });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Internal user not found." });
      return;
    }
    console.error("deleteInternalUser error:", error);
    next(error);
  }
}

export async function getApiKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!._id.toString();
    const user = await models.users.findById(userId).lean();

    if (!user?.apiKey) {
      res.status(HttpStatusCode.Ok).json({ apiKey: null, apiKeyCreatedAt: null });
      return;
    }

    const masked = `bkn_${"•".repeat(Math.max(0, user.apiKey.length - 8))}${user.apiKey.slice(-8)}`;
    res.status(HttpStatusCode.Ok).json({ apiKey: masked, apiKeyCreatedAt: user.apiKeyCreatedAt });
  } catch (error) {
    next(error);
  }
}

export async function generateApiKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!._id.toString();
    const newKey = `bkn_${crypto.randomBytes(32).toString("hex")}`;
    const now = new Date();

    await models.users.findByIdAndUpdate(userId, { apiKey: newKey, apiKeyCreatedAt: now });

    res.status(HttpStatusCode.Ok).json({
      message: "API key generated. Save it now — it will not be shown again in full.",
      apiKey: newKey,
      apiKeyCreatedAt: now,
    });
  } catch (error) {
    next(error);
  }
}

export async function revokeApiKey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!._id.toString();
    await models.users.findByIdAndUpdate(userId, { $unset: { apiKey: 1, apiKeyCreatedAt: 1 } });
    res.status(HttpStatusCode.Ok).json({ message: "API key revoked successfully." });
  } catch (error) {
    next(error);
  }
}
