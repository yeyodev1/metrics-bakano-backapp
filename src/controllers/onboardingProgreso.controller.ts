import type { Response } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import type { AuthRequest } from "../types/AuthRequest";
import { onboardingProgresoService, PASOS, type ProgresoEntorno } from "../services/onboardingProgreso.service";
import type { PasoOnboarding } from "../models/onboardingEvento.model";
import type { EstadoSesionOnboarding } from "../models/workspace.model";

const ESTADOS: EstadoSesionOnboarding[] = ["pendiente", "agendada", "cumplida", "bloqueada", "no_aplica"];

/** Cada paso dice si quien mira lo puede marcar, para no ofrecerle botones que no le tocan. */
function conPermisos(req: AuthRequest, progreso: ProgresoEntorno): ProgresoEntorno {
  return {
    ...progreso,
    pasos: progreso.pasos.map((p) => ({ ...p, puedoMarcar: onboardingProgresoService.puedeMarcar(req.user, p.paso) })),
  };
}

// GET /api/onboarding-progreso?bloqueados=1&pendientes=1
export async function listarProgreso(req: AuthRequest, res: Response): Promise<void> {
  const progresos = await onboardingProgresoService.resumen({
    soloBloqueados: req.query.bloqueados === "1",
    soloPendientes: req.query.pendientes === "1",
  });
  res.status(HttpStatusCode.Ok).json({
    total: progresos.length,
    bloqueados: progresos.filter((p) => p.bloqueado).length,
    progresos: progresos.map((p) => conPermisos(req, p)),
  });
}

// GET /api/onboarding-progreso/:workspaceId
export async function detalleProgreso(req: AuthRequest, res: Response): Promise<void> {
  const { workspaceId } = req.params as { workspaceId: string };
  if (!Types.ObjectId.isValid(workspaceId)) {
    res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
    return;
  }
  const detalle = await onboardingProgresoService.detalle(workspaceId);
  if (!detalle) {
    res.status(HttpStatusCode.NotFound).json({ message: "Entorno no encontrado." });
    return;
  }
  res.status(HttpStatusCode.Ok).json({ ...detalle, progreso: conPermisos(req, detalle.progreso) });
}

// PATCH /api/onboarding-progreso/:workspaceId/:paso
export async function marcarPaso(req: AuthRequest, res: Response): Promise<void> {
  const { workspaceId, paso } = req.params as { workspaceId: string; paso: PasoOnboarding };
  const { estado, motivo, nota, pendienteDelCliente } = req.body ?? {};

  if (!Types.ObjectId.isValid(workspaceId) || !PASOS.includes(paso)) {
    res.status(HttpStatusCode.BadRequest).json({ message: "Entorno o paso inválido." });
    return;
  }
  if (!ESTADOS.includes(estado)) {
    res.status(HttpStatusCode.BadRequest).json({ message: `Estado inválido. Usa: ${ESTADOS.join(", ")}.` });
    return;
  }
  if (!onboardingProgresoService.puedeMarcar(req.user, paso)) {
    res.status(HttpStatusCode.Forbidden).json({
      message: "Este paso lo marca su responsable o un superadmin. Si hay que moverlo, pídeselo a ellos.",
    });
    return;
  }

  try {
    const progreso = await onboardingProgresoService.marcar(workspaceId, paso, {
      estado,
      motivo,
      nota,
      pendienteDelCliente,
      porId: String(req.user!._id),
      porNombre: (req.user as any)?.name || (req.user as any)?.email || "Equipo",
    });
    res.status(HttpStatusCode.Ok).json({ progreso: conPermisos(req, progreso) });
  } catch (error: any) {
    if (error.message === "MOTIVO_REQUERIDO") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Para marcar como bloqueada hay que escribir el motivo." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Entorno no encontrado." });
      return;
    }
    console.error("marcarPaso error:", error);
    res.status(HttpStatusCode.InternalServerError).json({ message: "No se pudo guardar el avance." });
  }
}

// POST /api/onboarding-progreso/:workspaceId/:paso/recordar
export async function recordarPaso(req: AuthRequest, res: Response): Promise<void> {
  const { workspaceId, paso } = req.params as { workspaceId: string; paso: PasoOnboarding };
  if (!Types.ObjectId.isValid(workspaceId) || !PASOS.includes(paso)) {
    res.status(HttpStatusCode.BadRequest).json({ message: "Entorno o paso inválido." });
    return;
  }
  const { enviado } = await onboardingProgresoService.recordarAlCliente(workspaceId, paso, req.body?.texto);
  res.status(HttpStatusCode.Ok).json({
    enviado,
    message: enviado
      ? "Recordatorio enviado por Telegram."
      : "No se envió: el cliente no tiene Telegram conectado o no hay nada pendiente escrito.",
  });
}
