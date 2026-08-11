import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import { VideoPlanningService } from "../services/videoPlanning.service";
import { metaService } from "../services/meta.service";
import models from "../models";
import cloudinary from "../config/cloudinary";

const service = new VideoPlanningService();

// ── GET /planning-entries/:entryId/video-planning ─────────────────────────
export async function getByEntry(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { entryId } = req.params as { entryId: string };
    const planning = await service.getByEntry(entryId);

    if (!planning) {
      res.status(HttpStatusCode.Ok).json({ message: "No video planning found.", planning: null });
      return;
    }

    res.status(HttpStatusCode.Ok).json({ message: "Video planning retrieved.", planning });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid entry ID." });
      return;
    }
    console.error("getByEntry error:", error);
    next(error);
  }
}

// ── POST /planning-entries/:entryId/video-planning (create) ───────────────
export async function createPlanning(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { entryId } = req.params as { entryId: string };
    const { items = [], workspaceId } = req.body;

    if (!workspaceId) {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId is required." });
      return;
    }

    const planning = await service.upsert(entryId, workspaceId, items);
    res.status(HttpStatusCode.Created).json({ message: "Video planning created.", planning });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid entry ID." });
      return;
    }
    if (error.message === "LOCKED") {
      res.status(HttpStatusCode.Forbidden).json({ message: "Esta planificación ya fue aprobada por el cliente y no puede modificarse." });
      return;
    }
    console.error("createPlanning error:", error);
    next(error);
  }
}

// ── PUT /planning-entries/:entryId/video-planning (replace items) ─────────
export async function updatePlanning(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { entryId } = req.params as { entryId: string };
    const { items = [], workspaceId } = req.body;

    if (!workspaceId) {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId is required." });
      return;
    }

    const planning = await service.upsert(entryId, workspaceId, items);
    res.status(HttpStatusCode.Ok).json({ message: "Video planning updated.", planning });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid entry ID." });
      return;
    }
    if (error.message === "LOCKED") {
      res.status(HttpStatusCode.Forbidden).json({ message: "Esta planificación ya fue aprobada por el cliente y no puede modificarse." });
      return;
    }
    console.error("updatePlanning error:", error);
    next(error);
  }
}

// ── PATCH /video-planning/:planningId/items/:itemId ───────────────────────
export async function updateItem(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId, itemId } = req.params as {
      planningId: string;
      itemId: string;
    };
    const { publishToInstagram, publishToFacebook, ...fields } = req.body;
    // internalRole may be in the JWT payload (optional)
    const internalRole = (req.user as any)?.internalRole as string | undefined;

    const planning = await service.updateItem(planningId, itemId, fields, internalRole, {
      publishToInstagram: !!publishToInstagram,
      publishToFacebook: !!publishToFacebook,
    });
    res.status(HttpStatusCode.Ok).json({ message: "Item updated.", planning });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid ID." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Video planning not found." });
      return;
    }
    if (error.message === "ITEM_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Video item not found." });
      return;
    }
    console.error("updateItem error:", error);
    next(error);
  }
}

// ── POST /video-planning/:planningId/client-approval ─────────────────────
export async function submitClientApproval(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId } = req.params as { planningId: string };
    const { approvals } = req.body;
    const userId = req.user!._id;

    if (!Array.isArray(approvals) || approvals.length === 0) {
      res.status(HttpStatusCode.BadRequest).json({ message: "approvals array is required." });
      return;
    }

    const planning = await service.submitClientApproval(planningId, approvals, userId);
    res.status(HttpStatusCode.Ok).json({
      message: "Aprobación registrada. La planificación ha sido bloqueada permanentemente.",
      planning,
    });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid planning ID." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Video planning not found." });
      return;
    }
    if (error.message === "LOCKED") {
      res.status(HttpStatusCode.Conflict).json({ message: "Esta planificación ya fue aprobada anteriormente. La decisión es irreversible." });
      return;
    }
    console.error("submitClientApproval error:", error);
    next(error);
  }
}

// ── POST /video-planning/:planningId/reopen ───────────────────────────────
export async function reopenPlanning(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId } = req.params as { planningId: string };
    const planning = await service.reopen(planningId);
    res.status(HttpStatusCode.Ok).json({
      message: "Planificación re-abierta. Los videos rechazados han sido restablecidos a PENDIENTE.",
      planning,
    });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid planning ID." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Video planning not found." });
      return;
    }
    if (error.message === "NOT_LOCKED") {
      res.status(HttpStatusCode.BadRequest).json({ message: "La planificación no está bloqueada." });
      return;
    }
    if (error.message === "NO_REJECTED") {
      res.status(HttpStatusCode.BadRequest).json({ message: "No hay videos rechazados para re-abrir." });
      return;
    }
    console.error("reopenPlanning error:", error);
    next(error);
  }
}

