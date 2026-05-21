import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { publicMetricsService } from "../services/publicMetrics.service";

export async function getAllMetrics(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const page = Math.max(1, parseInt(req.query["page"] as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query["limit"] as string) || 20));
    const workspaceId = req.query["workspaceId"] as string | undefined;
    const dateParam = req.query["date"] as string | undefined;
    const date = dateParam ? new Date(dateParam) : undefined;

    const result = await publicMetricsService.getAllWorkspacesMetrics(page, limit, workspaceId, date);
    res.status(HttpStatusCode.Ok).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getWorkspaceMetrics(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const dateParam = req.query["date"] as string | undefined;
    const monthParam = req.query["month"] as string | undefined;
    const yearParam = req.query["year"] as string | undefined;

    const date = dateParam ? new Date(dateParam) : undefined;
    const month = monthParam ? parseInt(monthParam) : undefined;
    const year = yearParam ? parseInt(yearParam) : undefined;

    const result = await publicMetricsService.getSingleWorkspaceMetrics(workspaceId, date, month, year);

    if (!result) {
      res.status(HttpStatusCode.NotFound).json({ message: "Workspace not found." });
      return;
    }

    res.status(HttpStatusCode.Ok).json(result);
  } catch (error) {
    next(error);
  }
}

export async function getBillingAlerts(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const result = await publicMetricsService.getBillingAlerts();
    res.status(HttpStatusCode.Ok).json(result);
  } catch (error) {
    next(error);
  }
}
