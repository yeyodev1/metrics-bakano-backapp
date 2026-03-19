import crypto from "crypto";
import mongoose from "mongoose";
import models from "../models";
import { ISurvey, IQuestion } from "../models/survey.model";
import { ISurveyAssignment } from "../models/surveyAssignment.model";
import { ISurveyResponse, IAnswer } from "../models/surveyResponse.model";
import { resendService } from "./resend.service";

export class SurveyService {
  // ── Create ────────────────────────────────────────────────

  async createSurvey(data: {
    title: string;
    description?: string;
    coverImage?: string;
    questions: IQuestion[];
    createdBy: string;
  }): Promise<ISurvey> {
    const survey = await models.surveys.create({
      title: data.title,
      description: data.description,
      coverImage: data.coverImage,
      questions: data.questions,
      createdBy: new mongoose.Types.ObjectId(data.createdBy),
      status: "draft",
    });
    return survey;
  }

  // ── List ──────────────────────────────────────────────────

  async listSurveys(params: { userId: string; isSuperadmin: boolean }): Promise<ISurvey[]> {
    const uid = new mongoose.Types.ObjectId(params.userId);
    const filter = params.isSuperadmin
      ? {}
      : { $or: [{ createdBy: uid }, { authorizedSenders: uid }] };
    return models.surveys
      .find(filter)
      .populate("createdBy", "name email")
      .populate("authorizedSenders", "name email")
      .sort({ createdAt: -1 })
      .lean() as unknown as ISurvey[];
  }

  // ── Get by ID ─────────────────────────────────────────────

