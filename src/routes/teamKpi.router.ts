import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { projectManagerOrSuperadminMiddleware } from "../middlewares/projectManagerOrSuperadmin.middleware";
import { kpiWriteMiddleware } from "../middlewares/kpiWrite.middleware";
import {
  getTeamKpis,
  upsertTeamKpi,
  getMyKpi,
  getKpiEligibleUsers,
} from "../controllers/teamKpi.controller";

const teamKpiRouter = Router();

// All routes require authentication
teamKpiRouter.use(authMiddleware);

// GET /team-kpis?month=YYYY-MM — read all records (superadmin + PM + all internal)
teamKpiRouter.get("/", internalOrSuperadminMiddleware, getTeamKpis);

// GET /team-kpis/users — list users eligible for KPI evaluation
teamKpiRouter.get("/users", internalOrSuperadminMiddleware, getKpiEligibleUsers);

// GET /team-kpis/me?month=YYYY-MM — own record (any internal user)
teamKpiRouter.get("/me", internalOrSuperadminMiddleware, getMyKpi);

// POST /team-kpis — create or update a KPI record (editor, director, superadmin only)
teamKpiRouter.post("/", kpiWriteMiddleware, upsertTeamKpi);

export default teamKpiRouter;
