import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import {
  createOrUpdate,
  getMyMeetings,
  getByWorkspace,
  updateMeeting,
  completeMeeting,
} from "../controllers/clientMeeting.controller";

const router = Router();

router.use(authMiddleware);
router.use(internalOrSuperadminMiddleware);

router.post("/", createOrUpdate);
router.get("/my", getMyMeetings);
router.get("/workspace/:workspaceId", getByWorkspace);
router.patch("/:id", updateMeeting);
router.patch("/:id/complete", completeMeeting);

export default router;
