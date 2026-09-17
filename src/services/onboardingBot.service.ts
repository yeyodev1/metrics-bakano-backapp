import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { ghlService } from "./ghl.service";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { atencionClienteService, fechaEcuador } from "./atencionCliente.service";
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
  | { ok: false; motivo: "ya_agendada" | "sin_calendario" | "ocupado" | "error" };

class OnboardingBotService {
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
        fecha: guardada?.fecha,
        link: def.link,
        requisitos: def.requisitos,
        resumen: def.resumen,
      };
    });

    return {
      sesiones,
      siguiente: sesiones.find((s) => !s.agendada)?.sesion,
      completo: sesiones.every((s) => s.agendada),
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
    const def = SESIONES_ONBOARDING[sesion];
    if (!ghlService.isConfigured()) return { ok: false, motivo: "sin_calendario" };

    const workspaceId = chat.workspaceId!;
    const estado = await this.estado(workspaceId);
    if (estado.sesiones.find((s) => s.sesion === sesion)?.agendada) return { ok: false, motivo: "ya_agendada" };

    const cliente = await atencionClienteService.datosCliente(chat);
    if (!cliente.email) return { ok: false, motivo: "error" };

    let appointmentId: string;
    try {
      const libres = await ghlService.getFreeSlots(def.calendarioId, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 86_400_000));
      if (!libres.some((h) => Math.abs(h.getTime() - inicio.getTime()) < 60_000)) return { ok: false, motivo: "ocupado" };

      const contactId = await ghlService.upsertContact({
        email: cliente.email,
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
    await models.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          [`onboardingSesiones.${sesion}`]: {
            agendada: true,
            fecha: datos.fecha,
            appointmentId: datos.appointmentId,
            agendadoEn: new Date(),
            origen: datos.origen,
            avisadoEn: new Date(),
          },
        },
      }
    );
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
    const cuerpo = `${cliente} agendó ${origen === "telegram" ? "por Telegram" : "desde el link del CRM"} su sesión de ${def.etiqueta} con ${def.responsable.nombre} para el ${cuando} (hora Ecuador).`;
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
  async sincronizarDesdeCrm(): Promise<{ revisadas: number; marcadas: number; avisadas: number; omitido?: string }> {
    if (!ghlService.isConfigured()) return { revisadas: 0, marcadas: 0, avisadas: 0, omitido: "GHL sin configurar" };

    const desde = new Date(Date.now() - VENTANA_SYNC_DIAS.atras * 86_400_000);
    const hasta = new Date(Date.now() + VENTANA_SYNC_DIAS.adelante * 86_400_000);
    const eventos = await ghlService.getCalendarEvents(
      ORDEN_SESIONES.map((s) => SESIONES_ONBOARDING[s].calendarioId),
      desde,
      hasta
    );

    let marcadas = 0;
    let avisadas = 0;
    const contactos = new Map<string, any>();
    for (const evento of eventos) {
      const sesion = SESION_POR_CALENDARIO[evento.calendarId];
      const inicio = evento.startTime ? new Date(evento.startTime) : null;
      if (!sesion || !inicio || Number.isNaN(inicio.getTime())) continue;
      if (["cancelled", "canceled", "noshow"].includes(String(evento.appointmentStatus || "").toLowerCase())) continue;

      if (!contactos.has(evento.contactId)) contactos.set(evento.contactId, await ghlService.getContact(evento.contactId));
      const correo = String(contactos.get(evento.contactId)?.email || "").toLowerCase();
      if (!correo) continue;

      const usuario = await models.users.findOne({ email: correo }).select("workspaceId workspaces").lean();
      const workspaceId = (usuario?.workspaceId || usuario?.workspaces?.[0]?.workspaceId) as Types.ObjectId | undefined;
      if (!workspaceId) continue;

      const workspace = await models.workspaces.findById(workspaceId).select("name onboardingSesiones").lean();
      if (workspace?.onboardingSesiones?.[sesion]?.agendada) continue;

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
    return { revisadas: eventos.length, marcadas, avisadas };
  }

  /**
   * Correo de arranque: le dice al cliente que todo se maneja por Telegram.
   * Solo a entornos nuevos (corte por ONBOARDING_BIENVENIDA_DESDE) para no
   * escribirle de golpe a toda la cartera.
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
      const clientes = await models.users
        .find({ isInternal: { $ne: true }, isActive: true, $or: [{ workspaceId: workspace._id }, { "workspaces.workspaceId": workspace._id }] })
        .select("email name")
        .lean();
      if (!clientes.length) continue;

      try {
        await resendService.sendOnboardingBienvenida({
          to: clientes.map((c) => c.email).filter(Boolean),
          recipientName: clientes[0]?.name,
          workspaceName: workspace.name,
          botUrl: BOT_URL,
          sesiones: ORDEN_SESIONES.map((s) => ({
            etiqueta: SESIONES_ONBOARDING[s].etiqueta,
            responsable: SESIONES_ONBOARDING[s].responsable.nombre,
            link: SESIONES_ONBOARDING[s].link,
            resumen: SESIONES_ONBOARDING[s].resumen,
          })),
        });
        await models.workspaces.updateOne({ _id: workspace._id }, { $set: { onboardingBienvenidaEnviadaEn: new Date() } });
        enviadas++;
      } catch (error: any) {
        console.error(`[Onboarding] bienvenida de ${workspace.name}:`, error?.message || error);
      }
    }
    return { enviadas };
  }
}

export const onboardingBotService = new OnboardingBotService();
