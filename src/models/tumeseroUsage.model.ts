import { Schema, model, Document } from "mongoose";

export interface ITumeseroUsage extends Document {
  date: string; // YYYY-MM-DD Ecuador
  callCount: number;
  lastCallAt: Date;
}

const TumeseroUsageSchema = new Schema<ITumeseroUsage>(
  {
    date: { type: String, required: true, unique: true },
    callCount: { type: Number, default: 0 },
    lastCallAt: { type: Date, default: Date.now },
  },
  { timestamps: false, versionKey: false }
);

export const TumeseroUsageModel = model<ITumeseroUsage>(
  "TumeseroUsage",
  TumeseroUsageSchema
);
