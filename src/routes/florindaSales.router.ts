import { Router } from "express";
import { getFlorindaMonth, syncFlorindaSales } from "../controllers/florindaSales.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";

const florindaSalesRouter = Router();
florindaSalesRouter.use(authMiddleware);
florindaSalesRouter.get("/:workspaceId/month", workspaceAccessMiddleware, getFlorindaMonth);
florindaSalesRouter.post("/:workspaceId/sync", workspaceAccessMiddleware, syncFlorindaSales);

export default florindaSalesRouter;
