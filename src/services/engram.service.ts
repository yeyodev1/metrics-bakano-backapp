import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { Types } from "mongoose";
import models from "../models";
import type { IEngram } from "../models/engram.model";
import {
  scriptPerformanceService,
  type PerformanceMetric,
  type ScoredVideo,
} from "./scriptPerformance.service";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

/** How many winners / losers get sent to the model for synthesis. */
const SAMPLE_SIZE = 6;

/** Below this the sample is too thin to draw brand-level conclusions. */
const MIN_VIDEOS_FOR_REBUILD = 6;

const SYNTHESIS_PROMPT = `Eres un analista de comunicación de marca. Recibes los guiones de video que MEJOR y PEOR rindieron para una sola marca, con sus números reales.

Tu tarea: extraer los patrones que explican la diferencia. No resumas los guiones — explica QUÉ los hace funcionar.

Reglas estrictas:
- Cada patrón debe ser accionable al escribir el próximo guión. "Usar buenos ganchos" es inútil; "abrir nombrando el costo del problema en dólares" sirve.
- No inventes causalidad donde solo hay coincidencia. Si los ganadores no comparten nada claro, devuelve menos patrones — es válido devolver 1 o 2.
- Los patrones perdedores describen qué EVITAR, con la misma especificidad.
- "toneRules" captura cómo suena esta marca en particular, no buenas prácticas genéricas de marketing.
- "vocabularioMarca": palabras y expresiones concretas que esta marca usa y le funcionan.
- "vocabularioProhibido": muletillas, clichés o palabras que se repiten sin aportar. Es clave: los guiones genéricos se detectan por vocabulario repetido.
- Escribe en español, en segunda persona, dirigido a quien escribirá el guión.

Responde únicamente con el JSON del esquema.`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    winningPatterns: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          patron: { type: SchemaType.STRING },
          dimension: { type: SchemaType.STRING },
        },
        required: ["patron"],
      },
    },
    losingPatterns: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          patron: { type: SchemaType.STRING },
          dimension: { type: SchemaType.STRING },
        },
        required: ["patron"],
      },
    },
    toneRules: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          regla: { type: SchemaType.STRING },
          ejemploBueno: { type: SchemaType.STRING },
          ejemploMalo: { type: SchemaType.STRING },
        },
        required: ["regla"],
      },
    },
    vocabularioMarca: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    vocabularioProhibido: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: ["winningPatterns", "losingPatterns", "toneRules"],
} as const;

function describeVideos(videos: ScoredVideo[], metric: PerformanceMetric): string {
  const label = metric === "views" ? "vistas" : "leads";
  return videos
    .map(
      (v, i) =>
        `${i + 1}. [${v.value} ${label}] ${v.tema}\n` +
        `   Etapa: ${v.tipoGuion ?? "sin clasificar"} | Objetivo: ${v.objetivo ?? "?"} | ` +
        `Gancho: ${v.hookType ?? "?"}\n` +
        `   Guión: ${v.guionResumen}`
    )
    .join("\n\n");
}

