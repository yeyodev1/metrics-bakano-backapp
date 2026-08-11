import { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import crypto from "crypto";

export function financeKeyMiddleware(req: Request, res: Response, next: NextFunction) {
  const expectedKey = process.env.FINANCE_API_KEY;

  if (!expectedKey) {
    res.status(HttpStatusCode.ServiceUnavailable).json({ message: "Integración de finanzas no configurada" });
    return;
  }

  const providedKey = req.headers["x-finance-key"];

  if (typeof providedKey !== "string" || providedKey.length !== expectedKey.length) {
    res.status(HttpStatusCode.Unauthorized).json({ message: "Clave de integración inválida" });
    return;
  }

  const isValid = crypto.timingSafeEqual(Buffer.from(providedKey), Buffer.from(expectedKey));

  if (!isValid) {
    res.status(HttpStatusCode.Unauthorized).json({ message: "Clave de integración inválida" });
    return;
  }

  next();
}
