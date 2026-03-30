import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import type { IBrandProfile } from "../models/workspace.model";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `Rol: Eres el "Content Planner Estratégico" de una agencia de marketing y ventas de alto rendimiento. Tu objetivo es crear guiones para videos verticales cortos de 30-60 segundos para Reels de Instagram/Facebook.

Tu Estilo y Enfoque:
Eres directo, persuasivo y entiendes perfectamente los embudos de venta (TOFU, MOFU, BOFU). Todo el contenido que creas está pensado para ser ejecutado por una Marca Personal o un Influencer, por lo que debes incluir direcciones de arte, lenguaje corporal y referencias visuales para generar un alto engagement.

Reglas de CTA según tipo de negocio:
- Si es SERVICIOS: CTA de videos BOFU → agendar cita vía WhatsApp o GHL ("Comenta la palabra X para enviarte el link a mi calendario")
- Si es PRODUCTOS: CTA de videos BOFU → cerrar venta por WhatsApp o generar tráfico peatonal ("Comenta la palabra X para enviarte el catálogo al WhatsApp o visítanos hoy en la tienda")

Tipos de video:
- TOFU (Entretenimiento Educativo): alcance, viralidad y retención. Ganchos agresivos, derribo de mitos, educación rápida.
- MOFU (Creación de Valor): generar confianza. Ayuda al usuario a identificar su problema, tú eres el experto.
- BOFU (Venta Directa): basados en la oferta especial. CTA claros según dirección de tráfico.

IMPORTANTE: Responde ÚNICAMENTE con un JSON válido, sin markdown, sin explicaciones extra.`;

export interface GeminiFileResult {
  uri: string;
  mimeType: string;
}

export interface ScriptContext {
  productoMes?: string;
  ofertaEspecial?: string;
  referenciasAdicionales?: string;
}

export interface GenerateScriptParams {
  brandProfile: IBrandProfile;
  videoItem: {
    tema: string;
    tipo?: string;
    numero: number;
    tipoGuion?: "TOFU" | "MOFU" | "BOFU";
  };
  contextoMes?: ScriptContext;
  fileUris?: GeminiFileResult[];
}

export interface GuionIAResult {
  conceptoVisual: string;
  gancho: string;
  textoPantalla: string;
  cuerpo: string;
  cta: string;
  broll: string;
}

export class GeminiService {
  private fileManager: GoogleAIFileManager;
  private genAI: GoogleGenerativeAI;

  constructor() {
    this.fileManager = new GoogleAIFileManager(GEMINI_API_KEY);
    this.genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  }

  async uploadFileBuffer(
    buffer: Buffer,
    mimeType: string,
    displayName: string
  ): Promise<GeminiFileResult> {
    // Convert Buffer to ArrayBuffer for Blob compatibility
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    ) as ArrayBuffer;
    const blob = new Blob([arrayBuffer], { type: mimeType });

    const uploadResponse = await this.fileManager.uploadFile(blob as any, {
      mimeType,
      displayName,
    });
    return {
      uri: uploadResponse.file.uri,
      mimeType: uploadResponse.file.mimeType,
    };
  }

  async generateScript(params: GenerateScriptParams): Promise<GuionIAResult> {
    const { brandProfile, videoItem, contextoMes, fileUris } = params;

    const tipoGuionLabel =
      videoItem.tipoGuion || this.inferTipoGuion(videoItem.numero);

    let userPrompt = `PERFIL DE MARCA:
- Descripción: ${brandProfile.descripcion}
- Tipo de negocio: ${brandProfile.tipoNegocio || "No especificado"}
- Vertical/Industria: ${brandProfile.vertical || "No especificado"}
- Público objetivo: ${brandProfile.publicoObjetivo || "No especificado"}
- Propuesta de valor única: ${brandProfile.propuestaValor || "No especificado"}
- Tono de comunicación: ${brandProfile.tono || "No especificado"}
- Productos/Servicios principales: ${brandProfile.productosServicios || "No especificado"}
- Problema que resuelven: ${brandProfile.problemaResuelto || "No especificado"}
- Dirección de tráfico: ${brandProfile.trafficDirection || "No especificado"}
- Link de tráfico: ${brandProfile.trafficLink || "No especificado"}

VIDEO A GENERAR:
- Número de video: ${videoItem.numero}
- Tema: ${videoItem.tema}
- Tipo de contenido: ${videoItem.tipo || "No especificado"}
- Tipo de guión (embudo): ${tipoGuionLabel}`;

    if (contextoMes) {
      userPrompt += `\n\nCONTEXTO DEL MES:`;
      if (contextoMes.productoMes) {
        userPrompt += `\n- Producto/servicio destacado del mes: ${contextoMes.productoMes}`;
      }
      if (contextoMes.ofertaEspecial) {
        userPrompt += `\n- Oferta especial: ${contextoMes.ofertaEspecial}`;
      }
      if (contextoMes.referenciasAdicionales) {
        userPrompt += `\n- Referencias adicionales: ${contextoMes.referenciasAdicionales}`;
      }
    }

    userPrompt += `\n\nGenera el guión completo en JSON con exactamente estos campos:
{
  "conceptoVisual": "Descripción del concepto visual y dirección de arte",
  "gancho": "Gancho de 0-3 segundos, texto hablado",
  "textoPantalla": "Texto que aparece en pantalla durante el gancho",
  "cuerpo": "Desarrollo del guión de 3-45 segundos",
  "cta": "Call to action final",
  "broll": "Lista de tomas de apoyo y recursos visuales"
}`;

    const model = this.genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      systemInstruction: SYSTEM_PROMPT,
    });

    const contentParts: any[] = [];

    // Add file parts if available
    if (fileUris && fileUris.length > 0) {
      for (const f of fileUris) {
        contentParts.push({
          fileData: {
            mimeType: f.mimeType,
            fileUri: f.uri,
          },
        });
      }
    }

    contentParts.push({ text: userPrompt });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: contentParts }],
    });

    const responseText = result.response.text().trim();

    // Strip markdown code block if present
    const jsonText = responseText
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```\s*$/i, "")
      .trim();

    const parsed: GuionIAResult = JSON.parse(jsonText);
    return parsed;
  }

  async checkHealth(): Promise<{ available: boolean; model: string; error?: string }> {
    try {
      if (!GEMINI_API_KEY) {
        return { available: false, model: GEMINI_MODEL, error: "GEMINI_API_KEY not configured" };
      }
      const model = this.genAI.getGenerativeModel({ model: GEMINI_MODEL });
      await model.countTokens("health check");
      return { available: true, model: GEMINI_MODEL };
    } catch (err: any) {
      return { available: false, model: GEMINI_MODEL, error: err.message };
    }
  }

  inferTipoGuion(numero: number): "TOFU" | "MOFU" | "BOFU" {
    // Pattern: 1=TOFU, 2=MOFU, 3=BOFU, 4=TOFU, ...
    const mod = ((numero - 1) % 3) + 1;
    if (mod === 1) return "TOFU";
    if (mod === 2) return "MOFU";
    return "BOFU";
  }
}

export const geminiService = new GeminiService();
