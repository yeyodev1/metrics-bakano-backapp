import { Request, Response, NextFunction } from "express";
import { WorkspaceModel } from "../models/workspace.model";
import cloudinary from "../config/cloudinary";
import { AuthRequest } from "../types/AuthRequest";

export const uploadResource = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;
    const { categoria } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).send({ error: "No file provided" });
    }

    if (!["logo", "linea_grafica", "catalogo", "otro"].includes(categoria)) {
      return res.status(400).send({ error: "Invalid categoria. Use: logo, linea_grafica, catalogo, or otro" });
    }

    const workspace = await WorkspaceModel.findById(workspaceId);
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
    }

    const isPdf = file.mimetype === "application/pdf";
    const cloudinaryResult = await new Promise<{ url: string; public_id: string }>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `resources/${workspaceId}`,
          resource_type: isPdf ? "raw" : "image",
        },
        (error, result) => {
          if (error || !result) return reject(error);
          resolve({ url: result.secure_url, public_id: result.public_id });
        }
      );
      stream.end(file.buffer);
    });

    const resource = {
      nombre: file.originalname,
      url: cloudinaryResult.url,
      publicId: cloudinaryResult.public_id,
      tipo: file.mimetype,
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
    res.status(500).send({ error: "Internal server error" });
  }
};

export const getResources = async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { workspaceId } = req.params;

    const workspace = await WorkspaceModel.findById(workspaceId).select("resources");
    if (!workspace) {
      return res.status(404).send({ error: "Workspace not found" });
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
      return res.status(404).send({ error: "Workspace not found" });
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
