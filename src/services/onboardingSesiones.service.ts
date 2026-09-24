/**
 * Onboarding del cliente, version 2026-09-24.
 *
 * El proceso cambio: arranca un dia despues del pago con una bienvenida de 15
 * minutos donde Genesis crea el entorno frente al cliente, y sigue con las
 * reuniones de especializacion y levantamiento. La configuracion tecnica ya no
 * es una sesion aparte con David: se resuelve dentro de la especializacion.
 *
 * Telegram es el canal oficial. El bot no configura nada: enruta al cliente a
 * la reunion que toca, la agenda en el calendario del responsable y avisa.
 */
export type SesionOnboarding = "bienvenida" | "especializacion" | "levantamiento";

export interface DefinicionSesion {
  orden: number;
  etiqueta: string;
  emoji: string;
  responsable: { nombre: string; email: string };
  calendarioId: string;
  /** Link publico del CRM, por si el cliente prefiere agendar desde la web. */
  link: string;
  /** Cuanto dura, para decirselo sin que pregunte. */
  duracion: string;
  /** Lo que el cliente necesita tener listo para esa sesion. */
  requisitos: string[];
  /** Que se resuelve en la sesion, para que el bot lo explique. */
  resumen: string;
  /** Temas exactos de la sesion segun el documento de proceso. */
  temas: string[];
}

