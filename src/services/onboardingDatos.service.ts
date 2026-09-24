import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { atencionClienteService } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";

/**
 * Lo que el cliente tiene que entregar en el onboarding y los datos de su
 * marca. El bot detecta que falta, se lo pide conversando y lo deja en el
 * sistema: los datos van al perfil de marca (lo usa la IA de guiones) y los
 * envios quedan "declarados" hasta que el responsable los verifique.
 */

export type Entregable = "archivosMarca" | "facturacion" | "catalogo" | "invitacionMeta";

/** metrics.bakano.ec, salvo que APP_URL diga otra cosa (igual que los correos). */
const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";

/** El link exacto donde el cliente sube o carga cada cosa, con su entorno. */
export function linkEntregable(clave: Entregable, workspaceId: Types.ObjectId | string): string | undefined {
  const ruta = ENTREGABLES[clave]?.ruta;
  return ruta ? `${APP_URL}/app/workspaces/${workspaceId}${ruta}` : undefined;
}

const DENISSE = { nombre: "Denisse Quimi", email: "dquimi@bakano.ec" };
const DAVID = { nombre: "David Robles", email: "drobles@bakano.ec" };
const JOEL = { nombre: "Joel Jimenez", email: "jjimenez@bakano.ec" };

/**
 * Todo lo que el cliente entrega va POR LA PLATAFORMA, no por correo: cada
 * entregable tiene su pantalla en metrics.bakano.ec y el bot manda el link de
 * SU entorno. La unica excepcion es la invitacion al portafolio de Meta, que
 * se hace dentro de Meta Business.
 */
export const ENTREGABLES: Record<
  Entregable,
  { etiqueta: string; que: string; ruta?: string; a?: string; responsable: { nombre: string; email: string } }
> = {
  archivosMarca: {
    etiqueta: "Logos e identidad de marca",
    que: "Sube tus logos en PNG (con fondo transparente) y tu línea gráfica: colores, tipografías y ejemplos de piezas",
    ruta: "/resources",
    responsable: DENISSE,
  },
  facturacion: {
    etiqueta: "Facturación de los últimos 6 meses",
    que: "Carga tu facturación en la plataforma, incluidos los meses anteriores: con eso medimos el ROAS real",
    ruta: "/billing",
    responsable: DENISSE,
  },
  catalogo: {
    etiqueta: "Catálogo y precios",
    que: "Sube tu catálogo de productos o servicios con precios (PNG, JPG, WEBP o PDF), o escríbelo ahí mismo",
    ruta: "/resources",
    responsable: DENISSE,
  },
  invitacionMeta: {
    etiqueta: "Invitación al portafolio de Meta",
    que: "Invitación al portafolio comercial de Meta con permisos de ADMINISTRACIÓN (eso se hace dentro de Meta Business)",
    a: "agenciademi@gmail.com",
    responsable: JOEL,
  },
};

/**
 * Campos del perfil de marca que el cliente cuenta por chat, en el orden del
 * proceso (documento del 24/09/2026). El orden importa: es el que sigue el
 * bot cuando lo va preguntando uno por uno.
 */
export const CAMPOS_MARCA: Record<string, string> = {
  tipografiaTitulos: "La tipografía de sus títulos",
  tipografiaTextos: "La tipografía de sus textos",
  vertical: "Su vertical de negocio",
  descripcion: "Qué hace el negocio",
  tipoNegocio: "Si vende productos o servicios",
  productosServicios: "Qué productos o servicios vende",
  ticketPromedio: "Su ticket promedio de venta, o el rango",
  porQueTeCompran: "Por qué le compra su cliente",
  propuestaValor: "Qué lo hace diferente de su competencia",
  halagoComun: "El halago más común de sus clientes satisfechos",
  tono: "Su estilo de comunicación",
  // Donde cae la venta. Sin esto los videos no tienen a donde mandar a la
  // gente: es el dato que define si la pauta va a WhatsApp o a la agenda.
  trafficDirection: "Dónde captura la venta: WhatsApp o GHL/Agenda",
  trafficLink: "El link o el número de WhatsApp al que llegan sus clientes",
};

/**
 * Opciones fijas. Donde la respuesta es una de estas, el bot pone botones: el
 * cliente no tiene que escribir "semicasual" ni acordarse de como se llamaba
 * la tipografia.
 */
