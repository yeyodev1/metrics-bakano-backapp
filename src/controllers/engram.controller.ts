import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { engramService } from "../services/engram.service";

// ── GET /engram/:workspaceId ───────────────────────────────────────────────
export async function getEngram(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const [active, versions] = await Promise.all([
      engramService.getActive(workspaceId),
      engramService.listVersions(workspaceId),
    ]);

    res.status(HttpStatusCode.Ok).json({ active, versions });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    console.error("getEngram error:", error);
    next(error);
  }
}

// ── POST /engram/:workspaceId/rebuild ──────────────────────────────────────
export async function rebuildEngram(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const { metric, month } = req.body ?? {};

    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      res
        .status(HttpStatusCode.BadRequest)
        .json({ message: "El parámetro month debe tener formato YYYY-MM." });
      return;
    }

    const engram = await engramService.rebuild(workspaceId, {
      metric: metric === "leads" ? "leads" : "views",
      month,
      userId: req.user?._id,
    });

    res.status(HttpStatusCode.Created).json({
      message:
        "Engram generado como borrador. Revísalo y actívalo para que alimente los guiones.",
      engram,
    });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    if (error.message === "NOT_ENOUGH_DATA") {
      res.status(HttpStatusCode.UnprocessableEntity).json({
        message:
          "No hay suficientes videos con métricas para extraer aprendizajes confiables todavía.",
      });
      return;
    }
    console.error("rebuildEngram error:", error);
    next(error);
  }
}

// ── PATCH /engram/:workspaceId/:version/activate ───────────────────────────
export async function activateEngram(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId, version } = req.params as { workspaceId: string; version: string };
    const parsedVersion = Number(version);

    if (!Number.isInteger(parsedVersion) || parsedVersion < 1) {
      res.status(HttpStatusCode.BadRequest).json({ message: "Versión inválida." });
      return;
    }

    const engram = await engramService.activate(workspaceId, parsedVersion, req.user?._id);
    res.status(HttpStatusCode.Ok).json({ message: "Engram activado.", engram });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Versión de engram no encontrada." });
      return;
    }
    console.error("activateEngram error:", error);
    next(error);
  }
}
