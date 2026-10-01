import { Types } from "mongoose";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import { agenciaDisponible, crmIntegracionService } from "./crmIntegracion.service";

/**
 * El ID de la subcuenta de GoHighLevel de cada cliente, vinculado a su
 * entorno. Con eso el negocio se reconoce en el CRM (Metrics, el bot, Lucas y
 * el MCP saben cual es su location).
 *
 * Guardar el ID nunca depende de poder leer el CRM: si el token de agencia
 * esta configurado (GHL_AGENCY_TOKEN + GHL_COMPANY_ID) se intenta conectar en
 * modo agencia de una vez; si no, queda vinculado y se conecta despues.
 */

export interface VistaSubcuenta {
  locationId: string | null;
  vinculadoEn: Date | null;
  vinculadoPorNombre: string | null;
  /** Hay CrmIntegration conectada: Metrics y Lucas pueden leer el CRM. */
  crmConectado: boolean;
  crmModo: string | null;
  crmError: string | null;
  agenciaDisponible: boolean;
}

function limpiar(locationId: unknown): string {
  const id = typeof locationId === "string" ? locationId.trim() : "";
  if (!id) throw new CustomError("Falta el ID de la subcuenta.", 400);
  if (id.length > 100 || !/^[A-Za-z0-9_-]+$/.test(id)) {
    throw new CustomError("El ID no tiene el formato correcto: cópialo tal cual desde GoHighLevel (Configuración → Perfil de la empresa).", 400);
  }
  return id;
}

class CrmSubcuentaService {
  async ver(workspaceId: string): Promise<VistaSubcuenta> {
    const [ws, crm] = await Promise.all([
      models.workspaces.findById(workspaceId).select("crmSubcuenta").lean(),
      models.crmIntegrations.findOne({ workspaceId }).select("locationId estado modo ultimoError").lean(),
    ]);
    if (!ws) throw new CustomError("Entorno no encontrado.", 404);
    const sub = (ws as any).crmSubcuenta;
    return {
      locationId: sub?.locationId || (crm as any)?.locationId || null,
      vinculadoEn: sub?.vinculadoEn || null,
      vinculadoPorNombre: sub?.vinculadoPorNombre || null,
      crmConectado: (crm as any)?.estado === "conectado",
      crmModo: (crm as any)?.modo || null,
      crmError: (crm as any)?.ultimoError || null,
      agenciaDisponible: agenciaDisponible(true),
    };
  }

  /** Entorno de una location, para reconocer al negocio por su ID. */
  async entornoDe(locationId: string): Promise<{ _id: Types.ObjectId; name: string } | null> {
    const id = String(locationId || "").trim();
    if (!id) return null;
    const ws = await models.workspaces.findOne({ "crmSubcuenta.locationId": id }).select("_id name").lean();
    if (ws) return ws as any;
    const crm = await models.crmIntegrations.findOne({ locationId: id }).select("workspaceId").lean();
    if (!crm) return null;
    return (await models.workspaces.findById((crm as any).workspaceId).select("_id name").lean()) as any;
  }

  async vincular(workspaceId: string, locationIdCrudo: unknown, usuario: { _id: unknown; name?: string; email?: string }): Promise<VistaSubcuenta & { nota?: string }> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new CustomError("Entorno inválido.", 400);
    const locationId = limpiar(locationIdCrudo);

    // Una subcuenta, un negocio.
    const [otroWs, otroCrm] = await Promise.all([
      models.workspaces.findOne({ "crmSubcuenta.locationId": locationId, _id: { $ne: workspaceId } }).select("name").lean(),
      models.crmIntegrations.findOne({ locationId, workspaceId: { $ne: workspaceId } }).select("workspaceId").lean(),
    ]);
    if (otroWs || otroCrm) {
      const nombre = (otroWs as any)?.name || ((await models.workspaces.findById((otroCrm as any)?.workspaceId).select("name").lean()) as any)?.name;
      throw new CustomError(`Esa subcuenta ya está vinculada a otro entorno${nombre ? ` (${nombre})` : ""}.`, 409);
    }

    const r = await models.workspaces.updateOne(
      { _id: workspaceId },
      { $set: { crmSubcuenta: { locationId, vinculadoEn: new Date(), vinculadoPorNombre: usuario.name || usuario.email || "" } } }
    );
    if (!r.matchedCount) throw new CustomError("Entorno no encontrado.", 404);

    // Leer el CRM: con la agencia basta el ID. Si ya tenia un token propio de
    // esa misma location, no se toca.
    let nota: string | undefined;
    const actual = await models.crmIntegrations.findOne({ workspaceId }).select("locationId modo estado").lean();
    const yaConectado = actual && (actual as any).locationId === locationId && (actual as any).estado === "conectado";
    if (!yaConectado) {
      if (agenciaDisponible(true)) {
        try {
          await crmIntegracionService.conectar(workspaceId, { locationId }, String(usuario._id), true);
        } catch (error: any) {
          nota = `Quedó vinculado, pero no pude leer el CRM con la cuenta de agencia: ${error?.message || "error"}`;
        }
      } else {
        nota =
          "Quedó vinculado. Para que Metrics y Lucas lean ese CRM falta el token de agencia de GoHighLevel en el servidor (GHL_AGENCY_TOKEN y GHL_COMPANY_ID), o que el cliente conecte su token en Integraciones.";
      }
    }
    return { ...(await this.ver(workspaceId)), ...(nota ? { nota } : {}) };
  }
}

export const crmSubcuentaService = new CrmSubcuentaService();
