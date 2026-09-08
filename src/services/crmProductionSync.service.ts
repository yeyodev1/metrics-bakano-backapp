import { Types } from "mongoose";
import models from "../models";
import type { IPlanning } from "../models/planning.model";
import { ghlService } from "./ghl.service";
import { notificationService } from "./notification.service";
import { resendService } from "./resend.service";

/**
 * Produccion agendada desde el CRM (GoHighLevel).
 *
 * El cliente reserva su dia de grabacion por el link de agendamiento del CRM
 * y esa cita tiene que aparecer sola en el Planificador de Metrics, en el dia
 * y la hora que corresponde. Si en el CRM la mueven o la cancelan, aqui se
 * mueve o se cancela tambien. Entra por dos caminos:
 *
 *  - Webhook del workflow del CRM (`POST /v1/webhooks/ghl/production-appointment`).
 *  - Cron de reconciliacion cada 30 min que lee los calendarios de produccion
 *    por API, por si un webhook no llego (`GHL_PRODUCTION_CALENDAR_IDS`).
 */

export interface CitaCrm {
  appointmentId: string;
  calendarId?: string;
  calendarName?: string;
  title?: string;
  startsAt: Date;
  endsAt?: Date;
  status: string;
  address?: string;
  contact: {
    id?: string;
    name?: string;
    email?: string;
    phone?: string;
    company?: string;
  };
  /** `customData.workspaceId` del link de agendamiento, cuando lo lleva. */
  workspaceIdHint?: string;
}

export type AccionCita =
  | "creada"
  | "reprogramada"
  | "sin_cambios"
  | "cancelada"
  | "sin_entorno"
  | "ignorada";

export interface ResultadoCita {
  accion: AccionCita;
  motivo?: string;
  entry?: IPlanning | null;
  workspaceId?: string;
}

const ESTADOS_CANCELADOS = new Set(["cancelled", "canceled", "deleted", "invalid", "cancelada", "cancelado"]);

