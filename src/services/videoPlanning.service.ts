import axios from "axios";
import { Types } from "mongoose";
import models from "../models";
import type { IVideoPlanning, IVideoItem, IScriptMeta, ClienteAprobacion } from "../models/videoPlanning.model";
import { notificationService } from "./notification.service";
import { scriptClassifierService } from "./scriptClassifier.service";
import { metaService } from "./meta.service";
import { getTodayEcuador } from "./tumesero.service";
import { extractLeadActions } from "../utils/metaActions";
import cloudinary from "../config/cloudinary";

/** Extract Cloudinary public_id from a secure_url */
function extractCloudinaryPublicId(url: string): string | null {
  // e.g. https://res.cloudinary.com/cloud/video/upload/v123/folder/file.mp4
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.[^.]+$/);
  return match ? match[1] : null;
}

/** Delete a Cloudinary asset by URL (best-effort, never throws) */
async function deleteCloudinaryAsset(url: string): Promise<void> {
  try {
    const publicId = extractCloudinaryPublicId(url);
    if (!publicId) return;
    const resourceType = /\/video\/upload\//i.test(url) ? "video" : "image";
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType });
  } catch (err: any) {
    console.warn("[VideoPlanningService] Cloudinary delete failed:", err.message);
  }
}

// ── Meta Graph helpers ──────────────────────────────────────────────────────
const GRAPH_URL = "https://graph.facebook.com/v22.0";

/** GET a Graph endpoint. Returns `null` instead of throwing on any failure. */
async function graphGet(path: string, params: Record<string, any>): Promise<any | null> {
  try {
    const res = await axios.get(`${GRAPH_URL}/${path}`, { params });
    return res.data ?? null;
  } catch {
    return null;
  }
}

/** Flatten an insights `data[]` payload into `{ metricName: value }`. */
function flattenInsights(payload: any): Record<string, number> {
  if (!payload?.data) return {};
  return Object.fromEntries(
    payload.data.map((m: any) => [m.name, Number(m.values?.[0]?.value ?? m.value ?? 0)])
  );
}

/**
 * Instagram media insights.
 *
 * Graph rejects the whole request when a single metric is unsupported for the
 * media type, so the calls are split: a core set, an optional lead-intent set,
 * and a legacy fallback for pre-v22 media that still only exposes `plays`.
 */
async function fetchIgMediaInsights(
  mediaId: string,
  token: string
): Promise<Record<string, number> | null> {
  const core = await graphGet(`${mediaId}/insights`, {
    access_token: token,
    metric: "views,reach,likes,comments,saved,shares,total_interactions",
  });

  let values = flattenInsights(core);

  if (!core) {
    // Older media (feed images, pre-v22 videos): legacy metric names.
    const legacy = await graphGet(`${mediaId}/insights`, {
      access_token: token,
      metric: "reach,impressions,plays,saved,total_interactions",
    });
    values = flattenInsights(legacy);
  }

  // Best-effort: not exposed for every media type or permission set.
  const intent = await graphGet(`${mediaId}/insights`, {
    access_token: token,
    metric: "profile_visits,follows",
  });
  values = { ...values, ...flattenInsights(intent) };

  return Object.keys(values).length ? values : null;
}

/** Facebook page-post insights + engagement counts. */
async function fetchFbPostInsights(
  postId: string,
  token: string
): Promise<{
  views: number;
  reach: number;
  impressions: number;
  likes: number;
  comments: number;
  shares: number;
} | null> {
  const [post, insights] = await Promise.all([
    graphGet(`${postId}`, {
      access_token: token,
      fields:
        "shares,likes.summary(true).limit(0),comments.summary(true).limit(0)",
    }),
    graphGet(`${postId}/insights`, {
      access_token: token,
      metric: "post_impressions,post_impressions_unique,post_video_views",
    }),
  ]);

  if (!post && !insights) return null;

  const v = flattenInsights(insights);
  return {
    views: Number(v.post_video_views ?? 0),
    reach: Number(v.post_impressions_unique ?? 0),
    impressions: Number(v.post_impressions ?? 0),
    likes: Number(post?.likes?.summary?.total_count ?? 0),
    comments: Number(post?.comments?.summary?.total_count ?? 0),
    shares: Number(post?.shares?.count ?? 0),
  };
}

