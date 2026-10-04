/**
 * Reglas de las correcciones que el cliente pide sobre un VIDEO terminado.
 *
 * - Dos rondas por video. En la tercera solo se puede aprobar: si no, la
 *   edicion se vuelve una conversacion sin fin sobre gustos.
 * - Cada cambio dice el segundo exacto y que cambiar: el editor no adivina.
 * - No hacemos cambios de vanidad. No somos una productora audiovisual: cada
 *   cambio tiene que ayudar a vender (mensaje, oferta, dato, CTA, claridad).
 *   Colores, letras, musica por gusto o "como me veo" no entran.
 *
 * Lo que decide si un cambio es de vanidad es primero una lista de palabras
 * de negocio (pasa directo) y despues la IA. Si la IA no responde, se usa la
 * lista de palabras de vanidad: mejor dejar pasar un cambio dudoso que
 * bloquear al cliente porque el modelo se cayo.
 */

export const MAX_RONDAS_VIDEO = 2;
const MIN_CARACTERES = 12;
export const MAX_TEXTO_CORRECCION = 1500;
const LIMITE_IA_MS = 20_000;

export const MENSAJE_SIN_VANIDAD =
  "No hacemos cambios de vanidad: no somos una productora audiovisual, somos tu equipo de crecimiento. " +
  "Cada cambio tiene que tener sentido para vender más: el mensaje, la oferta, un precio o dato incorrecto, el llamado a la acción o algo que no se entiende.";

// ── Segundo del video ─────────────────────────────────────────────────────
/**
 * "1:23", "01:23", "83", "83s", "1m23s", "1 min 23", "0:05" → segundos.
 * null si no se entiende o es negativo/absurdo (mas de 2 horas).
 */
export function parseSegundo(valor: unknown): number | null {
  if (typeof valor === "number") return Number.isFinite(valor) && valor >= 0 && valor <= 7200 ? Math.round(valor) : null;
  const t = String(valor ?? "").trim().toLowerCase().replace(/^(en el |seg(undo)?\.? ?|min(uto)? ?)/, "");
  if (!t) return null;
  let total: number | null = null;
  const reloj = t.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (reloj) {
    const [a, b, c] = [Number(reloj[1]), Number(reloj[2]), reloj[3] !== undefined ? Number(reloj[3]) : null];
    if (b > 59 || (c !== null && c > 59)) return null;
    total = c === null ? a * 60 + b : a * 3600 + b * 60 + c;
  } else {
    const partes = t.match(/^(?:(\d+)\s*(?:m|min|minutos?)\s*)?(?:(\d+)\s*(?:s|seg|segundos?)?)?$/);
    if (partes && (partes[1] || partes[2])) total = Number(partes[1] || 0) * 60 + Number(partes[2] || 0);
  }
  return total !== null && total >= 0 && total <= 7200 ? total : null;
}

