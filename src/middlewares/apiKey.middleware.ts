import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";

export async function apiKeyMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const apiKey = req.headers["x-api-key"] as string;

  if (!apiKey) {
    res.status(HttpStatusCode.Unauthorized).json({ message: "API key required. Include x-api-key header." });
    return;
  }

  const user = await models.users.findOne({ apiKey, role: "superadmin", isActive: true }).lean();

  if (!user) {
    res.status(HttpStatusCode.Unauthorized).json({ message: "Invalid or revoked API key." });
    return;
  }

  req.user = {
    _id: user._id.toString(),
    email: user.email,
    role: user.role,
    isInternal: user.isInternal,
    internalRole: user.internalRole,
  };

  next();
}
