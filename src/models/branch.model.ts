import { Schema, model, Document, Types } from "mongoose";

export interface IBranch extends Document {
  name: string;
  workspaceId: Types.ObjectId;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BranchSchema = new Schema<IBranch>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
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

// Index to quickly find branches for a workspace
BranchSchema.index({ workspaceId: 1 });

export const BranchModel = model<IBranch>("Branch", BranchSchema);
