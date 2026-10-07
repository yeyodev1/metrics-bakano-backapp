import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import {
  evaluarCorreccionVideo,
  formatoSegundo,
  MAX_RONDAS_VIDEO,
  MAX_TEXTO_CORRECCION,
  MENSAJE_SIN_VANIDAD,
  parseSegundo,
  rondasRestantes,
} from "./correccionVideo.service";
import { ErrorRevisionVideo, esperaVeredicto, videoReviewNotificationService } from "./videoReviewNotification.service";

/**
 * Revision de VIDEOS por Telegram. Mismo patron que la de guiones: los
 * cambios se juntan en un borrador del chat y se envian todos juntos, porque
 * cada envio con cambios consume una ronda (hay dos por video). Aprobar un
 * video, en cambio, va directo.
 *
 * Cada cambio se filtra al anotarlo (segundo + que cambiar + que no sea de
 * vanidad), asi el cliente se entera en el momento y no al final.
 */

export interface VideoParaRevisar {
  itemId: string;
  numero: number;
  tema: string;
  link: string | null;
  version: number;
  rondasRestantes: number;
}

export interface RevisionVideosPendiente {
  planningId: string;
  videos: VideoParaRevisar[];
}

export interface CambioBorrador {
  itemId: string;
  numero: number;
  tema: string;
  segundo: number;
  texto: string;
}

class RevisionVideosChatService {
  /** La revision abierta mas reciente del cliente, con los videos que esperan su veredicto. */
  async pendiente(workspaceId: Types.ObjectId): Promise<RevisionVideosPendiente | null> {
    const planning = await models.videoPlanning
      .findOne({ workspaceId, revisionVideosAbierta: true })
      .sort({ createdAt: -1 })
      .select("_id items")
      .lean();
    if (!planning) return null;
    const videos = [...planning.items]
      .filter(esperaVeredicto)
      .sort((a, b) => a.numero - b.numero)
      .map((i) => ({
        itemId: String(i._id),
        numero: i.numero,
        tema: i.tema,
        link: i.driveLink || i.linkVideo || null,
        version: i.versiones?.length || 1,
        rondasRestantes: rondasRestantes(i),
      }));
    return videos.length ? { planningId: String(planning._id), videos } : null;
  }

  borrador(chat: ITelegramChat, planningId?: string): CambioBorrador[] {
    const r = chat.revisionVideos;
    if (!r?.correcciones?.length) return [];
    if (planningId && String(r.planningId) !== planningId) return [];
    return r.correcciones.map((c) => ({ ...c }));
  }

