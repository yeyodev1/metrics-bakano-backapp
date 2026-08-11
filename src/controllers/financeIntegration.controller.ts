import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import {
  listWorkspacesForFinance,
  getWorkspaceForFinance,
  setWorkspaceActiveForFinance,
} from "../services/financeIntegration.service";

export async function listFinanceWorkspaces(_req: Request, res: Response, next: NextFunction) {
  try {
    const workspaces = await listWorkspacesForFinance();
    res.status(HttpStatusCode.Ok).send({ message: "Workspaces retrieved successfully.", workspaces });
    return;
  } catch (error) {
    console.error("listFinanceWorkspaces error:", error);
    next(error);
  }
}

export async function getFinanceWorkspace(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const workspace = await getWorkspaceForFinance(workspaceId);
    res.status(HttpStatusCode.Ok).send({ message: "Workspace retrieved successfully.", workspace });
    return;
  } catch (error) {
    console.error("getFinanceWorkspace error:", error);
    next(error);
  }
}

export async function setFinanceWorkspaceActive(req: Request, res: Response, next: NextFunction) {
  try {
    const { workspaceId } = req.params as { workspaceId: string };
    const { isActive, reason } = req.body ?? {};

    if (typeof isActive !== "boolean") {
      res.status(HttpStatusCode.BadRequest).send({ message: "El campo isActive debe ser booleano." });
      return;
    }

    if (reason !== undefined && typeof reason !== "string") {
      res.status(HttpStatusCode.BadRequest).send({ message: "El campo reason debe ser texto." });
      return;
    }

    const workspace = await setWorkspaceActiveForFinance(workspaceId, isActive, reason);
    res.status(HttpStatusCode.Ok).send({ message: "Workspace updated successfully.", workspace });
    return;
  } catch (error) {
    console.error("setFinanceWorkspaceActive error:", error);
    next(error);
  }
}

export function financeHealth(_req: Request, res: Response) {
  res.status(HttpStatusCode.Ok).send({ ok: true, service: "metrics", ts: new Date().toISOString() });
}
