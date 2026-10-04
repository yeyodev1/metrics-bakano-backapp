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
 * - GET /users/                               Version 2021-07-28 · users.readonly (locationId)
 *     Opcional: sin el, los asesores se muestran por su id.
 *
 * La doc no detalla todo: `lastMessageDate`/`lastMessageDirection` de la
 * conversacion y el anidado de mensajes ({ messages: { messages: [] } }) se
 * leen de forma tolerante porque la respuesta real los trae asi aunque el
 * esquema publicado este truncado.
 *
 * Modo agencia (sin token del cliente): el token de la subcuenta se pide con
 * el token de agencia de Bakano. Verificado en el OpenAPI oficial
 * (apps/oauth.json, 2026-09-27):
 * - POST /oauth/locationToken                 Version 2021-07-28
 *     body application/x-www-form-urlencoded { companyId, locationId } (ambos requeridos)
 *     200 → { access_token, token_type, expires_in (seg., ej. 86399), scope, locationId, userId, ... }
 *     seguridad "Agency-Access-Only" (scope oauth.write): "Access Token generated
 *     with user type as Agency". A diferencia de "Agency-Access", NO menciona
 *     el Private Integration Token de agencia: si GHL_AGENCY_TOKEN es un PIT
 *     puede que lo rechace. Se valida con el primer intento real; si falla,
 *     hace falta un token OAuth de agencia (app del marketplace instalada).
 *   Existe tambien la variante v3 (POST /oauth/location-token con Version: v3);
 *   aqui se usa la v2, igual que el resto de este cliente.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const VERSION_CONVERSACIONES = "2021-04-15";
const VERSION_OPORTUNIDADES = "2021-07-28";
const VERSION_CONTACTOS = "2021-07-28";
const TIMEOUT_MS = 12_000;
/** Por pagina de conversaciones: el default documentado; no hay maximo publicado. */
const POR_PAGINA_CONVERSACIONES = 20;
const MAX_PAGINAS_CONVERSACIONES = 3;
/** Tope absoluto de conversaciones leidas (cada una es una llamada de mensajes). */
export const MAX_CONVERSACIONES_ABSOLUTO = 60;
const MENSAJES_POR_CONVERSACION = 20;
const CONCURRENCIA = 5;
/** Por defecto: oportunidad abierta sin moverse de etapa en tantos dias = estancada. */
const DIAS_ESTANCADA = 7;
const VERSION_OAUTH = "2021-07-28";
/** 429 (GoHighLevel limita ~100 llamadas cada 10 s por location): reintentos con espera. */
const REINTENTOS_429 = 2;
const ESPERA_429_MS = 2_000;

const esperar = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Fallo = "sin_permiso" | "no_autorizado" | "fallo";
type Resultado<T> = { ok: true; data: T } | { ok: false; tipo: Fallo; status?: number; mensaje: string };

/** El token dejo de servir (revocado, vencido o sin acceso a la location). */
export class CrmTokenInvalidoError extends Error {
  constructor(mensaje = "El token del CRM ya no es válido para esa location") {
    super(mensaje);
    this.name = "CrmTokenInvalidoError";
  }
}

/** Fallo al conseguir el token de subcuenta con la cuenta de agencia. */
export class CrmAgenciaError extends Error {
  constructor(
    mensaje: string,
    readonly tipo: Fallo,
    readonly status?: number
  ) {
    super(mensaje);
    this.name = "CrmAgenciaError";
  }
}

/** De donde sale el token: el del cliente (texto) o uno pedido con la agencia. */
export interface FuenteTokenCrm {
  obtener(): Promise<string>;
  /** El token dejo de servir: la proxima vez se pide otro. */
  invalidar(): void;
}
export type TokenCrm = string | FuenteTokenCrm;

/** true si hay token de agencia y companyId configurados en el servidor. */
export function agenciaConfigurada(): boolean {
  return Boolean(process.env.GHL_AGENCY_TOKEN?.trim() && process.env.GHL_COMPANY_ID?.trim());
}

// Token de subcuenta por locationId, en memoria de la instancia, hasta un poco
// antes de que venza. `enVuelo` evita pedir el mismo token varias veces a la vez.
const cacheAgencia = new Map<string, { token: string; venceEn: number }>();
const enVuelo = new Map<string, Promise<string>>();

