import { Types } from "mongoose";
import models from "../models";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";
import { fechaEcuador } from "./atencionCliente.service";
import { SESIONES_ONBOARDING } from "./onboardingSesiones.service";

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
        title: { $not: /^CANCELADA/ },
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
        title: { $not: /^CANCELADA/ },
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
