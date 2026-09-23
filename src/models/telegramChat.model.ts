import { Schema, model, Document, Types } from "mongoose";
import type { TemaAtencion } from "../services/equipoAtencion.service";

/**
 * Un chat privado de Telegram con @BakanoAgencyBot.
 *
 * Telegram no dice quien es la persona en la plataforma: el chat arranca
 * anonimo y se vincula a un usuario solo despues de probar que controla el
 * correo (codigo de un solo uso). Luego elige sobre que entorno habla, y todo
 * lo que el bot haga despues cuelga de ese `workspaceId`.
 */
export type TelegramChatEstado =
  | "esperando_correo"
  | "esperando_codigo"
  | "eligiendo_entorno"
  | "listo";

export interface ITelegramChat extends Document {
  chatId: number;
  telegramUserId: number;
  telegramUsername?: string;
  firstName?: string;

  estado: TelegramChatEstado;

  /** Correo escrito mientras se espera el codigo. Se borra al vincular. */
  correoPendiente?: string;
  /** Hash del codigo, nunca el codigo: quien lea la base no puede usarlo. */
  codigoHash?: string;
  codigoExpira?: Date;
  codigoEnviadoEn?: Date;
  codigoIntentos: number;

  userId?: Types.ObjectId;
  workspaceId?: Types.ObjectId;
  /** Tema elegido en el menu: el siguiente mensaje se le pasa a quien lo atiende. */
  tema?: TemaAtencion;
  /** Candado mientras se reserva una cita: dos toques seguidos no crean dos citas. */
  agendandoDesde?: Date;
  /** Ultimos mensajes con la IA, para que recuerde la conversacion. Se borra al salir o cambiar de entorno. */
  historial: { rol: "cliente" | "bot"; texto: string; en: Date }[];
  /** Ultima lectura de animo de la IA; "feliz" alimenta el resumen semanal. */
  ultimoAnimo?: { estado: string; motivo?: string; en: Date };
  /** Ultima alerta a la project manager: evita repetirla mas de una vez al dia. */
  ultimaAlerta?: { estado: string; en: Date };
  /**
   * Borrador de correcciones de guiones: se van anotando en la conversacion y
   * se envian todas juntas, porque la revision del cliente se recibe una vez.
   */
  /** Reuniones que el bot agendo (guiones/atencion): sin esto no se podrian mover ni cancelar. */
  citas?: {
    appointmentId: string;
    tipo: "reunion";
    tema: string;
    calendarId?: string;
    inicio: Date;
    agendadaEn?: Date;
    workspaceId?: Types.ObjectId;
    userId?: Types.ObjectId;
  }[];
  /** update_id de Telegram ya procesados: sus reintentos no se repiten. */
  updatesVistos?: number[];
  /** El bot pidió un archivo (logo, línea gráfica o catálogo) y lo está esperando. */
  archivoEsperado?: { categoria: string; pedidoEn: Date };
  /** El bot pidió el monto de facturación de un día y espera la respuesta. */
  facturacionEsperada?: { fecha: Date; pedidoEn: Date; modo?: "pedido" | "correccion" };
  /** El bot pidió un dato del perfil de marca por escrito (ej. el link de la venta). */
  datoEsperado?: { campo: string; pedidoEn: Date };
  /** Cambio de cita propuesto y esperando que el cliente lo confirme. */
  cambioPendiente?: {
    accion: "cancelar" | "reprogramar";
    ref: string;
    inicio?: Date;
    motivo?: string;
    /** La IA decidió que dirección tiene que enterarse. */
    avisarDireccion?: boolean;
    resumen: string;
    creadoEn: Date;
  };
  revisionGuiones?: {
    planningId: Types.ObjectId;
    correcciones: { itemId: string; numero: number; tema: string; texto: string; categoria?: string }[];
    actualizadoEn?: Date;
  };
  vinculadoEn?: Date;

  createdAt: Date;
  updatedAt: Date;
}

const TelegramChatSchema = new Schema<ITelegramChat>(
  {
    chatId: { type: Number, required: true, unique: true },
    telegramUserId: { type: Number, required: true },
    telegramUsername: { type: String, trim: true },
    firstName: { type: String, trim: true },

    estado: {
      type: String,
      enum: ["esperando_correo", "esperando_codigo", "eligiendo_entorno", "listo"],
      default: "esperando_correo",
    },

    correoPendiente: { type: String, lowercase: true, trim: true },
    codigoHash: { type: String, select: false },
    codigoExpira: { type: Date },
    codigoEnviadoEn: { type: Date },
    codigoIntentos: { type: Number, default: 0 },

    userId: { type: Schema.Types.ObjectId, ref: "User", default: null },
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", default: null },
    tema: { type: String, enum: ["produccion", "guiones", "atencion"] },
    agendandoDesde: { type: Date },
    historial: {
      type: [{ _id: false, rol: { type: String, enum: ["cliente", "bot"] }, texto: String, en: Date }],
      default: [],
    },
    ultimoAnimo: { estado: String, motivo: String, en: Date },
    ultimaAlerta: { estado: String, en: Date },
    citas: {
      type: [
        {
          _id: false,
          appointmentId: String,
          tipo: String,
          tema: String,
          calendarId: String,
          inicio: Date,
          agendadaEn: Date,
          workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace" },
          userId: { type: Schema.Types.ObjectId, ref: "User" },
        },
      ],
      default: undefined,
    },
    updatesVistos: { type: [Number], default: undefined },
    archivoEsperado: {
      type: { categoria: String, pedidoEn: Date },
      default: undefined,
    },
    facturacionEsperada: {
      // "correccion" es la ventana que queda abierta tras registrar: sin este
      // campo en el esquema, Mongoose lo descartaba y el bot seguía pidiendo
      // el monto aunque el cliente ya hubiera pasado a otro tema.
      type: { fecha: Date, pedidoEn: Date, modo: String },
      default: undefined,
    },
    datoEsperado: {
      type: { campo: String, pedidoEn: Date },
      default: undefined,
    },
    cambioPendiente: {
      type: { accion: String, ref: String, inicio: Date, motivo: String, avisarDireccion: Boolean, resumen: String, creadoEn: Date },
      default: undefined,
    },
    revisionGuiones: {
      type: {
        planningId: { type: Schema.Types.ObjectId, ref: "VideoPlanning" },
        correcciones: [
          { _id: false, itemId: String, numero: Number, tema: String, texto: String, categoria: String },
        ],
        actualizadoEn: Date,
      },
      default: undefined,
    },
    vinculadoEn: { type: Date },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

TelegramChatSchema.index({ userId: 1 });

export const TelegramChatModel = model<ITelegramChat>("TelegramChat", TelegramChatSchema);
