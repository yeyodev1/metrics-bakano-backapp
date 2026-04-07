import { Types } from "mongoose";
import models from "../models";
import type { NotificationType } from "../models/notification.model";

interface CreateOpts {
  workspaceId?: Types.ObjectId | string;
  referenceId?: Types.ObjectId | string;
}

export class NotificationService {
  async create(
    userId: string | Types.ObjectId,
    type: NotificationType,
    title: string,
    body: string,
    opts: CreateOpts = {}
  ) {
    const doc = new models.notifications({
      userId: new Types.ObjectId(userId.toString()),
      type,
      title,
      body,
      workspaceId: opts.workspaceId
        ? new Types.ObjectId(opts.workspaceId.toString())
        : undefined,
      referenceId: opts.referenceId
        ? new Types.ObjectId(opts.referenceId.toString())
        : undefined,
    });
    await doc.save();
    return doc.toObject();
  }

  /**
   * Create notifications for all users of a workspace.
   * @param excludeInternal - if true, only non-internal (client) users are notified
   */
  async createForWorkspaceUsers(
    workspaceId: string | Types.ObjectId,
    excludeInternal: boolean,
    type: NotificationType,
    title: string,
    body: string,
    opts: Omit<CreateOpts, "workspaceId"> = {}
  ) {
    const wsId = new Types.ObjectId(workspaceId.toString());

    // Find users who belong to this workspace
    const users = await models.users
      .find({
        $or: [
          { workspaceId: wsId },
          { "workspaces.workspaceId": wsId },
        ],
        isActive: true,
        ...(excludeInternal ? { isInternal: { $ne: true } } : {}),
      })
      .select("_id")
      .lean();

    if (!users.length) return;

    const docs = users.map((u) => ({
      userId: u._id,
      type,
      title,
      body,
      workspaceId: wsId,
      referenceId: opts.referenceId
        ? new Types.ObjectId(opts.referenceId.toString())
        : undefined,
      isRead: false,
    }));

    await models.notifications.insertMany(docs);
  }

  async getForUser(userId: string, page = 1, limit = 10) {
    const skip = (page - 1) * limit;
    const filter = { userId: new Types.ObjectId(userId) };
    const [notifications, total] = await Promise.all([
      models.notifications
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      models.notifications.countDocuments(filter),
    ]);
    return {
      notifications,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return await models.notifications.countDocuments({
      userId: new Types.ObjectId(userId),
      isRead: false,
    });
  }

  async markRead(notificationId: string, userId: string) {
    if (!Types.ObjectId.isValid(notificationId)) throw new Error("INVALID_ID");
    const doc = await models.notifications.findOneAndUpdate(
      { _id: notificationId, userId: new Types.ObjectId(userId) },
      { isRead: true },
      { new: true }
    );
    if (!doc) throw new Error("NOT_FOUND");
    return doc.toObject();
  }

  async markAllRead(userId: string) {
    await models.notifications.updateMany(
      { userId: new Types.ObjectId(userId), isRead: false },
      { isRead: true }
    );
  }

  async deleteOne(notificationId: string, userId: string) {
    if (!Types.ObjectId.isValid(notificationId)) throw new Error("INVALID_ID");
    const result = await models.notifications.deleteOne({
      _id: notificationId,
      userId: new Types.ObjectId(userId),
    });
    if (result.deletedCount === 0) throw new Error("NOT_FOUND");
  }
}

export const notificationService = new NotificationService();
