import { Schema, model, Document, Types } from "mongoose";

/**
 * El MCP del equipo (mcp.bakano.ec) se conecta con OAuth: Claude registra una
 * app, abre el navegador, la persona pone su correo y confirma con un enlace
 * mágico. Aquí vive todo eso. Nada se guarda en claro: códigos, enlaces y
 * tokens van con su sha256, así quien lea la base no puede usarlos.
 *
 * Serverless no guarda nada en memoria entre llamadas, por eso cada paso del
 * flujo queda en Mongo.
 */

/** Una app que se registró sola (Claude Desktop, claude.ai, Claude Code...). */
export interface IMcpCliente extends Document {
  clientId: string;
  nombre: string;
  redirectUris: string[];
  createdAt: Date;
  updatedAt: Date;
}

const McpClienteSchema = new Schema<IMcpCliente>(
  {
    clientId: { type: String, required: true, unique: true },
    nombre: { type: String, trim: true, maxlength: 80, default: "Claude" },
    redirectUris: { type: [String], default: [] },
  },
  { timestamps: true, versionKey: false }
);

export const McpClienteModel = model<IMcpCliente>("McpCliente", McpClienteSchema, "mcpclientes");

/**
 * Una entrada en curso: nace en /oauth/authorize y termina cuando la pestaña
 * que la empezó recibe el código para Claude.
 *
 * - pendiente: todavía no puso su correo
 * - enviada: se mandó el enlace, esperando el clic
 * - aprobada: tocó "conectar" en el correo
 * - entregada: la pestaña ya se llevó el código (no se entrega dos veces)
 */
export type EstadoSolicitudMcp = "pendiente" | "enviada" | "aprobada" | "entregada";

export interface IMcpSolicitud extends Document {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  resource?: string;
  /** Código corto que se ve en pantalla y en el correo: si no coinciden, no es tuyo. */
  codigoVisual: string;
  /** Secreto que solo tiene la pestaña que empezó: sin él nadie recoge el código. */
  sondeoHash?: string;
  email?: string;
  userId?: Types.ObjectId;
  enlaceHash?: string;
  enlaceEnviadoEn?: Date;
  enlacesEnviados: number;
  codeHash?: string;
  codeUsado?: boolean;
  estado: EstadoSolicitudMcp;
  expiraEn: Date;
  createdAt: Date;
  updatedAt: Date;
}

const McpSolicitudSchema = new Schema<IMcpSolicitud>(
  {
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    state: { type: String },
    codeChallenge: { type: String, required: true },
    resource: { type: String },
    codigoVisual: { type: String, required: true },
    sondeoHash: { type: String, select: false },
    email: { type: String, lowercase: true, trim: true },
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    enlaceHash: { type: String, select: false, index: true, sparse: true },
    enlaceEnviadoEn: { type: Date },
    enlacesEnviados: { type: Number, default: 0 },
    codeHash: { type: String, select: false, index: true, sparse: true },
    codeUsado: { type: Boolean, default: false },
    estado: { type: String, enum: ["pendiente", "enviada", "aprobada", "entregada"], default: "pendiente" },
    expiraEn: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false }
);

McpSolicitudSchema.index({ email: 1, createdAt: -1 });

export const McpSolicitudModel = model<IMcpSolicitud>("McpSolicitud", McpSolicitudSchema, "mcpsolicitudes");

/** Sesión de una persona en una app. El refresh rota en cada uso. */
export interface IMcpSesion extends Document {
  userId: Types.ObjectId;
  clientId: string;
  accessHash: string;
  accessExpira: Date;
  refreshHash: string;
  refreshExpira: Date;
  revocada: boolean;
  ultimoUso?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const McpSesionSchema = new Schema<IMcpSesion>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    clientId: { type: String, required: true },
    accessHash: { type: String, required: true, unique: true },
    accessExpira: { type: Date, required: true },
    refreshHash: { type: String, required: true, unique: true },
    refreshExpira: { type: Date, required: true },
    revocada: { type: Boolean, default: false },
    ultimoUso: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

export const McpSesionModel = model<IMcpSesion>("McpSesion", McpSesionSchema, "mcpsesiones");

/** Cada tool que alguien corre: quién, qué, con qué y cómo le fue. */
export interface IMcpAuditoria extends Document {
  userId: Types.ObjectId;
  email: string;
  perfil: string;
  tool: string;
  args?: string;
  ok: boolean;
  error?: string;
  ms: number;
  createdAt: Date;
}

const McpAuditoriaSchema = new Schema<IMcpAuditoria>(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    email: { type: String, required: true },
    perfil: { type: String, required: true },
    tool: { type: String, required: true },
    args: { type: String, maxlength: 4000 },
    ok: { type: Boolean, required: true },
    error: { type: String, maxlength: 1000 },
    ms: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

McpAuditoriaSchema.index({ userId: 1, createdAt: -1 });
McpAuditoriaSchema.index({ tool: 1, createdAt: -1 });

export const McpAuditoriaModel = model<IMcpAuditoria>("McpAuditoria", McpAuditoriaSchema, "mcpauditoria");
