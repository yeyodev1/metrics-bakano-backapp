import { Request } from "express";

export interface JwtPayload {
  _id: string;
  email: string;
  role: "superadmin" | "admin" | "colaborador";
  workspaceId?: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
