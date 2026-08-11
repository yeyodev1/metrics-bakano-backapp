import { Schema, model, Document } from "mongoose";

export interface IMetaGlobalIntegration extends Document {
  key: string;
  encryptedAccessToken: string;
  facebookUserId: string;
  facebookUserName: string;
  expiresAt?: Date;
  updatedAt: Date;
}

const MetaGlobalIntegrationSchema = new Schema<IMetaGlobalIntegration>(
  {
    key: { type: String, required: true, unique: true, default: "facebook-profile" },
    encryptedAccessToken: { type: String, required: true },
    facebookUserId: { type: String, required: true },
    facebookUserName: { type: String, required: true },
    expiresAt: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

export const MetaGlobalIntegrationModel = model<IMetaGlobalIntegration>(
  "MetaGlobalIntegration",
  MetaGlobalIntegrationSchema
);
