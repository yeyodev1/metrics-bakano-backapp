import { Schema, model, Document, Types } from "mongoose";

/**
 * Lo que paso en el CRM (GoHighLevel) de un cliente en un dia: cuantas
 * conversaciones hubo, por que canal, cuantos contactos escribieron y como
 * respondio cada asesor. Una por entorno y dia (hora de Ecuador). La calcula
 * el cron crm-metricas a partir de los mensajes; es la base del dashboard
 * del CRM y del resumen que da Bakano People.
 *
 * Tambien es el candado del calculo, como CrmRevision: pendiente → en_curso
 * → terminada (o fallida, que se reintenta hasta 3 veces).
 */
export type EstadoMetricaCrm = "pendiente" | "en_curso" | "terminada" | "fallida";

export interface AsesorMetricaCrm {
  /** userId de GoHighLevel. */
  userId: string;
  /** Nombre en el CRM; vacio si el token no tiene users.readonly. */
  nombre: string;
  /** Mensajes que escribio ese dia. */
  mensajes: number;
  /** Conversaciones en las que escribio. */
  conversaciones: number;
  /** Mensajes de clientes que contesto (primera respuesta a cada turno). */
  respuestas: number;
  /** Segundos hasta la primera respuesta de cada turno (como mucho 300, para medianas de rango). */
  tiemposSeg: number[];
  /** Conversaciones asignadas a el que quedaron con el cliente esperando. */
  sinRespuesta: number;
}

export interface ICrmMetricaDiaria extends Document {
  workspaceId: Types.ObjectId;
  /** "YYYY-MM-DD" en hora de Ecuador. */
  dia: string;
  estado: EstadoMetricaCrm;
  intentos: number;
  iniciadaEn: Date | null;
  terminadaEn: Date | null;
  error: string | null;
  /** Quedo algo del dia sin leer (tope de conversaciones, de mensajes o de tiempo). */
  truncado: boolean;

  /** Conversaciones con al menos un mensaje ese dia. */
  conversaciones: number;
  /** De esas, las que empezaron ese dia. */
  nuevas: number;
  porCanal: { whatsapp: number; instagram: number; facebook: number; sms: number; otro: number };
  mensajesEntrantes: number;
  /** Salientes escritos por una persona del equipo del cliente. */
  mensajesSalientes: number;
  /** Salientes de flujos, campañas, API o bots: no cuentan como respuesta. */
  mensajesAutomaticos: number;
  /** Contactos distintos que escribieron ese dia. */
  contactosQueEscribieron: number;
  /** Conversaciones donde el ultimo mensaje del cliente quedo sin respuesta. */
  sinRespuesta: number;
  /** Mediana del tiempo de primera respuesta del dia (seg.), null si no hubo. */
  medianaRespuestaSeg: number | null;
  asesores: AsesorMetricaCrm[];
  createdAt: Date;
  updatedAt: Date;
}

const AsesorSchema = new Schema<AsesorMetricaCrm>(
  {
    userId: { type: String, required: true },
    nombre: { type: String, default: "" },
    mensajes: { type: Number, default: 0 },
    conversaciones: { type: Number, default: 0 },
    respuestas: { type: Number, default: 0 },
    tiemposSeg: { type: [Number], default: [] },
    sinRespuesta: { type: Number, default: 0 },
  },
  { _id: false }
);

const CrmMetricaDiariaSchema = new Schema<ICrmMetricaDiaria>(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    dia: { type: String, required: true },
    estado: { type: String, enum: ["pendiente", "en_curso", "terminada", "fallida"], default: "pendiente" },
    intentos: { type: Number, default: 0 },
    iniciadaEn: { type: Date, default: null },
    terminadaEn: { type: Date, default: null },
    error: { type: String, default: null },
    truncado: { type: Boolean, default: false },
    conversaciones: { type: Number, default: 0 },
    nuevas: { type: Number, default: 0 },
    porCanal: {
      whatsapp: { type: Number, default: 0 },
      instagram: { type: Number, default: 0 },
      facebook: { type: Number, default: 0 },
      sms: { type: Number, default: 0 },
      otro: { type: Number, default: 0 },
    },
    mensajesEntrantes: { type: Number, default: 0 },
    mensajesSalientes: { type: Number, default: 0 },
    mensajesAutomaticos: { type: Number, default: 0 },
    contactosQueEscribieron: { type: Number, default: 0 },
    sinRespuesta: { type: Number, default: 0 },
    medianaRespuestaSeg: { type: Number, default: null },
    asesores: { type: [AsesorSchema], default: [] },
  },
  { timestamps: true, versionKey: false }
);

CrmMetricaDiariaSchema.index({ workspaceId: 1, dia: 1 }, { unique: true });
CrmMetricaDiariaSchema.index({ estado: 1, dia: 1 });

export const CrmMetricaDiariaModel = model<ICrmMetricaDiaria>("CrmMetricaDiaria", CrmMetricaDiariaSchema, "crmmetricasdiarias");
