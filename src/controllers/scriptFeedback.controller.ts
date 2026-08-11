import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";

const TIPOS = ["video", "guion", "general"] as const;

// ── GET /script-feedback/:workspaceId ──────────────────────────────────────
export async function listFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }

    const query: Record<string, any> = { workspaceId: new Types.ObjectId(workspaceId) };

    // Scoped to one script when asked; the chat is shared otherwise.
    const videoItemId = req.query["videoItemId"];
    if (typeof videoItemId === "string") {
      if (!Types.ObjectId.isValid(videoItemId)) {
        res.status(HttpStatusCode.BadRequest).json({ message: "videoItemId inválido." });
        return;
      }
      query.videoItemId = new Types.ObjectId(videoItemId);
    }

    const limit = Math.min(Number(req.query["limit"]) || 100, 300);

    const feedback = await models.scriptFeedback
      .find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    // Oldest first so the chat reads top to bottom.
    res.status(HttpStatusCode.Ok).json({ feedback: feedback.reverse() });
  } catch (error) {
    console.error("listFeedback error:", error);
    next(error);
  }
}

// ── POST /script-feedback/:workspaceId ─────────────────────────────────────
export async function createFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const { texto, tipo, videoItemId, planningId, videoTema } = req.body ?? {};

    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    if (typeof texto !== "string" || !texto.trim()) {
      res.status(HttpStatusCode.BadRequest).json({ message: "El mensaje no puede estar vacío." });
      return;
    }
    if (texto.length > 4000) {
      res.status(HttpStatusCode.BadRequest).json({ message: "El mensaje es demasiado largo." });
      return;
    }
    if (videoItemId && !Types.ObjectId.isValid(videoItemId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "videoItemId inválido." });
      return;
    }

    const created = await models.scriptFeedback.create({
      workspaceId: new Types.ObjectId(workspaceId),
      videoItemId: videoItemId ? new Types.ObjectId(videoItemId) : undefined,
      planningId:
        planningId && Types.ObjectId.isValid(planningId)
          ? new Types.ObjectId(planningId)
          : undefined,
      videoTema: typeof videoTema === "string" ? videoTema.slice(0, 200) : undefined,
      tipo: TIPOS.includes(tipo) ? tipo : videoItemId ? "video" : "general",
      texto: texto.trim(),
      authorId: new Types.ObjectId(req.user!._id),
      authorName: (req.user as any)?.name || (req.user as any)?.email || "Equipo",
    });

    res.status(HttpStatusCode.Created).json({ feedback: created });
  } catch (error) {
    console.error("createFeedback error:", error);
    next(error);
  }
}

// ── DELETE /script-feedback/:workspaceId/:feedbackId ───────────────────────
export async function deleteFeedback(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { feedbackId } = req.params as { feedbackId: string };
    if (!Types.ObjectId.isValid(feedbackId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "feedbackId inválido." });
      return;
    }

    const entry = await models.scriptFeedback.findById(feedbackId);
    if (!entry) {
      res.status(HttpStatusCode.NotFound).json({ message: "Comentario no encontrado." });
      return;
    }

    // Only the author or a superadmin can remove a note.
    const isAuthor = String(entry.authorId) === req.user?._id;
    if (!isAuthor && req.user?.role !== "superadmin") {
      res.status(HttpStatusCode.Forbidden).json({ message: "No puedes borrar este comentario." });
      return;
    }

    await entry.deleteOne();
    res.status(HttpStatusCode.Ok).json({ message: "Comentario eliminado." });
  } catch (error) {
    console.error("deleteFeedback error:", error);
    next(error);
  }
}