export const OPCIONES_MARCA: Record<string, { etiqueta: string; valor: string }[]> = {
  tipografiaTitulos: [
    { etiqueta: "Anton", valor: "Anton" },
    { etiqueta: "Helvetica", valor: "Helvetica" },
    { etiqueta: "Playfair", valor: "Playfair" },
  ],
  tipografiaTextos: [
    { etiqueta: "Nunito", valor: "Nunito" },
    { etiqueta: "Poppins", valor: "Poppins" },
    { etiqueta: "Montserrat", valor: "Montserrat" },
  ],
  tipoNegocio: [
    { etiqueta: "Productos", valor: "PRODUCTOS" },
    { etiqueta: "Servicios", valor: "SERVICIOS" },
  ],
  tono: [
    { etiqueta: "Profesional", valor: "profesional" },
    { etiqueta: "Semicasual", valor: "semicasual" },
    { etiqueta: "Casual", valor: "casual" },
  ],
};

/** Lo que el bot pregunta para cada campo, con sus palabras. */
export const PREGUNTA_MARCA: Record<string, string> = {
  tipografiaTitulos:
    "Empecemos por lo visual 🎨\n\n¿Qué <b>tipografía</b> usas para tus <b>títulos</b>?\n\nSi ya tienes una, mándame el archivo o escríbeme cómo se llama. Si no, elige una de estas y la usamos:",
  tipografiaTextos:
    "¿Y para los <b>textos y subtítulos</b>?\n\nIgual: mándame la tuya o elige una 👇",
  vertical: "¿Cuál es tu <b>vertical de negocio</b>? Por ejemplo: restaurante, clínica dental, tienda de ropa, inmobiliaria…",
  descripcion: "Cuéntame en dos o tres líneas: <b>¿qué hace tu negocio?</b>",
  tipoNegocio: "¿Vendes <b>productos</b> o <b>servicios</b>?",
  productosServicios: "Descríbeme <b>tu producto o servicio</b>: qué es, qué incluye, cómo lo entregas.",
  ticketPromedio:
    "¿Cuál es tu <b>ticket promedio de venta</b>?\n\nSi no lo tienes exacto, dame un rango. Por ejemplo: “unos 45 dólares” o “entre 30 y 80”.",
  porQueTeCompran: "¿<b>Por qué te compra</b> tu cliente? Con tus palabras, no la versión de folleto.",
  propuestaValor:
    "¿Qué te hace <b>diferente de tu competencia</b>?\n\nPor ejemplo: la velocidad de entrega, la calidad, los resultados que consigues…",
  halagoComun: "¿Cuál es el <b>halago más común</b> que te hacen tus clientes satisfechos?",
  tono: "Por último: ¿cómo te gusta <b>comunicarte</b> con tus clientes?",
};

/**
 * Campos que el cliente muchas veces no sabe todavia (no tiene la agenda
 * montada, no sabe que link poner). Ahi no se lo deja atascado: lo resuelve
 * con el equipo en su sesion, y al responsable le llega el aviso.
 */
export const AYUDA_CAMPO_MARCA: Record<string, { responsable: { nombre: string; email: string }; donde: string }> = {
  trafficDirection: { responsable: DAVID, donde: "tu sesión de Configuración de CRM y Metrics" },
  trafficLink: { responsable: DAVID, donde: "tu sesión de Configuración de CRM y Metrics" },
};

class OnboardingDatosService {
  /** Todo lo que le falta al cliente para arrancar, en el orden del proceso. */
  async pendientes(workspaceId: Types.ObjectId) {
    const [workspace, estado, diasFacturacion] = await Promise.all([
      models.workspaces.findById(workspaceId).select("name brandProfile onboardingEntregables metaAds").lean(),
      onboardingBotService.estado(workspaceId),
      models.dailyBilling
        .distinct("date", { workspaceId, date: { $gte: new Date(Date.now() - 180 * 86_400_000) } })
        .then((d) => d.length)
        .catch(() => 0),
    ]);
    const marca = ((workspace as any)?.brandProfile || {}) as Record<string, unknown>;
    const entregas = ((workspace as any)?.onboardingEntregables || {}) as Record<string, { estado?: string }>;

    return {
      entorno: workspace?.name,
      sesionesPendientes: estado.sesiones
        .filter((s) => !s.agendada && s.estado !== "cumplida" && s.estado !== "no_aplica")
        .map((s) => ({ sesion: s.sesion, etiqueta: s.etiqueta, con: s.responsable, link: s.link })),
      entregables: (Object.keys(ENTREGABLES) as Entregable[]).map((k) => ({
        clave: k,
        etiqueta: ENTREGABLES[k].etiqueta,
        que: ENTREGABLES[k].que,
        // El link es de ESTE entorno: se lo puedes pasar tal cual.
        link: linkEntregable(k, workspaceId),
        invitarA: ENTREGABLES[k].a,
        estado: entregas[k]?.estado || "pendiente",
      })),
      perfilDeMarca: `${APP_URL}/app/workspaces/${workspaceId}/brand-profile`,
      datosMarcaFaltantes: Object.keys(CAMPOS_MARCA)
        .filter((c) => !String(marca[c] ?? "").trim())
        .map((c) => ({ campo: c, que: CAMPOS_MARCA[c] })),
      datosMarcaCompletos: Object.keys(CAMPOS_MARCA).filter((c) => String(marca[c] ?? "").trim()),
      diasDeFacturacionEnPlataforma: diasFacturacion,
      metaConectado: Boolean((workspace as any)?.metaAds?.adAccountId || (workspace as any)?.metaAds?.pageId),
    };
  }

