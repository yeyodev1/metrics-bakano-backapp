import { Response } from "express";
import { AuthRequest } from "../types/AuthRequest";
import { notificationService } from "../services/notification.service";

export async function getMyNotifications(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!._id;
    const notifications = await notificationService.getForUser(userId);
    res.json({ notifications });
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
