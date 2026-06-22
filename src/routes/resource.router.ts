import { Router } from "express";
import { uploadResource, getResources, deleteResource } from "../controllers/resource.controller";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { uploadDocument } from "../middlewares/upload.middleware";

export const resourceRouter = Router();

resourceRouter.get("/:workspaceId/resources", workspaceAccessMiddleware, getResources);
resourceRouter.post("/:workspaceId/resources", workspaceAccessMiddleware, uploadDocument.single("file"), uploadResource);
resourceRouter.delete("/:workspaceId/resources/:resourceId", workspaceAccessMiddleware, deleteResource);
