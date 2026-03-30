import { Types } from "mongoose";
import models from "../models";
import type { IVideoPlanning, IVideoItem, ClienteAprobacion } from "../models/videoPlanning.model";
import { notificationService } from "./notification.service";
import { metaService } from "./meta.service";
import cloudinary from "../config/cloudinary";

/** Extract Cloudinary public_id from a secure_url */
function extractCloudinaryPublicId(url: string): string | null {
  // e.g. https://res.cloudinary.com/cloud/video/upload/v123/folder/file.mp4
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
  return match ? match[1] : null;
}

/** Delete a Cloudinary asset by URL (best-effort, never throws) */
async function deleteCloudinaryAsset(url: string): Promise<void> {
  try {
    const publicId = extractCloudinaryPublicId(url);
    if (!publicId) return;
    const resourceType = /\/video\/upload\//i.test(url) ? "video" : "image";
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err: any) {
    console.warn("[VideoPlanningService] Cloudinary delete failed:", err.message);
  }
}

// Fields an editor (internalRole=editor) is allowed to modify
const EDITOR_ALLOWED_FIELDS = new Set(["estadoProduccion", "edicion"]);

export class VideoPlanningService {
  // ── GET ────────────────────────────────────────────────────────────────────
  async getByEntry(entryId: string): Promise<IVideoPlanning | null> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");
    return await models.videoPlanning
      .findOne({ planningEntryId: new Types.ObjectId(entryId) })
      .lean<IVideoPlanning>();
  }

  // ── UPSERT (POST = create / PUT = replace items) ───────────────────────────
  async upsert(
    entryId: string,
    workspaceId: string,
    items: Partial<IVideoItem>[]
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");

    // Normalise items: assign numero + order if missing
    const normalised = items.map((item, i) => ({
      ...item,
      numero: item.numero ?? i + 1,
      order: item.order ?? i,
      estadoIdea: item.estadoIdea ?? "POR_REVISAR",
      estadoProduccion: item.estadoProduccion ?? "POR_GRABAR",
      edicion: item.edicion ?? "POR_EDITAR",
      estadoPublicacion: item.estadoPublicacion ?? "POR_PUBLICAR",
      clienteAprobacion: item.clienteAprobacion ?? "PENDIENTE",
    }));

    const existing = await models.videoPlanning.findOne({
      planningEntryId: new Types.ObjectId(entryId),
    });

    if (existing) {
      // Blocked once client approved
      if (existing.clienteAprobado) throw new Error("LOCKED");

      // Detect items removed that had Cloudinary assets → delete them (fire & forget)
      const newIds = new Set(normalised.map((i) => i._id?.toString()).filter(Boolean));
      const removedWithAssets = existing.items.filter(
        (i) =>
          !newIds.has(i._id.toString()) &&
          i.linkVideo &&
          /res\.cloudinary\.com/i.test(i.linkVideo)
      );
      if (removedWithAssets.length) {
        Promise.all(removedWithAssets.map((i) => deleteCloudinaryAsset(i.linkVideo!))).catch(() => {});
      }

      existing.items = normalised as IVideoItem[];
      await existing.save();

      // Notify non-internal workspace users that planning was re-sent
      notificationService
        .createForWorkspaceUsers(
          existing.workspaceId.toString(),
          true,
          "video_planning_resent",
          "Planificación actualizada",
          "Se ha actualizado la planificación de videos de tu entorno."
        )
        .catch(() => {});

      return existing.toObject() as IVideoPlanning;
    }

    const planning = new models.videoPlanning({
      planningEntryId: new Types.ObjectId(entryId),
      workspaceId: new Types.ObjectId(workspaceId),
      items: normalised,
    });
    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── UPDATE SINGLE ITEM (PATCH) ─────────────────────────────────────────────
  async updateItem(
    planningId: string,
    itemId: string,
    fields: Record<string, unknown>,
    internalRole?: string,
    platformFlags?: { publishToInstagram?: boolean; publishToFacebook?: boolean }
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) throw new Error("ITEM_NOT_FOUND");

    // Field-level permission: editor can only modify estadoProduccion & edicion
    const isEditor = internalRole === "editor";
    const allowedKeys = isEditor ? EDITOR_ALLOWED_FIELDS : null;

    // All content fields are mutable via PATCH — the lock (clienteAprobado) only prevents
    // replacing ALL items via PUT/POST. Individual item edits are always allowed for internal team.
    const MUTABLE_FIELDS = new Set([
      "tema", "descripcion", "tipo", "linkEjemplo", "recursos",
      "lugarGrabacion", "guion", "estadoIdea", "estadoProduccion",
      "edicion", "estadoPublicacion", "comentario", "motivoRechazo",
      "linkVideo", "fechaPublicacion", "copyPublicacion",
    ]);

    const wasPublicado = item.estadoPublicacion === "PUBLICADO";

    for (const [key, value] of Object.entries(fields)) {
      if (!MUTABLE_FIELDS.has(key)) continue;
      if (allowedKeys && !allowedKeys.has(key)) continue;
      (item as any)[key] = value;
    }

    await planning.save();

    // Notify non-internal workspace users when a video reaches PUBLICADO
    const isNowPublicado = item.estadoPublicacion === "PUBLICADO";
    if (!wasPublicado && isNowPublicado) {
      notificationService
        .createForWorkspaceUsers(
          planning.workspaceId.toString(),
          true,
          "video_status_changed",
          "Video publicado",
          `Un video de tu planificación ha sido publicado: "${(item as any).tema || "sin título"}".`
        )
        .catch(() => {});
    }

    // ── Social media scheduling (opt-in via platformFlags) ────────────────
    // NOTE: Instagram scheduling is temporarily disabled.
    // The Meta Content Publishing API requires the app to be approved (out of Development Mode)
    // so that any Instagram Business account can use it without being manually added as a tester.
    // Re-enable the Instagram block below once the Meta App Review is approved.
    const canSchedule =
      (item as any).fechaPublicacion &&
      (item as any).linkVideo &&
      platformFlags?.publishToFacebook; // publishToInstagram intentionally excluded for now

    if (canSchedule) {
      const workspace = await models.workspaces.findById(planning.workspaceId).lean();
      const meta = workspace?.metaAds;
      const scheduledAt = new Date((item as any).fechaPublicacion);

      if (meta?.pageId && meta?.accessToken) {
        // ── Instagram (DISABLED — pending Meta App Review approval) ───────
        // if (platformFlags?.publishToInstagram) {
        //   try {
        //     const result = await metaService.scheduleInstagramPost({
        //       pageId: meta.pageId,
        //       userAccessToken: meta.accessToken,
        //       pageAccessToken: meta.pageAccessToken,
        //       mediaUrl: (item as any).linkVideo,
        //       caption: (item as any).copyPublicacion || "",
        //       scheduledAt,
        //     });
        //     (item as any).igContainerId = result.containerId;
        //     (item as any).igScheduleStatus = "SCHEDULED";
        //     (item as any).igScheduleError = undefined;
        //   } catch (igErr: any) {
        //     console.warn("[VideoPlanningService] Instagram scheduling failed:", igErr.message);
        //     (item as any).igScheduleStatus = "FAILED";
        //     (item as any).igScheduleError = igErr.message;
        //   }
        // }

        // ── Facebook ───────────────────────────────────────────────────────
        if (platformFlags?.publishToFacebook && meta.pageAccessToken) {
          try {
            const result = await metaService.scheduleFacebookPost({
              pageId: meta.pageId,
              pageAccessToken: meta.pageAccessToken,
              mediaUrl: (item as any).linkVideo,
              caption: (item as any).copyPublicacion || "",
              scheduledAt,
            });
            (item as any).fbPostId = result.postId;
            (item as any).fbScheduleStatus = "SCHEDULED";
            (item as any).fbScheduleError = undefined;
          } catch (fbErr: any) {
            console.warn("[VideoPlanningService] Facebook scheduling failed:", fbErr.message);
            (item as any).fbScheduleStatus = "FAILED";
            (item as any).fbScheduleError = fbErr.message;
          }
        }

        await planning.save();
      }
    }

    return planning.toObject() as IVideoPlanning;
  }

  // ── CLIENT APPROVAL (POST) ─────────────────────────────────────────────────
  async submitClientApproval(
    planningId: string,
    approvals: { itemId: string; clienteAprobacion: ClienteAprobacion; motivoRechazo?: string }[],
    userId: string
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId)) throw new Error("INVALID_ID");

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");
    if (planning.clienteAprobado) throw new Error("LOCKED");

    // Apply per-item approvals
    for (const approval of approvals) {
      if (!Types.ObjectId.isValid(approval.itemId)) continue;
      const item = planning.items.find((i) => i._id.toString() === approval.itemId);
      if (item) {
        item.clienteAprobacion = approval.clienteAprobacion;
        // Auto-approve idea when client approves the video
        if (approval.clienteAprobacion === "APROBADO") {
          item.estadoIdea = "APROBADO";
        }
        if (approval.motivoRechazo !== undefined) {
          item.motivoRechazo = approval.motivoRechazo;
        }
      }
    }

    // Lock the document
    planning.clienteAprobado = true;
    planning.clienteAprobadoAt = new Date();
    planning.clienteAprobadoPor = new Types.ObjectId(userId);

    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── REOPEN (POST) ───────────────────────────────────────────────────────────
  async reopen(planningId: string): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId)) throw new Error("INVALID_ID");

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");
    if (!planning.clienteAprobado) throw new Error("NOT_LOCKED");

    // Only reopen if there are rejected items
    const hasRejected = planning.items.some(
      (i) => i.clienteAprobacion === "RECHAZADO"
    );
    if (!hasRejected) throw new Error("NO_REJECTED");

    // Reset lock
    planning.clienteAprobado = false;
    planning.clienteAprobadoAt = undefined;
    planning.clienteAprobadoPor = undefined;

    // Reset rejected items back to PENDIENTE
    for (const item of planning.items) {
      if (item.clienteAprobacion === "RECHAZADO") {
        item.clienteAprobacion = "PENDIENTE";
        item.motivoRechazo = undefined;
      }
    }

    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── CALENDAR ITEMS (GET) ──────────────────────────────────────────────────
  async getCalendarItems(
    workspaceId: string,
    startDate: Date,
    endDate: Date
  ): Promise<object[]> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const plannings = await models.videoPlanning
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        "items.fechaPublicacion": { $gte: startDate, $lte: endDate },
      })
      .lean<IVideoPlanning[]>();

    const result: object[] = [];
    for (const p of plannings) {
      for (const item of p.items) {
        if (
          item.fechaPublicacion &&
          item.fechaPublicacion >= startDate &&
          item.fechaPublicacion <= endDate
        ) {
          result.push({
            _id: item._id,
            planningId: p._id,
            entryId: p.planningEntryId,
            workspaceId: p.workspaceId,
            numero: item.numero,
            tema: item.tema,
            tipo: item.tipo,
            estadoPublicacion: item.estadoPublicacion,
            edicion: item.edicion,
            estadoProduccion: item.estadoProduccion,
            clienteAprobacion: item.clienteAprobacion,
            linkVideo: item.linkVideo,
            fechaPublicacion: item.fechaPublicacion,
            copyPublicacion: item.copyPublicacion,
          });
        }
      }
    }
    return result;
  }
}