function texto(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

function primero(...valores: unknown[]): string {
  for (const v of valores) {
    const t = texto(v);
    if (t) return t;
  }
  return "";
}

function fecha(v: unknown): Date | undefined {
  if (!v) return undefined;
  const d = new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Sin acentos ni mayusculas: "Sohé SPA" y "sohe spa" son el mismo entorno. */
function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function contieneComoFrase(textoBase: string, frase: string): boolean {
  if (!textoBase || !frase) return false;
  const esc = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(textoBase);
}

export function fechaEcuador(d: Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * Lee la cita de cualquiera de las formas en que GHL la manda: el webhook
 * de workflow (contacto en la raiz + objeto `calendar`), el payload plano de
 * la integracion de ventas, o un evento del endpoint `/calendars/events`.
 */
export function normalizarCita(body: any, extra: { contact?: any; calendarName?: string } = {}): CitaCrm | null {
  const b = body || {};
  const cal = b.calendar || b.appointment || {};
  const contacto = extra.contact || b.contact || {};

  const appointmentId = primero(
    b.appointmentId,
    cal.appointmentId,
    b.appointment?.id,
    cal.id,
    b.id,
    b.eventId
  );
  const startsAt = fecha(primero(b.startsAt, b.startTime, cal.startTime, cal.start_time, b.start_time));
  if (!appointmentId || !startsAt) return null;

  const endsAt = fecha(primero(b.endsAt, b.endTime, cal.endTime, cal.end_time, b.end_time));
  const nombreCompleto = primero(
    b.full_name,
    b.fullName,
    contacto.name,
    contacto.fullName,
    [texto(b.first_name || contacto.firstName), texto(b.last_name || contacto.lastName)].filter(Boolean).join(" ")
  );

  return {
    appointmentId,
    calendarId: primero(b.calendarId, cal.calendarId, b.appointment?.calendarId, cal.calendar_id) || undefined,
    calendarName: primero(extra.calendarName, b.calendarName, cal.calendarName, cal.calendar_name) || undefined,
    title: primero(b.title, cal.title, b.appointment?.title, cal.name) || undefined,
    startsAt,
    endsAt,
    status: primero(
      b.appointmentStatus,
      cal.appointmentStatus,
      cal.appoinmentStatus,
      b.appointment?.appointmentStatus,
      b.status,
      cal.status,
      b.appointment?.status,
      "booked"
    ).toLowerCase(),
    address: primero(b.address, cal.address, b.appointment?.address, cal.location) || undefined,
    contact: {
      id: primero(b.contact_id, b.contactId, contacto.id, cal.contactId) || undefined,
      name: nombreCompleto || undefined,
      email: primero(b.contactEmail, b.email, contacto.email).toLowerCase() || undefined,
      phone: primero(b.phone, contacto.phone) || undefined,
      company: primero(b.company_name, b.companyName, contacto.companyName) || undefined,
    },
    workspaceIdHint: primero(b.workspaceId, b.customData?.workspaceId, b.customData?.workspace_id) || undefined,
  };
}

class CrmProductionSyncService {
  calendariosDeProduccion(): string[] {
    return (process.env.GHL_PRODUCTION_CALENDAR_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  /**
   * A que entorno pertenece la cita. Orden: id explicito del link, correo del
   * contacto (usuario cliente de un solo entorno), nombre de empresa igual al
   * del entorno, y por ultimo el nombre del entorno dentro del titulo.
   */
  async resolverEntorno(cita: CitaCrm): Promise<{ _id: Types.ObjectId; name: string } | null> {
    if (cita.workspaceIdHint && Types.ObjectId.isValid(cita.workspaceIdHint)) {
      const ws = await models.workspaces.findById(cita.workspaceIdHint).select("name").lean();
      if (ws) return { _id: ws._id as Types.ObjectId, name: ws.name };
    }

    const entornos = (await models.workspaces.find({}).select("name").lean()) as { _id: Types.ObjectId; name: string }[];
    const candidatos = entornos.filter((w) => w.name && normalizar(w.name) !== "bakano");

    if (cita.contact.email) {
      const user = (await models.users
        .findOne({ email: cita.contact.email, isActive: true, isInternal: { $ne: true } })
        .select("workspaceId workspaces")
        .lean()) as any;
      if (user) {
        const ids = new Set<string>();
        if (user.workspaceId) ids.add(user.workspaceId.toString());
        for (const w of user.workspaces || []) {
          const id = w.workspaceId?._id?.toString() ?? w.workspaceId?.toString();
          if (id) ids.add(id);
        }
        const suyos = candidatos.filter((w) => ids.has(w._id.toString()));
        if (suyos.length === 1) return suyos[0];
        if (suyos.length > 1) {
          const porNombre = this.porNombre(cita, suyos);
          if (porNombre) return porNombre;
          return suyos[0];
        }
      }
    }

    return this.porNombre(cita, candidatos);
  }

  private porNombre(cita: CitaCrm, entornos: { _id: Types.ObjectId; name: string }[]) {
    const empresa = normalizar(cita.contact.company || "");
    if (empresa) {
      const exacto = entornos.find((w) => normalizar(w.name) === empresa);
      if (exacto) return exacto;
    }
    const base = normalizar([cita.title, cita.contact.company, cita.contact.name].filter(Boolean).join(" · "));
    if (!base) return null;
    let mejor: { _id: Types.ObjectId; name: string } | null = null;
    for (const w of entornos) {
      const nombre = normalizar(w.name);
      if (nombre.length < 4) continue;
      if (contieneComoFrase(base, nombre) && (!mejor || nombre.length > normalizar(mejor.name).length)) mejor = w;
    }
    return mejor;
  }

  private tituloDe(cita: CitaCrm): string {
    if (cita.calendarName) return `Producción · ${cita.calendarName}`;
    return "Producción agendada desde el CRM";
  }

  private notasDe(cita: CitaCrm): string {
    const partes: string[] = [];
    const quien = [cita.contact.name, cita.contact.email, cita.contact.phone].filter(Boolean).join(" · ");
    partes.push(`Agendado desde el CRM${quien ? ` por ${quien}` : ""}.`);
    if (cita.calendarName) partes.push(`Calendario: ${cita.calendarName}.`);
    if (cita.address) partes.push(`Lugar: ${cita.address}.`);
    if (cita.title) partes.push(`Cita: ${cita.title}.`);
    return partes.join(" ");
  }

  /**
   * Aplica la cita al Planificador: crea, reprograma o cancela. Idempotente
   * por `crm.appointmentId`, asi que el webhook y el cron pueden pisarse sin
   * duplicar nada.
   */
  async aplicarCita(cita: CitaCrm, origen: "webhook" | "cron"): Promise<ResultadoCita> {
    const permitidos = this.calendariosDeProduccion();
    if (permitidos.length && cita.calendarId && !permitidos.includes(cita.calendarId)) {
      return { accion: "ignorada", motivo: "calendario no es de producción" };
    }

    const existente = await models.planning.findOne({ "crm.appointmentId": cita.appointmentId });
    const cancelada = ESTADOS_CANCELADOS.has(cita.status);

    if (cancelada) {
      if (!existente) return { accion: "ignorada", motivo: "cancelación de una cita que nunca entró" };
      return this.cancelar(existente, cita);
    }

    if (existente) {
      const cambioFecha = Math.abs(existente.date.getTime() - cita.startsAt.getTime()) > 60_000;
      const fechaAnterior = existente.date;
      const volvioDeCancelada = existente.crm?.status ? ESTADOS_CANCELADOS.has(existente.crm.status) : false;
      existente.date = cita.startsAt;
      existente.endsAt = cita.endsAt;
      if (volvioDeCancelada) existente.title = existente.title.replace(/^CANCELADA · /, "");
      existente.crm = {
        ...(existente.crm as any),
        appointmentId: cita.appointmentId,
        calendarId: cita.calendarId ?? existente.crm?.calendarId,
        calendarName: cita.calendarName ?? existente.crm?.calendarName,
        contactId: cita.contact.id ?? existente.crm?.contactId,
        contactName: cita.contact.name ?? existente.crm?.contactName,
        contactEmail: cita.contact.email ?? existente.crm?.contactEmail,
        contactPhone: cita.contact.phone ?? existente.crm?.contactPhone,
        status: cita.status,
        syncedAt: new Date(),
      };
      await existente.save();
      if (!cambioFecha && !volvioDeCancelada) return { accion: "sin_cambios", entry: existente, workspaceId: existente.workspaceId.toString() };
      await this.avisar(existente, volvioDeCancelada ? "creada" : "reprogramada", { fechaAnterior });
      return { accion: "reprogramada", entry: existente, workspaceId: existente.workspaceId.toString() };
    }

    const entorno = await this.resolverEntorno(cita);
    if (!entorno) {
      await this.avisarSinEntorno(cita, origen);
      return { accion: "sin_entorno", motivo: "no se pudo asociar la cita a un entorno" };
    }

    const entry = new models.planning({
      workspaceId: entorno._id,
      title: this.tituloDe(cita),
      date: cita.startsAt,
      endsAt: cita.endsAt,
      notes: this.notasDe(cita),
      assignedTo: [],
      source: "crm",
      crm: {
        appointmentId: cita.appointmentId,
        calendarId: cita.calendarId,
        calendarName: cita.calendarName,
        contactId: cita.contact.id,
        contactName: cita.contact.name,
        contactEmail: cita.contact.email,
        contactPhone: cita.contact.phone,
        status: cita.status,
        syncedAt: new Date(),
      },
    });
    try {
      await entry.save();
    } catch (err: any) {
      // Carrera webhook/cron: el otro ya la creo. Se vuelve a aplicar como update.
      if (err?.code === 11000) return this.aplicarCita(cita, origen);
      throw err;
    }
    await this.avisar(entry, "creada", {});
    return { accion: "creada", entry, workspaceId: entorno._id.toString() };
  }

  private async cancelar(entry: IPlanning, cita: CitaCrm): Promise<ResultadoCita> {
    const yaCancelada = entry.crm?.status ? ESTADOS_CANCELADOS.has(entry.crm.status) : false;
    if (yaCancelada) return { accion: "sin_cambios", entry, workspaceId: entry.workspaceId.toString() };

    // Si ya hay guiones colgados de esta produccion no se borra: quedaria
    // trabajo huerfano. Se marca cancelada y el equipo decide que hacer.
    const conGuiones = await models.videoPlanning.exists({ planningEntryId: entry._id });
    const workspaceId = entry.workspaceId.toString();
    if (conGuiones) {
      entry.crm = { ...(entry.crm as any), status: cita.status, syncedAt: new Date() };
      if (!/^CANCELADA · /.test(entry.title)) entry.title = `CANCELADA · ${entry.title}`;
      await entry.save();
      await this.avisar(entry, "cancelada", { conservada: true });
      return { accion: "cancelada", entry, workspaceId };
    }

    await this.avisar(entry, "cancelada", { conservada: false });
    await models.planning.deleteOne({ _id: entry._id });
    return { accion: "cancelada", entry: null, workspaceId };
  }

  /** Correos del equipo interno del entorno; si no hay nadie asignado, los superadmins. */
  private async correosEquipo(workspaceId: Types.ObjectId): Promise<string[]> {
    const internos = await models.users
      .find({
        isActive: true,
        isInternal: true,
        $or: [{ workspaceId }, { "workspaces.workspaceId": workspaceId }],
      })
      .select("email")
      .lean();
    if (internos.length) return internos.map((u) => u.email).filter(Boolean);
    const superadmins = await models.users.find({ role: "superadmin", isActive: true }).select("email").lean();
    return superadmins.map((u) => u.email).filter(Boolean);
  }

  private async avisar(
    entry: IPlanning,
    tipo: "creada" | "reprogramada" | "cancelada",
    detalle: { fechaAnterior?: Date; conservada?: boolean }
  ) {
    try {
      const workspace = await models.workspaces.findById(entry.workspaceId).select("name").lean();
      const nombre = workspace?.name || "Cliente";
      const cuando = fechaEcuador(entry.date);
      const contacto = entry.crm?.contactName || "el cliente";

      const textos = {
        creada: {
          type: "produccion_agendada" as const,
          titulo: `Producción agendada · ${nombre}`,
          cuerpo: `${contacto} agendó una producción desde el CRM para el ${cuando} (hora Ecuador). Ya está en el Planificador.`,
        },
        reprogramada: {
          type: "produccion_reprogramada" as const,
          titulo: `Producción reprogramada · ${nombre}`,
          cuerpo: `La producción de ${nombre} se movió en el CRM${detalle.fechaAnterior ? ` del ${fechaEcuador(detalle.fechaAnterior)}` : ""} al ${cuando} (hora Ecuador). El Planificador ya está actualizado.`,
        },
        cancelada: {
          type: "produccion_cancelada" as const,
          titulo: `Producción cancelada · ${nombre}`,
          cuerpo: `La producción de ${nombre} del ${cuando} se canceló en el CRM.${
            detalle.conservada
              ? " Tenía guiones cargados, así que quedó marcada como CANCELADA en el Planificador para que el equipo decida."
              : " Se quitó del Planificador."
          }`,
        },
      }[tipo];

      await notificationService.createForWorkspaceUsers(entry.workspaceId, false, textos.type, textos.titulo, textos.cuerpo, {
        referenceId: entry._id as Types.ObjectId,
      });

      const to = await this.correosEquipo(entry.workspaceId);
      await resendService.sendProduccionCrmEmail({
        to,
        tipo,
        workspaceName: nombre,
        workspaceId: entry.workspaceId.toString(),
        fecha: cuando,
        fechaAnterior: detalle.fechaAnterior ? fechaEcuador(detalle.fechaAnterior) : undefined,
        titulo: entry.title,
        contacto: [entry.crm?.contactName, entry.crm?.contactEmail, entry.crm?.contactPhone].filter(Boolean).join(" · "),
        calendario: entry.crm?.calendarName,
        conservada: detalle.conservada,
      });
    } catch (err: any) {
      console.warn("[CRM Producción] aviso falló:", err.message);
    }
  }

  private async avisarSinEntorno(cita: CitaCrm, origen: "webhook" | "cron") {
    try {
      const superadmins = await models.users.find({ role: "superadmin", isActive: true }).select("_id email").lean();
      const quien = [cita.contact.name, cita.contact.company, cita.contact.email, cita.contact.phone].filter(Boolean).join(" · ");
      const cuerpo = `Llegó una producción del CRM (${origen}) para el ${fechaEcuador(cita.startsAt)} de "${
        quien || cita.title || cita.appointmentId
      }" y no coincide con ningún entorno. Agéndala a mano o corrige el nombre de empresa del contacto en el CRM.`;
      // Un aviso por cita, no uno por cada intento del cron.
      const yaAvisado = await models.notifications.exists({
        type: "produccion_sin_entorno",
        body: { $regex: cita.appointmentId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") },
      });
      if (yaAvisado) return;
      for (const sa of superadmins) {
        await notificationService.create(sa._id as Types.ObjectId, "produccion_sin_entorno", "Producción del CRM sin entorno", `${cuerpo} (cita ${cita.appointmentId})`);
      }
      await resendService.sendProduccionCrmEmail({
        to: superadmins.map((u) => u.email).filter(Boolean),
        tipo: "sin_entorno",
        workspaceName: cita.contact.company || cita.contact.name || "Sin entorno",
        fecha: fechaEcuador(cita.startsAt),
        titulo: cita.title || "Producción",
        contacto: quien,
        calendario: cita.calendarName,
      });
    } catch (err: any) {
      console.warn("[CRM Producción] aviso sin entorno falló:", err.message);
    }
  }

  /**
   * Reconciliacion por API: lee las citas de los calendarios de produccion
   * y las aplica. Las producciones del CRM que ya no aparecen en el rango se
   * dan por canceladas (las borraron en el CRM).
   */
  async sincronizarDesdeCrm(): Promise<{
    omitido?: string;
    revisadas: number;
    creadas: number;
    reprogramadas: number;
    canceladas: number;
    sinEntorno: number;
    errores: string[];
  }> {
    const resumen = { revisadas: 0, creadas: 0, reprogramadas: 0, canceladas: 0, sinEntorno: 0, errores: [] as string[] };
    const calendarios = this.calendariosDeProduccion();
    if (!calendarios.length) return { ...resumen, omitido: "GHL_PRODUCTION_CALENDAR_IDS vacío" };
    if (!ghlService.isConfigured()) return { ...resumen, omitido: "GHL_PIT_TOKEN / GHL_LOCATION_ID sin configurar" };

    const desde = new Date(Date.now() - 2 * 86_400_000);
    const hasta = new Date(Date.now() + 90 * 86_400_000);
    const eventos = await ghlService.getCalendarEvents(calendarios, desde, hasta);

    const contactos = new Map<string, any>();
    const vistas = new Set<string>();
    for (const ev of eventos) {
      resumen.revisadas += 1;
      try {
        const contactId = texto(ev.contactId);
        let contact: any = null;
        if (contactId) {
          if (!contactos.has(contactId)) contactos.set(contactId, await ghlService.getContact(contactId));
          contact = contactos.get(contactId);
        }
        const cita = normalizarCita(ev, { contact });
        if (!cita) continue;
        vistas.add(cita.appointmentId);
        const r = await this.aplicarCita(cita, "cron");
        if (r.accion === "creada") resumen.creadas += 1;
        else if (r.accion === "reprogramada") resumen.reprogramadas += 1;
        else if (r.accion === "cancelada") resumen.canceladas += 1;
        else if (r.accion === "sin_entorno") resumen.sinEntorno += 1;
      } catch (err: any) {
        resumen.errores.push(`${ev.id || "?"}: ${err.message}`);
      }
    }

    // Las que estaban en Metrics y ya no estan en el CRM.
    const huerfanas = await models.planning.find({
      source: "crm",
      "crm.calendarId": { $in: calendarios },
      "crm.appointmentId": { $nin: [...vistas] },
      date: { $gte: desde, $lte: hasta },
    });
    for (const entry of huerfanas) {
      try {
        const r = await this.cancelar(entry, {
          appointmentId: entry.crm!.appointmentId,
          startsAt: entry.date,
          status: "deleted",
          contact: {},
        });
        if (r.accion === "cancelada") resumen.canceladas += 1;
      } catch (err: any) {
        resumen.errores.push(`${entry.crm?.appointmentId}: ${err.message}`);
      }
    }

    return resumen;
  }
}

export const crmProductionSyncService = new CrmProductionSyncService();
