import { Router } from "express";
import { financeKeyMiddleware } from "../middlewares/financeKey.middleware";
import {
  createFinanceWorkspace,
  listFinanceWorkspaces,
  getFinanceWorkspace,
  setFinanceWorkspaceActive,
  financeHealth,
} from "../controllers/financeIntegration.controller";

const financeIntegrationRouter = Router();

financeIntegrationRouter.use(financeKeyMiddleware);

financeIntegrationRouter.get("/health", financeHealth);
financeIntegrationRouter.get("/workspaces", listFinanceWorkspaces);
financeIntegrationRouter.post("/workspaces", createFinanceWorkspace);
financeIntegrationRouter.get("/workspaces/:workspaceId", getFinanceWorkspace);
financeIntegrationRouter.patch("/workspaces/:workspaceId/active", setFinanceWorkspaceActive);

export default financeIntegrationRouter;
