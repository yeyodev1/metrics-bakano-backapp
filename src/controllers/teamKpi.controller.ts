import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import type { ITeamKpiRecord, KpiRoleType } from "../models/teamKpiRecord.model";

// ── Helpers to compute performance scores ────────────────────────────────

function safeDiv(a: number | undefined, b: number | undefined): number {
  if (!b || b === 0) return 0;
  return (a ?? 0) / b;
}

function clamp(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/**
 * Computes the final performance % for a KPI record.
 * All formulas match the team's spreadsheet.
 */
function computePerformance(rec: ITeamKpiRecord): number {
  if (rec.roleType === "editor") {
    const productivity  = clamp(safeDiv(rec.deliveredVideos, rec.targetVideos));
    const quality       = rec.deliveredVideos && rec.deliveredVideos > 0
      ? clamp(safeDiv(rec.approvedFirstPass, rec.deliveredVideos))
      : 1;
    const sla           = rec.urgencies && rec.urgencies > 0
      ? clamp(safeDiv(rec.urgenciesOnTime, rec.urgencies))
      : 1;
    return productivity * quality * sla;
  }

  if (rec.roleType === "asistente_produccion") {
    const visits    = clamp(safeDiv(rec.completedVisits, rec.targetVisits));
    const videos    = clamp(safeDiv(rec.videosMade, rec.targetVideosMade));
    const punctual  = rec.targetVideosMade && rec.targetVideosMade > 0
      ? clamp(safeDiv(rec.onTimeDeliveriesToEditor, rec.targetVideosMade))
      : 1;
    // Average of the three ratios
    return (visits + videos + punctual) / 3;
  }

  if (rec.roleType === "content") {
    const volume     = clamp(safeDiv(rec.deliveredPlans, rec.targetPlans));
    const quality    = rec.deliveredPlans && rec.deliveredPlans > 0
      ? clamp(safeDiv(rec.completePlans20, rec.deliveredPlans))
      : 1;
    const punctual   = clamp(safeDiv(rec.plansOnTime, rec.targetPlans));
    return (volume + quality + punctual) / 3;
  }

  return 0;
}

function formatRecord(rec: ITeamKpiRecord) {
  const performance = computePerformance(rec);
  return {
    ...rec.toObject ? rec.toObject() : rec,
    performanceScore: parseFloat((performance * 100).toFixed(2)),
  };
}

// ── Controllers ──────────────────────────────────────────────────────────

/**
 * GET /team-kpis?month=2026-03
 * Returns all KPI records for a given month, populated with user info.
 * Accessible by: superadmin, project_manager, and internal users.
 */
export async function getTeamKpis(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const month = req.query["month"] as string;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "A valid 'month' query param (YYYY-MM) is required." });
      return;
    }

    const records = await models.teamKpiRecords
      .find({ month })
      .populate("userId", "name email internalRole")
      .populate("pmUserId", "name email")
      .lean();

    const data = records.map((rec) => ({
      ...rec,
      performanceScore: parseFloat((computePerformance(rec as unknown as ITeamKpiRecord) * 100).toFixed(2)),
    }));

    res.status(HttpStatusCode.Ok).send({
      message: "Team KPI records retrieved successfully.",
      month,
      records: data,
    });
    return;
  } catch (error) {
    console.error("getTeamKpis error:", error);
    next(error);
  }
}

/**
 * POST /team-kpis
 * Create or update a KPI record for a given user + month.
 * Allowed by: editor, director, superadmin.
 */
