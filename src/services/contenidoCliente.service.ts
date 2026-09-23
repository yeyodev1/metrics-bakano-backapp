import { Types } from "mongoose";
import models from "../models";

/**
 * Cuanto contenido le queda al cliente por grabar.
 *
 * La produccion no se agenda "porque toca cada dos meses": se agenda antes de
 * quedarnos sin nada que grabar. Cuando ya se grabo todo lo escrito, el
 * cliente entra en cuenta regresiva: lo que queda es material en edicion y,
 * cuando se acabe, no hay de donde sacar mas sin una grabacion nueva.
 *
 * La cuenta se hace sobre los guiones POR GRABAR y no sobre "publicado":
 * publicado y editado casi no se marcan en Metrics (19 y 130 items de ~2.765
 * al 23/09/2026), asi que tomar esa señal daria un numero inventado. Esto se
 * mide con lo que el equipo si mantiene al dia.
 */

/** Por debajo de esto se avisa: no se espera a llegar a cero. */
export const RESERVA_BAJA = 8;
export const RESERVA_CRITICA = 3;

export interface ReservaContenido {
  /** Guiones escritos que todavia no se graban: es la reserva real. */
  porGrabar: number;
  /** Ya grabados y en cola de edicion. */
  enEdicion: number;
  /** Editados listos para salir. */
  listosParaPublicar: number;
  nivel: "sin_contenido" | "critica" | "baja" | "ok";
  proximaProduccion?: Date;
  ultimaProduccion?: Date;
}

class ContenidoClienteService {
  async reserva(workspaceId: Types.ObjectId | string): Promise<ReservaContenido> {
    const ahora = new Date();
    const [planes, proxima, ultima] = await Promise.all([
      models.videoPlanning.find({ workspaceId }).select("items").lean(),
      models.planning
        .findOne({ workspaceId, date: { $gte: ahora }, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } })
        .sort({ date: 1 })
        .select("date")
        .lean(),
      models.planning
        .findOne({ workspaceId, date: { $lt: ahora }, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } })
        .sort({ date: -1 })
        .select("date")
        .lean(),
    ]);

    let porGrabar = 0;
    let enEdicion = 0;
    let listosParaPublicar = 0;
    for (const plan of planes as any[]) {
      for (const item of plan.items || []) {
        if (item.estadoIdea === "RECHAZADO" || item.estadoProduccion === "RECHAZADO" || item.edicion === "RECHAZADO") continue;
        if (item.estadoPublicacion === "PUBLICADO") continue;
        if (item.estadoProduccion !== "GRABADO") porGrabar++;
        else if (item.edicion === "EDITADO") listosParaPublicar++;
        else enEdicion++;
      }
    }

    const nivel: ReservaContenido["nivel"] =
      porGrabar === 0 ? "sin_contenido" : porGrabar <= RESERVA_CRITICA ? "critica" : porGrabar <= RESERVA_BAJA ? "baja" : "ok";

    return { porGrabar, enEdicion, listosParaPublicar, nivel, proximaProduccion: proxima?.date, ultimaProduccion: ultima?.date };
  }

  /**
   * Se esta acabando y no hay grabacion en el calendario. Es lo unico que
   * justifica saltarse la espera entre producciones: si no hay que grabar, no
   * hay nada que publicar despues.
   */
  seAcaba(r: ReservaContenido): boolean {
    return !r.proximaProduccion && r.nivel !== "ok";
  }

  /** La reserva en palabras, para el chat y para el prompt de la IA. */
  enTexto(r: ReservaContenido): string {
    const cola =
      r.enEdicion || r.listosParaPublicar
        ? `\n     Mientras tanto tienes ${r.enEdicion} en edición y ${r.listosParaPublicar} listo${r.listosParaPublicar === 1 ? "" : "s"} para publicar.`
        : "";
    if (r.nivel === "sin_contenido") {
      return `⚠️ <b>Ya grabamos todo lo que estaba escrito</b>: no te quedan guiones por grabar.${cola}`;
    }
    if (r.nivel === "critica" || r.nivel === "baja") {
      return `⏳ Te quedan <b>${r.porGrabar} guion${r.porGrabar === 1 ? "" : "es"}</b> por grabar: se está acabando el contenido.${cola}`;
    }
    return `✅ Te quedan <b>${r.porGrabar} guiones</b> por grabar.${cola}`;
  }
}

export const contenidoClienteService = new ContenidoClienteService();
