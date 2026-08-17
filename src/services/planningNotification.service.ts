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

/**
 * Que le estamos diciendo al cliente. El workflow de GHL ramifica con esto:
 * no es lo mismo estrenar una planificacion que insistir por tercera vez.
 */
export type TipoAviso = "enviada" | "recordatorio" | "revisada";

export const TEXTO_AVISO: Record<TipoAviso, string> = {
  enviada: "Tu planificación fue enviada",
  recordatorio: "Recordatorio: tu planificación sigue esperando aprobación",
  revisada: "Tu planificación fue revisada",
};

export interface Contacto {
  nombre: string;
  apellido: string;
  correo: string;
  /** E.164, listo para WhatsApp. */
  telefono: string;
}

/**
 * Un usuario del entorno con sus dos vias ya resueltas.
 *
 * La pantalla necesita el id y el telefono sin normalizar para poder editarlo;
 * el envio necesita el E.164. Los dos salen del mismo sitio a proposito: si la
 * pantalla lista una cosa y el envio manda otra, el aviso es una loteria.
 */
export interface UsuarioAviso {
  id: string;
  nombre: string;
  apellido: string;
  correo: string;
  /** Tal como esta guardado en la ficha, sin normalizar. */
  telefono: string;
  /** Prefijo de pais guardado. Ecuador por defecto. */
  extension: string;
  /** Listo para WhatsApp, o vacio si no hay numero usable. */
  telefonoE164: string;
  esAdmin: boolean;
}

export interface ResultadoNotificacion {
  tipoAviso: TipoAviso;
  numeroEnvio: number;
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
  /**
   * Deduce que aviso toca, sin que nadie tenga que elegirlo.
   *
   * Primero de un ciclo que nacio de una revision -> "revisada". Primero de un
   * ciclo normal -> "enviada". Cualquiera despues del primero -> recordatorio,
   * porque el cliente ya recibio este mismo enlace y no respondio.
   */
  private deducirTipo(planning: any): { tipo: TipoAviso; numeroEnvio: number } {
    const desde = planning.cicloIniciadoEn ?? new Date(0);
    const previos = (planning.notificaciones ?? []).filter(
      (n: any) => n.canal === "whatsapp" && n.exito && new Date(n.enviadoEn) >= new Date(desde)
    ).length;

    if (previos > 0) return { tipo: "recordatorio", numeroEnvio: previos + 1 };
    return { tipo: planning.cicloEsRevision ? "revisada" : "enviada", numeroEnvio: 1 };
  }

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
    const { tipo, numeroEnvio } = this.deducirTipo(planning);

