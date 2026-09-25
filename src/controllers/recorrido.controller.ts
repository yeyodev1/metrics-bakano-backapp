import type { Response } from "express";
import { HttpStatusCode } from "axios";
import type { AuthRequest } from "../types/AuthRequest";
import { recorridoClienteService, type EstadoEtapa } from "../services/recorridoCliente.service";

/**
 * El recorrido del cliente para el equipo: verlo entero y mover las etapas
 * que no dejan rastro solas (avatares, escenas, aprobacion de videos y salida
 * a ventas). Las demas se deducen de los datos y no se pueden forzar aqui.
 */

export async function verRecorrido(req: AuthRequest, res: Response) {
  try {
    const r = await recorridoClienteService.de(req.params["workspaceId"] as string);
    res.status(HttpStatusCode.Ok).send(r);
  } catch (error: any) {
    console.error("verRecorrido error:", error?.message || error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo cargar el recorrido." });
  }
}

export async function marcarEtapa(req: AuthRequest, res: Response) {
  try {
    const { estado, nota } = req.body as { estado: EstadoEtapa; nota?: string };
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
    res.status(HttpStatusCode.Ok).send({ message: "Etapa actualizada.", ...actualizado });
  } catch (error: any) {
    console.error("marcarEtapa error:", error?.message || error);
    res.status(HttpStatusCode.InternalServerError).send({ message: "No se pudo marcar la etapa." });
  }
}
