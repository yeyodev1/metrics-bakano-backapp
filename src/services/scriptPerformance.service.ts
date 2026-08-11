import { Types } from "mongoose";
import models from "../models";
import type { IVideoItem } from "../models/videoPlanning.model";
import type { IVideoMetricSnapshot } from "../models/videoMetricSnapshot.model";

export type PerformanceMetric = "views" | "leads";

/**
 * Days after publication at which every video is measured.
 *
 * Without this a reel published three months ago always beats one published
 * last week, and the ranking measures age instead of quality.
 */
const NORMALIZATION_WINDOW_DAYS = 7;

/** Below this sample size a dimension's average is noise, not a finding. */
const MIN_SAMPLE_FOR_CONFIDENCE = 5;

/** Pareto cutoff. The real percentage reached is always reported alongside. */
const PARETO_TARGET = 0.8;

export interface ScoredVideo {
  videoItemId: string;
  planningId: string;
  numero: number;
  tema: string;
  guionResumen: string;
  igPermalink?: string;
  fechaPublicacion?: Date;
  tipoGuion?: string;
  objetivo?: string;
  hookType?: string;
  formato?: string;
  elementos?: Record<string, boolean>;
  value: number;
  /** Whether `value` came from a normalized snapshot or the live totals. */
  measuredAt: "normalized" | "latest";
  /** For leads only: real ad leads vs organic intent proxy. */
  leadSource?: "ads" | "proxy";
}

export interface DimensionStat {
  dimension: string;
  bucket: string;
  n: number;
  avg: number;
  median: number;
  total: number;
  /** Percent difference vs the workspace average for this metric. */
  liftPct: number;
  lowConfidence: boolean;
}

export interface ParetoResult {
  metric: PerformanceMetric;
  month?: string;
  totalVideos: number;
  totalValue: number;
  /** Index in `videos` where the cumulative share first crosses 80%. */
  thresholdIndex: number;
  /** Videos needed to reach the threshold. */
  winnersCount: number;
  /** The share those winners actually represent (e.g. 0.83, not a forced 0.8). */
  actualShare: number;
  /** Share of the catalogue those winners are (e.g. 0.17). */
  winnersRatio: number;
  videos: Array<ScoredVideo & { share: number; cumulativeShare: number }>;
  byDimension: DimensionStat[];
  insights: string[];
  leadSourceMix?: { ads: number; proxy: number };
}

// ── Scoring helpers ─────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Organic stand-in for "someone moved toward buying".
 *
 * Weighted because a save or a profile visit signals far more intent than a
 * comment, which is often just noise or a tagged friend.
 */
function organicLeadProxy(source: {
  comments?: number;
  saved?: number;
  shares?: number;
  profileVisits?: number;
  follows?: number;
}): number {
  return (
    Number(source.comments || 0) * 1 +
    Number(source.saved || 0) * 2 +
    Number(source.shares || 0) * 2 +
    Number(source.profileVisits || 0) * 3 +
    Number(source.follows || 0) * 5
  );
}

function truncate(text: string, max = 140): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function scriptSummary(item: IVideoItem): string {
  const ia = item.guionIA;
  if (ia?.gancho) return truncate(ia.gancho);
  if (item.guion) return truncate(item.guion);
  return truncate(item.descripcion || item.tema || "");
}

export class ScriptPerformanceService {
  /**
   * Pick the snapshot that represents each video fairly.
   *
   * Prefers the last snapshot within the normalization window; falls back to
   * the earliest available one when the video was linked late (its first
   * snapshot is already past day 7), and flags that as `latest` so the caller
   * knows the comparison is not apples-to-apples.
   */
  private pickNormalizedSnapshot(
    snapshots: IVideoMetricSnapshot[]
  ): { snapshot: IVideoMetricSnapshot; measuredAt: "normalized" | "latest" } | null {
    if (!snapshots.length) return null;

    const withinWindow = snapshots.filter(
      (s) => s.ageDays !== undefined && s.ageDays <= NORMALIZATION_WINDOW_DAYS
    );

    if (withinWindow.length) {
      const best = withinWindow.reduce((a, b) =>
        (a.ageDays ?? 0) >= (b.ageDays ?? 0) ? a : b
      );
      return { snapshot: best, measuredAt: "normalized" };
    }

    const earliest = snapshots.reduce((a, b) =>
      (a.ageDays ?? Infinity) <= (b.ageDays ?? Infinity) ? a : b
    );
    return { snapshot: earliest, measuredAt: "latest" };
  }

