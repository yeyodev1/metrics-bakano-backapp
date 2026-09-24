import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { verRecorrido, marcarEtapa } from "../controllers/recorrido.controller";

const recorridoRouter = Router();

// El recorrido completo y sus marcas son trabajo del equipo.
recorridoRouter.use(authMiddleware, internalOrSuperadminMiddleware);

recorridoRouter.get("/:workspaceId", verRecorrido);
recorridoRouter.patch("/:workspaceId/:etapa", marcarEtapa);

export default recorridoRouter;
