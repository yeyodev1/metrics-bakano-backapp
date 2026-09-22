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
  /** Temas exactos de la sesion segun el documento de proceso. */
  temas: string[];
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
      "Ten el usuario y la clave de la cuenta de Instagram del negocio",
      "Ten el número de WhatsApp Business del negocio",
      "Ten un método de pago para Meta (tarjeta de crédito o débito)",
    ],
    resumen:
      "Portafolio comercial en Meta, fanpage, cuenta de Instagram empresarial, cuenta publicitaria, WhatsApp Business y método de pago.",
    temas: [
      "Importancia del portafolio comercial y cómo se maneja",
      "Configuración del portafolio comercial en Meta",
      "Conexión o creación (si aplica) de la fanpage en Facebook",
      "Conexión o creación (si aplica) de la cuenta empresarial de Instagram",
      "Conexión o creación (si aplica) de la cuenta publicitaria",
      "Normas de la comunidad y buenas prácticas para evitar el baneo de Meta",
      "Conexión de WhatsApp Business con la cuenta publicitaria",
      "Configuración del método de pago en la cuenta publicitaria",
    ],
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
      "Ten a la mano el dispositivo con el WhatsApp Business",
      "Deja abiertas en tu computadora las cuentas de Facebook e Instagram del negocio",
    ],
    resumen: "Conexión del CRM con tus cuentas y configuración de tu entorno en metrics.bakano.ec.",
    temas: [
      "Conexión del CRM con el WhatsApp Business del negocio",
      "Conexión con las cuentas de Facebook e Instagram",
      "Configuración de tu entorno en metrics.bakano.ec",
    ],
  },
  estrategia: {
    orden: 3,
    etiqueta: "Estrategia y guiones",
    emoji: "📝",
    responsable: { nombre: "Ariana Vera", email: "avera@bakano.ec" },
    calendarioId: "JDzGl2qjoWwAk5TvBNUp",
    link: "https://api.leadconnectorhq.com/widget/bookings/arianna-reunion",
    requisitos: [
      "Ten a la mano tu catálogo y precios",
      "Piensa en qué diferencia a tu marca y a tu producto o servicio de la competencia",
      "Si tienes videos de referencia que te gusten, tenlos listos",
    ],
    resumen:
      "Diferenciación de tu marca, comprensión de tus servicios, ejemplos de videos y definición de la fecha de tu primera producción.",
    temas: [
      "Verificar que tu empresa se diferencie de la competencia en marca y producto o servicio",
      "Por qué importa esa diferenciación y sugerencias si todavía no la tienes",
      "Entender tus servicios según tu vertical de negocio para la estrategia y los guiones",
      "Definir la fecha de tu primera producción (levantamiento de avatar o grabación, según el servicio)",
      "Ejemplos de videos de Bakano editados con IA; si no te convencen, se te piden videos de referencia para hacerlo a semejanza",
    ],
  },
};

/**
 * Proceso completo de implementacion (documento "Proceso de implementacion de
 * estrategia Bakano"). Es lo que el bot sabe para guiar al cliente de punta
 * a punta; las sesiones de la etapa 1 viven arriba con su calendario.
 */
export const PROCESO_ONBOARDING = {
  envios: [
    {
      que: "Logos en PNG (fondo transparente) y tu línea gráfica, y el catálogo con precios",
      donde: "en metrics.bakano.ec, sección Recursos de marca de tu entorno",
    },
    {
      que: "Tu facturación de los últimos 6 meses",
      donde: "en metrics.bakano.ec, sección Facturación & ROAS de tu entorno",
    },
    {
      que: "Invitación al portafolio comercial de Meta con permisos de ADMINISTRACIÓN",
      donde: "dentro de Meta Business, invitando a agenciademi@gmail.com",
    },
  ],
  etapas: [
    {
      numero: 1,
      nombre: "Conexiones con plataformas",
      pasos: [
        "Onboarding en metrics.bakano.ec: subes tus datos de facturación (mínimo 6 meses de histórico), archivos e identidad de marca",
        "Nos envías tu catálogo y precios",
        "Sesión técnica de Meta con Joel Jimenez",
        "Sesión técnica de CRM y Metrics con David Robles",
        "Sesión de estrategia con Ariana Vera",
      ],
    },
    {
      numero: 2,
      nombre: "Producción",
      pasos: [
        "Producción o levantamiento de recursos como tu avatar",
        "Edición de los videos con IA",
        "Entrega de los videos",
      ],
    },
    {
      numero: 3,
      nombre: "Campañas y ROAS",
      pasos: [
        "Configuración de las campañas publicitarias en Meta",
        "Activación de los anuncios (aprobados por Meta)",
        "Revisión y estabilización del ROAS: análisis de métricas de los anuncios, ajuste y optimización de campañas y seguimiento del ROAS",
      ],
    },
  ],
};

/** El proceso en texto corto, para el system prompt de la IA. */
export function procesoOnboardingEnTexto(): string {
  const envios = PROCESO_ONBOARDING.envios.map((e) => `- ${e.que} → ${e.donde}`).join("\n");
  const etapas = PROCESO_ONBOARDING.etapas
    .map((e) => `Etapa ${e.numero} · ${e.nombre}:\n${e.pasos.map((p) => `  - ${p}`).join("\n")}`)
    .join("\n");
  const sesiones = (Object.keys(SESIONES_ONBOARDING) as SesionOnboarding[])
    .map((s) => {
      const d = SESIONES_ONBOARDING[s];
      return `${d.etiqueta} con ${d.responsable.nombre} (${d.responsable.email}):\n  Requisitos: ${d.requisitos.join("; ")}\n  Temas: ${d.temas.join("; ")}\n  Link: ${d.link}`;
    })
    .join("\n");
  return `Envíos que pide el proceso:\n${envios}\n\n${etapas}\n\nSesiones de la etapa 1:\n${sesiones}`;
}

export const ORDEN_SESIONES = (Object.keys(SESIONES_ONBOARDING) as SesionOnboarding[]).sort(
  (a, b) => SESIONES_ONBOARDING[a].orden - SESIONES_ONBOARDING[b].orden
);

/** Calendario del CRM → sesión, para reconocer las citas agendadas por el link. */
export const SESION_POR_CALENDARIO: Record<string, SesionOnboarding> = Object.fromEntries(
  ORDEN_SESIONES.map((s) => [SESIONES_ONBOARDING[s].calendarioId, s])
) as Record<string, SesionOnboarding>;

/** Correos que también deben enterarse del avance del onboarding. */
export const CORREOS_SEGUIMIENTO_ONBOARDING = ["gbenalcazar@bakano.ec"];