/** Whole days between publication and today (Ecuador calendar). */
function ageInDays(fechaPublicacion: Date | undefined, today: string): number | undefined {
  if (!fechaPublicacion) return undefined;
  const published = Date.parse(
    `${new Date(fechaPublicacion).toISOString().slice(0, 10)}T00:00:00Z`
  );
  const current = Date.parse(`${today}T00:00:00Z`);
  if (Number.isNaN(published) || Number.isNaN(current)) return undefined;
  return Math.max(0, Math.round((current - published) / 86_400_000));
}

/**
 * Upsert today's immutable snapshot for this item.
 *
 * `item.metrics` is a destructive overwrite; this is what makes age-normalized
 * comparison and growth curves possible. Never throws — a failed snapshot must
 * not break the sync.
 */
async function recordMetricSnapshot(
  planning: IVideoPlanning,
  item: IVideoItem,
  metrics: any,
  sawOrganic: boolean,
  sawPaid: boolean
): Promise<void> {
  if (!sawOrganic && !sawPaid) return;

  try {
    const date = getTodayEcuador();
    const source = sawOrganic && sawPaid ? "merged" : sawPaid ? "ads" : "organic";

    await models.videoMetricSnapshots.findOneAndUpdate(
      { videoItemId: item._id, date },
      {
        $set: {
          workspaceId: planning.workspaceId,
          planningId: planning._id,
          igMediaId: item.igMediaId,
          fbPostId: item.fbPostId,
          metaAdId: item.metaAdId,
          ageDays: ageInDays(item.fechaPublicacion, date),
          views: Number(metrics.views || 0),
          reach: Number(metrics.reach || 0),
          impressions: Number(metrics.impressions || 0),
          likes: Number(metrics.likes || 0),
          comments: Number(metrics.comments || 0),
          saved: Number(metrics.saved || 0),
          shares: Number(metrics.shares || 0),
          profileVisits: Number(metrics.profileVisits || 0),
          follows: Number(metrics.follows || 0),
          adSpend: Number(metrics.adSpend || 0),
          adLeads: Number(metrics.adLeads || 0),
          adROAS: Number(metrics.adROAS || 0),
          source,
        },
      },
      { upsert: true, new: true }
    );
  } catch (err: any) {
    console.warn(
      `[VideoPlanningService] Snapshot upsert failed for item ${item._id}:`,
      err.message
    );
  }
}

// Fields an editor (internalRole=editor) is allowed to modify
const EDITOR_ALLOWED_FIELDS = new Set(["estadoProduccion", "edicion"]);

