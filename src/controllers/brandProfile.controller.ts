import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import cloudinary from "../config/cloudinary";
import { notificationService } from "../services/notification.service";
import { geminiService } from "../services/gemini.service";

// ── GET /:id/brand-profile ─────────────────────────────────────────────────
export async function getBrandProfile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["id"] as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(id).lean();
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    res.status(HttpStatusCode.Ok).send({ brandProfile: workspace.brandProfile || null });
  } catch (error) {
    console.error("getBrandProfile error:", error);
    next(error);
  }
}

// ── PATCH /:id/brand-profile ───────────────────────────────────────────────
export async function upsertBrandProfile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["id"] as string;
    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid workspace id." });
      return;
    }

    const workspace = await models.workspaces.findById(id);
    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    const hadBrandProfile = !!(
      workspace.brandProfile && workspace.brandProfile.descripcion
    );

    const {
      descripcion, tipoNegocio, vertical, trafficDirection, trafficLink,
      publicoObjetivo, propuestaValor, tono, productosServicios, problemaResuelto,
    } = req.body;

    // Initialize brandProfile if not exists
    if (!workspace.brandProfile) {
      (workspace as any).brandProfile = {
        descripcion: "",
        vertical: "",
        trafficLink: "",
        archivos: [],
      };
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

    // If brand profile was missing before and now has content, notify internal CM/content managers
    const nowHasBrandProfile = !!(
      workspace.brandProfile && workspace.brandProfile.descripcion
    );
    if (!hadBrandProfile && nowHasBrandProfile) {
      await _notifyInternalRoles(id, workspace.name, "brand_profile_missing");
    }

    res.status(HttpStatusCode.Ok).send({
      message: "Brand profile updated.",
      brandProfile: workspace.brandProfile,
    });
  } catch (error) {
    console.error("upsertBrandProfile error:", error);
    next(error);
  }
}

// ── POST /:id/brand-profile/files ──────────────────────────────────────────
export async function uploadBrandProfileFile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["id"] as string;
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

    // Upload to Cloudinary
    const cloudinaryResult = await new Promise<{ url: string; public_id: string }>(
      (resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder,
            resource_type: isPdf ? "raw" : "image",
          },
          (error, result) => {
            if (error || !result) return reject(error || new Error("Cloudinary upload failed"));
            resolve({ url: result.secure_url, public_id: result.public_id });
          }
        );
        stream.end(buffer);
      }
    );

    // Upload to Gemini Files API and cache URI
    let geminiFileUri: string | undefined;
    let geminiFileMimeType: string | undefined;
    try {
      const geminiResult = await geminiService.uploadFileBuffer(
        buffer,
        mimetype,
        originalname
      );
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

    // Initialize brandProfile if needed
    if (!workspace.brandProfile) {
      (workspace as any).brandProfile = {
        descripcion: "",
        vertical: "",
        trafficLink: "",
        archivos: [],
      };
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

// ── DELETE /:id/brand-profile/files/:publicId ──────────────────────────────
export async function deleteBrandProfileFile(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params["id"] as string;
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

    // Delete from Cloudinary
    const isPdf = fileEntry.tipo === "pdf";
    try {
      await cloudinary.uploader.destroy(decodedPublicId, {
        resource_type: isPdf ? "raw" : "image",
      });
    } catch (cloudinaryError) {
      console.warn("Cloudinary deletion failed (non-fatal):", cloudinaryError);
    }

    // Remove from archivos array
    (workspace.brandProfile as any).archivos = archivos.filter(
      (f: any) => f.publicId !== decodedPublicId
    );
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

// ── Helper: notify internal CM/content managers ────────────────────────────
export async function notifyBrandProfileMissing(workspaceId: string, workspaceName: string) {
  await _notifyInternalRoles(workspaceId, workspaceName, "brand_profile_missing");
}

async function _notifyInternalRoles(
  workspaceId: string,
  workspaceName: string,
  type: "brand_profile_missing"
) {
  try {
    const wsId = new Types.ObjectId(workspaceId);
    const internalUsers = await models.users.find({
      isInternal: true,
      internalRole: { $in: ["community_manager", "content_manager"] },
      "workspaces.workspaceId": wsId,
    });

    for (const user of internalUsers) {
      await notificationService.create(
        (user._id as Types.ObjectId).toString(),
        type,
        "Perfil de marca pendiente",
        `El workspace ${workspaceName} no tiene configurado su perfil de marca. Por favor completa la información para poder generar guiones con IA.`,
        { workspaceId: wsId }
      );
    }
  } catch (error) {
    console.error("_notifyInternalRoles error:", error);
  }
}
