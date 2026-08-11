/**
 * Feed and ad scripts are not the same piece with a different budget.
 *
 * A feed script talks to people who already follow the brand and can afford
 * context. An ad script interrupts a stranger who owes it nothing. Generating
 * both from one prompt is why ads read like posts and underperform.
 */
import type { ObjetivoGuion } from "../models/videoPlanning.model";

const PROFILES: Record<ObjetivoGuion, string> = {
  feed: `OBJETIVO DE ESTE GUIÓN: FEED (orgánico)

Quien lo ve YA conoce la marca o llegó por afinidad. Escribe en consecuencia:
- Puedes tomarte los primeros 3 segundos para construir contexto o escena. No necesitas gritar.
- Prioriza que la persona termine el video sobre que haga clic. La retención es el resultado.
- Storytelling permitido: una situación, un antes y después, una escena cotidiana reconocible.
- El CTA es suave y de bajo compromiso: comentar una palabra clave, guardar el video, seguir la cuenta.
- Puedes asumir vocabulario y referencias propias de la marca sin explicarlas.
- NO repitas la oferta comercial en cada video. El feed construye relación; la venta dura quema audiencia.`,

  anuncio: `OBJETIVO DE ESTE GUIÓN: ANUNCIO (pauta pagada)

Quien lo ve NO conoce la marca y no la estaba buscando. Escribe en consecuencia:
- El gancho vive en los primeros 2 segundos. Si no detiene el scroll ahí, el resto no existe.
- Promesa concreta y verificable en la primera frase después del gancho. Nada de intriga larga.
- Estructura: gancho → problema nombrado → objeción principal resuelta → prueba → CTA duro.
- NO asumas ningún conocimiento previo: nombra el producto o servicio explícitamente.
- El CTA es una acción comercial directa e inmediata, con una sola opción.
- Sin jerga interna de la marca. Sin guiños que solo entiende un seguidor.
- Debe funcionar SIN sonido: el "textoPantalla" tiene que sostener el mensaje por sí solo.`,
};

export function getObjetivoBlock(objetivo: ObjetivoGuion): string {
  return PROFILES[objetivo];
}
