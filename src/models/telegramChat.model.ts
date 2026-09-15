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
    vinculadoEn: { type: Date },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

TelegramChatSchema.index({ userId: 1 });

export const TelegramChatModel = model<ITelegramChat>("TelegramChat", TelegramChatSchema);