// ── GET /video-planning/calendar?workspaceId=X&startDate=X&endDate=X ──────
export async function getCalendarItems(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId, startDate, endDate } = req.query as {
      workspaceId: string;
      startDate: string;
      endDate: string;
    };

    if (!workspaceId || !startDate || !endDate) {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId, startDate, endDate are required." });
      return;
    }

    const items = await service.getCalendarItems(
      workspaceId,
      new Date(startDate),
      new Date(endDate)
    );
    res.status(HttpStatusCode.Ok).json({ items });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid workspace ID." });
      return;
    }
    console.error("getCalendarItems error:", error);
    next(error);
  }
}

// ── POST /video-planning/items/:itemId/upload-media ────────────────────────
export async function uploadItemMedia(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { itemId } = req.params as { itemId: string };

    if (!Types.ObjectId.isValid(itemId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid item ID." });
      return;
    }

    if (!req.file) {
      res.status(HttpStatusCode.BadRequest).json({ message: "No file uploaded." });
      return;
    }

    const { buffer, mimetype, originalname } = req.file;
    const isVideo = mimetype.startsWith("video/");

    // Upload to Cloudinary
    const folder = `video-planning/items/${itemId}`;
    const cloudinaryResult = await new Promise<{ url: string; public_id: string; duration?: number }>(
      (resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: isVideo ? "video" : "image",
            use_filename: true,
            unique_filename: true,
          },
          (error, result) => {
            if (error || !result) return reject(error || new Error("Cloudinary upload failed"));
            resolve({
              url: result.secure_url,
              public_id: result.public_id,
              duration: (result as any).duration,
            });
          }
        );
        stream.end(buffer);
      }
    );

    // Find the planning document that contains this item
    const planning = await models.videoPlanning.findOne({ "items._id": new Types.ObjectId(itemId) });
    if (!planning) {
      res.status(HttpStatusCode.NotFound).json({ message: "Planning item not found." });
      return;
    }

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) {
      res.status(HttpStatusCode.NotFound).json({ message: "Item not found." });
      return;
    }

    // Delete previous Cloudinary asset if it exists (fire & forget)
    const prevLink = (item as any).linkVideo as string | undefined;
    if (prevLink && /res\.cloudinary\.com/i.test(prevLink)) {
      const prevPublicId = prevLink.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/)?.[1];
      if (prevPublicId) {
        const prevResourceType = /\/video\/upload\//i.test(prevLink) ? "video" : "image";
        cloudinary.uploader.destroy(prevPublicId, { resource_type: prevResourceType }).catch(() => {});
      }
    }

    (item as any).linkVideo = cloudinaryResult.url;
    await planning.save();

    res.status(HttpStatusCode.Ok).json({
      message: "Media uploaded successfully.",
      url: cloudinaryResult.url,
      publicId: cloudinaryResult.public_id,
      mediaType: isVideo ? "video" : "image",
      item,
    });
  } catch (error) {
    console.error("uploadItemMedia error:", error);
    next(error);
  }
}

// ── GET /video-planning/editor/:editorId/edited-items ─────────────────────
export async function getEditorCompletedItems(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { editorId } = req.params as { editorId: string };
    
    if (!Types.ObjectId.isValid(editorId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "Invalid editor ID." });
      return;
    }

    // Find all Plannings assigned to this editor
    const plannings = await models.planning.find({
      assignedTo: new Types.ObjectId(editorId)
    }).lean();

    const planningIds = plannings.map(p => p._id);

    // Find VideoPlannings matching those plannings, and populated with workspace
    const videoPlannings = await models.videoPlanning.find({
      planningEntryId: { $in: planningIds }
    }).populate("workspaceId", "name metaAds.pageName").lean();

    const result: any[] = [];
    for (const vp of videoPlannings) {
      for (const item of vp.items) {
        if (item.edicion === "EDITADO") {
          result.push({
            workspaceId: (vp.workspaceId as any)?._id,
            workspaceName: (vp.workspaceId as any)?.name || "Sin entorno",
            tema: item.tema,
            linkVideo: item.linkVideo,
            fechaPublicacion: item.fechaPublicacion,
          });
        }
      }
    }

    // Sort by fechaPublicacion desc
    result.sort((a, b) => {
      const dateA = a.fechaPublicacion ? new Date(a.fechaPublicacion).getTime() : 0;
      const dateB = b.fechaPublicacion ? new Date(b.fechaPublicacion).getTime() : 0;
      return dateB - dateA; // newest first
    });

    res.status(HttpStatusCode.Ok).json({ items: result });
  } catch (error: any) {
    console.error("getEditorCompletedItems error:", error);
    next(error);
  }
}

