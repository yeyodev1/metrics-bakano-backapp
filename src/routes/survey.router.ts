import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
import { projectManagerOrSuperadminMiddleware } from "../middlewares/projectManagerOrSuperadmin.middleware";
import {
  createSurvey,
  listSurveys,
  getSurvey,
  updateSurvey,
  updateSurveyStatus,
  deleteSurvey,
  sendSurvey,
  getSurveyResults,
  getSurveyForFill,
  submitSurveyResponse,
  getMySurveys,
  listInternalUsers,
  sendSurveyToInternals,
  assignInternalSenders,
  uploadSurveyImage,
} from "../controllers/survey.controller";
import { upload } from "../middlewares/upload.middleware";

const router = Router();

// IMPORTANT: Static paths before /:id to avoid Express treating them as IDs

// ── Client: my surveys ─────────────────────────────────────────
router.get("/me/surveys", authMiddleware, getMySurveys);

// ── Fill (any authenticated user) ─────────────────────────────
router.get("/fill/:token", authMiddleware, getSurveyForFill);
router.post("/fill/:token/submit", authMiddleware, submitSurveyResponse);

// ── Superadmin: internal users for survey sending ──────────────
router.get("/internal-users", authMiddleware, superadminMiddleware, listInternalUsers);

// ── Image upload ────────────────────────────────────────────────
router.post("/upload-image", authMiddleware, upload.single("image"), uploadSurveyImage);

// ── Any authenticated user: survey management ──────────────────
router.post("/", authMiddleware, createSurvey);
router.get("/", authMiddleware, listSurveys);
router.get("/:id", authMiddleware, getSurvey);
router.patch("/:id", authMiddleware, updateSurvey);
router.patch("/:id/status", authMiddleware, updateSurveyStatus);
router.delete("/:id", authMiddleware, deleteSurvey);
router.post("/:id/send", authMiddleware, sendSurvey);
router.post("/:id/send-internal", authMiddleware, superadminMiddleware, sendSurveyToInternals);
router.post("/:id/assign-senders", authMiddleware, superadminMiddleware, assignInternalSenders);

// ── Results: superadmin + project_manager ─────────────────────
router.get("/:id/results", authMiddleware, projectManagerOrSuperadminMiddleware, getSurveyResults);

export default router;
