import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import type { IScriptMeta, IVideoItem } from "../models/videoPlanning.model";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

const HOOK_TYPES = [
  "pregunta",
  "dato",
  "testimonio",
  "polemica",
  "pov",
  "problema",
  "oferta",
] as const;

const CLASSIFIER_PROMPT = `Eres un analista de contenido publicitario. Clasificas guiones de video corto (Reels/TikTok) según su ESTRUCTURA, no según su tema.

Reglas:
- "hookType" describe SOLO la primera frase del guión (el gancho), no el resto.
  · pregunta → abre interrogando al espectador
  · dato → abre con una cifra o hecho verificable
  · testimonio → abre con la voz de un cliente o un caso real
  · polemica → abre contradiciendo una creencia común
  · pov → abre poniendo al espectador dentro de una escena
  · problema → abre nombrando un dolor o frustración
  · oferta → abre con el precio, la promoción o el producto
- "objetivo": "anuncio" si el guión asume que el espectador NO conoce la marca y empuja a una acción comercial directa; "feed" si construye relación, educa o entretiene sin venta dura.
- Los "elementos" son booleanos estrictos: marca true SOLO si el elemento está explícitamente presente en el texto. No infieras ni des el beneficio de la duda.
  · testimonio → cita, caso o resultado de un cliente real
  · autoridad → metodología propia, credencial, años de experiencia o proceso nombrado
  · oferta → precio, promoción, descuento o paquete concreto
  · ctaExplicito → una instrucción clara de qué hacer ahora
  · problemaNecesidad → nombra el dolor o la necesidad del segmento
- "duracionSeg": estima la duración leyendo el guión en voz alta a ritmo natural (~2.8 palabras/segundo). Si el guión está vacío o es demasiado corto para estimar, omite el campo.

Responde únicamente con el JSON del esquema.`;

const RESPONSE_SCHEMA = {
  type: SchemaType.OBJECT,
  properties: {
    objetivo: { type: SchemaType.STRING, enum: ["feed", "anuncio"], format: "enum" },
    hookType: { type: SchemaType.STRING, enum: [...HOOK_TYPES], format: "enum" },
    formato: {
      type: SchemaType.STRING,
      enum: ["reel", "carrusel", "estatico", "historia"],
      format: "enum",
    },
    duracionSeg: { type: SchemaType.NUMBER },
    elementos: {
      type: SchemaType.OBJECT,
      properties: {
        testimonio: { type: SchemaType.BOOLEAN },
        autoridad: { type: SchemaType.BOOLEAN },
        oferta: { type: SchemaType.BOOLEAN },
        ctaExplicito: { type: SchemaType.BOOLEAN },
        problemaNecesidad: { type: SchemaType.BOOLEAN },
      },
      required: [
        "testimonio",
        "autoridad",
        "oferta",
        "ctaExplicito",
        "problemaNecesidad",
      ],
    },
  },
  required: ["objetivo", "hookType", "formato", "elementos"],
} as const;

/** Flatten a video item into the plain text the classifier reads. */
export function buildScriptText(item: Pick<IVideoItem, "tema" | "descripcion" | "guion" | "guionIA" | "tipo">): string {
  const parts: string[] = [];
  if (item.tema) parts.push(`TEMA: ${item.tema}`);
  if (item.tipo) parts.push(`TIPO DE PIEZA: ${item.tipo}`);
  if (item.descripcion) parts.push(`DESCRIPCIÓN: ${item.descripcion}`);

  const ia = item.guionIA;
  if (ia && (ia.gancho || ia.cuerpo || ia.cta)) {
    if (ia.gancho) parts.push(`GANCHO: ${ia.gancho}`);
    if (ia.textoPantalla) parts.push(`TEXTO EN PANTALLA: ${ia.textoPantalla}`);
    if (ia.cuerpo) parts.push(`CUERPO: ${ia.cuerpo}`);
    if (ia.cta) parts.push(`CTA: ${ia.cta}`);
    if (ia.conceptoVisual) parts.push(`CONCEPTO VISUAL: ${ia.conceptoVisual}`);
  } else if (item.guion) {
    parts.push(`GUIÓN: ${item.guion}`);
  }

  return parts.join("\n");
}

export class ScriptClassifierService {
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  /**
   * Classify one script into structural attributes.
   *
   * Returns `null` when there is not enough text to classify — an empty item
   * must not get invented attributes, or the whole analysis inherits noise.
   */
  async classify(
    item: Pick<IVideoItem, "tema" | "descripcion" | "guion" | "guionIA" | "tipo">
  ): Promise<IScriptMeta | null> {
    if (!GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not configured");

    const scriptText = buildScriptText(item);
    // Below this there is no script, just a title — classifying it would be
    // fabrication dressed as data.
    if (scriptText.trim().length < 40) return null;

    const model = this.genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: CLASSIFIER_PROMPT,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: RESPONSE_SCHEMA as any,
        temperature: 0,
      },
    });

    const result = await model.generateContent(scriptText);
    const raw = result.response.text();

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Gemini devolvió una clasificación no parseable.");
    }

    return {
      objetivo: parsed.objetivo,
      hookType: parsed.hookType,
      formato: parsed.formato,
      duracionSeg:
        typeof parsed.duracionSeg === "number" && parsed.duracionSeg > 0
          ? Math.round(parsed.duracionSeg)
          : undefined,
      elementos: {
        testimonio: !!parsed.elementos?.testimonio,
        autoridad: !!parsed.elementos?.autoridad,
        oferta: !!parsed.elementos?.oferta,
        ctaExplicito: !!parsed.elementos?.ctaExplicito,
        problemaNecesidad: !!parsed.elementos?.problemaNecesidad,
      },
      clasificadoPor: "ia",
      clasificadoEn: new Date(),
    };
  }
}

export const scriptClassifierService = new ScriptClassifierService();
