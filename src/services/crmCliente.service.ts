import axios from "axios";
import { CustomError } from "../errors/customError.error";
import type { EstadoWhatsappCrm, PermisosCrm } from "../models/crmIntegration.model";
import type { CanalHallazgoCrm } from "../models/crmHallazgo.model";

/**
 * Cliente de la API v2 de HighLevel (GoHighLevel) con el token DEL CLIENTE.
 *
 * No confundir con ghl.service.ts, que habla con el CRM de Bakano usando
 * tokens globales. Aqui cada entorno trae su location y su Private
 * Integration Token, y solo se LEE: conversaciones, mensajes, oportunidades.
 *
 * Verificado contra la doc oficial (OpenAPI en
 * github.com/GoHighLevel/highlevel-api-docs, 2026-09-26):
 * - GET /conversations/search                 Version 2021-04-15 · conversations.readonly
 *     locationId, limit (def. 20), sort asc|desc, sortBy last_message_date,
 *     lastMessageType (TYPE_WHATSAPP, TYPE_SMS, TYPE_INSTAGRAM...), startAfterDate
 * - GET /conversations/{id}/messages          Version 2021-04-15 · conversations/message.readonly
 *     limit (def. 20), lastMessageId. Los mensajes traen messageType ("TYPE_WHATSAPP"...)
 * - GET /opportunities/search                 Version 2021-07-28 · opportunities.readonly
 *     location_id (con guion bajo), status open|won|lost|abandoned|all, page, limit (max 100)
 * - GET /opportunities/pipelines              Version 2021-07-28 · opportunities.readonly (locationId)
 * - GET /contacts/{id} y GET /contacts/       Version 2021-07-28 · contacts.readonly
 *
 * La doc no detalla todo: `lastMessageDate`/`lastMessageDirection` de la
 * conversacion y el anidado de mensajes ({ messages: { messages: [] } }) se
 * leen de forma tolerante porque la respuesta real los trae asi aunque el
 * esquema publicado este truncado.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const VERSION_CONVERSACIONES = "2021-04-15";
const VERSION_OPORTUNIDADES = "2021-07-28";
const VERSION_CONTACTOS = "2021-07-28";
const TIMEOUT_MS = 12_000;
/** Por pagina de conversaciones: el default documentado; no hay maximo publicado. */
const POR_PAGINA_CONVERSACIONES = 20;
const MAX_PAGINAS_CONVERSACIONES = 3;
const MENSAJES_POR_CONVERSACION = 20;
const CONCURRENCIA = 5;
/** Oportunidad abierta sin moverse de etapa en tantos dias = estancada. */
const DIAS_ESTANCADA = 7;

type Fallo = "sin_permiso" | "no_autorizado" | "fallo";
type Resultado<T> = { ok: true; data: T } | { ok: false; tipo: Fallo; status?: number; mensaje: string };

/** El token dejo de servir (revocado, vencido o sin acceso a la location). */
export class CrmTokenInvalidoError extends Error {
  constructor(mensaje = "El token del CRM ya no es válido para esa location") {
    super(mensaje);
    this.name = "CrmTokenInvalidoError";
  }
}

export interface MensajeCrm {
  direccion: "inbound" | "outbound" | string;
  tipo: string;
  texto: string;
  fecha: Date | null;
}

export interface ConversacionCrm {
  id: string;
  contactId: string | null;
  nombre: string | null;
  telefono: string | null;
  email: string | null;
  ultimoTipo: string | null;
  ultimaFecha: Date | null;
  ultimaDireccion: string | null;
  noLeidos: number;
  canal: CanalHallazgoCrm;
  mensajes: MensajeCrm[];
}

export interface OportunidadCrm {
  id: string;
  nombre: string;
  monto: number | null;
  estado: "open" | "won" | "lost" | "abandoned" | string;
  pipeline: string | null;
  etapa: string | null;
  contactId: string | null;
  contacto: { nombre: string | null; telefono: string | null; email: string | null };
  actualizada: Date | null;
  ultimoCambioEtapa: Date | null;
  creada: Date | null;
}

