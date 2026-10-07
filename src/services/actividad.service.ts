import { Types } from "mongoose";
import models from "../models";
import type { TipoActividad } from "../models/actividad.model";

/**
 * Registrar en la bitacora nunca rompe lo que se estaba haciendo: si falla,
 * se avisa en el log y sigue.
 */
class ActividadService {
  async registrar(input: {
    workspaceId: Types.ObjectId | string;
    tipo: TipoActividad;
    actorId?: Types.ObjectId | string | null;
    actorNombre?: string | null;
    esCliente?: boolean;
    planningId?: Types.ObjectId | string | null;
    itemId?: Types.ObjectId | string | null;
    numero?: number;
    tema?: string;
    detalle?: string;
    en?: Date;
  }): Promise<void> {
    try {
      const id = (v?: Types.ObjectId | string | null) =>
        v && Types.ObjectId.isValid(String(v)) ? new Types.ObjectId(String(v)) : undefined;
      let actorNombre = input.actorNombre || undefined;
      if (!actorNombre && input.actorId) {
        const u = await models.users.findById(input.actorId).select("name email").lean();
        actorNombre = u?.name || u?.email || undefined;
      }
      await models.actividades.create({
        workspaceId: id(input.workspaceId),
        tipo: input.tipo,
        actorId: id(input.actorId),
        actorNombre,
        esCliente: Boolean(input.esCliente),
        planningId: id(input.planningId),
        itemId: id(input.itemId),
        numero: input.numero,
        tema: input.tema,
        detalle: input.detalle?.slice(0, 500),
        en: input.en ?? new Date(),
      });
    } catch (error: any) {
      console.warn("[Actividad] no se pudo registrar:", error?.message || error);
    }
  }
}

export const actividadService = new ActividadService();
