import { Schema, model, Document, Types } from "mongoose";

export interface ISurveyAssignment extends Document {
  surveyId: Types.ObjectId;
  workspaceId?: Types.ObjectId;
  recipientId: Types.ObjectId;
  sentBy: Types.ObjectId;
  token: string;
  status: "pending" | "completed";
  sentAt: Date;
  completedAt?: Date;
}

const SurveyAssignmentSchema = new Schema<ISurveyAssignment>(
  {
    surveyId: {
      type: Schema.Types.ObjectId,
      ref: "Survey",
      required: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: false,
    },
    recipientId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    sentBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    status: {
      type: String,
      enum: ["pending", "completed"],
      default: "pending",
    },
    sentAt: {
      type: Date,
      default: () => new Date(),
    },
    completedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Prevent duplicate assignments for the same survey + recipient
SurveyAssignmentSchema.index({ surveyId: 1, recipientId: 1 });

export const SurveyAssignmentModel = model<ISurveyAssignment>("SurveyAssignment", SurveyAssignmentSchema);
