import { Response } from "express";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import { notificationService } from "../services/notification.service";
import { resendService } from "../services/resend.service";
import models from "../models";

export async function getMyNotifications(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!._id;
    const page = Math.max(1, parseInt(req.query["page"] as string, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query["limit"] as string, 10) || 10));
    const result = await notificationService.getForUser(userId as string, page, limit);
    res.json(result);
  } catch {
    res.status(500).json({ message: "Error al obtener notificaciones" });
  }
}

export async function getUnreadCount(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!._id;
    const count = await notificationService.getUnreadCount(userId);
    res.json({ count });
  } catch {
    res.status(500).json({ message: "Error al obtener conteo" });
  }
}

export async function markRead(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const userId = req.user!._id;
    const notification = await notificationService.markRead(id, userId);
    res.json({ notification });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ message: "Notificación no encontrada" });
    res.status(500).json({ message: "Error al marcar como leída" });
  }
}

export async function markAllRead(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!._id;
    await notificationService.markAllRead(userId);
    res.json({ message: "Todas las notificaciones marcadas como leídas" });
  } catch {
    res.status(500).json({ message: "Error al marcar todas como leídas" });
  }
}

export async function deleteNotification(req: AuthRequest, res: Response) {
  try {
    const id = req.params.id as string;
    const userId = req.user!._id;
    await notificationService.deleteOne(id, userId);
    res.json({ message: "Notificación eliminada" });
  } catch (err: unknown) {
    const e = err as Error;
    if (e.message === "INVALID_ID") return res.status(400).json({ message: "ID inválido" });
    if (e.message === "NOT_FOUND") return res.status(404).json({ message: "Notificación no encontrada" });
    res.status(500).json({ message: "Error al eliminar notificación" });
  }
}

/**
 * POST /api/notifications/billing-reminder/:workspaceId
 * Sends a billing data reminder to all external (non-internal) collaborators of a workspace.
 * Only accessible by internal users and superadmins.
 */
export async function sendBillingReminder(req: AuthRequest, res: Response) {
  try {
    const { workspaceId } = req.params;

    const workspace = await models.workspaces.findById(workspaceId).select("name").lean();
    if (!workspace) return res.status(404).json({ message: "Entorno no encontrado" });

    const wsId = new Types.ObjectId(workspaceId);
    const now = new Date();
    const monthLabel = now.toLocaleDateString("es-EC", { month: "long", year: "numeric" });

    // Fetch all active external collaborators of this workspace
    const users = await models.users
      .find({
        $or: [{ workspaceId: wsId }, { "workspaces.workspaceId": wsId }],
        isActive: true,
        isInternal: { $ne: true },
      })
      .select("_id name email")
      .lean();

    if (!users.length) {
      return res.status(404).json({ message: "No hay colaboradores externos en este entorno" });
    }

    // Send in-app notification + email concurrently for each user
    const notifBody = `Por favor ingresa los datos de facturación de ${monthLabel} en ${workspace.name} para mantener el ROAS actualizado.`;

    await Promise.all([
      // In-app notifications (bulk insert)
      notificationService.createForWorkspaceUsers(
        workspaceId,
        true,
        "billing_reminder",
        "Datos de facturación pendientes",
        notifBody
      ),
      // Resend emails — fire-and-forget per user (don't block on individual failures)
      ...users.map((u) =>
        resendService
          .sendDailyBillingReminder({
            to: u.email,
            recipientName: u.name || u.email,
            workspaceName: workspace.name,
            workspaceId,
            hasFilled: false,
            date: now,
          })
          .catch((err) =>
            console.error(`[billing-reminder] email failed for ${u.email}:`, err)
          )
      ),
    ]);

    res.json({
      message: `Recordatorio enviado a ${users.length} colaborador${users.length !== 1 ? "es" : ""} del entorno`,
      count: users.length,
    });
  } catch {
    res.status(500).json({ message: "Error al enviar recordatorio" });
  }
}
