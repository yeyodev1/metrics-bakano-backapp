import { Schema, model, Document, Types } from "mongoose";

// ── Enums ──────────────────────────────────────────────────────────────────
export type EstadoIdea = "APROBADO" | "POR_REVISAR" | "RECHAZADO";
export type EstadoProduccion = "GRABADO" | "POR_GRABAR" | "RECHAZADO";
export type EstadoEdicion = "EDITADO" | "POR_EDITAR" | "RECHAZADO";
export type EstadoPublicacion = "PROGRAMADO" | "PUBLICADO" | "POR_PUBLICAR" | "-";
export type ClienteAprobacion = "PENDIENTE" | "APROBADO" | "RECHAZADO";
export type TipoGuion = "TOFU" | "MOFU" | "BOFU";

// ── GuionIA subdocument ────────────────────────────────────────────────────
export interface IGuionIA {
  conceptoVisual: string;
  gancho: string;
  textoPantalla: string;
  cuerpo: string;
  cta: string;
  broll: string;
  generadoEn?: Date;
  contextoMes?: {
    productoMes?: string;
    ofertaEspecial?: string;
    referenciasAdicionales?: string;
  };
}

// ── VideoItem subdocument ──────────────────────────────────────────────────
export interface IVideoItem {
  _id: Types.ObjectId;
  numero: number;
  tema: string;
  descripcion?: string;
  tipo?: string;
  linkEjemplo?: string;
  recursos?: string;
  lugarGrabacion?: string;
  guion?: string;
  tipoGuion?: TipoGuion;
  guionIA?: IGuionIA;
  estadoIdea: EstadoIdea;
  estadoProduccion: EstadoProduccion;
  edicion: EstadoEdicion;
  estadoPublicacion: EstadoPublicacion;
  comentario?: string;
  clienteAprobacion: ClienteAprobacion;
  motivoRechazo?: string;
  linkVideo?: string;
  fechaPublicacion?: Date;
  copyPublicacion?: string;
  order: number;
}

const GuionIASchema = new Schema(
  {
    conceptoVisual: { type: String, trim: true, default: "" },
    gancho: { type: String, trim: true, default: "" },
    textoPantalla: { type: String, trim: true, default: "" },
    cuerpo: { type: String, trim: true, default: "" },
    cta: { type: String, trim: true, default: "" },
    broll: { type: String, trim: true, default: "" },
    generadoEn: { type: Date },
    contextoMes: {
      productoMes: { type: String, trim: true },
      ofertaEspecial: { type: String, trim: true },
      referenciasAdicionales: { type: String, trim: true },
    },
  },
  { _id: false }
);

const VideoItemSchema = new Schema<IVideoItem>(
  {
    numero: { type: Number, required: true },
    tema: { type: String, required: true, trim: true },
    descripcion: { type: String, trim: true },
    tipo: { type: String, trim: true },
    linkEjemplo: { type: String, trim: true },
    recursos: { type: String, trim: true },
    lugarGrabacion: { type: String, trim: true },
    guion: { type: String },
    tipoGuion: {
      type: String,
      enum: ["TOFU", "MOFU", "BOFU"],
    },
    guionIA: { type: GuionIASchema },
    estadoIdea: {
      type: String,
      enum: ["APROBADO", "POR_REVISAR", "RECHAZADO"],
      default: "POR_REVISAR",
    },
    estadoProduccion: {
      type: String,
      enum: ["GRABADO", "POR_GRABAR", "RECHAZADO"],
      default: "POR_GRABAR",
    },
    edicion: {
      type: String,
      enum: ["EDITADO", "POR_EDITAR", "RECHAZADO"],
      default: "POR_EDITAR",
    },
    estadoPublicacion: {
      type: String,
      enum: ["PROGRAMADO", "PUBLICADO", "POR_PUBLICAR", "-"],
      default: "POR_PUBLICAR",
    },
    comentario: { type: String, trim: true },
    clienteAprobacion: {
      type: String,
      enum: ["PENDIENTE", "APROBADO", "RECHAZADO"],
      default: "PENDIENTE",
    },
    motivoRechazo: { type: String, trim: true },
    linkVideo: { type: String, trim: true },
    fechaPublicacion: { type: Date },
    copyPublicacion: { type: String, trim: true },
    order: { type: Number, default: 0 },
  },
  { _id: true }
);

// ── VideoPlanning document ─────────────────────────────────────────────────
export interface IVideoPlanning extends Document {
  planningEntryId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  items: IVideoItem[];
  clienteAprobado: boolean;
  clienteAprobadoAt?: Date;
  clienteAprobadoPor?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const VideoPlanningSchema = new Schema<IVideoPlanning>(
  {
    planningEntryId: {
      type: Schema.Types.ObjectId,
      ref: "Planning",
      required: true,
      unique: true,
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    items: { type: [VideoItemSchema], default: [] },
    clienteAprobado: { type: Boolean, default: false },
    clienteAprobadoAt: { type: Date },
    clienteAprobadoPor: { type: Schema.Types.ObjectId, ref: "User" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

VideoPlanningSchema.index({ workspaceId: 1 });
VideoPlanningSchema.index({ workspaceId: 1, "items.fechaPublicacion": 1 });

export const VideoPlanningModel = model<IVideoPlanning>(
  "VideoPlanning",
  VideoPlanningSchema
);
