import { Schema, model, Document, Types } from "mongoose";

export interface IVisitLog extends Document {
  producerId: Types.ObjectId;      // Producer/assistant who made the visit
  workspaceId: Types.ObjectId;     // Client workspace visited
  visitDate: Date;
  attendees: Types.ObjectId[];     // Team members who attended (must include producerId)
  month: string;                   // "YYYY-MM" — derived from visitDate for indexing
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const VisitLogSchema = new Schema<IVisitLog>(
  {
    producerId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    visitDate: { type: Date, required: true },
    attendees: [{ type: Schema.Types.ObjectId, ref: "User" }],
    month: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
    notes: { type: String, maxlength: 500 },
  },
  { timestamps: true, versionKey: false }
);

VisitLogSchema.index({ producerId: 1, month: 1 });
VisitLogSchema.index({ workspaceId: 1, month: 1 });

export const VisitLogModel = model<IVisitLog>("VisitLog", VisitLogSchema);
