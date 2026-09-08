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

interface CalendarioProduccion {
  id?: string;
  nombre: string;
}

class CrmProductionSyncService {
  private cacheCalendarios: { en: number; lista: { id: string; name: string }[] } | null = null;

  /**
   * Calendarios de produccion configurados en `GHL_PRODUCTION_CALENDAR_IDS`,
   * separados por coma. Cada entrada puede ser el ID del calendario o su
   * nombre tal como aparece en el CRM ("Producción Bakano"): nadie tiene que
   * ir a buscar IDs. Los nombres se resuelven a ID contra la API cuando hay
   * token; si no, se comparan por nombre.
   */
  configuracionCalendarios(): string[] {
    return (process.env.GHL_PRODUCTION_CALENDAR_IDS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  private async calendariosDelCrm(): Promise<{ id: string; name: string }[]> {
    if (!ghlService.isConfigured()) return [];
    if (this.cacheCalendarios && Date.now() - this.cacheCalendarios.en < 10 * 60_000) return this.cacheCalendarios.lista;
    const lista = await ghlService.getCalendars();
    this.cacheCalendarios = { en: Date.now(), lista };
    return lista;
  }

  /**
   * Sin configuracion, se detectan solos: cualquier calendario del CRM cuyo
   * nombre hable de produccion o grabacion. Asi funciona desde el primer
   * deploy sin tocar Vercel.
   */
  /**
   * En el CRM de Bakano los clientes agendan su grabacion en el calendario
   * de su equipo de produccion (Alfa Lobo o Dinamita, plan standard o
   * premium). Se reconocen por "equipo" en el nombre, ademas de cualquier
   * calendario que hable de produccion o grabacion.
   */
  private static PATRON_PRODUCCION = /^equipo\b|producc|grabaci|filmaci|rodaje|sesi[oó]n de video/i;

  async calendariosDeProduccion(): Promise<CalendarioProduccion[]> {
    const config = this.configuracionCalendarios();
    const delCrm = await this.calendariosDelCrm().catch(() => []);
    if (!config.length) {
      return delCrm
        .filter((c) => CrmProductionSyncService.PATRON_PRODUCCION.test(normalizar(c.name)))
        .map((c) => ({ id: c.id, nombre: c.name }));
    }
    return config.map((entrada) => {
      const match = delCrm.find((c) => c.id === entrada || normalizar(c.name) === normalizar(entrada));
      return match ? { id: match.id, nombre: match.name } : { id: /\s/.test(entrada) ? undefined : entrada, nombre: entrada };
    });
  }

  /** La cita pertenece a uno de los calendarios de produccion configurados. */
  private esDeProduccion(cita: CitaCrm, calendarios: CalendarioProduccion[]): boolean {
    // Sin lista (ni configurada ni detectada): por el webhook se acepta lo que
    // el workflow del CRM decida mandar, salvo que el nombre delate otra cosa.
    if (!calendarios.length) {
      return !cita.calendarName || CrmProductionSyncService.PATRON_PRODUCCION.test(normalizar(cita.calendarName));
    }
    return calendarios.some(
      (c) =>
        (c.id && cita.calendarId && c.id === cita.calendarId) ||
        (cita.calendarName && normalizar(c.nombre) === normalizar(cita.calendarName))
    );
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

    const porNombre = this.porNombre(cita, candidatos);
    if (porNombre) return porNombre;
    return this.porUsuarioCliente(cita, candidatos);
  }

  /**
   * Ultimo recurso: el titulo o el contacto traen el nombre de una persona
   * ("Javier Aguilar") que es usuario cliente de un entorno.
   */
  private async porUsuarioCliente(cita: CitaCrm, entornos: { _id: Types.ObjectId; name: string }[]) {
    const base = normalizar([cita.title, cita.contact.name].filter(Boolean).join(" · "));
    if (!base) return null;
    const clientes = (await models.users
      .find({ isActive: true, isInternal: { $ne: true } })
      .select("name lastName workspaceId workspaces")
      .lean()) as any[];
    const idsEntornos = new Set(entornos.map((w) => w._id.toString()));
    for (const u of clientes) {
      const completo = normalizar(`${u.name || ""} ${u.lastName || ""}`);
      if (!completo.includes(" ") || completo.length < 7) continue;
      if (!contieneComoFrase(base, completo)) continue;
      const ids = [u.workspaceId?.toString(), ...(u.workspaces || []).map((w: any) => w.workspaceId?._id?.toString() ?? w.workspaceId?.toString())].filter(Boolean);
      const ws = ids.map((id) => entornos.find((w) => w._id.toString() === id && idsEntornos.has(id))).find(Boolean);
      if (ws) return ws;
    }
    return null;
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
    if (mejor) return mejor;

    // El titulo del CRM suele traer solo parte del nombre del cliente
    // ("LUISA PITA" para "Luisa Pita Fotografia", "Proyectos Y Construcciones
    // Remodelaq Sas / Javier Aguilar - produccion standard"). Se prueba cada
    // segmento del titulo: si todas sus palabras (de 3+ letras) estan en el
    // nombre del entorno, o el segmento es el inicio del nombre, es ese.
    const segmentos = [cita.title, cita.contact.company]
      .filter(Boolean)
      .flatMap((t) => normalizar(t!).split(/\s*(?:\/|-|–|\||·|:)\s*/))
      .map((seg) => seg.replace(/\b(produccion|grabacion|standard|premium|estandar|sesion|cita)\b/g, "").trim())
      .filter((seg) => seg.length >= 4);
    const stop = new Set(["de", "del", "la", "el", "los", "las", "y", "sas", "cia", "ltda", "sa", "srl"]);
    let mejorPuntaje = 0;
    for (const seg of segmentos) {
      const palabras = seg.split(" ").filter((p) => p.length >= 3 && !stop.has(p));
      if (!palabras.length) continue;
      for (const w of entornos) {
        const nombre = normalizar(w.name);
        const palabrasEntorno = new Set(nombre.split(" "));
        const todas = palabras.every((p) => palabrasEntorno.has(p));
        const esInicio = nombre.startsWith(seg) || seg.startsWith(nombre);
        if (!todas && !esInicio) continue;
        const puntaje = palabras.length * 10 + (esInicio ? 5 : 0);
        if (puntaje > mejorPuntaje) {
          mejorPuntaje = puntaje;
          mejor = w;
        }
      }
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
    const calendarios = await this.calendariosDeProduccion();
    if (!this.esDeProduccion(cita, calendarios)) {
      return { accion: "ignorada", motivo: `el calendario "${cita.calendarName || cita.calendarId}" no es de producción` };
    }
    // Nombre del calendario para el titulo, aunque el webhook solo traiga el ID.
    if (!cita.calendarName && cita.calendarId) {
      cita.calendarName = calendarios.find((c) => c.id === cita.calendarId)?.nombre;
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
      console.warn(
        `[CRM Producción] sin entorno (${origen}): ${cita.appointmentId} · ${fechaEcuador(cita.startsAt)} · ` +
          `título="${cita.title || ""}" empresa="${cita.contact.company || ""}" contacto="${cita.contact.name || ""}" ` +
          `email="${cita.contact.email || ""}" calendario="${cita.calendarName || cita.calendarId || ""}"`
      );
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

  /**
   * Equipo interno del entorno + superadmins (la direccion quiere enterarse
   * de cada produccion que un cliente agenda). Sin duplicados.
   */
  private async equipoYSuperadmins(workspaceId: Types.ObjectId): Promise<{ _id: Types.ObjectId; email: string }[]> {
    const usuarios = await models.users
      .find({
        isActive: true,
        $or: [
          { isInternal: true, workspaceId },
          { isInternal: true, "workspaces.workspaceId": workspaceId },
          { role: "superadmin" },
        ],
      })
      .select("_id email")
      .lean();
    const vistos = new Set<string>();
    return usuarios
      .filter((u) => {
        const id = u._id.toString();
        if (vistos.has(id)) return false;
        vistos.add(id);
        return true;
      })
      .map((u) => ({ _id: u._id as Types.ObjectId, email: u.email }));
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

      // Superadmins que no pertenecen al entorno: aviso in-app aparte.
      const equipo = await this.equipoYSuperadmins(entry.workspaceId);
      const delEntorno = new Set(
        (
          await models.users
            .find({ $or: [{ workspaceId: entry.workspaceId }, { "workspaces.workspaceId": entry.workspaceId }] })
            .select("_id")
            .lean()
        ).map((u) => u._id.toString())
      );
      await Promise.all(
        equipo
          .filter((u) => !delEntorno.has(u._id.toString()))
          .map((u) =>
            notificationService.create(u._id, textos.type, textos.titulo, textos.cuerpo, {
              workspaceId: entry.workspaceId,
              referenceId: entry._id as Types.ObjectId,
            })
          )
      );

      const to = [...new Set(equipo.map((u) => u.email).filter(Boolean))];
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
   * No hay calendario de produccion (ni configurado ni detectado por nombre):
   * se avisa a los superadmins con la lista de calendarios del CRM para que
   * lo resuelvan desde Metrics, una vez al dia como maximo.
   */
  private async avisarSinCalendario() {
    try {
      const hace24h = new Date(Date.now() - 24 * 3_600_000);
      const reciente = await models.notifications.exists({ type: "produccion_sin_entorno", title: "Falta el calendario de producción del CRM", createdAt: { $gte: hace24h } });
      if (reciente) return;
      const nombres = (await this.calendariosDelCrm().catch(() => [])).map((c) => c.name);
      const cuerpo =
        `No encontré ningún calendario del CRM con "producción" o "grabación" en el nombre, así que las citas de los clientes no se están trayendo al Planificador. ` +
        (nombres.length ? `Calendarios que veo en el CRM: ${nombres.join(" · ")}. ` : "Tampoco pude leer la lista de calendarios del CRM. ") +
        `Renombra el calendario de producción o configura GHL_PRODUCTION_CALENDAR_IDS con su nombre exacto.`;
      const superadmins = await models.users.find({ role: "superadmin", isActive: true }).select("_id").lean();
      await Promise.all(
        superadmins.map((sa) => notificationService.create(sa._id as Types.ObjectId, "produccion_sin_entorno", "Falta el calendario de producción del CRM", cuerpo))
      );
    } catch (err: any) {
      console.warn("[CRM Producción] aviso sin calendario falló:", err.message);
    }
  }

  /**
   * Reconciliacion por API: lee las citas de los calendarios de produccion
   * y las aplica. Las producciones del CRM que ya no aparecen en el rango se
   * dan por canceladas (las borraron en el CRM).
   */
  async sincronizarDesdeCrm(rango: { desde?: Date; hasta?: Date } = {}): Promise<{
    omitido?: string;
    revisadas: number;
    creadas: number;
    reprogramadas: number;
    canceladas: number;
    sinEntorno: number;
    errores: string[];
  }> {
    const resumen = { revisadas: 0, creadas: 0, reprogramadas: 0, canceladas: 0, sinEntorno: 0, errores: [] as string[] };
    if (!ghlService.isConfigured()) return { ...resumen, omitido: "GHL_PIT_TOKEN / GHL_LOCATION_ID sin configurar" };

    const configurados = await this.calendariosDeProduccion();
    const sinResolver = configurados.filter((c) => !c.id).map((c) => c.nombre);
    if (sinResolver.length) resumen.errores.push(`calendarios no encontrados en el CRM: ${sinResolver.join(", ")}`);
    const calendarios = configurados.map((c) => c.id).filter((id): id is string => Boolean(id));
    if (!calendarios.length) {
      await this.avisarSinCalendario();
      const nombres = (await this.calendariosDelCrm().catch(() => [])).map((c) => `"${c.name}"`);
      return {
        ...resumen,
        omitido: `ningún calendario de producción encontrado en el CRM. Calendarios: ${nombres.join(", ") || "(no se pudieron leer)"}`,
      };
    }
    const nombrePorId = new Map(configurados.filter((c) => c.id).map((c) => [c.id as string, c.nombre]));

    const desde = rango.desde ?? new Date(Date.now() - 2 * 86_400_000);
    const hasta = rango.hasta ?? new Date(Date.now() + 90 * 86_400_000);
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
        const cita = normalizarCita(ev, { contact, calendarName: nombrePorId.get(texto(ev.calendarId)) });
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

/**
 * Sincronizacion "en vivo" desde el calendario: la pantalla la pide al abrir
 * la semana o el mes y pinta lo que haya en el CRM en ese momento. Se
 * agrupa por rango y no se repite si ya corrio hace menos de 45 s, para que
 * varias pestañas o recargas no golpeen la API del CRM.
 */
const ultimaSync = new Map<string, { en: number; resultado: Awaited<ReturnType<CrmProductionSyncService["sincronizarDesdeCrm"]>> }>();
const enCurso = new Map<string, Promise<Awaited<ReturnType<CrmProductionSyncService["sincronizarDesdeCrm"]>>>>();

export async function sincronizarRangoEnVivo(desde: Date, hasta: Date) {
  const clave = `${desde.toISOString().slice(0, 10)}_${hasta.toISOString().slice(0, 10)}`;
  const previa = ultimaSync.get(clave);
  if (previa && Date.now() - previa.en < 45_000) return { ...previa.resultado, cache: true };
  const pendiente = enCurso.get(clave);
  if (pendiente) return pendiente;
  const promesa = crmProductionSyncService
    .sincronizarDesdeCrm({ desde, hasta })
    .then((resultado) => {
      ultimaSync.set(clave, { en: Date.now(), resultado });
      return resultado;
    })
    .finally(() => enCurso.delete(clave));
  enCurso.set(clave, promesa);
  return promesa;
}