async function pedirTokenDeLocation(locationId: string): Promise<string> {
  const agencia = process.env.GHL_AGENCY_TOKEN?.trim();
  const companyId = process.env.GHL_COMPANY_ID?.trim();
  if (!agencia || !companyId) {
    throw new CrmAgenciaError("La conexión con la cuenta de agencia de Bakano no está configurada en el servidor.", "no_autorizado");
  }
  try {
    const r = await axios.post(
      `${GHL_API_BASE}/oauth/locationToken`,
      new URLSearchParams({ companyId, locationId }).toString(),
      {
        headers: {
          Authorization: `Bearer ${agencia}`,
          Version: VERSION_OAUTH,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        timeout: TIMEOUT_MS,
      }
    );
    const token = typeof r.data?.access_token === "string" ? r.data.access_token : "";
    if (!token) throw new CrmAgenciaError("GoHighLevel no devolvió el token de la subcuenta.", "fallo");
    const segundos = Number(r.data?.expires_in) > 0 ? Number(r.data.expires_in) : 3600;
    // Margen: 5 min antes (o la mitad, si vence muy pronto).
    const margen = Math.min(300, segundos / 2);
    cacheAgencia.set(locationId, { token, venceEn: Date.now() + (segundos - margen) * 1000 });
    return token;
  } catch (error: any) {
    if (error instanceof CrmAgenciaError) throw error;
    const status: number | undefined = error?.response?.status;
    const cuerpo = error?.response?.data;
    const detalle = String(cuerpo?.message || cuerpo?.error || error?.message || "error").slice(0, 200);
    // 400/401/403/404/422: la agencia no puede dar token para esa location
    // (location ajena, companyId equivocado, token de agencia invalido o sin oauth.write).
    if (status && status >= 400 && status < 500 && status !== 429) {
      throw new CrmAgenciaError(`La cuenta de agencia de Bakano no tiene acceso a esa location (${detalle})`, "no_autorizado", status);
    }
    throw new CrmAgenciaError(`No se pudo obtener el token de la subcuenta: ${status ?? ""} ${detalle}`.trim(), "fallo", status);
  }
}

/** Token de subcuenta sacado con la cuenta de agencia de Bakano (con cache). */
export function fuenteAgencia(locationId: string): FuenteTokenCrm {
  return {
    async obtener() {
      const guardado = cacheAgencia.get(locationId);
      if (guardado && guardado.venceEn > Date.now()) return guardado.token;
      let pedido = enVuelo.get(locationId);
      if (!pedido) {
        pedido = pedirTokenDeLocation(locationId).finally(() => enVuelo.delete(locationId));
        enVuelo.set(locationId, pedido);
      }
      return pedido;
    },
    invalidar() {
      cacheAgencia.delete(locationId);
    },
  };
}

export interface MensajeCrm {
  direccion: "inbound" | "outbound" | string;
  tipo: string;
  texto: string;
  fecha: Date | null;
  id?: string;
  /** Usuario del CRM que lo envio (solo salientes escritos por una persona). */
  userId?: string | null;
  /** De donde salio: app, workflow, bulk_actions, campaign, api... */
  fuente?: string | null;
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
  /** Usuario del CRM (asesor) a cargo de la conversacion. */
  asignadoA?: string | null;
}

/** Un usuario de la subcuenta: en el CRM del cliente, sus asesores de venta. */
export interface UsuarioCrm {
  id: string;
  nombre: string;
  email: string | null;
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
  /** Usuario del CRM (asesor) a cargo de la oportunidad. */
  asignadoA?: string | null;
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

/** Por fecha y sin repetidos (las paginas pueden solaparse). */
function ordenarMensajes(mensajes: MensajeCrm[]): MensajeCrm[] {
  const vistos = new Set<string>();
  return mensajes
    .filter((m) => !m.id || (vistos.has(m.id) ? false : (vistos.add(m.id), true)))
    .sort((a, b) => (a.fecha?.getTime() ?? 0) - (b.fecha?.getTime() ?? 0));
}

/** Tipos de mensaje que son conversacion real (no actividad del sistema). */
export function esMensajeDeConversacion(tipo?: string | null): boolean {
  return TIPOS_CONVERSACION.test(String(tipo || "")) || esWhatsapp(tipo);
}

export class CrmCliente {
  constructor(
    private readonly locationId: string,
    private readonly token: TokenCrm
  ) {}

  private async get<T = any>(ruta: string, version: string, params: Record<string, unknown> = {}): Promise<Resultado<T>> {
    let token: string;
    try {
      token = typeof this.token === "string" ? this.token : await this.token.obtener();
    } catch (error: any) {
      if (error instanceof CrmAgenciaError) return { ok: false, tipo: error.tipo, status: error.status, mensaje: error.message };
      return { ok: false, tipo: "fallo", mensaje: String(error?.message || error).slice(0, 300) };
    }
    for (let intento = 0; ; intento++) {
      try {
        const r = await axios.get(`${GHL_API_BASE}${ruta}`, {
          headers: { Authorization: `Bearer ${token}`, Version: version, Accept: "application/json" },
          params,
          timeout: TIMEOUT_MS,
        });
        return { ok: true, data: r.data as T };
      } catch (error: any) {
        const status: number | undefined = error?.response?.status;
        if (status === 429 && intento < REINTENTOS_429) {
          const pide = Number(error?.response?.headers?.["retry-after"]);
          await esperar(pide > 0 && pide <= 10 ? pide * 1000 : ESPERA_429_MS * (intento + 1));
          continue;
        }
        const cuerpo = error?.response?.data;
        const mensaje = String(cuerpo?.message || cuerpo?.error || error?.message || "error").slice(0, 300);
        // "The token is not authorized for this scope" = falta ese permiso.
        // Otro 401/403 (JWT invalido, sin acceso a la location) = token malo.
        if ((status === 401 || status === 403) && /scope/i.test(mensaje)) return { ok: false, tipo: "sin_permiso", status, mensaje };
        // Token de subcuenta de la agencia vencido o revocado antes de tiempo: se pide otro la proxima vez.
        if (status === 401 && typeof this.token !== "string") this.token.invalidar();
        if (status === 401 || status === 403) return { ok: false, tipo: "no_autorizado", status, mensaje };
        return { ok: false, tipo: "fallo", status, mensaje };
      }
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
    const r = await this.paginaDeMensajes(conversationId, limit);
    return r.ok ? { ok: true, data: r.data.mensajes } : r;
  }

  /** Una pagina de mensajes (los mas recientes primero en GHL; aqui ordenados por fecha). */
  private async paginaDeMensajes(
    conversationId: string,
    limit: number,
    lastMessageId?: string
  ): Promise<Resultado<{ mensajes: MensajeCrm[]; siguiente: string | null }>> {
    const r = await this.get<any>(`/conversations/${encodeURIComponent(conversationId)}/messages`, VERSION_CONVERSACIONES, {
      limit,
      ...(lastMessageId ? { lastMessageId } : {}),
    });
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
        id: texto(m?.id) ?? undefined,
        userId: texto(m?.userId),
        fuente: texto(m?.source),
      }))
      .sort((a, b) => (a.fecha?.getTime() ?? 0) - (b.fecha?.getTime() ?? 0));
    const anidado = Array.isArray(r.data?.messages) ? r.data : r.data?.messages;
    const siguiente = anidado?.nextPage && texto(anidado?.lastMessageId) ? String(anidado.lastMessageId) : null;
    return { ok: true, data: { mensajes, siguiente } };
  }

  /**
   * Mensajes de una conversacion desde `desde` hasta ahora (todos los tipos),
   * por paginas de 100 hasta pasar `desde` o `maxPaginas`.
   * `completo`: false si quedaron mensajes del rango sin leer.
   */
  async mensajesDesde(conversationId: string, desde: Date, maxPaginas = 3): Promise<Resultado<{ mensajes: MensajeCrm[]; completo: boolean }>> {
    const todos: MensajeCrm[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < maxPaginas; pagina++) {
      const r = await this.paginaDeMensajes(conversationId, 100, cursor);
      if (!r.ok) return r;
      todos.push(...r.data.mensajes);
      const masViejo = r.data.mensajes[0]?.fecha?.getTime();
      if (!r.data.siguiente || (masViejo !== undefined && masViejo < desde.getTime())) {
        return { ok: true, data: { mensajes: ordenarMensajes(todos), completo: true } };
      }
      cursor = r.data.siguiente;
    }
    return { ok: true, data: { mensajes: ordenarMensajes(todos), completo: false } };
  }

  /**
   * Todas las conversaciones con ultimo mensaje desde `desde` hasta ahora
   * (crudas de GHL), paginando hasta `max`. Va desde ahora y no desde el fin
   * del dia: una conversacion que siguio despues tiene su ultimo mensaje
   * despues y se perderia. Lanza CrmTokenInvalidoError si el token no sirve.
   */
  async conversacionesActivasDesde(desde: Date, opciones: { max: number; limiteMs?: number }): Promise<{ crudas: any[]; truncado: boolean }> {
    const crudas: any[] = [];
    let cursor: unknown;
    const porPagina = 100;
    while (crudas.length < opciones.max) {
      if (opciones.limiteMs && Date.now() > opciones.limiteMs) return { crudas, truncado: true };
      const r = await this.buscarConversaciones({ limit: porPagina, startAfterDate: cursor });
      if (!r.ok) {
        if (r.tipo === "no_autorizado") throw new CrmTokenInvalidoError(/agencia/i.test(r.mensaje) ? r.mensaje : undefined);
        if (r.tipo === "sin_permiso") throw new CrmTokenInvalidoError("El token perdió el permiso de conversaciones (conversations.readonly)");
        throw new Error(`conversaciones: ${r.status ?? ""} ${r.mensaje}`);
      }
      const lista = r.data?.conversations || [];
      for (const c of lista) {
        const ultima = fecha(c?.lastMessageDate ?? c?.dateUpdated);
        if (ultima && ultima.getTime() < desde.getTime()) return { crudas, truncado: false };
        crudas.push(c);
      }
      const ultima = lista[lista.length - 1];
      const siguiente = Array.isArray(ultima?.sort) ? ultima.sort[0] : ultima?.lastMessageDate;
      if (!lista.length || siguiente === undefined || siguiente === cursor) return { crudas, truncado: false };
      cursor = siguiente;
    }
    return { crudas: crudas.slice(0, opciones.max), truncado: true };
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
    const r = await this.conversacionesEnRango({ desde: new Date(Date.now() - horas * 3_600_000), max });
    return r.conversaciones;
  }

  /**
   * Conversaciones cuyo ultimo mensaje cae entre `desde` y `hasta` (sin
   * `hasta`: hasta ahora), las mas recientes primero, con sus ultimos
   * mensajes. Como mucho `max` (tope MAX_CONVERSACIONES_ABSOLUTO): cada una
   * cuesta una llamada de mensajes. Si se pasa `limiteMs` (epoch) y se acaba
   * el tiempo, deja de leer mensajes y devuelve lo que alcanzo.
   * `truncado`: quedaron conversaciones del rango sin leer.
   * Lanza CrmTokenInvalidoError si el token ya no sirve.
   */
  async conversacionesEnRango(opciones: {
    desde: Date;
    hasta?: Date;
    max?: number;
    limiteMs?: number;
  }): Promise<{ conversaciones: ConversacionCrm[]; truncado: boolean }> {
    const max = Math.max(1, Math.min(opciones.max ?? 30, MAX_CONVERSACIONES_ABSOLUTO));
    const desdeMs = opciones.desde.getTime();
    const hastaMs = opciones.hasta ? opciones.hasta.getTime() : Infinity;
    // Una pagina extra por si hay que saltar conversaciones posteriores a `hasta`.
    const maxPaginas = Math.max(MAX_PAGINAS_CONVERSACIONES, Math.ceil(max / POR_PAGINA_CONVERSACIONES) + 1);
    const crudas: any[] = [];
    // Rango que termina en el pasado: se arranca desde `hasta` con el cursor de
    // la busqueda (startAfterDate = valor de orden, last_message_date en ms).
    // Si GoHighLevel lo ignorara, igual se filtra abajo. +1 ms: el cursor es
    // exclusivo y `hasta` es inclusive.
    let cursor: unknown = opciones.hasta && hastaMs < Date.now() - 60_000 ? hastaMs + 1 : undefined;
    let agotado = false;

    for (let pagina = 0; pagina < maxPaginas && crudas.length < max; pagina++) {
      const r = await this.buscarConversaciones({ startAfterDate: cursor });
      if (!r.ok) {
        if (r.tipo === "no_autorizado") throw new CrmTokenInvalidoError(/agencia/i.test(r.mensaje) ? r.mensaje : undefined);
        if (r.tipo === "sin_permiso") throw new CrmTokenInvalidoError("El token perdió el permiso de conversaciones (conversations.readonly)");
        throw new Error(`conversaciones: ${r.status ?? ""} ${r.mensaje}`);
      }
      const lista = r.data?.conversations || [];
      if (!lista.length) {
        agotado = true;
        break;
      }
      for (const c of lista) {
        const ultima = fecha(c?.lastMessageDate ?? c?.dateUpdated);
        if (ultima && ultima.getTime() < desdeMs) {
          agotado = true;
          break;
        }
        if (ultima && ultima.getTime() > hastaMs) continue;
        crudas.push(c);
      }
      if (agotado) break;
      if (lista.length < POR_PAGINA_CONVERSACIONES) {
        agotado = true;
        break;
      }
      const ultima = lista[lista.length - 1];
      cursor = Array.isArray(ultima?.sort) ? ultima.sort[0] : ultima?.lastMessageDate;
      if (cursor === undefined) {
        agotado = true;
        break;
      }
    }

    let truncado = !agotado || crudas.length > max;
    const elegidas = crudas.slice(0, max);
    const conversaciones: ConversacionCrm[] = [];
    for (let i = 0; i < elegidas.length; i += CONCURRENCIA) {
      if (opciones.limiteMs && Date.now() > opciones.limiteMs) {
        truncado = true;
        break;
      }
      conversaciones.push(...(await Promise.all(elegidas.slice(i, i + CONCURRENCIA).map((c) => this.conversacionConMensajes(c)))));
    }
    return { conversaciones, truncado };
  }

  private async conversacionConMensajes(c: any): Promise<ConversacionCrm> {
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
      asignadoA: texto(c?.assignedTo),
    };
  }

  // ── Para Lucas (asesores) ──────────────────────────────────────────────

  /**
   * Los usuarios de la subcuenta (los asesores del cliente). Si el token no
   * tiene users.readonly devuelve [] y los asesores se muestran por su id.
   */
  async usuarios(): Promise<UsuarioCrm[]> {
    const r = await this.usuariosCrudo();
    if (!r.ok) return [];
    return (r.data?.users || []).map((u) => ({
      id: String(u.id),
      nombre: texto(u.name) || texto([u.firstName, u.lastName].filter(Boolean).join(" ")) || "Sin nombre",
      email: texto(u.email),
    }));
  }

  usuariosCrudo() {
    return this.get<{ users?: any[] }>("/users/", VERSION_CONTACTOS, { locationId: this.locationId });
  }

  /** La ultima conversacion de un contacto, con sus ultimos mensajes. */
  async conversacionDeContacto(contactId: string): Promise<ConversacionCrm | null> {
    if (!contactId) return null;
    const r = await this.get<{ conversations?: any[] }>("/conversations/search", VERSION_CONVERSACIONES, {
      locationId: this.locationId,
      contactId,
      limit: 1,
      sort: "desc",
      sortBy: "last_message_date",
    });
    const c = r.ok ? r.data?.conversations?.[0] : null;
    return c ? this.conversacionConMensajes(c) : null;
  }

  /** Contacto por telefono (el lead que Lucas esta viendo), si existe en el CRM. */
  async contactoPorTelefono(telefono: string): Promise<{ id: string; nombre: string | null; asignadoA: string | null } | null> {
    const numero = String(telefono || "").replace(/[^\d+]/g, "");
    if (numero.replace(/\D/g, "").length < 7) return null;
    const r = await this.get<{ contact?: any }>("/contacts/search/duplicate", VERSION_CONTACTOS, {
      locationId: this.locationId,
      number: numero.startsWith("+") ? numero : `+${numero}`,
    });
    const c = r.ok ? r.data?.contact : null;
    if (!c?.id) return null;
    return {
      id: String(c.id),
      nombre: texto(c.name) || texto([c.firstName, c.lastName].filter(Boolean).join(" ")),
      asignadoA: texto(c.assignedTo),
    };
  }

  /** Todas las oportunidades (2 paginas de 100 como mucho), con pipeline y etapa. */
  async todasLasOportunidades(): Promise<OportunidadCrm[]> {
    const r = await this.oportunidades({ desde: new Date(0) });
    return r.actualizadas;
  }

  /**
   * Oportunidades actualizadas entre `desde` y `hasta` (sin `hasta`: hasta
   * ahora) y las abiertas con monto que llevan `diasEstancada` (por defecto
   * DIAS_ESTANCADA) sin moverse, contado desde hoy. Con nombre de pipeline y
   * etapa. Lee como mucho 2 paginas de 100 (el rango no cambia las lecturas;
   * `truncado` si habia mas). Sin permiso de oportunidades devuelve listas
   * vacias (es opcional).
   */
  async oportunidades(opciones: { desde: Date; hasta?: Date; diasEstancada?: number }): Promise<{
    actualizadas: OportunidadCrm[];
    estancadas: OportunidadCrm[];
    disponible: boolean;
    truncado: boolean;
  }> {
    const [pipes, pagina1] = await Promise.all([this.pipelines(), this.buscarOportunidades({ page: 1 })]);
    if (!pagina1.ok) {
      if (pagina1.tipo === "fallo") throw new Error(`oportunidades: ${pagina1.status ?? ""} ${pagina1.mensaje}`);
      return { actualizadas: [], estancadas: [], disponible: false, truncado: false };
    }
    const crudas = [...(pagina1.data?.opportunities || [])];
    let truncado = false;
    if (pagina1.data?.meta?.nextPage) {
      const pagina2 = await this.buscarOportunidades({ page: 2 });
      if (pagina2.ok) crudas.push(...(pagina2.data?.opportunities || []));
      truncado = !pagina2.ok || Boolean(pagina2.data?.meta?.nextPage);
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
      asignadoA: texto(o.assignedTo),
    }));

    const desde = opciones.desde.getTime();
    const hasta = opciones.hasta ? opciones.hasta.getTime() : Infinity;
    const limiteEstancada = Date.now() - (opciones.diasEstancada ?? DIAS_ESTANCADA) * 86_400_000;
    return {
      actualizadas: lista.filter((o) => o.actualizada && o.actualizada.getTime() >= desde && o.actualizada.getTime() <= hasta),
      estancadas: lista.filter(
        (o) => o.estado === "open" && o.monto && o.ultimoCambioEtapa && o.ultimoCambioEtapa.getTime() < limiteEstancada
      ),
      disponible: true,
      truncado,
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
 * `token` es el del cliente o `fuenteAgencia(locationId)` (modo agencia).
 * - Nada autentica → 400 "El token no es válido para esa location" (o, en
 *   modo agencia, que la agencia no tiene acceso a esa location).
 * - GoHighLevel no responde → 502.
 */
export async function probarCrm(locationId: string, token: TokenCrm): Promise<ResultadoPruebaCrm> {
  const cliente = new CrmCliente(locationId, token);
  const [convs, wa, opps, contactos, usuarios] = await Promise.all([
    cliente.buscarConversaciones({ limit: 10 }),
    cliente.buscarConversaciones({ limit: 1, lastMessageType: "TYPE_WHATSAPP" }),
    cliente.pipelines(),
    cliente.listarContactos(1),
    cliente.usuariosCrudo(),
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
    if (typeof token !== "string") {
      throw new CustomError(
        "La cuenta de agencia de Bakano no tiene acceso a esa location. Revisa que el Location ID sea de una subcuenta de la agencia de Bakano.",
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
    usuarios: usuarios.ok,
  };

  let whatsapp: EstadoWhatsappCrm = "desconocido";
  if (wa.ok && (wa.data?.conversations || []).length) whatsapp = "conectado";
  else if (convs.ok && (convs.data?.conversations || []).some((c: any) => esWhatsapp(c?.lastMessageType))) whatsapp = "conectado";
  else if (mensajes?.ok && mensajes.data.some((m) => esWhatsapp(m.tipo))) whatsapp = "conectado";
  else if (convs.ok) whatsapp = "no_detectado";

  return { permisos, whatsapp };
}

/** Lo opcional que le falta al token: no impide conectar, pero se avisa. */
export function advertenciasPermisos(permisos: Partial<PermisosCrm>): string[] {
  const avisos: string[] = [];
  if (permisos.usuarios === false) {
    avisos.push("Sin el permiso users.readonly no se ven los nombres de los asesores: agrégaselo al token para ver cómo responde cada uno.");
  }
  return avisos;
}

/** Lo que le falta al token para la revision diaria, dicho para el cliente. */
export function permisosQueFaltan(permisos: PermisosCrm): string | null {
  if (!permisos.conversaciones) return "El token no tiene permiso de conversaciones: agrégale el scope conversations.readonly";
  if (!permisos.mensajes) return "El token no tiene permiso de mensajes: agrégale el scope conversations/message.readonly";
  return null;
}
