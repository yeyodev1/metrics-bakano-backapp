import { Schema, model, Document, Types } from "mongoose";

/**
 * Bitacora liviana de lo que hace Bakano por cada cliente: quien hizo que y
 * cuando. Los estados de los items se sobreescriben; esto no. Es la base del
 * reporte semanal (que se hizo y cuanto tardo cada cosa).
 *
 * Solo los momentos clave, no cada guardado: un guion escrito, aprobado o
 * corregido, una produccion realizada, un video subido, corregido o aprobado,
 * una entrega de archivos.
 */
export const TIPOS_ACTIVIDAD = [
  "guion_escrito",
  "guion_aprobado",
  "guion_corregido",
  "produccion_realizada",
  "video_subido",
  "video_revisado_interno",
  "video_corregido",
  "video_aprobado",
  "video_publicado",
  "entrega_archivos",
] as const;
export type TipoActividad = (typeof TIPOS_ACTIVIDAD)[number];

export interface IActividad extends Document {
  workspaceId: Types.ObjectId;
  tipo: TipoActividad;
  /** Quien lo hizo: alguien del equipo o el cliente. */
  actorId?: Types.ObjectId;
  actorNombre?: string;
  esCliente?: boolean;
  planningId?: Types.ObjectId;
  itemId?: Types.ObjectId;
  numero?: number;
  tema?: string;
  detalle?: string;
  en: Date;
  createdAt: Date;
}

const ActividadSchema = new Schema<IActividad>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    tipo: { type: String, enum: TIPOS_ACTIVIDAD, required: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorNombre: { type: String, trim: true },
    esCliente: { type: Boolean, default: false },
    planningId: { type: Schema.Types.ObjectId, ref: "VideoPlanning" },
    itemId: { type: Schema.Types.ObjectId },
    numero: { type: Number },
    tema: { type: String, trim: true },
    detalle: { type: String, trim: true, maxlength: 500 },
    en: { type: Date, default: Date.now },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

// El reporte barre por cliente y semana.
ActividadSchema.index({ workspaceId: 1, en: -1 });
ActividadSchema.index({ en: -1 });

export const ActividadModel = model<IActividad>("Actividad", ActividadSchema, "actividades");
