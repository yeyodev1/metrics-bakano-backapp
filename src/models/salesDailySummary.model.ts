import { Schema, model, Document, Types } from "mongoose";

export interface IStoreSummary {
  storeName: string;
  sessions: number;
  orders: number;
  revenue: number;
  deliveryCost: number;
}

export interface ISalesDailySummary extends Document {
  workspaceId: Types.ObjectId;
  date: string; // YYYY-MM-DD Ecuador
  totalSessions: number;
  totalOrders: number;
  conversionRate: number; // percentage 0-100
  totalRevenue: number; // sum of subtotal_neto
  totalDelivery: number; // sum of costo_delivery
  totalBilled: number; // sum of subtotal_desc (neto + delivery)
  byStore: IStoreSummary[];
  syncedAt: Date;
}

const StoreSummarySchema = new Schema<IStoreSummary>(
  {
    storeName: { type: String, required: true },
    sessions: { type: Number, default: 0 },
    orders: { type: Number, default: 0 },
    revenue: { type: Number, default: 0 },
    deliveryCost: { type: Number, default: 0 },
  },
  { _id: false }
);

const SalesDailySummarySchema = new Schema<ISalesDailySummary>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    date: { type: String, required: true }, // YYYY-MM-DD
    totalSessions: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    conversionRate: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalDelivery: { type: Number, default: 0 },
    totalBilled: { type: Number, default: 0 },
    byStore: { type: [StoreSummarySchema], default: [] },
    syncedAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Unique per workspace+date
SalesDailySummarySchema.index({ workspaceId: 1, date: 1 }, { unique: true });

export const SalesDailySummaryModel = model<ISalesDailySummary>(
  "SalesDailySummary",
  SalesDailySummarySchema
);
