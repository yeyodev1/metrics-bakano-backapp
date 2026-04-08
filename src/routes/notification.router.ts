import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import {
  getMyNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
  sendBillingReminder,
} from "../controllers/notification.controller";

const router = Router();

router.use(authMiddleware);

router.get("/", getMyNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllRead);
router.patch("/:id/read", markRead);
router.delete("/:id", deleteNotification);

// Internal/superadmin — send billing reminder to workspace collaborators
router.post("/billing-reminder/:workspaceId", internalOrSuperadminMiddleware, sendBillingReminder);

export default router;
