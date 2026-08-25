import { Schema, model, Document, Types } from "mongoose";

/**
 * Meta mensual de facturacion por cliente. Vive aparte del workspace porque es
 * un dato con historia: la meta de marzo no se pisa cuando se define la de
 * abril, y al cerrar el mes queremos poder comparar meta vs facturado real.
 */
export interface IMonthlyTarget extends Document {
  workspaceId: Types.ObjectId;
  /** Anio calendario, cuatro digitos. */
  year: number;
  /** Mes 1-12 (no 0-indexado: se guarda como lo escribe la gente). */
  month: number;
  targetAmount: number;
  /** Meta ambiciosa opcional. Solo pinta la barra, no cambia el % principal. */
  stretchAmount?: number;
  notes?: string;
  setBy: {
    userId: Types.ObjectId;
    name: string;
    email: string;
  };
  /**
   * "manual" la escribio alguien; "carryover" la copio el sistema desde el mes
   * anterior para que ningun cliente arranque el mes sin meta.
   */
  source: "manual" | "carryover";
  createdAt: Date;
  updatedAt: Date;
}

const MonthlyTargetSchema = new Schema<IMonthlyTarget>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    year: { type: Number, required: true, min: 2020 },
    month: { type: Number, required: true, min: 1, max: 12 },
    targetAmount: { type: Number, required: true, min: 0 },
    stretchAmount: { type: Number, min: 0 },
    notes: { type: String, trim: true },
    setBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
      name: { type: String, required: true, trim: true },
      email: { type: String, required: true, trim: true },
    },
    source: { type: String, enum: ["manual", "carryover"], default: "manual" },
  },
  { timestamps: true, versionKey: false }
);

// Una sola meta por cliente y mes: si se corrige, se actualiza la misma.
MonthlyTargetSchema.index({ workspaceId: 1, year: 1, month: 1 }, { unique: true });

export const MonthlyTargetModel = model<IMonthlyTarget>("MonthlyTarget", MonthlyTargetSchema);
