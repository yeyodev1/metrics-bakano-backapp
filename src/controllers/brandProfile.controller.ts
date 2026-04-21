import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import cloudinary from "../config/cloudinary";
import { notificationService } from "../services/notification.service";
import { geminiService } from "../services/gemini.service";
import { resendService } from "../services/resend.service";

// ── Helper: compute brand profile completion 0-100 ─────────────────────────
export function getBrandProfileCompletionScore(bp: any): number {
  if (!bp) return 0;
  const required = [
    bp.descripcion?.trim(),
    bp.tipoNegocio,
    bp.publicoObjetivo?.trim(),
    bp.propuestaValor?.trim(),
    bp.tono?.trim(),
    bp.productosServicios?.trim(),
    bp.problemaResuelto?.trim(),
    bp.trafficDirection,
    bp.trafficLink?.trim(),
  ];
  return Math.round(required.filter(Boolean).length / required.length * 100);
}

// ── GET /:workspaceId/brand-profile ───────────────────────────────────────
export async function getBrandProfile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["workspaceId"] as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(id).lean();
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    const completion = getBrandProfileCompletionScore(workspace.brandProfile);
    res.status(HttpStatusCode.Ok).send({
      brandProfile: workspace.brandProfile || null,
      completion,
      brandProfileInviteSentAt: (workspace as any).brandProfileInviteSentAt || null,
    });
  } catch (error) {
    console.error("getBrandProfile error:", error);
    next(error);
  }
}

// ── PATCH /:workspaceId/brand-profile ─────────────────────────────────────
export async function upsertBrandProfile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["workspaceId"] as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(id);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    const prevScore = getBrandProfileCompletionScore(workspace.brandProfile);

    const {
      descripcion, tipoNegocio, vertical, trafficDirection, trafficLink,
      publicoObjetivo, propuestaValor, tono, productosServicios, problemaResuelto,
    } = req.body;

    if (!workspace.brandProfile) {
      (workspace as any).brandProfile = { descripcion: "", vertical: "", trafficLink: "", archivos: [] };
    }

    if (descripcion !== undefined) (workspace.brandProfile as any).descripcion = descripcion;
    if (tipoNegocio !== undefined) (workspace.brandProfile as any).tipoNegocio = tipoNegocio;
    if (vertical !== undefined) (workspace.brandProfile as any).vertical = vertical;
    if (trafficDirection !== undefined) (workspace.brandProfile as any).trafficDirection = trafficDirection;
    if (trafficLink !== undefined) (workspace.brandProfile as any).trafficLink = trafficLink;
    if (publicoObjetivo !== undefined) (workspace.brandProfile as any).publicoObjetivo = publicoObjetivo;
    if (propuestaValor !== undefined) (workspace.brandProfile as any).propuestaValor = propuestaValor;
    if (tono !== undefined) (workspace.brandProfile as any).tono = tono;
    if (productosServicios !== undefined) (workspace.brandProfile as any).productosServicios = productosServicios;
    if (problemaResuelto !== undefined) (workspace.brandProfile as any).problemaResuelto = problemaResuelto;
    (workspace.brandProfile as any).updatedAt = new Date();

    await workspace.save();

    const newScore = getBrandProfileCompletionScore(workspace.brandProfile);

    // When profile first reaches 100%, notify entire internal team
    if (prevScore < 100 && newScore === 100) {
      await _notifyOnCompletion(id, workspace.name).catch(() => {});
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Brand profile updated.",
      brandProfile: workspace.brandProfile,
      completion: newScore,
    });
  } catch (error) {
    console.error("upsertBrandProfile error:", error);
    next(error);
  }
}

// ── POST /:workspaceId/brand-profile/files ────────────────────────────────
export async function uploadBrandProfileFile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["workspaceId"] as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    if (!req.file) {
      res.status(HttpStatusCode.BadRequest).send({ message: "No file uploaded." });
      return;
    }

    const workspace = await models.workspaces.findById(id);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    const { originalname, buffer, mimetype } = req.file;
    const isPdf = mimetype === "application/pdf";
    const folder = `brand-profiles/${id}`;

    const cloudinaryResult = await new Promise<{ url: string; public_id: string }>(
      (resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder, resource_type: isPdf ? "raw" : "image" },
          (error, result) => {
            if (error || !result) return reject(error || new Error("Cloudinary upload failed"));
            resolve({ url: result.secure_url, public_id: result.public_id });
          }
        );
        stream.end(buffer);
      }
    );

    let geminiFileUri: string | undefined;
    let geminiFileMimeType: string | undefined;
    try {
      const geminiResult = await geminiService.uploadFileBuffer(buffer, mimetype, originalname);
      geminiFileUri = geminiResult.uri;
      geminiFileMimeType = geminiResult.mimeType;
    } catch (geminiError) {
      console.warn("Gemini file upload failed (non-fatal):", geminiError);
    }

    const fileEntry = {
      nombre: originalname,
      url: cloudinaryResult.url,
      publicId: cloudinaryResult.public_id,
      tipo: isPdf ? "pdf" : "image",
      geminiFileUri,
      geminiFileMimeType,
    };

    if (!workspace.brandProfile) {
      (workspace as any).brandProfile = { descripcion: "", vertical: "", trafficLink: "", archivos: [] };
    }

    (workspace.brandProfile as any).archivos.push(fileEntry);
    (workspace.brandProfile as any).updatedAt = new Date();
    await workspace.save();

    res.status(HttpStatusCode.Created).send({
      message: "File uploaded successfully.",
      file: fileEntry,
      brandProfile: workspace.brandProfile,
    });
  } catch (error) {
    console.error("uploadBrandProfileFile error:", error);
    next(error);
  }
}

