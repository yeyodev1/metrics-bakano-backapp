import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Allows only users that are superadmin OR internal collaborators (isInternal: true).
 * Must be placed AFTER authMiddleware in the middleware chain.
 */
export function internalOrSuperadminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const { role, isInternal } = req.user || {};

  if (role === "superadmin" || isInternal === true) {
    next();
    return;
  }

  res.status(HttpStatusCode.Forbidden).send({
    message: "Access denied. Internal collaborator or superadmin role required.",
  });
}
