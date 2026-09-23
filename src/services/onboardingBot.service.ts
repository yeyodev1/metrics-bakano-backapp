import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import type { EstadoSesionOnboarding } from "../models/workspace.model";
import { ghlService } from "./ghl.service";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { atencionClienteService, fechaEcuador } from "./atencionCliente.service";
import { telegramService, type InlineButton } from "./telegram.service";
import {
  CORREOS_SEGUIMIENTO_ONBOARDING,
  ORDEN_SESIONES,
  SESIONES_ONBOARDING,
  SESION_POR_CALENDARIO,
  type SesionOnboarding,
} from "./onboardingSesiones.service";

/**
 * Onboarding por Telegram.
 *
 * El bot no configura nada tecnico: dice en que paso va el cliente, le agenda
 * la sesion con el responsable (Joel, David o Ariana) y avisa. Las citas que
 * el cliente agende por el link del CRM las reconoce el cron y quedan igual
 * de marcadas, para que el estado que ve el cliente nunca mienta.
 */

const DIAS_AGENDA_ONBOARDING = 14;
const ANTICIPACION_MS = 2 * 3_600_000;
// Ventana del cron para reconocer citas agendadas por el link.
const VENTANA_SYNC_DIAS = { atras: 7, adelante: 60 };
/**
 * Solo se avisa de citas recien creadas en el CRM. La primera corrida marca
 * el historial en silencio: si no, el equipo recibiria decenas de avisos de
 * sesiones que ya agendaron hace dias.
 */
const AVISAR_SI_CREADA_HACE_MENOS_DE_MS = 6 * 3_600_000;
const BOT_URL = process.env.TELEGRAM_BOT_URL || "https://t.me/BakanoAgencyBot";

export interface EstadoSesion {
  sesion: SesionOnboarding;
  etiqueta: string;
  emoji: string;
  responsable: string;
  agendada: boolean;
  /** Lo que marco el responsable; si nadie lo movio, se deduce de la agenda. */
  estado: EstadoSesionOnboarding;
  fecha?: Date;
  link: string;
  requisitos: string[];
  resumen: string;
}

export interface EstadoOnboarding {
  sesiones: EstadoSesion[];
  /** Siguiente sesion por agendar, en orden. */
  siguiente?: SesionOnboarding;
  completo: boolean;
  produccion: { agendada?: Date; puedeAgendar: boolean; desde?: Date };
}

export type ResultadoAgenda =
  | { ok: true; cuando: string; responsable: string }
  | { ok: false; motivo: "ya_agendada" | "sin_calendario" | "ocupado" | "error" | "en_curso" | "pasado" };