// ── POST /video-planning/:planningId/items/:itemId/link-reel ──────────────
export async function linkReelMedia(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId, itemId } = req.params as { planningId: string; itemId: string };
    const { igMediaId, igPermalink, metaAdId, casoUsoRef } = req.body;

    if (!igMediaId) {
      res.status(HttpStatusCode.BadRequest).json({ message: "igMediaId es requerido." });
      return;
    }

    const planning = await service.linkReelMedia(planningId, itemId, {
      igMediaId,
      igPermalink,
      metaAdId,
      casoUsoRef,
    });

    res.status(HttpStatusCode.Ok).json({ message: "Reel vinculado exitosamente con el guion.", planning });
  } catch (error: any) {
    console.error("linkReelMedia error:", error);
    next(error);
  }
}

// ── POST /video-planning/:planningId/items/:itemId/sync-metrics ───────────
export async function syncVideoItemMetrics(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId, itemId } = req.params as { planningId: string; itemId: string };
    const planning = await service.syncVideoItemMetrics(planningId, itemId);
    res.status(HttpStatusCode.Ok).json({ message: "Métricas del video actualizadas.", planning });
  } catch (error: any) {
    console.error("syncVideoItemMetrics error:", error);
    next(error);
  }
}

// ── GET /video-planning/workspace/:workspaceId/items ───────────────────────
export async function getWorkspaceItems(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const items = await service.getWorkspaceItems(workspaceId);
    res.status(HttpStatusCode.Ok).json({ items });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    console.error("getWorkspaceItems error:", error);
    next(error);
  }
}

// ── GET /video-planning/workspace/:workspaceId/ads ─────────────────────────
export async function getWorkspaceAds(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const limit = Number(req.query["limit"]) || 10;
    const after = typeof req.query["after"] === "string" ? req.query["after"] : undefined;

    const page = await metaService.getAdsPage(workspaceId, { limit, after });

    res.status(HttpStatusCode.Ok).json({
      ads: page.ads,
      nextCursor: page.nextCursor,
      adAccountName: page.adAccountName,
    });
  } catch (error: any) {
    console.error("getWorkspaceAds error:", error);
    next(error);
  }
}

// ── POST /video-planning/:planningId/items/:itemId/classify ────────────────
export async function classifyItemScript(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { planningId, itemId } = req.params as { planningId: string; itemId: string };
    const force = req.body?.force === true;

    const result = await service.classifyItemScript(planningId, itemId, { force });

    if (result.skipped === "NOT_ENOUGH_TEXT") {
      res.status(HttpStatusCode.UnprocessableEntity).json({
        message: "El guión no tiene suficiente texto para clasificarse.",
        scriptMeta: null,
      });
      return;
    }

    res.status(HttpStatusCode.Ok).json({
      message:
        result.skipped === "HUMAN_CLASSIFIED"
          ? "El guión ya fue clasificado manualmente. Usa force=true para sobrescribir."
          : "Guión clasificado.",
      scriptMeta: result.scriptMeta,
      skipped: result.skipped,
    });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "ID inválido." });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "ITEM_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Planificación o video no encontrado." });
      return;
    }
    console.error("classifyItemScript error:", error);
    next(error);
  }
}

// ── GET /video-planning/workspace/:workspaceId/published-reels ─────────────
export async function getPublishedReelsForWorkspace(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = await models.workspaces.findById(workspaceId).select("metaAds name").lean();

    if (!workspace) {
      res.status(HttpStatusCode.NotFound).json({ message: "Workspace no encontrado." });
      return;
    }

    const instagramAccountId = workspace.metaAds?.instagramAccountId;
    if (!instagramAccountId) {
      res.status(HttpStatusCode.Ok).json({ reels: [], message: "El workspace no tiene cuenta de Instagram vinculada." });
      return;
    }

    // Paginated: the picker asks for a page at a time instead of the whole feed.
    const limit = Number(req.query["limit"]) || 10;
    const after = typeof req.query["after"] === "string" ? req.query["after"] : undefined;

    const page = await metaService.getInstagramMediaPage(workspaceId, { limit, after });

    res.status(HttpStatusCode.Ok).json({
      reels: page.reels,
      nextCursor: page.nextCursor,
      accountName: page.accountName,
    });
  } catch (error: any) {
    console.error("getPublishedReelsForWorkspace error:", error);
    next(error);
  }
}
