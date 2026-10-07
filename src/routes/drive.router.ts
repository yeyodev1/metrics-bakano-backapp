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

// Subida masiva por planificacion: el editor suelta todos los videos y despues
// los conecta con sus guiones, sin entrar a Drive.
driveRouter.get("/planificaciones", controller.listarPlanificaciones);
driveRouter.post("/planificaciones/:planningId/sesion", controller.sesionPlanificacion);
driveRouter.post("/planificaciones/:planningId/sugerencias", controller.sugerirConexiones);
driveRouter.post("/planificaciones/:planningId/conectar", controller.conectarVideos);

export default driveRouter;
