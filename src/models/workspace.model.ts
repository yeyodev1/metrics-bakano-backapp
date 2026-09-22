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

/**
 * Una de las tres sesiones tecnicas del onboarding (Meta, CRM, Estrategia).
 * El cliente la agenda por el bot o por el link del CRM; el cron reconoce las
 * del link y las marca igual, para que el estado nunca mienta.
 */
/**
 * Avance de una sesion. Lo mueve el responsable desde Metrics: "cumplida"
 * cuando ya la dio, "bloqueada" cuando algo no deja avanzar (y ahi el motivo
 * es obligatorio, que es justo lo que antes se perdia en conversaciones).
 */
export type EstadoSesionOnboarding = "pendiente" | "agendada" | "cumplida" | "bloqueada" | "no_aplica";

export interface ISesionOnboarding {
  agendada: boolean;
  fecha?: Date;
  appointmentId?: string;
  agendadoEn?: Date;
  origen?: "telegram" | "link";
  /** Cuando se aviso al responsable, para no repetir el aviso. */
  avisadoEn?: Date;

  estado?: EstadoSesionOnboarding;
  /** Por que no avanza. Obligatorio al marcar "bloqueada". */
  motivo?: string;
  /** Que se hizo o que sigue, en palabras del responsable. */
  nota?: string;
  /** Que se le pide al cliente; el bot se lo puede recordar por Telegram. */
  pendienteDelCliente?: string;
  actualizadoPorId?: Types.ObjectId;
  actualizadoPorNombre?: string;
  actualizadoEn?: Date;
  /** Ultimo recordatorio enviado al cliente, para no repetirlo. */
  recordatorioEn?: Date;
}

export interface IOnboardingSesiones {
  meta?: ISesionOnboarding;
  crm?: ISesionOnboarding;
  estrategia?: ISesionOnboarding;
}

const SesionOnboardingSchema = new Schema<ISesionOnboarding>(
  {
    agendada: { type: Boolean, default: false },
    fecha: { type: Date },
    appointmentId: { type: String },
    agendadoEn: { type: Date },
    origen: { type: String, enum: ["telegram", "link"] },
    avisadoEn: { type: Date },
    estado: { type: String, enum: ["pendiente", "agendada", "cumplida", "bloqueada", "no_aplica"], default: "pendiente" },
    motivo: { type: String, trim: true, maxlength: 1000 },
    nota: { type: String, trim: true, maxlength: 1000 },
    pendienteDelCliente: { type: String, trim: true, maxlength: 500 },
    actualizadoPorId: { type: Schema.Types.ObjectId, ref: "User" },
    actualizadoPorNombre: { type: String, trim: true },
    actualizadoEn: { type: Date },
    recordatorioEn: { type: Date },
  },
  { _id: false }
);

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
  onboardingSesiones?: IOnboardingSesiones;
  /** Correo de arranque del onboarding (el que manda al bot de Telegram). */
  onboardingBienvenidaEnviadaEn?: Date;
  /**
   * Envios del onboarding (logos, facturacion, catalogo, invitacion a Meta).
   * El cliente los "declara" por el bot; el responsable los verifica.
   */
  onboardingEntregables?: Record<string, { estado: "pendiente" | "declarado" | "verificado"; declaradoEn?: Date; nota?: string }>;
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
      // "catalogo" faltaba y el controlador si lo aceptaba: subir el catalogo
      // reventaba al guardar por validacion del enum.
      enum: ["logo", "linea_grafica", "catalogo", "otro"],
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
    onboardingSesiones: {
      type: {
        meta: { type: SesionOnboardingSchema, default: undefined },
        crm: { type: SesionOnboardingSchema, default: undefined },
        estrategia: { type: SesionOnboardingSchema, default: undefined },
      },
      default: undefined,
    },
    onboardingBienvenidaEnviadaEn: {
      type: Date,
      default: null,
    },
    onboardingEntregables: {
      type: Schema.Types.Mixed,
      default: undefined,
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
