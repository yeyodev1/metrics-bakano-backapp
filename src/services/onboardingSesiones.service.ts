/**
 * Onboarding del cliente: las tres sesiones tecnicas que van antes de la
 * primera produccion (documento "Proceso de implementacion de estrategia").
 *
 * Telegram es el canal oficial: el bot NO resuelve la configuracion tecnica,
 * enruta al cliente a la sesion correcta, la agenda en el calendario del
 * responsable y avisa. Cada sesion vive en su propio calendario del CRM.
 */
export type SesionOnboarding = "meta" | "crm" | "estrategia";

export interface DefinicionSesion {
  orden: number;
  etiqueta: string;
  emoji: string;
  responsable: { nombre: string; email: string };
  calendarioId: string;
  /** Link publico del CRM, por si el cliente prefiere agendar desde la web. */
  link: string;
  /** Lo que el cliente necesita tener listo para esa sesion. */
  requisitos: string[];
  /** Que se resuelve en la sesion, para que el bot lo explique. */
  resumen: string;
}

export const SESIONES_ONBOARDING: Record<SesionOnboarding, DefinicionSesion> = {
  meta: {
    orden: 1,
    etiqueta: "Conexión de cuentas Meta",
    emoji: "📣",
    responsable: { nombre: "Joel Jimenez", email: "jjimenez@bakano.ec" },
    calendarioId: "GNizdekhY5SQaYTPdKPP",
    link: "https://api.leadconnectorhq.com/widget/bookings/meta-sessions",
    requisitos: [
      "Conéctate desde una computadora",
      "Ten el usuario y la clave del Instagram del negocio",
      "Ten a la mano el WhatsApp Business del negocio",
      "Ten una tarjeta de crédito o débito para Meta",
    ],
    resumen:
      "Portafolio comercial en Meta, fanpage, cuenta de Instagram empresarial, cuenta publicitaria, WhatsApp Business y método de pago.",
  },
  crm: {
    orden: 2,
    etiqueta: "Configuración de CRM y Metrics",
    emoji: "🗂️",
    responsable: { nombre: "David Robles", email: "drobles@bakano.ec" },
    calendarioId: "aaHn06pmWuNFuF7tjDST",
    link: "https://api.leadconnectorhq.com/widget/bookings/soporte-tecnico-crm",
    requisitos: [
      "Conéctate desde una computadora",
      "Ten el celular con el WhatsApp Business a la mano",
      "Deja abiertas las cuentas de Facebook e Instagram del negocio",
    ],
    resumen: "Conexión del CRM con tus cuentas y configuración de tu entorno en metrics.bakano.ec.",
  },
  estrategia: {
    orden: 3,
    etiqueta: "Estrategia y guiones",
    emoji: "📝",
    responsable: { nombre: "Ariana Vera", email: "avera@bakano.ec" },
    calendarioId: "JDzGl2qjoWwAk5TvBNUp",
    link: "https://api.leadconnectorhq.com/widget/bookings/arianna-reunion",
    requisitos: [
      "Ten claro qué producto o servicio quieres promocionar este mes",
      "Ten a la mano tu catálogo y precios",
      "Piensa en qué te diferencia de tu competencia",
    ],
    resumen:
      "Diferenciación de tu marca, comprensión de tus servicios, ejemplos de videos y definición de la fecha de tu primera producción.",
  },
};

export const ORDEN_SESIONES = (Object.keys(SESIONES_ONBOARDING) as SesionOnboarding[]).sort(
  (a, b) => SESIONES_ONBOARDING[a].orden - SESIONES_ONBOARDING[b].orden
);

/** Calendario del CRM → sesión, para reconocer las citas agendadas por el link. */
export const SESION_POR_CALENDARIO: Record<string, SesionOnboarding> = Object.fromEntries(
  ORDEN_SESIONES.map((s) => [SESIONES_ONBOARDING[s].calendarioId, s])
) as Record<string, SesionOnboarding>;

/** Correos que también deben enterarse del avance del onboarding. */
export const CORREOS_SEGUIMIENTO_ONBOARDING = ["gbenalcazar@bakano.ec"];
