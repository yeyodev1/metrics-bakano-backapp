import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Validates that the user has access to the workspace in req.params.
 * Superadmin can access any workspace.
 * Admin can only access their own workspace.
 */
export function workspaceAccessMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const { role, workspaceId: userWsId } = req.user || {};
  const { workspaceId: paramWsId } = req.params;

  if (role === "superadmin") {
    return next();
  }

  if (role === "admin" && userWsId && userWsId.toString() === paramWsId) {
    return next();
  }

  res.status(HttpStatusCode.Forbidden).send({
    message: "Access denied. You don't have permission for this workspace.",
  });
}