export class EngramService {
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  /** The engram currently feeding the script generator, if any. */
  async getActive(workspaceId: string): Promise<IEngram | null> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    return await models.engrams
      .findOne({ workspaceId: new Types.ObjectId(workspaceId), status: "active" })
      .lean<IEngram>();
  }

  async listVersions(workspaceId: string): Promise<IEngram[]> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    return await models.engrams
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ version: -1 })
      .lean<IEngram[]>();
  }

  /**
   * Synthesize a new engram from this brand's best and worst performers.
   *
   * Always lands as `draft` — nothing reaches the prompt until a human
   * approves it.
   */
  async rebuild(
    workspaceId: string,
    options: { metric?: PerformanceMetric; month?: string; userId?: string } = {}
  ): Promise<IEngram> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

    const metric = options.metric ?? "views";
    const performance = await scriptPerformanceService.getWorkspacePerformance(workspaceId, {
      metric,
      month: options.month,
    });

    if (performance.totalVideos < MIN_VIDEOS_FOR_REBUILD) {
      throw new Error("NOT_ENOUGH_DATA");
    }

    const winners = performance.videos.slice(0, SAMPLE_SIZE);
    const losers = performance.videos.slice(-SAMPLE_SIZE).reverse();

    // The team's own notes: they explain causes the numbers never show.
    const notas = await models.scriptFeedback
      .find({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ createdAt: -1 })
      .limit(40)
      .lean<any[]>();

    const bloqueNotas = notas.length
      ? `\n\n=== OBSERVACIONES DEL EQUIPO ===
Escritas por quienes hicieron los videos. Explican causas que las métricas no
muestran. Cuando una nota contradiga a los números, señálalo en vez de ignorarla.

${notas
          .map((n) => `- [${n.authorName}${n.videoTema ? ` · ${n.videoTema}` : ""}] ${n.texto}`)
          .join("\n")}`
      : "";

    const userPrompt = `MÉTRICA ANALIZADA: ${metric === "views" ? "vistas" : "leads"}
PERÍODO: ${options.month ?? "todo el histórico"}
VIDEOS ANALIZADOS: ${performance.totalVideos}

=== GUIONES QUE MEJOR RINDIERON ===
${describeVideos(winners, metric)}

=== GUIONES QUE PEOR RINDIERON ===
${describeVideos(losers, metric)}${bloqueNotas}`;

    const model = this.genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYNTHESIS_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA as any,
        temperature: 0.4,
      },
    });

    const result = await model.generateContent(userPrompt);

    let parsed: any;
    try {
      parsed = JSON.parse(result.response.text());
    } catch {
      throw new Error("Gemini devolvió un engram no parseable.");
    }

    // Attach the real numbers so a reader can audit each claim.
    const evidenceFor = (videos: ScoredVideo[]) =>
      videos.slice(0, 3).map((v) => ({
        videoItemId: new Types.ObjectId(v.videoItemId),
        tema: v.tema,
        metrica: metric,
        valor: v.value,
      }));

    const latest = await models.engrams
      .findOne({ workspaceId: new Types.ObjectId(workspaceId) })
      .sort({ version: -1 })
      .select("version")
      .lean();

    const engram = await models.engrams.create({
      workspaceId: new Types.ObjectId(workspaceId),
      version: (latest?.version ?? 0) + 1,
      status: "draft",
      winningPatterns: (parsed.winningPatterns ?? []).map((p: any) => ({
        patron: p.patron,
        dimension: p.dimension,
        evidencia: evidenceFor(winners),
      })),
      losingPatterns: (parsed.losingPatterns ?? []).map((p: any) => ({
        patron: p.patron,
        dimension: p.dimension,
        evidencia: evidenceFor(losers),
      })),
      toneRules: parsed.toneRules ?? [],
      vocabularioMarca: parsed.vocabularioMarca ?? [],
      vocabularioProhibido: parsed.vocabularioProhibido ?? [],
      basadoEn: {
        metric,
        month: options.month,
        videosAnalizados: performance.totalVideos,
        ganadores: performance.winnersCount,
      },
      generadoPor:
        options.userId && Types.ObjectId.isValid(options.userId)
          ? new Types.ObjectId(options.userId)
          : undefined,
    });

    return engram;
  }

  /** Promote a draft to active, archiving whatever was active before. */
  async activate(workspaceId: string, version: number, userId?: string): Promise<IEngram> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const target = await models.engrams.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      version,
    });
    if (!target) throw new Error("NOT_FOUND");

    await models.engrams.updateMany(
      { workspaceId: new Types.ObjectId(workspaceId), status: "active" },
      { $set: { status: "archived" } }
    );

    target.status = "active";
    target.approvedAt = new Date();
    if (userId && Types.ObjectId.isValid(userId)) {
      target.approvedBy = new Types.ObjectId(userId);
    }
    await target.save();

    return target;
  }

  /**
   * Render the active engram as a prompt block.
   *
   * Returns an empty string when there is nothing learned yet — the generator
   * must fall back cleanly rather than inject an empty section.
   */
  async getActivePromptBlock(workspaceId: string): Promise<string> {
    let engram: IEngram | null = null;
    try {
      engram = await this.getActive(workspaceId);
    } catch {
      return "";
    }
    if (!engram) return "";

    const lines: string[] = [
      "APRENDIZAJES DE ESTA MARCA (basados en métricas reales de sus propios videos):",
    ];

    if (engram.winningPatterns.length) {
      lines.push("\nLo que SÍ funciona — replícalo:");
      for (const p of engram.winningPatterns) lines.push(`- ${p.patron}`);
    }

    if (engram.losingPatterns.length) {
      lines.push("\nLo que NO funciona — evítalo:");
      for (const p of engram.losingPatterns) lines.push(`- ${p.patron}`);
    }

    if (engram.toneRules.length) {
      lines.push("\nTono de esta marca:");
      for (const r of engram.toneRules) {
        lines.push(`- ${r.regla}${r.ejemploBueno ? ` (así sí: "${r.ejemploBueno}")` : ""}`);
      }
    }

    if (engram.vocabularioMarca.length) {
      lines.push(`\nVocabulario propio de la marca: ${engram.vocabularioMarca.join(", ")}`);
    }

    if (engram.vocabularioProhibido.length) {
      lines.push(
        `\nPALABRAS PROHIBIDAS (se han vuelto genéricas o repetitivas, no las uses): ${engram.vocabularioProhibido.join(", ")}`
      );
    }

    return lines.join("\n");
  }
}

export const engramService = new EngramService();
