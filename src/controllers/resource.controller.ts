import { Request, Response, NextFunction } from "express";
import { WorkspaceModel } from "../models/workspace.model";
import cloudinary from "../config/cloudinary";
import { AuthRequest } from "../types/AuthRequest";
import { esTipoDeLogo, nombrePng, subirLogoComoPng } from "../services/logoPng.service";

export const uploadResource = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;
    const { categoria } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).send({ message: "No llegó ningún archivo.", error: "No file provided" });
    }

    if (!["logo", "linea_grafica", "catalogo", "otro"].includes(categoria)) {
      const invalida = "Categoría inválida. Usa: logo, linea_grafica, catalogo u otro.";
      return res.status(400).send({ message: invalida, error: invalida });
    }

    // El logo se acepta en cualquier imagen o PDF y se guarda convertido a
    // PNG (logoPng.service): exigir exportarlo era donde se trababa el cliente.
    if (categoria === "logo" && !esTipoDeLogo(file.mimetype)) {
      const formato = "Ese formato no se puede usar como logo. Súbelo como imagen (PNG, JPG, WEBP) o PDF y lo convertimos a PNG.";
      return res.status(400).send({ message: formato, error: formato });
    }

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ message: "Entorno no encontrado.", error: "Workspace not found" });
    }

    const esLogo = categoria === "logo";
    const isPdf = file.mimetype === "application/pdf";
    const cloudinaryResult = esLogo
      ? await subirLogoComoPng(file.buffer, `resources/${workspaceId}`)
      : await new Promise<{ url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `resources/${workspaceId}`,
          resource_type: isPdf ? "raw" : "image",
          // En raw la extension SOLO existe si va dentro del public_id. Sin
          // ella Cloudinary sirve application/octet-stream y el navegador no
          // puede visualizar el PDF (el iframe queda en blanco).
          ...(isPdf ? { public_id: `${categoria}-${Date.now()}.pdf` } : {}),
        },
        (error, result) => {
          if (error || !result) return reject(error);
          resolve({ url: result.secure_url, public_id: result.public_id });
        }
      );
      stream.end(file.buffer);
    });

    const resource = {
      nombre: esLogo ? nombrePng(file.originalname) : file.originalname,
      url: cloudinaryResult.url,
      publicId: cloudinaryResult.public_id,
      tipo: esLogo ? "image/png" : file.mimetype,
      categoria,
      uploadedBy: req.user!._id,
      createdAt: new Date(),
    };

    if (!workspace.resources) {
      workspace.resources = [];
    }
    workspace.resources.push(resource as any);
    await workspace.save();

    const saved = workspace.resources[workspace.resources.length - 1];
    res.status(201).send({ message: "Resource uploaded", resource: saved });
  } catch (error) {
    console.error("Error in uploadResource:", error);
    // Validación de Mongo (categoría fuera del enum, campo faltante): es del
    // pedido, no del servidor, y el cliente merece saber qué pasó.
    if ((error as any)?.name === "ValidationError") {
      const detalle = (error as any).message || "El archivo no se pudo guardar.";
      return res.status(400).send({ message: detalle, error: detalle });
    }
    res.status(500).send({ message: "No pude guardar el archivo. Inténtalo de nuevo.", error: "Internal server error" });
  }
};

export const getResources = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId).select("resources");
    if (!workspace) {
      return res.status(404).send({ message: "Entorno no encontrado.", error: "Workspace not found" });
    }

    res.status(200).send({ resources: workspace.resources || [] });
  } catch (error) {
    console.error("Error in getResources:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};

export const deleteResource = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId, resourceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ message: "Entorno no encontrado.", error: "Workspace not found" });
    }

    const resource = (workspace.resources || []).find(
      (r: any) => r._id.toString() === resourceId
    );
    if (!resource) {
      return res.status(404).send({ error: "Resource not found" });
    }

    const isPdf = resource.tipo === "application/pdf";
    await cloudinary.uploader.destroy(resource.publicId, {
      resource_type: isPdf ? "raw" : "image",
    });

    workspace.resources = (workspace.resources as any[]).filter(
      (r: any) => r._id.toString() !== resourceId
    );
    await workspace.save();

    res.status(200).send({ message: "Resource deleted" });
  } catch (error) {
    console.error("Error in deleteResource:", error);
    res.status(500).send({ error: "Internal server error" });
  }
};
