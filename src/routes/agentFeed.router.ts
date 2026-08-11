import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { getWorkspaceAgentFeed } from "../controllers/agentFeed.controller";

const agentFeedRouter = Router();

agentFeedRouter.get(
  "/workspaces/:workspaceId",
  authMiddleware,
  workspaceAccessMiddleware,
  getWorkspaceAgentFeed
);

export default agentFeedRouter;
