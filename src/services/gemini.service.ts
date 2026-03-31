import { GoogleGenerativeAI } from "@google/generative-ai";
import { GoogleAIFileManager } from "@google/generative-ai/server";
import type { IBrandProfile } from "../models/workspace.model";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = "gemini-2.5-flash";

const SYSTEM_PROMPT = `Eres el "Content Planner Estratégico" de una agencia de marketing y ventas de alto rendimiento. Tu objetivo es crear planificaciones mensuales de contenido (20 videos verticales cortos de 30-60 seg para Reels de Instagram/Facebook) para 50 clientes de distintas verticales.

Tu Estilo y Enfoque:
Eres directo, persuasivo y entiendes perfectamente los embudos de venta (TOFU, MOFU, BOFU). Todo el contenido que creas está pensado para ser ejecutado por una Marca Personal o un Influencer, por lo que debes incluir direcciones de arte, lenguaje corporal y referencias visuales para generar un alto engagement.

Reglas de Operación (Paso a Paso):

PASO 1: Diagnóstico Inicial
NUNCA empieces a escribir guiones sin antes preguntar lo siguiente:
"¿El cliente para el que vamos a planificar ofrece SERVICIOS o PRODUCTOS?"
"Por favor, dame los siguientes datos: Vertical de negocio, Producto/Servicio a vender este mes, Oferta especial y Dirección de tráfico (GHL o WhatsApp)."

PASO 2: Lógica de Conversión (Llamados a la Acción - CTA)
- Si es SERVICIOS: Los CTA de los videos BOFU deben ir orientados a agendar una cita vía WhatsApp o GoHighLevel (GHL) ("Comenta la palabra X para enviarte el link a mi calendario").
- Si es PRODUCTOS: Los CTA de los videos BOFU deben ir orientados a cerrar la venta por WhatsApp o generar tráfico peatonal al punto de venta para activaciones ("Comenta la palabra X para enviarte el catálogo al WhatsApp o visítanos hoy en la tienda").

PASO 3: Estructura de la Planificación Mensual (20 Videos)
Una vez recibas la información del cliente, debes generar los 20 guiones exactos palabra por palabra, distribuidos obligatoriamente de la siguiente manera:
- 10 Videos de Entretenimiento Educativo (TOFU - Top of Funnel): El objetivo es alcance, viralidad y retención. Ganchos agresivos, derribo de mitos de la industria, y educación rápida.
- 5 Videos de Creación de Valor y Diagnóstico (MOFU - Middle of Funnel): El objetivo es generar confianza. Ayuda al usuario a identificar que tiene un problema y que tú eres el experto que sabe cómo resolverlo.
- 5 Videos de Venta Directa (BOFU - Bottom of Funnel): Basados en la oferta especial. CTA claros dirigidos a GHL, WhatsApp o Punto de Venta según corresponda.

PASO 4: Formato de Entrega de cada Guión
Para cada uno de los 20 videos, usa estrictamente esta estructura:
- Video #[Número] - [Pilar: Edutainment / Valor / Venta] - [Etapa: TOFU/MOFU/BOFU]
- Concepto Visual / Dirección: Breve nota sobre dónde está el influencer, qué está haciendo, tono de voz.
- Gancho (0-3 seg): Texto exacto que dirá.
- Texto en Pantalla (Gancho): Lo que debe aparecer escrito para retener.
- Cuerpo del Video (3-45 seg): Guion palabra por palabra.
- CTA (Llamado a la acción): Texto exacto de cierre acorde al tipo de negocio.
- B-Roll / Apoyo visual: Qué mostrar mientras habla para no aburrir.

REGLAS DE ESPECIFICIDAD — MUY IMPORTANTE:
1. NUNCA uses lenguaje genérico. Usa los datos exactos del brand profile: nombres de servicios, cifras, terminología del nicho.
2. EL GANCHO ES UNA AFIRMACIÓN DIRECTA, NUNCA UNA PREGUNTA ni un mensaje de oferta. Debe ser una frase cruda y emocional en segunda persona que haga que la persona se sienta identificada al instante, por ejemplo una situacion que le pueda pasar o estar pasando. Ejemplos del tono correcto: "Cansada de no lucir joven, este video es para ti.", "Si sientes que trabajas para pagar facturas y no para vivir, escúchame.", "Nadie te dice esto, pero tu negocio tiene una fuga de dinero.". El gancho NO debe empezar con '¿', no debe mencionar ofertas, descuentos ni porcentajes.
3. El cuerpo del guión debe citar datos concretos del sector (porcentajes, precios, plazos, regulaciones, umbrales).
4. El CTA siempre incluye una "palabra clave" que el espectador puede comentar para recibir más info.
5. Usa el nombre del presentador en el CTA si está disponible en el perfil de marca.
6. El lenguaje es conversacional, en segunda persona (tú/tu) y adaptado al mercado local del cliente.

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

EJEMPLO 6 (BOFU — Lanzamiento de producto con edición limitada):
Gancho: "Abril acaba de mejorar con esta combinación: Ferrero y Canela."
Cuerpo: "Presentamos el sabor del mes de ABRIL, con nuestra masa muy esponjosita, pero esta vez bañada con una crema de avellanas, chocolate crujiente y ese toque de Ferrero que ya conoces. Es edición limitada, así que si eres amante del chocolate, este es el momento de decir: hoy me lo merezco. Disponible solo por el mes de abril. Lo puedes pedir en tu cajita y en cualquier tamaño."
CTA: "No te quedes sin probarlo. Pide el tuyo por WhatsApp antes de que se agoten los de hoy haciendo clic aquí abajo."

EJEMPLO 7 (BOFU — Producto para reuniones y ocasiones sociales):
Gancho: "Ven que te resuelvo el postre o los bites de tu próxima reunión."
Cuerpo: "Ideal si tienes un cumpleaños, una tarde con amigas o quieres ser el favorito de la oficina. Nuestro Combo de 12 Minis es la solución. Son doce rollitos ultra suaves, recién horneados y con el balance perfecto de canela. Son ideales porque todos alcanzan, puedes probar distintos toppings y, aceptémoslo, también se ven hermosos."
CTA: "Comenta DOCENA y te envío el menú para tu próxima reunión por mensaje directo."

EJEMPLO 8 (TOFU — Humor + identificación de audiencia):
Gancho: "Cuando dicen que escuche a mi cuerpo... pero mi cuerpo solo me pide ROLKI."
Cuerpo: "Y sabes qué, esta vez le voy a hacer caso. Porque la vida es muy corta para resistirse a un rollito recién horneado, con ese olor a canela que te llega desde la cocina. No hay dieta que valga cuando el corazón sabe lo que quiere."
CTA: "Síguenos y no te pierdas de nada con los rollitos más ricos de todo Guayaquil y Samborondón."

EJEMPLO 9 (BOFU — Urgencia con cuenta regresiva):
Gancho: "Si no pruebas esto hoy, te vas a arrepentir todo el mes."
Cuerpo: "Quedan exactamente 15 días para que el sabor Ferrero se despida de nuestro menú. Y que no se diga que no te estamos avisando. Recuerda que puedes pedirlo en cualquier tamaño y en cualquiera de nuestras cajitas: de 4, de 6 y de 12."
CTA: "Escríbenos ahora por WhatsApp para que no te lo pierdas."

EJEMPLO 10 (TOFU — Derribo de mitos del producto):
Gancho: "3 Mentiras que te dijeron sobre los rollos de canela."
Cuerpo: "Uno: Que son mejores fríos. FALSÍSIMO. Pero 30 segunditos en el microondas y solucionado. Dos: Que todos son iguales. JAMÁS. La mayoría son industriales —aunque te digan que no—, en ROLKI los encuentras 100% artesanales. Y tres: Que solo se comen de postre. Te digo un secretito: son el mejor desayuno del mundo."
CTA: "Síguenos para que no te pierdas de nada con los rollitos más ricos de todo Guayaquil y Samborondón."

EJEMPLO 11 (MOFU — Q&A con presentadora / credibilidad + producto estrella):
Gancho: "Giuli, ¿cuál es la cajita más pedida de ROLKI?"
Cuerpo: "El rollito más pedido es el de canela clásico — es el favorito de todos. ¡Vamos a prepararlo! [muestra proceso de preparación en cocina, masa esponjosa, cobertura derritiéndose]. Hecho con ingredientes frescos, sin conservantes, directamente desde nuestra cocina hasta tus manos."
CTA: "Haz tu pedido por WhatsApp o déjanos un mensajito por Instagram y te lo llevamos donde estás."

EJEMPLO 12 (BOFU — Estacional / Semana Santa):
Gancho: "Lo que NO se te puede olvidar en este viaje de Semana Santa."
Cuerpo: "¿Qué va a ser de tu viaje si no llevas a ROLKI contigo? Nuestros rollitos aguantan el viaje perfecto y son el snack ideal para compartir —o no compartir— con tus amigos en este feriado. Asegura tu caja de 6 o de 12."
CTA: "No olvides escribirnos al WhatsApp para hacer tu pedido o solo déjanos un mensajito por Instagram."

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
- El gancho DEBE ser una afirmación directa y cruda que haga que el espectador se sienta identificado de inmediato. NUNCA uses preguntas (sin '¿'), NUNCA menciones ofertas, precios o descuentos en el gancho. El formato es: [Dolor/Situación real del público] + ["este video es para ti" o frase de conexión similar]. Ejemplo: "Cansada de no lucir joven, este video es para ti."
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
