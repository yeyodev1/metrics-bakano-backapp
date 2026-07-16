import { Document, Schema, Types, model } from "mongoose";

export interface IFlorindaSalesBreakdown {
  name: string;
  invoiceCount: number;
  totalSales: number;
}

export interface IFlorindaDailySales extends Document {
  workspaceId: Types.ObjectId;
  date: string;
  invoiceCount: number;
  lineItemCount: number;
  netSales: number;
  tax: number;
  discount: number;
  totalSales: number;
  byChannel: IFlorindaSalesBreakdown[];
  bySeller: IFlorindaSalesBreakdown[];
  syncedAt: Date;
}

const BreakdownSchema = new Schema<IFlorindaSalesBreakdown>(
  {
    name: { type: String, required: true },
    invoiceCount: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
  },
  { _id: false }
);

const FlorindaDailySalesSchema = new Schema<IFlorindaDailySales>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    date: { type: String, required: true },
    invoiceCount: { type: Number, default: 0 },
    lineItemCount: { type: Number, default: 0 },
    netSales: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    totalSales: { type: Number, default: 0 },
    byChannel: { type: [BreakdownSchema], default: [] },
    bySeller: { type: [BreakdownSchema], default: [] },
    syncedAt: { type: Date, default: Date.now },
  },
  { timestamps: true, versionKey: false }
);

FlorindaDailySalesSchema.index({ workspaceId: 1, date: 1 }, { unique: true });

export const FlorindaDailySalesModel = model<IFlorindaDailySales>(
  "FlorindaDailySales",
  FlorindaDailySalesSchema
);