export const SESIONES_ONBOARDING: Record<SesionOnboarding, DefinicionSesion> = {
  bienvenida: {
    orden: 1,
    etiqueta: "Bienvenida y creación de tu entorno",
    emoji: "🤝",
    responsable: { nombre: "Genesis Benalcazar", email: "gbenalcazar@bakano.ec" },
    calendarioId: "FWL0e2jCKpbamtlj31io",
    link: "https://api.leadconnectorhq.com/widget/bookings/project-manager",
    duracion: "15 minutos",
    requisitos: [
      "Conéctate desde una computadora",
      "Ten a la mano el correo con el que quieres entrar a metrics.bakano.ec",
      "Ten instalado Telegram en tu celular",
    ],
    resumen:
      "Creamos tu entorno contigo en pantalla, te damos los accesos y te dejamos conectado al bot para que sigas el proceso desde el chat.",
    temas: [
      "Creación de tu entorno en metrics.bakano.ec frente a ti",
      "Invitación por correo a las personas de tu equipo que tendrán acceso",
      "Conexión de tu cuenta con el bot de Telegram",
      "Cómo es el proceso completo y qué te vamos a pedir en cada paso",
    ],
  },
  especializacion: {
    orden: 2,
    etiqueta: "Especialización con Joel",
    emoji: "📣",
    responsable: { nombre: "Joel Jimenez", email: "jjimenez@bakano.ec" },
    calendarioId: "GNizdekhY5SQaYTPdKPP",
    link: "https://api.leadconnectorhq.com/widget/bookings/meta-sessions",
    duracion: "1 hora",
    requisitos: [
      "Conéctate desde una computadora",
      "Ten el usuario y la clave de la cuenta de Instagram del negocio",
      "Ten el número de WhatsApp Business del negocio",
      "Ten un método de pago para Meta (tarjeta de crédito o débito)",
    ],
    resumen:
      "Dejamos listas tus cuentas para anunciar: portafolio comercial, fanpage, Instagram empresarial, cuenta publicitaria, WhatsApp Business y método de pago.",
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
  levantamiento: {
    orden: 3,
    etiqueta: "Levantamiento de información con Ariana",
    emoji: "📝",
    responsable: { nombre: "Ariana Vera", email: "avera@bakano.ec" },
    calendarioId: "JDzGl2qjoWwAk5TvBNUp",
    link: "https://api.leadconnectorhq.com/widget/bookings/arianna-reunion",
    duracion: "1 hora",
    requisitos: [
      "Ten claro qué quieres promocionar en las próximas semanas",
      "Ten a la mano tu catálogo y precios",
      "Si tienes videos de referencia que te gusten, tenlos listos",
    ],
    resumen:
      "Definimos qué vamos a anunciar en las próximas semanas y levantamos todo lo que Ariana necesita para escribir tus guiones.",
    temas: [
      "Qué deseas promocionar en las siguientes semanas",
      "Cómo se diferencia tu marca y tu producto o servicio de la competencia",
      "Tus servicios según tu vertical de negocio, para la estrategia y los guiones",
      "Ejemplos de videos de Bakano editados con IA y, si no te convencen, tus videos de referencia",
      "Definición de la fecha de tu producción o levantamiento de avatar",
    ],
  },
};

/**
 * El recorrido completo, de punta a punta, tal como lo ve el cliente.
 *
 * El cliente ve TODO: tambien lo que hace el equipo por dentro (los avatares,
 * las escenas, la edicion). Saber que su video esta en la mesa de Javier y no
 * "en proceso" es la diferencia entre esperar tranquilo y escribir preguntando.
 */
export type EtapaRecorrido =
  | "datosMarca"
  | "bienvenida"
  | "especializacion"
  | "levantamiento"
  | "guiones"
  | "aprobacionGuiones"
  | "produccion"
  | "avatares"
  | "escenas"
  | "edicion"
  | "aprobacionVideos"
  | "salidaVentas";

export interface DefinicionEtapa {
  orden: number;
  etiqueta: string;
  emoji: string;
  /** Quien la mueve: el cliente, el equipo, o el propio sistema. */
  deQuien: "cliente" | "equipo";
  responsable?: { nombre: string; email: string };
  /** Que pasa en esta etapa, en una linea, para el cliente. */
  que: string;
  /** Si la marca el equipo a mano en Metrics o se deduce de los datos. */
  seMarca: "automatico" | "manual";
}

const ARIANA = { nombre: "Ariana Vera", email: "avera@bakano.ec" };
const JEAN = { nombre: "Jean Ortega", email: "jortega@bakano.ec" };
const ANGEL = { nombre: "Ángel Sánchez", email: "asanchez@bakano.ec" };
const JAVIER = { nombre: "Javier León", email: "jleon@bakano.ec" };
const JOEL = { nombre: "Joel Jimenez", email: "jjimenez@bakano.ec" };
const GENESIS = { nombre: "Genesis Benalcazar", email: "gbenalcazar@bakano.ec" };

export const RECORRIDO: Record<EtapaRecorrido, DefinicionEtapa> = {
  bienvenida: {
    orden: 1,
    etiqueta: "Bienvenida y creación de tu entorno",
    emoji: "🤝",
    deQuien: "cliente",
    responsable: GENESIS,
    que: "15 minutos con Genesis: creamos tu entorno contigo en pantalla y te conectamos al bot.",
    seMarca: "automatico",
  },
  datosMarca: {
    orden: 2,
    etiqueta: "Los datos de tu marca",
    emoji: "🎨",
    deQuien: "cliente",
    que: "Nos cuentas de tu negocio por el chat: tipografía, vertical, ticket promedio, qué te diferencia y cómo hablas.",
    seMarca: "automatico",
  },
  especializacion: {
    orden: 3,
    etiqueta: "Especialización con Joel",
    emoji: "📣",
    deQuien: "cliente",
    responsable: JOEL,
    que: "Dejamos listas tus cuentas de Meta para poder anunciar.",
    seMarca: "automatico",
  },
  levantamiento: {
    orden: 4,
    etiqueta: "Levantamiento con Ariana",
    emoji: "📝",
    deQuien: "cliente",
    responsable: ARIANA,
    que: "Definimos qué vamos a promocionar y levantamos lo que hace falta para escribir tus guiones.",
    seMarca: "automatico",
  },
  guiones: {
    orden: 5,
    etiqueta: "Creación de tus guiones",
    emoji: "✍️",
    deQuien: "equipo",
    responsable: ARIANA,
    que: "Ariana escribe los guiones de lo que vamos a grabar.",
    seMarca: "automatico",
  },
  aprobacionGuiones: {
    orden: 6,
    etiqueta: "Tu aprobación de los guiones",
    emoji: "✅",
    deQuien: "cliente",
    que: "Los revisas y nos dices qué cambiarías. Nada se graba sin tu visto bueno.",
    seMarca: "automatico",
  },
  produccion: {
    orden: 7,
    etiqueta: "Producción y levantamiento de tu avatar",
    emoji: "🎬",
    deQuien: "cliente",
    responsable: JEAN,
    que: "La grabación: tu avatar, tus productos y los recursos que hagan falta.",
    seMarca: "automatico",
  },
  avatares: {
    orden: 8,
    etiqueta: "Creación de tus avatares",
    emoji: "🧬",
    deQuien: "equipo",
    responsable: ANGEL,
    que: "Con lo grabado, Ángel arma tus avatares.",
    seMarca: "manual",
  },
  escenas: {
    orden: 9,
    etiqueta: "Creación de las escenas",
    emoji: "🎞️",
    deQuien: "equipo",
    responsable: ANGEL,
    que: "Ángel monta las escenas de cada guion.",
    seMarca: "manual",
  },
  edicion: {
    orden: 10,
    etiqueta: "Edición de tus videos",
    emoji: "✂️",
    deQuien: "equipo",
    responsable: JAVIER,
    que: "Javier arma los videos finales, listos para publicar.",
    seMarca: "automatico",
  },
  aprobacionVideos: {
    orden: 11,
    etiqueta: "Tu aprobación de los videos",
    emoji: "👀",
    deQuien: "cliente",
    que: "Los ves y los apruebas. Si algo no te cuadra, se corrige antes de salir.",
    seMarca: "manual",
  },
  salidaVentas: {
    orden: 12,
    etiqueta: "Salida a ventas",
    emoji: "🚀",
    deQuien: "equipo",
    responsable: JOEL,
    que: "Un día después de tu aprobación, Joel pone los anuncios a circular. Vamos a cerrar ventas.",
    seMarca: "manual",
  },
};

export const ORDEN_RECORRIDO = (Object.keys(RECORRIDO) as EtapaRecorrido[]).sort(
  (a, b) => RECORRIDO[a].orden - RECORRIDO[b].orden
);

/** Las etapas que el equipo marca a mano en Metrics. */
export const ETAPAS_MANUALES = ORDEN_RECORRIDO.filter((e) => RECORRIDO[e].seMarca === "manual");

/**
 * Lo que el cliente entrega por su lado. Va aparte del recorrido porque no es
 * una etapa que avance: son cosas que pueden llegar en cualquier momento.
 */
export const PROCESO_ONBOARDING = {
  envios: [
    {
      que: "Tus logos en PNG (fondo transparente) y tu línea gráfica",
      donde: "por el chat del bot, o en metrics.bakano.ec en Recursos de marca",
    },
    {
      que: "Tu catálogo con precios",
      donde: "por el chat del bot, o en metrics.bakano.ec en Recursos de marca",
    },
    {
      que: "Tu facturación de los últimos 6 meses",
      donde: "por el chat del bot, o en metrics.bakano.ec en Facturación & ROAS",
    },
    {
      que: "Invitación al portafolio comercial de Meta con permisos de ADMINISTRACIÓN",
      donde: "dentro de Meta Business, invitando a agenciademi@gmail.com",
    },
  ],
  etapas: [
    {
      numero: 1,
      nombre: "Arranque",
      pasos: [
        "Bienvenida de 15 minutos con Genesis: se crea tu entorno frente a ti",
        "Te llega la invitación por correo para las personas con acceso",
        "Conectas tu cuenta con el bot de Telegram",
        "Nos cuentas los datos de tu marca por el chat",
      ],
    },
    {
      numero: 2,
      nombre: "Especialización y estrategia",
      pasos: [
        "Reunión de especialización con Joel Jimenez: tus cuentas listas para anunciar",
        "Levantamiento de información con Ariana Vera: qué vamos a promocionar",
        "Ariana escribe tus guiones y tú los apruebas",
      ],
    },
    {
      numero: 3,
      nombre: "Producción",
      pasos: [
        "Producción y levantamiento de tu avatar con Jean Ortega",
        "Creación de avatares y escenas con Ángel Sánchez",
        "Edición de los videos con Javier León",
        "Tu aprobación de los videos",
      ],
    },
    {
      numero: 4,
      nombre: "Ventas",
      pasos: [
        "Un día después de tu aprobación, los anuncios salen a circular (Joel Jimenez)",
        "Seguimiento del ROAS: análisis, ajuste y optimización de las campañas",
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
      return `${d.etiqueta} con ${d.responsable.nombre} (${d.responsable.email}), ${d.duracion}:\n  Requisitos: ${d.requisitos.join("; ")}\n  Temas: ${d.temas.join("; ")}\n  Link: ${d.link}`;
    })
    .join("\n");
  const recorrido = ORDEN_RECORRIDO.map((e) => {
    const d = RECORRIDO[e];
    return `${d.orden}. ${d.etiqueta}${d.responsable ? ` (${d.responsable.nombre})` : ""}: ${d.que}`;
  }).join("\n");
  return `Envíos que pide el proceso:\n${envios}\n\n${etapas}\n\nReuniones:\n${sesiones}\n\nRecorrido completo que ve el cliente:\n${recorrido}`;
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