function normalizar(texto: string): string {
  return (texto || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

class OnboardingBotService {
  private entornosCache: { en: number; lista: { id: Types.ObjectId; n: string }[] } | null = null;

  async estado(workspaceId: Types.ObjectId): Promise<EstadoOnboarding> {
    const [workspace, produccion] = await Promise.all([
      models.workspaces.findById(workspaceId).select("onboardingSesiones").lean(),
      atencionClienteService.estadoProduccion(workspaceId),
    ]);

    const sesiones: EstadoSesion[] = ORDEN_SESIONES.map((s) => {
      const def = SESIONES_ONBOARDING[s];
      const guardada = workspace?.onboardingSesiones?.[s];
      return {
        sesion: s,
        etiqueta: def.etiqueta,
        emoji: def.emoji,
        responsable: def.responsable.nombre,
        agendada: Boolean(guardada?.agendada),
        estado: guardada?.estado && guardada.estado !== "pendiente" ? guardada.estado : guardada?.agendada ? "agendada" : "pendiente",
        fecha: guardada?.fecha,
        link: def.link,
        requisitos: def.requisitos,
        resumen: def.resumen,
      };
    });

    // Una sesion esta resuelta si esta agendada o si el responsable la marco
    // cumplida o "no aplica": esas no pueden aparecer como "lo que sigue".
    const resuelta = (s: EstadoSesion) => s.agendada || s.estado === "cumplida" || s.estado === "no_aplica";
    return {
      sesiones,
      siguiente: sesiones.find((s) => !resuelta(s))?.sesion,
      completo: sesiones.every(resuelta),
      produccion: {
        agendada: produccion.proxima,
        puedeAgendar: produccion.puedeAgendar,
        desde: produccion.habilitadaDesde,
      },
    };
  }

  async horarios(sesion: SesionOnboarding): Promise<Date[] | null> {
    if (!ghlService.isConfigured()) return null;
    try {
      const desde = new Date(Date.now() + ANTICIPACION_MS);
      return await ghlService.getFreeSlots(
        SESIONES_ONBOARDING[sesion].calendarioId,
        desde,
        new Date(desde.getTime() + DIAS_AGENDA_ONBOARDING * 86_400_000)
      );
    } catch (error: any) {
      console.error("[Onboarding] horarios:", error.response?.data || error.message);
      return [];
    }
  }

  /** Agenda la sesion en el calendario del responsable y avisa. */
  async agendar(chat: ITelegramChat, sesion: SesionOnboarding, inicio: Date): Promise<ResultadoAgenda> {
    if (!ghlService.isConfigured()) return { ok: false, motivo: "sin_calendario" };

    const workspaceId = chat.workspaceId!;
    if (inicio.getTime() < Date.now()) return { ok: false, motivo: "pasado" };
    const estado = await this.estado(workspaceId);
    if (estado.sesiones.find((s) => s.sesion === sesion)?.agendada) return { ok: false, motivo: "ya_agendada" };

    const cliente = await atencionClienteService.datosCliente(chat);
    if (!cliente.email) return { ok: false, motivo: "error" };

    // Candado: dos toques seguidos (o la IA y un boton) no crean dos citas.
    if (!(await atencionClienteService.tomarCandado(chat))) return { ok: false, motivo: "en_curso" };
    try {
      return await this.agendarConCandado(chat, sesion, inicio, cliente);
    } finally {
      await atencionClienteService.soltarCandado(chat);
    }
  }

  private async agendarConCandado(
    chat: ITelegramChat,
    sesion: SesionOnboarding,
    inicio: Date,
    cliente: Awaited<ReturnType<typeof atencionClienteService.datosCliente>>
  ): Promise<ResultadoAgenda> {
    const def = SESIONES_ONBOARDING[sesion];
    const workspaceId = chat.workspaceId!;
    // Relectura dentro del candado: otro pedido pudo agendarla recien.
    const guardada = (await models.workspaces.findById(workspaceId).select(`onboardingSesiones.${sesion}`).lean()) as any;
    const actual = guardada?.onboardingSesiones?.[sesion];
    if (actual?.agendada || actual?.estado === "cumplida" || actual?.estado === "no_aplica") return { ok: false, motivo: "ya_agendada" };

    let appointmentId: string;
    try {
      const libres = await ghlService.getFreeSlots(def.calendarioId, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 86_400_000));
      if (!libres.some((h) => Math.abs(h.getTime() - inicio.getTime()) < 60_000)) return { ok: false, motivo: "ocupado" };

      const contactId = await ghlService.upsertContact({
        email: cliente.email!,
        firstName: cliente.firstName,
        lastName: cliente.lastName,
        companyName: cliente.entorno,
      });
      appointmentId = await ghlService.createAppointment({
        calendarId: def.calendarioId,
        contactId,
        startTime: inicio,
        title: `${cliente.entorno} · ${def.etiqueta} (Telegram)`,
      });
    } catch (error: any) {
      console.error("[Onboarding] no se pudo agendar:", error.response?.data || error.message);
      return { ok: false, motivo: "error" };
    }

    await this.marcar(workspaceId, sesion, { fecha: inicio, appointmentId, origen: "telegram" });
    await this.avisar(workspaceId, sesion, cliente.entorno, cliente.nombre, inicio, "telegram");
    return { ok: true, cuando: fechaEcuador(inicio), responsable: def.responsable.nombre };
  }

  private async marcar(
    workspaceId: Types.ObjectId,
    sesion: SesionOnboarding,
    datos: { fecha: Date; appointmentId?: string; origen: "telegram" | "link" }
  ): Promise<void> {
    // Campo por campo: pisar el subdocumento entero borraba el motivo, la nota
    // y lo pendiente del cliente que habia anotado el responsable.
    const ruta = `onboardingSesiones.${sesion}`;
    // Hay entornos con onboardingSesiones en null: Mongo no deja crear campos
    // dentro de null, asi que primero se deja como objeto vacio.
    await models.workspaces.updateOne(
      { _id: workspaceId, onboardingSesiones: { $type: "null" } },
      { $set: { onboardingSesiones: {} } }
    );
    await models.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          [`${ruta}.agendada`]: true,
          [`${ruta}.fecha`]: datos.fecha,
          [`${ruta}.appointmentId`]: datos.appointmentId,
          [`${ruta}.agendadoEn`]: new Date(),
          [`${ruta}.origen`]: datos.origen,
          [`${ruta}.avisadoEn`]: new Date(),
        },
      }
    );
    // El estado lo decide el responsable si ya lo toco (bloqueada, cumplida,
    // no aplica); solo si no, pasa a "agendada".
    await models.workspaces.updateOne(
      { _id: workspaceId, [`${ruta}.estado`]: { $nin: ["bloqueada", "cumplida", "no_aplica"] } },
      { $set: { [`${ruta}.estado`]: "agendada" } }
    );

    // Tambien en la bitacora: el tablero tiene que poder contar la historia
    // completa, venga del bot o del link del CRM.
    await models.onboardingEventos
      .create({
        workspaceId,
        paso: sesion,
        estado: "agendada",
        nota: `Agendada ${datos.origen === "telegram" ? "por Telegram" : "desde el link del CRM"} para el ${fechaEcuador(datos.fecha)}`,
        origen: "sistema",
      })
      .catch((error: any) => console.error("[Onboarding] bitácora:", error?.message || error));
  }

  /** La sesion vuelve a pendiente (se cancelo). No toca motivo ni nota del responsable. */
  async desmarcar(workspaceId: Types.ObjectId, sesion: SesionOnboarding, nota: string): Promise<void> {
    const ruta = `onboardingSesiones.${sesion}`;
    // Si el responsable ya la marco cumplida o "no aplica", eso manda.
    const r = await models.workspaces.updateOne(
      { _id: workspaceId, [`${ruta}.estado`]: { $nin: ["cumplida", "no_aplica"] } },
      {
        $set: { [`${ruta}.agendada`]: false },
        $unset: { [`${ruta}.fecha`]: 1, [`${ruta}.appointmentId`]: 1, [`${ruta}.agendadoEn`]: 1 },
      }
    );
    if (!r.modifiedCount) return;
    // "bloqueada" (con su motivo) la puso el responsable: se conserva.
    await models.workspaces.updateOne(
      { _id: workspaceId, [`${ruta}.estado`]: { $in: ["agendada", "pendiente", null] } },
      { $set: { [`${ruta}.estado`]: "pendiente" } }
    );
    await models.onboardingEventos
      .create({ workspaceId, paso: sesion, estado: "pendiente", nota, origen: "sistema" })
      .catch((error: any) => console.error("[Onboarding] bitácora:", error?.message || error));
  }

  /** La sesion se movio: nueva fecha, mismo estado. */
  async moverFecha(workspaceId: Types.ObjectId, sesion: SesionOnboarding, fecha: Date, nota: string): Promise<void> {
    const ruta = `onboardingSesiones.${sesion}`;
    await models.workspaces.updateOne(
      { _id: workspaceId },
      { $set: { [`${ruta}.fecha`]: fecha, [`${ruta}.actualizadoEn`]: new Date() } }
    );
    await models.onboardingEventos
      .create({ workspaceId, paso: sesion, estado: "agendada", nota, origen: "sistema" })
      .catch((error: any) => console.error("[Onboarding] bitácora:", error?.message || error));
  }

  /** Aviso al responsable de la sesion (Slack + correo + in-app) y a seguimiento. */
  private async avisar(
    workspaceId: Types.ObjectId,
    sesion: SesionOnboarding,
    entorno: string,
    cliente: string,
    fecha: Date,
    origen: "telegram" | "link"
  ): Promise<void> {
    const def = SESIONES_ONBOARDING[sesion];
    const cuando = fechaEcuador(fecha);
    const titulo = `${def.emoji} ${entorno} agendó su sesión de ${def.etiqueta} · ${cuando}`;
    const cuerpo =
      `${cliente} agendó ${origen === "telegram" ? "por Telegram" : "desde el link del CRM"} su sesión de ${def.etiqueta} con ${def.responsable.nombre} para el ${cuando} (hora Ecuador).\n\n` +
      `Cuando la termines, marca la cita como "Showed" en el CRM: con eso el bot da la sesión por cumplida y lleva al cliente al siguiente paso solo. ` +
      `Si el cliente no llegó, márcala como "No Show" y el bot le ofrece reagendarla.`;
    const correos = [...new Set([def.responsable.email, ...CORREOS_SEGUIMIENTO_ONBOARDING])];

    const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "reunion_agendada", titulo, cuerpo, { workspaceId })
      ),
      slackService.avisarEquipo({ titulo, detalle: cuerpo, correos }),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: `onboarding · ${def.etiqueta}`,
        workspaceName: entorno,
        clienteNombre: cliente,
        mensaje: cuerpo,
        asunto: titulo,
        encabezado: `${entorno} agendó su onboarding`,
      }),
    ]);
  }

  /**
   * Reconoce las citas que el cliente agendo por el link del CRM y las marca.
   * Sin esto el bot diria "te falta agendar" a alguien que ya agendo.
   */
  async sincronizarDesdeCrm(): Promise<{
    revisadas: number;
    marcadas: number;
    cumplidas: number;
    avisadas: number;
    /** Citas futuras que no se pudieron asociar a ningún entorno. */
    sinResolver: { titulo: string; cuando: string; sesion: string; motivo: string }[];
    omitido?: string;
  }> {
    if (!ghlService.isConfigured())
      return { revisadas: 0, marcadas: 0, cumplidas: 0, avisadas: 0, sinResolver: [], omitido: "GHL sin configurar" };

    const desde = new Date(Date.now() - VENTANA_SYNC_DIAS.atras * 86_400_000);
    const hasta = new Date(Date.now() + VENTANA_SYNC_DIAS.adelante * 86_400_000);
    const eventos = await ghlService.getCalendarEvents(
      ORDEN_SESIONES.map((s) => SESIONES_ONBOARDING[s].calendarioId),
      desde,
      hasta
    );

    let marcadas = 0;
    let cumplidas = 0;
    let avisadas = 0;
    const sinResolver: { titulo: string; cuando: string; sesion: string; motivo: string }[] = [];
    // Por que se descarta cada cita: sin esto el cron dice "0 marcadas" y no
    // hay forma de saber si fue por el contacto, por el correo o por el entorno.
    const descartes: Record<string, number> = {};
    const descartar = (motivo: string) => {
      descartes[motivo] = (descartes[motivo] || 0) + 1;
    };
    const contactos = new Map<string, any>();
    // Canceladas primero: si el cliente reagendo por el link (cancela A, crea
    // B), A se desmarca antes de mirar B y B se marca en esta misma pasada.
    const esCancelada = (e: any) => ["cancelled", "canceled", "invalid"].includes(String(e.appointmentStatus || "").toLowerCase());
    eventos.sort((a: any, b: any) => Number(esCancelada(b)) - Number(esCancelada(a)));
    for (const evento of eventos) {
      const sesion = SESION_POR_CALENDARIO[evento.calendarId];
      const inicio = evento.startTime ? new Date(evento.startTime) : null;
      if (!sesion || !inicio || Number.isNaN(inicio.getTime())) {
        descartar("sin sesión o sin fecha");
        continue;
      }
      // Reuniones de guiones que agenda el bot: mismo calendario que la sesion
      // de Estrategia de Ariana, pero no son la sesion de onboarding.
      if (/·\s*Reunión de /i.test(String(evento.title || ""))) {
        descartar("reunión del bot, no es sesión de onboarding");
        continue;
      }

      // Si ya estaba marcada con esta misma cita, se sigue el CRM: cancelada
      // la desmarca y un cambio de hora actualiza la fecha.
      const marcada = (await models.workspaces
        .findOne({ [`onboardingSesiones.${sesion}.appointmentId`]: evento.id })
        .select(`_id onboardingSesiones.${sesion}`)
        .lean()) as any;
      const estadoCita = String(evento.appointmentStatus || "").toLowerCase();

      // El responsable marca la cita como "asistió" en el CRM: ahí es cuando
      // la sesión queda cumplida y el bot empuja al cliente al siguiente paso.
      if (estadoCita === "showed") {
        const workspaceId = marcada?._id || (await this.entornoDelEvento(evento, contactos, sesion));
        if (!workspaceId) {
          descartar("asistió pero sin entorno");
          continue;
        }
        if (await this.marcarCumplida(workspaceId, sesion)) {
          cumplidas++;
          descartar("marcada como cumplida desde el CRM");
        } else {
          descartar("ya estaba cumplida");
        }
        continue;
      }

      if (["cancelled", "canceled", "noshow", "invalid"].includes(estadoCita)) {
        if (marcada) {
          const motivo = estadoCita === "noshow" ? "El cliente no asistió (marcado en el CRM)" : "Cancelada en el CRM";
          await this.desmarcar(marcada._id, sesion, motivo);
          if (estadoCita === "noshow") await this.avisarReagendar(marcada._id, sesion);
          descartar(estadoCita === "noshow" ? "no asistió: vuelve a pendiente" : "cancelada en el CRM: se desmarcó");
        } else {
          descartar("cita cancelada");
        }
        continue;
      }
      if (marcada) {
        const guardada = marcada.onboardingSesiones?.[sesion]?.fecha;
        if (guardada && Math.abs(new Date(guardada).getTime() - inicio.getTime()) > 60_000) {
          await this.moverFecha(marcada._id, sesion, inicio, `Movida en el CRM al ${fechaEcuador(inicio)}`);
          descartar("movida en el CRM: se actualizó la fecha");
        } else {
          descartar("ya estaba marcada");
        }
        continue;
      }

      if (!contactos.has(evento.contactId)) contactos.set(evento.contactId, await ghlService.getContact(evento.contactId));
      const correo = String(contactos.get(evento.contactId)?.email || "").toLowerCase();
      if (!correo) {
        descartar("contacto del CRM sin correo");
        continue;
      }

      const resuelto = await this.entornoDeLaCita(correo, contactos.get(evento.contactId), evento.title);
      if (!resuelto.id) {
        descartar(resuelto.motivo || "sin entorno");
        // Solo importan las que están por venir: una sesión futura que el bot
        // no sabe de quién es, es una sesión que nadie va a ver reflejada.
        if (inicio.getTime() > Date.now()) {
          sinResolver.push({
            titulo: evento.title || "(sin título)",
            cuando: fechaEcuador(inicio),
            sesion: SESIONES_ONBOARDING[sesion].etiqueta,
            motivo: resuelto.motivo || "sin entorno",
          });
        }
        continue;
      }
      const workspaceId = resuelto.id;

      const workspace = await models.workspaces.findById(workspaceId).select("name onboardingSesiones").lean();
      const guardada = workspace?.onboardingSesiones?.[sesion];
      if (guardada?.agendada || guardada?.estado === "cumplida" || guardada?.estado === "no_aplica") {
        descartar("ya estaba marcada o resuelta");
        continue;
      }

      await this.marcar(workspaceId, sesion, { fecha: inicio, appointmentId: evento.id, origen: "link" });
      marcadas++;

      const creada = new Date(evento.dateAdded || evento.createdAt || evento.dateUpdated || 0);
      const recien = !Number.isNaN(creada.getTime()) && Date.now() - creada.getTime() < AVISAR_SI_CREADA_HACE_MENOS_DE_MS;
      if (!recien || inicio.getTime() < Date.now()) continue;

      await this.avisar(
        workspaceId,
        sesion,
        workspace?.name || "Cliente",
        contactos.get(evento.contactId)?.contactName || correo,
        inicio,
        "link"
      );
      avisadas++;
    }
    if (Object.keys(descartes).length) {
      console.log("[Onboarding] citas descartadas:", JSON.stringify(descartes));
    }
    return { revisadas: eventos.length, marcadas, cumplidas, avisadas, sinResolver };
  }

  /** El entorno de una cita del CRM, resolviendo el contacto si hace falta. */
  private async entornoDelEvento(evento: any, contactos: Map<string, any>, sesion: SesionOnboarding): Promise<Types.ObjectId | null> {
    if (!contactos.has(evento.contactId)) contactos.set(evento.contactId, await ghlService.getContact(evento.contactId));
    const contacto = contactos.get(evento.contactId);
    const correo = String(contacto?.email || "").toLowerCase();
    if (!correo) return null;
    const resuelto = await this.entornoDeLaCita(correo, contacto, evento.title);
    return resuelto.id ?? null;
  }

  /**
   * La sesion se dio: el responsable marco "asistió" en el CRM. Queda cumplida
   * (aunque el cliente la hubiera agendado por el link y no por el bot) y al
   * cliente se le avisa por Telegram con el siguiente paso, que es justo lo
   * que antes se quedaba esperando a que alguien lo escribiera a mano.
   */
  async marcarCumplida(workspaceId: Types.ObjectId, sesion: SesionOnboarding, nota = "Marcada como asistida en el CRM"): Promise<boolean> {
    const ruta = `onboardingSesiones.${sesion}`;
    const r = await models.workspaces.updateOne(
      { _id: workspaceId, [`${ruta}.estado`]: { $nin: ["cumplida", "no_aplica"] } },
      { $set: { [`${ruta}.agendada`]: true, [`${ruta}.estado`]: "cumplida", [`${ruta}.actualizadoEn`]: new Date() } }
    );
    if (!r.modifiedCount) return false;

    await models.onboardingEventos
      .create({ workspaceId, paso: sesion, estado: "cumplida", nota, origen: "sistema" })
      .catch((error: any) => console.error("[Onboarding] bitácora:", error?.message || error));
    await this.avisarAvanceAlCliente(workspaceId, sesion).catch((error: any) =>
      console.error("[Onboarding] aviso de avance:", error?.message || error)
    );
    return true;
  }

  /**
   * "Ya cerramos esta sesión, lo que sigue es X": va a los chats de Telegram
   * de ese entorno con el botón para agendar lo siguiente.
   */
  private async avisarAvanceAlCliente(workspaceId: Types.ObjectId, sesion: SesionOnboarding): Promise<void> {
    const chats = await models.telegramChats.find({ workspaceId, estado: "listo" }).select("chatId").lean();
    if (!chats.length) return;

    const def = SESIONES_ONBOARDING[sesion];
    const estado = await this.estado(workspaceId);
    const siguiente = estado.siguiente ? SESIONES_ONBOARDING[estado.siguiente] : null;

    const texto = siguiente
      ? `Listo, cerramos tu sesión de <b>${def.etiqueta}</b> con ${def.responsable.nombre} ✅\n\n` +
        `Lo que sigue es <b>${siguiente.etiqueta}</b> con <b>${siguiente.responsable.nombre}</b>.\n${siguiente.resumen}\n\n` +
        `Te la agendo ahora?`
      : estado.produccion.puedeAgendar
        ? `Listo, cerramos tu sesión de <b>${def.etiqueta}</b> con ${def.responsable.nombre} ✅\n\n` +
          "Con eso terminas tus sesiones 🎉 lo que sigue es tu <b>primera producción</b>: la grabación de tu avatar y de tus productos.\n\nLa agendamos?"
        : `Listo, cerramos tu sesión de <b>${def.etiqueta}</b> con ${def.responsable.nombre} ✅\n\nCualquier cosa me escribes.`;

    const botones: InlineButton[][] = siguiente
      ? [[{ text: `📅 Agendar ${siguiente.etiqueta}`, callback_data: `onb:${estado.siguiente}` }], [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }]]
      : estado.produccion.puedeAgendar
        ? [[{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }], [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }]]
        : [[{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }]];

    for (const chat of chats) {
      await telegramService.sendMessage(chat.chatId, texto, botones).catch((error: any) => {
        console.error("[Onboarding] no se pudo avisar al cliente:", error?.message || error);
      });
    }
  }

  /**
   * Digest para el equipo con las sesiones futuras que el bot no pudo asociar
   * a un entorno. Sin esto el cliente ve "te falta agendar" aunque ya agendó,
   * y nadie se entera de que en el CRM la cita quedó sin identificar.
   */
  async avisarSesionesSinEntorno(sinResolver: { titulo: string; cuando: string; sesion: string; motivo: string }[]): Promise<boolean> {
    if (!sinResolver.length) return false;
    const detalle = [
      `Hay ${sinResolver.length} ${sinResolver.length === 1 ? "sesión agendada" : "sesiones agendadas"} en el CRM que no puedo asociar a ningún entorno:`,
      "",
      ...sinResolver.map((s) => `• ${s.cuando} · ${s.sesion} · "${s.titulo}"\n   ${s.motivo}`),
      "",
      "Cómo se arregla: pon el nombre del entorno (tal como está en metrics.bakano.ec) al inicio del título de la cita, " +
        "o crea el entorno y el usuario del cliente en la plataforma. Mientras tanto, el bot le sigue diciendo al cliente que le falta agendar.",
    ].join("\n");

    const correos = [...new Set([...CORREOS_SEGUIMIENTO_ONBOARDING, "dreyes@bakano.ec"])];
    return slackService
      .avisarEquipo({ titulo: "🗂️ Sesiones de onboarding sin entorno en el CRM", detalle, correos })
      .catch((error: any) => {
        console.error("[Onboarding] Slack sin entorno:", error?.message || error);
        return false;
      });
  }

  /** La sesion no se dio: se le ofrece agendarla de nuevo, sin reproches. */
  private async avisarReagendar(workspaceId: Types.ObjectId, sesion: SesionOnboarding): Promise<void> {
    const chats = await models.telegramChats.find({ workspaceId, estado: "listo" }).select("chatId").lean();
    const def = SESIONES_ONBOARDING[sesion];
    for (const chat of chats) {
      await telegramService
        .sendMessage(
          chat.chatId,
          `Vi que no pudimos hacer tu sesión de <b>${def.etiqueta}</b> con ${def.responsable.nombre} 😅\n\nLa dejamos para otro día? Te muestro horarios.`,
          [
            [{ text: `📅 Agendar ${def.etiqueta}`, callback_data: `onb:${sesion}` }],
            [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
          ]
        )
        .catch((error: any) => console.error("[Onboarding] aviso de reagendar:", error?.message || error));
    }
  }

  /**
   * De quien es la cita. En el CRM el contacto no siempre es el cliente: en
   * los calendarios de soporte el contacto es el propio responsable, y hay
   * clientes que agendan con un correo personal que no esta en la plataforma.
   * Por eso se resuelve en cascada: usuario → empresa del contacto → titulo.
   */
  private async entornoDeLaCita(
    correo: string,
    contacto: any,
    titulo?: string
  ): Promise<{ id?: Types.ObjectId; motivo?: string }> {
    // Un correo de Bakano nunca es el cliente: en los calendarios de soporte
    // el contacto es el propio responsable (David, Joel…), y de quien es la
    // sesion se saca del titulo ("Depil - CRM MEET") o de la empresa.
    const esDelEquipo = /@bakano\.ec$/i.test(correo);
    const usuario = esDelEquipo
      ? null
      : await models.users.findOne({ email: correo }).select("workspaceId workspaces isInternal").lean();
    // Un correo puede estar en VARIOS entornos (agencias, socios, pruebas).
    // Antes se tomaba el primero del array y la sesion se marcaba en el
    // entorno equivocado, sin que nadie se enterara.
    const suyos = [
      ...new Set(
        [usuario?.workspaceId, ...(usuario?.workspaces || []).map((w: any) => w.workspaceId)]
          .filter(Boolean)
          .map((id: any) => String(id))
      ),
    ];
    if (!usuario?.isInternal && suyos.length === 1) return { id: new Types.ObjectId(suyos[0]) };

    for (const texto of this.nombresCandidatos(contacto, titulo, esDelEquipo)) {
      // Si el correo ya tiene entornos, el nombre solo desempata entre ESOS.
      const id = await this.entornoPorNombre(texto, suyos.length ? new Set(suyos) : undefined);
      if (id) return { id };
    }

    return {
      motivo: esDelEquipo || usuario?.isInternal
        ? "cita en el calendario del equipo y el título no dice de qué cliente es"
        : suyos.length > 1
          ? `el correo está en ${suyos.length} entornos y la cita no dice cuál (falta la empresa en el contacto del CRM)`
          : usuario
            ? "el usuario existe en Metrics pero no está asignado a ningún entorno"
            : "el correo no existe en Metrics y la empresa del contacto no coincide con ningún entorno",
    };
  }

  /**
   * Nombres que pueden identificar al cliente, del mas fiable al menos.
   *
   * Los titulos del CRM vienen como "Empresa / Persona - Meta Sessions" o
   * "Depil - CRM MEET": el nombre util es lo que va antes de la barra o del
   * guion, no el titulo entero (que ademas trae el nombre de la sesion).
   */
  private nombresCandidatos(contacto: any, titulo?: string, esDelEquipo = false): string[] {
    const t = (titulo || "").trim();
    const candidatos = [
      // La empresa del responsable ("david s.a") no dice de que cliente es.
      esDelEquipo ? "" : contacto?.companyName,
      t.split("/")[0],
      t.split(" - ")[0],
      t,
    ];
    return [...new Set(candidatos.map((x) => String(x || "").trim()).filter((x) => x.length >= 4))];
  }

  /**
   * Empareja "MEMOS", "DOX SA" o "Saori - CRM MEET" con su entorno.
   *
   * Cuatro pasadas, de la mas segura a la mas floja, y cada una exige que la
   * coincidencia sea UNICA: si dos entornos encajan, se prefiere no marcar
   * nada antes que marcar el equivocado (eso ya paso una vez).
   */
  private async entornoPorNombre(texto: string, permitidos?: Set<string>): Promise<Types.ObjectId | undefined> {
    const objetivo = normalizar(texto);
    if (objetivo.length < 3) return undefined;
    // Palabras del texto original: normalizar junta todo ("DOX SA" → "doxsa").
    const palabras = new Set(
      texto
        .split(/[^\p{L}\p{N}]+/u)
        .map((p) => normalizar(p))
        .filter((p) => p.length >= 3)
    );

    if (!this.entornosCache || Date.now() - this.entornosCache.en > 10 * 60_000) {
      const lista = await models.workspaces.find({ isActive: true }).select("_id name").lean();
      this.entornosCache = {
        en: Date.now(),
        lista: lista.map((w) => ({ id: w._id as Types.ObjectId, n: normalizar(w.name) })),
      };
    }
    const candidatos = permitidos
      ? this.entornosCache.lista.filter((w) => permitidos.has(String(w.id)))
      : this.entornosCache.lista;

    const unico = (encontrados: { id: Types.ObjectId }[]) => (encontrados.length === 1 ? encontrados[0]!.id : undefined);
    return (
      // 1. Igual: "Megaprinter" → "Megaprinter".
      unico(candidatos.filter((w) => w.n && w.n === objetivo)) ??
      // 2. El entorno es una palabra del texto: "DOX SA" → "DOX".
      unico(candidatos.filter((w) => w.n.length >= 3 && palabras.has(w.n))) ??
      // 3. El entorno dentro del texto: "Flash CarWash" → "FLASH CAR".
      unico(candidatos.filter((w) => w.n.length >= 5 && objetivo.includes(w.n))) ??
      // 4. El texto dentro del entorno: "Saori" → "Saori Sushi".
      unico(candidatos.filter((w) => objetivo.length >= 5 && w.n.includes(objetivo)))
    );
  }

  /**
   * Correo de arranque de un entorno: descarga de Telegram, link del bot y
   * acceso a la plataforma. Idempotente: `onboardingBienvenidaEnviadaEn`
   * garantiza que salga una sola vez por entorno.
   */
  async enviarBienvenida(workspaceId: Types.ObjectId | string, opts: { forzar?: boolean } = {}): Promise<boolean> {
    const id = new Types.ObjectId(String(workspaceId));
    const workspace = await models.workspaces.findById(id).select("name isActive onboardingBienvenidaEnviadaEn").lean();
    if (!workspace || !workspace.isActive) return false;
    if (workspace.onboardingBienvenidaEnviadaEn && !opts.forzar) return false;

    const clientes = await models.users
      .find({ isInternal: { $ne: true }, isActive: true, $or: [{ workspaceId: id }, { "workspaces.workspaceId": id }] })
      .select("email name")
      .lean();
    const destinatarios = clientes.map((c) => c.email).filter(Boolean);
    if (!destinatarios.length) return false;

    // Se marca antes de enviar: si Resend falla, el cron reintenta, pero dos
    // altas seguidas no pueden disparar dos correos al mismo entorno.
    await models.workspaces.updateOne({ _id: id }, { $set: { onboardingBienvenidaEnviadaEn: new Date() } });

    try {
      await resendService.sendOnboardingBienvenida({
        to: destinatarios,
        recipientName: clientes[0]?.name,
        workspaceName: workspace.name,
        botUrl: BOT_URL,
        correoCliente: destinatarios[0],
        sesiones: ORDEN_SESIONES.map((s) => ({
          etiqueta: SESIONES_ONBOARDING[s].etiqueta,
          responsable: SESIONES_ONBOARDING[s].responsable.nombre,
          link: SESIONES_ONBOARDING[s].link,
          resumen: SESIONES_ONBOARDING[s].resumen,
        })),
      });
      console.log(`[Onboarding] bienvenida enviada a ${workspace.name} (${destinatarios.length} destinatarios)`);
      return true;
    } catch (error: any) {
      console.error(`[Onboarding] bienvenida de ${workspace.name}:`, error?.message || error);
      await models.workspaces.updateOne({ _id: id }, { $unset: { onboardingBienvenidaEnviadaEn: 1 } });
      return false;
    }
  }

  /**
   * Red de seguridad del cron: entornos que se quedaron sin su correo.
   * Solo a partir de ONBOARDING_BIENVENIDA_DESDE, para no escribirle de golpe
   * a toda la cartera vieja.
   */
  async enviarBienvenidasPendientes(): Promise<{ enviadas: number }> {
    const corte = process.env.ONBOARDING_BIENVENIDA_DESDE ? new Date(process.env.ONBOARDING_BIENVENIDA_DESDE) : null;
    if (!corte || Number.isNaN(corte.getTime())) return { enviadas: 0 };

    const pendientes = await models.workspaces
      .find({ isActive: true, createdAt: { $gte: corte }, onboardingBienvenidaEnviadaEn: { $in: [null, undefined] } })
      .select("name")
      .limit(10)
      .lean();

    let enviadas = 0;
    for (const workspace of pendientes) {
      if (await this.enviarBienvenida(workspace._id as Types.ObjectId)) enviadas++;
    }
    return { enviadas };
  }
}

export const onboardingBotService = new OnboardingBotService();