  /** Guarda un dato de la marca con las palabras del cliente. */
  async registrarDatoMarca(chat: ITelegramChat, campo: string, valor: string, reemplazar = false) {
    if (!(campo in CAMPOS_MARCA)) return { ok: false as const, motivo: `campo desconocido: ${campo}` };
    // Lo que ya estaba (lo lleno el equipo o el cliente en la web) no se pisa
    // sin que el cliente diga que quiere cambiarlo.
    const previo = (await models.workspaces.findById(chat.workspaceId).select(`brandProfile.${campo}`).lean()) as any;
    const actual = String(previo?.brandProfile?.[campo] ?? "").trim();
    if (actual && !reemplazar) {
      return { ok: false as const, motivo: "ya_tiene_valor", actual, siguiente: "Pregúntale si quiere reemplazarlo; si dice que sí, vuelve a llamar con reemplazar=true." };
    }
    let limpio = String(valor || "").trim().slice(0, 1500);
    if (campo === "tono") {
      // El proceso define tres estilos. Lo que escriba se acomoda a uno de
      // ellos: guardar "formal pero cercano" no le sirve a quien escribe.
      const v = limpio.toLowerCase();
      limpio = /semi|intermedi|mezcla/.test(v)
        ? "semicasual"
        : /casual|cercan|informal|amig/.test(v)
          ? "casual"
          : /profes|formal|serio|corporat/.test(v)
            ? "profesional"
            : "";
      if (!limpio) return { ok: false as const, motivo: "Elige uno de los tres: profesional, semicasual o casual." };
    } else if (campo === "tipografiaTitulos" || campo === "tipografiaTextos") {
      if (limpio.length < 2) return { ok: false as const, motivo: "Dime el nombre de la tipografía o elige una de las opciones." };
      limpio = limpio.slice(0, 80);
    } else if (campo === "ticketPromedio") {
      if (!/\d/.test(limpio)) return { ok: false as const, motivo: "Necesito un número o un rango. Por ejemplo: “45 dólares” o “entre 30 y 80”." };
      limpio = limpio.slice(0, 120);
    } else if (campo === "trafficDirection") {
      const v = limpio.toLowerCase();
      limpio = /whats|wpp|wasap/.test(v) ? "WHATSAPP" : /ghl|agenda|calendar|crm|cita/.test(v) ? "GHL" : "";
      if (!limpio) return { ok: false as const, motivo: "trafficDirection debe ser WhatsApp o GHL/Agenda" };
    } else if (campo === "trafficLink") {
      // O es un numero de WhatsApp o es un link: cualquier otra cosa no sirve
      // para pautar y se vuelve un problema recien cuando el anuncio esta vivo.
      const digitos = limpio.replace(/[^\d]/g, "");
      const esLink = /^(https?:\/\/|www\.|wa\.me|[\w-]+\.[a-z]{2,})/i.test(limpio);
      if (!esLink && digitos.length < 9) {
        return { ok: false as const, motivo: "Necesito un número de WhatsApp con código de país (+593…) o un link completo." };
      }
      if (!esLink) limpio = digitos.startsWith("593") ? `+${digitos}` : digitos.length === 10 && digitos.startsWith("0") ? `+593${digitos.slice(1)}` : limpio;
    } else if (campo === "tipoNegocio") {
      const v = limpio.toLowerCase();
      limpio = /servicio/.test(v) ? "SERVICIOS" : /producto/.test(v) ? "PRODUCTOS" : "";
      if (!limpio) return { ok: false as const, motivo: "tipoNegocio debe ser productos o servicios" };
    } else if (limpio.length < 3) {
      return { ok: false as const, motivo: "muy corto: pídele un poco más de detalle" };
    }
    // Entorno nuevo: brandProfile es null y Mongo no deja crear un campo
    // dentro de null. Primero se crea vacio (solo si sigue en null).
    await models.workspaces.updateOne(
      { _id: chat.workspaceId, $or: [{ brandProfile: null }, { brandProfile: { $exists: false } }] },
      { $set: { brandProfile: { descripcion: "", vertical: "", trafficLink: "", archivos: [] } } }
    );
    await models.workspaces.updateOne(
      { _id: chat.workspaceId },
      { $set: { [`brandProfile.${campo}`]: limpio, "brandProfile.updatedAt": new Date() } }
    );
    return { ok: true as const, guardado: CAMPOS_MARCA[campo] };
  }

