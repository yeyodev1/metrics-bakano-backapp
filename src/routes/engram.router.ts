import { Router } from "express";
import * as engramController from "../controllers/engram.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";

const engramRouter = Router();

engramRouter.use(authMiddleware);

// GET /api/engram/:workspaceId
engramRouter.get("/:workspaceId", workspaceAccessMiddleware, engramController.getEngram);

// POST /api/engram/:workspaceId/rebuild
// Writing to a brand's memory is an internal decision, not a client one.
engramRouter.post(
  "/:workspaceId/rebuild",
  internalOrSuperadminMiddleware,
  engramController.rebuildEngram
);

// PATCH /api/engram/:workspaceId/:version/activate
engramRouter.patch(
  "/:workspaceId/:version/activate",
  internalOrSuperadminMiddleware,
  engramController.activateEngram
);

export default engramRouter;
