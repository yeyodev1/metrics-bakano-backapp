import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { surveyService } from "../services/survey.service";

// ── Helpers ───────────────────────────────────────────────────

function isSuperadmin(req: AuthRequest): boolean {
  return req.user?.role === "superadmin";
}

function isPrivilegedInternal(req: AuthRequest): boolean {
  return (
    req.user?.isInternal === true &&
    ["project_manager", "content_manager"].includes(req.user?.internalRole ?? "")
  );
}

function userId(req: AuthRequest): string {
  return req.user!._id;
}

// ── Surveys CRUD ──────────────────────────────────────────────

export async function createSurvey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { title, description, questions } = req.body;

    if (!title || typeof title !== "string" || !title.trim()) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Survey title is required." });
      return;
    }
    if (!questions || !Array.isArray(questions) || questions.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "At least one question is required." });
      return;
    }

    const survey = await surveyService.createSurvey({ title, description, questions, createdBy: userId(req) });
    res.status(HttpStatusCode.Created).send({ message: "Survey created successfully.", survey });
  } catch (error) {
    console.error("createSurvey error:", error);
    next(error);
  }
}

export async function listSurveys(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveys = await surveyService.listSurveys({
      userId: userId(req),
      isSuperadmin: isSuperadmin(req) || isPrivilegedInternal(req),
    });
    res.status(HttpStatusCode.Ok).send({ message: "Surveys retrieved successfully.", surveys });
  } catch (error) {
    console.error("listSurveys error:", error);
    next(error);
  }
}

export async function getSurvey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const survey = await surveyService.getSurveyById(surveyId, userId(req), isSuperadmin(req));
    res.status(HttpStatusCode.Ok).send({ message: "Survey retrieved successfully.", survey });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "Access denied." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    console.error("getSurvey error:", error);
    next(error);
  }
}

export async function updateSurvey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const { title, description, questions } = req.body;
    const survey = await surveyService.updateSurvey(surveyId, { title, description, questions }, userId(req), isSuperadmin(req));
    res.status(HttpStatusCode.Ok).send({ message: "Survey updated successfully.", survey });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "Access denied." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    if (error.message === "NOT_DRAFT") {
      res.status(HttpStatusCode.Conflict).send({ message: "Survey can only be modified while in draft status." });
      return;
    }
    console.error("updateSurvey error:", error);
    next(error);
  }
}

export async function updateSurveyStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const { status } = req.body;

    if (!["draft", "active", "closed"].includes(status)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Status must be 'draft', 'active', or 'closed'." });
      return;
    }

    const survey = await surveyService.updateStatus(surveyId, status, userId(req), isSuperadmin(req));
    res.status(HttpStatusCode.Ok).send({ message: "Survey status updated.", survey });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "Access denied." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    console.error("updateSurveyStatus error:", error);
    next(error);
  }
}

export async function deleteSurvey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    await surveyService.deleteSurvey(surveyId, userId(req), isSuperadmin(req));
    res.status(HttpStatusCode.Ok).send({ message: "Survey deleted successfully." });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "Access denied." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    if (error.message === "NOT_DRAFT") {
      res.status(HttpStatusCode.Conflict).send({ message: "Survey can only be deleted while in draft status." });
      return;
    }
    console.error("deleteSurvey error:", error);
    next(error);
  }
}

// ── Send ──────────────────────────────────────────────────────

export async function sendSurvey(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const { workspaceId, userIds, message } = req.body;

    if (!workspaceId) {
      res.status(HttpStatusCode.BadRequest).send({ message: "workspaceId is required." });
      return;
    }
    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "At least one user ID is required." });
      return;
    }

    const result = await surveyService.sendSurvey({ surveyId, workspaceId, userIds, message, sentBy: userId(req) });
    res.status(HttpStatusCode.Ok).send({ message: `Survey sent to ${result.sent} user(s). ${result.skipped} skipped.`, ...result });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    if (error.message === "SURVEY_NOT_ACTIVE") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Survey must be active to send." });
      return;
    }
    console.error("sendSurvey error:", error);
    next(error);
  }
}

// ── Assign internal senders ────────────────────────────────────

export async function assignInternalSenders(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const { userIds } = req.body;

    if (!Array.isArray(userIds)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "userIds must be an array." });
      return;
    }

    const survey = await surveyService.assignInternalSenders(surveyId, userIds);
    res.status(HttpStatusCode.Ok).send({ message: "Responsible senders assigned.", survey });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    console.error("assignInternalSenders error:", error);
    next(error);
  }
}

// ── List internal users ────────────────────────────────────────

export async function listInternalUsers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const users = await surveyService.listInternalUsers();
    res.status(HttpStatusCode.Ok).send({ message: "Internal users retrieved.", users });
  } catch (error) {
    console.error("listInternalUsers error:", error);
    next(error);
  }
}

// ── Send survey to internals ───────────────────────────────────

export async function sendSurveyToInternals(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const { userIds, message } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      res.status(HttpStatusCode.BadRequest).send({ message: "At least one user ID is required." });
      return;
    }

    const result = await surveyService.sendSurveyToInternals({ surveyId, userIds, message, sentBy: userId(req) });
    res.status(HttpStatusCode.Ok).send({ message: `Survey sent to ${result.sent} internal user(s). ${result.skipped} skipped.`, ...result });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    if (error.message === "SURVEY_NOT_ACTIVE") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Survey must be active to send." });
      return;
    }
    console.error("sendSurveyToInternals error:", error);
    next(error);
  }
}

// ── Results ───────────────────────────────────────────────────

export async function getSurveyResults(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const surveyId = req.params["id"] as string;
    const data = await surveyService.getSurveyResults(surveyId);
    res.status(HttpStatusCode.Ok).send({ message: "Survey results retrieved.", ...data });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "INVALID_ID") {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid survey ID." });
      return;
    }
    console.error("getSurveyResults error:", error);
    next(error);
  }
}

// ── Fill ──────────────────────────────────────────────────────

export async function getSurveyForFill(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.params["token"] as string;
    const data = await surveyService.getSurveyForFill(token, userId(req));
    res.status(HttpStatusCode.Ok).send({ message: "Survey retrieved.", ...data });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "This survey was not assigned to you." });
      return;
    }
    if (error.message === "ALREADY_COMPLETED") {
      res.status(HttpStatusCode.Conflict).send({ message: "You have already completed this survey." });
      return;
    }
    console.error("getSurveyForFill error:", error);
    next(error);
  }
}

export async function submitSurveyResponse(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const token = req.params["token"] as string;
    const { answers } = req.body;

    if (!answers || !Array.isArray(answers)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Answers array is required." });
      return;
    }

    await surveyService.submitSurveyResponse(token, userId(req), answers);
    res.status(HttpStatusCode.Ok).send({ message: "Survey submitted successfully. Thank you!" });
  } catch (error: any) {
    if (error.message === "NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Survey not found." });
      return;
    }
    if (error.message === "FORBIDDEN") {
      res.status(HttpStatusCode.Forbidden).send({ message: "This survey was not assigned to you." });
      return;
    }
    if (error.message === "ALREADY_COMPLETED") {
      res.status(HttpStatusCode.Conflict).send({ message: "You have already completed this survey." });
      return;
    }
    console.error("submitSurveyResponse error:", error);
    next(error);
  }
}

// ── My surveys ─────────────────────────────────────────────────

export async function getMySurveys(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const data = await surveyService.getMySurveys(userId(req));
    res.status(HttpStatusCode.Ok).send({ message: "Surveys retrieved.", ...data });
  } catch (error) {
    console.error("getMySurveys error:", error);
    next(error);
  }
}
