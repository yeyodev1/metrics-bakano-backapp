import { Types } from "mongoose";
import models from "../models";
import type { IVideoItem } from "../models/videoPlanning.model";
import { scriptPerformanceService, type PerformanceMetric } from "./scriptPerformance.service";
import { engramService } from "./engram.service";

export interface AgentFeedOptions {
  /** Inclusive lower bound on `fechaPublicacion` (YYYY-MM-DD). */
  from?: string;
  /** Inclusive upper bound on `fechaPublicacion` (YYYY-MM-DD). */
  to?: string;
  /** Shorthand for a whole month (YYYY-MM). Overrides from/to. */
  month?: string;
}

function monthBounds(month: string): { from: string; to: string } {
  const [year, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(year, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, "0")}` };
}

function toDay(date?: Date | string): string | null {
  if (!date) return null;
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

/**
 * The full script, not a flattened excerpt.
 *
 * The feed used to send `guion || guionIA.cuerpo`, which dropped the hook, the
 * on-screen text, the CTA and the b-roll — exactly the parts an agent needs to
 * learn what works.
 */
function renderScript(item: IVideoItem) {
  const ia = item.guionIA;
  return {
    textoLibre: item.guion || "",
    estructurado: ia
      ? {
          conceptoVisual: ia.conceptoVisual || "",
          hook1: ia.gancho || "",
          textoPantalla: ia.textoPantalla || "",
          cuerpo: ia.cuerpo || "",
          cta: ia.cta || "",
          broll: ia.broll || "",
          generadoEn: ia.generadoEn ?? null,
          contextoMes: ia.contextoMes ?? null,
        }
      : null,
    /** Everything as one readable block, for prompts that want plain text. */
    completo: ia
      ? [
          ia.gancho && `HOOK 1: ${ia.gancho}`,
          ia.textoPantalla && `TEXTO EN PANTALLA: ${ia.textoPantalla}`,
          ia.cuerpo && `CUERPO (abre con HOOK 2): ${ia.cuerpo}`,
          ia.cta && `CTA: ${ia.cta}`,
          ia.broll && `B-ROLL: ${ia.broll}`,
        ]
          .filter(Boolean)
          .join("\n")
      : item.guion || "",
  };
}

export class AgentFeedService {
  /**
   * What this brand is missing for the analysis to mean anything.
   *
   * An agent that does not know the journey is empty will happily invent one;
   * saying it outright is cheaper than letting it guess.
   */
  private gaps(workspace: any, guiones: any[], conFecha: number): string[] {
    const bp = workspace.brandProfile ?? {};
    const gaps: string[] = [];

    if (!bp.propuestaValor) gaps.push("Sin propuesta de valor definida.");
    if (!bp.segmentosMercado?.length) gaps.push("Sin segmentos de mercado definidos.");
    if (!bp.canalesDetail?.length) gaps.push("Sin canales definidos.");
    if (!bp.customerJourneyCases?.length) {
      gaps.push(
        "Sin Customer Journey: no hay casos de cliente, así que no se puede anclar el hook a un dolor concreto."
      );
    }

    const sinReel = guiones.filter((g) => !g.publicacion.igMediaId).length;
    if (sinReel === guiones.length && guiones.length > 0) {
      gaps.push(
        "Ningún guión está vinculado a su publicación, por lo que no hay métricas y el análisis de desempeño viene vacío."
      );
    } else if (sinReel > 0) {
      gaps.push(`${sinReel} de ${guiones.length} guiones no están vinculados a su publicación.`);
    }

    const sinClasificar = guiones.filter((g) => !g.clasificacion.tipoGancho).length;
    if (sinClasificar > 0) {
      gaps.push(
        `${sinClasificar} de ${guiones.length} guiones no están clasificados (tipo de gancho, objetivo, elementos), así que quedan fuera del desglose por tipo de guión.`
      );
    }

    const sinFecha = guiones.length - conFecha;
    if (sinFecha > 0) {
      gaps.push(
        `${sinFecha} de ${guiones.length} guiones no tienen fecha de publicación; el rango de fechas solo refleja los ${conFecha} que sí la tienen.`
      );
    }

    const sinTexto = guiones.filter((g) => !g.guion.completo).length;
    if (sinTexto > 0) {
      gaps.push(`${sinTexto} de ${guiones.length} guiones no tienen texto escrito todavía.`);
    }

    return gaps;
  }

  /**
   * Everything the scripting agent needs about one brand: its strategy, its
   * scripts with dates and full text, what the numbers say works, and what has
   * already been learned.
   */
  async build(workspaceId: string, options: AgentFeedOptions = {}) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces.findById(workspaceId).lean<any>();
    if (!workspace) throw new Error("NOT_FOUND");

    const range = options.month ? monthBounds(options.month) : { from: options.from, to: options.to };

    // ── Scripts ───────────────────────────────────────────────────────────
    const plannings = await models.videoPlanning
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .lean<any[]>();

    const guiones: any[] = [];
    for (const planning of plannings) {
      for (const item of planning.items || []) {
        const dia = toDay(item.fechaPublicacion);
        if (range.from && (!dia || dia < range.from)) continue;
        if (range.to && (!dia || dia > range.to)) continue;

        guiones.push({
          videoItemId: String(item._id),
          planningId: String(planning._id),
          numero: item.numero,
          tema: item.tema,
          descripcion: item.descripcion || "",
          fechaPublicacion: dia,
          // What kind of script this is — the dimensions performance groups by.
          clasificacion: {
            etapaEmbudo: item.tipoGuion ?? null,
            objetivo: item.scriptMeta?.objetivo ?? null,
            tipoGancho: item.scriptMeta?.hookType ?? null,
            formato: item.scriptMeta?.formato ?? null,
            duracionSeg: item.scriptMeta?.duracionSeg ?? null,
            elementos: item.scriptMeta?.elementos ?? null,
            casoJourney: item.casoUsoRef ?? null,
            clasificadoPor: item.scriptMeta?.clasificadoPor ?? null,
          },
          guion: renderScript(item),
          publicacion: {
            estado: item.estadoPublicacion,
            igMediaId: item.igMediaId ?? null,
            igPermalink: item.igPermalink ?? null,
            fbPostId: item.fbPostId ?? null,
            metaAdId: item.metaAdId ?? null,
          },
          metricas: item.metrics ?? null,
        });
      }
    }

    guiones.sort((a, b) => (b.fechaPublicacion ?? "").localeCompare(a.fechaPublicacion ?? ""));

    const fechas = guiones.map((g) => g.fechaPublicacion).filter(Boolean).sort();

    // ── What actually works ───────────────────────────────────────────────
    const desempeno: Record<string, any> = {};
    for (const metric of ["views", "leads"] as PerformanceMetric[]) {
      try {
        const p = await scriptPerformanceService.getWorkspacePerformance(workspaceId, {
          metric,
          month: options.month,
        });
        desempeno[metric === "views" ? "porVistas" : "porLeads"] = {
          totalVideosMedidos: p.totalVideos,
          videosGanadores: p.winnersCount,
          concentracion: `${Math.round(p.actualShare * 100)}% de los ${
            metric === "views" ? "vistas" : "leads"
          } lo generan ${p.winnersCount} de ${p.totalVideos} videos`,
          topVideos: p.videos.slice(0, 5).map((v) => ({
            videoItemId: v.videoItemId,
            tema: v.tema,
            fechaPublicacion: v.fechaPublicacion ? toDay(v.fechaPublicacion) : null,
            valor: v.value,
            etapaEmbudo: v.tipoGuion ?? null,
            objetivo: v.objetivo ?? null,
            tipoGancho: v.hookType ?? null,
            gancho: v.guionResumen,
          })),
          // Only conclusions with enough sample size reach the agent.
          queFunciona: p.byDimension
            .filter((d) => !d.lowConfidence && d.liftPct > 0)
            .slice(0, 8)
            .map((d) => ({
              dimension: d.dimension,
              valor: d.bucket,
              rindeMasQuePromedio: `${d.liftPct}%`,
              muestra: d.n,
            })),
          queNoFunciona: p.byDimension
            .filter((d) => !d.lowConfidence && d.liftPct < 0)
            .slice(0, 8)
            .map((d) => ({
              dimension: d.dimension,
              valor: d.bucket,
              rindeMenosQuePromedio: `${Math.abs(d.liftPct)}%`,
              muestra: d.n,
            })),
          advertencias: p.insights,
          origenDeLeads: p.leadSourceMix ?? null,
        };
      } catch {
        desempeno[metric === "views" ? "porVistas" : "porLeads"] = null;
      }
    }

    const engram = await engramService.getActive(workspaceId).catch(() => null);

    // What the team observed but the numbers cannot show.
    const notas = await models.scriptFeedback
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .limit(80)
      .lean<any[]>();

    const temaPorItem = new Map(guiones.map((g) => [g.videoItemId, g.tema]));

    return {
      generadoEn: new Date().toISOString(),
      periodo: {
        desde: range.from ?? null,
        hasta: range.to ?? null,
        mes: options.month ?? null,
        // The real span of the data returned, which may be narrower.
        primerGuion: fechas[0] ?? null,
        ultimoGuion: fechas[fechas.length - 1] ?? null,
      },
      workspace: {
        id: String(workspace._id),
        nombre: workspace.name,
        instagram: workspace.metaAds?.instagramAccountName ?? null,
        pagina: workspace.metaAds?.pageName ?? null,
      },
      estrategia: {
        descripcion: workspace.brandProfile?.descripcion || "",
        propuestaValor: workspace.brandProfile?.propuestaValor || "",
        publicoObjetivo: workspace.brandProfile?.publicoObjetivo || "",
        tono: workspace.brandProfile?.tono || "",
        productosServicios: workspace.brandProfile?.productosServicios || "",
        problemaResuelto: workspace.brandProfile?.problemaResuelto || "",
        vertical: workspace.brandProfile?.vertical || "",
        tipoNegocio: workspace.brandProfile?.tipoNegocio ?? null,
        segmentosMercado: workspace.brandProfile?.segmentosMercado || [],
        canales: workspace.brandProfile?.canalesDetail || [],
        actividadesClave: workspace.brandProfile?.actividadesClave || [],
        customerJourney: workspace.brandProfile?.customerJourneyCases || [],
      },
      aprendizajes: engram
        ? {
            version: engram.version,
            aprobadoEn: engram.approvedAt ?? null,
            loQueFunciona: engram.winningPatterns.map((p) => p.patron),
            loQueNoFunciona: engram.losingPatterns.map((p) => p.patron),
            reglasDeTono: engram.toneRules,
            vocabularioMarca: engram.vocabularioMarca,
            vocabularioProhibido: engram.vocabularioProhibido,
            basadoEn: engram.basadoEn ?? null,
          }
        : null,
      desempeno,
      /**
       * Human observations, newest first. Treated as evidence about *why*
       * something worked — the metrics already cover *what* happened.
       */
      notasDelEquipo: notas.map((n) => ({
        fecha: n.createdAt,
        autor: n.authorName,
        tipo: n.tipo,
        sobreElGuion: n.videoItemId
          ? temaPorItem.get(String(n.videoItemId)) ?? n.videoTema ?? null
          : null,
        videoItemId: n.videoItemId ? String(n.videoItemId) : null,
        texto: n.texto,
      })),
      resumen: {
        totalGuiones: guiones.length,
        conFechaPublicacion: fechas.length,
        conReelVinculado: guiones.filter((g) => g.publicacion.igMediaId).length,
        conGuionEscrito: guiones.filter((g) => g.guion.completo).length,
        clasificados: guiones.filter((g) => g.clasificacion.tipoGancho).length,
      },
      // Stated plainly so the agent reasons with what exists instead of
      // inventing conclusions from gaps.
      datosFaltantes: this.gaps(workspace, guiones, fechas.length),
      guiones,
    };
  }
}

export const agentFeedService = new AgentFeedService();
