import { Schema, model, Document, Types } from "mongoose";

export interface IClientMeeting extends Document {
  workspaceId: Types.ObjectId;
  pmUserId: Types.ObjectId;
  nextMeetingDate: Date;
  lastMeetingDate?: Date;
  intervalDays: number;
  agenda?: string;
  contactUserId?: Types.ObjectId;
  contactName?: string;
  contactEmail?: string;
  meetingLink?: string;
  notes?: string;
  recordingLink?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ClientMeetingSchema = new Schema<IClientMeeting>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    pmUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    nextMeetingDate: {
      type: Date,
      required: true,
    },
    lastMeetingDate: {
      type: Date,
      default: null,
    },
    intervalDays: {
      type: Number,
      default: 25,
    },
    agenda: {
      type: String,
      trim: true,
    },
    contactUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    contactName: {
      type: String,
      trim: true,
    },
    contactEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },
    meetingLink: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    recordingLink: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// One meeting schedule per workspace-PM pair
ClientMeetingSchema.index({ workspaceId: 1, pmUserId: 1 }, { unique: true });

export const ClientMeetingModel = model<IClientMeeting>(
  "ClientMeeting",
  ClientMeetingSchema
);
