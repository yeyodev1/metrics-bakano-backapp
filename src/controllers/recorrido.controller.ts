import type { Response } from "express";
import { HttpStatusCode } from "axios";
import type { AuthRequest } from "../types/AuthRequest";
import { recorridoClienteService, type EstadoEtapa, type EtapaCliente } from "../services/recorridoCliente.service";
import { puedeMarcarPaso } from "../services/permisoOnboarding.service";
import { RECORRIDO, type EtapaRecorrido } from "../services/onboardingSesiones.service";

/** Cada etapa dice si quien mira la puede marcar: su responsable, Genesis o un superadmin. */
function conPermisos(req: AuthRequest, etapas: EtapaCliente[]) {
  return etapas.map((e) => ({ ...e, puedoMarcar: puedeMarcarPaso(req.user, [e.responsableEmail]) }));
}

/**
 * El recorrido del cliente para el equipo: verlo entero y mover las etapas
 * que no dejan rastro solas (avatares, escenas, aprobacion de videos y salida
 * a ventas). Las demas se deducen de los datos y no se pueden forzar aqui.
 */

export async function verRecorrido(req: AuthRequest, res: Response) {
  try {
    const r = await recorridoClienteService.de(req.params["workspaceId"] as string);
    res.status(HttpStatusCode.Ok).send({ ...r, etapas: conPermisos(req, r.etapas) });
  } catch (error: any) {
    console.error("verRecorrido error:", error?.message || error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo cargar el recorrido." });
  }
}

export async function marcarEtapa(req: AuthRequest, res: Response) {
  try {
    const { estado, nota } = req.body as { estado: EstadoEtapa; nota?: string };
    const etapa = RECORRIDO[req.params["etapa"] as EtapaRecorrido];
    if (etapa && !puedeMarcarPaso(req.user, [etapa.responsable?.email])) {
      res.status(HttpStatusCode.Forbidden).send({
        message: `Esta etapa la marca ${etapa.responsable?.nombre ?? "su responsable"} o un superadmin.`,
      });
      return;
    }
    const quien = { nombre: (req.user as any)?.name || (req.user as any)?.email || "Equipo Bakano", userId: req.user?._id as any };
    const r = await recorridoClienteService.marcar(
      req.params["workspaceId"] as string,
      req.params["etapa"] as string,
      estado,
      quien,
      nota
    );
    if (!r.ok) {
      const mensajes: Record<string, string> = {
        etapa_desconocida: "Esa etapa no existe.",
        estado_invalido: "Ese estado no es válido.",
      };
      res.status(HttpStatusCode.BadRequest).send({ message: mensajes[r.motivo || ""] || "No se pudo marcar." });
      return;
    }
    const actualizado = await recorridoClienteService.de(req.params["workspaceId"] as string);
    res.status(HttpStatusCode.Ok).send({ message: "Etapa actualizada.", ...actualizado, etapas: conPermisos(req, actualizado.etapas) });
  } catch (error: any) {
    console.error("marcarEtapa error:", error?.message || error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo marcar la etapa." });
  }
}
