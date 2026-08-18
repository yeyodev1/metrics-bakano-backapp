import { Schema, model, Document, Types } from "mongoose";

/**
 * Log inmutable de aprobaciones y rechazos por etapa.
 *
 * Los estados de un item (`estadoIdea`, `edicion`, `clienteAprobacion`) se
 * sobreescriben: un guion rechazado que luego se aprueba deja de ser visible
 * como rechazo. Los dashboards de banderas necesitan la historia completa —
 * "12 guiones rechazados este mes" — asi que cada transicion a APROBADO o
 * RECHAZADO queda registrada aqui y nunca se edita.
 */
export type EtapaRevision = "contenido" | "edicion";
export type ResultadoRevision = "aprobado" | "rechazado";
export type FuenteRevision = "interno" | "cliente";

export const MOTIVO_CATEGORIAS = [
  "ortografia",
  "tono_incorrecto",
  "gancho_debil",
  "estructura",
  "informacion_incorrecta",
  "calidad_video",
  "ritmo_edicion",
  "audio_musica",
  "subtitulos",
  "otro",
] as const;
export type MotivoCategoria = (typeof MOTIVO_CATEGORIAS)[number];

/**
 * Clasifica un motivo de rechazo escrito en texto libre.
 *
 * Los rechazos llegan como texto (del cliente o del PM); el dashboard de
 * motivos necesita categorias contables. Sin esto todo caeria en "otro" y
 * "Faltas de ortografia (15 veces)" seria imposible de mostrar.
 */
export function inferMotivoCategoria(motivo?: string | null): MotivoCategoria {
  const texto = (motivo || "").toLowerCase();
  if (!texto.trim()) return "otro";
  if (/ortograf|tilde|mal escrit|falta.*orto/.test(texto)) return "ortografia";
  if (/\btono\b|muy formal|muy informal|no suena/.test(texto)) return "tono_incorrecto";
  if (/gancho|\bhook\b|no engancha|arranque|inicio flojo/.test(texto)) return "gancho_debil";
  if (/estructura|formato|orden de|no sigue/.test(texto)) return "estructura";
  if (/informaci|dato err|precio|incorrect|equivocad|no es cierto/.test(texto))
    return "informacion_incorrecta";
  if (/calidad|borros|pixel|resoluci|iluminaci|desenfoc/.test(texto)) return "calidad_video";
  if (/ritmo|muy largo|muy lento|cortes|duraci|aburrid/.test(texto)) return "ritmo_edicion";
  if (/audio|music|sonido|volumen|voz/.test(texto)) return "audio_musica";
  if (/subtitul|caption|texto en pantalla/.test(texto)) return "subtitulos";
  return "otro";
}

export interface IReviewEvent extends Document {
  workspaceId: Types.ObjectId;
  planningId: Types.ObjectId;
  videoItemId: Types.ObjectId;
  /** Denormalizado: el item puede borrarse y el evento debe seguir legible. */
  videoTema?: string;

  etapa: EtapaRevision;
  resultado: ResultadoRevision;
  fuente: FuenteRevision;

  /** El colaborador responsable del entregable evaluado (content o editor). */
  responsableId?: Types.ObjectId;
  responsableNombre?: string;
  /** Quien registro la decision (PM, cliente, etc.). */
  actorId?: Types.ObjectId;
  actorNombre?: string;

  motivo?: string;
  motivoCategoria?: MotivoCategoria;

  /** Sintetizado desde el estado actual por el script de backfill. */
  backfilled?: boolean;

  createdAt: Date;
  updatedAt: Date;
}

const ReviewEventSchema = new Schema<IReviewEvent>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    planningId: {
      type: Schema.Types.ObjectId,
      ref: "VideoPlanning",
      required: true,
    },
    videoItemId: { type: Schema.Types.ObjectId, required: true },
    videoTema: { type: String, trim: true },

    etapa: {
      type: String,
      enum: ["contenido", "edicion"],
      required: true,
    },
    resultado: {
      type: String,
      enum: ["aprobado", "rechazado"],
      required: true,
    },
    fuente: {
      type: String,
      enum: ["interno", "cliente"],
      default: "interno",
    },

    responsableId: { type: Schema.Types.ObjectId, ref: "User" },
    responsableNombre: { type: String, trim: true },
    actorId: { type: Schema.Types.ObjectId, ref: "User" },
    actorNombre: { type: String, trim: true },

    motivo: { type: String, trim: true, maxlength: 2000 },
    motivoCategoria: { type: String, enum: MOTIVO_CATEGORIAS },

    backfilled: { type: Boolean, default: false },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

ReviewEventSchema.index({ workspaceId: 1, etapa: 1, createdAt: -1 });
ReviewEventSchema.index({ responsableId: 1, createdAt: -1 });
ReviewEventSchema.index({ createdAt: -1 });

export const ReviewEventModel = model<IReviewEvent>(
  "ReviewEvent",
  ReviewEventSchema
);
