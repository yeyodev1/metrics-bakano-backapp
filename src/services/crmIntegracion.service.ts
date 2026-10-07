import { Types } from "mongoose";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import type {
  ICrmIntegration,
  EstadoCrm,
  EstadoWhatsappCrm,
  ModoCrm,
  PermisosCrm,
  RevisionCrmConfig,
} from "../models/crmIntegration.model";
import { cifrarTokenCrm, descifrarTokenCrm, exigirCifradoCrm } from "../utils/cifradoCrm";
import { advertenciasPermisos, agenciaConfigurada, CrmCliente, fuenteAgencia, permisosQueFaltan, probarCrm } from "./crmCliente.service";

/**
 * El CRM de cada cliente conectado a su entorno: guardar, probar, mostrar y
 * desconectar. El token entra una vez, se prueba contra GoHighLevel, se
 * guarda cifrado y nunca vuelve a salir: la vista solo lleva sus ultimos 4.
 *
 * Modo agencia: si el servidor tiene GHL_AGENCY_TOKEN + GHL_COMPANY_ID, el
 * equipo de Bakano conecta solo con el Location ID y no se guarda token: el
 * de la subcuenta se pide a GoHighLevel cuando hace falta (crmCliente).
 * Solo el equipo: con la agencia se puede leer CUALQUIER subcuenta de
 * Bakano, y un cliente no debe poder conectar la location de otro.
 */

/** Rangos de la revision diaria que puede fijar el equipo. */
export const RANGOS_REVISION = {
  diasConversaciones: { min: 1, max: 30 },
  diasOportunidades: { min: 1, max: 30 },
  diasEstancada: { min: 2, max: 60 },
} as const;
export const REVISION_POR_DEFECTO: RevisionCrmConfig = {
  activa: true,
  diasConversaciones: 1,
  diasOportunidades: 1,
  diasEstancada: 7,
};

function entero(valor: unknown, porDefecto: number, rango: { min: number; max: number }): number {
  const n = typeof valor === "number" && Number.isFinite(valor) ? Math.round(valor) : porDefecto;
  return Math.min(rango.max, Math.max(rango.min, n));
}

/** Configuracion de la revision con los valores por defecto (documentos viejos no la tienen). */
export function configRevision(doc: { revision?: Partial<RevisionCrmConfig> | null } | null | undefined): RevisionCrmConfig {
  const r = doc?.revision ?? {};
  return {
    activa: r.activa !== false,
    diasConversaciones: entero(r.diasConversaciones, REVISION_POR_DEFECTO.diasConversaciones, RANGOS_REVISION.diasConversaciones),
    diasOportunidades: entero(r.diasOportunidades, REVISION_POR_DEFECTO.diasOportunidades, RANGOS_REVISION.diasOportunidades),
    diasEstancada: entero(r.diasEstancada, REVISION_POR_DEFECTO.diasEstancada, RANGOS_REVISION.diasEstancada),
  };
}

export function modoCrm(doc: { modo?: ModoCrm | null } | null | undefined): ModoCrm {
  return doc?.modo === "agencia" ? "agencia" : "token_propio";
}

/** Equipo de Bakano (mismo criterio que `esEquipo` en conectadoPor). */
export function esEquipoBakano(usuario: { isInternal?: boolean; role?: string } | null | undefined): boolean {
  return Boolean(usuario?.isInternal || usuario?.role === "superadmin");
}

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const BAKANOLOGY_WEB = process.env.BAKANOLOGY_URL || "https://bakanology.com";

/** Lo que ve el frontend (y el bot). Nunca incluye el token. */
export interface CrmVista {
  estado: EstadoCrm;
  /** token_propio: el cliente pego su token. agencia: con la cuenta de agencia de Bakano (tokenFinal = ""). */
  modo: ModoCrm;
  locationId: string;
  tokenFinal: string;
  whatsapp: EstadoWhatsappCrm;
  permisos: PermisosCrm;
  conectadoPor: { nombre: string; esEquipo: boolean; en: Date } | null;
  ultimaRevision: Date | null;
  ultimoError: string | null;
  /** Lo que mira la revision diaria (solo el equipo lo cambia). */
  revision: RevisionCrmConfig;
  /** Permisos opcionales que faltan (no impiden la conexion). */
  advertencias: string[];
}

