import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Validates that the user has administrative access to the workspace in req.params.
 * Superadmin can access any workspace.
 * Admin can only access their assigned workspace.
 * Collaborators are DENIED.
 */
export function workspaceAdminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const { role, workspaceId: userWsId } = req.user || {};
  const { workspaceId: paramWsId } = req.params;

  // 1. Superadmin has full access everywhere
  if (role === "superadmin") {
    return next();
  }

  // 2. Admin has access ONLY if it matches their assigned workspace
  if (role === "admin" && userWsId && userWsId.toString() === paramWsId) {
    return next();
  }

  // 3. Anyone else (Collaborators or wrong workspace) is denied
  res.status(HttpStatusCode.Forbidden).send({
    message: "Access denied. Administrative permissions required for this workspace.",
  });
}
