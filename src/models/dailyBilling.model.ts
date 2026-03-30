import { Schema, model, Document, Types } from "mongoose";

export interface IDailyBillingEntry extends Document {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  userName: string;
  userEmail: string;
  date: Date;
  amount: number;
  metaSpend: number;
  roas: number;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const DailyBillingEntrySchema = new Schema<IDailyBillingEntry>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    userName: { type: String, required: true, trim: true },
    userEmail: { type: String, required: true, trim: true },
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    metaSpend: { type: Number, required: true, default: 0 },
    roas: { type: Number, required: true, default: 0 },
    notes: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false }
);

// Compound unique: one entry per user per workspace per day
DailyBillingEntrySchema.index({ userId: 1, workspaceId: 1, date: 1 }, { unique: true });
// For querying entries by workspace and date range
DailyBillingEntrySchema.index({ workspaceId: 1, date: 1 });

export const DailyBillingEntryModel = model<IDailyBillingEntry>(
  "DailyBillingEntry",
  DailyBillingEntrySchema
);
