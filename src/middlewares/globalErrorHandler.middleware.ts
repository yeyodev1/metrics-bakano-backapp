import { Request, Response, NextFunction } from "express";
import { ErrorHandler } from "../errors/errorHandler.error";

const slackWebhookUrl = process.env.SLACK_ERROR_WEBHOOK || "";

/**
 * Errores de dominio que se lanzan como `new Error("CODIGO")` en los servicios.
 * Si un controlador no los traduce, acá se vuelven 4xx en vez de 500: son
 * culpa de la petición, no del servidor, y no deben disparar alertas.
 */
const DOMAIN_ERRORS: Record<string, { status: number; message: string }> = {
  MOTIVO_REQUERIDO: { status: 400, message: "Indica el motivo: es obligatorio." },
  INVALID_ID: { status: 400, message: "Identificador inválido." },
  NOT_FOUND: { status: 404, message: "Recurso no encontrado." },
};

export function globalErrorHandler(error: any, req: Request, res: Response, _next: NextFunction) {
  const handler = new ErrorHandler(slackWebhookUrl);
  const domain = typeof error?.message === "string" ? DOMAIN_ERRORS[error.message] : undefined;
  const status = error.status || domain?.status || 500;
  const message = domain?.message || error.message || "Internal Server Error";

  handler.handleHttpError(res, message, status, error);
}
