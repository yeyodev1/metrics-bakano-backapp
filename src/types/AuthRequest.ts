import { Request } from "express";

export interface JwtPayload {
  _id: string;
  email: string;
  role: "superadmin" | "user" | "admin" | "colaborador";
  isInternal?: boolean;
  internalRole?: string;
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
