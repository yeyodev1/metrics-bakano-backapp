import { Schema, model, Document, Types } from "mongoose";
import type { EstadoSesionOnboarding } from "./workspace.model";

/**
 * Bitacora del onboarding: cada vez que alguien mueve una sesion queda quien,
 * cuando, a que estado y por que. El estado actual vive en el workspace; aqui
 * queda la historia, que es lo que permite responder "por que no avanzo esto".
 */
/**
 * Pasos del onboarding. Los tres primeros son el proceso nuevo; meta, crm y
 * estrategia son los del anterior y se conservan para no perder el historial
 * de los clientes que pasaron por ahi.
 */
export type PasoOnboarding =
  | "bienvenida"
  | "especializacion"
  | "levantamiento"
  | "produccion"
  | "meta"
  | "crm"
  | "estrategia";

export interface IOnboardingEvento extends Document {
  workspaceId: Types.ObjectId;
  paso: PasoOnboarding;
  estado: EstadoSesionOnboarding;
  motivo?: string;
  nota?: string;
  pendienteDelCliente?: string;
  /** "equipo" lo marco una persona; "sistema" lo movio el bot o el cron. */
  origen: "equipo" | "sistema";
  porId?: Types.ObjectId;
  porNombre?: string;
  createdAt: Date;
  updatedAt: Date;
}

const OnboardingEventoSchema = new Schema<IOnboardingEvento>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    paso: { type: String, enum: ["meta", "crm", "estrategia", "produccion"], required: true },
    estado: { type: String, enum: ["pendiente", "agendada", "cumplida", "bloqueada", "no_aplica"], required: true },
    motivo: { type: String, trim: true, maxlength: 1000 },
    nota: { type: String, trim: true, maxlength: 1000 },
    pendienteDelCliente: { type: String, trim: true, maxlength: 500 },
    origen: { type: String, enum: ["equipo", "sistema"], default: "equipo" },
    porId: { type: Schema.Types.ObjectId, ref: "User" },
    porNombre: { type: String, trim: true },
  },
  { timestamps: true, versionKey: false }
);

OnboardingEventoSchema.index({ workspaceId: 1, createdAt: -1 });

export const OnboardingEventoModel = model<IOnboardingEvento>("OnboardingEvento", OnboardingEventoSchema);