  private async guardar(chat: ITelegramChat, planningId: string, cambios: CambioBorrador[]): Promise<void> {
    if (cambios.length) {
      const revision = { planningId: new Types.ObjectId(planningId), correcciones: cambios, actualizadoEn: new Date() };
      chat.revisionVideos = revision as any;
      await models.telegramChats.updateOne({ _id: chat._id }, { $set: { revisionVideos: revision } });
    } else {
      chat.revisionVideos = undefined;
      await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { revisionVideos: 1 } });
    }
  }

  async anotar(chat: ITelegramChat, numero: number, segundoCrudo: unknown, texto: string) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return { ok: false as const, motivo: "no hay videos esperando su revisión" };
    const video = revision.videos.find((v) => v.numero === Number(numero));
    if (!video) return { ok: false as const, motivo: `el video #${numero} no está por revisar`, disponibles: revision.videos.map((v) => v.numero) };
    if (!video.rondasRestantes) {
      return {
        ok: false as const,
        motivo: "sin_rondas",
        detalle: `El video #${numero} ya usó sus ${MAX_RONDAS_VIDEO} rondas de cambios: esta versión solo se puede aprobar.`,
      };
    }
    const segundo = parseSegundo(segundoCrudo);
    if (segundo === null) return { ok: false as const, motivo: "falta_segundo", detalle: "pregúntale en qué segundo está el cambio (ej. 0:15)" };
    const limpio = String(texto || "").trim().slice(0, MAX_TEXTO_CORRECCION);
    const ev = await evaluarCorreccionVideo(limpio);
    if (ev.tipo === "poco_clara") return { ok: false as const, motivo: "poco_clara", detalle: ev.motivo };
    if (ev.tipo === "vanidad") return { ok: false as const, motivo: "vanidad", detalle: ev.motivo, explicacion: MENSAJE_SIN_VANIDAD };

    const cambios = this.borrador(chat, revision.planningId);
    const repetido = cambios.find((c) => c.itemId === video.itemId && c.segundo === segundo);
    if (repetido) repetido.texto = `${repetido.texto}. ${limpio}`.slice(0, MAX_TEXTO_CORRECCION);
    else cambios.push({ itemId: video.itemId, numero: video.numero, tema: video.tema, segundo, texto: limpio });
    await this.guardar(chat, revision.planningId, cambios);
    return {
      ok: true as const,
      video: `#${video.numero} ${video.tema}`,
      segundo: formatoSegundo(segundo),
      cambiosEnEsteVideo: cambios.filter((c) => c.itemId === video.itemId).length,
      rondaQueSeUsara: MAX_RONDAS_VIDEO - video.rondasRestantes + 1,
      rondasRestantesDespues: video.rondasRestantes - 1,
    };
  }

  async quitar(chat: ITelegramChat, numero: number, segundoCrudo?: unknown) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return { ok: false as const, motivo: "no hay videos esperando su revisión" };
    const segundo = segundoCrudo === undefined || segundoCrudo === null || segundoCrudo === "" ? null : parseSegundo(segundoCrudo);
    const cambios = this.borrador(chat, revision.planningId);
    const restantes = cambios.filter((c) => !(c.numero === Number(numero) && (segundo === null || c.segundo === segundo)));
    if (restantes.length === cambios.length) return { ok: false as const, motivo: "no había un cambio anotado así" };
    await this.guardar(chat, revision.planningId, restantes);
    return { ok: true as const, cambiosEnBorrador: restantes.length };
  }

  async resumen(chat: ITelegramChat) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return null;
    const cambios = this.borrador(chat, revision.planningId);
    const conCambios = new Set(cambios.map((c) => c.itemId));
    return {
      revision,
      cambios,
      sinCambios: revision.videos.filter((v) => !conCambios.has(v.itemId)),
    };
  }

  /** Aprobar un video va directo: no consume rondas ni espera al resto. */
  async aprobar(chat: ITelegramChat, numero: number) {
    const revision = await this.pendiente(chat.workspaceId!);
    const video = revision?.videos.find((v) => v.numero === Number(numero));
    if (!revision || !video) return { ok: false as const, motivo: `el video #${numero} no está por revisar` };
    try {
      const r = await videoReviewNotificationService.registrarRevision(
        revision.planningId,
        [{ itemId: video.itemId, estado: "APROBADO" }],
        chat.userId ? String(chat.userId) : undefined
      );
      const cambios = this.borrador(chat, revision.planningId).filter((c) => c.itemId !== video.itemId);
      await this.guardar(chat, revision.planningId, cambios);
      return { ok: true as const, aprobado: `#${video.numero} ${video.tema}`, quedanPorRevisar: r.pendientes };
    } catch (error: any) {
      return { ok: false as const, motivo: this.motivoDe(error) };
    }
  }

  /**
   * Envia los cambios anotados (una ronda por video con cambios) y, si el
   * cliente lo acepto, aprueba los que no tienen cambios.
   */
  async enviar(chat: ITelegramChat, aprobarResto: boolean) {
    const r = await this.resumen(chat);
    if (!r) return { ok: false as const, motivo: "no hay videos esperando su revisión" };
    if (!r.cambios.length && !aprobarResto) return { ok: false as const, motivo: "nada_que_enviar" };
    // Sin aprobarResto se envia solo lo corregido: los demas siguen esperando.
    const porVideo = new Map<string, CambioBorrador[]>();
    for (const c of r.cambios) porVideo.set(c.itemId, [...(porVideo.get(c.itemId) ?? []), c]);
    const reviews = [
      ...[...porVideo.entries()].map(([itemId, cs]) => ({
        itemId,
        estado: "RECHAZADO" as const,
        cambios: cs.map((c) => ({ segundo: c.segundo, texto: c.texto })),
      })),
      ...(aprobarResto ? r.sinCambios.map((v) => ({ itemId: v.itemId, estado: "APROBADO" as const })) : []),
    ];
    try {
      // La vanidad ya se filtro al anotar: no se le vuelve a preguntar a la IA.
      const res = await videoReviewNotificationService.registrarRevision(
        r.revision.planningId,
        reviews,
        chat.userId ? String(chat.userId) : undefined,
        { validarVanidad: false }
      );
      await this.guardar(chat, r.revision.planningId, []);
      return {
        ok: true as const,
        corregidos: res.corregidos.map((c) => ({ video: `#${c.numero}`, ronda: c.ronda, rondasRestantes: c.rondasRestantes })),
        aprobados: res.aprobados,
        quedanPorRevisar: res.pendientes,
      };
    } catch (error: any) {
      return { ok: false as const, motivo: this.motivoDe(error) };
    }
  }

  private motivoDe(error: any): string {
    if (error instanceof ErrorRevisionVideo) return error.detalle;
    if (error?.message === "REVISION_CERRADA") return "esta revisión ya se había cerrado";
    console.error("[Revisión videos] envío:", error?.message || error);
    return "error al enviar";
  }
}

export const revisionVideosChatService = new RevisionVideosChatService();
