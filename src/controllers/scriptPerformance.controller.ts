import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import {
  scriptPerformanceService,
  type PerformanceMetric,
} from "../services/scriptPerformance.service";

function parseMetric(value: unknown): PerformanceMetric {
  return value === "leads" ? "leads" : "views";
}

// ── GET /script-performance/:workspaceId ───────────────────────────────────
export async function getWorkspacePerformance(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const month = typeof req.query.month === "string" ? req.query.month : undefined;

    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      res
        .status(HttpStatusCode.BadRequest)
        .json({ message: "El parámetro month debe tener formato YYYY-MM." });
      return;
    }

    const performance = await scriptPerformanceService.getWorkspacePerformance(
      workspaceId,
      { metric: parseMetric(req.query.metric), month }
    );

    res.status(HttpStatusCode.Ok).json({ performance });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    if (error.message === "INVALID_MONTH") {
      res
        .status(HttpStatusCode.BadRequest)
        .json({ message: "El parámetro month debe tener formato YYYY-MM." });
      return;
    }
    console.error("getWorkspacePerformance error:", error);
    next(error);
  }
}

// ── GET /script-performance/:workspaceId/items/:itemId/timeline ────────────
export async function getItemTimeline(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const { workspaceId, itemId } = req.params as {
      workspaceId: string;
      itemId: string;
    };

    const timeline = await scriptPerformanceService.getItemTimeline(workspaceId, itemId);
    res.status(HttpStatusCode.Ok).json({ timeline });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "ID inválido." });
      return;
    }
    console.error("getItemTimeline error:", error);
    next(error);
  }
}

// ── GET /script-performance/cross-workspace ────────────────────────────────
export async function getCrossWorkspacePerformance(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const month = typeof req.query.month === "string" ? req.query.month : undefined;
    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      res
        .status(HttpStatusCode.BadRequest)
        .json({ message: "El parámetro month debe tener formato YYYY-MM." });
      return;
    }

    const comparison = await scriptPerformanceService.getCrossWorkspacePerformance({
      vertical: typeof req.query.vertical === "string" ? req.query.vertical : undefined,
      metric: parseMetric(req.query.metric),
      month,
    });

    res.status(HttpStatusCode.Ok).json({ comparison });
  } catch (error: any) {
    console.error("getCrossWorkspacePerformance error:", error);
    next(error);
  }
}
