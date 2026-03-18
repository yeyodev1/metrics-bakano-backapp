import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { VideoPlanningService } from "../services/videoPlanning.service";

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
    const fields = req.body;
    // internalRole may be in the JWT payload (optional)
    const internalRole = (req.user as any)?.internalRole as string | undefined;

    const planning = await service.updateItem(planningId, itemId, fields, internalRole);
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
