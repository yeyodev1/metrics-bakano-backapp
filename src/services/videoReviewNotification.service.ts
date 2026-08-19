import axios from "axios";
import models from "../models";
import { resendService } from "./resend.service";
import { planningNotificationService, type Contacto } from "./planningNotification.service";

const APP_URL = "https://metrics.bakano.ec";

/**
 * Enlace fijo del WhatsApp de revision, igual que el de aprobacion de
 * planificacion: la plantilla de Meta no puede llevar ids, asi que la
 * pantalla de aterrizaje resuelve sola que revision toca.
 */
export const RUTA_REVISION_WHATSAPP = "/app/workspaces/review-videos-from-whatsapp";

/**
 * Con esto ramifica el workflow de GHL para elegir plantilla:
 * primer aviso, insistencia del cron, o confirmacion de que ya reviso.
 */
export type TipoAvisoRevision = "esperando_revision" | "recordatorio" | "revisado";

/** Cada cuanto insiste el cron mientras el cliente no revise. */
const HORAS_ENTRE_RECORDATORIOS = 4;

export interface ResultadoAvisoRevision {
  tipoAviso: TipoAvisoRevision;
  numeroEnvio: number;
  videosListos: number;
  whatsapp: { enviado: boolean; error?: string; contactos: Contacto[] };
  email: { enviado: boolean; error?: string; destinatarios: string[] };
}

export class VideoReviewNotificationService {
  /** Videos que el cliente tiene que revisar: editados, con o sin link. */
  private editados(planning: any): any[] {
    return (planning.items ?? []).filter((i: any) => i.edicion === "EDITADO");
  }

  private deducirTipo(planning: any): { tipo: TipoAvisoRevision; numeroEnvio: number } {
    const desde = planning.revisionCicloIniciadoEn ?? new Date(0);
    const previos = (planning.avisosRevision ?? []).filter(
      (n: any) =>
        n.canal === "whatsapp" &&
        n.exito &&
        n.tipoAviso !== "revisado" &&
        new Date(n.enviadoEn) >= new Date(desde)
    ).length;

    if (previos > 0) return { tipo: "recordatorio", numeroEnvio: previos + 1 };
    return { tipo: "esperando_revision", numeroEnvio: 1 };
  }

  /**
   * Abre el ciclo y manda el primer aviso (o el recordatorio, si ya estaba
   * abierto). Lo dispara el equipo al terminar de editar; el cron reusa esta
   * misma ruta para insistir, asi que el tipo se deduce, no se elige.
   */
  async notificar(planningId: string, porNombre?: string): Promise<ResultadoAvisoRevision> {
    const planning: any = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const listos = this.editados(planning);
    if (!listos.length) throw new Error("SIN_VIDEOS_EDITADOS");

    // Ya reviso todo: insistirle es la forma mas rapida de que ignore el canal.
    if (planning.videosRevisadosEn && !planning.revisionVideosAbierta) {
      throw new Error("YA_REVISADO");
    }

    const { tipo, numeroEnvio } = this.deducirTipo(planning);

    // Primer aviso del ciclo: se abre y cada video editado queda PENDIENTE.
    if (!planning.revisionVideosAbierta) {
      planning.revisionVideosAbierta = true;
      planning.revisionCicloIniciadoEn = new Date();
      for (const item of listos) {
        if (!item.videoClienteAprobacion) item.videoClienteAprobacion = "PENDIENTE";
      }
    }

    const resultado = await this.enviar(planning, tipo, numeroEnvio, porNombre);
    await planning.save();
    return resultado;
  }

