/**
 * The agency's script framework.
 *
 * Transcribed from "BASE DE ESTRUCTURA DE GUIÓN PARA LÍNEA COMERCIAL DEL
 * CLIENTE" (Drive) plus the vertical-specific rules from the strategy meeting.
 *
 * The schema in that document maps 1:1 onto `IBrandProfile`:
 *   Propuesta de valor      → propuestaValor
 *   Segmento de mercado (3) → segmentosMercado[]
 *   Canales                 → canalesDetail[]
 *   Actividades clave       → actividadesClave[]
 *   Customer Journey        → customerJourneyCases[] (quién es / cómo se
 *                             siente / qué obtiene)
 */

export type VerticalKind = "servicio" | "gastronomia" | "producto";

/**
 * Non-negotiable rules from the base document. These are what make a script
 * "de la agencia" instead of a generic AI output.
 */
const BASE_FRAMEWORK = `ESTRUCTURA OBLIGATORIA DEL GUIÓN (marco de la agencia):

1. DURACIÓN: máximo 45 segundos. Ni uno más. Si no cabe, corta contenido, no aceleres.

2. DOBLE HOOK — esta es la regla que define nuestros guiones:
   · HOOK 1 (0-3 seg): nace de la NECESIDAD o el PROBLEMA del caso del Customer Journey al que apunta este video. Es la frase que hace que la persona se reconozca. Sale del "cómo se siente al inicio" de ese caso, no de una idea general.
   · HOOK 2 (inmediatamente después): un segundo giro que reengancha justo cuando la persona iba a soltar el video. Puede ser un dato que contradice lo esperado, una consecuencia que no había considerado, o el costo real de seguir igual.
   Un guión con un solo hook está incompleto. Devuélvelo con los dos.

3. MAPEO AL CUSTOMER JOURNEY: cada guión apunta a UN caso específico (Caso 1, 2 o 3). El hook sale de su dolor, el cuerpo de lo que ese perfil necesita entender, y el cierre de "qué obtiene" según ese caso. No mezcles casos en un mismo guión.

4. CIERRE EN CALL TO ACTION: el guión termina en una acción concreta y única, coherente con el canal real del cliente.

5. LENGUAJE HUMANO. El guión no puede sonar a IA ni a robot:
   · Frases cortas, como habla una persona, no como escribe un copy.
   · Sin estructuras simétricas ni paralelismos perfectos.
   · Sin adjetivos apilados.
   · Permite una idea imperfecta o coloquial si así hablaría el cliente.
   · Si al leerlo en voz alta suena a anuncio institucional, está mal.

6. USA EL MATERIAL REAL DE LA MARCA: los segmentos, canales y actividades clave del esquema son datos concretos, no decorado. Nombra sus servicios, sus cifras, sus años, sus clientes. Un guión que podría servirle a cualquier otra empresa del rubro está mal escrito.`;

const VERTICAL_RULES: Record<VerticalKind, string> = {
  servicio: `REGLAS ADICIONALES — SERVICIOS DE ALTO TICKET:
- El servicio se vende por el COSTO DE NO RESOLVERLO. Cuantifica lo que la persona pierde hoy antes de mencionar la solución.
- La autoridad va nombrada: metodología, proceso, años, planta propia, credencial. "Te ayudamos" no es autoridad.
- Anticipa la objeción principal (precio, tiempo, desconfianza) y resuélvela dentro de los 45 segundos.
- El HOOK 2 suele ser el mejor lugar para el dato de autoridad o la consecuencia económica.
- El cierre lleva a una conversación (diagnóstico, cotización, llamada), no a una compra impulsiva.`,

  gastronomia: `REGLAS ADICIONALES — GASTRONOMÍA:
- Se vende por ANTOJO Y OCASIÓN, no por argumentos racionales. Textura, temperatura, sonido, momento.
- Ancla a una ocasión concreta: el almuerzo del viernes, el after-office, el domingo en familia.
- Nadie califica un plato de 15 dólares. NO construyas filtros ni argumentos de "cliente ideal": el objetivo es volumen de pedidos, no leads calificados.
- El HOOK 2 suele ser la ocasión o el detalle sensorial que no se ve en la foto.
- CTA inmediato y de baja fricción: pedir ahora, reservar hoy, llegar antes de que se acabe.`,

  producto: `REGLAS ADICIONALES — PRODUCTO FÍSICO:
- Es el vertical más difícil de mover: el guión carga con TODA la demostración. Muestra el producto en uso, no en pedestal.
- Contrasta contra la alternativa que la persona usa hoy, con un atributo medible (duración, rendimiento, precio por uso).
- La objeción es "¿me va a servir a mí?". Resuélvela con un caso de uso específico, no con adjetivos.
- El HOOK 2 suele ser la comparación o el resultado medible.
- Escasez solo si es real. No la inventes.`,
};

/**
 * Infer the vertical from the brand profile.
 *
 * `vertical` is free text, so food keywords are matched first; `tipoNegocio`
 * is the reliable fallback.
 */
export function inferVertical(brandProfile: {
  tipoNegocio?: string;
  vertical?: string;
}): VerticalKind {
  const vertical = (brandProfile.vertical || "").toLowerCase();

  const FOOD_KEYWORDS = [
    "gastronom",
    "restaurant",
    "comida",
    "food",
    "cafeter",
    "cafe",
    "bar",
    "panader",
    "paster",
    "helader",
    "pizzer",
    "cocina",
    "catering",
    "parrilla",
  ];
  if (FOOD_KEYWORDS.some((k) => vertical.includes(k))) return "gastronomia";

  if (brandProfile.tipoNegocio === "PRODUCTOS") return "producto";
  return "servicio";
}

export function getFrameworkBlock(vertical: VerticalKind): string {
  return `${BASE_FRAMEWORK}\n\n${VERTICAL_RULES[vertical]}`;
}
