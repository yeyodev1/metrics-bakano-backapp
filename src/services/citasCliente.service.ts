import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { ghlService } from "./ghl.service";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { crmProductionSyncService } from "./crmProductionSync.service";
import { atencionClienteService, fechaEcuador } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { CALENDARIOS_PRODUCCION, EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { ORDEN_SESIONES, SESIONES_ONBOARDING, type SesionOnboarding } from "./onboardingSesiones.service";

/**
 * Citas del cliente: verlas, moverlas y cancelarlas desde Telegram.
 *
 * Reglas (acordadas con direccion):
 * - Mover o cancelar SIEMPRE funciona: el boton hace lo que dice. La regla de
 *   los dos dias se le dice clarisimo, pero no lo deja atascado: si falta
 *   menos, igual se hace y se le avisa a TODOS los encargados de esa cita
 *   (DM, correo y notificacion) para que reacomoden su dia.
 * - Cancelar nunca borra: la cita queda "cancelled" en el CRM, con historial.
 * - Solo se tocan citas que el sistema sabe que son de ESE entorno: la
 *   produccion por su Planning, las sesiones por onboardingSesiones y las
 *   reuniones por el registro del chat. Nunca un id que venga del modelo.
 * - Mover una produccion no la cuenta como nueva: la regla de los 2 meses se
 *   mide contra la ultima produccion ya realizada.
 * - La confirmacion la exige el servidor, no solo el prompt: primero se
 *   propone el cambio (queda pendiente en el chat) y se ejecuta recien cuando
 *   el cliente toca el boton o confirma en un mensaje posterior.
 */

/** Debajo de esto el cambio es "sobre la hora": se avisa a todo el equipo de la cita. */
const PLAZO_URGENTE_MS = 48 * 3_600_000;
const ANTICIPACION_MS = 2 * 3_600_000;
const ANTICIPACION_PRODUCCION_MS = 48 * 3_600_000;
const VENTANA_MOVER_DIAS = 30;
const MESES_ENTRE_PRODUCCIONES = Number(process.env.PRODUCCION_MESES_ENTRE) > 0 ? Number(process.env.PRODUCCION_MESES_ENTRE) : 2;
const CANCELADAS = ["cancelled", "canceled", "invalid"];
/** Un cambio propuesto y no confirmado caduca: nadie confirma "si" a algo de ayer. */
const CAMBIO_VENCE_MS = 15 * 60_000;

export type TipoCita = "produccion" | "onboarding" | "reunion";

export interface CitaCliente {
  /** Referencia estable para el bot: prod:<planningId> · onb:<sesion> · reu:<appointmentId>. */
  ref: string;
  tipo: TipoCita;
  etiqueta: string;
  con: string;
  correos: string[];
  inicio: Date;
  appointmentId: string;
  calendarId?: string;
  planningId?: Types.ObjectId;
  sesion?: SesionOnboarding;
  tema?: TemaAtencion;
}

export type ResultadoCambio =
  | { ok: true; accion: "cancelada" | "reprogramada"; cita: string; antes: string; ahora?: string; con: string }
  | { ok: false; motivo: string; con?: string; correos?: string[] };

function sumarMeses(fecha: Date, meses: number): Date {
  const r = new Date(fecha);
  r.setMonth(r.getMonth() + meses);
  return r;
}

class CitasClienteService {
  /** Citas futuras del entorno que el bot puede gestionar. */
  async listar(chat: ITelegramChat): Promise<CitaCliente[]> {
    const ahora = new Date();
    const [producciones, workspace] = await Promise.all([
      models.planning
        .find({
          workspaceId: chat.workspaceId,
          date: { $gte: ahora },
          title: { $not: /^CANCELADA/ },
          "crm.appointmentId": { $exists: true, $ne: null },
        })
        .sort({ date: 1 })
        .select("date title crm")
        .lean(),
      models.workspaces.findById(chat.workspaceId).select("onboardingSesiones").lean(),
    ]);

    const citas: CitaCliente[] = [];
    for (const p of producciones) {
      citas.push({
        ref: `prod:${p._id}`,
        tipo: "produccion",
        etiqueta: "Producción",
        con: equipoAtencionService.nombres("produccion"),
        correos: equipoAtencionService.correos("produccion"),
        inicio: p.date,
        appointmentId: p.crm!.appointmentId,
        calendarId: p.crm?.calendarId,
        planningId: p._id as Types.ObjectId,
      });
    }
    for (const s of ORDEN_SESIONES) {
      const g = (workspace as any)?.onboardingSesiones?.[s];
      if (!g?.agendada || !g.appointmentId || !g.fecha || new Date(g.fecha) <= ahora) continue;
      const def = SESIONES_ONBOARDING[s];
      citas.push({
        ref: `onb:${s}`,
        tipo: "onboarding",
        etiqueta: `Sesión de ${def.etiqueta}`,
        con: def.responsable.nombre,
        correos: [def.responsable.email],
        inicio: new Date(g.fecha),
        appointmentId: g.appointmentId,
        calendarId: def.calendarioId,
        sesion: s,
      });
    }
    for (const c of chat.citas || []) {
      if (!c.appointmentId || new Date(c.inicio) <= ahora) continue;
      // Solo las de este entorno y de quien las agendo: el chat puede cambiar
      // de entorno o de cuenta (/salir) y no debe ver reuniones ajenas.
      if (String(c.workspaceId) !== String(chat.workspaceId)) continue;
      if (c.userId && String(c.userId) !== String(chat.userId)) continue;
      const tema = c.tema as TemaAtencion;
      citas.push({
        ref: `reu:${c.appointmentId}`,
        tipo: "reunion",
        etiqueta: `Reunión de ${EQUIPO_ATENCION[tema]?.etiqueta ?? "atención"}`,
        con: equipoAtencionService.nombres(tema),
        correos: equipoAtencionService.correos(tema),
        inicio: new Date(c.inicio),
        appointmentId: c.appointmentId,
        calendarId: c.calendarId,
        tema,
      });
    }
    return citas.sort((a, b) => a.inicio.getTime() - b.inicio.getTime());
  }

  /** Falta menos de dos días: se puede igual, pero se avisa a todo el equipo. */
  esUrgente(cita: CitaCliente): boolean {
    return cita.inicio.getTime() - Date.now() < PLAZO_URGENTE_MS;
  }

  /** Cualquier cita futura se puede cambiar; esUrgente solo cambia el aviso. */
  editable(cita: CitaCliente): boolean {
    return cita.inicio.getTime() > Date.now();
  }

  /**
   * Sobre la hora no se toca el calendario: se le avisa a TODOS los encargados
   * de esa cita (y a atención) para que lo coordinen con el cliente. Dirección
   * solo si de verdad hace falta, y eso lo decide la IA.
   */
  async solicitarCambio(
    chat: ITelegramChat,
    ref: string,
    accion: "mover" | "cancelar",
    motivo?: string,
    avisarDireccion = false
  ): Promise<{ ok: boolean; motivo?: string; con?: string; correos?: string[]; cuando?: string; etiqueta?: string }> {
    const cita = (await this.listar(chat)).find((c) => c.ref === ref);
    if (!cita) return { ok: false, motivo: "no_encontrada" };

    const cliente = await atencionClienteService.datosCliente(chat);
    const titulo = `⚠️ SOBRE LA HORA · ${cliente.entorno} quiere ${accion} su ${cita.etiqueta.toLowerCase()} del ${fechaEcuador(cita.inicio)}`;
    const detalle =
      `${cliente.nombre} lo pidió por Telegram y faltan menos de dos días, así que NO se tocó el calendario.\n` +
      (motivo ? `Motivo: ${motivo}\n` : "") +
      `\nCoordínenlo con el cliente y muevan o cancelen la cita en el CRM si corresponde.`;

    const correos = [...new Set([
      ...cita.correos,
      ...equipoAtencionService.correos("atencion"),
      ...(avisarDireccion ? ["dquimi@bakano.ec", "dreyes@bakano.ec"] : []),
    ])];
    const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();

    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos }),
      ...correos.map((c) => slackService.mensajeDirecto(c, titulo, detalle)),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle, { workspaceId: chat.workspaceId! })
      ),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: `cambio de ${cita.etiqueta.toLowerCase()} sobre la hora`,
        workspaceName: cliente.entorno,
        clienteNombre: cliente.nombre,
        clienteEmail: cliente.email,
        telegramUsername: chat.telegramUsername,
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);

    return { ok: true, con: cita.con, correos: cita.correos, cuando: fechaEcuador(cita.inicio), etiqueta: cita.etiqueta };
  }

  private async ventanaMover(chat: ITelegramChat, cita: CitaCliente): Promise<{ desde: Date; calendario: string }> {
    if (cita.tipo === "produccion") {
      // La regla se mide contra la ultima produccion ya realizada, no contra
      // la que se esta moviendo: mover no la cuenta como nueva.
      const ultima = await models.planning
        .findOne({ workspaceId: chat.workspaceId, date: { $lt: new Date() }, title: { $not: /^CANCELADA/ } })
        .sort({ date: -1 })
        .select("date")
        .lean();
      const porRegla = ultima ? sumarMeses(ultima.date, MESES_ENTRE_PRODUCCIONES).getTime() : 0;
      return {
        desde: new Date(Math.max(porRegla, Date.now() + ANTICIPACION_PRODUCCION_MS)),
        calendario: cita.calendarId || CALENDARIOS_PRODUCCION.standard,
      };
    }
    return { desde: new Date(Date.now() + ANTICIPACION_MS), calendario: cita.calendarId! };
  }

  async horariosParaMover(chat: ITelegramChat, ref: string): Promise<{ cita?: CitaCliente; horarios: Date[]; motivo?: string }> {
    const cita = (await this.listar(chat)).find((c) => c.ref === ref);
    if (!cita) return { horarios: [], motivo: "no_encontrada" };
    if (!cita.calendarId && cita.tipo !== "produccion") return { cita, horarios: [], motivo: "sin_calendario" };
    const { desde, calendario } = await this.ventanaMover(chat, cita);
    try {
      const horarios = await ghlService.getFreeSlots(calendario, desde, new Date(desde.getTime() + VENTANA_MOVER_DIAS * 86_400_000));
      return { cita, horarios: horarios.filter((h) => Math.abs(h.getTime() - cita.inicio.getTime()) > 60_000) };
    } catch (error: any) {
      console.error("[Citas] horarios para mover:", error.response?.data || error.message);
      return { cita, horarios: [], motivo: "sin_horarios" };
    }
  }

  async cancelar(chat: ITelegramChat, ref: string, motivoCliente?: string, avisarDireccion = false): Promise<ResultadoCambio> {
    const cita = (await this.listar(chat)).find((c) => c.ref === ref);
    if (!cita) return { ok: false, motivo: "no_encontrada" };
    if (!(await atencionClienteService.tomarCandado(chat))) return { ok: false, motivo: "en_curso" };

    try {
      const verificada = await this.verificar(cita);
      if (!verificada.ok) return { ok: false, motivo: verificada.motivo, con: cita.con, correos: cita.correos };
      try {
        await ghlService.updateAppointment(cita.appointmentId, { cancelar: true });
      } catch (error: any) {
        console.error("[Citas] cancelar:", error.response?.data || error.message);
        // Un timeout no dice si el CRM lo aplico: se vuelve a leer.
        const ahora = await ghlService.getAppointment(cita.appointmentId);
        if (!CANCELADAS.includes(String(ahora?.appointmentStatus || "").toLowerCase())) {
          return { ok: false, motivo: "error", con: cita.con, correos: cita.correos };
        }
      }
      await this.reflejar(chat, cita, "cancelada");
      await this.avisar(chat, cita, "cancelada", undefined, motivoCliente, avisarDireccion);
      return { ok: true, accion: "cancelada", cita: cita.etiqueta, antes: fechaEcuador(cita.inicio), con: cita.con };
    } finally {
      await atencionClienteService.soltarCandado(chat);
    }
  }

  async reprogramar(chat: ITelegramChat, ref: string, nuevoInicio: Date, avisarDireccion = false): Promise<ResultadoCambio> {
    if (Number.isNaN(nuevoInicio.getTime())) return { ok: false, motivo: "horario_invalido" };
    const opciones = await this.horariosParaMover(chat, ref);
    const cita = opciones.cita;
    if (!cita) return { ok: false, motivo: "no_encontrada" };
    // Solo un horario que el sistema ofrecio: respeta la regla y esta libre.
    if (!opciones.horarios.some((h) => Math.abs(h.getTime() - nuevoInicio.getTime()) < 60_000)) {
      return { ok: false, motivo: "horario_no_disponible", con: cita.con, correos: cita.correos };
    }
    if (!(await atencionClienteService.tomarCandado(chat))) return { ok: false, motivo: "en_curso" };

    try {
      const verificada = await this.verificar(cita);
      if (!verificada.ok) return { ok: false, motivo: verificada.motivo, con: cita.con, correos: cita.correos };
      try {
        await ghlService.updateAppointment(cita.appointmentId, { startTime: nuevoInicio });
      } catch (error: any) {
        console.error("[Citas] reprogramar:", error.response?.data || error.message);
        const ahora = await ghlService.getAppointment(cita.appointmentId);
        if (!ahora?.startTime || Math.abs(new Date(ahora.startTime).getTime() - nuevoInicio.getTime()) > 60_000) {
          return { ok: false, motivo: "error", con: cita.con, correos: cita.correos };
        }
      }
      await this.reflejar(chat, cita, "reprogramada", nuevoInicio);
      await this.avisar(chat, cita, "reprogramada", nuevoInicio, undefined, avisarDireccion);
      return {
        ok: true,
        accion: "reprogramada",
        cita: cita.etiqueta,
        antes: fechaEcuador(cita.inicio),
        ahora: fechaEcuador(nuevoInicio),
        con: cita.con,
      };
    } finally {
      await atencionClienteService.soltarCandado(chat);
    }
  }

  /**
   * Primera fase: valida y deja el cambio pendiente en el chat. No toca el CRM.
   * Devuelve el resumen que el cliente tiene que confirmar.
   */
  async proponer(
    chat: ITelegramChat,
    cambio: { accion: "cancelar" | "reprogramar"; ref: string; inicio?: string; motivo?: string; avisarDireccion?: boolean }
  ): Promise<{ ok: true; resumen: string } | { ok: false; motivo: string; con?: string; correos?: string[] }> {
    const cita = (await this.listar(chat)).find((c) => c.ref === cambio.ref);
    if (!cita) return { ok: false, motivo: "no_encontrada" };

    let nuevo: Date | undefined;
    if (cambio.accion === "reprogramar") {
      nuevo = new Date(cambio.inicio || "");
      if (Number.isNaN(nuevo.getTime())) return { ok: false, motivo: "horario_invalido" };
      const { horarios } = await this.horariosParaMover(chat, cambio.ref);
      if (!horarios.some((h) => Math.abs(h.getTime() - nuevo!.getTime()) < 60_000)) {
        return { ok: false, motivo: "horario_no_disponible", con: cita.con, correos: cita.correos };
      }
    }
    const resumen =
      (cambio.accion === "cancelar"
        ? `Cancelar ${cita.etiqueta.toLowerCase()} con ${cita.con} del ${fechaEcuador(cita.inicio)}`
        : `Mover ${cita.etiqueta.toLowerCase()} con ${cita.con} del ${fechaEcuador(cita.inicio)} al ${fechaEcuador(nuevo!)}`);
    const pendiente = {
      accion: cambio.accion,
      ref: cambio.ref,
      inicio: nuevo,
      motivo: cambio.motivo?.slice(0, 500),
      avisarDireccion: cambio.avisarDireccion === true,
      resumen,
      creadoEn: new Date(),
    };
    await models.telegramChats.updateOne({ _id: chat._id }, { $set: { cambioPendiente: pendiente } });
    chat.cambioPendiente = pendiente;
    return { ok: true, resumen };
  }

  /**
   * Segunda fase: ejecuta el cambio pendiente. `antesDe` impide confirmar en
   * el mismo turno en que se propuso: la IA no puede proponer y confirmar sola
   * sin que el cliente haya visto el resumen.
   */
  async confirmar(chat: ITelegramChat, opciones: { antesDe?: Date } = {}): Promise<ResultadoCambio> {
    const fresco = await models.telegramChats.findById(chat._id).select("cambioPendiente").lean();
    const p = fresco?.cambioPendiente;
    if (!p) return { ok: false, motivo: "sin_cambio_pendiente" };
    const creado = new Date(p.creadoEn).getTime();
    if (Date.now() - creado > CAMBIO_VENCE_MS) {
      await this.descartar(chat);
      return { ok: false, motivo: "cambio_vencido" };
    }
    if (opciones.antesDe && creado >= opciones.antesDe.getTime()) return { ok: false, motivo: "falta_confirmacion_del_cliente" };

    // Se consume antes de ejecutar: un doble toque no lo aplica dos veces.
    const tomado = await models.telegramChats.updateOne(
      { _id: chat._id, "cambioPendiente.creadoEn": p.creadoEn },
      { $unset: { cambioPendiente: 1 } }
    );
    if (!tomado.modifiedCount) return { ok: false, motivo: "en_curso" };
    chat.cambioPendiente = undefined;
    return p.accion === "cancelar"
      ? this.cancelar(chat, p.ref, p.motivo, p.avisarDireccion === true)
      : this.reprogramar(chat, p.ref, new Date(p.inicio!), p.avisarDireccion === true);
  }

  async descartar(chat: ITelegramChat): Promise<void> {
    await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { cambioPendiente: 1 } });
    chat.cambioPendiente = undefined;
  }

  /**
   * La cita sigue viva en el CRM, es del calendario que el sistema espera y,
   * con la hora REAL del CRM (el equipo pudo moverla), faltan 48 h o mas.
   * Deja en `cita.inicio` la hora real para los avisos.
   */
  private async verificar(cita: CitaCliente): Promise<{ ok: boolean; motivo: string }> {
    const evento = await ghlService.getAppointment(cita.appointmentId);
    if (!evento) return { ok: false, motivo: "no_encontrada_en_crm" };
    if (CANCELADAS.includes(String(evento.appointmentStatus || "").toLowerCase())) return { ok: false, motivo: "ya_cancelada" };
    if (cita.calendarId && evento.calendarId && evento.calendarId !== cita.calendarId) return { ok: false, motivo: "no_coincide" };
    // La hora real del CRM manda (el equipo pudo moverla) y se usa en los avisos.
    const real = evento.startTime ? new Date(evento.startTime) : null;
    if (real && !Number.isNaN(real.getTime())) cita.inicio = real;
    return { ok: true, motivo: "" };
  }

  /** El cambio del CRM tambien queda en la plataforma. */
  private async reflejar(chat: ITelegramChat, cita: CitaCliente, accion: "cancelada" | "reprogramada", nuevo?: Date): Promise<void> {
    try {
      if (cita.tipo === "produccion" && accion === "cancelada") {
        // Nunca se borra: se marca cancelada ANTES de que la vea el sync del
        // CRM. Asi el sync (y el cron) la encuentran ya cancelada y no llegan
        // al deleteOne que usan para las canceladas sin guiones.
        const entry = await models.planning.findById(cita.planningId).select("title").lean();
        await models.planning.updateOne(
          { _id: cita.planningId },
          {
            $set: {
              "crm.status": "cancelled",
              "crm.syncedAt": new Date(),
              ...(entry && !/^CANCELADA · /.test(entry.title) ? { title: `CANCELADA · ${entry.title}` } : {}),
            },
          }
        );
      } else if (cita.tipo === "produccion") {
        // Rango que cubre la fecha vieja y la nueva: si solo cubriera una, el
        // sync veria la otra como huerfana y mandaria avisos falsos.
        const fechas = [cita.inicio.getTime(), (nuevo ?? cita.inicio).getTime()];
        await crmProductionSyncService.sincronizarDesdeCrm({
          desde: new Date(Math.min(...fechas) - 86_400_000),
          hasta: new Date(Math.max(...fechas) + 86_400_000),
        });
      } else if (cita.tipo === "onboarding") {
        const nota = `${accion === "cancelada" ? "Cancelada" : `Movida al ${fechaEcuador(nuevo!)}`} por el cliente desde Telegram`;
        if (accion === "cancelada") await onboardingBotService.desmarcar(chat.workspaceId!, cita.sesion!, nota);
        else await onboardingBotService.moverFecha(chat.workspaceId!, cita.sesion!, nuevo!, nota);
      } else if (accion === "cancelada") {
        await models.telegramChats.updateOne({ _id: chat._id }, { $pull: { citas: { appointmentId: cita.appointmentId } } });
        chat.citas = (chat.citas || []).filter((c) => c.appointmentId !== cita.appointmentId) as any;
      } else {
        await models.telegramChats.updateOne(
          { _id: chat._id, "citas.appointmentId": cita.appointmentId },
          { $set: { "citas.$.inicio": nuevo } }
        );
        const c = (chat.citas || []).find((x) => x.appointmentId === cita.appointmentId);
        if (c) c.inicio = nuevo!;
      }
    } catch (error: any) {
      console.error("[Citas] reflejar en la plataforma:", error?.message || error);
    }
  }

  /**
   * Aviso al responsable. Al mover una produccion el sync del CRM ya manda
   * correo y notificacion al equipo: ahi solo Slack, para no duplicar. Al
   * cancelarla el sync no avisa (la encuentra ya cancelada): van todos.
   */
  private async avisar(
    chat: ITelegramChat,
    cita: CitaCliente,
    accion: "cancelada" | "reprogramada",
    nuevo?: Date,
    motivoCliente?: string,
    avisarDireccion = false
  ) {
    const cliente = await atencionClienteService.datosCliente(chat);
    const urgente = this.esUrgente(cita);
    const titulo =
      (urgente ? "⚠️ SOBRE LA HORA · " : "🗓️ ") +
      (accion === "cancelada"
        ? `${cliente.entorno} canceló su ${cita.etiqueta.toLowerCase()} del ${fechaEcuador(cita.inicio)}`
        : `${cliente.entorno} movió su ${cita.etiqueta.toLowerCase()} al ${fechaEcuador(nuevo!)}`);
    const detalle =
      `${cliente.nombre} lo hizo por Telegram.` +
      (accion === "reprogramada" ? ` Antes: ${fechaEcuador(cita.inicio)}.` : "") +
      (motivoCliente ? `\nMotivo: ${motivoCliente}` : "") +
      (urgente ? "\n\nFaltaban menos de 48 horas: hay que reacomodar la agenda." : "") +
      "\nYa quedó en el calendario del CRM.";

    // Sobre la hora avisa a TODOS los de esa cita y a atención (Genesis).
    // Dirección solo si hace falta de verdad: eso lo decide la IA.
    const correos = [...new Set([
      ...cita.correos,
      ...(urgente ? equipoAtencionService.correos("atencion") : []),
      ...(avisarDireccion ? ["dquimi@bakano.ec", "dreyes@bakano.ec"] : []),
    ])];

    const tareas: Promise<unknown>[] = [slackService.avisarEquipo({ titulo, detalle, correos })];
    if (urgente) {
      // Un DM llega; un mensaje en el canal a esta altura puede no verse.
      tareas.push(...correos.map((c) => slackService.mensajeDirecto(c, titulo, detalle)));
    }
    if (cita.tipo !== "produccion" || accion === "cancelada" || urgente) {
      const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
      tareas.push(
        ...internos.map((u) =>
          notificationService.create(u._id as Types.ObjectId, "reunion_agendada", titulo, detalle, { workspaceId: chat.workspaceId! })
        ),
        resendService.sendSolicitudClienteEmail({
          to: correos,
          tema: cita.etiqueta,
          workspaceName: cliente.entorno,
          clienteNombre: cliente.nombre,
          clienteEmail: cliente.email,
          telegramUsername: chat.telegramUsername,
          mensaje: detalle,
          asunto: titulo,
          encabezado: titulo,
        })
      );
    }
    await Promise.allSettled(tareas);
  }
}

export const citasClienteService = new CitasClienteService();