  /**
   * El cliente reviso: registra el veredicto por video y, cuando no queda
   * ninguno pendiente, cierra el ciclo y confirma con el aviso "revisado".
   */
  async registrarRevision(
    planningId: string,
    reviews: { itemId: string; estado: "APROBADO" | "RECHAZADO"; motivo?: string }[],
    porUserId?: string
  ): Promise<{ pendientes: number; cicloCerrado: boolean }> {
    const planning: any = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");
    if (!planning.revisionVideosAbierta) throw new Error("REVISION_CERRADA");

    for (const r of reviews) {
      const item = planning.items.id(r.itemId);
      if (!item || item.edicion !== "EDITADO") continue;
      if (r.estado === "RECHAZADO" && !r.motivo?.trim()) throw new Error("MOTIVO_REQUERIDO");
      item.videoClienteAprobacion = r.estado;
      item.videoClienteMotivo = r.estado === "RECHAZADO" ? r.motivo?.trim() : undefined;
      item.videoClienteRevisadoEn = new Date();
    }

    const pendientes = this.editados(planning).filter(
      (i: any) => !i.videoClienteAprobacion || i.videoClienteAprobacion === "PENDIENTE"
    ).length;

    let cicloCerrado = false;
    if (pendientes === 0) {
      planning.revisionVideosAbierta = false;
      planning.videosRevisadosEn = new Date();
      if (porUserId) planning.videosRevisadosPor = porUserId;
      cicloCerrado = true;
      // La confirmacion no debe tumbar la revision si GHL falla: se registra
      // el intento en la auditoria y ya.
      await this.enviar(planning, "revisado", 1).catch(() => undefined);
    }

    await planning.save();
    return { pendientes, cicloCerrado };
  }

  /**
   * Barrido del cron: un recordatorio por ciclo abierto sin actividad en las
   * ultimas 4 horas. Devuelve el resumen para el log del cron.
   */
  async recordatorios(): Promise<{ revisados: number; enviados: number; errores: string[] }> {
    const abiertas: any[] = await models.videoPlanning.find({ revisionVideosAbierta: true });
    const corte = new Date(Date.now() - HORAS_ENTRE_RECORDATORIOS * 60 * 60 * 1000);

    let enviados = 0;
    const errores: string[] = [];

    for (const planning of abiertas) {
      const avisos = (planning.avisosRevision ?? []).filter((n: any) => n.exito);
      const ultimo = avisos.length
        ? new Date(avisos[avisos.length - 1].enviadoEn)
        : new Date(0);
      if (ultimo > corte) continue;

      try {
        const { tipo, numeroEnvio } = this.deducirTipo(planning);
        await this.enviar(planning, tipo, numeroEnvio, "cron");
        await planning.save();
        enviados++;
      } catch (error: any) {
        errores.push(`${planning._id}: ${error.message}`);
      }
    }

    return { revisados: abiertas.length, enviados, errores };
  }

  /**
   * La revision que un entorno tiene abierta, para el aterrizaje del enlace
   * fijo del WhatsApp. La mas reciente, igual que en aprobacion.
   */
  async pendienteDeRevisar(workspaceId: string) {
    const planning: any = await models.videoPlanning
      .findOne({ workspaceId, revisionVideosAbierta: true })
      .sort({ createdAt: -1 })
      .lean();

    if (!planning) return null;

    const listos = this.editados(planning);
    return {
      planningId: String(planning._id),
      planningEntryId: String(planning.planningEntryId),
      workspaceId: String(planning.workspaceId),
      videosListos: listos.length,
      pendientes: listos.filter(
        (i: any) => !i.videoClienteAprobacion || i.videoClienteAprobacion === "PENDIENTE"
      ).length,
      ultimoAviso: planning.avisosRevision?.length
        ? planning.avisosRevision[planning.avisosRevision.length - 1].enviadoEn
        : null,
    };
  }

  /** Auditoria completa del circuito para la pantalla interna. */
  async historial(planningId: string) {
    const planning: any = await models.videoPlanning.findById(planningId).lean();
    if (!planning) throw new Error("NOT_FOUND");

    const avisos = planning.avisosRevision ?? [];
    return {
      revisionAbierta: Boolean(planning.revisionVideosAbierta),
      videosRevisadosEn: planning.videosRevisadosEn ?? null,
      avisos,
      resumen: {
        whatsapp: avisos.filter((n: any) => n.canal === "whatsapp" && n.exito).length,
        email: avisos.filter((n: any) => n.canal === "email" && n.exito).length,
        ultimo: avisos.length ? avisos[avisos.length - 1] : null,
      },
    };
  }