export interface ResultadoPruebaCrm {
  permisos: PermisosCrm;
  whatsapp: EstadoWhatsappCrm;
}

/** Tipos de mensaje que son conversacion real (no actividad del sistema). */
const TIPOS_CONVERSACION = /^(TYPE_(WHATSAPP|SMS|RCS|CUSTOM_SMS|CUSTOM_PROVIDER_SMS|INSTAGRAM|FACEBOOK|WEBCHAT|LIVE_CHAT|GMB|TIKTOK|EMAIL|CUSTOM_EMAIL|CUSTOM_PROVIDER_EMAIL|CALL|IVR_CALL|CUSTOM_CALL))$/;

export function esWhatsapp(tipo?: string | null): boolean {
  return /WHATSAPP/i.test(String(tipo || ""));
}

export function canalDeTipo(tipo?: string | null): CanalHallazgoCrm {
  const t = String(tipo || "").toUpperCase();
  if (t.includes("WHATSAPP")) return "whatsapp";
  if (t.includes("INSTAGRAM")) return "instagram";
  if (t.includes("FACEBOOK")) return "facebook";
  if (/SMS|RCS/.test(t)) return "sms";
  return "otro";
}

function fecha(valor: unknown): Date | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const d = typeof valor === "number" ? new Date(valor) : new Date(String(valor));
  return Number.isNaN(d.getTime()) ? null : d;
}

function texto(valor: unknown): string | null {
  const s = typeof valor === "string" ? valor.trim() : "";
  return s || null;
}

/** Corre `fn` sobre todos, de a `n` a la vez. */
async function enLotes<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const salida: R[] = [];
  for (let i = 0; i < items.length; i += n) {
    salida.push(...(await Promise.all(items.slice(i, i + n).map(fn))));
  }
  return salida;
}

export class CrmCliente {
  constructor(
    private readonly locationId: string,
    private readonly token: string
  ) {}

  private async get<T = any>(ruta: string, version: string, params: Record<string, unknown> = {}): Promise<Resultado<T>> {
    try {
      const r = await axios.get(`${GHL_API_BASE}${ruta}`, {
        headers: { Authorization: `Bearer ${this.token}`, Version: version, Accept: "application/json" },
        params,
        timeout: TIMEOUT_MS,
      });
      return { ok: true, data: r.data as T };
    } catch (error: any) {
      const status: number | undefined = error?.response?.status;
      const cuerpo = error?.response?.data;
      const mensaje = String(cuerpo?.message || cuerpo?.error || error?.message || "error").slice(0, 300);
      // "The token is not authorized for this scope" = falta ese permiso.
      // Otro 401/403 (JWT invalido, sin acceso a la location) = token malo.
      if ((status === 401 || status === 403) && /scope/i.test(mensaje)) return { ok: false, tipo: "sin_permiso", status, mensaje };
      if (status === 401 || status === 403) return { ok: false, tipo: "no_autorizado", status, mensaje };
      return { ok: false, tipo: "fallo", status, mensaje };
    }
  }

  // ── Lecturas crudas ────────────────────────────────────────────────────

  buscarConversaciones(opciones: { limit?: number; lastMessageType?: string; startAfterDate?: unknown } = {}) {
    return this.get<{ conversations?: any[]; total?: number }>("/conversations/search", VERSION_CONVERSACIONES, {
      locationId: this.locationId,
      limit: opciones.limit ?? POR_PAGINA_CONVERSACIONES,
      sort: "desc",
      sortBy: "last_message_date",
      ...(opciones.lastMessageType ? { lastMessageType: opciones.lastMessageType } : {}),
      ...(opciones.startAfterDate !== undefined ? { startAfterDate: opciones.startAfterDate } : {}),
    });
  }

