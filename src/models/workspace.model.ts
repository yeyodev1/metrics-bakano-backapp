import { Schema, model, Document, Types } from "mongoose";

export interface IWorkspace extends Document {
  name: string;
  adminId?: Types.ObjectId;
  isActive: boolean;
  metaAds?: {
    accessToken: string; // Long-lived user/page token
    pageId: string;
    pageName: string;
    adAccountId?: string;
    adAccountName?: string;
    lastSyncedAt: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metaAds: {
      accessToken: String,
      pageId: String,
      pageName: String,
      adAccountId: String,
      adAccountName: String,
      lastSyncedAt: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const WorkspaceModel = model<IWorkspace>("Workspace", WorkspaceSchema);
