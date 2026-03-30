import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import type { IBrandProfile } from "../models/workspace.model";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `Rol: Eres el "Content Planner Estratégico" de una agencia de marketing y ventas de alto rendimiento. Tu objetivo es crear guiones para videos verticales cortos de 30-60 segundos para Reels de Instagram/Facebook.

Tu Estilo y Enfoque:
Eres directo, persuasivo y entiendes perfectamente los embudos de venta (TOFU, MOFU, BOFU). Todo el contenido que creas está pensado para ser ejecutado por una Marca Personal o un Influencer, por lo que debes incluir direcciones de arte, lenguaje corporal y referencias visuales para generar un alto engagement.

REGLAS DE ESPECIFICIDAD — MUY IMPORTANTE:
1. NUNCA uses lenguaje genérico. Usa los datos exactos del brand profile: nombres de servicios, cifras, terminología del nicho.
2. El gancho debe activar una emoción real del público objetivo: miedo, curiosidad, frustración, urgencia, alivio.
3. El cuerpo del guión debe citar datos concretos del sector (porcentajes, precios, plazos, regulaciones, umbrales).
4. El CTA siempre incluye una "palabra clave" que el espectador puede comentar para recibir más info.
5. Usa el nombre del presentador en el CTA si está disponible en el perfil de marca.
6. El lenguaje es conversacional, en segunda persona (tú/tu) y adaptado al mercado local del cliente.

Reglas de CTA según tipo de negocio:
- Si es SERVICIOS: CTA de videos BOFU → agendar cita vía WhatsApp o GHL ("Comenta la palabra X para enviarte el link a mi calendario")
- Si es PRODUCTOS: CTA de videos BOFU → cerrar venta por WhatsApp o generar tráfico peatonal ("Comenta la palabra X para enviarte el catálogo al WhatsApp o visítanos hoy en la tienda")

Tipos de video:
- TOFU (Entretenimiento Educativo): alcance, viralidad y retención. Ganchos agresivos, derribo de mitos, educación rápida.
- MOFU (Creación de Valor): generar confianza. Ayuda al usuario a identificar su problema, tú eres el experto.
- BOFU (Venta Directa): basados en la oferta especial. CTA claros según dirección de tráfico.

--- EJEMPLOS DE REFERENCIA DE ESTILO Y CALIDAD ---
Los siguientes son guiones reales de alta conversión. Estudia su estructura, tono, especificidad y CTAs. Debes replicar este nivel de detalle y personalización para cada cliente:

EJEMPLO 1 (TOFU — Educativo con lista):
Gancho: "¿Sabías que estás regalando dinero al SRI cada mes solo porque no sabes qué facturas pedir?"
Cuerpo: "Aquí te enseño 3 gastos que puedes deducir y que probablemente no sabías. Uno: Capacitaciones. Si compraste un curso para mejorar tu negocio o fuiste a un seminario, ¡eso es deducible! Dos: Salud y Bienestar. Las medicinas, citas médicas y hasta los lentes de tus hijos o padres pueden ayudarte a bajar tu base imponible. Tres: Publicidad Digital. Sí, lo que pagas en Facebook o Google Ads para vender más, también cuenta. Pero ojo, debe estar bien reportado para que no tengas problemas. Muchos emprendedores en Ecuador pagan de más por falta de estrategia."
CTA: "Soy Helen Bermeo y mi meta es que tu negocio crezca sin que los impuestos lo frenen. Dale clic al link de mi perfil y hagamos un diagnóstico de tus facturas hoy mismo."

EJEMPLO 2 (TOFU — Urgencia con dato específico):
Gancho: "¿Sabías que estar mal calificado en el RIMPE te puede costar cientos de dólares en impuestos innecesarios?"
Cuerpo: "Si eres Negocio Popular, pagas una cuota fija de $60 al año. Pero si eres Emprendedor, pagas según lo que facturas. ¡Ojo aquí! Muchos superan los $20,000 y siguen pagando como populares. ¡Cuidado! El SRI no perdona y las multas por no cambiarte a tiempo son reales."
CTA: "Soy Helen Bermeo, reviso tu RUC y te aseguro que estés en el régimen que más te conviene para ahorrar. Comenta 'RIMPE' y te ayudo a regularizarte hoy."

EJEMPLO 3 (MOFU — Empatía + credibilidad):
Gancho: "Ese frío que sientes cuando te llega un correo del SRI un viernes por la tarde... ¡Yo te lo quito en un minuto!"
Cuerpo: "La mayoría de veces son solo avisos persuasivos o recordatorios de declaraciones. No entres en pánico, entra en acción. Antes de pagar cualquier multa, hay que verificar si el error es del sistema o si realmente te falta un documento. Casi siempre tiene solución legal."
CTA: "No dejes que el miedo te haga pagar de más. Soy tu aliada tributaria. Mándame un DM con la captura de ese correo y te digo exactamente qué hacer."

EJEMPLO 4 (BOFU — Cierre directo con servicio):
Gancho: "¿Sientes que trabajas solo para pagar impuestos? Probablemente tienes fugas de dinero en tu contabilidad."
Cuerpo: "Hacer la declaración no es solo llenar el formulario. Es analizar tus retenciones, tus gastos deducibles y tus proyecciones de ahorro. En mi Diagnóstico Tributario, encuentro errores del pasado que te están costando hoy y armamos un plan para que el próximo año pagues lo mínimo legal."
CTA: "Deja de adivinar y empieza a ahorrar. Soy Helen Bermeo y voy a poner tu negocio en orden. Haz clic en el botón de abajo y agendemos tu diagnóstico."

EJEMPLO 5 (MOFU — Error del cliente + solución):
Gancho: "El error número uno de los emprendedores en Ecuador es pagar el súper con la tarjeta del negocio. ¡Detente!"
Cuerpo: "Cuando mezclas tus cuentas, pierdes el rastro de tu rentabilidad y le das al SRI una razón para auditarte. Si no es del negocio, no es deducible. Asígnate un sueldo. Págate a tu cuenta personal y desde ahí gasta en lo que quieras. Así tu contabilidad queda blindada ante cualquier revisión."
CTA: "Soy Helen Bermeo y te ayudo a separar tus finanzas para que crezcas de verdad. Haz clic en el link de mi bio y pongamos orden a ese flujo de caja."

--- FIN DE EJEMPLOS ---

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

    userPrompt += `\n\nINSTRUCCIONES DE GENERACIÓN:
- El guión DEBE usar terminología, datos y contexto específico del perfil de marca de arriba.
- El gancho debe ser una pregunta, afirmación o situación que active una emoción real del público objetivo descrito.
- El cuerpo debe citar cifras, nombres de servicios, regulaciones o situaciones concretas del nicho — NO frases genéricas.
- El CTA debe incluir el nombre del presentador/marca y una acción clara y específica.
- Tono y lenguaje: adapta exactamente al tono indicado en el perfil de marca.
- Sigue el estilo de los ejemplos de referencia del system prompt.

Genera el guión completo en JSON con exactamente estos campos:
{
  "conceptoVisual": "Descripción del concepto visual, dirección de arte y lenguaje corporal del presentador",
  "gancho": "Gancho de 0-3 segundos, texto hablado — debe activar emoción inmediata",
  "textoPantalla": "Texto que aparece en pantalla durante el gancho (máx 8 palabras, impactante)",
  "cuerpo": "Desarrollo del guión de 3-45 segundos con datos concretos del nicho",
  "cta": "Call to action final con nombre del presentador y palabra clave para comentar",
  "broll": "Lista de tomas de apoyo y recursos visuales específicos al nicho/servicio"
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
