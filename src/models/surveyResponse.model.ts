import { Schema, model, Document, Types } from "mongoose";

export interface IAnswer {
  questionId: string;
  value: any;
}

export interface ISurveyResponse extends Document {
  assignmentId: Types.ObjectId;
  surveyId: Types.ObjectId;
  respondentId: Types.ObjectId;
  answers: IAnswer[];
  submittedAt: Date;
}

const AnswerSchema = new Schema<IAnswer>(
  {
    questionId: { type: String, required: true },
    value: { type: Schema.Types.Mixed },
  },
  { _id: false }
);

const SurveyResponseSchema = new Schema<ISurveyResponse>(
  {
    assignmentId: {
      type: Schema.Types.ObjectId,
      ref: "SurveyAssignment",
      required: true,
      unique: true, // one response per assignment
    },
    surveyId: {
      type: Schema.Types.ObjectId,
      ref: "Survey",
      required: true,
    },
    respondentId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    answers: [AnswerSchema],
    submittedAt: {
      type: Date,
      default: () => new Date(),
    },
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

export const SurveyResponseModel = model<ISurveyResponse>("SurveyResponse", SurveyResponseSchema);
