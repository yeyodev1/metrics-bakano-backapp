import { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { clientMeetingService } from "../services/clientMeeting.service";

export async function createOrUpdate(req: AuthRequest, res: Response) {
  try {
    const { workspaceId, nextMeetingDate, agenda, intervalDays, contactUserId, contactName, contactEmail, meetingLink, notes } = req.body;
    const userId = req.user!._id;

    if (!workspaceId) {
      return res.status(400).json({ message: "workspaceId es requerido" });
    }
    if (!nextMeetingDate) {
      return res.status(400).json({ message: "nextMeetingDate es requerido" });
    }

    // Superadmin can pass pmUserId explicitly; others use their own id
    const pmUserId =
      req.user!.role === "superadmin" && req.body.pmUserId
        ? req.body.pmUserId
        : userId;

    // Resolve workspace name and PM name for email (non-blocking if they fail)
    let workspaceName: string | undefined;
    let pmName = req.user!.email;
    try {
      const dbModels = (await import("../models")).default;
      const [ws, pm] = await Promise.all([
        dbModels.workspaces.findById(workspaceId).select("name").lean(),
        dbModels.users.findById(pmUserId).select("name email").lean(),
      ]);
      workspaceName = (ws as any)?.name;
      pmName = (pm as any)?.name || (pm as any)?.email || pmName;
    } catch { /* silent */ }

    const meeting = await clientMeetingService.createOrUpdate(
      workspaceId,
      pmUserId,
      new Date(nextMeetingDate),
      {
        agenda,
        intervalDays,
        contactUserId,
        contactName,
        contactEmail,
        meetingLink,
        notes,
        pmName,
        workspaceName,
      }
    );

    res.status(200).json({ meeting });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    res.status(500).json({ message: "Error al guardar la reunión" });
  }
}

export async function getMyMeetings(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!._id;
    const meetings = await clientMeetingService.getMyMeetings(userId);
    res.json({ meetings });
  } catch (err: unknown) {
    res.status(500).json({ message: "Error al obtener reuniones" });
  }
}

export async function getByWorkspace(req: AuthRequest, res: Response) {
  try {
    const workspaceId = req.params.workspaceId as string;
    const meeting = await clientMeetingService.getByWorkspace(workspaceId);
    res.json({ meeting });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    res.status(500).json({ message: "Error al obtener reunión" });
  }
}

export async function updateMeeting(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const userId = req.user!._id;
    const { nextMeetingDate, agenda, intervalDays, meetingLink, notes, contactUserId, contactName, contactEmail } = req.body;
    const { Types } = await import("mongoose");

    const fields: Record<string, unknown> = {};
    if (nextMeetingDate) fields.nextMeetingDate = new Date(nextMeetingDate);
    if (agenda !== undefined) fields.agenda = agenda;
    if (intervalDays) fields.intervalDays = intervalDays;
    if (meetingLink !== undefined) fields.meetingLink = meetingLink;
    if (notes !== undefined) fields.notes = notes;
    if (contactUserId && Types.ObjectId.isValid(contactUserId)) fields.contactUserId = new Types.ObjectId(contactUserId);
    if (contactName !== undefined) fields.contactName = contactName;
    if (contactEmail !== undefined) fields.contactEmail = contactEmail;

    const meeting = await clientMeetingService.update(id, userId, fields as Parameters<typeof clientMeetingService.update>[2]);
    res.json({ meeting });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ message: "Reunión no encontrada" });
    res.status(500).json({ message: "Error al actualizar reunión" });
  }
}

export async function completeMeeting(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const userId = req.user!._id;
    const { notes, recordingLink } = req.body;
    const meeting = await clientMeetingService.complete(id, userId, { notes, recordingLink });
    res.json({ meeting });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ message: "Reunión no encontrada" });
    res.status(500).json({ message: "Error al completar reunión" });
  }
}
