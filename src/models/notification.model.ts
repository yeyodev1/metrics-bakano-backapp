import { Schema, model, Document, Types } from "mongoose";

export type NotificationType =
  | "new_client_assigned"
  | "video_status_changed"
  | "video_planning_resent"
  | "brand_profile_missing";

export interface INotification extends Document {
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  workspaceId?: Types.ObjectId;
  referenceId?: Types.ObjectId;
  isRead: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    type: {
      type: String,
      enum: [
        "new_client_assigned",
        "video_status_changed",
        "video_planning_resent",
        "brand_profile_missing",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      default: null,
    },
    referenceId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    isRead: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Fast queries: get all notifications for a user sorted newest first
NotificationSchema.index({ userId: 1, createdAt: -1 });

export const NotificationModel = model<INotification>(
  "Notification",
  NotificationSchema
);
