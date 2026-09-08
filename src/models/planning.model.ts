import { Schema, model, Document, Types } from "mongoose";

export type PlanningSource = "manual" | "crm";

/**
 * Rastro de la cita del CRM (GoHighLevel) de la que nace una produccion.
 * Sin esto no habia forma de saber que un dia de produccion vino del link de
 * agendamiento, ni de encontrarlo cuando el cliente lo mueve o lo cancela.
 */
export interface IPlanningCrm {
  appointmentId: string;
  calendarId?: string;
  calendarName?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  contactPhone?: string;
  status?: string;
  syncedAt: Date;
}

export interface IPlanning extends Document {
  workspaceId: Types.ObjectId;
  title: string;
  date: Date;
  endsAt?: Date;
  notes?: string;
  assignedTo: Types.ObjectId[];
  /** Opcional porque las producciones agendadas desde el CRM no tienen autor. */
  createdBy?: Types.ObjectId;
  source: PlanningSource;
  crm?: IPlanningCrm;
  /**
   * La produccion del mes se da por cumplida cuando el productor marca el
   * primer guion del cliente como GRABADO. Antes no existia el concepto: el
   * calendario mostraba la fecha, pero nadie sabia si ya se grabo.
   */
  cumplida: boolean;
  cumplidaEn?: Date;
  cumplidaPorId?: Types.ObjectId;
  cumplidaPorNombre?: string;
  createdAt: Date;
  updatedAt: Date;
}

const PlanningSchema = new Schema<IPlanning>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    date: {
      type: Date,
      required: true,
    },
    endsAt: { type: Date },
    notes: {
      type: String,
      trim: true,
    },
    assignedTo: [{
      type: Schema.Types.ObjectId,
      ref: "User",
    }],
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
    },
    source: {
      type: String,
      enum: ["manual", "crm"],
      default: "manual",
    },
    crm: {
      type: new Schema<IPlanningCrm>(
        {
          appointmentId: { type: String, required: true, trim: true },
          calendarId: { type: String, trim: true },
          calendarName: { type: String, trim: true },
          contactId: { type: String, trim: true },
          contactName: { type: String, trim: true },
          contactEmail: { type: String, trim: true, lowercase: true },
          contactPhone: { type: String, trim: true },
          status: { type: String, trim: true },
          syncedAt: { type: Date, required: true },
        },
        { _id: false }
      ),
      default: undefined,
    },
    cumplida: { type: Boolean, default: false },
    cumplidaEn: { type: Date },
    cumplidaPorId: { type: Schema.Types.ObjectId, ref: "User" },
    cumplidaPorNombre: { type: String, trim: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// Index for efficient querying by workspace and date
PlanningSchema.index({ workspaceId: 1, date: 1 });
// Una cita del CRM = una produccion. El upsert del webhook se apoya en esto.
PlanningSchema.index({ "crm.appointmentId": 1 }, { unique: true, sparse: true });

export const PlanningModel = model<IPlanning>("Planning", PlanningSchema);
