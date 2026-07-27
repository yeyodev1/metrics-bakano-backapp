import { Schema, model, Document, Types } from "mongoose";

export interface ISalesAppointment extends Document {
  ghlAppointmentId: string;
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  contactEmail: string;
  calendarId: string;
  status: string;
  startsAt: Date;
  endsAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SalesAppointmentSchema = new Schema<ISalesAppointment>(
  {
    ghlAppointmentId: { type: String, required: true, unique: true, trim: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    calendarId: { type: String, required: true, trim: true },
    status: { type: String, required: true, trim: true },
    startsAt: { type: Date, required: true },
    endsAt: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

SalesAppointmentSchema.index({ workspaceId: 1, userId: 1, startsAt: -1 });

export const SalesAppointmentModel = model<ISalesAppointment>("SalesAppointment", SalesAppointmentSchema);