  async mensajes(conversationId: string, limit = MENSAJES_POR_CONVERSACION): Promise<Resultado<MensajeCrm[]>> {
    const r = await this.get<any>(`/conversations/${encodeURIComponent(conversationId)}/messages`, VERSION_CONVERSACIONES, { limit });
    if (!r.ok) return r;
    // La respuesta real viene anidada ({ messages: { messages: [] } }); por si
    // acaso tambien se acepta el arreglo plano que muestra el esquema.
    const crudos: any[] = Array.isArray(r.data?.messages) ? r.data.messages : r.data?.messages?.messages || [];
    const mensajes = crudos
      .map((m) => ({
        direccion: String(m?.direction || ""),
        tipo: String(m?.messageType || m?.type || ""),
        texto: String(m?.body || "").trim(),
        fecha: fecha(m?.dateAdded),
      }))
      .sort((a, b) => (a.fecha?.getTime() ?? 0) - (b.fecha?.getTime() ?? 0));
    return { ok: true, data: mensajes };
  }

  buscarOportunidades(opciones: { page?: number; limit?: number; status?: string } = {}) {
    return this.get<{ opportunities?: any[]; meta?: { total?: number; nextPage?: number | null } }>(
      "/opportunities/search",
      VERSION_OPORTUNIDADES,
      {
        location_id: this.locationId,
        status: opciones.status ?? "all",
        page: opciones.page ?? 1,
        limit: opciones.limit ?? 100,
      }
    );
  }

  pipelines() {
    return this.get<{ pipelines?: { id: string; name: string; stages?: { id: string; name: string }[] }[] }>(
      "/opportunities/pipelines",
      VERSION_OPORTUNIDADES,
      { locationId: this.locationId }
    );
  }

  listarContactos(limit = 1) {
    return this.get<{ contacts?: any[] }>("/contacts/", VERSION_CONTACTOS, { locationId: this.locationId, limit });
  }

  async contacto(contactId: string): Promise<{ nombre: string | null; telefono: string | null; email: string | null } | null> {
    if (!contactId) return null;
    const r = await this.get<{ contact?: any }>(`/contacts/${encodeURIComponent(contactId)}`, VERSION_CONTACTOS);
    if (!r.ok || !r.data?.contact) return null;
    const c = r.data.contact;
    return {
      nombre: texto(c.name) || texto([c.firstName, c.lastName].filter(Boolean).join(" ")),
      telefono: texto(c.phone),
      email: texto(c.email),
    };
  }

  // ── Para la revision diaria ────────────────────────────────────────────

  /**
   * Conversaciones con actividad en las ultimas `horas`, con sus ultimos
   * mensajes. Lanza CrmTokenInvalidoError si el token ya no sirve.
   */
  async conversacionesRecientes(horas: number, max = 30): Promise<ConversacionCrm[]> {
    const desde = Date.now() - horas * 3_600_000;
    const crudas: any[] = [];
    let cursor: unknown;

    for (let pagina = 0; pagina < MAX_PAGINAS_CONVERSACIONES && crudas.length < max; pagina++) {
      const r = await this.buscarConversaciones({ startAfterDate: cursor });
      if (!r.ok) {
        if (r.tipo === "no_autorizado") throw new CrmTokenInvalidoError();
        if (r.tipo === "sin_permiso") throw new CrmTokenInvalidoError("El token perdió el permiso de conversaciones (conversations.readonly)");
        throw new Error(`conversaciones: ${r.status ?? ""} ${r.mensaje}`);
      }
      const lista = r.data?.conversations || [];
      let seguir = lista.length >= POR_PAGINA_CONVERSACIONES;
      for (const c of lista) {
        const ultima = fecha(c?.lastMessageDate ?? c?.dateUpdated);
        if (ultima && ultima.getTime() < desde) {
          seguir = false;
          break;
        }
        crudas.push(c);
      }
      if (!seguir || !lista.length) break;
      const ultima = lista[lista.length - 1];
      cursor = Array.isArray(ultima?.sort) ? ultima.sort[0] : ultima?.lastMessageDate;
      if (cursor === undefined) break;
    }

    const elegidas = crudas.slice(0, max);
    return enLotes(elegidas, CONCURRENCIA, async (c) => {
      const r = await this.mensajes(String(c.id));
      const mensajes = r.ok
        ? r.data.filter((m) => m.texto && (TIPOS_CONVERSACION.test(m.tipo) || esWhatsapp(m.tipo))).slice(-MENSAJES_POR_CONVERSACION)
        : [];
      // Canal: el tipo que mas se repite en los mensajes; si no hay, el ultimo.
      const cuenta = new Map<CanalHallazgoCrm, number>();
      for (const m of mensajes) cuenta.set(canalDeTipo(m.tipo), (cuenta.get(canalDeTipo(m.tipo)) ?? 0) + 1);
      const canal = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? canalDeTipo(c?.lastMessageType);
      return {
        id: String(c.id),
        contactId: texto(c?.contactId),
        nombre: texto(c?.fullName) || texto(c?.contactName),
        telefono: texto(c?.phone),
        email: texto(c?.email),
        ultimoTipo: texto(c?.lastMessageType),
        ultimaFecha: fecha(c?.lastMessageDate ?? c?.dateUpdated),
        ultimaDireccion: texto(c?.lastMessageDirection),
        noLeidos: Number(c?.unreadCount) || 0,
        canal,
        mensajes,
      };
    });
  }

