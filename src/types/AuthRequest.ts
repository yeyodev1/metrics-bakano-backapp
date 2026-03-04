import { Request } from "express";

export interface JwtPayload {
  _id: string;
  email: string;
  role: "superadmin" | "user";
}

export interface AuthRequest extends Request {
  user?: JwtPayload;
}
