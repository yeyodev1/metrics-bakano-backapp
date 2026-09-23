import { Types } from "mongoose";
import models from "../models";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";
import { fechaEcuador } from "./atencionCliente.service";
import { SESIONES_ONBOARDING } from "./onboardingSesiones.service";
import { contenidoClienteService } from "./contenidoCliente.service";
import { telegramService } from "./telegram.service";
import { equipoAtencionService as equipoAtencion } from "./equipoAtencion.service";

/**
 * Una produccion sin planificacion no sirve.
 *
 * El cliente agenda la grabacion y el dia llega sin guiones: se graba
 * cualquier cosa o se pierde el dia. La produccion y la planificacion son la
 * misma cosa vista desde dos lados, asi que cuando se agenda una grabacion se
 * avisa de una vez a quien escribe los guiones (content managers, community
 * managers y copywriters) y a Genesis, que es quien empuja que se cumpla.
 *
 * Si llegada la fecha sigue sin guiones, el aviso se repite todos los dias:
 * no se deja morir en un correo que nadie abrio.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const ROLES_GUIONES = ["content_manager", "community_manager", "copywriter"];
/** Se insiste desde dos semanas antes: antes de eso todavia hay tiempo de sobra. */
const VENTANA_PRESION_DIAS = 14;
const CADA_MS = 20 * 3_600_000;
/**
 * Cuantos clientes se avisan por corrida. Hoy 63 de 101 entornos estan sin
 * guiones por grabar: mandarlos todos el primer dia seria un correo que nadie
 * abre y 63 clientes escribiendo a la vez. Se atienden los mas urgentes
 * primero y el resto entra en las corridas siguientes.
 */
const MAX_AVISOS_POR_CORRIDA = 12;

export interface EstadoPlanificacion {
  tienePlanificacion: boolean;
  guiones: number;
  listaParaCliente: boolean;
  planningId?: Types.ObjectId;
}

class ProduccionPlanificacionService {
  /** A quien le toca escribir los guiones, mas Genesis. */
  private async destinatarios(): Promise<{ correos: string[]; usuarios: { _id: Types.ObjectId }[] }> {
    const equipo = await models.users
      .find({ isActive: true, isInternal: true, internalRole: { $in: ROLES_GUIONES } })
      .select("_id email")
      .lean();
    const correos = [...new Set([...equipo.map((u) => u.email), ...equipoAtencionService.correos("atencion")])];
    const usuarios = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
    return { correos, usuarios: usuarios as any };
  }

  /** Que tan lista esta la planificacion de esa produccion. */
  async estado(planningId: Types.ObjectId | string): Promise<EstadoPlanificacion> {
    const plan = await models.videoPlanning.findOne({ planningEntryId: planningId }).select("items listaParaCliente").lean();
    return {
      tienePlanificacion: Boolean(plan),
      guiones: (plan as any)?.items?.length || 0,
      listaParaCliente: Boolean((plan as any)?.listaParaCliente),
      planningId: planningId as Types.ObjectId,
    };
  }

  /** La produccion de ese entorno mas cercana a esa fecha (la que se acaba de agendar). */
  async produccionDe(workspaceId: Types.ObjectId, fecha: Date) {
    return models.planning
      .findOne({
        workspaceId,
        date: { $gte: new Date(fecha.getTime() - 60_000), $lte: new Date(fecha.getTime() + 60_000) },
        title: { $not: /^CANCELADA/ }, cancelada: { $ne: true },
      })
      .select("_id date title avisoPlanificacionEn")
      .lean();
  }

