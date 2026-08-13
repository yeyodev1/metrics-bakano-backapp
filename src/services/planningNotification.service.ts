import axios from "axios";
import models from "../models";
import { resendService } from "./resend.service";
import { normalizarTelefono, partirNombre } from "../utils/telefono";

const APP_URL = "https://metrics.bakano.ec";

/**
 * Enlace que viaja en el WhatsApp. No lleva el id de la planificación a
 * propósito: la plantilla está aprobada por Meta con esta URL fija, así que la
 * pantalla resuelve sola cuál es la que toca aprobar.
 */
export const RUTA_DESDE_WHATSAPP = "/app/workspaces/new-planning-from-whatsapp";

export interface Contacto {
  nombre: string;
  apellido: string;
  correo: string;
  /** E.164, listo para WhatsApp. */
  telefono: string;
}

export interface ResultadoNotificacion {
  whatsapp: { enviado: boolean; error?: string; contactos: Contacto[] };
  email: { enviado: boolean; error?: string; destinatarios: string[] };
}

export class PlanningNotificationService {
  /**
   * Avisa al cliente de que tiene una planificación por aprobar.
   *
   * Los dos canales son independientes a propósito: si WhatsApp falla, el
   * correo igual sale, y al revés. Cada intento queda registrado con su
   * resultado, porque "no le llegó" y "no se envió" son cosas distintas y hoy
   * no había forma de distinguirlas.
   */
  async notificar(
    planningId: string,
    porNombre?: string
  ): Promise<ResultadoNotificacion> {
    const planning: any = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    if (!planning.notificacionAbierta) {
      throw new Error("CICLO_CERRADO");
    }

    const workspace: any = await models.workspaces
      .findById(planning.workspaceId)
      .lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const { correos, contactos, sinTelefono } = await this.destinatarios(workspace._id);
    const enlace = `${APP_URL}${RUTA_DESDE_WHATSAPP}`;
    const total = planning.items?.length ?? 0;

    const [whatsapp, email] = await Promise.all([
      this.enviarWhatsapp(workspace, contactos, sinTelefono, enlace, total),
      this.enviarEmail(correos, workspace.name, enlace, total),
    ]);

    planning.notificaciones.push({
      canal: "whatsapp",
      enviadoEn: new Date(),
      porNombre,
      exito: whatsapp.enviado,
      error: whatsapp.error,
    });
    planning.notificaciones.push({
      canal: "email",
      enviadoEn: new Date(),
      porNombre,
      exito: email.enviado,
      error: email.error,
      proveedorId: email.proveedorId,
    });
    await planning.save();

    return { whatsapp: { ...whatsapp, contactos }, email: { ...email, destinatarios: correos } };
  }

  /**
   * Los usuarios del entorno que deben enterarse, con sus dos vias.
   *
   * El telefono vive en el usuario, no en el entorno: el aviso va a las
   * personas, no a la empresa. Antes esto leia workspace.phoneNumber, un
   * campo que no existe en el esquema, asi que el WhatsApp habria fallado
   * siempre con "el entorno no tiene telefono".
   */
  private async destinatarios(workspaceId: any): Promise<{
    correos: string[];
    contactos: Contacto[];
    sinTelefono: string[];
  }> {
    const usuarios = await models.users
      .find({
        isInternal: { $ne: true },
        isActive: { $ne: false },
        $or: [{ "workspaces.workspaceId": workspaceId }, { workspaceId }],
      })
      .select("name email phoneNumber phoneExtension workspaces")
      .lean();

    /**
     * El WhatsApp va solo a quien administra la cuenta: es quien aprueba. Un
     * colaborador no decide, y llenarle el chat con recordatorios que no puede
     * atender es la forma mas rapida de que el cliente silencie el canal.
     */
    const esAdmin = (u: any) =>
      (u.workspaces ?? []).some(
        (w: any) => String(w.workspaceId) === String(workspaceId) && w.role === "admin"
      );

    const admins = usuarios.filter(esAdmin);
    const conTelefono = admins.filter((u: any) => u.phoneNumber);

    return {
      // El correo si va a todos: leerlo no obliga a nadie a hacer nada.
      correos: usuarios.map((u: any) => u.email).filter(Boolean),
      // Un contacto completo por administrador: GHL crea o actualiza el
      // contacto con estos datos, asi que mandar solo el numero obligaba a
      // mantener la ficha a mano en dos sitios.
      contactos: conTelefono
        .map((u: any) => {
          const { nombre, apellido } = partirNombre(u.name, u.lastName);
          const tel = normalizarTelefono(u.phoneNumber, u.phoneExtension || "593");
          return { nombre, apellido, correo: u.email, telefono: tel.e164 };
        })
        .filter((c) => c.telefono),
      sinTelefono: admins
        .filter((u: any) => !u.phoneNumber)
        .map((u: any) => u.name || u.email),
    };
  }

