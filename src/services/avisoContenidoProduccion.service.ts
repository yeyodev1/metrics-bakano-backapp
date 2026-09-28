import { Types } from "mongoose";
import models from "../models";
import { notificationService } from "./notification.service";
import { resendService } from "./resend.service";
import { equipoAtencionService } from "./equipoAtencion.service";

export type CambioProduccion = "movida" | "agendada" | "cancelada";

function fechaEcuador(d: Date): string {
  return new Date(d).toLocaleString("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
}

function horasDeCorreccion(): number {
  const n = Number(process.env.GUION_CORRECCION_HORAS);
  return Number.isFinite(n) && n > 0 ? n : 48;
}

/**
 * Producción agenda la grabación, pero los videos (guiones aprobados y listos
 * para grabar) son de contenido. Cada vez que una producción se agenda, se
 * mueve o se cancela, Ariana y la content manager del cliente se enteran con
 * lo que falta, para que la fecha nueva no las agarre sin guiones.
 */
class AvisoContenidoProduccionService {
  /** Ariana (guiones) + content managers asignadas al entorno; si no hay, todas. */
  private async destinatarios(workspaceId: Types.ObjectId) {
    const deEntorno = await models.users
      .find({
        isActive: { $ne: false },
        isInternal: true,
        internalRole: "content_manager",
        $or: [{ workspaceId }, { "workspaces.workspaceId": workspaceId }],
      })
      .select("_id email")
      .lean();
    const content = deEntorno.length
      ? deEntorno
      : await models.users.find({ isActive: { $ne: false }, isInternal: true, internalRole: "content_manager" }).select("_id email").lean();
    const vistos = new Set<string>();
    return [...(await equipoAtencionService.usuarios("guiones")), ...content].filter((u: any) => {
      const id = String(u._id);
      if (vistos.has(id)) return false;
      vistos.add(id);
      return true;
    }) as { _id: Types.ObjectId; email: string }[];
  }

  /** Nunca rompe a quien llama: si el aviso falla, el cambio de fecha ya quedó. */
  async avisar(params: {
    entryId: Types.ObjectId | string;
    tipo: CambioProduccion;
    fechaAnterior?: Date;
    porNombre?: string;
  }): Promise<void> {
    try {
      const entry: any = await models.planning.findById(params.entryId).select("workspaceId title date").lean();
      if (!entry) return;
      const [workspace, vp, para] = await Promise.all([
        models.workspaces.findById(entry.workspaceId).select("name").lean(),
        models.videoPlanning
          .findOne({ planningEntryId: entry._id })
          .select("items.estadoProduccion items.clienteAprobacion clienteAprobado")
          .lean(),
        this.destinatarios(entry.workspaceId),
      ]);
      if (!para.length) return;

      const nombre = (workspace as any)?.name || "Cliente";
      const cuando = fechaEcuador(entry.date);
      const items: any[] = (vp as any)?.items ?? [];
      const aprobados = (vp as any)?.clienteAprobado ? items.length : items.filter((i) => i.clienteAprobacion === "APROBADO").length;
      const limite = new Date(new Date(entry.date).getTime() - horasDeCorreccion() * 3_600_000);

      const estadoGuiones =
        params.tipo === "cancelada"
          ? undefined
          : !items.length
            ? "Todavía no hay guiones cargados para esta producción."
            : `${items.length} guiones cargados, ${aprobados} aprobados por el cliente.`;
      const pendiente =
        params.tipo === "cancelada"
          ? "Si tenía guiones, quedan en el Planificador para cuando se vuelva a agendar."
          : `Los videos tienen que estar listos y aprobados para esa fecha. El cliente puede pedir correcciones hasta el ${fechaEcuador(limite)}.`;
      const titulo = {
        movida: `Producción movida · ${nombre}`,
        agendada: `Producción agendada · ${nombre}`,
        cancelada: `Producción cancelada · ${nombre}`,
      }[params.tipo];
      const que = {
        movida: `La producción de ${nombre} pasó ${params.fechaAnterior ? `del ${fechaEcuador(params.fechaAnterior)} ` : ""}al ${cuando}`,
        agendada: `Se agendó la producción de ${nombre} para el ${cuando}`,
        cancelada: `Se canceló la producción de ${nombre} del ${cuando}`,
      }[params.tipo];
      const cuerpo = `${que}${params.porNombre ? ` (lo hizo ${params.porNombre})` : ""}. ${estadoGuiones ? `${estadoGuiones} ` : ""}${pendiente}`;
      const tipoNotificacion = params.tipo === "cancelada" ? "produccion_cancelada" : params.tipo === "agendada" ? "produccion_agendada" : "produccion_reprogramada";

      await Promise.all(
        para.map((u) =>
          notificationService.create(u._id, tipoNotificacion, titulo, cuerpo, {
            workspaceId: entry.workspaceId,
            referenceId: entry._id,
          })
        )
      );
      await resendService.sendAvisoContenidoProduccion({
        to: para.map((u) => u.email).filter(Boolean),
        titulo,
        que: `${que}${params.porNombre ? ` (lo hizo ${params.porNombre})` : ""}.`,
        estadoGuiones,
        pendiente,
        workspaceId: String(entry.workspaceId),
      });
    } catch (error: any) {
      console.warn("[Producción → contenido] aviso falló:", error?.message || error);
    }
  }
}

export const avisoContenidoProduccionService = new AvisoContenidoProduccionService();
