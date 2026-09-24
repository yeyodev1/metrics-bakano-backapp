import { Schema, model, Document, Types } from "mongoose";

/**
 * Cada cosa que un cliente hace en el bot.
 *
 * Sin esto solo sabiamos cuantos se conectaron, que no dice nada: importa si
 * lo usan, para que, y que se queda sin tocar. Se guarda siempre, un registro
 * por interaccion, y de ahi salen el reporte semanal y las mejoras.
 */
export interface IUsoBot extends Document {
  workspaceId?: Types.ObjectId;
  userId?: Types.ObjectId;
  chatId: number;
  /** "menu:onboarding", "citas:ver", "mensaje", "ia:verMisCitas"… */
  accion: string;
  /** Como llego: boton del menu, texto libre o una herramienta de la IA. */
  origen: "boton" | "texto" | "ia";
  detalle?: string;
  en: Date;
}

const UsoBotSchema = new Schema<IUsoBot>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace" },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    chatId: { type: Number, required: true },
    accion: { type: String, required: true, trim: true, maxlength: 120 },
    origen: { type: String, enum: ["boton", "texto", "ia"], required: true },
    detalle: { type: String, trim: true, maxlength: 500 },
    en: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

UsoBotSchema.index({ en: -1 });
UsoBotSchema.index({ workspaceId: 1, en: -1 });
UsoBotSchema.index({ accion: 1, en: -1 });

export const UsoBotModel = model<IUsoBot>("UsoBot", UsoBotSchema);