  /**
   * Oportunidades actualizadas en las ultimas `horas` y las abiertas con
   * monto que llevan DIAS_ESTANCADA sin moverse. Con nombre de pipeline y
   * etapa. Sin permiso de oportunidades devuelve listas vacias (es opcional).
   */
  async oportunidades(horas: number): Promise<{ actualizadas: OportunidadCrm[]; estancadas: OportunidadCrm[]; disponible: boolean }> {
    const [pipes, pagina1] = await Promise.all([this.pipelines(), this.buscarOportunidades({ page: 1 })]);
    if (!pagina1.ok) {
      if (pagina1.tipo === "fallo") throw new Error(`oportunidades: ${pagina1.status ?? ""} ${pagina1.mensaje}`);
      return { actualizadas: [], estancadas: [], disponible: false };
    }
    const crudas = [...(pagina1.data?.opportunities || [])];
    if (pagina1.data?.meta?.nextPage) {
      const pagina2 = await this.buscarOportunidades({ page: 2 });
      if (pagina2.ok) crudas.push(...(pagina2.data?.opportunities || []));
    }

    const nombrePipeline = new Map<string, string>();
    const nombreEtapa = new Map<string, string>();
    if (pipes.ok) {
      for (const p of pipes.data?.pipelines || []) {
        nombrePipeline.set(p.id, p.name);
        for (const s of p.stages || []) nombreEtapa.set(s.id, s.name);
      }
    }

    const lista: OportunidadCrm[] = crudas.map((o) => ({
      id: String(o.id),
      nombre: String(o.name || "Oportunidad"),
      monto: typeof o.monetaryValue === "number" && o.monetaryValue > 0 ? o.monetaryValue : null,
      estado: String(o.status || ""),
      pipeline: nombrePipeline.get(o.pipelineId) ?? null,
      etapa: nombreEtapa.get(o.pipelineStageId) ?? null,
      contactId: texto(o.contactId),
      contacto: { nombre: texto(o.contact?.name), telefono: texto(o.contact?.phone), email: texto(o.contact?.email) },
      actualizada: fecha(o.updatedAt),
      ultimoCambioEtapa: fecha(o.lastStageChangeAt ?? o.lastStatusChangeAt ?? o.updatedAt),
      creada: fecha(o.createdAt),
    }));

    const desde = Date.now() - horas * 3_600_000;
    const limiteEstancada = Date.now() - DIAS_ESTANCADA * 86_400_000;
    return {
      actualizadas: lista.filter((o) => o.actualizada && o.actualizada.getTime() >= desde),
      estancadas: lista.filter(
        (o) => o.estado === "open" && o.monto && o.ultimoCambioEtapa && o.ultimoCambioEtapa.getTime() < limiteEstancada
      ),
      disponible: true,
    };
  }

