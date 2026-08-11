import { Schema, model, Document, Types } from "mongoose";

/**
 * Human notes about what is working.
 *
 * Metrics say *what* happened; they never say why. The team already knows
 * things the numbers cannot show — a hook that landed, a client who reacted to
 * one video, an offer that carried the month. This is where that goes, tied to
 * the specific script when possible, and it is fed to the scripting agent
 * alongside the numbers.
 */
export type FeedbackTipo = "video" | "guion" | "general";

export interface IScriptFeedback extends Document {
  workspaceId: Types.ObjectId;
  /** The script this note is about, when it is about one. */
  videoItemId?: Types.ObjectId;
  planningId?: Types.ObjectId;
  /** Denormalized so the note stays readable if the item is later removed. */
  videoTema?: string;

  tipo: FeedbackTipo;
  texto: string;

  authorId: Types.ObjectId;
  authorName: string;

  createdAt: Date;
  updatedAt: Date;
}

const ScriptFeedbackSchema = new Schema<IScriptFeedback>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    videoItemId: { type: Schema.Types.ObjectId },
    planningId: { type: Schema.Types.ObjectId, ref: "VideoPlanning" },
    videoTema: { type: String, trim: true },

    tipo: {
      type: String,
      enum: ["video", "guion", "general"],
      default: "general",
    },
    texto: { type: String, required: true, trim: true, maxlength: 4000 },

    authorId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    authorName: { type: String, trim: true, required: true },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

ScriptFeedbackSchema.index({ workspaceId: 1, createdAt: -1 });
ScriptFeedbackSchema.index({ videoItemId: 1, createdAt: -1 });

export const ScriptFeedbackModel = model<IScriptFeedback>(
  "ScriptFeedback",
  ScriptFeedbackSchema
);