export async function upsertTeamKpi(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const pmUserId = req.user!._id;
    const {
      userId,
      month,
      roleType,
      // Editor fields
      workingDays,
      targetVideos,
      deliveredVideos,
      returnedVideos,
      approvedFirstPass,
      urgencies,
      urgenciesOnTime,
      // Asistente Producción fields
      prodClients,
      targetVisits,
      completedVisits,
      targetVideosMade,
      videosMade,
      onTimeDeliveriesToEditor,
      // Content fields
      contentClients,
      targetPlans,
      deliveredPlans,
      completePlans20,
      plansOnTime,
      postsTarget,
      postsDelivered,
      publishRate,
    } = req.body;

    // Validate required fields
    if (!userId || !Types.ObjectId.isValid(userId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "A valid 'userId' is required." });
      return;
    }
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "A valid 'month' (YYYY-MM) is required." });
      return;
    }
    if (!roleType || !["editor", "asistente_produccion", "content"].includes(roleType)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "roleType must be 'editor', 'asistente_produccion', or 'content'." });
      return;
    }

    const filter = {
      userId: new Types.ObjectId(userId),
      month,
    };

    const $set: Partial<ITeamKpiRecord> = {
      pmUserId: new Types.ObjectId(pmUserId),
      roleType: roleType as KpiRoleType,
      // Editor
      ...(workingDays !== undefined && { workingDays }),
      ...(targetVideos !== undefined && { targetVideos }),
      ...(deliveredVideos !== undefined && { deliveredVideos }),
      ...(returnedVideos !== undefined && { returnedVideos }),
      ...(approvedFirstPass !== undefined && { approvedFirstPass }),
      ...(urgencies !== undefined && { urgencies }),
      ...(urgenciesOnTime !== undefined && { urgenciesOnTime }),
      // Asistente Producción
      ...(prodClients !== undefined && { prodClients }),
      ...(targetVisits !== undefined && { targetVisits }),
      ...(completedVisits !== undefined && { completedVisits }),
      ...(targetVideosMade !== undefined && { targetVideosMade }),
      ...(videosMade !== undefined && { videosMade }),
      ...(onTimeDeliveriesToEditor !== undefined && { onTimeDeliveriesToEditor }),
      // Content
      ...(contentClients !== undefined && { contentClients }),
      ...(targetPlans !== undefined && { targetPlans }),
      ...(deliveredPlans !== undefined && { deliveredPlans }),
      ...(completePlans20 !== undefined && { completePlans20 }),
      ...(plansOnTime !== undefined && { plansOnTime }),
      ...(postsTarget !== undefined && { postsTarget }),
      ...(postsDelivered !== undefined && { postsDelivered }),
      ...(publishRate !== undefined && { publishRate }),
    };

    const doc = await models.teamKpiRecords.findOneAndUpdate(
      filter,
      { $set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.status(HttpStatusCode.Ok).send({
      message: "KPI record saved successfully.",
      record: formatRecord(doc!),
    });
    return;
  } catch (error) {
    console.error("upsertTeamKpi error:", error);
    next(error);
  }
}

/**
 * GET /team-kpis/me?month=2026-03
 * Returns the KPI record for the authenticated user for the given month.
 */
export async function getMyKpi(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user!._id;
    const month = req.query["month"] as string;

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "A valid 'month' query param (YYYY-MM) is required." });
      return;
    }

    const record = await models.teamKpiRecords
      .findOne({ userId: new Types.ObjectId(userId), month })
      .lean();

    if (!record) {
      res.status(HttpStatusCode.Ok).send({ message: "No KPI record found for this month.", record: null });
      return;
    }

    res.status(HttpStatusCode.Ok).send({
      message: "KPI record retrieved successfully.",
      record: {
        ...record,
        performanceScore: parseFloat(
          (computePerformance(record as unknown as ITeamKpiRecord) * 100).toFixed(2)
        ),
      },
    });
    return;
  } catch (error) {
    console.error("getMyKpi error:", error);
    next(error);
  }
}

/**
 * GET /team-kpis/users?month=2026-03
 * Returns all internal users eligible for KPI evaluation (editor, asistente_produccion, content, director, etc.)
 * Used by the frontend to populate the user selector.
 */
export async function getKpiEligibleUsers(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const users = await models.users
      .find({
        isInternal: true,
        internalRole: { $in: ["editor", "asistente_produccion", "productor", "content_manager", "director", "community_manager"] },
        isActive: true,
      })
      .select("_id name email internalRole")
      .lean();

    res.status(HttpStatusCode.Ok).send({
      message: "KPI eligible users retrieved successfully.",
      users,
    });
    return;
  } catch (error) {
    console.error("getKpiEligibleUsers error:", error);
    next(error);
  }
}