export function vistaCrm(doc: Partial<Pick<ICrmIntegration, Exclude<keyof CrmVista, "advertencias">>> | null): CrmVista | null {
  if (!doc) return null;
  const modo = modoCrm(doc);
  return {
    estado: doc.estado ?? "conectado",
    modo,
    locationId: doc.locationId ?? "",
    tokenFinal: modo === "agencia" ? "" : doc.tokenFinal ?? "",
    whatsapp: doc.whatsapp ?? "desconocido",
    permisos: {
      conversaciones: Boolean(doc.permisos?.conversaciones),
      mensajes: Boolean(doc.permisos?.mensajes),
      oportunidades: Boolean(doc.permisos?.oportunidades),
      contactos: Boolean(doc.permisos?.contactos),
      usuarios: Boolean(doc.permisos?.usuarios),
    },
    conectadoPor: doc.conectadoPor
      ? { nombre: doc.conectadoPor.nombre, esEquipo: Boolean(doc.conectadoPor.esEquipo), en: doc.conectadoPor.en }
      : null,
    ultimaRevision: doc.ultimaRevision ?? null,
    ultimoError: doc.ultimoError ?? null,
    revision: configRevision(doc),
    advertencias: advertenciasPermisos({ usuarios: Boolean(doc.permisos?.usuarios) }),
  };
}

/** Donde el cliente conecta su CRM en Metrics (la ruta del frontend lleva /app). */
export function linkIntegraciones(workspaceId: string | Types.ObjectId): string {
  return `${APP_URL}/app/workspaces/${workspaceId}/integraciones`;
}

export function bakanologyUrl(): string {
  return BAKANOLOGY_WEB;
}

function limpiarToken(token: string): string {
  return token.trim().replace(/^Bearer\s+/i, "").trim();
}

/** true si el servidor puede conectar por la agencia y quien pregunta es del equipo. */
export function agenciaDisponible(equipo: boolean): boolean {
  return equipo && agenciaConfigurada();
}

class CrmIntegracionService {
  async obtener(
    workspaceId: string,
    equipo = false
  ): Promise<{ crm: CrmVista | null; bakanologyUrl: string; agenciaDisponible: boolean }> {
    const doc = await models.crmIntegrations.findOne({ workspaceId }).lean();
    return { crm: vistaCrm(doc as any), bakanologyUrl: BAKANOLOGY_WEB, agenciaDisponible: agenciaDisponible(equipo) };
  }

  /** Solo el estado, para el bot. */
  async estado(workspaceId: string | Types.ObjectId): Promise<CrmVista | null> {
    const doc = await models.crmIntegrations.findOne({ workspaceId }).lean();
    return vistaCrm(doc as any);
  }

  /**
   * Con token → modo token_propio (como siempre). Sin token y con la agencia
   * disponible (solo equipo) → modo agencia. Se prueba igual en los dos.
   * Reconectar no toca la configuracion de la revision.
   */
  async conectar(
    workspaceId: string,
    datos: { locationId?: unknown; token?: unknown },
    userId: string,
    equipo = false
  ): Promise<CrmVista> {
    const locationId = typeof datos.locationId === "string" ? datos.locationId.trim() : "";
    const token = typeof datos.token === "string" ? limpiarToken(datos.token) : "";
    if (!locationId) throw new CustomError("Falta el Location ID de tu subcuenta de GoHighLevel.", 400);
    if (locationId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(locationId)) {
      throw new CustomError("El Location ID no tiene el formato correcto: cópialo tal cual desde GoHighLevel.", 400);
    }
    const modo: ModoCrm = token ? "token_propio" : "agencia";
    if (modo === "agencia") {
      if (!agenciaDisponible(equipo)) throw new CustomError("Pega el token de integración privada de tu CRM", 400);
      // Con la agencia se puede leer cualquier subcuenta: una location, un entorno.
      const otro = await models.crmIntegrations.exists({ locationId, workspaceId: { $ne: workspaceId } });
      if (otro) throw new CustomError("Esa location ya está conectada a otro entorno.", 409);
    } else {
      if (token.length < 8 || token.length > 4000) throw new CustomError("El token no tiene el formato correcto.", 400);
      // Antes de llamar a GoHighLevel: sin clave no se podria guardar igual.
      exigirCifradoCrm();
    }

    const prueba = await probarCrm(locationId, modo === "agencia" ? fuenteAgencia(locationId) : token);
    const falta = permisosQueFaltan(prueba.permisos);
    if (falta) throw new CustomError(falta, 400);

    const usuario = await models.users.findById(userId).select("name email isInternal role").lean();
    const doc = await models.crmIntegrations
      .findOneAndUpdate(
        { workspaceId },
        {
          ...(modo === "agencia" ? { $unset: { tokenCifrado: 1 } } : {}),
          $set: {
            proveedor: "gohighlevel",
            locationId,
            modo,
            ...(modo === "agencia"
              ? { tokenFinal: "" }
              : { tokenCifrado: cifrarTokenCrm(token), tokenFinal: token.slice(-4) }),
            estado: "conectado",
            permisos: prueba.permisos,
            whatsapp: prueba.whatsapp,
            conectadoPor: {
              userId: new Types.ObjectId(userId),
              nombre: (usuario as any)?.name || (usuario as any)?.email || "",
              esEquipo: esEquipoBakano(usuario as any),
              en: new Date(),
            },
            ultimoError: null,
          },
          $setOnInsert: { ultimaRevision: null, revision: { ...REVISION_POR_DEFECTO } },
        },
        { upsert: true, new: true }
      )
      .lean();
    return vistaCrm(doc as any)!;
  }