  /**
   * El WhatsApp lo manda GoHighLevel: aquí solo se dispara su webhook con los
   * datos que espera la plantilla aprobada.
   */
  /**
   * Un disparo del webhook POR PERSONA, con un JSON plano.
   *
   * GHL arma el contacto con lo que recibe en la raiz del cuerpo, asi que un
   * arreglo de contactos en una sola llamada le sirve de poco. Uno por
   * persona ademas permite saber a quien si le llego y a quien no, en vez de
   * un unico exito o fracaso para todo el grupo.
   */
  private async enviarWhatsapp(
    workspace: any,
    contactos: Contacto[],
    faltantes: string[],
    enlace: string,
    totalVideos: number
  ): Promise<{ enviado: boolean; error?: string }> {
    const url = process.env.GHL_PLANNING_WEBHOOK_URL;
    if (!url) {
      return {
        enviado: false,
        error:
          "Falta GHL_PLANNING_WEBHOOK_URL en el backend: sin esa variable no hay a donde disparar el WhatsApp.",
      };
    }

    if (!contactos.length) {
      const quienes = faltantes.length ? ` Sin telefono: ${faltantes.join(", ")}.` : "";
      return {
        enviado: false,
        error: `Ningun administrador de este entorno tiene telefono cargado.${quienes} Agregalo en su ficha para poder avisar por WhatsApp.`,
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
            enlace,
          },
          { timeout: 10000 }
        );
      } catch (error: any) {
        const motivo = error.response?.data?.message || error.message || "error desconocido";
        fallos.push(`${contacto.nombre || contacto.telefono}: ${motivo}`);
      }
    }

    // Exito parcial: si le llego a alguien, el aviso salio; pero se dice a
    // quien no, que es lo que permite reintentar solo con ese.
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
    totalVideos: number
  ): Promise<{ enviado: boolean; error?: string; proveedorId?: string }> {
    if (!destinatarios.length) {
      return { enviado: false, error: "El entorno no tiene usuarios cliente con correo." };
    }

    try {
      const id = await resendService.sendPlanningReadyEmail({
        to: destinatarios,
        cliente,
        enlace,
        totalVideos,
      });
      return { enviado: true, proveedorId: id };
    } catch (error: any) {
      return { enviado: false, error: error.message || "Error al enviar el correo." };
    }
  }

  /**
   * La planificación que el cliente tiene pendiente de aprobar.
   *
   * Es lo que resuelve el enlace del WhatsApp: la plantilla lleva una URL fija,
   * así que la pantalla necesita saber sola cuál mostrar. Se elige la más
   * reciente sin aprobar.
   */
  async pendienteDeAprobar(workspaceId: string) {
    const planning: any = await models.videoPlanning
      .findOne({ workspaceId, clienteAprobado: { $ne: true } })
      .sort({ createdAt: -1 })
      .lean();

    if (!planning) return null;

    const entry: any = await models.planning
      .findById(planning.planningEntryId)
      .lean()
      .catch(() => null);

    return {
      planningId: String(planning._id),
      workspaceId: String(planning.workspaceId),
      totalVideos: planning.items?.length ?? 0,
      pendientes: (planning.items ?? []).filter(
        (i: any) => i.clienteAprobacion === "PENDIENTE"
      ).length,
      creadaEn: planning.createdAt,
      mes: entry?.month ?? null,
      anio: entry?.year ?? null,
      ultimaNotificacion:
        planning.notificaciones?.length
          ? planning.notificaciones[planning.notificaciones.length - 1].enviadoEn
          : null,
    };
  }

  /**
   * Cierra el ciclo. Se llama al aprobar o rechazar: a partir de ahí no se
   * puede volver a notificar hasta que se mande una planificación nueva.
   */
  async cerrarCiclo(planningId: string) {
    await models.videoPlanning.findByIdAndUpdate(planningId, {
      notificacionAbierta: false,
    });
  }
}

export const planningNotificationService = new PlanningNotificationService();