  /** Collect every linked video of a workspace, scored by the chosen metric. */
  private async scoreVideos(
    workspaceId: string,
    metric: PerformanceMetric,
    month?: string
  ): Promise<ScoredVideo[]> {
    const plannings = await models.videoPlanning
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .select("_id items")
      .lean();

    const itemIds: Types.ObjectId[] = [];
    const rows: Array<{ planningId: string; item: IVideoItem }> = [];

    for (const planning of plannings) {
      for (const item of planning.items) {
        if (!item.igMediaId && !item.metaAdId && !item.fbPostId) continue;
        if (month) {
          if (!item.fechaPublicacion) continue;
          const ym = new Date(item.fechaPublicacion).toISOString().slice(0, 7);
          if (ym !== month) continue;
        }
        itemIds.push(item._id);
        rows.push({ planningId: String(planning._id), item });
      }
    }

    if (!rows.length) return [];

    const snapshots = await models.videoMetricSnapshots
      .find({ videoItemId: { $in: itemIds } })
      .lean<IVideoMetricSnapshot[]>();

    const byItem = new Map<string, IVideoMetricSnapshot[]>();
    for (const snap of snapshots) {
      const key = String(snap.videoItemId);
      const list = byItem.get(key) || [];
      list.push(snap);
      byItem.set(key, list);
    }

    const scored: ScoredVideo[] = [];

    for (const { planningId, item } of rows) {
      const picked = this.pickNormalizedSnapshot(byItem.get(String(item._id)) || []);
      // No snapshot yet (linked before the daily sync existed): fall back to the
      // live totals so the video still appears, marked as non-normalized.
      const source: any = picked?.snapshot ?? item.metrics ?? {};
      const measuredAt = picked?.measuredAt ?? "latest";

      let value: number;
      let leadSource: "ads" | "proxy" | undefined;

      if (metric === "leads") {
        const adLeads = Number(source.adLeads || 0);
        if (adLeads > 0) {
          value = adLeads;
          leadSource = "ads";
        } else {
          value = organicLeadProxy(source);
          leadSource = "proxy";
        }
      } else {
        value = Number(source.views || 0);
      }

      scored.push({
        videoItemId: String(item._id),
        planningId,
        numero: item.numero,
        tema: item.tema,
        guionResumen: scriptSummary(item),
        igPermalink: item.igPermalink,
        fechaPublicacion: item.fechaPublicacion,
        tipoGuion: item.tipoGuion,
        objetivo: item.scriptMeta?.objetivo,
        hookType: item.scriptMeta?.hookType,
        formato: item.scriptMeta?.formato,
        elementos: item.scriptMeta?.elementos as Record<string, boolean> | undefined,
        value,
        measuredAt,
        leadSource,
      });
    }

    return scored;
  }

  /** Average / median / lift per bucket of one dimension. */
  private aggregateDimension(
    videos: ScoredVideo[],
    dimension: string,
    bucketOf: (v: ScoredVideo) => string | undefined,
    overallAvg: number
  ): DimensionStat[] {
    const buckets = new Map<string, number[]>();

    for (const video of videos) {
      const bucket = bucketOf(video);
      if (!bucket) continue; // unclassified — excluded, never lumped into "other"
      const list = buckets.get(bucket) || [];
      list.push(video.value);
      buckets.set(bucket, list);
    }

    const stats: DimensionStat[] = [];
    for (const [bucket, values] of buckets) {
      const total = values.reduce((a, b) => a + b, 0);
      const avg = total / values.length;
      stats.push({
        dimension,
        bucket,
        n: values.length,
        avg: Math.round(avg * 100) / 100,
        median: Math.round(median(values) * 100) / 100,
        total: Math.round(total * 100) / 100,
        liftPct: overallAvg > 0 ? Math.round(((avg - overallAvg) / overallAvg) * 1000) / 10 : 0,
        lowConfidence: values.length < MIN_SAMPLE_FOR_CONFIDENCE,
      });
    }

    return stats.sort((a, b) => b.avg - a.avg);
  }