  /** Dispara WhatsApp + correo y deja ambos intentos en la auditoria. */
  private async enviar(
    planning: any,
    tipo: TipoAvisoRevision,
    numeroEnvio: number,
    porNombre?: string
  ): Promise<ResultadoAvisoRevision> {
    const workspace: any = await models.workspaces.findById(planning.workspaceId).lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const { correos, contactos, sinTelefono } =
      await planningNotificationService.destinatarios(workspace._id);
    const enlace = `${APP_URL}${RUTA_REVISION_WHATSAPP}`;
    const videosListos = this.editados(planning).length;
    const totalVideos = planning.items?.length ?? 0;

    const [whatsapp, email] = await Promise.all([
      this.enviarWhatsapp(
        workspace, contactos, sinTelefono, enlace, totalVideos, videosListos, tipo, numeroEnvio
      ),
      this.enviarEmail(correos, workspace.name, enlace, videosListos, tipo),
    ]);

    planning.avisosRevision.push({
      canal: "whatsapp",
      enviadoEn: new Date(),
      porNombre,
      exito: whatsapp.enviado,
      error: whatsapp.error,
      tipoAviso: tipo,
      numeroEnvio,
    });
    planning.avisosRevision.push({
      canal: "email",
      enviadoEn: new Date(),
      porNombre,
      exito: email.enviado,
      error: email.error,
      proveedorId: email.proveedorId,
      tipoAviso: tipo,
      numeroEnvio,
    });

    return {
      tipoAviso: tipo,
      numeroEnvio,
      videosListos,
      whatsapp: { ...whatsapp, contactos },
      email: { ...email, destinatarios: correos },
    };
  }

  /** Mismo contrato que el circuito de planificacion: un disparo por persona. */
  private async enviarWhatsapp(
    workspace: any,
    contactos: Contacto[],
    faltantes: string[],
    enlace: string,
    totalVideos: number,
    videosListos: number,
    tipoAviso: TipoAvisoRevision,
    numeroEnvio: number
  ): Promise<{ enviado: boolean; error?: string }> {
    const url = process.env.GHL_REVIEW_WEBHOOK_URL;
    if (!url) {
      return {
        enviado: false,
        error:
          "Falta GHL_REVIEW_WEBHOOK_URL en el backend: sin esa variable no hay a donde disparar el WhatsApp de revision.",
      };
    }

    if (!contactos.length) {
      const quienes = faltantes.length ? ` Sin telefono: ${faltantes.join(", ")}.` : "";
      return {
        enviado: false,
        error: `Ningun administrador de este entorno tiene telefono cargado.${quienes}`,
      };
    }

    const fallos: string[] = [];

    for (const contacto of contactos) {
      try {
        await axios.post(
          url,
          {
            nombre: contacto.nombre,
            apellido: contacto.apellido,
            correo: contacto.correo,
            telefono: contacto.telefono,
            cliente: workspace.name,
            workspaceId: String(workspace._id),
            totalVideos,
            videosListos,
            enlace,
            tipoAviso,
            numeroEnvio,
          },
          { timeout: 10000 }
        );
      } catch (error: any) {
        const motivo = error.response?.data?.message || error.message || "error desconocido";
        fallos.push(`${contacto.nombre || contacto.telefono}: ${motivo}`);
      }
    }

    if (fallos.length === contactos.length) {
      return { enviado: false, error: `No se pudo avisar a nadie. ${fallos.join(" | ")}` };
    }
    if (fallos.length) {
      return { enviado: true, error: `No llego a: ${fallos.join(" | ")}` };
    }
    return { enviado: true };
  }

  private async enviarEmail(
    destinatarios: string[],
    cliente: string,
    enlace: string,
    videosListos: number,
    tipo: TipoAvisoRevision
  ): Promise<{ enviado: boolean; error?: string; proveedorId?: string }> {
    if (!destinatarios.length) {
      return { enviado: false, error: "El entorno no tiene usuarios cliente con correo." };
    }

    try {
      const id = await resendService.sendVideosParaRevisionEmail({
        to: destinatarios,
        cliente,
        enlace,
        videosListos,
        tipo,
      });
      return { enviado: true, proveedorId: id };
    } catch (error: any) {
      return { enviado: false, error: error.message || "Error al enviar el correo." };
    }
  }
}

export const videoReviewNotificationService = new VideoReviewNotificationService();
