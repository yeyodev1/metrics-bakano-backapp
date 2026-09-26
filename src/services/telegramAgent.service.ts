import { z } from "zod";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { contenidoClienteService } from "./contenidoCliente.service";
import { accesosClienteService } from "./accesosCliente.service";
import { atencionClienteService, fechaEcuador, type DatosCliente } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { citasClienteService } from "./citasCliente.service";
import { AYUDA_CAMPO_MARCA, CAMPOS_MARCA, ENTREGABLES, onboardingDatosService } from "./onboardingDatos.service";
import { metricasClienteService } from "./metricasCliente.service";
import { claveDia, contextoParaLaIa, facturacionChatService, comoPlata } from "./facturacionChat.service";
import { publicidadClienteService } from "./publicidadCliente.service";
import { pagosClienteService } from "./pagosCliente.service";
import { fueraDeHorario, incidentesService } from "./incidentes.service";
import { equipoParaLaIa, WHATSAPP_DIRECCION } from "./equipoBakano.service";
import { CATEGORIAS_GUION, revisionGuionesService } from "./revisionGuiones.service";
import { perfilClienteService, type PerfilCliente } from "./perfilCliente.service";
import {
  PROCESO_ONBOARDING,
  SESIONES_ONBOARDING,
  procesoOnboardingEnTexto,
  type SesionOnboarding,
} from "./onboardingSesiones.service";
import { horasDeCorreccion } from "./videoPlanning.service";
import { escaparHtml, telegramService } from "./telegram.service";
import { notificationService } from "./notification.service";
import { resendService } from "./resend.service";
import { slackService } from "./slack.service";
import { contratoChatService } from "./contratoChat.service";
import { PAUTA_MINIMA, PAUTA_TEMPORADA_ALTA } from "./contratoTexto";

/**
 * La IA que conversa con el cliente por Telegram.
 *
 * Corre con el AI SDK sobre Vercel AI Gateway: el modelo es un string
 * "proveedor/modelo" y se autentica con AI_GATEWAY_API_KEY (u OIDC en
 * Vercel). Cambiar de modelo es cambiar AI_MODEL.
 *
 * `ai` es solo ESM y se carga al primer mensaje, no al importar: si no carga
 * en el runtime, falla solo la IA (el bot vuelve al menu) y no la funcion
 * entera de la API. Un import estatico tumbo todo el backend en produccion.
 *
 * Nunca inventa datos: producciones, guiones y horarios salen de las
 * herramientas. En paralelo clasifica el animo del cliente y avisa a la
 * project manager si esta molesto o en peligro de irse.
 */

const modelo = () => process.env.AI_MODEL || "google/gemini-3.8-flash";
// Vercel corta la funcion a los 60 s y Telegram reintenta si no respondemos.
// Enviar una revision encadena varias herramientas: con 35 s no alcanzaba.
const LIMITE_MS = Number(process.env.AI_LIMITE_MS) || 50_000;
const LIMITE_CLASIFICACION_MS = 30_000;
/** Un comentario ya no bloquea la respuesta del cliente: puede tomarse más. */
const LIMITE_COMENTARIO_MS = 45_000;

/**
 * Razonamiento del modelo. Medido el 2026-09-22 con el flujo completo de
 * correcciones: "low" no acelero (20-30 s por turno vs 10-19 s por defecto),
 * asi que por defecto va como viene el modelo. AI_THINKING_LEVEL lo cambia.
 */
function opcionesModelo(): Record<string, unknown> {
  const nivel = process.env.AI_THINKING_LEVEL || "default";
  return nivel === "default" ? {} : { providerOptions: { google: { thinkingConfig: { thinkingLevel: nivel } } } };
}
const MAX_HISTORIAL = 20;
const ALERTA_CADA_MS = 24 * 3_600_000;

const TEMAS = ["produccion", "guiones", "atencion"] as const;

type Mensaje = { role: "user" | "assistant"; content: string };
type AiSdk = typeof import("ai");

let aiSdk: Promise<AiSdk> | null = null;
/**
 * `import()` a secas lo compila TypeScript a `require()` (module commonjs) y
 * en el runtime de Vercel eso revienta con "require() of ES Module": la IA
 * quedaba muerta y el bot respondia siempre con el menu. El Function lo
 * esconde del compilador, asi que sigue siendo un import dinamico de verdad.
 */
