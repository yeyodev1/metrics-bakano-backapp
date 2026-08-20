import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { workspaceAccessMiddleware } from "../middlewares/workspaceAccess.middleware";
import { uploadDocument } from "../middlewares/upload.middleware";
import {
  createFinanceCardUpdate,
  createFinanceCheckout,
  getFinanceBilling,
  submitFinanceReceipt,
} from "../controllers/billingPortal.controller";

/**
 * Facturación de Bakano para el cliente (proxy hacia finanzas). El cliente solo
 * ve su propio workspace: authMiddleware + workspaceAccessMiddleware, igual que
 * el resto de rutas por workspace.
 */
const billingPortalRouter = Router();

billingPortalRouter.use(authMiddleware);

billingPortalRouter.get("/:workspaceId/finance-billing", workspaceAccessMiddleware, getFinanceBilling);
billingPortalRouter.post(
  "/:workspaceId/finance-billing/checkout",
  workspaceAccessMiddleware,
  createFinanceCheckout
);
billingPortalRouter.post(
  "/:workspaceId/finance-billing/card-update-session",
  workspaceAccessMiddleware,
  createFinanceCardUpdate
);
billingPortalRouter.post(
  "/:workspaceId/finance-billing/submissions",
  workspaceAccessMiddleware,
  uploadDocument.single("receipt"),
  submitFinanceReceipt
);

export default billingPortalRouter;
