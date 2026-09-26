import { Schema, model, Document, Types } from "mongoose";

/**
 * El CRM (GoHighLevel) propio de un cliente, conectado desde su entorno.
 *
 * Bakano tiene su propio CRM con tokens globales (ghl.service.ts); esto es
 * otra cosa: la location del cliente, con un Private Integration Token que
 * nos da el. Con eso se revisan sus conversaciones y oportunidades cada dia.
 *
 * `tokenCifrado` va con AES-256-GCM (CRM_TOKEN_SECRET) y nunca sale por la
 * API: para mostrarlo solo se usa `tokenFinal` (ultimos 4 caracteres).
 */
export type EstadoCrm = "conectado" | "error";
export type EstadoWhatsappCrm = "conectado" | "no_detectado" | "desconocido";

export interface PermisosCrm {
  conversaciones: boolean;
  mensajes: boolean;
  oportunidades: boolean;
  contactos: boolean;
}

export interface ICrmIntegration extends Document {
  workspaceId: Types.ObjectId;
  proveedor: "gohighlevel";
  locationId: string;
  tokenCifrado: string;
  tokenFinal: string;
  estado: EstadoCrm;
  permisos: PermisosCrm;
  whatsapp: EstadoWhatsappCrm;
  conectadoPor: {
    userId: Types.ObjectId;
    nombre: string;
    esEquipo: boolean;
    en: Date;
  } | null;
  ultimaRevision: Date | null;
  ultimoError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const CrmIntegrationSchema = new Schema<ICrmIntegration>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, unique: true },
    proveedor: { type: String, enum: ["gohighlevel"], default: "gohighlevel" },
    locationId: { type: String, required: true, trim: true },
    // select: false: ni por descuido se devuelve en una consulta cualquiera.
    tokenCifrado: { type: String, required: true, select: false },
    tokenFinal: { type: String, required: true },
    estado: { type: String, enum: ["conectado", "error"], default: "conectado" },
    permisos: {
      conversaciones: { type: Boolean, default: false },
      mensajes: { type: Boolean, default: false },
      oportunidades: { type: Boolean, default: false },
      contactos: { type: Boolean, default: false },
    },
    whatsapp: { type: String, enum: ["conectado", "no_detectado", "desconocido"], default: "desconocido" },
    conectadoPor: {
      type: new Schema(
        {
          userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
          nombre: { type: String, default: "" },
          esEquipo: { type: Boolean, default: false },
          en: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: null,
    },
    ultimaRevision: { type: Date, default: null },
    ultimoError: { type: String, default: null },
  },
  { timestamps: true, versionKey: false }
);

CrmIntegrationSchema.index({ estado: 1 });

export const CrmIntegrationModel = model<ICrmIntegration>("CrmIntegration", CrmIntegrationSchema, "crmintegrations");
