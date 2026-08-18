import { Schema, model, Document, Types } from "mongoose";

export interface IBrandProfileFile {
  nombre: string;
  url: string;
  publicId: string;
  tipo: string;
  geminiFileUri?: string;
  geminiFileMimeType?: string;
}

export interface ICustomerJourneyCase {
  casoNumero: number;
  nombreCaso?: string;
  potencialCliente: string;
  efectoAnuncio: string;
  accionEsperada: string;
}

export interface ISegmentoMercado {
  nombre: string;
  descripcion: string;
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
  segmentosMercado?: ISegmentoMercado[];
  canalesDetail?: string[];
  actividadesClave?: string[];
  customerJourneyCases?: ICustomerJourneyCase[];
  updatedAt?: Date;
}

export interface IResource {
  nombre: string;
  url: string;
  publicId: string;
  tipo: string;
  categoria: "logo" | "linea_grafica" | "catalogo" | "otro";
  uploadedBy: Types.ObjectId;
  createdAt: Date;
}

export interface IOnboardingStatus {
  videoGenesisAccepted: boolean;
  contractSubmitted: boolean;
  resourcesCompleted: boolean;
  meetingScheduled: boolean;
}

export interface IWorkspace extends Document {
  name: string;
  adminId?: Types.ObjectId;
  isActive: boolean;
  /**
   * Por que se desactivo, quien lo hizo y cuando. Antes un entorno inactivo no
   * dejaba rastro: nadie podia saber si era falta de pago, fin de contrato o
   * una pausa acordada sin preguntar por WhatsApp.
   */
  desactivacion?: {
    motivo: "falta_de_pago" | "fin_de_contrato" | "pausa_acordada" | "otro";
    nota?: string;
    fecha: Date;
    porNombre?: string;
  };
  metaAds?: {
    accessToken: string; // Long-lived user token
    pageAccessToken?: string; // Token específico de la página
    pageId: string;
    pageName: string;
    adAccountId?: string;
    adAccountName?: string;
    instagramAccountId?: string;
    instagramAccountName?: string;
    pictureUrl?: string;
    lastSyncedAt: Date;
  };
  brandProfile?: IBrandProfile;
  brandProfileInviteSentAt?: Date;
  resources?: IResource[];
  onboardingStatus?: IOnboardingStatus;
  preNegotiatedContract?: any; // Stores predefined contract parameters
  contractData?: any; // Stores the final contract form and signature
  teamInfo?: {
    teamName: string;
    teamVideoUrl: string;
  };
  /**
   * Carpeta del cliente en la unidad compartida de Drive. Se crea en la
   * primera entrega y se le aplica "cualquiera con el enlace puede ver";
   * nunca se borra, ni aunque el workspace se desactive.
   */
  driveFolderId?: string;
  driveFolderLink?: string;
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

const ResourceSchema = new Schema(
  {
    nombre: { type: String, required: true, trim: true },
    url: { type: String, required: true },
    publicId: { type: String, required: true },
    tipo: { type: String, required: true },
    categoria: {
      type: String,
      enum: ["logo", "linea_grafica", "otro"],
      required: true,
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const CustomerJourneyCaseSchema = new Schema(
  {
    casoNumero: { type: Number, required: true },
    nombreCaso: { type: String, trim: true },
    potencialCliente: { type: String, trim: true, default: "" },
    efectoAnuncio: { type: String, trim: true, default: "" },
    accionEsperada: { type: String, trim: true, default: "" },
  },
  { _id: false }
);

const SegmentoMercadoSchema = new Schema(
  {
    nombre: { type: String, trim: true, required: true },
    descripcion: { type: String, trim: true, default: "" },
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
    segmentosMercado: { type: [SegmentoMercadoSchema], default: [] },
    canalesDetail: { type: [String], default: [] },
    actividadesClave: { type: [String], default: [] },
    customerJourneyCases: { type: [CustomerJourneyCaseSchema], default: [] },
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
    desactivacion: {
      type: {
        motivo: {
          type: String,
          enum: ["falta_de_pago", "fin_de_contrato", "pausa_acordada", "otro"],
          required: true,
        },
        nota: { type: String, trim: true },
        fecha: { type: Date, default: Date.now },
        porNombre: { type: String, trim: true },
      },
      default: null,
    },
    metaAds: {
      accessToken: String,
      pageAccessToken: String,
      pageId: String,
      pageName: String,
      adAccountId: String,
      adAccountName: String,
      instagramAccountId: String,
      instagramAccountName: String,
      pictureUrl: String,
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
    resources: {
      type: [ResourceSchema],
      default: [],
    },
    onboardingStatus: {
      type: {
        videoGenesisAccepted: { type: Boolean, default: false },
        contractSubmitted: { type: Boolean, default: false },
        resourcesCompleted: { type: Boolean, default: false },
        meetingScheduled: { type: Boolean, default: false },
      },
      default: {
        videoGenesisAccepted: false,
        contractSubmitted: false,
        resourcesCompleted: false,
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
    driveFolderId: { type: String, trim: true },
    driveFolderLink: { type: String, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const WorkspaceModel = model<IWorkspace>("Workspace", WorkspaceSchema);
