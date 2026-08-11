import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { billingService } from "../services/billing.service";
import { agentFeedService } from "../services/agentFeed.service";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * GET /api/agent-feed/workspaces/:workspaceId
 *
 * Everything the scripting agent needs about one brand:
 * strategy and Customer Journey, every script with its full text and publish
 * date, what the metrics say works and what does not, and the learned engram.
 *
 * Optional range: `?month=YYYY-MM` or `?from=YYYY-MM-DD&to=YYYY-MM-DD`.
 */
export async function getWorkspaceAgentFeed(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const { from, to, month } = req.query as Record<string, string | undefined>;

    if (month && !MONTH_RE.test(month)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "month debe ser YYYY-MM." });
      return;
    }
    for (const [name, value] of [["from", from], ["to", to]] as const) {
      if (value && !DATE_RE.test(value)) {
        res.status(HttpStatusCode.BadRequest).json({ message: `${name} debe ser YYYY-MM-DD.` });
        return;
      }
    }
    if (from && to && from > to) {
      res.status(HttpStatusCode.BadRequest).json({ message: "from no puede ser mayor que to." });
      return;
    }

    const feed = await agentFeedService.build(workspaceId, { from, to, month });

    // Billing is a separate concern and must never block the feed.
    let facturacion: any = null;
    try {
      const now = new Date();
      const summary: any = await billingService.getMonthEntries(
        workspaceId,
        now.getFullYear(),
        now.getMonth() + 1
      );
      const days = summary?.days ?? [];
      const totalAmount = days.reduce((s: number, d: any) => s + d.totalAmount, 0);
      const totalMetaSpend = days.reduce((s: number, d: any) => s + d.totalMetaSpend, 0);
      facturacion = {
        totalFacturado: totalAmount,
        totalInvertidoMetaAds: totalMetaSpend,
        roasPromedio: totalMetaSpend > 0 ? totalAmount / totalMetaSpend : 0,
      };
    } catch {
      /* non-blocking */
    }

    res.status(HttpStatusCode.Ok).json({ ...feed, facturacionMesActual: facturacion });
  } catch (error: any) {
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).json({ message: "workspaceId inválido." });
      return;
    }
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).json({ message: "Workspace no encontrado." });
      return;
    }
    console.error("getWorkspaceAgentFeed error:", error);
    next(error);
  }
}
