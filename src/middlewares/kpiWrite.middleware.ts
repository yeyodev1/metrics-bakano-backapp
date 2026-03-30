import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Allows KPI write access to:
 *  - superadmin
 *  - internal users with internalRole: 'editor' or 'director'
 * Project Manager, Producer, etc. are read-only.
 */
export function kpiWriteMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const { role, isInternal, internalRole } = req.user || {};

  const isSuperadmin = role === "superadmin";
  const isEditor = isInternal === true && internalRole === "editor";
  const isDirector = isInternal === true && internalRole === "director";

  if (isSuperadmin || isEditor || isDirector) {
    return next();
  }

  res.status(HttpStatusCode.Forbidden).send({
    message: "Access denied. Only Editor, Director, or Superadmin can write KPI records.",
  });
}