/** 83 → "1:23" */
export function formatoSegundo(segundo: number): string {
  const s = Math.max(0, Math.round(segundo));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

// ── Rondas ────────────────────────────────────────────────────────────────
export function rondasRestantes(item: { rondasUsadas?: number | null }): number {
  return Math.max(0, MAX_RONDAS_VIDEO - (item.rondasUsadas ?? 0));
}

// ── Vanidad ───────────────────────────────────────────────────────────────
export type TipoCorreccion = "negocio" | "vanidad" | "poco_clara";
export interface EvaluacionCorreccion {
  tipo: TipoCorreccion;
  motivo?: string;
  /** "palabras" o "ia": de donde salio la decision (para auditar). */
  fuente: "palabras" | "ia";
}

function sinAcentos(texto: string): string {
  return (texto || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Cambios que tocan la venta: pasan sin preguntarle a la IA.
const NEGOCIO = [
  /precio|\$\s?\d|\d+\s?(usd|dolares)|descuento|promo(cion)?|oferta|cupon|envio gratis/,
  /dato (mal|incorrect|equivocad|errone)|esta mal (escrit|el dato|el precio|el numero|el nombre)|no es (asi|cierto|correcto)|equivocad|incorrect|errone/,
  /telefono|whatsapp|direccion|horario|link|enlace|pagina web|sitio web|@\w+/,
  /\bcta\b|llamado a la accion|escribenos|agenda|reserva|compra|cotiza/,
  /no se entiende|no se escucha|se corta (la voz|el audio|la frase)|no se lee|tapa (el|la) (texto|producto|precio)|ortografia|falta (una )?tilde|mal escrito/,
  /nombre (del producto|de la marca|del negocio|del plato|del servicio)|producto equivocado|no es nuestro producto|competencia|marca de otro/,
  /legal|no podemos decir|no se puede prometer|garantia/,
];

// Gustos: si la IA no esta, estos se frenan.
const VANIDAD = [
  /\bcolor(es)?\b|tono de color|colorimetria|mas (calido|frio|saturado|brillante)|filtro/,
  /tipografia|tipo de letra|\bfuente\b|letra mas (bonita|grande|chica)|otra letra/,
  /(no me gusta|cambia(r)?|otra) (la )?(musica|cancion)|musica (mas|menos)|otra cancion/,
  /me veo|salgo (mal|feo|gordo|gorda)|mi cara|mi pelo|mi peinado|se me ve|mas delgad|papada|arrugas/,
  /transicion(es)?|efecto(s)? (mas|de)|mas dinamico|mas moderno|mas elegante|mas bonito|mas lindo|mas pro\b|estetic|que se vea mejor/,
  /no me gusta (como|el estilo|la vibra)|no me convence (el estilo|como se ve)/,
];

/** Lo que se decide sin IA. null = hay que preguntarle a la IA. */
export function evaluarPorPalabras(texto: string): EvaluacionCorreccion | null {
  const t = sinAcentos(texto);
  if (t.length < MIN_CARACTERES || t.split(" ").length < 3) {
    return { tipo: "poco_clara", motivo: "falta qué cambiar exactamente y cómo lo quiere", fuente: "palabras" };
  }
  if (NEGOCIO.some((re) => re.test(t))) return { tipo: "negocio", fuente: "palabras" };
  return null;
}

export function pareceVanidad(texto: string): boolean {
  const t = sinAcentos(texto);
  return VANIDAD.some((re) => re.test(t));
}

// ── IA (mismo cargador perezoso que telegramAgent; ver alli el porque) ────
type AiSdk = typeof import("ai");
let aiSdk: Promise<AiSdk> | null = null;
const importarEsm = new Function("modulo", "return import(modulo)") as (modulo: string) => Promise<any>;
async function traerAi(): Promise<AiSdk> {
  try {
    return require("ai") as AiSdk;
  } catch (error: any) {
    if (error?.code !== "ERR_REQUIRE_ESM" && !/ES Module/i.test(String(error?.message))) throw error;
    return (await importarEsm("ai")) as AiSdk;
  }
}
function cargarAi(): Promise<AiSdk> {
  aiSdk ??= traerAi().catch((error) => {
    aiSdk = null;
    throw error;
  });
  return aiSdk;
}

const PROMPT_IA = `Eres el filtro de correcciones de video de Bakano, una agencia de crecimiento (no una productora audiovisual).
El cliente pide un cambio sobre un video de redes sociales ya editado. Decide si el cambio es de NEGOCIO o de VANIDAD.
- negocio: mejora la venta o corrige un error: mensaje, oferta, precio o dato incorrecto, producto equivocado, CTA, contacto, algo que no se entiende o no se escucha, texto mal escrito, información legal, quitar algo que daña la marca o confunde al cliente final.
- vanidad: gusto personal sin efecto en ventas: colores, filtros, tipografía, música por gusto, transiciones, efectos, "que se vea más bonito/moderno/elegante", cómo se ve la persona (cara, cuerpo, pelo), cambiar una toma solo porque no le gusta cómo sale.
- poco_clara: no dice qué cambiar ni cómo (ej. "no me gusta", "mejóralo").
Si un cambio estético tiene una razón de venta concreta (ej. "la música tapa la voz y no se entiende el precio", "el texto blanco no se lee sobre el fondo"), es negocio.
Responde SOLO un JSON: {"tipo":"negocio|vanidad|poco_clara","motivo":"una línea, en español, dirigida al cliente"}`;

async function evaluarConIa(texto: string): Promise<EvaluacionCorreccion | null> {
  try {
    const { generateText } = await cargarAi();
    const { text } = await generateText({
      model: process.env.AI_MODEL || "google/gemini-3.8-flash",
      system: PROMPT_IA,
      prompt: `Cambio pedido: ${texto.slice(0, MAX_TEXTO_CORRECCION)}`,
      abortSignal: AbortSignal.timeout(LIMITE_IA_MS),
    });
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const r = JSON.parse(json);
    if (!["negocio", "vanidad", "poco_clara"].includes(r?.tipo)) return null;
    return { tipo: r.tipo, motivo: typeof r.motivo === "string" ? r.motivo.slice(0, 300) : undefined, fuente: "ia" };
  } catch (error: any) {
    console.warn("[Correcciones video] IA no disponible:", error?.message || error);
    return null;
  }
}

/**
 * Decide si un cambio entra. `ia` se puede reemplazar en pruebas.
 */
export async function evaluarCorreccionVideo(
  texto: string,
  ia: (texto: string) => Promise<EvaluacionCorreccion | null> = evaluarConIa
): Promise<EvaluacionCorreccion> {
  const directo = evaluarPorPalabras(texto);
  if (directo) return directo;
  const porIa = await ia(texto);
  if (porIa) return porIa;
  return pareceVanidad(texto)
    ? { tipo: "vanidad", motivo: "es un cambio de estilo o de gusto, no de venta", fuente: "palabras" }
    : { tipo: "negocio", fuente: "palabras" };
}

export interface CambioVideo {
  segundo: unknown;
  texto: string;
}

export interface CambioValidado {
  segundo: number;
  texto: string;
}

export type ResultadoValidacion =
  | { ok: true; cambios: CambioValidado[] }
  | { ok: false; motivo: "sin_cambios" | "segundo_invalido" | "poco_clara" | "vanidad"; detalle: string; indice?: number };

/** Valida una ronda completa: segundo + texto + regla anti-vanidad. */
export async function validarCambios(
  cambios: CambioVideo[],
  ia?: (texto: string) => Promise<EvaluacionCorreccion | null>
): Promise<ResultadoValidacion> {
  if (!Array.isArray(cambios) || !cambios.length) {
    return { ok: false, motivo: "sin_cambios", detalle: "Indica al menos un cambio con su segundo." };
  }
  const limpios: CambioValidado[] = [];
  for (const [i, c] of cambios.entries()) {
    const segundo = parseSegundo(c?.segundo);
    if (segundo === null) {
      return { ok: false, motivo: "segundo_invalido", detalle: `El cambio ${i + 1} no tiene un segundo válido (ej. 0:15).`, indice: i };
    }
    const texto = String(c?.texto || "").trim().slice(0, MAX_TEXTO_CORRECCION);
    const ev = await evaluarCorreccionVideo(texto, ia);
    if (ev.tipo === "poco_clara") {
      return { ok: false, motivo: "poco_clara", detalle: `El cambio en ${formatoSegundo(segundo)} no es claro: ${ev.motivo || "di qué cambiar y cómo lo quieres"}.`, indice: i };
    }
    if (ev.tipo === "vanidad") {
      return {
        ok: false,
        motivo: "vanidad",
        detalle: `El cambio en ${formatoSegundo(segundo)} es de vanidad${ev.motivo ? ` (${ev.motivo})` : ""}. ${MENSAJE_SIN_VANIDAD}`,
        indice: i,
      };
    }
    limpios.push({ segundo, texto });
  }
  limpios.sort((a, b) => a.segundo - b.segundo);
  return { ok: true, cambios: limpios };
}
