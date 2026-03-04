import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";

/**
 * Validates that the user has access to the workspace in req.params.
 * Superadmin can access any workspace.
 * Admin or Colaborador can only access workspaces they belong to.
 */
export async function workspaceAccessMiddleware(
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

    const hasAccess = user.workspaces?.some(
      (ws) => ws.workspaceId.toString() === paramWsId
    ) || (user.workspaceId && user.workspaceId.toString() === paramWsId);

    if (hasAccess) {
      next();
      return;
    }

    res.status(HttpStatusCode.Forbidden).send({
      message: "Access denied. You don't have permission for this workspace.",
    });
  } catch (error) {
    res.status(HttpStatusCode.InternalServerError).send({ message: "Error verifying access" });
  }
}
