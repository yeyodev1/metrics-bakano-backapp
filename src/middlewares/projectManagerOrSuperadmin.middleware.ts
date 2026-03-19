import { Response, NextFunction } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { HttpStatusCode } from "axios";

export function projectManagerOrSuperadminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  const isSuperadmin = req.user?.role === "superadmin";
  const isProjectManager =
    req.user?.isInternal === true && req.user?.internalRole === "project_manager";
  const isContentManager =
    req.user?.isInternal === true && req.user?.internalRole === "content_manager";

  if (isSuperadmin || isProjectManager || isContentManager) {
    return next();
  }

  res.status(HttpStatusCode.Forbidden).send({
    message: "Acceso restringido a Content Manager, Project Manager y Superadmin.",
  });
}
