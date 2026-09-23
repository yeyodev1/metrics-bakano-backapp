import { Schema, model, Document, Types } from "mongoose";

/**
 * Un cliente que la está pasando mal y alguien tiene que atender.
 *
 * Nace de la conversación de Telegram: la IA lee el ánimo y, cuando pasa de
 * molesto, abre el incidente. Vive en Metrics para que el equipo entero lo
 * vea (no solo quien recibió el correo), sepa de qué cliente es, qué dijo y
 * qué se recomienda hacer, y para que quede registro de quién lo tomó.
 */
export type GravedadIncidente = "molesto" | "angustiado" | "en_peligro";
export type EstadoIncidente = "abierto" | "tomado" | "cerrado";
/** Cada cosa que le pasó al incidente, para poder reconstruir la historia. */
export type AccionIncidente = "abierto" | "asignado" | "tomado" | "cerrado" | "reabierto" | "recordatorio" | "nota";

export interface EventoIncidente {
  accion: AccionIncidente;
  porNombre: string;
  porUserId?: Types.ObjectId;
  detalle?: string;
  en: Date;
}

export interface IIncidente extends Document {
  workspaceId: Types.ObjectId;
  workspaceName: string;
  origen: "telegram";
  gravedad: GravedadIncidente;
  /** Tema del que se queja: define a quién le toca por defecto. */
  tema: string;
  responsableNombre?: string;
  responsableEmail?: string;
  cliente: { nombre?: string; email?: string; telegram?: string; chatId?: number };
  /** La frase exacta del cliente: sin interpretaciones de por medio. */
  frase: string;
  motivo?: string;
  recomendacion?: string;
  mensajeCompleto?: string;
  /** Llegó fuera de horario de oficina (después de las 17:00 de Ecuador o fin de semana). */
  fueraDeHorario: boolean;

  estado: EstadoIncidente;
  /** A quién se le asignó a dedo (puede no ser el responsable por tema). */
  asignadoA?: { userId: Types.ObjectId; nombre: string; email: string; en: Date; porNombre: string };
  /** Todo lo que pasó, en orden. Nunca se borra nada de aquí. */
  historial: EventoIncidente[];
  tomadoPor?: { userId: Types.ObjectId; nombre: string; en: Date };
  cerradoPor?: { userId: Types.ObjectId; nombre: string; en: Date };
  nota?: string;
  /** Último recordatorio al equipo mientras sigue sin que nadie lo tome. */
  ultimoPingEn?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const IncidenteSchema = new Schema<IIncidente>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    workspaceName: { type: String, required: true, trim: true },
    origen: { type: String, enum: ["telegram"], default: "telegram" },
    gravedad: { type: String, enum: ["molesto", "angustiado", "en_peligro"], required: true },
    tema: { type: String, required: true },
    responsableNombre: { type: String, trim: true },
    responsableEmail: { type: String, trim: true, lowercase: true },
    cliente: {
      nombre: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      telegram: { type: String, trim: true },
      chatId: { type: Number },
    },
    frase: { type: String, required: true, trim: true, maxlength: 1000 },
    motivo: { type: String, trim: true, maxlength: 1000 },
    recomendacion: { type: String, trim: true, maxlength: 1000 },
    mensajeCompleto: { type: String, trim: true, maxlength: 4000 },
    fueraDeHorario: { type: Boolean, default: false },

    estado: { type: String, enum: ["abierto", "tomado", "cerrado"], default: "abierto" },
    asignadoA: {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      nombre: { type: String, trim: true },
      email: { type: String, trim: true, lowercase: true },
      en: { type: Date },
      porNombre: { type: String, trim: true },
    },
    historial: {
      type: [
        {
          _id: false,
          accion: { type: String, enum: ["abierto", "asignado", "tomado", "cerrado", "reabierto", "recordatorio", "nota"] },
          porNombre: { type: String, trim: true },
          porUserId: { type: Schema.Types.ObjectId, ref: "User" },
          detalle: { type: String, trim: true, maxlength: 2000 },
          en: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    tomadoPor: {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      nombre: { type: String, trim: true },
      en: { type: Date },
    },
    cerradoPor: {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      nombre: { type: String, trim: true },
      en: { type: Date },
    },
    nota: { type: String, trim: true, maxlength: 2000 },
    ultimoPingEn: { type: Date },
  },
  { timestamps: true, versionKey: false }
);

// Lo que mira el equipo: lo abierto primero y lo más reciente arriba.
IncidenteSchema.index({ estado: 1, createdAt: -1 });
IncidenteSchema.index({ workspaceId: 1, createdAt: -1 });

export const IncidenteModel = model<IIncidente>("Incidente", IncidenteSchema);