const importarEsm = new Function("modulo", "return import(modulo)") as (modulo: string) => Promise<any>;
async function traerAi(): Promise<AiSdk> {
  try {
    // El require literal es ademas lo que hace que Vercel empaquete "ai" en
    // la funcion: si solo quedara el import escondido, no lo rastrearia.
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

/**
 * Red de seguridad por si el clasificador no responde (se corta a los 30 s).
 * Es tosca a propósito: prefiero abrir un incidente de más que dejar pasar a
 * un cliente furioso porque el modelo tardó.
 */
const SENALES_DE_ALARMA =
  /\b(furios|indignad|harto|hartа|estafa|verguenza|vergüenza|pesimo|pésimo|nadie responde|no me responden|quiero cancelar|voy a cancelar|me quiero ir|desesperad|angustiad|urgente|urgencia|ayuda ya|por favor ayud)/i;

function animoDeEmergencia(texto: string): Clasificacion | null {
  if (!SENALES_DE_ALARMA.test(texto)) return null;
  const seVa = /\b(cancelar|me quiero ir|estafa)/i.test(texto);
  return {
    estado: seVa ? "en_peligro" : "molesto",
    tema: "atencion",
    motivo: "Detectado por palabras clave: la lectura de ánimo no respondió a tiempo",
    frase: texto.slice(0, 300),
    recomendacion: "Contactar al cliente de inmediato: el mensaje suena grave y el análisis automático no alcanzó a correr.",
  };
}

const clasificacionSchema = z.object({
  estado: z.enum(["en_peligro", "angustiado", "molesto", "feliz", "neutral"]),
  /** De qué se queja: define a qué responsable se escala. */
  tema: z.enum(TEMAS).catch("atencion"),
  motivo: z.string().default(""),
  frase: z.string().default(""),
  recomendacion: z.string().default(""),
});
type Clasificacion = z.infer<typeof clasificacionSchema>;

class TelegramAgentService {
  /** Responde con IA. false si la IA fallo: el bot vuelve al menu. */
  async responder(chat: ITelegramChat, texto: string): Promise<boolean> {
    const historial: Mensaje[] = (chat.historial || []).slice(-MAX_HISTORIAL).map((m) => ({
      role: m.rol === "cliente" ? "user" : "assistant",
      content: m.texto,
    }));
    // El animo se lee en paralelo pero la respuesta no lo espera: antes el
    // cliente esperaba hasta 30 s extra cuando el clasificador tardaba.
    const clasificacion = this.clasificar(historial, texto).catch((error) => {
      console.error("[Telegram IA] clasificación:", error?.message || error);
      return null;
    });

    let respuesta = "";
    let cliente: DatosCliente | null = null;
    // Lo que paso en este turno: si se propuso un cambio de cita, van botones.
    // Que herramientas uso: con eso se arman los botones de la respuesta. El
    // cliente venia teniendo que escribir "dime los horarios" a mano.
    const turno = { inicio: new Date(), propuesta: false, usadas: new Set<string>() };
    try {
      const { generateText, isStepCount } = await cargarAi();
      const [datos, perfil] = await Promise.all([
        atencionClienteService.datosCliente(chat),
        perfilClienteService.de(chat.workspaceId!, chat.userId),
      ]);
      cliente = datos;
      // Cliente arrancando: lo pendiente va en las instrucciones y el modelo
      // no gasta un paso (5-10 s) en consultarlo en cada mensaje.
      const pendientes =
        !perfil.esEquipo && perfil.tipo !== "activo"
          ? await onboardingDatosService.pendientes(chat.workspaceId!).catch(() => null)
          : null;
      await telegramService.sendChatAction(chat.chatId, "typing").catch(() => undefined);
      const inicio = Date.now();
      let marca: number | undefined;

      const resultado = await generateText({
        model: modelo(),
        system: this.instrucciones(datos, perfil, pendientes),
        messages: [...historial, { role: "user", content: texto }],
        tools: this.registrarUso(this.herramientas(chat, texto, turno), turno.usadas, chat),
        stopWhen: isStepCount(6),
        // Tiempo por paso en los logs: sin esto un corte a los 50 s no dice
        // si fue el modelo pensando o una herramienta lenta.
        onStepFinish: (paso: any) => {
          const ahora = Date.now();
          console.log(
            `[Telegram IA] paso ${((ahora - (marca ?? inicio)) / 1000).toFixed(1)} s · ${
              (paso.toolCalls || []).map((c: any) => c.toolName).join(", ") || "texto"
            }`
          );
          marca = ahora;
          for (const parte of paso.content || []) {
            if (parte?.type === "tool-error") {
              console.error(`[Telegram IA] herramienta ${parte.toolName} falló:`, String(parte.error?.message || parte.error).slice(0, 300));
            }
          }
        },
        abortSignal: AbortSignal.timeout(LIMITE_MS),
        ...opcionesModelo(),
      });
      // Por si el modelo se salta la regla: sin markdown ni signos de apertura.
      respuesta = resultado.text.replace(/\*\*?|__|#+ /g, "").replace(/[¡¿]/g, "").trim();
    } catch (error: any) {
      console.error("[Telegram IA] respuesta:", error?.message || error);
      // Si alcanzo a proponer un cambio de cita, el cliente igual tiene que
      // ver que confirma: sin esto quedaria pendiente y sin botones.
      if (turno.propuesta && chat.cambioPendiente) {
        respuesta = `Te lo dejo listo para confirmar:\n${chat.cambioPendiente.resumen} (hora Ecuador).\n\nConfirmas?`;
      }
    }

    if (respuesta) {
      await telegramService.sendMessage(
        chat.chatId,
        escaparHtml(respuesta).slice(0, 4000),
        turno.propuesta
          ? [
              [
                { text: "✅ Sí, confirmo", callback_data: "cita:si" },
                { text: "✖️ No", callback_data: "cita:no" },
              ],
            ]
          : this.botonesDelTurno(turno.usadas)
      );
      const ahora = new Date();
      await models.telegramChats.updateOne(
        { _id: chat._id },
        {
          $push: {
            historial: {
              $each: [
                { rol: "cliente", texto: texto.slice(0, 2000), en: ahora },
                { rol: "bot", texto: respuesta.slice(0, 2000), en: ahora },
              ],
              $slice: -MAX_HISTORIAL,
            },
          },
        }
      );
    }

    // La queja se escala aunque la IA no haya podido responder.
    // Si el clasificador no llegó, se mira el texto: un "quiero cancelar" no
    // se puede perder porque el modelo tardó 30 segundos.
    const c = (await clasificacion) ?? animoDeEmergencia(texto);
    if (c) {
      cliente ??= await atencionClienteService.datosCliente(chat).catch(() => null);
      if (cliente) await this.alertarSiHaceFalta(chat, cliente, c, texto);

      // Alguien angustiado no puede recibir "se me trabó, escríbeme de nuevo".
      // Si la IA no alcanzó a responder, igual se le contesta como persona y
      // se le dice que el equipo ya está en eso (el aviso ya salió arriba).
      if (!respuesta && (c.estado === "angustiado" || c.estado === "en_peligro")) {
        await telegramService
          .sendMessage(
            chat.chatId,
            "Te leo, y entiendo que es urgente 🙏\n\n" +
              (fueraDeHorario()
                ? "A esta hora el equipo ya está fuera de oficina (atendemos hasta las 5 de la tarde), pero igual les avisé a todos ahora mismo " +
                  "y me voy a encargar de que un asesor tome tu caso apenas arranque el día. Esto lo tiene que ver una persona, no solo yo."
                : "Ya le avisé a tu equipo de Bakano ahora mismo para que te contacten.") +
              "\n\nCuéntame mientras qué es lo más urgente y lo sumo al aviso.",
            [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]]
          )
          .catch((error: any) => console.error("[Telegram IA] aviso de urgencia:", error?.message || error));
        return true;
      }
    }
    return Boolean(respuesta);
  }

  /** Envuelve cada herramienta para saber cuales se usaron en este turno. */
  private registrarUso(herramientas: Record<string, any>, usadas: Set<string>, chat: ITelegramChat): Record<string, any> {
    for (const [nombre, def] of Object.entries(herramientas)) {
      const original = def.execute;
      def.execute = async (args: any, opciones: any) => {
        usadas.add(nombre);
        // Queda registro de que herramienta resolvio la pregunta: es lo que
        // despues dice si el bot sirve para lo que el cliente necesita.
        models.usoBot
          .create({ workspaceId: chat.workspaceId, userId: chat.userId, chatId: chat.chatId, accion: `ia:${nombre}`, origen: "ia", en: new Date() })
          .catch(() => undefined);
        return original(args, opciones);
      };
    }
    return herramientas;
  }

  /**
   * Botones segun de que se hablo. Una respuesta de la IA sin botones deja al
   * cliente escribiendo "dime los horarios" a mano, que es justo lo que el
   * menu evita.
   */
  private botonesDelTurno(usadas: Set<string>): { text: string; callback_data?: string; url?: string }[][] {
    const uso = (...nombres: string[]) => nombres.some((n) => usadas.has(n));
    const botones: { text: string; callback_data?: string; url?: string }[][] = [];

    if (uso("verMisCitas", "verHorariosParaMover", "reprogramarCita", "cancelarCita", "avisarCambioSobreLaHora")) {
      botones.push([{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }]);
    }
    if (uso("verHorariosProduccion", "agendarProduccion", "verProducciones", "verReservaDeContenido")) {
      botones.push([{ text: "🎬 Mis producciones", callback_data: "menu:produccion" }]);
    }
    if (uso("verGuionesParaRevisar", "verGuiones", "verGuion", "anotarCorreccion", "verBorradorRevision", "enviarRevisionGuiones")) {
      botones.push([{ text: "📝 Revisar mis guiones", callback_data: "menu:guiones" }]);
    }
    if (uso("verOnboarding", "verPendientesOnboarding", "registrarDatoMarca", "registrarEntregable", "pedirAyudaConDato", "verHorariosOnboarding", "agendarSesionOnboarding")) {
      botones.push([{ text: "🚀 Cómo va mi onboarding", callback_data: "menu:onboarding" }]);
    }
    if (uso("enviarMiContrato", "reenviarContratoAlCorreo")) {
      botones.push([{ text: "📝 Mi contrato", callback_data: "contrato:estado" }]);
    }
    if (uso("verMisAccesos", "recuperarContrasena")) {
      botones.push([{ text: "🔑 Mis accesos y contraseñas", callback_data: "acceso:ver" }]);
    }
    if (uso("verFacturacionPendiente", "registrarFacturacion", "verMetricas")) {
      botones.push([{ text: "💵 Mi facturación del día", callback_data: "fact:ver" }]);
    }
    if (uso("verMisPagos", "generarLinkDePago")) {
      botones.push([{ text: "💳 Mis pagos", callback_data: "pago:ver" }]);
    }
    if (uso("verHorariosLibres", "agendarReunion")) {
      botones.push([{ text: "📅 Agendar una reunión", callback_data: "menu:agendar" }]);
    }
    if (uso("pasarMensajeAlEquipo")) {
      botones.push([{ text: "💬 Escribirle a mi equipo", callback_data: "menu:atencion" }]);
    }
    botones.push([{ text: "📋 Ver menú", callback_data: "menu:ver" }]);
    // Telegram amontona todo si son muchos: el menu completo esta a un toque.
    return botones.slice(-4);
  }

  private instrucciones(
    cliente: DatosCliente,
    perfil: PerfilCliente,
    pendientes: Awaited<ReturnType<typeof onboardingDatosService.pendientes>> | null
  ): string {
    const equipo = (Object.keys(EQUIPO_ATENCION) as TemaAtencion[])
      .map(
        (t) =>
          `- ${EQUIPO_ATENCION[t].etiqueta}: ${equipoAtencionService.nombres(t)} (${equipoAtencionService.correos(t).join(", ")})` +
          (t === "produccion"
            ? " (la producción se agenda en su calendario con agendarProduccion)"
            : EQUIPO_ATENCION[t].calendarioId
              ? " (se puede agendar reunión en su calendario)"
              : "")
      )
      .join("\n");

    return `Eres el asistente de Bakano, una agencia de marketing de Ecuador. Atiendes por Telegram a ${cliente.nombre}, del cliente "${cliente.entorno}".
Hoy es ${fechaEcuador(new Date())} (hora Ecuador).

En qué punto está este cliente: ${perfilClienteService.describir(perfil)}
${
  pendientes
    ? `Lo que le falta ahora mismo (dato real, no hace falta llamar verPendientesOnboarding salvo que registres algo):
- Sesiones sin agendar: ${pendientes.sesionesPendientes.map((x) => `${x.etiqueta} con ${x.con} (${x.sesion})`).join("; ") || "ninguna"}
- Datos de marca que faltan: ${pendientes.datosMarcaFaltantes.map((x) => `${x.campo} (${x.que})`).join("; ") || "ninguno"}
- Le falta cargar en la plataforma: ${
        pendientes.entregables
          .filter((x) => x.estado === "pendiente")
          .map((x) => `${x.clave} → ${x.etiqueta}: ${x.link || `se hace en Meta, invitando a ${x.invitarA}`}`)
          .join("; ") || "nada"
      }
- Su perfil de marca: ${pendientes.perfilDeMarca}
`
    : ""
}
Cómo hablas:
- Como una persona normal escribiendo por WhatsApp: amigable, cercana y relajada, pero sin exagerar. Tratas de tú.
- NUNCA uses signos de apertura: nada de "¡" ni de "¿". Escribe "hola!", "cómo estás?", "listo!", nunca "¡Hola!" ni "¿Cómo estás?".
- Saludos naturales: "holaaa", "hola, qué tal", "hey". Expresiones como "dale", "listo", "súper", "genial", "tranqui". No abuses de ellas.
- Nada de frases de call center ni formales: nunca "estimado", "es un placer atenderle", "quedo atento a sus comentarios", "no dude en contactarnos".
- Emojis con moderación, de 0 a 2 por mensaje, solo cuando sumen.
- Mensajes cortos, como un chat: máximo 4 o 5 líneas. Si tienes varias cosas que decir, ve al grano.
- Texto plano: sin markdown, sin asteriscos, sin almohadillas.
- No repitas el saludo en cada mensaje: saluda solo al empezar la conversación.
- Siempre nombras a las personas del equipo con nombre y apellido.

Quién atiende a este cliente:
${equipo}

Cómo se complementa el equipo (explícaselo cuando pregunte quién hace qué, o cuando ayude a que entienda el proceso):
${equipoParaLaIa()}
- A Luis Reyes NO se lo contacta ni se ofrece su contacto, aunque sea dueño.
- Con Diego Reyes el cliente puede hablar sin ningún problema. Si INSISTE en hablar con alguien de dirección (lo pide dos veces, dice que quiere hablar con un dueño o con el jefe, o está muy molesto y no le basta el equipo), dale su WhatsApp: ${WHATSAPP_DIRECCION.numero}. Solo en ese caso; no lo ofrezcas de entrada.

Revisión y corrección de guiones:
- Cuando el cliente quiera revisar o corregir sus guiones, usa verGuionesParaRevisar y muéstrale la lista corta (número y tema). Si pide ver uno, usa verGuion y resúmelo en pocas líneas.
- Una corrección clara dice qué parte cambiar (gancho, cuerpo, CTA, un dato, el tono) y qué quiere en su lugar. Si te dice algo vago como "no me gusta", "cámbialo" o "mejóralo", pregúntale qué exactamente y cómo lo quiere antes de anotar nada. Nunca inventes la corrección por él.
- Apenas una corrección esté clara, anótala con anotarCorreccion usando sus palabras, con la categoría que mejor le quede, y confírmale en una línea. Pregunta si quiere corregir algún otro.
- Las correcciones se envían todas juntas y una sola vez. Antes de enviar usa verBorradorRevision, muéstrale el resumen y pregúntale qué hacemos con los guiones que no corrigió (normalmente se aprueban). Llama enviarRevisionGuiones solo cuando el cliente confirme de forma explícita, y con aprobarResto en true solo si aceptó aprobar los demás.
- Si el plazo de correcciones ya cerró, explícale que ya no se pueden pedir cambios a los guiones y ofrece pasarle el mensaje a ${equipoAtencionService.nombres("guiones")}.
- Al enviar, confírmale que le llegó a ${equipoAtencionService.nombres("guiones")} y al equipo, y hasta cuándo se corrigen.

Onboarding (arranque del cliente):
- Son tres sesiones técnicas, en este orden: Conexión de cuentas Meta con Joel Jimenez, Configuración de CRM y Metrics con David Robles, y Estrategia y guiones con Ariana Vera. Después viene la primera producción.
- Tú no resuelves la configuración técnica por chat: cada tema se ve en su sesión. Tu trabajo es decirle en qué paso va, qué necesita tener listo y agendarle la sesión que le toca.
- Usa verOnboarding para saber el estado real, verHorariosOnboarding para ofrecer 3 o 4 horarios y agendarSesionOnboarding cuando elija uno.
- Si el cliente pregunta por algo que se ve en una sesión (conectar Instagram, pagos de Meta, el CRM, los guiones), explícale en una línea que eso se resuelve en esa sesión y ofrécele agendarla.
- Si prefiere agendar por su cuenta, pásale el link de esa sesión.
- Manda links (agendamiento, metrics.bakano.ec) solo cuando correspondan al paso en el que está el cliente, no todos de golpe.
- Para que todo funcione el cliente necesita un entorno creado en metrics.bakano.ec; si te dice que no puede entrar o no ve su información, recuérdaselo.

Arrancar el onboarding (tú tomas la iniciativa):
- Si el cliente es nuevo o está en onboarding, apenas termines de responder lo que preguntó, usa verPendientesOnboarding y sigue con lo que falta. No esperes a que él lo pida.
- Una cosa a la vez, en este orden: agendar la sesión que le toca, luego los datos de su marca que falten y luego los envíos (archivos de marca, facturación, catálogo, invitación a Meta).
- Dónde captura la venta (trafficDirection y trafficLink): es el dato que define a dónde mandamos a la gente que ve sus videos. Explícaselo así y pregúntale si quiere que le escriban por WhatsApp o que le agenden una cita (GHL / Agenda). Después pídele el número de WhatsApp con código de país o el link de su agenda, y guárdalo con registrarDatoMarca.
- Si te dice que no sabe, que no lo tiene o que no entiende: NO insistas. Usa pedirAyudaConDato y dile con tranquilidad que el equipo lo arma con él en esa sesión y que ya avisaste al responsable.
- Datos de marca: pregúntale de forma natural, uno por mensaje (por ejemplo "cuéntame, a quién le vendes?"). Cuando responda algo concreto, guárdalo con registrarDatoMarca usando sus palabras, y confírmale en pocas palabras que quedó en el sistema. Si responde algo vago, pídele un poco más de detalle antes de guardar.
- Todo lo que entrega va POR LA PLATAFORMA, nunca por correo: pásale el link de SU entorno (el de arriba, ya trae su id) y dile en una línea qué sube ahí. La única excepción es la invitación al portafolio de Meta, que se hace dentro de Meta Business.
- Puede mandarte los archivos por aquí mismo: dile que los adjunte con el clip 📎 y, si es el logo, que lo envíe como Archivo (no como foto) en PNG, porque Telegram comprime las fotos y el logo pierde el fondo transparente. Tú los guardas solo en su entorno.
- Los logos tienen que ser PNG con fondo transparente. Si te dice que los tiene en .ai, .psd o .jpg, pídele que los exporte a PNG antes de subirlos; la plataforma no acepta otro formato para el logo.
- Cuando te diga que ya lo subió, regístralo con registrarEntregable: así el responsable lo verifica. No lo marques si solo dice que lo va a hacer.
- Si el cliente está apurado o pregunta otra cosa, atiéndelo primero y retoma lo pendiente después, sin presionar.
- Si es un cliente en marcha, no le ofrezcas sesiones del onboarding ni le pidas envíos. Solo si faltan datos de su marca, pídele uno al final de la conversación y sin insistir.
- Si es alguien del equipo de Bakano, no le pidas datos: solo dile qué falta.

Publicidad (qué estamos anunciando):
- "qué están pautando", "qué anuncios tengo activos", "cuánto se ha gastado en Meta", "muéstrame los anuncios": usa verPublicidad y responde con los nombres, los links tal cual vienen y la inversión de los últimos 30 días.
- Pásale los links sin cambiarlos. Si un anuncio no trae link, no inventes uno ni prometas mandarlo después.
- Si la herramienta devuelve hayDatos en false, dile con naturalidad que ahora mismo no puedes ver la pauta, que ya avisaste a Denisse Quimi y que ella se comunica para resolverlo. Nunca inventes anuncios, montos ni fechas.
- Si "activosSinInversion" viene en true, díselo con naturalidad: los anuncios están encendidos pero no registran gasto en los últimos 30 días, y el equipo ya está revisándolo.
- No prometas resultados ni cambios de campaña: eso lo decide el equipo.

Preguntas de facturación (esto lo respondes siempre, nunca lo derives):
- "cuánto facturé/vendí", "cómo voy este mes", "cuánto llevo", "cuál es mi ROAS", "cómo cerré el mes", "llegué a la meta": usa verMetricas y contesta con los números, en plata y con una lectura corta.
- Si falta registrar días, dilo y ofrécele registrarlos ahí mismo por el chat.
- Si hay meta del mes, di en qué porcentaje va o quedó. Si no hay meta, no la inventes ni la menciones.
- Cuenta el resultado en positivo. Si el mes quedó por debajo de la meta, dilo de frente, sin dramatizar, y cierra con que este mes tomamos acción en eso.

Pagos a Bakano (su suscripción; no confundir con su facturación del día, que son sus ventas):
- Si pregunta cuánto debe, si está al día, por su factura, o cómo pagar a Bakano, usa verMisPagos y contéstale con el monto y el mes.
- Si quiere pagar, genera el link con generarLinkDePago (una factura por vez, la más antigua primero) y pásale el link tal cual. Se paga con tarjeta y queda registrado solo.
- Si prefiere transferencia, dile que puede subir el comprobante en metrics.bakano.ec, en su facturación, o pasarle el mensaje a su equipo.
- Habla de plata con naturalidad y respeto: facilitas el pago, no cobras. Nunca amenaces con pausar ni hables de la desactivación. Si reclama un cobro o dice que ya pagó, no discutas: pásale el mensaje al equipo.

Facturación del día:
- El cliente puede registrar su facturación por aquí: si te dice un monto ("ayer vendí 450", "hoy hice 1.250"), regístralo con registrarFacturacion y confírmale el total del día.
- Si no sabes de qué día habla, usa verFacturacionPendiente y pregúntale antes de registrar. Nunca inventes el monto ni el día.
- Registrar 0 es válido y se hace igual: así no queda hueco en el ROAS.
- Si ya había un monto de ese día, díselo y confirma antes de reemplazarlo.
- Si en los datos "metaConectado" viene en false, NO menciones Meta, ni gasto en pauta, ni ROAS: ese cliente todavía no tiene la cuenta conectada y hablar de eso lo confunde. Compara solo facturación.
- Después de registrar, CIERRA con una lectura corta de lo que significa ese número, usando solo el "contexto" que te devuelve la herramienta: compáralo con el promedio del mes, con el día anterior o con el mismo día de la semana pasada, y si hay gasto de Meta menciona el ROAS del día. Dos líneas, en plata y en porcentaje redondeado, sin inventar nada que no esté en esos datos.
- Si el día viene muy por debajo de su promedio, dilo sin dramatizar y ofrece pasarle el dato a su equipo. Si viene bien, díselo también: es la parte que le interesa.
- Si no hay con qué comparar todavía (primer día registrado del mes), no inventes tendencias: dile que a partir de ahora ya puedes comparar.

Métricas:
- Para facturación, gasto en Meta, ROAS o qué videos funcionan mejor, usa verMetricas. Da los números redondeados y en una o dos líneas.
- Si faltan días de facturación, dile que el ROAS está incompleto y que puede registrar la facturación diaria en metrics.bakano.ec.
- Si no hay datos, dile que todavía no hay información suficiente y que Denisse Quimi (dquimi@bakano.ec) le cuenta cómo van sus campañas.
- No interpretes de más ni prometas resultados.

Proceso completo de implementación (esto lo sabes de memoria):
${procesoOnboardingEnTexto()}

Producciones (grabaciones):
- Son sesiones en un ambiente controlado para grabar las tomas del avatar del cliente y de los productos que vamos a promocionar.
- QUÉ ES LA PRODUCCIÓN: es la grabación para crear su AVATAR y grabar sus PRODUCTOS. No es una grabación de videos sueltos ni una sesión de contenido mensual: con ese material armamos todos los videos del periodo. Dilo así siempre que pregunte.
- CADA CUÁNTO: una producción cada 6 MESES, contados desde la última. En la práctica, para la mayoría es una vez al año. Si ya tiene una agendada, no puede agendar otra.
- Puede volver a grabar antes de los 6 meses si la estrategia lo pide (productos nuevos, cambio de marca, se acabó el contenido). Eso lo habilita el equipo: si lo pide, díselo así y pásale el mensaje con pasarMensajeAlEquipo.
- Para agendar: usa verHorariosProduccion, ofrece 3 o 4 horarios y, cuando el cliente elija uno concreto, usa agendarProduccion con el valor "inicio" exacto. Confirma fecha, hora y que lo atienden ${equipoAtencionService.nombres("produccion")}.
- Si todavía no puede agendar, explica la regla con naturalidad y dile desde qué fecha puede.
- El cliente es UNO SOLO: nunca le agendes dos cosas a la misma hora, aunque sean con personas distintas del equipo. Los horarios que te devuelven las herramientas ya vienen filtrados; si aun así te sale "ya_tiene_esa_hora", dile qué cita tiene a esa hora y con quién, y ofrécele otro horario o mover la que ya tiene.
- Mover una producción no cambia la regla: la nueva fecha también tiene que respetar los 6 meses desde la última grabación.
BAKANOLOGY (la academia):
- Bakanology es la academia de Bakano: cursos de Estrategia Comercial, ADN de la Venta y Marketing y Ventas. Es donde aprende a vender, a hablarle a un cliente y a leer sus números.
- VA INCLUIDA en su suscripción: mientras siga con Bakano no paga nada aparte, sin costo adicional y sin fecha de corte. Dilo así si pregunta.
- Entra en bakanology.com con el MISMO correo de Metrics, pero con una contraseña distinta. Son dos plataformas: Metrics para sus números, guiones y archivos; Bakanology para aprender.

CONTRATO:
- Si pide ver, leer, revisar o que le mandes su contrato, usa enviarMiContrato: le llega el PDF aquí mismo. Puede pedirlo las veces que quiera. Si no lo firmó, es un borrador con sus datos; si ya lo firmó, es el firmado.
- Siempre dile que la copia firmada le llega también a su correo (el que dio para el contrato). Si ya firmó y quiere que se lo mandes de nuevo al correo, usa reenviarContratoAlCorreo.
- Lo que dice el contrato, por si pregunta: el servicio empieza al día siguiente de recibir el comprobante de pago. Se compromete a una inversión mensual en anuncios de mínimo $${PAUTA_MINIMA} sin impuestos (con menos no podemos asegurar cierres y los resultados tardan más), que crece a medida que crece su facturación; en octubre, noviembre y diciembre se recomiendan al menos $${PAUTA_TEMPORADA_ALTA}. Bakano cubre el CRM; los mensajes de WhatsApp del CRM los paga él directo a Meta. El primer mes es de exploración y lo recomendado es quedarse al menos dos meses. Si en los dos primeros meses no hay resultados, en el tercer y cuarto mes paga el 50% de los honorarios, siempre que haya mantenido su pauta y dado seguimiento a sus prospectos. Para suspender el servicio tiene que pedirlo por escrito por los canales oficiales de Bakano.
- No activas la garantía ni cambias condiciones: si la pide o quiere suspender, pásale el mensaje al equipo con pasarMensajeAlEquipo.

CONTRASEÑAS:
- Si dice que olvidó su contraseña o que no puede entrar, pregúntale de cuál de las dos y usa recuperarContrasena. Le llega el correo para crear una nueva.
- NUNCA le digas una contraseña por el chat, ni digas que se la puedes mandar: no las tenemos en claro y este chat puede quedar abierto en un celular prestado. Lo que sí puedes es mandarle el correo de recuperación al toque.
- Si solo pregunta con qué correo entra o dónde entra, usa verMisAccesos.

- GRABAMOS HASTA QUEDARNOS SIN CONTENIDO. La producción no se agenda "porque toca cada 6 meses": se agenda antes de quedarnos sin guiones por grabar. Usa verReservaDeContenido cuando se hable de producción, contenido o videos; si seAcaba viene en true, díselo claro y empújalo a cerrar fecha ya, que ahí la espera entre producciones no aplica.
- NO HAY PRODUCCIÓN SIN PLANIFICACIÓN. Dilo siempre que se hable de grabar: los guiones de lo que vamos a grabar tienen que estar escritos y aprobados por él ANTES de la grabación. Si su planificación está vacía, dile que ya avisaste a su equipo de contenido y a Genesis Benalcazar para que los preparen, y pásale el link de su planificación.
- Y para que lo que grabemos llegue a sus clientes hace falta el CRM: si todavía no hizo su sesión de Configuración de CRM y Metrics con David Robles, dile que la agende. Sin eso, los videos no tienen a dónde llevar a la gente.

Mover o cancelar citas (producción, sesiones del onboarding y reuniones):
- Usa verMisCitas para ver sus citas. Solo puedes tocar las que salen ahí.
- Mover y cancelar SIEMPRE funciona, aunque sea el mismo día: nunca le digas que no se puede.
- Dile claro que lo ideal es avisar con más de 2 días. Si la cita es en menos (sobreLaHora en true), adviérteselo con naturalidad: se la cambias igual, solo que le avisas a todo el equipo de esa cita para que reacomode su día.
- avisarCambioSobreLaHora es solo para cuando él NO quiere cambiarla todavía y prefiere que el equipo lo sepa y lo coordine con él (o cuando no hay horarios libres). No la uses para bloquearlo.
- Siempre que hables de una cita (la agendas, la mueves, la cancelas o avisas), pídele que revise su planificación en Metrics para que no se le cruce nada.
- Los avisos van a los encargados de esa cita. A dirección (Denisse Quimi y Diego Reyes) NO se les avisa por un cambio normal: solo pasa avisarDireccion en true si el cliente está muy molesto, amenaza con irse o es algo grave de verdad.
- Antes de cancelar, sugiere mover: casi siempre conviene más. Si igual quiere cancelar, pregúntale el motivo.
- Para mover: verHorariosParaMover, ofrece 3 o 4 horarios y, cuando elija uno, llama reprogramarCita. Eso NO la mueve todavía: repítele la cita, la fecha actual y la nueva y pídele que confirme (le aparecen botones).
- Para cancelar: cuando quede claro que quiere cancelar, llama cancelarCita. Eso NO la cancela todavía: repítele qué cita y qué fecha se cancela y pídele que confirme (le aparecen botones).
- Si en su siguiente mensaje te dice que sí, usa confirmarCambioCita. Si dice que no o cambia de idea, no hagas nada.
- Cuando el cambio se hace, el sistema ya le avisa al responsable: no uses pasarMensajeAlEquipo para eso.
- Después confírmale que ya quedó en el calendario y que le avisamos al responsable.
- Si agendarProduccion falla, discúlpate y ofrece pasarle el mensaje al equipo con el horario que quería.

Reglas:
- Nunca inventes datos. Para producciones, guiones, horarios o métricas usa siempre las herramientas.
- Si no hay dato o no sabes la respuesta, no inventes: dile que el encargado de ese tema se comunica con él en breve, y que si quiere agilizarlo puede escribirle directo a su correo (dale el correo del encargado). Y pásale el mensaje con pasarMensajeAlEquipo.
- Otros encargados por tema: Meta Ads y campañas → Denisse Quimi (dquimi@bakano.ec); CRM → David Robles (drobles@bakano.ec); metrics.bakano.ec y tecnología → Diego Reyes (dreyes@bakano.ec).
- Si el cliente quiere hablar con alguien o tiene algo que no puedes resolver, ofrécele dos caminos: agendar una reunión (guiones y atención tienen calendario de reuniones; producción se agenda con agendarProduccion) o pasarle su mensaje a la persona.
- Para agendar: consulta horarios libres, ofrece 3 o 4 opciones y agenda solo cuando el cliente elija un horario concreto. Usa exactamente el valor "inicio" que devuelve la herramienta.
- Antes de pasar un mensaje al equipo asegúrate de entender qué necesita. Después confírmale a quién se lo enviaste.
- Si el cliente está molesto, reconoce cómo se siente, discúlpate sin excusas y ofrece una solución concreta.
- Si está muy molesto o angustiado, dile que ya avisaste a su equipo y que te vas a encargar de que un asesor tome el caso, porque esto lo tiene que ver una persona. ${
    fueraDeHorario()
      ? "Ahora mismo estamos FUERA de horario de oficina (atendemos hasta las 5 de la tarde): díselo con calma, que igual ya avisaste a todos y que lo toman apenas arranque el día."
      : "Estamos en horario de oficina: dile que lo van a contactar lo antes posible."
  }
- No prometas descuentos, reembolsos, cambios de contrato ni fechas que el equipo no confirmó.
- Solo hablas de la cuenta de ${cliente.entorno}. Si pregunta algo ajeno a Bakano, redirígelo con buena onda.
- Si una herramienta falla, discúlpate y ofrece pasar el mensaje al equipo.
- Al confirmar una cita agendada, dile con quién es y el correo del responsable por si necesita escribirle.
- Nunca menciones, recomiendes ni ofrezcas contactar a Luis Reyes, ni agendar con él. No es un canal de atención. Si el cliente lo pide, dile con buena onda que su equipo es quien lo atiende y ofrece a la persona que corresponda.`;
  }

  private herramientas(chat: ITelegramChat, textoCliente: string, turno: { inicio: Date; propuesta: boolean }) {
    return {
      verProducciones: {
        description: "Próximas producciones (grabaciones) del cliente y la última realizada.",
        inputSchema: z.object({}),
        execute: async () => {
          const ahora = new Date();
          const [proximas, ultima] = await Promise.all([
            models.planning
              .find({ workspaceId: chat.workspaceId, date: { $gte: ahora }, title: { $not: /^CANCELADA/ }, cancelada: { $ne: true } })
              .sort({ date: 1 })
              .limit(3)
              .select("title date")
              .lean(),
            models.planning
              .findOne({ workspaceId: chat.workspaceId, date: { $lt: ahora }, title: { $not: /^CANCELADA/ }, cancelada: { $ne: true } })
              .sort({ date: -1 })
              .select("title date cumplida")
              .lean(),
          ]);
          return {
            atienden: equipoAtencionService.nombres("produccion"),
            proximas: proximas.map((p) => ({ fecha: fechaEcuador(p.date), titulo: p.title })),
            ultima: ultima ? { fecha: fechaEcuador(ultima.date), titulo: ultima.title, grabada: ultima.cumplida } : null,
          };
        },
      },

      verGuiones: {
        description:
          "Guiones de las planificaciones recientes: aprobación del cliente, grabación, edición, publicación y hasta cuándo puede pedir correcciones.",
        inputSchema: z.object({}),
        execute: async () => {
          const entradas = await models.planning
            .find({ workspaceId: chat.workspaceId, date: { $gte: new Date(Date.now() - 45 * 86_400_000) } })
            .sort({ date: 1 })
            .limit(3)
            .select("_id date")
            .lean();
          if (!entradas.length) return { planificaciones: [], nota: "No hay planificaciones recientes." };

          const planes = await models.videoPlanning
            .find({ planningEntryId: { $in: entradas.map((e) => e._id) } })
            .select("planningEntryId items listaParaCliente")
            .lean();
          const horas = horasDeCorreccion();
          return {
            atiende: equipoAtencionService.nombres("guiones"),
            planificaciones: entradas.map((e) => {
              const plan = planes.find((p) => String(p.planningEntryId) === String(e._id));
              const limite = new Date(e.date.getTime() - horas * 3_600_000);
              return {
                produccion: fechaEcuador(e.date),
                correccionesHasta: fechaEcuador(limite),
                puedePedirCorrecciones: limite.getTime() > Date.now(),
                listaParaRevisar: plan?.listaParaCliente ?? false,
                guiones: (plan?.items || []).map((i) => ({
                  numero: i.numero,
                  tema: i.tema,
                  aprobacionCliente: i.clienteAprobacion,
                  motivoRechazo: i.motivoRechazo,
                  grabacion: i.estadoProduccion,
                  edicion: i.edicion,
                  publicacion: i.estadoPublicacion,
                })),
              };
            }),
          };
        },
      },

      verHorariosLibres: {
        description: "Horarios libres de los próximos 7 días para reunirse con la persona de un tema.",
        inputSchema: z.object({ tema: z.enum(TEMAS) }),
        execute: async ({ tema }: { tema: TemaAtencion }) => {
          const horarios = await atencionClienteService.horariosLibres(tema);
          if (horarios === null) {
            return {
              agendable: false,
              nota:
                tema === "produccion"
                  ? "Para agendar la producción usa verHorariosProduccion y agendarProduccion."
                  : `Con ${equipoAtencionService.nombres(tema)} la reunión se coordina por mensaje: pregunta qué día y hora prefiere y usa pasarMensajeAlEquipo.`,
            };
          }
          // El cliente es uno solo: no se le ofrecen horas que ya tiene ocupadas.
          const libres = await citasClienteService.sinChoques(chat, horarios);
          return {
            agendable: true,
            con: equipoAtencionService.nombres(tema),
            horariosQuitadosPorSuAgenda: libres.quitados,
            horarios: libres.horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
          };
        },
      },

      verGuionesParaRevisar: {
        description:
          "Guiones que el cliente tiene por revisar (planificación lista y sin respuesta), con el plazo para pedir correcciones y lo que ya anotó en su borrador.",
        inputSchema: z.object({}),
        execute: async () => {
          const r = await revisionGuionesService.resumen(chat);
          if (!r) return { hayGuionesPorRevisar: false, nota: "No hay guiones esperando su revisión: o ya la envió o todavía no está lista." };
          const enBorrador = new Map(r.correcciones.map((c) => [c.numero, c.texto]));
          return {
            hayGuionesPorRevisar: true,
            produccion: r.plazo.produccion ?? null,
            puedePedirCorrecciones: !r.plazo.cerrado,
            correccionesHasta: r.plazo.hasta ?? null,
            guiones: r.revision.guiones.map((g) => ({
              numero: g.numero,
              tema: g.tema,
              estado: g.aprobacion,
              extracto: g.texto.slice(0, 220),
              correccionAnotada: enBorrador.get(g.numero) ?? null,
            })),
          };
        },
      },

      verGuion: {
        description: "Texto completo de un guion (gancho, cuerpo y CTA) para comentarlo con el cliente.",
        inputSchema: z.object({ numero: z.number().int() }),
        execute: async ({ numero }: { numero: number }) => {
          const r = await revisionGuionesService.pendiente(chat.workspaceId!);
          const g = r?.guiones.find((x) => x.numero === numero);
          return g ? { numero: g.numero, tema: g.tema, texto: g.texto || "Este guion todavía no tiene texto." } : { error: `No encontré el guion #${numero}.` };
        },
      },

      anotarCorreccion: {
        description:
          "Anota en el borrador una corrección CLARA para un guion: qué parte cambiar y qué quiere en su lugar. Rechaza correcciones vagas; si pasa, pregúntale al cliente el detalle.",
        inputSchema: z.object({
          numero: z.number().int().describe("Número del guion"),
          correccion: z.string().describe("La corrección con las palabras del cliente: qué cambiar y cómo lo quiere"),
          categoria: z.enum(CATEGORIAS_GUION).describe("gancho_debil, tono_incorrecto, estructura, informacion_incorrecta, ortografia u otro"),
        }),
        execute: async ({ numero, correccion, categoria }: { numero: number; correccion: string; categoria: string }) =>
          revisionGuionesService.anotar(chat, numero, correccion, categoria),
      },

      quitarCorreccion: {
        description: "Quita del borrador la corrección de un guion, si el cliente se arrepiente.",
        inputSchema: z.object({ numero: z.number().int() }),
        execute: async ({ numero }: { numero: number }) => revisionGuionesService.quitar(chat, numero),
      },

      verBorradorRevision: {
        description: "Resumen de lo que se enviaría: correcciones anotadas y guiones que quedarían sin corrección.",
        inputSchema: z.object({}),
        execute: async () => {
          const r = await revisionGuionesService.resumen(chat);
          if (!r) return { nota: "No hay guiones esperando su revisión." };
          return {
            correcciones: r.correcciones.map((c) => ({ guion: `#${c.numero} ${c.tema}`, correccion: c.texto, categoria: c.categoria })),
            sinCorreccion: r.sinCorreccion.map((g) => `#${g.numero} ${g.tema}`),
            puedePedirCorrecciones: !r.plazo.cerrado,
            correccionesHasta: r.plazo.hasta ?? null,
          };
        },
      },

      enviarRevisionGuiones: {
        description:
          "Envía la revisión completa al equipo (una sola vez). Solo tras confirmación explícita del cliente. aprobarResto=true aprueba los guiones que no corrigió; úsalo solo si el cliente lo aceptó.",
        inputSchema: z.object({ aprobarResto: z.boolean() }),
        execute: async ({ aprobarResto }: { aprobarResto: boolean }) => revisionGuionesService.enviar(chat, aprobarResto),
      },

      verOnboarding: {
        description:
          "Estado real del onboarding del cliente: qué sesiones técnicas ya agendó (Meta con Joel, CRM y Metrics con David, Estrategia con Ariana), cuál sigue, qué necesita tener listo y su link de agendamiento.",
        inputSchema: z.object({}),
        execute: async () => {
          const estado = await onboardingBotService.estado(chat.workspaceId!);
          return {
            sesiones: estado.sesiones.map((s) => ({
              sesion: s.sesion,
              etiqueta: s.etiqueta,
              responsable: s.responsable,
              agendada: s.agendada,
              // Ya pasó la fecha y nadie la cerró: no digas que "la tiene
              // agendada", porque en sus citas ya no aparece.
              yaPaso: s.pasada,
              estado: s.estado,
              fecha: s.fecha ? fechaEcuador(s.fecha) : null,
              queSeVe: s.resumen,
              temas: SESIONES_ONBOARDING[s.sesion].temas,
              requisitos: s.requisitos,
              link: s.link,
              correoResponsable: SESIONES_ONBOARDING[s.sesion].responsable.email,
            })),
            envios: PROCESO_ONBOARDING.envios,
            siguiente: estado.siguiente ?? null,
            completo: estado.completo,
            produccion: {
              agendada: estado.produccion.agendada ? fechaEcuador(estado.produccion.agendada) : null,
              puedeAgendar: estado.produccion.puedeAgendar,
            },
          };
        },
      },

      verHorariosOnboarding: {
        description: "Horarios libres (próximos 14 días) del responsable de una sesión del onboarding.",
        inputSchema: z.object({ sesion: z.enum(["meta", "crm", "estrategia"]) }),
        execute: async ({ sesion }: { sesion: SesionOnboarding }) => {
          const def = SESIONES_ONBOARDING[sesion];
          const crudos = await onboardingBotService.horarios(sesion);
          const libres = crudos?.length ? await citasClienteService.sinChoques(chat, crudos) : { horarios: [], quitados: 0 };
          return {
            con: def.responsable.nombre,
            etiqueta: def.etiqueta,
            link: def.link,
            horariosQuitadosPorSuAgenda: libres.quitados,
            horarios: !libres.horarios.length
              ? `No pude ver los horarios: pásale el link ${def.link}`
              : libres.horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
          };
        },
      },

      agendarSesionOnboarding: {
        description:
          "Agenda una sesión del onboarding en el calendario del responsable y le avisa. Úsala solo con un horario que el cliente eligió de verHorariosOnboarding.",
        inputSchema: z.object({
          sesion: z.enum(["meta", "crm", "estrategia"]),
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosOnboarding"),
        }),
        execute: async ({ sesion, inicio }: { sesion: SesionOnboarding; inicio: string }) => {
          const fecha = new Date(inicio);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "horario inválido" };
          const choque = await citasClienteService.puedeA(chat, fecha);
          if (!choque.ok)
            return {
              ok: false,
              motivo: "ya_tiene_esa_hora",
              yaTiene: choque.choca,
              siguiente: "Dile que a esa hora ya tiene esa cita con nosotros y que no puede estar en las dos. Ofrécele otro horario o mover la que ya tiene.",
            };
          const r = await onboardingBotService.agendar(chat, sesion, fecha);
          const def = SESIONES_ONBOARDING[sesion];
          return r.ok
            ? { ok: true, cuando: r.cuando, con: r.responsable, correo: def.responsable.email, llevarListo: def.requisitos }
            : { ok: false, motivo: r.motivo, link: def.link };
        },
      },

      verMisAccesos: {
        description:
          "Con qué correo entra el cliente a Metrics y a Bakanology, y los links de las dos. No devuelve contraseñas: no las tenemos en claro.",
        inputSchema: z.object({}),
        execute: async () => {
          const correo = await accesosClienteService.correoDe(chat);
          return { correo, ...accesosClienteService.enlaces() };
        },
      },

      recuperarContrasena: {
        description:
          "Le manda al cliente el correo para crear una contraseña nueva, de Metrics o de Bakanology. Úsala cuando diga que la olvidó o que no puede entrar. Nunca le digas una contraseña por el chat: no las tenemos en claro.",
        inputSchema: z.object({ plataforma: z.enum(["metrics", "bakanology"]) }),
        execute: async ({ plataforma }: { plataforma: "metrics" | "bakanology" }) => {
          const r = await accesosClienteService.recuperar(chat, plataforma);
          return r.ok
            ? {
                ok: true,
                correo: r.correo,
                siguiente: `Dile que le llegó a ${r.correo} el link para crear su contraseña nueva, que vence en una hora y que revise el spam si no lo ve.`,
              }
            : { ok: false, motivo: r.motivo };
        },
      },

      enviarMiContrato: {
        description:
          "Le manda al cliente su contrato en PDF por este chat: el borrador con sus datos si no lo firmó, o el firmado si ya lo firmó. Úsala cuando pida ver, leer o que le mandes su contrato.",
        inputSchema: z.object({}),
        execute: async () => {
          const r = await contratoChatService.enviarPdf(chat);
          if (!r.ok) return { ok: false, siguiente: "Dile que no pudiste generarlo ahora y que lo intente de nuevo en un momento." };
          return {
            ok: true,
            firmado: r.firmado,
            correo: r.correo || null,
            siguiente: r.firmado
              ? "Ya le llegó el PDF firmado aquí. Dile que esa misma copia está en su correo."
              : "Ya le llegó el borrador aquí. Dile que lo lea con calma y que, cuando lo firme, le llega la copia firmada a su correo.",
          };
        },
      },

      reenviarContratoAlCorreo: {
        description: "Le reenvía a su correo el contrato ya firmado. Solo si ya lo firmó y lo pide por correo.",
        inputSchema: z.object({}),
        execute: async () => contratoChatService.reenviarPorCorreo(chat),
      },

      verReservaDeContenido: {
        description:
          "Cuánto contenido le queda al cliente: guiones escritos por grabar, piezas en edición y listas para publicar, y si ya tiene producción agendada.",
        inputSchema: z.object({}),
        execute: async () => {
          const r = await contenidoClienteService.reserva(chat.workspaceId!);
          const seAcaba = contenidoClienteService.seAcaba(r);
          return {
            guionesPorGrabar: r.porGrabar,
            enEdicion: r.enEdicion,
            listosParaPublicar: r.listosParaPublicar,
            nivel: r.nivel,
            proximaProduccion: r.proximaProduccion ? fechaEcuador(r.proximaProduccion) : null,
            seAcaba,
            siguiente: seAcaba
              ? "Dile que se está acabando su contenido y que cierren fecha de producción ya, sin esperar. Ofrécele horarios."
              : "Cuéntaselo con naturalidad si viene al caso.",
          };
        },
      },

      verHorariosProduccion: {
        description:
          "Dice si el cliente puede agendar su producción (una cada 6 meses desde la última, para crear su avatar y grabar sus productos; con una ya agendada no puede otra) y los horarios libres de Karen Muñoz y Jean Ortega desde la fecha permitida.",
        inputSchema: z.object({}),
        execute: async () => {
          const { estado, horarios: crudos } = await atencionClienteService.horariosProduccion(chat.workspaceId!);
          const libres = crudos?.length
            ? (await citasClienteService.sinChoques(chat, crudos, { duracionMs: 3 * 3_600_000 })).horarios
            : crudos;
          const horarios = libres;
          return {
            puedeAgendar: estado.puedeAgendar,
            yaTieneAgendada: estado.proxima ? fechaEcuador(estado.proxima) : null,
            ultimaProduccion: estado.ultima ? fechaEcuador(estado.ultima) : null,
            disponibleDesde: estado.habilitadaDesde ? fechaEcuador(estado.habilitadaDesde) : null,
            esperaPorReglaDe2Meses: estado.esperar ?? false,
            horarios:
              horarios === null
                ? "El calendario no está disponible: ofrece pasarle el mensaje al equipo."
                : horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
          };
        },
      },

      agendarProduccion: {
        description:
          "Agenda la producción en el calendario de Karen Muñoz y Jean Ortega y les avisa. Úsala solo con un horario que el cliente eligió de verHorariosProduccion. El sistema vuelve a validar la regla de 6 meses.",
        inputSchema: z.object({
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosProduccion"),
        }),
        execute: async ({ inicio }: { inicio: string }) => {
          const fecha = new Date(inicio);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "horario inválido" };
          const choque = await citasClienteService.puedeA(chat, fecha, { duracionMs: 3 * 3_600_000 });
          if (!choque.ok)
            return {
              ok: false,
              motivo: "ya_tiene_esa_hora",
              yaTiene: choque.choca,
              siguiente: "Dile que a esa hora ya tiene esa cita con nosotros y que no puede estar en las dos. Ofrécele otro horario o mover la que ya tiene.",
            };
          const r = await atencionClienteService.reservarProduccion(chat, fecha);
          return r.ok
            ? {
                ok: true,
                cuando: r.cuando,
                con: equipoAtencionService.nombres("produccion"),
                correos: equipoAtencionService.correos("produccion"),
                guionesEnSuPlanificacion: r.planificacion?.guiones ?? 0,
                siguiente:
                  (r.planificacion?.guiones
                    ? "Dile cuántos guiones tiene ya en su planificación y que los revise antes de grabar."
                    : "Dile claro que toda producción necesita su planificación con guiones antes de grabar, y que ya avisaste a su equipo de contenido y a Genesis para que los preparen.") +
                  " Y recuérdale agendar su sesión de CRM con David Robles si todavía no la tiene.",
              }
            : { ok: false, motivo: r.motivo };
        },
      },

      agendarReunion: {
        description:
          "Agenda la reunión en el calendario del CRM y avisa por correo a la persona. Úsala solo con un horario que el cliente eligió de verHorariosLibres.",
        inputSchema: z.object({
          tema: z.enum(["guiones", "atencion"]),
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosLibres"),
        }),
        execute: async ({ tema, inicio }: { tema: "guiones" | "atencion"; inicio: string }) => {
          const fecha = new Date(inicio);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "horario inválido" };
          const choque = await citasClienteService.puedeA(chat, fecha);
          if (!choque.ok)
            return {
              ok: false,
              motivo: "ya_tiene_esa_hora",
              yaTiene: choque.choca,
              siguiente: "Dile que a esa hora ya tiene esa cita con nosotros y que no puede estar en las dos. Ofrécele otro horario o mover la que ya tiene.",
            };
          const r = await atencionClienteService.reservarReunion(chat, tema, fecha);
          return r.ok
            ? { ok: true, cuando: r.cuando, con: equipoAtencionService.nombres(tema), correos: equipoAtencionService.correos(tema) }
            : { ok: false, motivo: r.motivo };
        },
      },

      verMisCitas: {
        description:
          "Citas futuras del cliente (producción, sesiones del onboarding y reuniones), con su ref, con quién y si es sobre la hora (menos de 2 días: se cambia igual, avisando a todo el equipo).",
        inputSchema: z.object({}),
        execute: async () => {
          const citas = await citasClienteService.listar(chat);
          if (!citas.length) return { citas: [], nota: "No tiene citas futuras que se puedan gestionar desde aquí." };
          return {
            citas: citas.map((c) => ({
              ref: c.ref,
              cita: c.etiqueta,
              cuando: fechaEcuador(c.inicio),
              con: c.con,
              correos: c.correos,
              sePuedeCambiar: citasClienteService.editable(c),
              sobreLaHora: citasClienteService.esUrgente(c),
            })),
          };
        },
      },

      verHorariosParaMover: {
        description:
          "Horarios libres para mover una cita (ref de verMisCitas). En producción respeta la regla de 6 meses desde la última grabación.",
        inputSchema: z.object({ ref: z.string().describe("ref exacta de verMisCitas") }),
        execute: async ({ ref }: { ref: string }) => {
          const r = await citasClienteService.horariosParaMover(chat, ref);
          if (!r.cita) return { ok: false, motivo: "No encontré esa cita. Usa verMisCitas." };
          return {
            ok: true,
            cita: r.cita.etiqueta,
            actual: fechaEcuador(r.cita.inicio),
            con: r.cita.con,
            horarios: r.horarios.length
              ? r.horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) }))
              : "No hay horarios libres en los próximos 30 días: ofrece pasarle el mensaje al responsable.",
          };
        },
      },

      reprogramarCita: {
        description:
          "Propone mover una cita a un horario de verHorariosParaMover. NO la mueve: deja el cambio listo y al cliente le aparecen botones para confirmarlo. Muéstrale el resumen y pídele que confirme.",
        inputSchema: z.object({
          ref: z.string().describe("ref exacta de verMisCitas"),
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosParaMover"),
        }),
        execute: async ({ ref, inicio }: { ref: string; inicio: string }) => {
          const r = await citasClienteService.proponer(chat, { accion: "reprogramar", ref, inicio });
          if (r.ok && "resumen" in r) turno.propuesta = true;
          return r.ok ? { ...r, siguiente: "Pídele que confirme con el botón o respondiéndote que sí." } : r;
        },
      },

      cancelarCita: {
        description:
          "Propone cancelar una cita. NO la cancela: deja el cambio listo y al cliente le aparecen botones para confirmarlo. Muéstrale el resumen y pídele que confirme.",
        inputSchema: z.object({
          ref: z.string().describe("ref exacta de verMisCitas"),
          motivo: z.string().nullish().describe("Por qué cancela, con sus palabras"),
          avisarDireccion: z
            .boolean()
            .nullish()
            .describe("true SOLO si es grave (cliente muy molesto o en riesgo de irse): avisa también a Denisse y Diego"),
        }),
        execute: async ({ ref, motivo, avisarDireccion }: { ref: string; motivo?: string | null; avisarDireccion?: boolean | null }) => {
          const r = await citasClienteService.proponer(chat, {
            accion: "cancelar",
            ref,
            motivo: motivo ?? undefined,
            avisarDireccion: avisarDireccion === true,
          });
          if (r.ok && "resumen" in r) turno.propuesta = true;
          return r.ok ? { ...r, siguiente: "Pídele que confirme con el botón o respondiéndote que sí." } : r;
        },
      },

      avisarCambioSobreLaHora: {
        description:
          "Avisa a TODOS los encargados de una cita que el cliente necesita moverla o cancelarla, para que lo coordinen con él. No toca el calendario: úsala solo si él no quiere elegir horario ahora o no hay horarios libres.",
        inputSchema: z.object({
          ref: z.string().describe("ref exacta de verMisCitas"),
          accion: z.enum(["mover", "cancelar"]),
          motivo: z.string().nullish().describe("Por qué lo necesita, con sus palabras"),
          avisarDireccion: z
            .boolean()
            .nullish()
            .describe("true SOLO si es grave (cliente muy molesto o en riesgo de irse): avisa también a Denisse y Diego"),
        }),
        execute: async ({ ref, accion, motivo, avisarDireccion }: { ref: string; accion: "mover" | "cancelar"; motivo?: string | null; avisarDireccion?: boolean | null }) => {
          const r = await citasClienteService.solicitarCambio(chat, ref, accion, motivo ?? undefined, avisarDireccion === true);
          return r.ok
            ? { ...r, siguiente: "Dile que ya avisaste a todo el equipo de esa cita, que lo coordinan hoy con él, y recuérdale la regla de los 2 días y que revise su planificación." }
            : r;
        },
      },

      pedirAyudaConDato: {
        description: `El cliente no sabe o no tiene un dato del perfil de marca. Lo deja pendiente y avisa al responsable para que lo resuelva con él. Campos: ${Object.keys(
          AYUDA_CAMPO_MARCA
        ).join(", ")}.`,
        inputSchema: z.object({
          campo: z.enum(Object.keys(AYUDA_CAMPO_MARCA) as [string, ...string[]]),
          nota: z.string().nullish().describe("Lo que contó el cliente, con sus palabras"),
        }),
        execute: async ({ campo, nota }: { campo: string; nota?: string | null }) =>
          onboardingDatosService.pedirAyudaConDato(chat, campo, nota ?? undefined),
      },

      confirmarCambioCita: {
        description:
          "Ejecuta el cambio de cita que ya propusiste en un mensaje anterior, cuando el cliente responde que sí lo confirma. No sirve en el mismo mensaje en que lo propusiste.",
        inputSchema: z.object({}),
        execute: async () => citasClienteService.confirmar(chat, { antesDe: turno.inicio }),
      },

      verPendientesOnboarding: {
        description:
          "Lo que le falta al cliente para arrancar: sesiones sin agendar, datos de su marca que no tenemos, envíos pendientes (archivos, facturación, catálogo, invitación a Meta) y si ya conectó Meta.",
        inputSchema: z.object({}),
        execute: async () => {
          const [pendientes, perfil] = await Promise.all([
            onboardingDatosService.pendientes(chat.workspaceId!),
            perfilClienteService.de(chat.workspaceId!, chat.userId),
          ]);
          // Un cliente en marcha ya paso el arranque (muchos antes de que
          // existieran las sesiones): solo se completan datos de su marca.
          if (perfil.tipo === "activo") {
            return { clienteEnMarcha: true, datosMarcaFaltantes: pendientes.datosMarcaFaltantes, datosMarcaCompletos: pendientes.datosMarcaCompletos };
          }
          return pendientes;
        },
      },

      registrarDatoMarca: {
        description: `Guarda en el perfil de marca un dato que el cliente contó. Campos: ${Object.entries(CAMPOS_MARCA)
          .map(([k, v]) => `${k} (${v})`)
          .join(", ")}.`,
        inputSchema: z.object({
          campo: z.enum(Object.keys(CAMPOS_MARCA) as [string, ...string[]]),
          valor: z.string().describe("Lo que dijo el cliente, con sus palabras, completo"),
          reemplazar: z.boolean().nullish().describe("true solo si el cliente pidió cambiar un dato que ya estaba"),
        }),
        execute: async ({ campo, valor, reemplazar }: { campo: string; valor: string; reemplazar?: boolean | null }) =>
          onboardingDatosService.registrarDatoMarca(chat, campo, valor, reemplazar ?? false),
      },

      registrarEntregable: {
        description: `Registra que el cliente YA envió algo del onboarding y avisa al responsable para verificarlo. Claves: ${Object.entries(ENTREGABLES)
          .map(([k, v]) => `${k} (${v.etiqueta}, a ${v.a})`)
          .join(", ")}.`,
        inputSchema: z.object({
          clave: z.enum(Object.keys(ENTREGABLES) as [string, ...string[]]),
          nota: z.string().nullish().describe("Detalle que dio el cliente (qué mandó, desde qué correo)"),
        }),
        execute: async ({ clave, nota }: { clave: string; nota?: string | null }) => onboardingDatosService.registrarEntregable(chat, clave, nota ?? undefined),
      },

      verFacturacionPendiente: {
        description:
          "Días que al cliente le faltan por registrar su facturación (y si ya registró hoy). Úsala antes de pedirle el monto.",
        inputSchema: z.object({}),
        execute: async () => {
          const dias = await facturacionChatService.diasPendientes(chat);
          return {
            dias: dias.map((d) => ({ dia: claveDia(d.fecha), texto: d.texto, registrado: d.registrado })),
            nota: "Para registrar usa registrarFacturacion con el valor exacto de 'dia' (YYYY-MM-DD).",
          };
        },
      },

      registrarFacturacion: {
        description:
          "Registra en metrics.bakano.ec cuánto facturó el cliente un día. Si ya había registrado ese día, lo corrige. Úsala cuando el cliente te diga un monto claro.",
        inputSchema: z.object({
          monto: z.number().describe("Monto en dólares, solo el número"),
          dia: z.string().describe("Día en formato YYYY-MM-DD, tomado de verFacturacionPendiente"),
        }),
        execute: async ({ monto, dia }: { monto: number; dia: string }) => {
          const fecha = new Date(`${dia}T05:00:00.000Z`);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "día inválido, usa YYYY-MM-DD" };
          const r = await facturacionChatService.registrar(chat, monto, fecha);
          return r.ok
            ? {
                ok: true,
                accion: r.accion,
                monto: r.monto,
                dia: r.diaTexto,
                montoRegistrado: comoPlata(r.monto),
                contexto: contextoParaLaIa(r.contexto),
                siguiente: "Confirma lo registrado y cierra con una lectura corta del número usando el contexto.",
              }
            : r;
        },
      },

      verMisPagos: {
        description:
          "Lo que el cliente le debe a Bakano por su suscripción: saldo pendiente, facturas abiertas (mes, monto, si está vencida) y si puede pagar con tarjeta. Úsala cuando pregunte por pagos, su factura con Bakano o si está al día.",
        inputSchema: z.object({}),
        execute: async () => pagosClienteService.paraLaIa(String(chat.workspaceId)),
      },

      generarLinkDePago: {
        description:
          "Genera el link de pago con tarjeta (Stripe) de UNA factura abierta, tomada de verMisPagos. Cobra solo lo que falta de esa factura. Úsala cuando el cliente quiera pagar.",
        inputSchema: z.object({
          invoiceId: z.string().describe("invoiceId exacto de verMisPagos"),
        }),
        execute: async ({ invoiceId }: { invoiceId: string }) => {
          const estado = await pagosClienteService.estado(String(chat.workspaceId), true);
          const factura = estado.facturas.find((f) => f.id === invoiceId);
          if (!factura) return { ok: false, motivo: "Esa factura ya no tiene saldo o no existe; vuelve a consultar verMisPagos." };
          try {
            const url = await pagosClienteService.link(String(chat.workspaceId), invoiceId);
            return { ok: true, url, mes: factura.texto, monto: `$${factura.saldo.toFixed(2)}`, siguiente: "Pásale el link tal cual y dile que al terminar queda registrado solo." };
          } catch {
            return { ok: false, motivo: "No se pudo generar el link ahora; ofrécele pasarle el mensaje al equipo." };
          }
        },
      },

      verPublicidad: {
        description:
          "Qué le estamos anunciando AHORA en Meta: anuncios activos, su link para verlos y cuánto se invirtió en los últimos 30 días. Úsala siempre que pregunte por la pauta, los anuncios o la inversión.",
        inputSchema: z.object({}),
        execute: async () => publicidadClienteService.paraElCliente(chat.workspaceId!),
      },

      verMetricas: {
        description:
          "Métricas del entorno: facturación, gasto en Meta y ROAS del mes actual y del anterior, días sin registrar, meta del mes si existe, y los videos con más vistas.",
        inputSchema: z.object({}),
        execute: async () => {
          const [resumen, cerrado] = await Promise.all([
            metricasClienteService.resumen(chat.workspaceId!),
            metricasClienteService.mesCerrado(chat.workspaceId!).catch(() => null),
          ]);
          return { ...resumen, mesCerrado: cerrado };
        },
      },

      pasarMensajeAlEquipo: {
        description: "Envía por correo y notificación el pedido del cliente a la persona que atiende el tema.",
        inputSchema: z.object({
          tema: z.enum(TEMAS),
          resumen: z.string().describe("Qué necesita el cliente, con los detalles: días, horarios, número de guion"),
        }),
        execute: async ({ tema, resumen }: { tema: TemaAtencion; resumen: string }) => {
          const ok = await atencionClienteService.enviarMensaje(
            chat,
            tema,
            `${resumen}\n\nÚltimo mensaje del cliente: “${textoCliente.slice(0, 1000)}”`
          );
          return ok ? { ok: true, enviadoA: equipoAtencionService.nombres(tema) } : { ok: false };
        },
      },
    };
  }

  /**
   * Cierre en lenguaje natural para algo que ya pasó (por ejemplo, una
   * facturación registrada con los botones). No usa herramientas: recibe los
   * datos ya calculados y solo los interpreta, así el cliente recibe una
   * lectura y no una plantilla.
   */
  async comentar(chat: ITelegramChat, instruccion: string, datos: unknown): Promise<string | null> {
    try {
      const { generateText } = await cargarAi();
      const cliente = await atencionClienteService.datosCliente(chat);
      const { text } = await generateText({
        model: modelo(),
        system:
          `Eres el asistente de Bakano hablando por Telegram con ${cliente.nombre}, del cliente "${cliente.entorno}".\n` +
          "Escribes como una persona por WhatsApp: cercano, claro y corto (máximo 4 líneas). " +
          "NUNCA uses signos de apertura (¡ ¿). Sin markdown. Emojis con moderación (0 a 2).\n" +
          "Usa SOLO los datos que te paso: no inventes cifras, tendencias ni promesas. " +
          "Si un dato viene en null, es que no existe todavía y no se menciona. " +
          "Escribe en español correcto, con tildes.",
        prompt: `${instruccion}\n\nDatos:\n${JSON.stringify(datos)}`,
        abortSignal: AbortSignal.timeout(LIMITE_COMENTARIO_MS),
        ...opcionesModelo(),
      });
      const limpio = text.replace(/\*\*?|__|#+ /g, "").replace(/[¡¿]/g, "").trim();
      return limpio || null;
    } catch (error: any) {
      console.error("[Telegram IA] comentario:", error?.message || error);
      return null;
    }
  }

  private async clasificar(historial: Mensaje[], texto: string): Promise<Clasificacion | null> {
    const { generateText } = await cargarAi();
    const contexto = historial
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`)
      .join("\n");
    const { text } = await generateText({
      model: modelo(),
      system: `Clasificas el ánimo de un cliente de una agencia de marketing según su último mensaje y el contexto. Responde SOLO un JSON válido, sin texto extra:
{"estado":"en_peligro|angustiado|molesto|feliz|neutral","tema":"produccion|guiones|atencion","motivo":"...","frase":"frase exacta del cliente que lo muestra","recomendacion":"acción concreta para el equipo"}
tema: produccion si habla de grabaciones o fechas de producción; guiones si habla de guiones, contenido o videos; atencion para pagos, resultados, contrato o cualquier otra cosa.
en_peligro: quiere cancelar o pausar el SERVICIO con la agencia (no una cita, sesión o grabación puntual), no ve resultados, siente que pierde dinero, compara con otra agencia, amenaza con irse.
angustiado: se le nota angustia, ansiedad o miedo: algo urgente que no sale, presión fuerte (una fecha encima, plata comprometida, su jefe o su familia encima), insiste varias veces, pide ayuda con desesperación, escribe en mayúsculas o repite el mismo pedido. No amenaza con irse, pero está pasándola mal y necesita que alguien lo atienda YA.
molesto: queja, frustración, reclamo por demoras o errores, tono duro.
feliz: satisfacción clara, agradecimiento entusiasta, buenos resultados.
neutral: todo lo demás. Ante la duda, neutral.`,
      prompt: `${contexto ? `Contexto:\n${contexto}\n\n` : ""}Último mensaje del cliente: ${texto}`,
      abortSignal: AbortSignal.timeout(LIMITE_CLASIFICACION_MS),
      ...opcionesModelo(),
    });
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const r = clasificacionSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  }

  /** Molesto o en peligro → aviso a quien atiende (project manager). Una vez al dia, salvo que empeore. */
  private async alertarSiHaceFalta(chat: ITelegramChat, cliente: DatosCliente, c: Clasificacion, texto: string): Promise<void> {
    try {
      await models.telegramChats.updateOne({ _id: chat._id }, { $set: { ultimoAnimo: { estado: c.estado, motivo: c.motivo, en: new Date() } } });
      if (c.estado !== "en_peligro" && c.estado !== "angustiado" && c.estado !== "molesto") return;

      // Un cliente angustiado o a punto de irse no espera un día: si antes
      // solo estaba molesto, el aviso vuelve a salir aunque sea el mismo día.
      const GRAVEDAD: Record<string, number> = { molesto: 1, angustiado: 2, en_peligro: 3 };
      const previa = chat.ultimaAlerta;
      const empeoro = GRAVEDAD[c.estado]! > (GRAVEDAD[previa?.estado ?? ""] ?? 0);
      if (previa?.en && Date.now() - new Date(previa.en).getTime() < ALERTA_CADA_MS && !empeoro) return;

      const urgente = c.estado === "en_peligro" || c.estado === "angustiado";
      const titulo =
        c.estado === "en_peligro"
          ? `🔴 URGENTE · ${cliente.entorno} podría irse`
          : c.estado === "angustiado"
            ? `🔴 URGENTE · ${cliente.entorno} está angustiado y necesita que lo atiendan`
            : `🟠 ${cliente.entorno} está molesto`;
      const frase = c.frase || texto.slice(0, 300);
      const tema = c.tema;
      // Queda en Metrics como incidente del cliente: el equipo entero lo ve,
      // sabe qué se recomienda y quién lo tomó. El correo ya no es el registro.
      const incidenteId = await incidentesService.abrir({
        workspaceId: chat.workspaceId!,
        workspaceName: cliente.entorno,
        gravedad: c.estado as "molesto" | "angustiado" | "en_peligro",
        tema,
        cliente: { nombre: cliente.nombre, email: cliente.email, telegram: chat.telegramUsername, chatId: chat.chatId },
        frase,
        motivo: c.motivo,
        recomendacion: c.recomendacion,
        mensajeCompleto: texto,
      });
      const mensaje = [
        `${
          c.estado === "en_peligro"
            ? "🔴 Cliente en peligro"
            : c.estado === "angustiado"
              ? "🔴 Cliente angustiado: lo detecté yo en la conversación de Telegram y se lo estoy avisando a todo el equipo"
              : "🟠 Cliente molesto"
        } (detectado por la IA en Telegram)`,
        `Tema: ${EQUIPO_ATENCION[tema].etiqueta} · responsable: ${equipoAtencionService.nombres(tema)}`,
        "",
        `Frase: “${frase}”`,
        `Motivo: ${c.motivo}`,
        `Recomendación: ${c.recomendacion}`,
        "",
        `Mensaje completo: “${texto.slice(0, 1000)}”`,
        "",
        incidenteId ? `Tómalo en Metrics: ${incidentesService.link(incidenteId)}` : "",
      ]
        .filter(Boolean)
        .join("\n");

      // Molesto va al responsable del tema y a los superadmins. Angustiado o
      // en peligro va a TODO el equipo interno: correo y notificación en
      // Metrics, para que alguien lo agarre ya. Los contactos bloqueados los
      // filtra cada canal.
      const [responsables, equipo] = await Promise.all([
        equipoAtencionService.usuarios(tema),
        models.users
          .find({ isActive: true, ...(urgente ? { $or: [{ isInternal: true }, { role: "superadmin" }] } : { role: "superadmin" }) })
          .select("_id email")
          .lean(),
      ]);
      const correos = [...new Set([...equipoAtencionService.correos(tema), ...equipo.map((u) => u.email).filter(Boolean)])];
      const ids = [...new Map([...responsables, ...equipo].map((u) => [String(u._id), u._id])).values()];
      await Promise.allSettled([
        ...ids.map((id) =>
          notificationService.create(id as any, "cliente_en_riesgo", titulo, `${cliente.nombre}: “${frase.slice(0, 240)}” · ${c.recomendacion}`, {
            workspaceId: chat.workspaceId!,
          })
        ),
        resendService.sendSolicitudClienteEmail({
          to: correos,
          tema: c.estado === "angustiado" ? "cliente angustiado" : urgente ? "cliente en peligro" : "cliente molesto",
          workspaceName: cliente.entorno,
          clienteNombre: cliente.nombre,
          clienteEmail: cliente.email,
          telegramUsername: chat.telegramUsername,
          mensaje,
          asunto: `${titulo} (Telegram)`,
          encabezado: titulo,
        }),
        slackService.avisarEquipo({ titulo, detalle: mensaje, correos }),
      ]);
      await models.telegramChats.updateOne({ _id: chat._id }, { $set: { ultimaAlerta: { estado: c.estado, en: new Date() } } });
    } catch (error: any) {
      console.error("[Telegram IA] alerta:", error?.message || error);
    }
  }
}

export const telegramAgentService = new TelegramAgentService();