  /** Vuelve a probar con el token guardado y actualiza permisos, WhatsApp y estado. */
  async reprobar(workspaceId: string): Promise<CrmVista> {
    const doc = await models.crmIntegrations.findOne({ workspaceId }).select("+tokenCifrado").lean();
    if (!doc) throw new CustomError("Este entorno todavía no tiene un CRM conectado.", 404);
    const token = modoCrm(doc as any) === "agencia" ? fuenteAgencia(doc.locationId) : descifrarTokenCrm((doc as any).tokenCifrado);

    let cambios: Record<string, unknown>;
    try {
      const prueba = await probarCrm(doc.locationId, token);
      const falta = permisosQueFaltan(prueba.permisos);
      cambios = {
        permisos: prueba.permisos,
        whatsapp: prueba.whatsapp,
        estado: falta ? "error" : "conectado",
        ultimoError: falta,
      };
    } catch (error) {
      // GoHighLevel caido no es culpa del token: no se marca error.
      if (error instanceof CustomError && error.status === 400) {
        cambios = { estado: "error", ultimoError: error.message };
      } else {
        throw error;
      }
    }
    const actualizado = await models.crmIntegrations.findOneAndUpdate({ _id: doc._id }, { $set: cambios }, { new: true }).lean();
    return vistaCrm(actualizado as any)!;
  }

  async desconectar(workspaceId: string): Promise<void> {
    await models.crmIntegrations.deleteOne({ workspaceId });
  }

  /**
   * Cambia lo que mira la revision diaria. Solo equipo (lo valida el
   * controlador). Campos opcionales; los que vienen se validan con su rango.
   */
  async cambiarRevision(workspaceId: string, datos: Record<string, unknown>): Promise<CrmVista> {
    const cambios: Partial<RevisionCrmConfig> = {};
    if (datos.activa !== undefined) {
      if (typeof datos.activa !== "boolean") throw new CustomError("«activa» tiene que ser verdadero o falso.", 400);
      cambios.activa = datos.activa;
    }
    const nombres: Record<keyof typeof RANGOS_REVISION, string> = {
      diasConversaciones: "Los días de conversaciones",
      diasOportunidades: "Los días de oportunidades",
      diasEstancada: "Los días para dar una oportunidad por estancada",
    };
    for (const campo of Object.keys(RANGOS_REVISION) as (keyof typeof RANGOS_REVISION)[]) {
      const valor = datos[campo];
      if (valor === undefined) continue;
      const { min, max } = RANGOS_REVISION[campo];
      if (typeof valor !== "number" || !Number.isInteger(valor) || valor < min || valor > max) {
        throw new CustomError(`${nombres[campo]} tienen que ser un número entero entre ${min} y ${max}.`, 400);
      }
      cambios[campo] = valor;
    }
    if (!Object.keys(cambios).length) {
      throw new CustomError("No hay cambios: manda activa, diasConversaciones, diasOportunidades o diasEstancada.", 400);
    }

    const doc = await models.crmIntegrations.findOne({ workspaceId }).select("revision").lean();
    if (!doc) throw new CustomError("Este entorno todavía no tiene un CRM conectado.", 404);
    const revision = { ...configRevision(doc as any), ...cambios };
    const actualizado = await models.crmIntegrations.findOneAndUpdate({ _id: doc._id }, { $set: { revision } }, { new: true }).lean();
    return vistaCrm(actualizado as any)!;
  }

  /** Cliente listo para leer el CRM de un entorno (para la revision diaria). */
  async cliente(doc: { locationId: string; tokenCifrado?: string | null; modo?: ModoCrm | null }): Promise<CrmCliente> {
    if (modoCrm(doc) === "agencia") return new CrmCliente(doc.locationId, fuenteAgencia(doc.locationId));
    return new CrmCliente(doc.locationId, descifrarTokenCrm(doc.tokenCifrado || ""));
  }
}

export const crmIntegracionService = new CrmIntegracionService();
