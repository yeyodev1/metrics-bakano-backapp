import { Schema, model, Document, Types } from "mongoose";

export interface IBrandProfileFile {
  nombre: string;
  url: string;
  publicId: string;
  tipo: string;
  geminiFileUri?: string;
  geminiFileMimeType?: string;
}

export interface IBrandProfile {
  descripcion: string;
  tipoNegocio?: "SERVICIOS" | "PRODUCTOS";
  vertical: string;
  publicoObjetivo?: string;
  propuestaValor?: string;
  tono?: string;
  productosServicios?: string;
  problemaResuelto?: string;
  trafficDirection?: "WHATSAPP" | "GHL";
  trafficLink: string;
  archivos: IBrandProfileFile[];
  updatedAt?: Date;
}

export interface IOnboardingStatus {
  videoGenesisAccepted: boolean;
  contractSubmitted: boolean;
  meetingScheduled: boolean;
}

export interface IWorkspace extends Document {
  name: string;
  adminId?: Types.ObjectId;
  isActive: boolean;
  metaAds?: {
    accessToken: string; // Long-lived user token
    pageAccessToken?: string; // Token específico de la página
    pageId: string;
    pageName: string;
    adAccountId?: string;
    adAccountName?: string;
    lastSyncedAt: Date;
  };
  brandProfile?: IBrandProfile;
  brandProfileInviteSentAt?: Date;
  onboardingStatus?: IOnboardingStatus;
  preNegotiatedContract?: any; // Stores predefined contract parameters
  contractData?: any; // Stores the final contract form and signature
  teamInfo?: {
    teamName: string;
    teamVideoUrl: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

const BrandProfileFileSchema = new Schema(
  {
    nombre: { type: String, required: true, trim: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    tipo: { type: String, required: true },
    geminiFileUri: { type: String },
    geminiFileMimeType: { type: String },
  },
  { _id: false }
);

const BrandProfileSchema = new Schema(
  {
    descripcion: { type: String, trim: true, default: "" },
    tipoNegocio: {
      type: String,
      enum: ["SERVICIOS", "PRODUCTOS"],
    },
    vertical: { type: String, trim: true, default: "" },
    publicoObjetivo: { type: String, trim: true },
    propuestaValor: { type: String, trim: true },
    tono: { type: String, trim: true },
    productosServicios: { type: String, trim: true },
    problemaResuelto: { type: String, trim: true },
    trafficDirection: {
      type: String,
      enum: ["WHATSAPP", "GHL"],
    },
    trafficLink: { type: String, trim: true, default: "" },
    archivos: { type: [BrandProfileFileSchema], default: [] },
    updatedAt: { type: Date },
  },
  { _id: false }
);

const WorkspaceSchema = new Schema<IWorkspace>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    adminId: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    metaAds: {
      accessToken: String,
      pageAccessToken: String,
      pageId: String,
      pageName: String,
      adAccountId: String,
      adAccountName: String,
      lastSyncedAt: Date,
    },
    brandProfile: {
      type: BrandProfileSchema,
      default: null,
    },
    brandProfileInviteSentAt: {
      type: Date,
      default: null,
    },
    onboardingStatus: {
      type: {
        videoGenesisAccepted: { type: Boolean, default: false },
        contractSubmitted: { type: Boolean, default: false },
        meetingScheduled: { type: Boolean, default: false },
      },
      default: {
        videoGenesisAccepted: false,
        contractSubmitted: false,
        meetingScheduled: false,
      },
    },
    preNegotiatedContract: {
      type: Schema.Types.Mixed,
      default: null,
    },
    contractData: {
      type: Schema.Types.Mixed,
      default: null,
    },
    teamInfo: {
      teamName: { type: String, trim: true },
      teamVideoUrl: { type: String, trim: true },
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const WorkspaceModel = model<IWorkspace>("Workspace", WorkspaceSchema);
