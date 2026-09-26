import { Schema, model, Document, Types } from "mongoose";

/**
 * Constancia de la revision diaria del CRM de un cliente: una por entorno y
 * dia. Sirve de candado (el cron corre varias veces en la mañana y sigue por
 * donde quedo) y de historial de que se miro.
 */
export interface ICrmRevision extends Document {
  workspaceId: Types.ObjectId;
  /** "YYYY-MM-DD" en hora de Ecuador. */
  dia: string;
  /** en_curso mientras corre; terminada u omitida al final. */
  estadoRevision: "en_curso" | "terminada" | "fallida";
  iniciadaEn: Date;
  terminadaEn: Date | null;
  /** Veces que se intento hoy: una corrida sin tiempo o un error se reintenta hasta 3. */
  intentos: number;
  conversaciones: number;
  oportunidades: number;
  hallazgos: number;
  whatsapp: "conectado" | "no_detectado" | "desconocido";
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CrmRevisionSchema = new Schema<ICrmRevision>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    dia: { type: String, required: true },
    estadoRevision: { type: String, enum: ["en_curso", "terminada", "fallida"], default: "en_curso" },
    iniciadaEn: { type: Date, required: true },
    terminadaEn: { type: Date, default: null },
    intentos: { type: Number, default: 0 },
    conversaciones: { type: Number, default: 0 },
    oportunidades: { type: Number, default: 0 },
    hallazgos: { type: Number, default: 0 },
    whatsapp: { type: String, enum: ["conectado", "no_detectado", "desconocido"], default: "desconocido" },
    error: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

CrmRevisionSchema.index({ workspaceId: 1, dia: 1 }, { unique: true });

export const CrmRevisionModel = model<ICrmRevision>("CrmRevision", CrmRevisionSchema, "crmrevisiones");
