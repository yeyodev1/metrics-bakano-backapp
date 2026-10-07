import { Schema, model, Document, Types } from "mongoose";

/**
 * Candado y registro del reporte semanal: uno por cliente y semana (y uno
 * consolidado para direccion, con workspaceId null). Si ya existe, no se
 * reenvia: el cron corre varias veces el viernes para alcanzar a todos.
 */
export interface IReporteSemanal extends Document {
  /** Viernes del reporte, fecha de Ecuador: "2026-10-09". */
  semana: string;
  workspaceId: Types.ObjectId | null;
  estado: "enviado" | "omitido" | "fallido";
  telegram: number;
  correos: number;
  motivo?: string;
  /** Lo que se le mando (y sus mediciones): el consolidado se arma de aqui. */
  datos?: unknown;
  enviadoEn: Date;
}

const ReporteSemanalSchema = new Schema<IReporteSemanal>(
  {
    semana: { type: String, required: true },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    estado: { type: String, enum: ["enviado", "omitido", "fallido"], required: true },
    telegram: { type: Number, default: 0 },
    correos: { type: Number, default: 0 },
    motivo: { type: String, trim: true },
    datos: { type: Schema.Types.Mixed },
    enviadoEn: { type: Date, default: Date.now },
  },
  { timestamps: false, versionKey: false }
);

ReporteSemanalSchema.index({ semana: 1, workspaceId: 1 }, { unique: true });

export const ReporteSemanalModel = model<IReporteSemanal>("ReporteSemanal", ReporteSemanalSchema, "reportessemanales");