  private buildInsights(
    pareto: Omit<ParetoResult, "insights">,
    videos: ScoredVideo[]
  ): string[] {
    const insights: string[] = [];
    const metricLabel = pareto.metric === "views" ? "vistas" : "leads";

    if (!videos.length) return ["Aún no hay videos vinculados con métricas."];

    if (pareto.totalValue > 0) {
      insights.push(
        `${pareto.winnersCount} de ${pareto.totalVideos} videos concentran el ` +
          `${Math.round(pareto.actualShare * 100)}% de tus ${metricLabel}.`
      );
    }

    const confident = pareto.byDimension.filter((d) => !d.lowConfidence);
    const best = confident.filter((d) => d.liftPct > 0).sort((a, b) => b.liftPct - a.liftPct)[0];
    if (best) {
      insights.push(
        `"${best.bucket}" (${best.dimension}) rinde ${best.liftPct}% por encima del promedio ` +
          `en ${metricLabel}, sobre ${best.n} videos.`
      );
    }

    const worst = confident.filter((d) => d.liftPct < 0).sort((a, b) => a.liftPct - b.liftPct)[0];
    if (worst) {
      insights.push(
        `"${worst.bucket}" (${worst.dimension}) rinde ${Math.abs(worst.liftPct)}% por debajo del ` +
          `promedio. Revisar antes de repetirlo.`
      );
    }

    const unclassified = videos.filter((v) => !v.hookType && !v.objetivo).length;
    if (unclassified > 0) {
      insights.push(
        `${unclassified} videos sin clasificar quedaron fuera del desglose por tipo de guión.`
      );
    }

    const notNormalized = videos.filter((v) => v.measuredAt === "latest").length;
    if (notNormalized > 0) {
      insights.push(
        `${notNormalized} videos no tienen histórico dentro de los primeros ${NORMALIZATION_WINDOW_DAYS} días; ` +
          `se comparan con sus totales actuales y pueden verse inflados.`
      );
    }

    if (confident.length === 0 && pareto.byDimension.length > 0) {
      insights.push(
        `Ninguna dimensión llega a ${MIN_SAMPLE_FOR_CONFIDENCE} videos todavía. ` +
          `Los promedios son referenciales, no conclusiones.`
      );
    }

    return insights;
  }

  // ── PUBLIC: workspace Pareto ──────────────────────────────────────────────
  async getWorkspacePerformance(
    workspaceId: string,
    options: { metric?: PerformanceMetric; month?: string } = {}
  ): Promise<ParetoResult> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const metric = options.metric === "leads" ? "leads" : "views";
    const month = options.month;
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new Error("INVALID_MONTH");

    const scored = (await this.scoreVideos(workspaceId, metric, month)).sort(
      (a, b) => b.value - a.value
    );

    const totalValue = scored.reduce((a, b) => a + b.value, 0);
    const overallAvg = scored.length ? totalValue / scored.length : 0;

    let cumulative = 0;
    let thresholdIndex = -1;
    const videos = scored.map((v, i) => {
      const share = totalValue > 0 ? v.value / totalValue : 0;
      cumulative += share;
      if (thresholdIndex === -1 && cumulative >= PARETO_TARGET) thresholdIndex = i;
      return {
        ...v,
        share: Math.round(share * 10000) / 10000,
        cumulativeShare: Math.round(cumulative * 10000) / 10000,
      };
    });

    // Every video together may still not reach 80% only when total is 0.
    if (thresholdIndex === -1) thresholdIndex = Math.max(0, videos.length - 1);
    const winnersCount = videos.length ? thresholdIndex + 1 : 0;
    const actualShare = videos.length ? videos[thresholdIndex].cumulativeShare : 0;

