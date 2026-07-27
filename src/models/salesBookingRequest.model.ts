import { Schema, model, Document, Types } from "mongoose";

export interface ISalesBookingEvidence {
  name: string;
  url: string;
  publicId: string;
  mimeType: string;
}

export interface ISalesBookingRequest extends Document {
  workspaceId: Types.ObjectId;
  userId: Types.ObjectId;
  salesApproach: "spin" | "automatic_paragraph" | "direct_service" | "catalog";
  commonObjection: "price_no_response" | "think_about_it" | "out_of_budget" | "curiosity" | "other";
  otherObjection?: string;
  lostSaleEvidence: ISalesBookingEvidence[];
  createdAt: Date;
  updatedAt: Date;
}

const SalesBookingRequestSchema = new Schema<ISalesBookingRequest>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    salesApproach: { type: String, required: true, enum: ["spin", "automatic_paragraph", "direct_service", "catalog"] },
    commonObjection: { type: String, required: true, enum: ["price_no_response", "think_about_it", "out_of_budget", "curiosity", "other"] },
    otherObjection: { type: String, trim: true, maxlength: 300 },
    lostSaleEvidence: [
      {
        name: { type: String, required: true },
        url: { type: String, required: true },
        publicId: { type: String, required: true },
        mimeType: { type: String, required: true },
      },
    ],
  },
  { timestamps: true, versionKey: false }
);

SalesBookingRequestSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });

export const SalesBookingRequestModel = model<ISalesBookingRequest>("SalesBookingRequest", SalesBookingRequestSchema);
