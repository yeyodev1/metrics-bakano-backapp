import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import {
  getMyNotifications,
  getUnreadCount,
  markRead,
  markAllRead,
  deleteNotification,
} from "../controllers/notification.controller";

const router = Router();

router.use(authMiddleware);

router.get("/", getMyNotifications);
router.get("/unread-count", getUnreadCount);
router.patch("/read-all", markAllRead);
router.patch("/:id/read", markRead);
router.delete("/:id", deleteNotification);

export default router;