  /**
   * Se agendo una grabacion: el equipo de guiones y Genesis se enteran ahora,
   * no la semana de la produccion.
   */
  async avisarNuevaProduccion(opciones: {
    workspaceId: Types.ObjectId;
    entorno: string;
    cliente: string;
    cuando: Date;
    planningId?: Types.ObjectId;
  }): Promise<void> {
    const estado = opciones.planningId ? await this.estado(opciones.planningId) : null;
    const listo = Boolean(estado?.guiones);
    const titulo = `🎬 ${opciones.entorno} grabó fecha: ${fechaEcuador(opciones.cuando)} · ${listo ? "revisar" : "FALTA"} planificación`;
    const detalle =
      `${opciones.cliente} agendó su producción por Telegram para el ${fechaEcuador(opciones.cuando)} (hora Ecuador).\n\n` +
      (listo
        ? `Ya hay ${estado!.guiones} guion${estado!.guiones === 1 ? "" : "es"} en su planificación: revisen que esté al día y aprobado por el cliente.`
        : "⚠️ Todavía NO tiene planificación con guiones. No puede haber producción sin planificación: sin guiones no hay qué grabar y se pierde el día.") +
      `\n\nPlanificación del cliente: ${APP_URL}/app/workspaces/${opciones.workspaceId}/planning`;

    const { correos, usuarios } = await this.destinatarios();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos }),
      ...correos.map((c) => slackService.mensajeDirecto(c, titulo, detalle)),
      ...usuarios.map((u) =>
        notificationService.create(u._id, "produccion_agendada", titulo, detalle, { workspaceId: opciones.workspaceId })
      ),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: "planificación de la producción",
        workspaceName: opciones.entorno,
        clienteNombre: opciones.cliente,
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);

    if (opciones.planningId) {
      await models.planning.updateOne({ _id: opciones.planningId }, { $set: { avisoPlanificacionEn: new Date() } });
    }
  }

  /**
   * Producciones de las proximas dos semanas que siguen sin guiones. Se
   * insiste una vez al dia hasta que exista la planificacion: es la unica
   * forma de que no llegue el dia de grabar sin nada escrito.
   */
  async presionarPendientes(): Promise<{ revisadas: number; insistidas: number }> {
    const ahora = new Date();
    const producciones = await models.planning
      .find({
        date: { $gte: ahora, $lte: new Date(ahora.getTime() + VENTANA_PRESION_DIAS * 86_400_000) },
        title: { $not: /^CANCELADA/ }, cancelada: { $ne: true },
        cumplida: { $ne: true },
      })
      .select("_id workspaceId date title avisoPlanificacionEn")
      .lean();

    let insistidas = 0;
    for (const p of producciones) {
      const estado = await this.estado(p._id as Types.ObjectId);
      if (estado.guiones) continue;
      const ultimo = (p as any).avisoPlanificacionEn ? new Date((p as any).avisoPlanificacionEn).getTime() : 0;
      if (Date.now() - ultimo < CADA_MS) continue;

      const workspace = await models.workspaces.findById(p.workspaceId).select("name").lean();
      const dias = Math.max(0, Math.ceil((new Date(p.date).getTime() - Date.now()) / 86_400_000));
      const titulo = `⚠️ ${workspace?.name || "Cliente"} graba en ${dias} día${dias === 1 ? "" : "s"} y NO tiene guiones`;
      const detalle =
        `La producción es el ${fechaEcuador(new Date(p.date))} (hora Ecuador) y su planificación sigue vacía.\n\n` +
        "No puede haber producción sin planificación: si llega el día sin guiones, se pierde la grabación y el mes del cliente.\n\n" +
        `Planificación: ${APP_URL}/app/workspaces/${p.workspaceId}/planning`;

      const { correos, usuarios } = await this.destinatarios();
      await Promise.allSettled([
        slackService.avisarEquipo({ titulo, detalle, correos }),
        ...correos.map((c) => slackService.mensajeDirecto(c, titulo, detalle)),
        ...usuarios.map((u) =>
          notificationService.create(u._id, "produccion_agendada", titulo, detalle, { workspaceId: p.workspaceId as Types.ObjectId })
        ),
        resendService.sendSolicitudClienteEmail({
          to: correos,
          tema: "producción sin planificación",
          workspaceName: workspace?.name || "Cliente",
          clienteNombre: workspace?.name || "Cliente",
          mensaje: detalle,
          asunto: titulo,
          encabezado: titulo,
        }),
      ]);
      await models.planning.updateOne({ _id: p._id }, { $set: { avisoPlanificacionEn: new Date() } });
      insistidas++;
    }
    return { revisadas: producciones.length, insistidas };
  }

  /**
   * Clientes que se estan quedando sin guiones por grabar y no tienen
   * grabacion en el calendario. Se le avisa al cliente por su chat (con el
   * boton para agendar) y se presiona al equipo. Una vez al dia.
   */
  async avisarContenidoQueSeAcaba(): Promise<{ revisados: number; avisados: number; enCola: number }> {
    const entornos = await models.workspaces.find({ isActive: true }).select("name avisoContenidoEn").lean();

    // Primero se mide todo y se ordena por urgencia: el que esta en cero va
    // antes que el que todavia tiene ocho guiones escritos.
    const candidatos: { w: any; reserva: Awaited<ReturnType<typeof contenidoClienteService.reserva>> }[] = [];
    for (const w of entornos as any[]) {
      const reserva = await contenidoClienteService.reserva(w._id).catch(() => null);
      if (!reserva || !contenidoClienteService.seAcaba(reserva)) continue;
      const ultimo = w.avisoContenidoEn ? new Date(w.avisoContenidoEn).getTime() : 0;
      if (Date.now() - ultimo < CADA_MS) continue;
      candidatos.push({ w, reserva });
    }
    candidatos.sort((a, b) => a.reserva.porGrabar - b.reserva.porGrabar);
    const tanda = candidatos.slice(0, MAX_AVISOS_POR_CORRIDA);
    const enCola = candidatos.length - tanda.length;
    if (enCola) console.log(`[Contenido] ${enCola} entorno(s) quedan para la próxima corrida`);
    let avisados = 0;

    for (const { w, reserva } of tanda) {

      const urgente = reserva.nivel === "sin_contenido";
      const titulo = `${urgente ? "🚨" : "⏳"} ${w.name} ${urgente ? "se quedó sin guiones por grabar" : `solo tiene ${reserva.porGrabar} guiones por grabar`}`;
      const detalle =
        (urgente
          ? "Ya se grabó todo lo que estaba escrito y no tiene ninguna producción agendada.\n\n"
          : `Le quedan ${reserva.porGrabar} guiones por grabar y no tiene producción agendada.\n\n`) +
        `En cola: ${reserva.enEdicion} en edición y ${reserva.listosParaPublicar} listos para publicar.\n\n` +
        "Grabamos hasta quedarnos sin contenido: hay que escribir los guiones nuevos y cerrar fecha de producción con el cliente.\n\n" +
        `Planificación: ${APP_URL}/app/workspaces/${w._id}/planning`;

      const { correos, usuarios } = await this.destinatarios();
      const produccion = equipoAtencion.correos("produccion");
      const todos = [...new Set([...correos, ...produccion])];
      await Promise.allSettled([
        slackService.avisarEquipo({ titulo, detalle, correos: todos }),
        ...todos.map((c) => slackService.mensajeDirecto(c, titulo, detalle)),
        ...usuarios.map((u) => notificationService.create(u._id, "produccion_agendada", titulo, detalle, { workspaceId: w._id })),
        resendService.sendSolicitudClienteEmail({
          to: todos,
          tema: "se acaba el contenido",
          workspaceName: w.name,
          clienteNombre: w.name,
          mensaje: detalle,
          asunto: titulo,
          encabezado: titulo,
        }),
      ]);

      // Y al cliente, por su chat: es su contenido el que se apaga.
      const chats = await models.telegramChats.find({ workspaceId: w._id, estado: "listo" }).select("chatId").lean();
      for (const chat of chats as any[]) {
        await telegramService
          .sendMessage(
            chat.chatId,
            (urgente
              ? "🎬 <b>Ya grabamos todo lo que estaba escrito</b>\n\nNo te quedan guiones por grabar, así que cuando salga lo que está en edición no habrá nada más que publicar."
              : `🎬 <b>Se está acabando tu contenido</b>\n\nTe quedan ${reserva.porGrabar} guiones por grabar.`) +
              `\n\nEn cola tienes ${reserva.enEdicion} en edición y ${reserva.listosParaPublicar} listos para publicar.\n\n` +
              "Grabamos hasta quedarnos sin contenido, así que lo mejor es cerrar fecha ya: mientras antes grabemos, antes vuelves a tener videos saliendo 💪\n\n" +
              "Tu equipo ya está avisado para preparar los guiones nuevos.",
            [
              [{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }],
              [{ text: "📋 Ver mi planificación", url: `${APP_URL}/app/workspaces/${w._id}/planning` }],
              [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
            ]
          )
          .catch((error: any) => console.error("[Contenido] aviso al cliente:", error?.message || error));
      }

      await models.workspaces.updateOne({ _id: w._id }, { $set: { avisoContenidoEn: new Date() } });
      avisados++;
    }
    return { revisados: entornos.length, avisados, enCola };
  }

  /** Lo que se le dice al cliente cuando acaba de agendar su produccion. */
  textoParaElCliente(estado: EstadoPlanificacion | null, workspaceId: Types.ObjectId | string, faltaCrm: boolean): string {
    const crm = SESIONES_ONBOARDING.crm;
    return (
      "\n\n📋 <b>Toda producción necesita su planificación</b>: los guiones de lo que vamos a grabar tienen que estar listos y aprobados por ti <b>antes</b> de la grabación. " +
      (estado?.guiones
        ? `Ya tienes <b>${estado.guiones} guion${estado.guiones === 1 ? "" : "es"}</b> en tu planificación, revísalos aquí:\n${APP_URL}/app/workspaces/${workspaceId}/planning`
        : "Todavía no tienes guiones cargados, así que ya avisé a tu equipo de contenido y a Genesis Benalcazar para que los preparen y te los pasen a revisar.") +
      (faltaCrm
        ? `\n\n🗓️ Y falta algo clave: agenda tu sesión de <b>${crm.etiqueta}</b> con <b>${crm.responsable.nombre}</b>. Él deja listo tu CRM y todo lo que necesitamos para que lo que grabemos llegue a tus clientes.`
        : "")
    );
  }
}

export const produccionPlanificacionService = new ProduccionPlanificacionService();
