import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { facturacionVisibleMiddleware } from "../controllers/facturacionPrivada.controller";
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

// All billing routes require authentication, workspace access and (if the client made it private) being on its list
billingRouter.use(authMiddleware);

billingRouter.post("/:workspaceId", workspaceAccessMiddleware, facturacionVisibleMiddleware, createBillingEntry);
billingRouter.get("/:workspaceId/month", workspaceAccessMiddleware, facturacionVisibleMiddleware, getMonthBilling);
billingRouter.get("/:workspaceId/day", workspaceAccessMiddleware, facturacionVisibleMiddleware, getDayBilling);
billingRouter.get("/:workspaceId/my-entry-today", workspaceAccessMiddleware, facturacionVisibleMiddleware, getMyEntryToday);
billingRouter.get("/:workspaceId/missing-current-month", workspaceAccessMiddleware, facturacionVisibleMiddleware, getMissingCurrentMonthDates);
billingRouter.post("/:workspaceId/distribute", workspaceAccessMiddleware, facturacionVisibleMiddleware, distributeCurrentMonthBilling);
billingRouter.put("/:workspaceId/entry/:entryId", workspaceAccessMiddleware, facturacionVisibleMiddleware, updateBillingEntry);

export default billingRouter;
