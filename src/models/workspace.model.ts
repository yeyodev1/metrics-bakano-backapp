import { Schema, model, Document, Types } from "mongoose";

export interface IWorkspace extends Document {
  name: string;
  adminId?: Types.ObjectId;
  isActive: boolean;
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
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const WorkspaceModel = model<IWorkspace>("Workspace", WorkspaceSchema);