    const byDimension: DimensionStat[] = [
      ...this.aggregateDimension(scored, "tipoGuion", (v) => v.tipoGuion, overallAvg),
      ...this.aggregateDimension(scored, "objetivo", (v) => v.objetivo, overallAvg),
      ...this.aggregateDimension(scored, "hookType", (v) => v.hookType, overallAvg),
      ...this.aggregateDimension(scored, "formato", (v) => v.formato, overallAvg),
    ];

    // Elements are not mutually exclusive, so each gets its own con/sin split —
    // that is what answers "does adding a testimonial actually help?".
    const ELEMENT_KEYS = [
      "testimonio",
      "autoridad",
      "oferta",
      "ctaExplicito",
      "problemaNecesidad",
    ] as const;

    for (const key of ELEMENT_KEYS) {
      const classified = scored.filter((v) => v.elementos !== undefined);
      byDimension.push(
        ...this.aggregateDimension(
          classified,
          `elemento:${key}`,
          (v) => (v.elementos?.[key] ? `con ${key}` : `sin ${key}`),
          overallAvg
        )
      );
    }

    const leadSourceMix =
      metric === "leads"
        ? {
            ads: scored.filter((v) => v.leadSource === "ads").length,
            proxy: scored.filter((v) => v.leadSource === "proxy").length,
          }
        : undefined;

    const base: Omit<ParetoResult, "insights"> = {
      metric,
      month,
      totalVideos: videos.length,
      totalValue: Math.round(totalValue * 100) / 100,
      thresholdIndex,
      winnersCount,
      actualShare,
      winnersRatio: videos.length ? Math.round((winnersCount / videos.length) * 1000) / 1000 : 0,
      videos,
      byDimension,
      leadSourceMix,
    };

    return { ...base, insights: this.buildInsights(base, scored) };
  }

  // ── PUBLIC: single video timeline ─────────────────────────────────────────
  async getItemTimeline(workspaceId: string, itemId: string) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    return await models.videoMetricSnapshots
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        videoItemId: new Types.ObjectId(itemId),
      })
      .sort({ date: 1 })
      .lean();
  }

  // ── PUBLIC: cross-workspace comparison ────────────────────────────────────
  /**
   * Compare dimension performance across every workspace of a vertical.
   *
   * This is what answers "services are the most stable" with numbers instead
   * of impressions.
   */
  async getCrossWorkspacePerformance(options: {
    vertical?: string;
    metric?: PerformanceMetric;
    month?: string;
  }) {
    const metric = options.metric === "leads" ? "leads" : "views";

    const query: Record<string, any> = { isActive: true };
    if (options.vertical) {
      query["brandProfile.vertical"] = options.vertical;
    }

    const workspaces = await models.workspaces
      .find(query)
      .select("_id name brandProfile.vertical")
      .lean();

    const results = [];
    for (const workspace of workspaces) {
      try {
        const perf = await this.getWorkspacePerformance(String(workspace._id), {
          metric,
          month: options.month,
        });
        if (!perf.totalVideos) continue;
        results.push({
          workspaceId: String(workspace._id),
          workspaceName: (workspace as any).name,
          vertical: (workspace as any).brandProfile?.vertical,
          totalVideos: perf.totalVideos,
          totalValue: perf.totalValue,
          avgValue: Math.round((perf.totalValue / perf.totalVideos) * 100) / 100,
          winnersCount: perf.winnersCount,
          actualShare: perf.actualShare,
          topDimensions: perf.byDimension.filter((d) => !d.lowConfidence).slice(0, 3),
        });
      } catch {
        // A broken workspace must not sink the whole comparison.
      }
    }

    return {
      metric,
      month: options.month,
      vertical: options.vertical,
      workspaces: results.sort((a, b) => b.avgValue - a.avgValue),
    };
  }
}

export const scriptPerformanceService = new ScriptPerformanceService();