// ── DELETE /:workspaceId/brand-profile/files/:publicId ────────────────────
export async function deleteBrandProfileFile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["workspaceId"] as string;
    const publicId = req.params["publicId"] as string;

    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(id);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    if (!workspace.brandProfile) {
      res.status(HttpStatusCode.NotFound).send({ message: "Brand profile not found." });
      return;
    }

    const decodedPublicId = decodeURIComponent(publicId);
    const archivos = (workspace.brandProfile as any).archivos as any[];
    const fileEntry = archivos.find((f: any) => f.publicId === decodedPublicId);

    if (!fileEntry) {
      res.status(HttpStatusCode.NotFound).send({ message: "File not found." });
      return;
    }

    const isPdf = fileEntry.tipo === "pdf";
    try {
      await cloudinary.uploader.destroy(decodedPublicId, { resource_type: isPdf ? "raw" : "image" });
    } catch (cloudinaryError) {
      console.warn("Cloudinary deletion failed (non-fatal):", cloudinaryError);
    }

    (workspace.brandProfile as any).archivos = archivos.filter((f: any) => f.publicId !== decodedPublicId);
    (workspace.brandProfile as any).updatedAt = new Date();
    await workspace.save();

    res.status(HttpStatusCode.Ok).send({
      message: "File deleted successfully.",
      brandProfile: workspace.brandProfile,
    });
  } catch (error) {
    console.error("deleteBrandProfileFile error:", error);
    next(error);
  }
}

// ── POST /:workspaceId/send-brand-profile-invite ──────────────────────────
export async function sendBrandProfileInviteController(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    if (!Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(workspaceId);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    const appUrl = process.env.APP_URL || 'https://metrics.bakano.ec';
    const brandProfileUrl = `${appUrl}/app/workspaces/${workspaceId}/brand-profile`;
    const score = getBrandProfileCompletionScore(workspace.brandProfile);

    // Find external client users for this workspace
    const clients = await models.users.find({
      isInternal: false,
      role: { $ne: 'superadmin' },
      'workspaces.workspaceId': new Types.ObjectId(workspaceId),
      isActive: true,
    }).lean();

    if (clients.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "No client users found for this workspace." });
      return;
    }

    // Send email to each client
    const emailPromises = clients.map(client =>
      resendService.sendBrandProfileInvite({
        to: client.email,
        recipientName: client.name,
        workspaceName: workspace.name,
        brandProfileUrl,
        completionScore: score,
      }).catch(err => console.error('[brand-profile-invite] email error:', err?.message))
    );
    await Promise.allSettled(emailPromises);

    // Mark invite as sent on workspace
    (workspace as any).brandProfileInviteSentAt = new Date();
    await workspace.save();

    res.status(HttpStatusCode.Ok).send({
      message: `Invitación enviada a ${clients.length} cliente(s).`,
      sentTo: clients.map(c => c.email),
    });
  } catch (error) {
    console.error("sendBrandProfileInviteController error:", error);
    next(error);
  }
}

// ── Exported helper for cron ───────────────────────────────────────────────
export async function notifyBrandProfileMissing(workspaceId: string, workspaceName: string) {
  await _notifyAllStakeholders(workspaceId, workspaceName, 0);
}

// ── Internal: notify all stakeholders when profile is incomplete ──────────
export async function _notifyAllStakeholders(
  workspaceId: string,
  workspaceName: string,
  score: number
) {
  try {
    const wsId = new Types.ObjectId(workspaceId);

    // 1. Superadmins
    const superadmins = await models.users.find({ role: 'superadmin', isActive: true }).lean();
    for (const admin of superadmins) {
      notificationService.create(
        (admin._id as Types.ObjectId).toString(),
        'brand_profile_missing',
        'Perfil de marca incompleto',
        `${workspaceName} tiene su perfil al ${score}%. El cliente aún no lo ha completado.`,
        { workspaceId: wsId }
      ).catch(() => {});
    }

    // 2. Project managers assigned to this workspace
    const pms = await models.users.find({
      isInternal: true,
      internalRole: 'project_manager',
      'workspaces.workspaceId': wsId,
      isActive: true,
    }).lean();
    for (const pm of pms) {
      notificationService.create(
        (pm._id as Types.ObjectId).toString(),
        'brand_profile_missing',
        'Perfil de marca incompleto',
        `${workspaceName} tiene su perfil al ${score}%. El cliente aún no lo ha completado.`,
        { workspaceId: wsId }
      ).catch(() => {});
    }

    // 3. External clients of this workspace
    const clients = await models.users.find({
      isInternal: false,
      role: { $ne: 'superadmin' },
      'workspaces.workspaceId': wsId,
      isActive: true,
    }).lean();
    for (const client of clients) {
      notificationService.create(
        (client._id as Types.ObjectId).toString(),
        'brand_profile_missing',
        'Tu perfil de marca está incompleto',
        `Tu perfil está al ${score}%. Complétalo para que creemos contenido que venda para tu negocio.`,
        { workspaceId: wsId }
      ).catch(() => {});
    }
  } catch (error) {
    console.error("_notifyAllStakeholders error:", error);
  }
}

// ── Internal: notify on first completion ──────────────────────────────────
async function _notifyOnCompletion(workspaceId: string, workspaceName: string) {
  const wsId = new Types.ObjectId(workspaceId);

  const internalUsers = await models.users.find({
    isInternal: true,
    'workspaces.workspaceId': wsId,
    isActive: true,
  }).lean();

  for (const user of internalUsers) {
    notificationService.create(
      (user._id as Types.ObjectId).toString(),
      'brand_profile_missing',
      'Perfil de marca completado',
      `El cliente de ${workspaceName} completó su perfil de marca al 100%. Ya pueden generarse guiones con IA.`,
      { workspaceId: wsId }
    ).catch(() => {});
  }
}
