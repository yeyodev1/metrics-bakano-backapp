import { Schema, model, Document, Types } from "mongoose";

/**
 * Engram — a brand's learned memory.
 *
 * Metrics used to be a dead end: they were measured and never fed back into
 * generation. An engram is the distilled "what works for THIS brand", derived
 * from the Pareto winners and losers, and injected into the script prompt so
 * every month starts from the previous month's evidence instead of from zero.
 *
 * Versioned and human-approved on purpose: a bad month must not silently
 * poison every future script.
 */
export type EngramStatus = "draft" | "active" | "archived";

export interface IEngramEvidence {
  videoItemId: Types.ObjectId;
  tema?: string;
  metrica: string;
  valor: number;
}

export interface IEngramPattern {
  patron: string;
  dimension?: string;
  /** Percent difference vs the brand's average for the measured metric. */
  liftPct?: number;
  evidencia?: IEngramEvidence[];
}

export interface IEngramToneRule {
  regla: string;
  ejemploBueno?: string;
  ejemploMalo?: string;
}

export interface IEngram extends Document {
  workspaceId: Types.ObjectId;
  version: number;
  status: EngramStatus;

  winningPatterns: IEngramPattern[];
  losingPatterns: IEngramPattern[];
  toneRules: IEngramToneRule[];
  /** Words this brand owns. */
  vocabularioMarca: string[];
  /** Words that turned generic or repetitive across clients — banned. */
  vocabularioProhibido: string[];

  /** What the rebuild looked at, so a reader can judge the sample. */
  basadoEn?: {
    metric: string;
    month?: string;
    videosAnalizados: number;
    ganadores: number;
  };

  generadoPor?: Types.ObjectId;
  approvedBy?: Types.ObjectId;
  approvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const EvidenceSchema = new Schema(
  {
    videoItemId: { type: Schema.Types.ObjectId, required: true },
    tema: { type: String, trim: true },
    metrica: { type: String, trim: true },
    valor: { type: Number },
  },
  { _id: false }
);

const PatternSchema = new Schema(
  {
    patron: { type: String, required: true, trim: true },
    dimension: { type: String, trim: true },
    liftPct: { type: Number },
    evidencia: { type: [EvidenceSchema], default: [] },
  },
  { _id: false }
);

const ToneRuleSchema = new Schema(
  {
    regla: { type: String, required: true, trim: true },
    ejemploBueno: { type: String, trim: true },
    ejemploMalo: { type: String, trim: true },
  },
  { _id: false }
);

const EngramSchema = new Schema<IEngram>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    version: { type: Number, required: true },
    status: {
      type: String,
      enum: ["draft", "active", "archived"],
      default: "draft",
    },

    winningPatterns: { type: [PatternSchema], default: [] },
    losingPatterns: { type: [PatternSchema], default: [] },
    toneRules: { type: [ToneRuleSchema], default: [] },
    vocabularioMarca: { type: [String], default: [] },
    vocabularioProhibido: { type: [String], default: [] },

    basadoEn: {
      metric: { type: String, trim: true },
      month: { type: String, trim: true },
      videosAnalizados: { type: Number },
      ganadores: { type: Number },
    },

    generadoPor: { type: Schema.Types.ObjectId, ref: "User" },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

EngramSchema.index({ workspaceId: 1, version: -1 }, { unique: true });
EngramSchema.index({ workspaceId: 1, status: 1 });

export const EngramModel = model<IEngram>("Engram", EngramSchema);
