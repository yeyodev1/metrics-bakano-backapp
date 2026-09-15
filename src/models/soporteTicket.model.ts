import { Schema, model, Document, Types } from "mongoose";

/**
 * Correo que llego a soporte@bakano.ec.
 *
 * Google reenvia el buzon a la direccion de recepcion de Resend, Resend avisa
 * al webhook y el ticket se publica en el canal de soporte de Slack
 * etiquetando a quien atiende el tema. `emailId` es unico: Resend reintenta
 * los webhooks y no debe salir el mismo ticket dos veces.
 */
export type EstadoTicket = "recibido" | "publicado" | "sin_slack";

export interface ISoporteTicket extends Document {
  emailId: string;
  deNombre?: string;
  deEmail?: string;
  asunto: string;
  texto?: string;

  tema?: string;
  urgencia?: string;
  animo?: string;
  resumen?: string;
  accionSugerida?: string;

  workspaceId?: Types.ObjectId;
  userId?: Types.ObjectId;
  entorno?: string;

  mencionados: string[];
  slackTs?: string;
  estado: EstadoTicket;

  createdAt: Date;
  updatedAt: Date;
}

const SoporteTicketSchema = new Schema<ISoporteTicket>(
  {
    emailId: { type: String, required: true, unique: true },
    deNombre: { type: String, trim: true },
    deEmail: { type: String, trim: true, lowercase: true },
    asunto: { type: String, trim: true, default: "(sin asunto)" },
    texto: { type: String, maxlength: 20000 },

    tema: { type: String },
    urgencia: { type: String },
    animo: { type: String },
    resumen: { type: String },
    accionSugerida: { type: String },

    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    entorno: { type: String },

    mencionados: { type: [String], default: [] },
    slackTs: { type: String },
    estado: { type: String, enum: ["recibido", "publicado", "sin_slack"], default: "recibido" },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

SoporteTicketSchema.index({ createdAt: -1 });

export const SoporteTicketModel = model<ISoporteTicket>("SoporteTicket", SoporteTicketSchema);
