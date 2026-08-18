import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { flagsService } from "../services/flags.service";
import type { EtapaRevision } from "../models/reviewEvent.model";

/**
 * Periodo por defecto: el mes en curso. Las banderas miden el ciclo mensual
 * de planificaciones; sin filtro explicito lo natural es "como vamos este mes".
 */
function parsePeriod(req: AuthRequest): { from: Date; to: Date } {
  const now = new Date();
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), 1);
  const from = req.query.from ? new Date(String(req.query.from)) : defaultFrom;
  const to = req.query.to ? new Date(String(req.query.to)) : now;
  if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new Error("INVALID_DATE");
  // `to` sin hora significa "ese dia completo".
  if (typeof req.query.to === "string" && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to)) {
    to.setUTCHours(23, 59, 59, 999);
  }
  return { from, to };
}

// ── GET /flags/clients?from&to ─────────────────────────────────────────────
export async function getClientFlags(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to } = parsePeriod(req);
    const clientes = await flagsService.clientFlags(from, to);
    res.status(HttpStatusCode.Ok).json({ from, to, clientes });
  } catch (error: any) {
    if (error.message === "INVALID_DATE") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Fechas inválidas." });
      return;
    }
    console.error("getClientFlags error:", error);
    next(error);
  }
}

// ── GET /flags/collaborators?from&to ───────────────────────────────────────
export async function getCollaboratorFlags(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to } = parsePeriod(req);
    const colaboradores = await flagsService.collaboratorFlags(from, to);
    res.status(HttpStatusCode.Ok).json({ from, to, colaboradores });
  } catch (error: any) {
    if (error.message === "INVALID_DATE") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Fechas inválidas." });
      return;
    }
    console.error("getCollaboratorFlags error:", error);
    next(error);
  }
}

// ── GET /flags/collaborators/:userId?etapa&from&to ─────────────────────────
export async function getCollaboratorDetail(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { from, to } = parsePeriod(req);
    const { userId } = req.params as { userId: string };
    const etapa = req.query.etapa ? (String(req.query.etapa) as EtapaRevision) : undefined;
    if (etapa && etapa !== "contenido" && etapa !== "edicion") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Etapa inválida." });
      return;
    }
    const detail = await flagsService.collaboratorDetail(userId, etapa, from, to);
    res.status(HttpStatusCode.Ok).json({ from, to, ...detail });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "ID de colaborador inválido." });
      return;
    }
    if (error.message === "INVALID_DATE") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Fechas inválidas." });
      return;
    }
    console.error("getCollaboratorDetail error:", error);
    next(error);
  }
}
