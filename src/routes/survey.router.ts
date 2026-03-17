import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware";
import { superadminMiddleware } from "../middlewares/superadmin.middleware";
import { internalOrSuperadminMiddleware } from "../middlewares/internalOrSuperadmin.middleware";
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
} from "../controllers/survey.controller";

const router = Router();

// IMPORTANT: Static paths before /:id to avoid Express treating them as IDs

// ── Client: my surveys ─────────────────────────────────────────
router.get("/me/surveys", authMiddleware, getMySurveys);

// ── Fill (any authenticated user) ─────────────────────────────
router.get("/fill/:token", authMiddleware, getSurveyForFill);
router.post("/fill/:token/submit", authMiddleware, submitSurveyResponse);

// ── Superadmin: internal users for survey sending ──────────────
router.get("/internal-users", authMiddleware, superadminMiddleware, listInternalUsers);

// ── Internal / Superadmin: survey management ───────────────────
router.post("/", authMiddleware, internalOrSuperadminMiddleware, createSurvey);
router.get("/", authMiddleware, internalOrSuperadminMiddleware, listSurveys);
router.get("/:id", authMiddleware, internalOrSuperadminMiddleware, getSurvey);
router.patch("/:id", authMiddleware, internalOrSuperadminMiddleware, updateSurvey);
router.patch("/:id/status", authMiddleware, internalOrSuperadminMiddleware, updateSurveyStatus);
router.delete("/:id", authMiddleware, internalOrSuperadminMiddleware, deleteSurvey);
router.post("/:id/send", authMiddleware, internalOrSuperadminMiddleware, sendSurvey);
router.post("/:id/send-internal", authMiddleware, superadminMiddleware, sendSurveyToInternals);
router.post("/:id/assign-senders", authMiddleware, superadminMiddleware, assignInternalSenders);

// ── Results: superadmin only ───────────────────────────────────
router.get("/:id/results", authMiddleware, superadminMiddleware, getSurveyResults);

export default router;
