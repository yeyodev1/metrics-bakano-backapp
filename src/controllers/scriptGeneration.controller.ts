import { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import { geminiService } from "../services/gemini.service";
import type { GeminiFileResult, ScriptContext } from "../services/gemini.service";

const TIPO_REEL_TO_GUION: Record<string, "TOFU" | "MOFU" | "BOFU"> = {
  "Educativo": "TOFU",
  "Creación de valor": "MOFU",
  "Venta": "BOFU",
};

// ── GET /llm-status ───────────────────────────────────────────────────────────
export async function getLLMStatus(
  _req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const status = await geminiService.checkHealth();
    res.status(HttpStatusCode.Ok).send(status);
  } catch (error) {
    next(error);
  }
}

// ── POST /video-planning/:videoItemId/generate-script ──────────────────────
export async function generateScript(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const videoItemId = req.params["videoItemId"] as string;
    const { contextoMes }: { contextoMes?: ScriptContext } = req.body;

    if (!Types.ObjectId.isValid(videoItemId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid videoItemId." });
      return;
    }

    // Find the VideoPlanning document that contains this item
    const planning = await models.videoPlanning.findOne({
      "items._id": new Types.ObjectId(videoItemId),
    });

    if (!planning) {
      res.status(HttpStatusCode.NotFound).send({ message: "Video item not found." });
      return;
    }

    const videoItem = planning.items.find(
      (item: any) => item._id.toString() === videoItemId
    );

    if (!videoItem) {
      res.status(HttpStatusCode.NotFound).send({ message: "Video item not found in planning." });
      return;
    }

    // Get workspace to retrieve brand profile
    const workspace = await models.workspaces
      .findById(planning.workspaceId.toString())
      .lean();

    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    if (!workspace.brandProfile || !(workspace.brandProfile as any).descripcion) {
      res.status(HttpStatusCode.BadRequest).send({
        message:
          "El workspace no tiene perfil de marca configurado. Completa el perfil primero.",
      });
      return;
    }

    const brandProfile = workspace.brandProfile as any;

    // Infer tipoGuion based on video number
    const tipoGuion =
      (videoItem as any).tipoGuion || geminiService.inferTipoGuion(videoItem.numero);

    // Prepare file parts from Gemini-cached files
    const fileUris: GeminiFileResult[] = [];
    if (brandProfile.archivos && brandProfile.archivos.length > 0) {
      for (const archivo of brandProfile.archivos) {
        if (archivo.geminiFileUri && archivo.geminiFileMimeType) {
          fileUris.push({
            uri: archivo.geminiFileUri,
            mimeType: archivo.geminiFileMimeType,
          });
        }
      }
    }

    // Generate script via Gemini
    const guionIA = await geminiService.generateScript({
      brandProfile,
      videoItem: {
        tema: videoItem.tema,
        tipo: videoItem.tipo,
        numero: videoItem.numero,
        tipoGuion: tipoGuion as any,
      },
      contextoMes,
      fileUris: fileUris.length > 0 ? fileUris : undefined,
    });

    // Save result back to videoItem
    const guionIADoc = {
      ...guionIA,
      generadoEn: new Date(),
      contextoMes: contextoMes || undefined,
    };

    await models.videoPlanning.updateOne(
      {
        _id: planning._id,
        "items._id": new Types.ObjectId(videoItemId),
      },
      {
        $set: {
          "items.$.guionIA": guionIADoc,
          "items.$.tipoGuion": tipoGuion,
          // Backwards compat: set guion to gancho
          "items.$.guion": guionIA.gancho,
        },
      }
    );

    // Return updated item
    const updatedPlanning = await models.videoPlanning.findById(planning._id).lean();
    const updatedItem = updatedPlanning?.items.find(
      (item: any) => item._id.toString() === videoItemId
    );

    res.status(HttpStatusCode.Ok).send({
      message: "Script generated successfully.",
      videoItem: updatedItem,
      guionIA: guionIADoc,
    });
  } catch (error: any) {
    console.error("generateScript error:", error);
    if (error instanceof SyntaxError) {
      res.status(HttpStatusCode.InternalServerError).send({
        message: "Gemini returned invalid JSON. Please try again.",
        detail: error.message,
      });
      return;
    }
    next(error);
  }
}

// ── POST /video-planning/generate-script-quick ─────────────────────────────
// Generates a script without needing an existing video item (create mode).
export async function generateScriptQuick(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const {
      workspaceId,
      tema,
      tipo,
      contextoMes,
    }: {
      workspaceId: string;
      tema: string;
      tipo?: string;
      contextoMes?: ScriptContext;
    } = req.body;

    if (!workspaceId || !tema) {
      res.status(HttpStatusCode.BadRequest).send({ message: "workspaceId and tema are required." });
      return;
    }

    const workspace = await models.workspaces.findById(workspaceId).lean();

    if (!workspace) {
      res.status(HttpStatusCode.NotFound).send({ message: "Workspace not found." });
      return;
    }

    if (!workspace.brandProfile || !(workspace.brandProfile as any).descripcion) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "El workspace no tiene perfil de marca configurado. Completa el perfil primero.",
      });
      return;
    }

    const brandProfile = workspace.brandProfile as any;
    const tipoGuion: "TOFU" | "MOFU" | "BOFU" =
      (tipo && TIPO_REEL_TO_GUION[tipo]) || "TOFU";

    const fileUris: GeminiFileResult[] = [];
    if (brandProfile.archivos?.length > 0) {
      for (const archivo of brandProfile.archivos) {
        if (archivo.geminiFileUri && archivo.geminiFileMimeType) {
          fileUris.push({ uri: archivo.geminiFileUri, mimeType: archivo.geminiFileMimeType });
        }
      }
    }

    const guionIA = await geminiService.generateScript({
      brandProfile,
      videoItem: { tema, tipo, numero: 1, tipoGuion },
      contextoMes,
      fileUris: fileUris.length > 0 ? fileUris : undefined,
    });

    res.status(HttpStatusCode.Ok).send({
      message: "Script generated successfully.",
      guionIA: { ...guionIA, generadoEn: new Date(), contextoMes: contextoMes || undefined },
    });
  } catch (error: any) {
    console.error("generateScriptQuick error:", error);
    if (error instanceof SyntaxError) {
      res.status(HttpStatusCode.InternalServerError).send({
        message: "Gemini returned invalid JSON. Please try again.",
        detail: error.message,
      });
      return;
    }
    next(error);
  }
}
