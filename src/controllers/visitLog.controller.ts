import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { Types } from "mongoose";
import { AuthRequest } from "../types/AuthRequest";
import models from "../models";

/**
 * POST /visit-logs
 * Any internal user (producer, assistant, etc.) can log a visit for themselves.
 */
export async function createVisitLog(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const producerId = req.user!._id;
    const { workspaceId, visitDate, attendees, notes } = req.body;

    if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "A valid 'workspaceId' is required." });
      return;
    }
    if (!visitDate) {
      res.status(HttpStatusCode.BadRequest).send({ message: "'visitDate' is required." });
      return;
    }

    const date = new Date(visitDate);
    if (isNaN(date.getTime())) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid 'visitDate'." });
      return;
    }

    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;

    // Validate attendees array (optional, but if provided must be valid ObjectIds)
    const cleanAttendees: Types.ObjectId[] = [];
    if (Array.isArray(attendees) && attendees.length > 0) {
      for (const id of attendees) {
        if (!Types.ObjectId.isValid(id)) {
          res.status(HttpStatusCode.BadRequest).send({ message: `Invalid attendee id: ${id}` });
          return;
        }
        cleanAttendees.push(new Types.ObjectId(id));
      }
    }

    const log = await models.visitLogs.create({
      producerId: new Types.ObjectId(producerId),
      workspaceId: new Types.ObjectId(workspaceId),
      visitDate: date,
      month,
      attendees: cleanAttendees,
      notes: notes?.trim() || undefined,
    });

    const populated = await models.visitLogs
      .findById(log._id)
      .populate("producerId", "name email internalRole")
      .populate("workspaceId", "name")
      .populate("attendees", "name internalRole")
      .lean();

    res.status(HttpStatusCode.Created).send({
      message: "Visit log created successfully.",
      log: populated,
    });
  } catch (error) {
    console.error("createVisitLog error:", error);
    next(error);
  }
}

/**
 * GET /visit-logs?month=YYYY-MM&producerId=xxx
 * Internal + superadmin can read all logs. Producers see all (PM decides visibility).
 * Optional filter by producerId.
 */
export async function getVisitLogs(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const month = req.query["month"] as string | undefined;
    const producerIdFilter = req.query["producerId"] as string | undefined;

    if (month && !/^\d{4}-\d{2}$/.test(month)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid 'month' format. Use YYYY-MM." });
      return;
    }

    const filter: Record<string, unknown> = {};
    if (month) filter["month"] = month;
    if (producerIdFilter && Types.ObjectId.isValid(producerIdFilter)) {
      filter["producerId"] = new Types.ObjectId(producerIdFilter);
    }

    const logs = await models.visitLogs
      .find(filter)
      .sort({ visitDate: -1 })
      .populate("producerId", "name email internalRole")
      .populate("workspaceId", "name")
      .populate("attendees", "name internalRole")
      .lean();

    res.status(HttpStatusCode.Ok).send({ message: "Visit logs retrieved.", logs });
  } catch (error) {
    console.error("getVisitLogs error:", error);
    next(error);
  }
}

/**
 * DELETE /visit-logs/:id
 * Only the producer who created it or a superadmin can delete.
 */
export async function deleteVisitLog(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const id = req.params["id"] as string;
    const requesterId = req.user!._id.toString();
    const requesterRole = req.user!.role;

    if (!Types.ObjectId.isValid(id)) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Invalid log id." });
      return;
    }

    const log = await models.visitLogs.findById(id);
    if (!log) {
      res.status(HttpStatusCode.NotFound).send({ message: "Visit log not found." });
      return;
    }

    const isOwner = log.producerId.toString() === requesterId;
    const isSuperadmin = requesterRole === "superadmin";

    if (!isOwner && !isSuperadmin) {
      res.status(HttpStatusCode.Forbidden).send({ message: "You cannot delete this log." });
      return;
    }

    await log.deleteOne();
    res.status(HttpStatusCode.Ok).send({ message: "Visit log deleted." });
  } catch (error) {
    console.error("deleteVisitLog error:", error);
    next(error);
  }
}