  /**
   * WhatsApp conectado en el CRM: se busca una conversacion cuyo ultimo
   * mensaje sea TYPE_WHATSAPP; si no hay, se miran las ultimas por si
   * alguna tiene mensajes de WhatsApp.
   */
  async detectarWhatsapp(muestra?: ConversacionCrm[]): Promise<EstadoWhatsappCrm> {
    if (muestra?.some((c) => c.canal === "whatsapp" || esWhatsapp(c.ultimoTipo))) return "conectado";
    const [wa, general] = await Promise.all([
      this.buscarConversaciones({ limit: 1, lastMessageType: "TYPE_WHATSAPP" }),
      this.buscarConversaciones({ limit: 10 }),
    ]);
    if (wa.ok && (wa.data?.conversations || []).length) return "conectado";
    if (!general.ok) return "desconocido";
    const convs = general.data?.conversations || [];
    if (convs.some((c: any) => esWhatsapp(c?.lastMessageType))) return "conectado";
    return wa.ok ? "no_detectado" : "desconocido";
  }
}

/**
 * Prueba un token contra la location: que permisos tiene y si hay WhatsApp.
 * - Nada autentica → 400 "El token no es válido para esa location".
 * - GoHighLevel no responde → 502.
 */
export async function probarCrm(locationId: string, token: string): Promise<ResultadoPruebaCrm> {
  const cliente = new CrmCliente(locationId, token);
  const [convs, wa, opps, contactos] = await Promise.all([
    cliente.buscarConversaciones({ limit: 10 }),
    cliente.buscarConversaciones({ limit: 1, lastMessageType: "TYPE_WHATSAPP" }),
    cliente.pipelines(),
    cliente.listarContactos(1),
  ]);

  // Mensajes: se prueba con la primera conversacion. Si la location no tiene
  // ninguna no hay con que probar: se asume igual que conversaciones (en los
  // Private Integration Tokens se marcan juntos) y la revision diaria lo
  // corrige si no era asi.
  let mensajes: Resultado<MensajeCrm[]> | null = null;
  const primera = convs.ok ? (convs.data?.conversations || [])[0] : null;
  if (primera?.id) mensajes = await cliente.mensajes(String(primera.id), 10);

  const resultados = [convs, wa, opps, contactos, ...(mensajes ? [mensajes] : [])];
  if (!resultados.some((r) => r.ok)) {
    if (resultados.some((r) => !r.ok && r.tipo === "fallo" && (!r.status || r.status >= 500))) {
      throw new CustomError("No pudimos comunicarnos con GoHighLevel. Intenta de nuevo en un momento.", 502);
    }
    // Autentica pero no tiene ninguno de los permisos que usamos.
    if (resultados.every((r) => !r.ok && r.tipo === "sin_permiso")) {
      throw new CustomError(
        "El token no tiene permiso de conversaciones: agrégale el scope conversations.readonly (y también conversations/message.readonly, opportunities.readonly y contacts.readonly)",
        400
      );
    }
    throw new CustomError("El token no es válido para esa location. Revisa que el Location ID y el token sean de la misma subcuenta.", 400);
  }

  const permisos: PermisosCrm = {
    conversaciones: convs.ok,
    mensajes: mensajes ? mensajes.ok : convs.ok,
    oportunidades: opps.ok,
    contactos: contactos.ok,
  };

  let whatsapp: EstadoWhatsappCrm = "desconocido";
  if (wa.ok && (wa.data?.conversations || []).length) whatsapp = "conectado";
  else if (convs.ok && (convs.data?.conversations || []).some((c: any) => esWhatsapp(c?.lastMessageType))) whatsapp = "conectado";
  else if (mensajes?.ok && mensajes.data.some((m) => esWhatsapp(m.tipo))) whatsapp = "conectado";
  else if (convs.ok) whatsapp = "no_detectado";

  return { permisos, whatsapp };
}

/** Lo que le falta al token para la revision diaria, dicho para el cliente. */
export function permisosQueFaltan(permisos: PermisosCrm): string | null {
  if (!permisos.conversaciones) return "El token no tiene permiso de conversaciones: agrégale el scope conversations.readonly";
  if (!permisos.mensajes) return "El token no tiene permiso de mensajes: agrégale el scope conversations/message.readonly";
  return null;
}
