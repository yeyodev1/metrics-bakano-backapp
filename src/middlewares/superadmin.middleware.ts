import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";

/**
 * Allows only users with role 'superadmin'.
 * Must be placed AFTER authMiddleware in the middleware chain.
 */
export function superadminMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  if (req.user?.role !== "superadmin") {
    res.status(HttpStatusCode.Forbidden).send({
      message: "Access denied. Superadmin role required.",
    });
    return;
  }
  next();
}
