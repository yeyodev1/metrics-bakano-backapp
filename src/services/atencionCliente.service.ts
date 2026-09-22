import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import type { NotificationType } from "../models/notification.model";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { ghlService } from "./ghl.service";
import { slackService } from "./slack.service";
import { crmProductionSyncService } from "./crmProductionSync.service";
import { CALENDARIOS_PRODUCCION, EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";

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

/**
 * Produccion: sesion en ambiente controlado para las tomas del avatar y de
 * los productos a promocionar. Una cada N meses (2 por defecto) contados
 * desde la ultima; con una ya agendada no se agenda otra.
 */
const MESES_ENTRE_PRODUCCIONES = Number(process.env.PRODUCCION_MESES_ENTRE) > 0 ? Number(process.env.PRODUCCION_MESES_ENTRE) : 2;
// El cliente necesita tiempo para revisar guiones antes de grabar (48 h de correcciones).
const ANTICIPACION_PRODUCCION_MS = 48 * 3_600_000;
const VENTANA_PRODUCCION_DIAS = 30;

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

export interface EstadoProduccion {
  puedeAgendar: boolean;
  /** Produccion ya agendada: bloquea agendar otra. */
  proxima?: Date;
  ultima?: Date;
  /** Primer momento en que puede grabar (regla de meses + anticipacion). */
  habilitadaDesde?: Date;
  /** true si la regla de los meses corre la fecha, no solo la anticipacion. */
  esperar?: boolean;
}

export type ResultadoProduccion =
  | { ok: true; cuando: string }
  | { ok: false; motivo: "sin_calendario" | "en_curso" | "ya_agendada" | "antes_de_tiempo" | "ocupado" | "error" };

function sumarMeses(fecha: Date, meses: number): Date {
  const r = new Date(fecha);
  r.setMonth(r.getMonth() + meses);
  return r;
}

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
    if (!(await this.tomarCandado(chat))) return { ok: false, motivo: "en_curso" };

    try {
      const cliente = await this.datosCliente(chat);
      if (!cliente.email) return { ok: false, motivo: "error" };

      try {
        if (!(await this.sigueLibre(calendarioId, inicio))) return { ok: false, motivo: "ocupado" };
        const contactId = await this.contactoCrm(cliente);
        const appointmentId = await ghlService.createAppointment({
          calendarId: calendarioId,
          contactId,
          startTime: inicio,
          title: `${cliente.entorno} · Reunión de ${etiqueta} (Telegram)`,
        });
        // Se guarda para poder moverla o cancelarla despues desde el chat.
        const cita = {
          appointmentId,
          tipo: "reunion" as const,
          tema,
          calendarId: calendarioId,
          inicio,
          agendadaEn: new Date(),
          workspaceId: chat.workspaceId,
          userId: chat.userId,
        };
        await models.telegramChats
          .updateOne({ _id: chat._id }, { $push: { citas: { $each: [cita], $slice: -20 } } })
          .catch((error: any) => console.error("[Atención] guardar cita:", error?.message || error));
        chat.citas = [...(chat.citas || []), cita];
      } catch (error: any) {
        console.error("[Atención] no se pudo agendar en el CRM:", error.response?.data || error.message);
        return { ok: false, motivo: "error" };
      }

      const cuando = fechaEcuador(inicio);
      await this.avisarEquipo(chat, tema, cliente, {
        tipo: "reunion_agendada",
        titulo: `📅 ${cliente.entorno} agendó una reunión · ${cuando}`,
        cuerpo: `${cliente.nombre} agendó por Telegram una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        mensaje: `📅 Agendó una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        asunto: `📅 ${cliente.entorno} agendó una reunión contigo · ${cuando}`,
        encabezado: `${cliente.entorno} agendó una reunión`,
      });
      return { ok: true, cuando };
    } finally {
      await this.soltarCandado(chat);
    }
  }

  // ── Produccion ─────────────────────────────────────────────────────────────
  /** Regla de agenda de produccion, calculada siempre en el servidor. */
  async estadoProduccion(workspaceId: Types.ObjectId): Promise<EstadoProduccion> {
    const ahora = new Date();
    const [proxima, ultima] = await Promise.all([
      models.planning.findOne({ workspaceId, date: { $gte: ahora }, title: { $not: /^CANCELADA/ } }).sort({ date: 1 }).select("date").lean(),
      models.planning.findOne({ workspaceId, date: { $lt: ahora }, title: { $not: /^CANCELADA/ } }).sort({ date: -1 }).select("date").lean(),
    ]);
    if (proxima) return { puedeAgendar: false, proxima: proxima.date, ultima: ultima?.date };

    const porRegla = ultima ? sumarMeses(ultima.date, MESES_ENTRE_PRODUCCIONES) : ahora;
    const minimo = ahora.getTime() + ANTICIPACION_PRODUCCION_MS;
    return {
      puedeAgendar: true,
      ultima: ultima?.date,
      habilitadaDesde: new Date(Math.max(porRegla.getTime(), minimo)),
      esperar: porRegla.getTime() > minimo,
    };
  }

  /** Premium si el cliente ya grabo por el calendario premium; si no, standard. */
  private async calendarioProduccion(workspaceId: Types.ObjectId): Promise<string> {
    const previa = await models.planning
      .findOne({ workspaceId, "crm.calendarId": { $in: Object.values(CALENDARIOS_PRODUCCION) } })
      .sort({ date: -1 })
      .select("crm.calendarId")
      .lean();
    return previa?.crm?.calendarId || CALENDARIOS_PRODUCCION.standard;
  }

  /** Estado de la regla + horarios libres de produccion. horarios null: CRM sin configurar. */
  async horariosProduccion(workspaceId: Types.ObjectId): Promise<{ estado: EstadoProduccion; horarios: Date[] | null }> {
    const estado = await this.estadoProduccion(workspaceId);
    if (!estado.puedeAgendar) return { estado, horarios: [] };
    if (!ghlService.isConfigured()) return { estado, horarios: null };
    try {
      const desde = estado.habilitadaDesde!;
      const calendario = await this.calendarioProduccion(workspaceId);
      const horarios = await ghlService.getFreeSlots(calendario, desde, new Date(desde.getTime() + VENTANA_PRODUCCION_DIAS * 86_400_000));
      return { estado, horarios };
    } catch (error: any) {
      console.error("[Atención] horarios de producción:", error.response?.data || error.message);
      return { estado, horarios: [] };
    }
  }

  async reservarProduccion(chat: ITelegramChat, inicio: Date): Promise<ResultadoProduccion> {
    if (!ghlService.isConfigured()) return { ok: false, motivo: "sin_calendario" };
    if (!(await this.tomarCandado(chat))) return { ok: false, motivo: "en_curso" };

    try {
      // La regla se vuelve a validar aqui: ni el menu ni la IA la pueden saltar.
      const estado = await this.estadoProduccion(chat.workspaceId!);
      if (!estado.puedeAgendar) return { ok: false, motivo: "ya_agendada" };
      if (inicio.getTime() < estado.habilitadaDesde!.getTime() - 60_000) return { ok: false, motivo: "antes_de_tiempo" };

      const cliente = await this.datosCliente(chat);
      if (!cliente.email) return { ok: false, motivo: "error" };
      const calendario = await this.calendarioProduccion(chat.workspaceId!);

      try {
        if (!(await this.sigueLibre(calendario, inicio))) return { ok: false, motivo: "ocupado" };
        const contactId = await this.contactoCrm(cliente);
        await ghlService.createAppointment({
          calendarId: calendario,
          contactId,
          startTime: inicio,
          title: `${cliente.entorno} · Producción (Telegram)`,
          permitirProduccion: true,
        });
      } catch (error: any) {
        console.error("[Atención] no se pudo agendar la producción:", error.response?.data || error.message);
        return { ok: false, motivo: "error" };
      }

      const cuando = fechaEcuador(inicio);
      const correosProduccion = equipoAtencionService.correos("produccion");

      // El sync del CRM crea la produccion en el Planificador y manda su
      // correo + notificacion al equipo. Si no la crea, se avisa aqui.
      const sync = await crmProductionSyncService
        .sincronizarDesdeCrm({ desde: new Date(inicio.getTime() - 86_400_000), hasta: new Date(inicio.getTime() + 86_400_000) })
        .catch((error: any) => {
          console.error("[Atención] sync de producción:", error?.message || error);
          return null;
        });

      // "creadas" es 0 si el webhook del CRM ya la habia creado: lo que importa
      // es si ya esta en el Planificador (ahi el sync ya aviso al equipo).
      const enPlanificador =
        sync !== null &&
        (await models.planning.exists({
          workspaceId: chat.workspaceId,
          date: { $gte: new Date(inicio.getTime() - 60_000), $lte: new Date(inicio.getTime() + 60_000) },
          title: { $not: /^CANCELADA/ },
        }));
      if (enPlanificador) {
        await slackService
          .avisarEquipo({
            titulo: `🎬 ${cliente.entorno} agendó su producción · ${cuando}`,
            detalle: `${cliente.nombre} la agendó por Telegram. Ya está en el calendario del CRM y en el Planificador.`,
            correos: correosProduccion,
          })
          .catch((error) => console.error("[Atención] Slack producción:", error?.message || error));
      } else {
        await this.avisarEquipo(chat, "produccion", cliente, {
          tipo: "produccion_agendada",
          titulo: `🎬 ${cliente.entorno} agendó su producción · ${cuando}`,
          cuerpo: `${cliente.nombre} agendó por Telegram su producción para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
          mensaje: `🎬 Agendó su producción para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
          asunto: `🎬 ${cliente.entorno} agendó su producción · ${cuando}`,
          encabezado: `${cliente.entorno} agendó su producción`,
        });
      }
      return { ok: true, cuando };
    } finally {
      await this.soltarCandado(chat);
    }
  }

  // ── Mensajes y avisos ──────────────────────────────────────────────────────
  /** El pedido del cliente llega por correo, Slack y la plataforma a quien atiende el tema. */
  async enviarMensaje(chat: ITelegramChat, tema: TemaAtencion, mensaje: string): Promise<boolean> {
    const cliente = await this.datosCliente(chat);
    return this.avisarEquipo(chat, tema, cliente, {
      tipo: "solicitud_cliente",
      titulo: `💬 ${cliente.entorno} escribió por Telegram · ${EQUIPO_ATENCION[tema].etiqueta}`,
      cuerpo: `${cliente.nombre}: “${mensaje.slice(0, 280)}”`,
      mensaje: mensaje.slice(0, 3000),
    });
  }

  /** Correo + Slack + notificacion in-app a quien atiende el tema. true si llego por algun lado. */
  async avisarEquipo(
    chat: ITelegramChat,
    tema: TemaAtencion,
    cliente: DatosCliente,
    aviso: { tipo: NotificationType; titulo: string; cuerpo: string; mensaje: string; asunto?: string; encabezado?: string }
  ): Promise<boolean> {
    const { etiqueta } = EQUIPO_ATENCION[tema];
    const correos = equipoAtencionService.correos(tema);
    const [internos, proxima] = await Promise.all([
      equipoAtencionService.usuarios(tema),
      tema === "produccion" ? this.proximaProduccion(chat.workspaceId!) : null,
    ]);

    const [avisosInApp, slack, correo] = await Promise.all([
      Promise.allSettled(
        internos.map((u) => notificationService.create(u._id, aviso.tipo, aviso.titulo, aviso.cuerpo, { workspaceId: chat.workspaceId! }))
      ),
      slackService
        .avisarEquipo({ titulo: aviso.titulo, detalle: `${cliente.nombre} (${cliente.entorno})\n${aviso.mensaje}`, correos })
        .catch((error) => {
          console.error("[Atención] Slack:", error?.message || error);
          return false;
        }),
      resendService
        .sendSolicitudClienteEmail({
          to: correos,
          tema: etiqueta,
          workspaceName: cliente.entorno,
          clienteNombre: cliente.nombre,
          clienteEmail: cliente.email,
          telegramUsername: chat.telegramUsername,
          mensaje: aviso.mensaje,
          proximaProduccion: proxima ? fechaEcuador(proxima) : undefined,
          asunto: aviso.asunto,
          encabezado: aviso.encabezado,
        })
        .then(() => true)
        .catch((error) => {
          console.error("[Atención] no se pudo enviar el correo al equipo:", error);
          return false;
        }),
    ]);

    return correo || slack || avisosInApp.some((r) => r.status === "fulfilled");
  }

  // ── Utilidades de agenda ───────────────────────────────────────────────────
  /** Candado: dos toques (o dos llamadas de la IA) seguidos no crean dos citas. */
  async tomarCandado(chat: ITelegramChat): Promise<boolean> {
    const tomado = await models.telegramChats.findOneAndUpdate(
      {
        _id: chat._id,
        $or: [{ agendandoDesde: { $exists: false } }, { agendandoDesde: null }, { agendandoDesde: { $lt: new Date(Date.now() - BLOQUEO_AGENDA_MS) } }],
      },
      { $set: { agendandoDesde: new Date() } }
    );
    return Boolean(tomado);
  }

  async soltarCandado(chat: ITelegramChat): Promise<void> {
    await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { agendandoDesde: 1 } });
  }

  /** El horario pudo ocuparse mientras el cliente elegia. */
  async sigueLibre(calendarioId: string, inicio: Date): Promise<boolean> {
    const libres = await ghlService.getFreeSlots(calendarioId, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 86_400_000));
    return libres.some((h) => Math.abs(h.getTime() - inicio.getTime()) < 60_000);
  }

  private contactoCrm(cliente: DatosCliente): Promise<string> {
    return ghlService.upsertContact({
      email: cliente.email!,
      firstName: cliente.firstName,
      lastName: cliente.lastName,
      companyName: cliente.entorno,
    });
  }
}

export const atencionClienteService = new AtencionClienteService();