  async getSurveyById(surveyId: string, userId: string, isSuperadmin: boolean): Promise<ISurvey> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId).populate("createdBy", "name email").lean();
    if (!survey) throw new Error("NOT_FOUND");

    // createdBy is populated → extract _id; authorizedSenders are plain ObjectIds
    const creatorId = (survey.createdBy as any)?._id?.toString() ?? survey.createdBy?.toString();

    const isAuthorized =
      isSuperadmin ||
      creatorId === userId ||
      (survey.authorizedSenders ?? []).some((s: any) => s?.toString() === userId);

    if (!isAuthorized) throw new Error("FORBIDDEN");

    return survey as unknown as ISurvey;
  }

  // ── Update ────────────────────────────────────────────────

  async updateSurvey(
    surveyId: string,
    data: Partial<Pick<ISurvey, "title" | "description" | "coverImage" | "questions">>,
    userId: string,
    isSuperadmin: boolean
  ): Promise<ISurvey> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId);
    if (!survey) throw new Error("NOT_FOUND");
    if (!isSuperadmin && survey.createdBy.toString() !== userId) throw new Error("FORBIDDEN");

    Object.assign(survey, data);
    await survey.save();
    return survey;
  }

  // ── Update status ─────────────────────────────────────────

  async updateStatus(
    surveyId: string,
    status: "draft" | "active" | "closed",
    userId: string,
    isSuperadmin: boolean
  ): Promise<ISurvey> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId);
    if (!survey) throw new Error("NOT_FOUND");
    if (!isSuperadmin && survey.createdBy.toString() !== userId) throw new Error("FORBIDDEN");

    survey.status = status;
    await survey.save();
    return survey;
  }

  // ── Delete ────────────────────────────────────────────────

  async deleteSurvey(surveyId: string, userId: string, isSuperadmin: boolean): Promise<void> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId);
    if (!survey) throw new Error("NOT_FOUND");
    if (!isSuperadmin && survey.createdBy.toString() !== userId) throw new Error("FORBIDDEN");

    await models.surveys.deleteOne({ _id: surveyId });
  }

  // ── Assign internal senders (superadmin delegates) ────────

  async assignInternalSenders(
    surveyId: string,
    userIds: string[],
  ): Promise<ISurvey> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");
    const survey = await models.surveys.findById(surveyId);
    if (!survey) throw new Error("NOT_FOUND");

    const validIds = userIds
      .filter((id) => mongoose.isValidObjectId(id))
      .map((id) => new mongoose.Types.ObjectId(id));

    survey.authorizedSenders = validIds as any;
    await survey.save();
    return (await models.surveys
      .findById(surveyId)
      .populate("authorizedSenders", "name email")
      .lean()) as unknown as ISurvey;
  }

  // ── Send ──────────────────────────────────────────────────

  async sendSurvey(params: {
    surveyId: string;
    workspaceId: string;
    userIds: string[];
    message?: string;
    sentBy: string;
  }): Promise<{ sent: number; skipped: number }> {
    const { surveyId, workspaceId, userIds, message, sentBy } = params;

    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId).lean();
    if (!survey) throw new Error("NOT_FOUND");
    if (survey.status !== "active") throw new Error("SURVEY_NOT_ACTIVE");

    const sender = await models.users.findById(sentBy).lean();
    if (!sender) throw new Error("NOT_FOUND");

    // Check sender is authorized (creator, superadmin, or delegated)
    const isSuperadmin = sender.role === "superadmin";
    const isCreator = survey.createdBy.toString() === sentBy;
    const isDelegated = (survey.authorizedSenders ?? []).some((s: any) => s.toString() === sentBy);
    if (!isSuperadmin && !isCreator && !isDelegated) throw new Error("FORBIDDEN");

    let sent = 0;
    let skipped = 0;

    for (const userId of userIds) {
      if (!mongoose.isValidObjectId(userId)) {
        skipped++;
        continue;
      }

      const recipient = await models.users.findById(userId).lean();
      if (!recipient || !recipient.isActive || recipient.isInternal) {
        skipped++;
        continue;
      }

      // Only send to users that belong to this workspace
      const belongsToWorkspace =
        recipient.workspaces?.some((ws) => ws.workspaceId.toString() === workspaceId) ||
        recipient.workspaceId?.toString() === workspaceId;

      if (!belongsToWorkspace) {
        skipped++;
        continue;
      }

      // Skip only if there's a pending assignment (not yet answered)
      const existing = await models.surveyAssignments.findOne({
        surveyId: new mongoose.Types.ObjectId(surveyId),
        recipientId: new mongoose.Types.ObjectId(userId),
        status: "pending",
      });

      if (existing) {
        skipped++;
        continue;
      }

      const token = crypto.randomBytes(32).toString("hex");

      await models.surveyAssignments.create({
        surveyId: new mongoose.Types.ObjectId(surveyId),
        workspaceId: new mongoose.Types.ObjectId(workspaceId),
        recipientId: new mongoose.Types.ObjectId(userId),
        sentBy: new mongoose.Types.ObjectId(sentBy),
        token,
        status: "pending",
        sentAt: new Date(),
      });

      const surveyLink = `https://metrics.bakano.ec/app/survey/${token}`;

      try {
        await resendService.sendSurveyInvitation({
          to: recipient.email,
          recipientName: recipient.name || recipient.email,
          senderName: sender.name || sender.email,
          surveyTitle: survey.title,
          surveyLink,
          customMessage: message,
        });
        sent++;
      } catch (emailError) {
        // Assignment was created; log email failure but don't fail the whole batch
        console.error(`Failed to send email to ${recipient.email}:`, emailError);
        sent++; // assignment exists, mark as sent even if email failed
      }
    }

    return { sent, skipped };
  }

  // ── List internal users (for superadmin to send surveys) ──

  async listInternalUsers(): Promise<{ _id: string; name: string; email: string }[]> {
    const users = await models.users
      .find({ isInternal: true, isActive: true })
      .select("_id name email")
      .sort({ name: 1 })
      .lean();
    return users as unknown as { _id: string; name: string; email: string }[];
  }

  // ── Send survey to internal team (superadmin only) ─────────

  async sendSurveyToInternals(params: {
    surveyId: string;
    userIds: string[];
    message?: string;
    sentBy: string;
  }): Promise<{ sent: number; skipped: number }> {
    const { surveyId, userIds, message, sentBy } = params;

    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId).lean();
    if (!survey) throw new Error("NOT_FOUND");
    if (survey.status !== "active") throw new Error("SURVEY_NOT_ACTIVE");

    const sender = await models.users.findById(sentBy).lean();
    if (!sender) throw new Error("NOT_FOUND");

    let sent = 0;
    let skipped = 0;

    for (const uid of userIds) {
      if (!mongoose.isValidObjectId(uid)) { skipped++; continue; }

      const recipient = await models.users.findById(uid).lean();
      if (!recipient || !recipient.isActive || !recipient.isInternal) { skipped++; continue; }

      const existing = await models.surveyAssignments.findOne({
        surveyId: new mongoose.Types.ObjectId(surveyId),
        recipientId: new mongoose.Types.ObjectId(uid),
        status: "pending",
      });
      if (existing) { skipped++; continue; }

      const token = crypto.randomBytes(32).toString("hex");

      await models.surveyAssignments.create({
        surveyId: new mongoose.Types.ObjectId(surveyId),
        recipientId: new mongoose.Types.ObjectId(uid),
        sentBy: new mongoose.Types.ObjectId(sentBy),
        token,
        status: "pending",
        sentAt: new Date(),
      });

      const surveyLink = `https://metrics.bakano.ec/app/survey/${token}`;

      try {
        await resendService.sendSurveyInvitation({
          to: recipient.email,
          recipientName: recipient.name || recipient.email,
          senderName: sender.name || sender.email,
          surveyTitle: survey.title,
          surveyLink,
          customMessage: message,
        });
        sent++;
      } catch (emailError) {
        console.error(`Failed to send email to ${recipient.email}:`, emailError);
        sent++;
      }
    }

    return { sent, skipped };
  }

  // ── Results ───────────────────────────────────────────────

  async getSurveyResults(surveyId: string): Promise<{
    survey: ISurvey;
    assignments: ISurveyAssignment[];
    responses: ISurveyResponse[];
  }> {
    if (!mongoose.isValidObjectId(surveyId)) throw new Error("INVALID_ID");

    const survey = await models.surveys.findById(surveyId).lean();
    if (!survey) throw new Error("NOT_FOUND");

    const assignments = await models.surveyAssignments
      .find({ surveyId: new mongoose.Types.ObjectId(surveyId) })
      .populate("recipientId", "name email")
      .populate("sentBy", "name email")
      .lean();

    const responses = await models.surveyResponses
      .find({ surveyId: new mongoose.Types.ObjectId(surveyId) })
      .lean();

    return {
      survey: survey as unknown as ISurvey,
      assignments: assignments as unknown as ISurveyAssignment[],
      responses: responses as unknown as ISurveyResponse[],
    };
  }

  // ── Get for fill ──────────────────────────────────────────

  async getSurveyForFill(
    token: string,
    userId: string
  ): Promise<{ survey: ISurvey; assignment: ISurveyAssignment }> {
    const assignment = await models.surveyAssignments.findOne({ token }).lean();
    if (!assignment) throw new Error("NOT_FOUND");

    if (assignment.recipientId.toString() !== userId) throw new Error("FORBIDDEN");
    if (assignment.status === "completed") throw new Error("ALREADY_COMPLETED");

    const survey = await models.surveys.findById(assignment.surveyId).lean();
    if (!survey) throw new Error("NOT_FOUND");

    return {
      survey: survey as unknown as ISurvey,
      assignment: assignment as unknown as ISurveyAssignment,
    };
  }

  // ── Submit response ───────────────────────────────────────

  async submitSurveyResponse(token: string, userId: string, answers: IAnswer[]): Promise<void> {
    const assignment = await models.surveyAssignments.findOne({ token });
    if (!assignment) throw new Error("NOT_FOUND");

    if (assignment.recipientId.toString() !== userId) throw new Error("FORBIDDEN");
    if (assignment.status === "completed") throw new Error("ALREADY_COMPLETED");

    await models.surveyResponses.create({
      assignmentId: assignment._id,
      surveyId: assignment.surveyId,
      respondentId: new mongoose.Types.ObjectId(userId),
      answers,
      submittedAt: new Date(),
    });

    assignment.status = "completed";
    assignment.completedAt = new Date();
    await assignment.save();
  }

  // ── My surveys ────────────────────────────────────────────

  async getMySurveys(userId: string): Promise<{
    pending: ISurveyAssignment[];
    completed: ISurveyAssignment[];
  }> {
    const all = await models.surveyAssignments
      .find({ recipientId: new mongoose.Types.ObjectId(userId) })
      .populate("surveyId", "title description")
      .populate("sentBy", "name email")
      .sort({ sentAt: -1 })
      .lean();

    const pending = all.filter((a) => a.status === "pending") as unknown as ISurveyAssignment[];
    const completed = all.filter((a) => a.status === "completed") as unknown as ISurveyAssignment[];

    return { pending, completed };
  }
}

export const surveyService = new SurveyService();
