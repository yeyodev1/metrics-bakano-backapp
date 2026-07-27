import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import {
  createBillingEntry,
  getMonthBilling,
  getDayBilling,
  updateBillingEntry,
  getMyEntryToday,
  getMissingCurrentMonthDates,
  distributeCurrentMonthBilling,
} from "../controllers/billing.controller";

const billingRouter = Router();

// All billing routes require authentication and workspace access
billingRouter.use(authMiddleware);

billingRouter.post("/:workspaceId", workspaceAccessMiddleware, createBillingEntry);
billingRouter.get("/:workspaceId/month", workspaceAccessMiddleware, getMonthBilling);
billingRouter.get("/:workspaceId/day", workspaceAccessMiddleware, getDayBilling);
billingRouter.get("/:workspaceId/my-entry-today", workspaceAccessMiddleware, getMyEntryToday);
billingRouter.get("/:workspaceId/missing-current-month", workspaceAccessMiddleware, getMissingCurrentMonthDates);
billingRouter.post("/:workspaceId/distribute", workspaceAccessMiddleware, distributeCurrentMonthBilling);
billingRouter.put("/:workspaceId/entry/:entryId", workspaceAccessMiddleware, updateBillingEntry);

export default billingRouter;
