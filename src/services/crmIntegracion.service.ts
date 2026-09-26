import { Types } from "mongoose";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import type { ICrmIntegration, EstadoCrm, EstadoWhatsappCrm, PermisosCrm } from "../models/crmIntegration.model";
import { cifrarTokenCrm, descifrarTokenCrm, exigirCifradoCrm } from "../utils/cifradoCrm";
import { CrmCliente, permisosQueFaltan, probarCrm } from "./crmCliente.service";

/**
 * El CRM de cada cliente conectado a su entorno: guardar, probar, mostrar y
 * desconectar. El token entra una vez, se prueba contra GoHighLevel, se
 * guarda cifrado y nunca vuelve a salir: la vista solo lleva sus ultimos 4.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const BAKANOLOGY_WEB = process.env.BAKANOLOGY_URL || "https://bakanology.com";

/** Lo que ve el frontend (y el bot). Nunca incluye el token. */
export interface CrmVista {
  estado: EstadoCrm;
  locationId: string;
  tokenFinal: string;
  whatsapp: EstadoWhatsappCrm;
  permisos: PermisosCrm;
  conectadoPor: { nombre: string; esEquipo: boolean; en: Date } | null;
  ultimaRevision: Date | null;
  ultimoError: string | null;
}

export function vistaCrm(doc: Pick<ICrmIntegration, keyof CrmVista> | null): CrmVista | null {
  if (!doc) return null;
  return {
    estado: doc.estado,
    locationId: doc.locationId,
    tokenFinal: doc.tokenFinal,
    whatsapp: doc.whatsapp,
    permisos: {
      conversaciones: Boolean(doc.permisos?.conversaciones),
      mensajes: Boolean(doc.permisos?.mensajes),
      oportunidades: Boolean(doc.permisos?.oportunidades),
      contactos: Boolean(doc.permisos?.contactos),
    },
    conectadoPor: doc.conectadoPor
      ? { nombre: doc.conectadoPor.nombre, esEquipo: Boolean(doc.conectadoPor.esEquipo), en: doc.conectadoPor.en }
      : null,
    ultimaRevision: doc.ultimaRevision ?? null,
    ultimoError: doc.ultimoError ?? null,
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

class CrmIntegracionService {
  async obtener(workspaceId: string): Promise<{ crm: CrmVista | null; bakanologyUrl: string }> {
    const doc = await models.crmIntegrations.findOne({ workspaceId }).lean();
    return { crm: vistaCrm(doc as any), bakanologyUrl: BAKANOLOGY_WEB };
  }

  /** Solo el estado, para el bot. */
  async estado(workspaceId: string | Types.ObjectId): Promise<CrmVista | null> {
    const doc = await models.crmIntegrations.findOne({ workspaceId }).lean();
    return vistaCrm(doc as any);
  }

  async conectar(workspaceId: string, datos: { locationId?: unknown; token?: unknown }, userId: string): Promise<CrmVista> {
    const locationId = typeof datos.locationId === "string" ? datos.locationId.trim() : "";
    const token = typeof datos.token === "string" ? limpiarToken(datos.token) : "";
    if (!locationId) throw new CustomError("Falta el Location ID de tu subcuenta de GoHighLevel.", 400);
    if (!token) throw new CustomError("Falta el token (Private Integration Token) de GoHighLevel.", 400);
    if (locationId.length > 100 || !/^[A-Za-z0-9_-]+$/.test(locationId)) {
      throw new CustomError("El Location ID no tiene el formato correcto: cópialo tal cual desde GoHighLevel.", 400);
    }
    if (token.length < 8 || token.length > 4000) throw new CustomError("El token no tiene el formato correcto.", 400);
    // Antes de llamar a GoHighLevel: sin clave no se podria guardar igual.
    exigirCifradoCrm();

    const prueba = await probarCrm(locationId, token);
    const falta = permisosQueFaltan(prueba.permisos);
    if (falta) throw new CustomError(falta, 400);

    const usuario = await models.users.findById(userId).select("name email isInternal role").lean();
    const doc = await models.crmIntegrations
      .findOneAndUpdate(
        { workspaceId },
        {
          $set: {
            proveedor: "gohighlevel",
            locationId,
            tokenCifrado: cifrarTokenCrm(token),
            tokenFinal: token.slice(-4),
            estado: "conectado",
            permisos: prueba.permisos,
            whatsapp: prueba.whatsapp,
            conectadoPor: {
              userId: new Types.ObjectId(userId),
              nombre: (usuario as any)?.name || (usuario as any)?.email || "",
              esEquipo: Boolean((usuario as any)?.isInternal || (usuario as any)?.role === "superadmin"),
              en: new Date(),
            },
            ultimoError: null,
          },
          $setOnInsert: { ultimaRevision: null },
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
    const token = descifrarTokenCrm((doc as any).tokenCifrado);

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

  /** Cliente listo para leer el CRM de un entorno (para la revision diaria). */
  async cliente(doc: { locationId: string; tokenCifrado: string }): Promise<CrmCliente> {
    return new CrmCliente(doc.locationId, descifrarTokenCrm(doc.tokenCifrado));
  }
}

export const crmIntegracionService = new CrmIntegracionService();
