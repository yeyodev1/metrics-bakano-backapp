import { Types } from "mongoose";
import models from "../models";
import {
  inferMotivoCategoria,
  type EtapaRevision,
  type FuenteRevision,
  type MotivoCategoria,
  type ResultadoRevision,
} from "../models/reviewEvent.model";
import type { IVideoItem, IVideoPlanning } from "../models/videoPlanning.model";

/**
 * Registra las transiciones de estado de un item como eventos inmutables.
 *
 * Solo las TRANSICIONES generan evento: guardar un item sin cambiar su estado
 * no puede duplicar rechazos, porque el dashboard de banderas los cuenta.
 */

interface TransitionInput {
  planning: IVideoPlanning;
  item: IVideoItem;
  prevEstadoIdea: string;
  prevEdicion: string;
  actorId?: string;
}

function resultadoDeIdea(estado: string): ResultadoRevision | null {
  if (estado === "APROBADO") return "aprobado";
  if (estado === "RECHAZADO") return "rechazado";
  return null;
}

function resultadoDeEdicion(estado: string): ResultadoRevision | null {
  if (estado === "EDITADO") return "aprobado";
  if (estado === "RECHAZADO") return "rechazado";
  return null;
}

async function nombreDe(userId?: string | Types.ObjectId): Promise<string | undefined> {
  if (!userId) return undefined;
  const user = await models.users.findById(userId).select("name email").lean();
  return (user?.name || user?.email) ?? undefined;
}

class ReviewEventService {
  private async create(input: {
    planning: IVideoPlanning;
    item: IVideoItem;
    etapa: EtapaRevision;
    resultado: ResultadoRevision;
    fuente: FuenteRevision;
    actorId?: string;
    motivo?: string;
    motivoCategoria?: string;
  }): Promise<void> {
    const { planning, item, etapa } = input;
    const responsableId = etapa === "contenido" ? item.guionPorId : item.editorPorId;
    const responsableNombre =
      etapa === "contenido" ? item.guionPorNombre : item.editorPorNombre;

    await models.reviewEvents.create({
      workspaceId: planning.workspaceId,
      planningId: planning._id,
      videoItemId: item._id,
      videoTema: item.tema,
      etapa,
      resultado: input.resultado,
      fuente: input.fuente,
      responsableId: responsableId ?? undefined,
      responsableNombre: responsableNombre ?? undefined,
      actorId: input.actorId ? new Types.ObjectId(input.actorId) : undefined,
      actorNombre: await nombreDe(input.actorId),
      motivo: input.resultado === "rechazado" ? input.motivo : undefined,
      motivoCategoria:
        input.resultado === "rechazado"
          ? ((input.motivoCategoria as MotivoCategoria | undefined) ??
            inferMotivoCategoria(input.motivo))
          : undefined,
    });
  }

  /** Transiciones internas de `estadoIdea` y `edicion` (PATCH de item). */
  async recordItemTransitions(input: TransitionInput): Promise<void> {
    try {
      const { planning, item, actorId } = input;

      if (item.estadoIdea !== input.prevEstadoIdea) {
        const resultado = resultadoDeIdea(item.estadoIdea);
        if (resultado) {
          await this.create({
            planning,
            item,
            etapa: "contenido",
            resultado,
            fuente: "interno",
            actorId,
            motivo: item.motivoRechazo,
            motivoCategoria: item.motivoCategoria,
          });
        }
      }

      if (item.edicion !== input.prevEdicion) {
        const resultado = resultadoDeEdicion(item.edicion);
        if (resultado) {
          await this.create({
            planning,
            item,
            etapa: "edicion",
            resultado,
            fuente: "interno",
            actorId,
            motivo: item.motivoRechazo,
            motivoCategoria: item.motivoCategoria,
          });
        }
      }
    } catch (err: any) {
      // El registro de metricas nunca debe romper el guardado del item.
      console.warn("[ReviewEventService] record failed:", err.message);
    }
  }

  /** Veredicto del cliente sobre los guiones (aprobacion de planificacion). */
  async recordClientApproval(input: {
    planning: IVideoPlanning;
    item: IVideoItem;
    prevClienteAprobacion: string;
    actorId?: string;
    motivo?: string;
    motivoCategoria?: string;
  }): Promise<void> {
    try {
      const { item } = input;
      if (item.clienteAprobacion === input.prevClienteAprobacion) return;
      const resultado =
        item.clienteAprobacion === "APROBADO"
          ? "aprobado"
          : item.clienteAprobacion === "RECHAZADO"
            ? "rechazado"
            : null;
      if (!resultado) return;

      await this.create({
        planning: input.planning,
        item,
        etapa: "contenido",
        resultado,
        fuente: "cliente",
        actorId: input.actorId,
        motivo: input.motivo ?? item.motivoRechazo,
        motivoCategoria: input.motivoCategoria ?? item.motivoCategoria,
      });
    } catch (err: any) {
      console.warn("[ReviewEventService] client record failed:", err.message);
    }
  }
}

export const reviewEventService = new ReviewEventService();
