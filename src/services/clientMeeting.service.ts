import { Types } from "mongoose";
import models from "../models";
import { resendService } from "./resend.service";

export class ClientMeetingService {
  async createOrUpdate(
    workspaceId: string,
    pmUserId: string,
    nextMeetingDate: Date,
    opts: {
      agenda?: string;
      intervalDays?: number;
      contactUserId?: string;
      contactName?: string;
      contactEmail?: string;
      meetingLink?: string;
      notes?: string;
      pmName?: string;
      workspaceName?: string;
    } = {}
  ) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(pmUserId)) {
      throw new Error("INVALID_ID");
    }

    const { agenda, intervalDays = 25, contactUserId, contactName, contactEmail, meetingLink, notes, pmName, workspaceName } = opts;

    const filter = {
      workspaceId: new Types.ObjectId(workspaceId),
      pmUserId: new Types.ObjectId(pmUserId),
    };

    const $set: Record<string, unknown> = { nextMeetingDate, intervalDays };
    if (agenda !== undefined) $set.agenda = agenda;
    if (meetingLink !== undefined) $set.meetingLink = meetingLink;
    if (notes !== undefined) $set.notes = notes;
    if (contactUserId && Types.ObjectId.isValid(contactUserId)) {
      $set.contactUserId = new Types.ObjectId(contactUserId);
    }
    if (contactName !== undefined) $set.contactName = contactName;
    if (contactEmail !== undefined) $set.contactEmail = contactEmail;

    const doc = await models.clientMeetings.findOneAndUpdate(filter, { $set }, {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    });

    const saved = doc!.toObject();

    // Send email notification (non-blocking)
    if (contactEmail && contactName && pmName && workspaceName) {
      resendService.sendMeetingInviteEmail({
        to: contactEmail,
        contactName,
        pmName,
        workspaceName,
        meetingDate: nextMeetingDate,
        agenda,
        meetingLink,
      }).catch(() => {});
    }

    return saved;
  }

  async getByWorkspace(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    return await models.clientMeetings
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean();
  }

  async getMyMeetings(pmUserId: string) {
    if (!Types.ObjectId.isValid(pmUserId)) throw new Error("INVALID_ID");

    const meetings = await models.clientMeetings
      .find({ pmUserId: new Types.ObjectId(pmUserId) })
      .sort({ nextMeetingDate: 1 })
      .lean();

    // Populate workspace names
    const workspaceIds = meetings.map((m) => m.workspaceId);
    const workspaces = await models.workspaces
      .find({ _id: { $in: workspaceIds } })
      .select("_id name metaAds")
      .lean();

    const wsMap = new Map(workspaces.map((w) => [w._id.toString(), w]));

    return meetings.map((m) => ({
      ...m,
      workspace: wsMap.get(m.workspaceId.toString()) || null,
    }));
  }

  async complete(meetingId: string, pmUserId: string, opts: { notes?: string; recordingLink?: string } = {}) {
    if (!Types.ObjectId.isValid(meetingId)) throw new Error("INVALID_ID");

    const meeting = await models.clientMeetings.findOne({
      _id: meetingId,
      pmUserId: new Types.ObjectId(pmUserId),
    });

    if (!meeting) throw new Error("NOT_FOUND");

    const now = new Date();
    const nextDate = new Date(now);
    nextDate.setDate(nextDate.getDate() + meeting.intervalDays);

    meeting.lastMeetingDate = now;
    meeting.nextMeetingDate = nextDate;
    if (opts.notes !== undefined) meeting.notes = opts.notes;
    if (opts.recordingLink !== undefined) meeting.recordingLink = opts.recordingLink;
    await meeting.save();

    return meeting.toObject();
  }

  async update(meetingId: string, pmUserId: string, fields: { nextMeetingDate?: Date; agenda?: string; intervalDays?: number; meetingLink?: string; notes?: string; contactUserId?: Types.ObjectId; contactName?: string; contactEmail?: string }) {
    if (!Types.ObjectId.isValid(meetingId)) throw new Error("INVALID_ID");

    const doc = await models.clientMeetings.findOneAndUpdate(
      { _id: meetingId, pmUserId: new Types.ObjectId(pmUserId) },
      { $set: fields },
      { new: true }
    );

    if (!doc) throw new Error("NOT_FOUND");
    return doc.toObject();
  }
}

export const clientMeetingService = new ClientMeetingService();
