import { Schema, model, Document, Types } from "mongoose";

// ── Types ──────────────────────────────────────────────────────────────────
export type KpiRoleType = "editor" | "asistente_produccion" | "content";

// ── Interface ──────────────────────────────────────────────────────────────
export interface ITeamKpiRecord extends Document {
  userId: Types.ObjectId;       // The team member being evaluated
  pmUserId: Types.ObjectId;     // Who last filled / updated this record
  month: string;                // "YYYY-MM"  e.g. "2026-03"
  roleType: KpiRoleType;

  // ── Editor fields ─────────────────────────────────────────────────────
  workingDays?: number;
  targetVideos?: number;
  deliveredVideos?: number;
  returnedVideos?: number;       // Videos devueltos (errors)
  approvedFirstPass?: number;    // Videos aprobados a la 1ra
  urgencies?: number;            // Urgencias asignadas
  urgenciesOnTime?: number;      // Urgencias a tiempo

  // ── Asistente de Producción fields ───────────────────────────────────
  prodClients?: number;
  targetVisits?: number;
  completedVisits?: number;
  targetVideosMade?: number;
  videosMade?: number;
  onTimeDeliveriesToEditor?: number;

  // ── Content fields ───────────────────────────────────────────────────
  contentClients?: number;
  targetPlans?: number;
  deliveredPlans?: number;
  completePlans20?: number;      // Planes completos (20 videos)
  plansOnTime?: number;
  postsTarget?: number;          // Posts por período (ej. 50)
  postsDelivered?: number;       // Posts entregados a tiempo
  publishRate?: number;          // % publicación efectiva (decimal)

  createdAt: Date;
  updatedAt: Date;
}

// ── Schema ─────────────────────────────────────────────────────────────────
const TeamKpiRecordSchema = new Schema<ITeamKpiRecord>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    pmUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    month: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}$/,    // enforce "YYYY-MM" format
    },
    roleType: {
      type: String,
      enum: ["editor", "asistente_produccion", "content"],
      required: true,
    },

    // Editor
    workingDays: { type: Number },
    targetVideos: { type: Number },
    deliveredVideos: { type: Number },
    returnedVideos: { type: Number },
    approvedFirstPass: { type: Number },
    urgencies: { type: Number },
    urgenciesOnTime: { type: Number },

    // Asistente de Producción
    prodClients: { type: Number },
    targetVisits: { type: Number },
    completedVisits: { type: Number },
    targetVideosMade: { type: Number },
    videosMade: { type: Number },
    onTimeDeliveriesToEditor: { type: Number },

    // Content
    contentClients: { type: Number },
    targetPlans: { type: Number },
    deliveredPlans: { type: Number },
    completePlans20: { type: Number },
    plansOnTime: { type: Number },
    postsTarget: { type: Number },
    postsDelivered: { type: Number },
    publishRate: { type: Number },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// One KPI record per user per month (across all their assigned clients)
TeamKpiRecordSchema.index({ userId: 1, month: 1 }, { unique: true });

export const TeamKpiRecordModel = model<ITeamKpiRecord>(
  "TeamKpiRecord",
  TeamKpiRecordSchema
);
