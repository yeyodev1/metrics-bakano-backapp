import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import {
  googleDriveService,
  driveSharedDriveId,
  sanitizeDriveName,
} from "../services/googleDrive.service";

/**
 * Entrega de videos maestros a Drive.
 *
 * El backend solo orquesta (carpetas + sesion resumable + confirmacion); el
 * archivo viaja directo navegador → googleapis.com porque Vercel corta el
 * body en ~4.5MB y los videos maestros pesan cientos de MB.
 */

const MAX_SIZE = 5 * 1024 * 1024 * 1024; // 5GB: tope de cordura, no de Drive

function ymDe(fecha?: Date): string {
  const d = fecha ? new Date(fecha) : new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function buscarPlanningConItem(itemId: string) {
  const planning = await models.videoPlanning.findOne({
    "items._id": new Types.ObjectId(itemId),
  });
  const item = planning?.items.find((i) => i._id.toString() === itemId);
  return { planning, item };
}

function mapDriveError(error: any, res: Response): boolean {
  if (error?.message === "DRIVE_NOT_CONFIGURED") {
    res.status(HttpStatusCode.ServiceUnavailable).json({
      message:
        "Drive no está configurado: falta GOOGLE_DRIVE_SA_KEY_B64 o DRIVE_SHARED_DRIVE_ID en el backend.",
    });
    return true;
  }
  if (error?.response?.status === 404) {
    res.status(HttpStatusCode.ServiceUnavailable).json({
      message:
        "Drive respondió 404: revisa que la service account esté invitada a la unidad compartida como Gestor de contenido.",
    });
    return true;
  }
  if (error?.response?.status === 403) {
    res.status(HttpStatusCode.ServiceUnavailable).json({
      message:
        "Drive respondió 403 (permisos): la service account no puede escribir en la unidad compartida o el enlace público está bloqueado por el admin del Workspace.",
    });
    return true;
  }
  return false;
}

// ── POST /drive/upload-session ──────────────────────────────────────────────
export async function createUploadSession(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { itemId, fileName, mimeType, size } = req.body as {
      itemId?: string;
      fileName?: string;
      mimeType?: string;
      size?: number;
    };

    if (!itemId || !Types.ObjectId.isValid(itemId)) {
      res.status(HttpStatusCode.BadRequest).json({ message: "itemId inválido." });
      return;
    }
    if (!fileName || !mimeType || !size || size <= 0 || size > MAX_SIZE) {
      res.status(HttpStatusCode.BadRequest).json({
        message: "fileName, mimeType y size (>0, máx 5GB) son requeridos.",
      });
      return;
    }
    if (!mimeType.startsWith("video/") && !mimeType.startsWith("image/")) {
      res.status(HttpStatusCode.BadRequest).json({ message: "Solo videos e imágenes." });
      return;
    }

    const { planning, item } = await buscarPlanningConItem(itemId);
    if (!planning || !item) {
      res.status(HttpStatusCode.NotFound).json({ message: "Item no encontrado." });
      return;
    }

    // Carpeta del cliente (una vez): con enlace publico de solo lectura.
    const workspace = await models.workspaces.findById(planning.workspaceId);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).json({ message: "Workspace no encontrado." });
      return;
    }
    if (!workspace.driveFolderId) {
      const folder = await googleDriveService.ensureFolder(
        driveSharedDriveId(),
        sanitizeDriveName(workspace.name)
      );
      await googleDriveService.setAnyoneReader(folder.id);
      workspace.driveFolderId = folder.id;
      workspace.driveFolderLink = folder.webViewLink;
      await workspace.save();
    }

    // Carpeta del mes (una vez por planificacion; hereda el permiso).
    if (!planning.driveMonthFolderId) {
      const monthFolder = await googleDriveService.ensureFolder(
        workspace.driveFolderId,
        ymDe(item.fechaPublicacion)
      );
      planning.driveMonthFolderId = monthFolder.id;
      planning.driveMonthFolderLink = monthFolder.webViewLink;
      await planning.save();
    }

    const ext = fileName.includes(".") ? fileName.split(".").pop() : "mp4";
    const driveName = `${String(item.numero).padStart(2, "0")} - ${sanitizeDriveName(item.tema)}.${ext}`;
    const origin = req.headers.origin as string | undefined;

    // Re-subida: misma fileId para no duplicar archivos en la carpeta.
    const uploadUrl = item.driveFileId
      ? await googleDriveService.createReplaceSession({
          fileId: item.driveFileId,
          mimeType,
          size,
          name: driveName,
          origin,
        })
      : await googleDriveService.createResumableSession({
          parentId: planning.driveMonthFolderId!,
          name: driveName,
          mimeType,
          size,
          origin,
        });

    res.status(HttpStatusCode.Ok).json({
      uploadUrl,
      replace: !!item.driveFileId,
      fileId: item.driveFileId ?? null,
      driveName,
    });
  } catch (error: any) {
    if (mapDriveError(error, res)) return;
    console.error("createUploadSession error:", error?.response?.data || error);
    next(error);
  }
}

// ── POST /drive/confirm ─────────────────────────────────────────────────────
export async function confirmUpload(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { itemId, fileId } = req.body as { itemId?: string; fileId?: string };
    if (!itemId || !Types.ObjectId.isValid(itemId) || !fileId) {
      res.status(HttpStatusCode.BadRequest).json({ message: "itemId y fileId son requeridos." });
      return;
    }

    const { planning, item } = await buscarPlanningConItem(itemId);
    if (!planning || !item) {
      res.status(HttpStatusCode.NotFound).json({ message: "Item no encontrado." });
      return;
    }

    // Verificar contra Drive: el archivo existe y vive donde debe.
    const file = await googleDriveService.getFile(fileId);
    const esperado = item.driveFileId || null;
    const parentOk =
      (esperado && fileId === esperado) ||
      (file.parents ?? []).includes(planning.driveMonthFolderId || "");
    if (!parentOk) {
      res.status(HttpStatusCode.BadRequest).json({
        message: "El archivo no pertenece a la carpeta del mes de esta planificación.",
      });
      return;
    }

    item.driveFileId = file.id;
    item.driveLink = file.webViewLink;

    // Subir el archivo maestro ES la entrega del editor: estampar responsable
    // (mismo criterio que el sistema de banderas).
    const actorId = req.user?._id;
    if (actorId && (req.user?.internalRole === "editor" || !item.editorPorId)) {
      const user = await models.users.findById(actorId).select("name email").lean();
      item.editorPorId = new Types.ObjectId(actorId);
      item.editorPorNombre = user?.name || user?.email || item.editorPorNombre;
    }

    await planning.save();

    res.status(HttpStatusCode.Ok).json({
      message: "Video maestro registrado en Drive.",
      driveFileId: item.driveFileId,
      driveLink: item.driveLink,
      driveMonthFolderLink: planning.driveMonthFolderLink,
      item,
    });
  } catch (error: any) {
    if (mapDriveError(error, res)) return;
    console.error("confirmUpload error:", error?.response?.data || error);
    next(error);
  }
}
