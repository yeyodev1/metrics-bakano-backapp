import { Schema, model, Document, Types } from "mongoose";

/**
 * Lo que encontro la revision diaria del CRM del cliente: ventas que se le
 * estaban cayendo de las manos. Lo lee el bot (aviso al cliente) y tambien
 * otros servicios directo de Mongo (`leidoPorLucasEn`).
 *
 * No se duplica: un mismo lead (conversacion u oportunidad) da como mucho un
 * hallazgo de cada tipo.
 */
export type TipoHallazgoCrm = "cierre_casi_solo" | "lead_sin_respuesta" | "oportunidad_estancada";
export type CanalHallazgoCrm = "whatsapp" | "sms" | "instagram" | "facebook" | "otro" | "oportunidad";

export interface ICrmHallazgo extends Document {
  workspaceId: Types.ObjectId;
  /** "YYYY-MM-DD" en hora de Ecuador: el dia de la revision que lo encontro. */
  dia: string;
  tipo: TipoHallazgoCrm;
  canal: CanalHallazgoCrm;
  contacto: { nombre: string | null; telefono: string | null; email: string | null };
  /** Que dijo o dio el lead. */
  resumen: string;
  porQueEsCierre: string;
  queHacer: string;
  /** Texto listo para que el cliente se lo mande al lead. */
  mensajeSugerido: string;
  monto: number | null;
  conversationId: string | null;
  opportunityId: string | null;
  avisadoClienteEn: Date | null;
  leidoPorLucasEn: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CrmHallazgoSchema = new Schema<ICrmHallazgo>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    dia: { type: String, required: true },
    tipo: { type: String, enum: ["cierre_casi_solo", "lead_sin_respuesta", "oportunidad_estancada"], required: true },
    canal: { type: String, enum: ["whatsapp", "sms", "instagram", "facebook", "otro", "oportunidad"], default: "otro" },
    contacto: {
      nombre: { type: String, default: null },
      telefono: { type: String, default: null },
      email: { type: String, default: null },
    },
    resumen: { type: String, default: "" },
    porQueEsCierre: { type: String, default: "" },
    queHacer: { type: String, default: "" },
    mensajeSugerido: { type: String, default: "" },
    monto: { type: Number, default: null },
    conversationId: { type: String, default: null },
    opportunityId: { type: String, default: null },
    avisadoClienteEn: { type: Date, default: null },
    leidoPorLucasEn: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false }
);

// Sin duplicados: uno por (entorno, conversacion u oportunidad, tipo).
CrmHallazgoSchema.index(
  { workspaceId: 1, conversationId: 1, tipo: 1 },
  { unique: true, partialFilterExpression: { conversationId: { $type: "string" } } }
);
CrmHallazgoSchema.index(
  { workspaceId: 1, opportunityId: 1, tipo: 1 },
  { unique: true, partialFilterExpression: { opportunityId: { $type: "string" } } }
);
CrmHallazgoSchema.index({ workspaceId: 1, dia: -1 });

export const CrmHallazgoModel = model<ICrmHallazgo>("CrmHallazgo", CrmHallazgoSchema, "crmhallazgos");
