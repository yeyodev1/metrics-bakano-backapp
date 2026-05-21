import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { PlanningService } from "../services/planning.service";
import models from "../models";

const planningService = new PlanningService();

export async function createEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { title, date, notes, assignedTo } = req.body;
    const userId = req.user?._id;

    if (!title || !date) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Title and Date are required." });
      return;
    }

    const entry = await planningService.createEntry({
      workspaceId,
      title,
      date: new Date(date),
      notes,
      assignedTo: Array.isArray(assignedTo) ? assignedTo : [],
      createdBy: userId!,
    });

    res.status(HttpStatusCode.Created).send({ message: "Planning entry created successfully.", entry });
    return;
  } catch (error) {
    console.error("createEntry error:", error);
    next(error);
  }
}

export async function listEntries(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { startDate, endDate } = req.query;

    // Superadmin can query any workspace without restriction
    const isSuperadmin = req.user?.role === "superadmin";

    if (!isSuperadmin) {
      // For regular users, verify they belong to this workspace
      const userId = req.user?._id;
      const user = await models.users.findById(userId).lean() as any;
      const hasAccess =
        user?.isInternal ||
        (user?.workspaces || []).some((ws: any) => {
          const wsId = ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString();
          return wsId === workspaceId;
        });

      if (!hasAccess) {
        res.status(HttpStatusCode.Forbidden).send({ message: "Access denied to this workspace." });
        return;
      }
    }

    const entries = await planningService.listEntries(
      workspaceId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined
    );

    res.status(HttpStatusCode.Ok).send({ message: "Planning entries retrieved successfully.", entries });
    return;
  } catch (error) {
    console.error("listEntries error:", error);
    next(error);
  }
}

export async function updateEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entryId = req.params["entryId"] as string;
    const { title, date, notes, assignedTo } = req.body;

    const entry = await planningService.updateEntry(entryId, {
      title,
      date,
      notes,
      assignedTo: Array.isArray(assignedTo) ? assignedTo : undefined,
    });

    res.status(HttpStatusCode.Ok).send({ message: "Planning entry updated successfully.", entry });
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Entry not found." });
      return;
    }
    console.error("updateEntry error:", error);
    next(error);
  }
}

export async function deleteEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entryId = req.params["entryId"] as string;

    await planningService.deleteEntry(entryId);

    res.status(HttpStatusCode.Ok).send({ message: "Planning entry deleted successfully." });
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Entry not found." });
      return;
    }
    console.error("deleteEntry error:", error);
    next(error);
  }
}

export async function listMyWeek(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?._id;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      res.status(HttpStatusCode.BadRequest).send({ message: "startDate and endDate are required." });
      return;
    }

    const user = await models.users.findById(userId).populate("workspaces.workspaceId", "name metaAds").lean();

    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    let workspaceIds: string[] = [];

    // Build workspace name + Meta page id lookups — populated workspaceId is { _id, name, metaAds }
    const wsNameMap: Record<string, string> = {};
    const wsMetaPageIdMap: Record<string, string> = {};

    (user.workspaces || []).forEach((ws: any) => {
      const id = ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString();
      if (!id) return;
      if (ws.workspaceId?.name) wsNameMap[id] = ws.workspaceId.name;
      if (ws.workspaceId?.metaAds?.pageId) wsMetaPageIdMap[id] = ws.workspaceId.metaAds.pageId;
    });

    const isSuperadminOrInternal =
      req.user?.role === "superadmin" ||
      user.role === "superadmin" ||
      user.isInternal === true;

    if (isSuperadminOrInternal) {
      // Fetch all workspaces with name + metaAds so we can label entries correctly
      const allWorkspaces = await models.workspaces.find({}, "_id name metaAds.pageId").lean();
      workspaceIds = allWorkspaces.map((ws: any) => ws._id.toString());
      allWorkspaces.forEach((ws: any) => {
        const id = ws._id.toString();
        wsNameMap[id] = ws.name;
        if (ws.metaAds?.pageId) wsMetaPageIdMap[id] = ws.metaAds.pageId;
      });
    } else {
      // For regular users, workspaceId is a populated object — extract _id
      workspaceIds = (user.workspaces || [])
        .map((ws: any) => ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString())
        .filter((id: string | undefined): id is string => Boolean(id));
    }

    // Fetch from all workspaces in parallel
    const allEntriesNested = await Promise.all(
      workspaceIds.map((wsId) =>
        planningService.listEntries(wsId, new Date(startDate as string), new Date(endDate as string))
      )
    );

    const entries = allEntriesNested
      .flat()
      .map((entry) => ({
        ...(entry as any).toObject?.() ?? entry,
        workspaceName: wsNameMap[(entry as any).workspaceId?.toString()] || "Workspace",
        workspaceMetaPageId: wsMetaPageIdMap[(entry as any).workspaceId?.toString()],
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.status(HttpStatusCode.Ok).send({ message: "My week entries retrieved successfully.", entries });
    return;
  } catch (error) {
    console.error("listMyWeek error:", error);
    next(error);
  }
}
