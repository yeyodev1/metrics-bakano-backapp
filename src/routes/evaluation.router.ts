import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { createEvaluation, getTeamRanking } from "../controllers/evaluation.controller";

const evaluationRouter = Router();

evaluationRouter.use(authMiddleware);

evaluationRouter.post("/", createEvaluation);
evaluationRouter.get("/workspace/:workspaceId/ranking", workspaceAccessMiddleware, getTeamRanking);

export default evaluationRouter;