  /**
   * El cliente no sabe ese dato. No se lo deja dando vueltas: se le dice quien
   * lo va a resolver con el y a ese responsable le llega el aviso (Slack, DM,
   * correo y notificacion en Metrics), una sola vez por campo.
   */
  async pedirAyudaConDato(chat: ITelegramChat, campo: string, nota?: string) {
    const ayuda = AYUDA_CAMPO_MARCA[campo];
    if (!ayuda) return { ok: false as const, motivo: `ese campo no tiene ayuda del equipo: ${campo}` };
    const clave = `ayuda_${campo}`;
    const workspace = await models.workspaces.findById(chat.workspaceId).select("name onboardingEntregables").lean();
    const yaAvisado = (workspace as any)?.onboardingEntregables?.[clave]?.estado === "declarado";

    await models.workspaces.updateOne(
      { _id: chat.workspaceId },
      { $set: { [`onboardingEntregables.${clave}`]: { estado: "declarado", declaradoEn: new Date(), nota: nota?.slice(0, 500) } } }
    );

    if (!yaAvisado) {
      const cliente = await atencionClienteService.datosCliente(chat);
      const titulo = `${cliente.entorno} necesita ayuda con: ${CAMPOS_MARCA[campo]}`;
      const detalle =
        `${cliente.nombre} me dijo por Telegram que todavía no lo sabe.\n` +
        (nota ? `Lo que contó: ${nota}\n` : "") +
        `\nLe dije que lo resuelven juntos en ${ayuda.donde}. Queda pendiente en su perfil de marca:\n` +
        `${APP_URL}/app/workspaces/${chat.workspaceId}/brand-profile`;
      const correos = [ayuda.responsable.email];
      const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
      await Promise.allSettled([
        slackService.avisarEquipo({ titulo, detalle, correos }),
        slackService.mensajeDirecto(ayuda.responsable.email, titulo, detalle),
        ...internos.map((u) =>
          notificationService.create(u._id as any, "solicitud_cliente", titulo, detalle, { workspaceId: chat.workspaceId! })
        ),
        resendService.sendSolicitudClienteEmail({
          to: correos,
          tema: CAMPOS_MARCA[campo],
          workspaceName: cliente.entorno,
          clienteNombre: cliente.nombre,
          clienteEmail: cliente.email,
          telegramUsername: chat.telegramUsername,
          mensaje: detalle,
          asunto: titulo,
          encabezado: titulo,
        }),
      ]);
    }
    return { ok: true as const, responsable: ayuda.responsable.nombre, donde: ayuda.donde, yaAvisado };
  }

  /** El cliente dice que ya envio algo: queda declarado y se avisa al responsable para verificar. */
  async registrarEntregable(chat: ITelegramChat, clave: string, nota?: string) {
    const def = ENTREGABLES[clave as Entregable];
    if (!def) return { ok: false as const, motivo: `entregable desconocido: ${clave}` };
    const workspace = await models.workspaces.findById(chat.workspaceId).select("onboardingEntregables").lean();
    const actual = (workspace as any)?.onboardingEntregables?.[clave]?.estado;
    if (actual === "declarado" || actual === "verificado") return { ok: true as const, yaEstaba: actual, etiqueta: def.etiqueta };

    await models.workspaces.updateOne(
      { _id: chat.workspaceId },
      {
        $set: {
          [`onboardingEntregables.${clave}`]: {
            estado: "declarado",
            declaradoEn: new Date(),
            nota: nota?.trim().slice(0, 500) || undefined,
          },
        },
      }
    );

    const cliente = await atencionClienteService.datosCliente(chat);
    const donde = linkEntregable(clave as Entregable, chat.workspaceId!) || def.a;
    const titulo = `📦 ${cliente.entorno} dice que ya cargó: ${def.etiqueta}`;
    const detalle = `${cliente.nombre} lo declaró por Telegram. Revisa que esté completo en ${donde}.${nota ? `\nNota del cliente: ${nota}` : ""}`;
    const internos = await models.users.find({ email: def.responsable.email, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos: [def.responsable.email] }),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle, { workspaceId: chat.workspaceId! })
      ),
      resendService.sendSolicitudClienteEmail({
        to: [def.responsable.email],
        tema: "onboarding",
        workspaceName: cliente.entorno,
        clienteNombre: cliente.nombre,
        clienteEmail: cliente.email,
        telegramUsername: chat.telegramUsername,
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
    return { ok: true as const, etiqueta: def.etiqueta, verificara: def.responsable.nombre, donde };
  }
}

export const onboardingDatosService = new OnboardingDatosService();
