import { Router } from "express";
import * as controller from "../controllers/drive.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";

const driveRouter = Router();

// Solo equipo interno: los editores suben, el cliente solo recibe el enlace.
driveRouter.use(authMiddleware, internalOrSuperadminMiddleware);

// POST /api/drive/upload-session  { itemId, fileName, mimeType, size }
driveRouter.post("/upload-session", controller.createUploadSession);

// POST /api/drive/confirm  { itemId, fileId }
driveRouter.post("/confirm", controller.confirmUpload);

export default driveRouter;
