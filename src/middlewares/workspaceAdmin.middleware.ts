import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";

/**
 * Validates that the user has administrative access to the workspace in req.params.
 * Superadmin can access any workspace.
 * Admin can only access workspaces they belong to as 'admin'.
 */
export async function workspaceAdminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const { role, _id } = req.user || {};
  const { workspaceId: paramWsId } = req.params;

  if (role === "superadmin") {
    next();
    return;
  }

  if (!_id) {
    res.status(HttpStatusCode.Unauthorized).send({ message: "No user ID found." });
    return;
  }

  try {
    const user = await models.users.findById(_id).lean();
    if (!user || !user.isActive) {
      res.status(HttpStatusCode.Forbidden).send({ message: "User not found or inactive." });
      return;
    }

    const isLegacyAdmin = user.role === "superadmin" || user.role === "admin";
    const hasAdminAccess = user.workspaces?.some(
      (ws) => ws.workspaceId.toString() === paramWsId && ws.role === "admin"
    ) || (user.workspaceId && user.workspaceId.toString() === paramWsId && isLegacyAdmin);

    if (hasAdminAccess) {
      next();
      return;
    }

    res.status(HttpStatusCode.Forbidden).send({
      message: "Access denied. Administrative permissions required for this workspace.",
    });
  } catch (error) {
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error verifying admin access" });
  }
}

