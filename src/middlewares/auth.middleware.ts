import { Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { AuthRequest, JwtPayload } from "../types/AuthRequest";
import models from "../models";

/**
 * Valida el JWT y deja `req.user` con los datos del usuario.
 *
 * `isInternal`, `internalRole` y `role` se leen de la base, no del token. El
 * token dura 14 días: cuando a alguien lo convertían en colaborador interno
 * (o le cambiaban el rol), su sesión seguía diciendo "cliente" hasta que
 * volvía a entrar, y los middlewares de equipo interno lo rechazaban aunque
 * la base ya estuviera bien. Un usuario desactivado tampoco debe seguir
 * entrando con un token vigente.
 *
 * Si la consulta falla se usan los claims del token: peor tener datos de
 * hace unos días que tumbar toda la API por un parpadeo de Mongo.
 */
export async function authMiddleware(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  let token = "";

  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  } else if (req.query.token) {
    token = req.query.token as string;
  }

  if (!token) {
    res.status(401).json({ message: "No token provided" });
    return;
  }

  let decoded: any;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || "default_jwt_secret_key");
  } catch (error) {
    res.status(401).json({ message: "Invalid or expired token" });
    return;
  }

  // Normalize id to _id for compatibility with different token sources
  if (decoded.id && !decoded._id) {
    decoded._id = decoded.id;
  }

  try {
    const fresh = await models.users
      .findById(decoded._id)
      .select("role isInternal internalRole isActive")
      .lean<{ role?: string; isInternal?: boolean; internalRole?: string; isActive?: boolean }>();

    if (fresh) {
      if (fresh.isActive === false) {
        res.status(401).json({ message: "Usuario desactivado." });
        return;
      }
      decoded.role = fresh.role ?? decoded.role;
      decoded.isInternal = fresh.isInternal === true;
      decoded.internalRole = fresh.internalRole ?? null;
    }
  } catch (error) {
    console.error("[authMiddleware] no se pudo refrescar el usuario, se usan los claims del token:", (error as Error).message);
  }

  req.user = decoded as JwtPayload;
  next();
}
