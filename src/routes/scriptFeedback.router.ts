import { Router } from "express";
import * as controller from "../controllers/scriptFeedback.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";

const scriptFeedbackRouter = Router();

scriptFeedbackRouter.use(authMiddleware);

// GET  /api/script-feedback/:workspaceId?videoItemId=&limit=
scriptFeedbackRouter.get("/:workspaceId", workspaceAccessMiddleware, controller.listFeedback);

// POST /api/script-feedback/:workspaceId
scriptFeedbackRouter.post("/:workspaceId", workspaceAccessMiddleware, controller.createFeedback);

// DELETE /api/script-feedback/:workspaceId/:feedbackId
scriptFeedbackRouter.delete(
  "/:workspaceId/:feedbackId",
  workspaceAccessMiddleware,
  controller.deleteFeedback
);

export default scriptFeedbackRouter;
