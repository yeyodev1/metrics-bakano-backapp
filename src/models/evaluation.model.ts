import { Schema, model, Document, Types } from "mongoose";

export interface IEvaluation extends Document {
  evaluatorId: Types.ObjectId;
  evaluatedUserId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  rating: number; // 1 to 5
  feedback: string;
  createdAt: Date;
  updatedAt: Date;
}

export const EvaluationSchema = new Schema<IEvaluation>(
  {
    evaluatorId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    evaluatedUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    rating: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    feedback: {
      type: String,
      trim: true,
      default: "",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const EvaluationModel = model<IEvaluation>("Evaluation", EvaluationSchema);
