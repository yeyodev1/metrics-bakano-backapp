import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { createVisitLog, getVisitLogs, deleteVisitLog } from "../controllers/visitLog.controller";

const visitLogRouter = Router();

visitLogRouter.use(authMiddleware);
visitLogRouter.use(internalOrSuperadminMiddleware);

// GET  /visit-logs?month=YYYY-MM&producerId=xxx
visitLogRouter.get("/", getVisitLogs);

// POST /visit-logs — producer logs a visit (producerId taken from JWT)
visitLogRouter.post("/", createVisitLog);

// DELETE /visit-logs/:id — only creator or superadmin
visitLogRouter.delete("/:id", deleteVisitLog);

export default visitLogRouter;
