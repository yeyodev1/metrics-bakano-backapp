import { Schema, model, Document, Types } from "mongoose";

export interface IPlanning extends Document {
  workspaceId: Types.ObjectId;
  title: string;
  date: Date;
  notes?: string;
  assignedTo: Types.ObjectId[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const PlanningSchema = new Schema<IPlanning>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    assignedTo: [{
      type: Schema.Types.ObjectId,
      ref: "User",
    }],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Index for efficient querying by workspace and date
PlanningSchema.index({ workspaceId: 1, date: 1 });

export const PlanningModel = model<IPlanning>("Planning", PlanningSchema);
