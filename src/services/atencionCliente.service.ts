import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import type { NotificationType } from "../models/notification.model";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { ghlService } from "./ghl.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";

export const TZ = "America/Guayaquil";

export function fechaEcuador(fecha: Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(fecha);
}

/** "jue 18 · 10:30", para que el horario quepa en un boton. */
export function horarioCorto(fecha: Date): string {
  const dia = new Intl.DateTimeFormat("es-EC", { timeZone: TZ, weekday: "short", day: "numeric" }).format(fecha);
  const hora = new Intl.DateTimeFormat("es-EC", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(fecha);
  return `${dia} · ${hora}`;
}

export function diaEcuador(fecha: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(fecha);
}

const DIAS_AGENDA = 7;
// Nadie agenda para dentro de 10 minutos: el equipo necesita margen.
const ANTICIPACION_MS = 2 * 3_600_000;
const BLOQUEO_AGENDA_MS = 60_000;

export interface DatosCliente {
  entorno: string;
  nombre: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

export type ResultadoReserva =
  | { ok: true; cuando: string }
  | { ok: false; motivo: "sin_calendario" | "en_curso" | "ocupado" | "error" };

/**
 * Lo que el bot hace por el cliente, sea desde el menu o desde la IA: los dos
 * caminos agendan y avisan igual.
 */
class AtencionClienteService {
  async datosCliente(chat: ITelegramChat): Promise<DatosCliente> {
    const [workspace, cliente] = await Promise.all([
      models.workspaces.findById(chat.workspaceId).select("name").lean(),
      models.users.findById(chat.userId).select("name lastName email").lean(),
    ]);
    return {
      entorno: workspace?.name || "Cliente",
      nombre: [cliente?.name, cliente?.lastName].filter(Boolean).join(" ") || cliente?.email || "Cliente",
      firstName: cliente?.name,
      lastName: cliente?.lastName,
      email: cliente?.email,
    };
  }

  async proximaProduccion(workspaceId: Types.ObjectId): Promise<Date | null> {
    const proxima = await models.planning
      .findOne({ workspaceId, date: { $gte: new Date() }, title: { $not: /^CANCELADA/ } })
      .sort({ date: 1 })
      .select("date")
      .lean();
    return proxima?.date ?? null;
  }

  /** Horarios libres de la semana. null: ese tema no se agenda en calendario. */
  async horariosLibres(tema: TemaAtencion): Promise<Date[] | null> {
    const { calendarioId } = EQUIPO_ATENCION[tema];
    if (!calendarioId || !ghlService.isConfigured()) return null;
    try {
      const desde = new Date(Date.now() + ANTICIPACION_MS);
      return await ghlService.getFreeSlots(calendarioId, desde, new Date(desde.getTime() + DIAS_AGENDA * 86_400_000));
    } catch (error: any) {
      console.error("[Atención] horarios del CRM:", error.response?.data || error.message);
      return [];
    }
  }

  async reservarReunion(chat: ITelegramChat, tema: TemaAtencion, inicio: Date): Promise<ResultadoReserva> {
    const { calendarioId, etiqueta } = EQUIPO_ATENCION[tema];
    if (!calendarioId || !ghlService.isConfigured()) return { ok: false, motivo: "sin_calendario" };

    // Candado: dos toques (o dos llamadas de la IA) seguidos no crean dos citas.
    const tomado = await models.telegramChats.findOneAndUpdate(
      {
        _id: chat._id,
        $or: [{ agendandoDesde: { $exists: false } }, { agendandoDesde: null }, { agendandoDesde: { $lt: new Date(Date.now() - BLOQUEO_AGENDA_MS) } }],
      },
      { $set: { agendandoDesde: new Date() } }
    );
    if (!tomado) return { ok: false, motivo: "en_curso" };

    try {
      const cliente = await this.datosCliente(chat);
      if (!cliente.email) return { ok: false, motivo: "error" };

      try {
        // El horario pudo ocuparse mientras el cliente elegia.
        const libres = await ghlService.getFreeSlots(calendarioId, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 86_400_000));
        if (!libres.some((h) => Math.abs(h.getTime() - inicio.getTime()) < 60_000)) return { ok: false, motivo: "ocupado" };
        const contactId = await ghlService.upsertContact({
          email: cliente.email,
          firstName: cliente.firstName,
          lastName: cliente.lastName,
          companyName: cliente.entorno,
        });
        await ghlService.createAppointment({
          calendarId: calendarioId,
          contactId,
          startTime: inicio,
          title: `${cliente.entorno} · Reunión de ${etiqueta} (Telegram)`,
        });
      } catch (error: any) {
        console.error("[Atención] no se pudo agendar en el CRM:", error.response?.data || error.message);
        return { ok: false, motivo: "error" };
      }

      const cuando = fechaEcuador(inicio);
      await this.avisarEquipo(chat, tema, cliente, {
        tipo: "reunion_agendada",
        titulo: `${cliente.entorno} agendó una reunión · ${cuando}`,
        cuerpo: `${cliente.nombre} agendó por Telegram una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        mensaje: `📅 Agendó una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        asunto: `📅 ${cliente.entorno} agendó una reunión contigo · ${cuando}`,
        encabezado: `${cliente.entorno} agendó una reunión`,
      });
      return { ok: true, cuando };
    } finally {
      await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { agendandoDesde: 1 } });
    }
  }

  /** El pedido del cliente llega por correo y en la plataforma a quien atiende el tema. */
  async enviarMensaje(chat: ITelegramChat, tema: TemaAtencion, mensaje: string): Promise<boolean> {
    const cliente = await this.datosCliente(chat);
    return this.avisarEquipo(chat, tema, cliente, {
      tipo: "solicitud_cliente",
      titulo: `${cliente.entorno} escribió por Telegram · ${EQUIPO_ATENCION[tema].etiqueta}`,
      cuerpo: `${cliente.nombre}: “${mensaje.slice(0, 280)}”`,
      mensaje: mensaje.slice(0, 3000),
    });
  }

  /** Correo + notificacion in-app a quien atiende el tema. true si llego por algun lado. */
  async avisarEquipo(
    chat: ITelegramChat,
    tema: TemaAtencion,
    cliente: DatosCliente,
    aviso: { tipo: NotificationType; titulo: string; cuerpo: string; mensaje: string; asunto?: string; encabezado?: string }
  ): Promise<boolean> {
    const { etiqueta } = EQUIPO_ATENCION[tema];
    const [internos, proxima] = await Promise.all([
      equipoAtencionService.usuarios(tema),
      tema === "produccion" ? this.proximaProduccion(chat.workspaceId!) : null,
    ]);

    const avisosInApp = await Promise.allSettled(
      internos.map((u) => notificationService.create(u._id, aviso.tipo, aviso.titulo, aviso.cuerpo, { workspaceId: chat.workspaceId! }))
    );

    let correoEnviado = false;
    try {
      await resendService.sendSolicitudClienteEmail({
        to: equipoAtencionService.correos(tema),
        tema: etiqueta,
        workspaceName: cliente.entorno,
        clienteNombre: cliente.nombre,
        clienteEmail: cliente.email,
        telegramUsername: chat.telegramUsername,
        mensaje: aviso.mensaje,
        proximaProduccion: proxima ? fechaEcuador(proxima) : undefined,
        asunto: aviso.asunto,
        encabezado: aviso.encabezado,
      });
      correoEnviado = true;
    } catch (error) {
      console.error("[Atención] no se pudo enviar el correo al equipo:", error);
    }

    return correoEnviado || avisosInApp.some((r) => r.status === "fulfilled");
  }
}

export const atencionClienteService = new AtencionClienteService();