    const [whatsapp, email] = await Promise.all([
      this.enviarWhatsapp(workspace, contactos, sinTelefono, enlace, total, tipo, numeroEnvio),
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

    return { tipoAviso: tipo, numeroEnvio, whatsapp: { ...whatsapp, contactos }, email: { ...email, destinatarios: correos } };
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
    const usuarios = await this.usuariosDelEntorno(workspaceId);
    const admins = usuarios.filter((u) => u.esAdmin);

    return {
      // El correo si va a todos: leerlo no obliga a nadie a hacer nada.
      correos: usuarios.map((u) => u.correo).filter(Boolean),
      // Un contacto completo por administrador: GHL crea o actualiza el
      // contacto con estos datos, asi que mandar solo el numero obligaba a
      // mantener la ficha a mano en dos sitios.
      contactos: admins
        .filter((u) => u.telefonoE164)
        .map((u) => ({
          nombre: u.nombre,
          apellido: u.apellido,
          correo: u.correo,
          telefono: u.telefonoE164,
        })),
      /**
       * Se mide por el E.164, no por "tiene algo escrito": un numero que no se
       * puede normalizar desaparecia de las dos listas y nadie se enteraba de
       * que a esa persona no le iba a llegar nada.
       */
      sinTelefono: admins
        .filter((u) => !u.telefonoE164)
        .map((u) => u.nombre || u.correo),
    };
  }

  /**
   * Los usuarios del entorno, ya clasificados por via.
   *
   * Preview y envio salen de aqui. `lastName` va en el select porque
   * `partirNombre` lo lee: sin el, el campo estaba siempre vacio y el apellido
   * volvia a deducirse partiendo el nombre, que es justo lo que se queria
   * evitar con nombres compuestos.
   */
  private async usuariosDelEntorno(workspaceId: any): Promise<UsuarioAviso[]> {
    const usuarios = await models.users
      .find({
        isInternal: { $ne: true },
        isActive: { $ne: false },
        $or: [{ "workspaces.workspaceId": workspaceId }, { workspaceId }],
      })
      .select("name lastName email phoneNumber phoneExtension workspaces")
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

    return usuarios.map((u: any) => {
      const { nombre, apellido } = partirNombre(u.name, u.lastName);
      const extension = u.phoneExtension || "593";
      const tel = u.phoneNumber ? normalizarTelefono(u.phoneNumber, extension) : null;

      return {
        id: String(u._id),
        nombre,
        apellido,
        correo: u.email,
        telefono: u.phoneNumber || "",
        extension,
        telefonoE164: tel?.valido ? tel.e164 : "",
        esAdmin: esAdmin(u),
      };
    });
  }

  /**
   * Lo que la pantalla muestra antes de disparar: quien recibe correo, quien
   * recibe WhatsApp y a quien le falta el numero.
   *
   * Existe porque el boton mandaba a ciegas. Quien notifica tiene que poder
   * ver a quien le va a llegar antes de que salga, no despues.
   */
  async previewDestinatarios(planningId: string): Promise<{
    entorno: string;
    totalVideos: number;
    tipoAviso: TipoAviso;
    numeroEnvio: number;
    puedeNotificar: boolean;
    correo: UsuarioAviso[];
    whatsapp: UsuarioAviso[];
  }> {
    const planning: any = await models.videoPlanning.findById(planningId).lean();
    if (!planning) throw new Error("NOT_FOUND");

    const workspace: any = await models.workspaces
      .findById(planning.workspaceId)
      .lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const usuarios = await this.usuariosDelEntorno(workspace._id);
    const { tipo, numeroEnvio } = this.deducirTipo(planning);

    return {
      entorno: workspace.name,
      totalVideos: planning.items?.length ?? 0,
      tipoAviso: tipo,
      numeroEnvio,
      puedeNotificar: Boolean(planning.notificacionAbierta),
      correo: usuarios,
      whatsapp: usuarios.filter((u) => u.esAdmin),
    };
  }

  /**
   * Guarda el telefono en la ficha del usuario desde la misma pantalla.
   *
   * Se guarda en el usuario, no en la planificacion: el numero sirve para el
   * proximo aviso y para el siguiente mes. Escribirlo cada vez seria pedirle
   * al equipo que mantenga a mano un dato que ya tiene sitio.
   */
  async guardarTelefono(
    planningId: string,
    userId: string,
    phoneNumber: string,
    phoneExtension: string
  ): Promise<UsuarioAviso> {
    const planning: any = await models.videoPlanning
      .findById(planningId)
      .select("workspaceId")
      .lean();
    if (!planning) throw new Error("NOT_FOUND");

    const user: any = await models.users.findById(userId);
    if (!user) throw new Error("USER_NOT_FOUND");

    // Que el id sea valido no basta: tiene que ser gente de este entorno, o
    // esta ruta serviria para editar el telefono de cualquier usuario.
    const pertenece =
      (user.workspaces ?? []).some(
        (w: any) => String(w.workspaceId) === String(planning.workspaceId)
      ) || String(user.workspaceId ?? "") === String(planning.workspaceId);
    if (!pertenece) throw new Error("USER_NOT_IN_WORKSPACE");

    const extension = phoneExtension || "593";
    const tel = normalizarTelefono(phoneNumber, extension);
    if (!tel.valido) throw new Error("TELEFONO_INVALIDO");

    user.phoneNumber = phoneNumber;
    user.phoneExtension = extension;
    await user.save();

    const { nombre, apellido } = partirNombre(user.name, user.lastName);
    return {
      id: String(user._id),
      nombre,
      apellido,
      correo: user.email,
      telefono: phoneNumber,
      extension,
      telefonoE164: tel.e164,
      esAdmin: (user.workspaces ?? []).some(
        (w: any) =>
          String(w.workspaceId) === String(planning.workspaceId) && w.role === "admin"
      ),
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
    totalVideos: number,
    tipoAviso: TipoAviso,
    numeroEnvio: number
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
            // Una sola señal para ramificar: "enviada" | "recordatorio" |
            // "revisada". Antes iba ademas un booleano esRecordatorio, pero
            // era redundante y obligaba a mantener dos campos coherentes.
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
      // La pantalla a la que aterriza el cliente desde WhatsApp se arma con el
      // entry, no con la planificacion: /workspaces/:workspaceId/planning/
      // :entryId/video-planning/client. Sin esto no hay forma de construir la URL.
      planningEntryId: String(planning.planningEntryId),
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