export class VideoPlanningService {
  // ── GET ────────────────────────────────────────────────────────────────────
  async getByEntry(entryId: string): Promise<IVideoPlanning | null> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");
    return await models.videoPlanning
      .findOne({ planningEntryId: new Types.ObjectId(entryId) })
      .lean<IVideoPlanning>();
  }

  // ── UPSERT (POST = create / PUT = replace items) ───────────────────────────
  async upsert(
    entryId: string,
    workspaceId: string,
    items: Partial<IVideoItem>[]
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");

    // Normalise items: assign numero + order if missing
    const normalised = items.map((item, i) => ({
      ...item,
      numero: item.numero ?? i + 1,
      order: item.order ?? i,
      estadoIdea: item.estadoIdea ?? "POR_REVISAR",
      estadoProduccion: item.estadoProduccion ?? "POR_GRABAR",
      edicion: item.edicion ?? "POR_EDITAR",
      estadoPublicacion: item.estadoPublicacion ?? "POR_PUBLICAR",
      clienteAprobacion: item.clienteAprobacion ?? "PENDIENTE",
    }));

    const existing = await models.videoPlanning.findOne({
      planningEntryId: new Types.ObjectId(entryId),
    });

    if (existing) {
      if (existing.clienteAprobado) {
        // Planning is locked: only allow appending brand-new items (no _id)
        const newOnly = normalised.filter((i) => !i._id);
        if (newOnly.length === 0) throw new Error("LOCKED");

        // Re-number new items after the existing ones
        const base = existing.items.length;
        const toAppend = newOnly.map((item, i) => ({
          ...item,
          numero: base + i + 1,
          order: base + i,
          clienteAprobacion: "PENDIENTE" as ClienteAprobacion,
        }));
        existing.items.push(...(toAppend as IVideoItem[]));
        await existing.save();
        return existing.toObject() as IVideoPlanning;
      }

      // Detect items removed that had Cloudinary assets → delete them (fire & forget)
      const newIds = new Set(normalised.map((i) => i._id?.toString()).filter(Boolean));
      const removedWithAssets = existing.items.filter(
        (i) =>
          !newIds.has(i._id.toString()) &&
          i.linkVideo &&
          /res\.cloudinary\.com/i.test(i.linkVideo)
      );
      if (removedWithAssets.length) {
        Promise.all(removedWithAssets.map((i) => deleteCloudinaryAsset(i.linkVideo!))).catch(() => {});
      }

      existing.items = normalised as IVideoItem[];
      await existing.save();

      // Notify non-internal workspace users that planning was re-sent
      notificationService
        .createForWorkspaceUsers(
          existing.workspaceId.toString(),
          true,
          "video_planning_resent",
          "Planificación actualizada",
          "Se ha actualizado la planificación de videos de tu entorno."
        )
        .catch(() => {});

      return existing.toObject() as IVideoPlanning;
    }

    const planning = new models.videoPlanning({
      planningEntryId: new Types.ObjectId(entryId),
      workspaceId: new Types.ObjectId(workspaceId),
      items: normalised,
    });
    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── UPDATE SINGLE ITEM (PATCH) ─────────────────────────────────────────────
  async updateItem(
    planningId: string,
    itemId: string,
    fields: Record<string, unknown>,
    internalRole?: string,
    platformFlags?: { publishToInstagram?: boolean; publishToFacebook?: boolean }
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) throw new Error("ITEM_NOT_FOUND");

    // Field-level permission: editor can only modify estadoProduccion & edicion
    const isEditor = internalRole === "editor";
    const allowedKeys = isEditor ? EDITOR_ALLOWED_FIELDS : null;

    // All content fields are mutable via PATCH — the lock (clienteAprobado) only prevents
    // replacing ALL items via PUT/POST. Individual item edits are always allowed for internal team.
    const MUTABLE_FIELDS = new Set([
      "tema", "descripcion", "tipo", "tipoGuion", "linkEjemplo", "recursos",
      "lugarGrabacion", "guion", "estadoIdea", "estadoProduccion",
      "edicion", "estadoPublicacion", "comentario", "motivoRechazo",
      "linkVideo", "fechaPublicacion", "copyPublicacion",
      "casoUsoRef", "igMediaId", "igPermalink", "metaAdId", "metrics",
      "scriptMeta",
    ]);

    const wasPublicado = item.estadoPublicacion === "PUBLICADO";

    for (const [key, value] of Object.entries(fields)) {
      if (!MUTABLE_FIELDS.has(key)) continue;
      if (allowedKeys && !allowedKeys.has(key)) continue;
      (item as any)[key] = value;
    }

    await planning.save();

    // Notify non-internal workspace users when a video reaches PUBLICADO
    const isNowPublicado = item.estadoPublicacion === "PUBLICADO";
    if (!wasPublicado && isNowPublicado) {
      notificationService
        .createForWorkspaceUsers(
          planning.workspaceId.toString(),
          true,
          "video_status_changed",
          "Video publicado",
          `Un video de tu planificación ha sido publicado: "${(item as any).tema || "sin título"}".`
        )
        .catch(() => {});
    }

    // ── Social media scheduling (opt-in via platformFlags) ────────────────
    // NOTE: Instagram scheduling is temporarily disabled.
    // The Meta Content Publishing API requires the app to be approved (out of Development Mode)
    // so that any Instagram Business account can use it without being manually added as a tester.
    // Re-enable the Instagram block below once the Meta App Review is approved.
    const canSchedule =
      (item as any).fechaPublicacion &&
      (item as any).linkVideo &&
      platformFlags?.publishToFacebook; // publishToInstagram intentionally excluded for now

    if (canSchedule) {
      const workspace = await models.workspaces.findById(planning.workspaceId).lean();
      const meta = workspace?.metaAds;
      const scheduledAt = new Date((item as any).fechaPublicacion);

      if (meta?.pageId && meta?.accessToken) {
        // ── Instagram (DISABLED — pending Meta App Review approval) ───────
        // if (platformFlags?.publishToInstagram) {
        //   try {
        //     const result = await metaService.scheduleInstagramPost({
        //       pageId: meta.pageId,
        //       userAccessToken: meta.accessToken,
        //       pageAccessToken: meta.pageAccessToken,
        //       mediaUrl: (item as any).linkVideo,
        //       caption: (item as any).copyPublicacion || "",
        //       scheduledAt,
        //     });
        //     (item as any).igContainerId = result.containerId;
        //     (item as any).igScheduleStatus = "SCHEDULED";
        //     (item as any).igScheduleError = undefined;
        //   } catch (igErr: any) {
        //     console.warn("[VideoPlanningService] Instagram scheduling failed:", igErr.message);
        //     (item as any).igScheduleStatus = "FAILED";
        //     (item as any).igScheduleError = igErr.message;
        //   }
        // }

        // ── Facebook ───────────────────────────────────────────────────────
        if (platformFlags?.publishToFacebook && meta.pageAccessToken) {
          try {
            const result = await metaService.scheduleFacebookPost({
              pageId: meta.pageId,
              pageAccessToken: meta.pageAccessToken,
              mediaUrl: (item as any).linkVideo,
              caption: (item as any).copyPublicacion || "",
              scheduledAt,
            });
            (item as any).fbPostId = result.postId;
            (item as any).fbScheduleStatus = "SCHEDULED";
            (item as any).fbScheduleError = undefined;
          } catch (fbErr: any) {
            console.warn("[VideoPlanningService] Facebook scheduling failed:", fbErr.message);
            (item as any).fbScheduleStatus = "FAILED";
            (item as any).fbScheduleError = fbErr.message;
          }
        }

        await planning.save();
      }
    }

    return planning.toObject() as IVideoPlanning;
  }

  // ── CLIENT APPROVAL (POST) ─────────────────────────────────────────────────
  async submitClientApproval(
    planningId: string,
    approvals: { itemId: string; clienteAprobacion: ClienteAprobacion; motivoRechazo?: string }[],
    userId: string
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId)) throw new Error("INVALID_ID");

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");
    if (planning.clienteAprobado) throw new Error("LOCKED");

    // Apply per-item approvals
    for (const approval of approvals) {
      if (!Types.ObjectId.isValid(approval.itemId)) continue;
      const item = planning.items.find((i) => i._id.toString() === approval.itemId);
      if (item) {
        item.clienteAprobacion = approval.clienteAprobacion;
        // Auto-approve idea when client approves the video
        if (approval.clienteAprobacion === "APROBADO") {
          item.estadoIdea = "APROBADO";
        }
        if (approval.motivoRechazo !== undefined) {
          item.motivoRechazo = approval.motivoRechazo;
        }
      }
    }

    // Lock the document
    planning.clienteAprobado = true;
    planning.clienteAprobadoAt = new Date();
    planning.clienteAprobadoPor = new Types.ObjectId(userId);

    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── REOPEN (POST) ───────────────────────────────────────────────────────────
  async reopen(planningId: string): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId)) throw new Error("INVALID_ID");

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");
    if (!planning.clienteAprobado) throw new Error("NOT_LOCKED");

    // Only reopen if there are rejected items
    const hasRejected = planning.items.some(
      (i) => i.clienteAprobacion === "RECHAZADO"
    );
    if (!hasRejected) throw new Error("NO_REJECTED");

    // Reset lock
    planning.clienteAprobado = false;
    planning.clienteAprobadoAt = undefined;
    planning.clienteAprobadoPor = undefined;

    // Reset rejected items back to PENDIENTE
    for (const item of planning.items) {
      if (item.clienteAprobacion === "RECHAZADO") {
        item.clienteAprobacion = "PENDIENTE";
        item.motivoRechazo = undefined;
      }
    }

    await planning.save();
    return planning.toObject() as IVideoPlanning;
  }

  // ── CALENDAR ITEMS (GET) ──────────────────────────────────────────────────
  async getCalendarItems(
    workspaceId: string,
    startDate: Date,
    endDate: Date
  ): Promise<object[]> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const plannings = await models.videoPlanning
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        "items.fechaPublicacion": { $gte: startDate, $lte: endDate },
      })
      .lean<IVideoPlanning[]>();

    const result: object[] = [];
    for (const p of plannings) {
      for (const item of p.items) {
        if (
          item.fechaPublicacion &&
          item.fechaPublicacion >= startDate &&
          item.fechaPublicacion <= endDate
        ) {
          result.push({
            _id: item._id,
            planningId: p._id,
            entryId: p.planningEntryId,
            workspaceId: p.workspaceId,
            numero: item.numero,
            tema: item.tema,
            tipo: item.tipo,
            estadoPublicacion: item.estadoPublicacion,
            edicion: item.edicion,
            estadoProduccion: item.estadoProduccion,
            clienteAprobacion: item.clienteAprobacion,
            linkVideo: item.linkVideo,
            fechaPublicacion: item.fechaPublicacion,
            copyPublicacion: item.copyPublicacion,
            // Same attributes the builder shows, so an event on the calendar
            // and a row in the matrix are recognisably the same thing.
            tipoGuion: item.tipoGuion ?? null,
            objetivo: item.scriptMeta?.objetivo ?? null,
            casoUsoRef: item.casoUsoRef ?? null,
            tieneGuion: !!(item.guion || item.guionIA?.gancho),
            igMediaId: item.igMediaId ?? null,
            metaAdId: item.metaAdId ?? null,
          });
        }
      }
    }
    return result;
  }

  // ── LINK PUBLISHED REEL MEDIA ─────────────────────────────────────────────
  async linkReelMedia(
    planningId: string,
    itemId: string,
    data: { igMediaId?: string; igPermalink?: string; metaAdId?: string; casoUsoRef?: number }
  ): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) throw new Error("ITEM_NOT_FOUND");

    // Cada fuente se escribe solo si viene en el body, y una cadena vacia
    // desvincula. Antes se asignaba igMediaId siempre y metaAdId solo si era
    // truthy: no habia forma de quitar un anuncio mal vinculado, y un guion
    // pautado sin reel terminaba con igMediaId en undefined.
    if (data.igMediaId !== undefined) {
      item.igMediaId = data.igMediaId || undefined;
      // El permalink pertenece al reel; si se desvincula, deja de aplicar.
      if (!data.igMediaId) item.igPermalink = undefined;
    }
    if (data.igPermalink) item.igPermalink = data.igPermalink;
    if (data.metaAdId !== undefined) item.metaAdId = data.metaAdId || undefined;
    if (data.casoUsoRef !== undefined) item.casoUsoRef = data.casoUsoRef;

    // Solo cuenta como publicado si quedo vinculado a algo real.
    if (item.igMediaId || item.metaAdId) item.estadoPublicacion = "PUBLICADO";

    await planning.save();

    // Trigger metrics fetch immediately for the newly linked Reel
    try {
      await this.syncVideoItemMetrics(planningId, itemId);
    } catch {
      // Non-blocking metrics sync
    }

    return (await models.videoPlanning.findById(planningId)) || planning;
  }

  // ── SYNC METRICS FOR A SINGLE VIDEO ITEM ─────────────────────────────────
  async syncVideoItemMetrics(planningId: string, itemId: string): Promise<IVideoPlanning> {
    if (!Types.ObjectId.isValid(planningId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) throw new Error("ITEM_NOT_FOUND");

    if (!item.igMediaId && !item.metaAdId && !item.fbPostId) {
      return planning;
    }

    const token = await metaService.getGlobalAccessToken().catch(() => null);
    if (!token) return planning;

    const metrics: any = { ...(item.metrics || {}), lastSyncedAt: new Date() };
    let sawOrganic = false;
    let sawPaid = false;

    // ── Instagram (organic) ────────────────────────────────────────────────
    if (item.igMediaId) {
      try {
        const [mediaRes, insightsRes] = await Promise.all([
          graphGet(`${item.igMediaId}`, {
            access_token: token,
            fields:
              "id,caption,media_type,permalink,thumbnail_url,media_url,like_count,comments_count",
          }),
          fetchIgMediaInsights(item.igMediaId, token),
        ]);

        if (mediaRes) {
          sawOrganic = true;
          metrics.likes = Number(mediaRes.like_count || 0);
          metrics.comments = Number(mediaRes.comments_count || 0);
          if (mediaRes.permalink && !item.igPermalink) item.igPermalink = mediaRes.permalink;
          if (mediaRes.media_url && !item.linkVideo) item.linkVideo = mediaRes.media_url;
        }

        if (insightsRes) {
          sawOrganic = true;
          // `views` is the v22 native metric; `plays`/`impressions` are
          // deprecated for Reels and only survive on older media.
          metrics.views = Number(insightsRes.views ?? insightsRes.plays ?? 0);
          metrics.reach = Number(insightsRes.reach ?? 0);
          metrics.impressions = Number(insightsRes.impressions ?? 0);
          metrics.saved = Number(insightsRes.saved ?? 0);
          metrics.shares = Number(insightsRes.shares ?? 0);
          metrics.profileVisits = Number(insightsRes.profile_visits ?? 0);
          metrics.follows = Number(insightsRes.follows ?? 0);
          if (insightsRes.likes !== undefined) metrics.likes = Number(insightsRes.likes);
          if (insightsRes.comments !== undefined) metrics.comments = Number(insightsRes.comments);
        }
      } catch (err: any) {
        console.warn(
          `[VideoPlanningService] Failed to sync IG media ${item.igMediaId}:`,
          err.message
        );
      }
    }

    // ── Facebook post (organic) ────────────────────────────────────────────
    // Only used when there is no IG media, so a cross-posted Reel does not get
    // its Instagram numbers overwritten by the Facebook copy.
    if (item.fbPostId && !item.igMediaId) {
      try {
        const fb = await fetchFbPostInsights(item.fbPostId, token);
        if (fb) {
          sawOrganic = true;
          metrics.views = fb.views;
          metrics.reach = fb.reach;
          metrics.impressions = fb.impressions;
          metrics.likes = fb.likes;
          metrics.comments = fb.comments;
          metrics.shares = fb.shares;
        }
      } catch (err: any) {
        console.warn(
          `[VideoPlanningService] Failed to sync FB post ${item.fbPostId}:`,
          err.message
        );
      }
    }

    // ── Meta Ads (paid) ────────────────────────────────────────────────────
    if (item.metaAdId) {
      try {
        const adRes = await graphGet(`${item.metaAdId}/insights`, {
          access_token: token,
          // Lifetime numbers — a video's total performance, not a rolling window.
          date_preset: "maximum",
          fields: "spend,clicks,impressions,reach,actions,purchase_roas",
        });

        const row = adRes?.data?.[0];
        if (row) {
          sawPaid = true;
          metrics.adSpend = Number(row.spend || 0);
          metrics.adLeads = extractLeadActions(row.actions);
          const roasVal = row.purchase_roas?.[0]?.value;
          metrics.adROAS = roasVal ? Number(roasVal) : 0;
        }
      } catch (err: any) {
        console.warn(
          `[VideoPlanningService] Failed to sync Meta Ad ${item.metaAdId}:`,
          err.message
        );
      }
    }

    item.metrics = metrics;
    await planning.save();

    await recordMetricSnapshot(planning, item, metrics, sawOrganic, sawPaid);

    return planning;
  }

  // ── ALL ITEMS OF A WORKSPACE ──────────────────────────────────────────────
  /**
   * Every script of a workspace, across all of its plannings.
   *
   * The Content Builder works at workspace level, not per monthly planning, so
   * it needs one flat list. Each item carries its `planningId` because updating
   * an item requires knowing which planning document holds it.
   */
  async getWorkspaceItems(
    workspaceId: string
  ): Promise<Array<IVideoItem & { planningId: string; planningEntryId: string }>> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const plannings = await models.videoPlanning
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .lean<IVideoPlanning[]>();

    const result: Array<
      IVideoItem & { planningId: string; planningEntryId: string; planningCreatedAt: Date }
    > = [];
    for (const planning of plannings) {
      for (const item of planning.items || []) {
        result.push({
          ...(item as any),
          planningId: String(planning._id),
          planningEntryId: String(planning.planningEntryId),
          planningCreatedAt: planning.createdAt,
        });
      }
    }

    /**
     * Newest first.
     *
     * Most items have no `fechaPublicacion` — the team rarely fills it — so
     * sorting on it alone dumped almost everything into one undated bucket in
     * arbitrary order. The planning's own date stands in for those, which keeps
     * the months in order, and the script number orders within a month.
     */
    const sortKey = (i: (typeof result)[number]) =>
      new Date(i.fechaPublicacion ?? i.planningCreatedAt ?? 0).getTime();

    return result.sort((a, b) => {
      const diff = sortKey(b) - sortKey(a);
      if (diff !== 0) return diff;
      return (b.numero ?? 0) - (a.numero ?? 0);
    });
  }

  // ── CLASSIFY SCRIPT STRUCTURE ─────────────────────────────────────────────
  /**
   * Tag one item's script with its structural attributes.
   *
   * A human classification is never overwritten unless `force` is set — the
   * team's judgement outranks the model's.
   */
  async classifyItemScript(
    planningId: string,
    itemId: string,
    options: { force?: boolean } = {}
  ): Promise<{ planning: IVideoPlanning; scriptMeta: IScriptMeta | null; skipped?: string }> {
    if (!Types.ObjectId.isValid(planningId) || !Types.ObjectId.isValid(itemId)) {
      throw new Error("INVALID_ID");
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new Error("NOT_FOUND");

    const item = planning.items.find((i) => i._id.toString() === itemId);
    if (!item) throw new Error("ITEM_NOT_FOUND");

    if (item.scriptMeta?.clasificadoPor === "humano" && !options.force) {
      return { planning, scriptMeta: item.scriptMeta, skipped: "HUMAN_CLASSIFIED" };
    }

    const scriptMeta = await scriptClassifierService.classify(item);
    if (!scriptMeta) {
      return { planning, scriptMeta: null, skipped: "NOT_ENOUGH_TEXT" };
    }

    item.scriptMeta = scriptMeta;
    await planning.save();

    return { planning, scriptMeta };
  }

  // ── BULK DAILY SYNC (cron) ────────────────────────────────────────────────
  /**
   * Re-sync every linked video published within `windowDays`.
   *
   * Runs strictly sequentially with a small delay: there is no job queue in
   * this project and Graph API throttles hard per app.
   */
  async syncRecentMetrics(
    options: { windowDays?: number; workspaceId?: string; delayMs?: number } = {}
  ): Promise<{ scanned: number; synced: number; failed: number }> {
    const windowDays = options.windowDays ?? 90;
    const delayMs = options.delayMs ?? 350;

    const since = new Date(Date.now() - windowDays * 86_400_000);

    const query: Record<string, any> = {
      "items.fechaPublicacion": { $gte: since },
    };
    if (options.workspaceId && Types.ObjectId.isValid(options.workspaceId)) {
      query.workspaceId = new Types.ObjectId(options.workspaceId);
    }

    const plannings = await models.videoPlanning.find(query).select("_id items");

    const targets: Array<{ planningId: string; itemId: string }> = [];
    for (const planning of plannings) {
      for (const item of planning.items) {
        const linked = item.igMediaId || item.metaAdId || item.fbPostId;
        if (!linked) continue;
        if (!item.fechaPublicacion || item.fechaPublicacion < since) continue;
        targets.push({
          planningId: planning._id!.toString(),
          itemId: item._id.toString(),
        });
      }
    }

    let synced = 0;
    let failed = 0;

    for (const target of targets) {
      try {
        await this.syncVideoItemMetrics(target.planningId, target.itemId);
        synced++;
      } catch (err: any) {
        failed++;
        console.warn(
          `[VideoPlanningService] Bulk sync failed for item ${target.itemId}:`,
          err.message
        );
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    }

    return { scanned: targets.length, synced, failed };
  }
}
