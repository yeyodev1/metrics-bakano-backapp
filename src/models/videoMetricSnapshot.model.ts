import { Schema, model, Document, Types } from "mongoose";

/**
 * Daily snapshot of a published video's performance.
 *
 * `VideoPlanning.items[].metrics` only keeps the latest values (destructive
 * overwrite), which makes it impossible to compare videos of different ages or
 * to draw a growth curve. This collection keeps one immutable row per
 * (videoItem, day) so the Pareto engine can normalize by post age.
 */
export type MetricSource = "organic" | "ads" | "merged";

export interface IVideoMetricSnapshot extends Document {
  workspaceId: Types.ObjectId;
  planningId: Types.ObjectId;
  videoItemId: Types.ObjectId;

  igMediaId?: string;
  fbPostId?: string;
  metaAdId?: string;

  /** Ecuador-local calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Whole days elapsed between `fechaPublicacion` and `date`. */
  ageDays?: number;

  // Organic
  views: number;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  saved: number;
  shares: number;
  profileVisits: number;
  follows: number;

  // Paid
  adSpend: number;
  adLeads: number;
  adROAS: number;

  source: MetricSource;
  createdAt: Date;
  updatedAt: Date;
}

const VideoMetricSnapshotSchema = new Schema<IVideoMetricSnapshot>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    planningId: {
      type: Schema.Types.ObjectId,
      ref: "VideoPlanning",
      required: true,
    },
    videoItemId: { type: Schema.Types.ObjectId, required: true },

    igMediaId: { type: String, trim: true },
    fbPostId: { type: String, trim: true },
    metaAdId: { type: String, trim: true },

    date: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
    ageDays: { type: Number },

    views: { type: Number, default: 0 },
    reach: { type: Number, default: 0 },
    impressions: { type: Number, default: 0 },
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    saved: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    profileVisits: { type: Number, default: 0 },
    follows: { type: Number, default: 0 },

    adSpend: { type: Number, default: 0 },
    adLeads: { type: Number, default: 0 },
    adROAS: { type: Number, default: 0 },

    source: {
      type: String,
      enum: ["organic", "ads", "merged"],
      default: "organic",
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

// One row per video per day — the sync upserts on this key.
VideoMetricSnapshotSchema.index({ videoItemId: 1, date: 1 }, { unique: true });
VideoMetricSnapshotSchema.index({ workspaceId: 1, date: -1 });
VideoMetricSnapshotSchema.index({ workspaceId: 1, videoItemId: 1, ageDays: 1 });

export const VideoMetricSnapshotModel = model<IVideoMetricSnapshot>(
  "VideoMetricSnapshot",
  VideoMetricSnapshotSchema
);
