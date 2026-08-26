import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import cloudinary from "../config/cloudinary";
import { geminiService } from "../services/gemini.service";
import type { IScriptRef } from "../models/videoPlanning.model";

/** Tope por video: lo que cabe en un prompt sin volverlo ruido. */
const MAX_REFS_POR_ITEM = 6;

/**
 * Localiza el item dentro de su planificación. Los items son subdocumentos, así
 * que la única entrada es la planificación que los contiene.
 */
async function findItem(videoItemId: string) {
  const planning = await models.videoPlanning.findOne({
    "items._id": new Types.ObjectId(videoItemId),
  });
  if (!planning) return null;

  const item = planning.items.find((i: any) => i._id.toString() === videoItemId);
  if (!item) return null;

  return { planning, item: item as any };
}

// ── POST /items/:itemId/script-refs ───────────────────────────────────────────
/**
 * Adjunta una imagen o un PDF como referencia del guión.
 *
 * Va a dos lados a propósito: Cloudinary para poder verla en la app, y la Files
 * API de Gemini para que el modelo la lea al escribir. Si Gemini falla, la
 * referencia igual se guarda — se ve en la app aunque no alimente al guión.
 */
export async function uploadScriptRef(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const itemId = req.params["itemId"] as string;
    if (!Types.ObjectId.isValid(itemId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid itemId." });
      return;
    }

    if (!req.file) {
      res.status(HttpStatusCode.BadRequest).send({ message: "No se envió ningún archivo." });
      return;
    }

    const found = await findItem(itemId);
    if (!found) {
      res.status(HttpStatusCode.NotFound).send({ message: "Video item not found." });
      return;
    }

    const { planning, item } = found;

    if (!item.scriptRefs) item.scriptRefs = [];
    if (item.scriptRefs.length >= MAX_REFS_POR_ITEM) {
      res.status(HttpStatusCode.BadRequest).send({
        message: `Máximo ${MAX_REFS_POR_ITEM} referencias por video. Borra alguna para subir otra.`,
      });
      return;
    }

    const { originalname, buffer, mimetype } = req.file;
    const isPdf = mimetype === "application/pdf";
    const folder = `script-refs/${planning.workspaceId.toString()}/${itemId}`;

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
      console.warn("Gemini script-ref upload failed (non-fatal):", geminiError);
    }

    const ref: IScriptRef = {
      nombre: originalname,
      url: cloudinaryResult.url,
      publicId: cloudinaryResult.public_id,
      tipo: isPdf ? "pdf" : "image",
      geminiFileUri,
      geminiFileMimeType,
      subidoEn: new Date(),
    };

    item.scriptRefs.push(ref);
    await planning.save();

    const guardada = item.scriptRefs[item.scriptRefs.length - 1];

    res.status(HttpStatusCode.Created).send({
      message: "Referencia subida.",
      ref: guardada,
      // Sin URI de Gemini la referencia se ve pero no alimenta al guión: el
      // frontend lo avisa en vez de dejar creer que la IA la está leyendo.
      leePorIA: !!geminiFileUri,
    });
  } catch (error) {
    console.error("uploadScriptRef error:", error);
    next(error);
  }
}

// ── DELETE /items/:itemId/script-refs/:refId ──────────────────────────────────
export async function deleteScriptRef(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const itemId = req.params["itemId"] as string;
    const refId = req.params["refId"] as string;

    if (!Types.ObjectId.isValid(itemId) || !Types.ObjectId.isValid(refId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid id." });
      return;
    }

    const found = await findItem(itemId);
    if (!found) {
      res.status(HttpStatusCode.NotFound).send({ message: "Video item not found." });
      return;
    }

    const { planning, item } = found;
    const ref = (item.scriptRefs ?? []).find((r: any) => r._id?.toString() === refId);

    if (!ref) {
      res.status(HttpStatusCode.NotFound).send({ message: "Referencia no encontrada." });
      return;
    }

    try {
      await cloudinary.uploader.destroy(ref.publicId, {
        resource_type: ref.tipo === "pdf" ? "raw" : "image",
      });
    } catch (cloudinaryError) {
      console.warn("Cloudinary deletion failed (non-fatal):", cloudinaryError);
    }

    item.scriptRefs = (item.scriptRefs ?? []).filter(
      (r: any) => r._id?.toString() !== refId
    );
    await planning.save();

    res.status(HttpStatusCode.Ok).send({ message: "Referencia eliminada." });
  } catch (error) {
    console.error("deleteScriptRef error:", error);
    next(error);
  }
}
