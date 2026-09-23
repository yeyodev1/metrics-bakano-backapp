/**
 * Quién es quién en Bakano y cómo se complementan.
 *
 * El cliente no contrata "una agencia": contrata a un equipo que trabaja en
 * cadena. Si sabe que Ariana define el guion, que los productores lo graban,
 * que Javier y Ángel lo editan y que Joel y Denisse lo ponen a circular,
 * entiende por qué le pedimos cada cosa y a quién le habla en cada momento.
 */

export interface EtapaEquipo {
  emoji: string;
  etapa: string;
  quienes: string;
  que: string;
}

export const CADENA_BAKANO: EtapaEquipo[] = [
  {
    emoji: "📝",
    etapa: "Estrategia y guiones",
    quienes: "Ariana Vera",
    que: "Define la estrategia contigo, escribe los guiones y decide qué vamos a anunciar.",
  },
  {
    emoji: "🎬",
    etapa: "Producción",
    quienes: "Karen Muñoz y Jean Ortega",
    que: "Graban lo que hace falta para que eso exista: tu avatar, tus productos y los recursos clave.",
  },
  {
    emoji: "✂️",
    etapa: "Edición",
    quienes: "Javier León y Ángel Sánchez",
    que: "Arman los videos finales con lo grabado, listos para publicar.",
  },
  {
    emoji: "📣",
    etapa: "Campañas",
    quienes: "Joel Jimenez y Denisse Quimi",
    que: "Ponen los videos a circular en Meta y ajustan la pauta para traerte más prospectos.",
  },
  {
    emoji: "🤝",
    etapa: "Atención",
    quienes: "Genesis Benalcazar",
    que: "Coordina que todo lo anterior se cumpla y te acompaña en el día a día.",
  },
];

/**
 * Los dueños son tres. Con Diego y Denisse el cliente puede hablar sin
 * problema; a Luis se lo nombra y nada más, nunca se ofrece su contacto.
 */
export const DIRECCION = {
  texto:
    "Bakano es de Denisse Quimi, Diego Reyes y Luis Reyes. " +
    "Con Diego Reyes puedes hablar sin ningún problema: dreyes@bakano.ec, en Instagram @yeyo.dev. " +
    "Y con Denisse Quimi: dquimi@bakano.ec, en Instagram @denisseads.",
  contactos: [
    { nombre: "Diego Reyes", email: "dreyes@bakano.ec", instagram: "@yeyo.dev" },
    { nombre: "Denisse Quimi", email: "dquimi@bakano.ec", instagram: "@denisseads" },
  ],
};

/**
 * El WhatsApp de Diego. No va en el mensaje de siempre: se da cuando el
 * cliente insiste en hablar con dirección, no de entrada.
 */
export const WHATSAPP_DIRECCION = { nombre: "Diego Reyes", numero: "+593 96 368 1303" };

/** El equipo en texto, para el chat y para el prompt de la IA. */
export function equipoEnTexto(): string {
  return CADENA_BAKANO.map((e) => `${e.emoji} <b>${e.etapa}</b> · ${e.quienes}\n     ${e.que}`).join("\n\n");
}

export function equipoParaLaIa(): string {
  return (
    CADENA_BAKANO.map((e) => `- ${e.etapa}: ${e.quienes}. ${e.que}`).join("\n") +
    `\n- Dirección: ${DIRECCION.texto}`
  );
}
