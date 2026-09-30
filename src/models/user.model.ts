import { Schema, model, Document, Types } from "mongoose";

export type BotAcceso = "bakano" | "lucas";
export const BOTS_ACCESO: BotAcceso[] = ["bakano", "lucas"];

export interface IUserWorkspaceAccess {
  workspaceId: Types.ObjectId;
  role: "admin" | "colaborador";
  /**
   * A qué bot entra con este entorno: @BakanoAgencyBot (onboarding, guiones,
   * producción) y/o Lucas (el asesor de ventas). Los vendedores de un cliente
   * solo necesitan a Lucas. Sin el campo (altas viejas) entra a los dos.
   */
  bots?: BotAcceso[];
}

/** Bots a los que entra con ese acceso. Leer siempre por aquí: las altas viejas no tienen el campo. */
export function botsDeAcceso(acceso?: { bots?: BotAcceso[] | null } | null): BotAcceso[] {
  return acceso?.bots?.length ? acceso.bots : BOTS_ACCESO;
}

export type InternalRole =
  | 'director'
  | 'estratega'
  | 'project_manager'
  | 'content_manager'
  | 'account_manager'
  | 'community_manager'
  | 'productor'
  | 'asistente_produccion'
  | 'editor'
  | 'disenador'
  | 'copywriter'
  | 'analista'
  | 'desarrollador'
  | 'trafficker'
  | 'sales_executive'

export interface IUser extends Document {
  name?: string;
  /**
   * Apellido aparte. GHL crea el contacto con nombre y apellido separados, y
   * partir `name` por el primer espacio falla con nombres compuestos: "Maria
   * Jose Perez" da apellido "Jose Perez". Cuando esta cargado, manda este.
   */
  lastName?: string;
  email: string;
  password?: string;
  role: "superadmin" | "user" | "admin" | "colaborador";
  workspaceId?: Types.ObjectId;
  workspaces: IUserWorkspaceAccess[];
  isInternal: boolean;
  internalRole?: InternalRole;
  isActive: boolean;
  phoneNumber?: string;
  phoneExtension?: string;
  apiKey?: string;
  apiKeyCreatedAt?: Date;
  /** Cuando se le presento el bot de Telegram, para no escribirle dos veces. */
  presentacionBotEnviadaEn?: Date;
  /** Cuando dio por visto el aviso del bot en Metrics. Hasta entonces se le muestra. */
  avisoBotVistoEn?: Date;
  /** Recordatorios del bot ya enviados y cuando fue el ultimo (tope: dos semanas). */
  presentacionBotRecordatorios?: number;
  presentacionBotUltimoEn?: Date;
  /** Cuando se le explico la regla de produccion (cada 6 meses). */
  avisoReglaProduccionEn?: Date;
  /** Cuando se le dijo que Bakanology va incluido en su suscripcion. */
  avisoBakanologyEn?: Date;
  /** Cuando se le dio el acceso a la academia. Sin esto no sabriamos quien quedo afuera. */
  accesoBakanologyEn?: Date;
  /**
   * Recuperación de contraseña. Se guarda el hash del token, nunca el token:
   * si alguien lee la base de datos no puede usarlo para entrar a una cuenta.
   */
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  photoUrl?: string;
  presentationVideoUrl?: string;
}

export const UserSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      trim: true,
    },
    lastName: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["superadmin", "user", "admin", "colaborador"],
      default: "user",
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
    },
    workspaces: [
      {
        workspaceId: {
          type: Schema.Types.ObjectId,
          ref: "Workspace",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "colaborador"],
          required: true,
        },
        bots: {
          type: [{ type: String, enum: ["bakano", "lucas"] }],
          default: undefined,
        },
      }
    ],
    isInternal: {
      type: Boolean,
      default: false,
    },
    internalRole: {
      type: String,
      enum: ['director', 'estratega', 'project_manager', 'content_manager', 'account_manager', 'community_manager', 'productor', 'asistente_produccion', 'editor', 'disenador', 'copywriter', 'analista', 'desarrollador', 'trafficker', 'sales_executive'],
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
    },
    phoneExtension: {
      type: String,
      trim: true,
    },
    apiKey: {
      type: String,
      index: true,
      sparse: true,
    },
    apiKeyCreatedAt: {
      type: Date,
    },
    presentacionBotEnviadaEn: {
      type: Date,
    },
    avisoBotVistoEn: {
      type: Date,
    },
    presentacionBotRecordatorios: {
      type: Number,
      default: 0,
    },
    presentacionBotUltimoEn: {
      type: Date,
    },
    avisoReglaProduccionEn: {
      type: Date,
    },
    avisoBakanologyEn: {
      type: Date,
    },
    accesoBakanologyEn: {
      type: Date,
    },
    // `select: false` para que ningún endpoint devuelva estos campos por error.
    passwordResetTokenHash: {
      type: String,
      select: false,
    },
    passwordResetExpiresAt: {
      type: Date,
      select: false,
    },
    photoUrl: {
      type: String,
      trim: true,
      default: null,
    },
    presentationVideoUrl: {
      type: String,
      trim: true,
      default: null,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const UserModel = model<IUser>("User", UserSchema);
