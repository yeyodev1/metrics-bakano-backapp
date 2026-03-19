import { Schema, model, Document, Types } from "mongoose";
import crypto from "crypto";

export type QuestionType =
  | "short_text"
  | "long_text"
  | "multiple_choice"
  | "checkbox"
  | "rating"
  | "nps"
  | "yes_no"
  | "dropdown"
  | "date"
  | "image_question";

export type ImageAnswerType =
  | "yes_no"
  | "rating"
  | "nps"
  | "short_text"
  | "long_text"
  | "multiple_choice"
  | "checkbox"
  | "dropdown"
  | "date";

export interface IQuestion {
  id: string;
  type: QuestionType;
  label: string;
  required: boolean;
  options?: string[];
  min?: number;
  max?: number;
  minLabel?: string;
  maxLabel?: string;
  imageUrl?: string;
  imageAnswerType?: ImageAnswerType;
}

export interface ISurvey extends Document {
  title: string;
  description?: string;
  coverImage?: string;
  questions: IQuestion[];
  createdBy: Types.ObjectId;
  authorizedSenders: Types.ObjectId[];
  status: "draft" | "active" | "closed";
  createdAt: Date;
  updatedAt: Date;
}

const QuestionSchema = new Schema<IQuestion>(
  {
    id: {
      type: String,
      default: () => crypto.randomUUID(),
    },
    type: {
      type: String,
      enum: ["short_text", "long_text", "multiple_choice", "checkbox", "rating", "nps", "yes_no", "dropdown", "date", "image_question"],
      required: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    required: {
      type: Boolean,
      default: false,
    },
    options: [{ type: String }],
    min: { type: Number },
    max: { type: Number },
    minLabel: { type: String, trim: true },
    maxLabel: { type: String, trim: true },
    imageUrl: { type: String },
    imageAnswerType: {
      type: String,
      enum: ["yes_no", "rating", "nps", "short_text", "long_text", "multiple_choice", "checkbox", "dropdown", "date"],
    },
  },
  { _id: false }
);

const SurveySchema = new Schema<ISurvey>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      trim: true,
    },
    coverImage: { type: String },
    questions: [QuestionSchema],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    authorizedSenders: [{ type: Schema.Types.ObjectId, ref: "User" }],
    status: {
      type: String,
      enum: ["draft", "active", "closed"],
      default: "draft",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

SurveySchema.index({ createdBy: 1, status: 1 });

export const SurveyModel = model<ISurvey>("Survey", SurveySchema);
