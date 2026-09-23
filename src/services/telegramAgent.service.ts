import { z } from "zod";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { atencionClienteService, fechaEcuador, type DatosCliente } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { citasClienteService } from "./citasCliente.service";
import { CAMPOS_MARCA, ENTREGABLES, onboardingDatosService } from "./onboardingDatos.service";
import { metricasClienteService } from "./metricasCliente.service";
import { claveDia, facturacionChatService, nombreDia } from "./facturacionChat.service";
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

const clasificacionSchema = z.object({
  estado: z.enum(["en_peligro", "molesto", "feliz", "neutral"]),
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
    const turno = { inicio: new Date(), propuesta: false };
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
        tools: this.herramientas(chat, texto, turno),
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
          : [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]]
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
    const c = await clasificacion;
    if (c) {
      cliente ??= await atencionClienteService.datosCliente(chat).catch(() => null);
      if (cliente) await this.alertarSiHaceFalta(chat, cliente, c, texto);
    }
    return Boolean(respuesta);
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
- Datos de marca: pregúntale de forma natural, uno por mensaje (por ejemplo "cuéntame, a quién le vendes?"). Cuando responda algo concreto, guárdalo con registrarDatoMarca usando sus palabras, y confírmale en pocas palabras que quedó en el sistema. Si responde algo vago, pídele un poco más de detalle antes de guardar.
- Todo lo que entrega va POR LA PLATAFORMA, nunca por correo: pásale el link de SU entorno (el de arriba, ya trae su id) y dile en una línea qué sube ahí. La única excepción es la invitación al portafolio de Meta, que se hace dentro de Meta Business.
- Puede mandarte los archivos por aquí mismo: dile que los adjunte con el clip 📎 y, si es el logo, que lo envíe como Archivo (no como foto) en PNG, porque Telegram comprime las fotos y el logo pierde el fondo transparente. Tú los guardas solo en su entorno.
- Los logos tienen que ser PNG con fondo transparente. Si te dice que los tiene en .ai, .psd o .jpg, pídele que los exporte a PNG antes de subirlos; la plataforma no acepta otro formato para el logo.
- Cuando te diga que ya lo subió, regístralo con registrarEntregable: así el responsable lo verifica. No lo marques si solo dice que lo va a hacer.
- Si el cliente está apurado o pregunta otra cosa, atiéndelo primero y retoma lo pendiente después, sin presionar.
- Si es un cliente en marcha, no le ofrezcas sesiones del onboarding ni le pidas envíos. Solo si faltan datos de su marca, pídele uno al final de la conversación y sin insistir.
- Si es alguien del equipo de Bakano, no le pidas datos: solo dile qué falta.

Facturación del día:
- El cliente puede registrar su facturación por aquí: si te dice un monto ("ayer vendí 450", "hoy hice 1.250"), regístralo con registrarFacturacion y confírmale el total del día.
- Si no sabes de qué día habla, usa verFacturacionPendiente y pregúntale antes de registrar. Nunca inventes el monto ni el día.
- Registrar 0 es válido y se hace igual: así no queda hueco en el ROAS.
- Si ya había un monto de ese día, díselo y confirma antes de reemplazarlo.

Métricas:
- Para facturación, gasto en Meta, ROAS o qué videos funcionan mejor, usa verMetricas. Da los números redondeados y en una o dos líneas.
- Si faltan días de facturación, dile que el ROAS está incompleto y que puede registrar la facturación diaria en metrics.bakano.ec.
- Si no hay datos, dile que todavía no hay información suficiente y que Denisse Quimi (dquimi@bakano.ec) le cuenta cómo van sus campañas.
- No interpretes de más ni prometas resultados.

Proceso completo de implementación (esto lo sabes de memoria):
${procesoOnboardingEnTexto()}

Producciones (grabaciones):
- Son sesiones en un ambiente controlado para grabar las tomas del avatar del cliente y de los productos que vamos a promocionar.
- Cada cliente puede agendar una producción cada 2 meses, contados desde la última. Si ya tiene una agendada, no puede agendar otra.
- Para agendar: usa verHorariosProduccion, ofrece 3 o 4 horarios y, cuando el cliente elija uno concreto, usa agendarProduccion con el valor "inicio" exacto. Confirma fecha, hora y que lo atienden ${equipoAtencionService.nombres("produccion")}.
- Si todavía no puede agendar, explica la regla con naturalidad y dile desde qué fecha puede.
- Mover una producción no cambia la regla: la nueva fecha también tiene que respetar los 2 meses desde la última grabación.

Mover o cancelar citas (producción, sesiones del onboarding y reuniones):
- Usa verMisCitas para ver sus citas. Solo puedes tocar las que salen ahí.
- Solo se pueden mover o cancelar hasta 48 horas antes. Si falta menos, no lo hagas: dile que lo coordina directo con el responsable, dale su correo y pásale el mensaje con pasarMensajeAlEquipo.
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
              .find({ workspaceId: chat.workspaceId, date: { $gte: ahora }, title: { $not: /^CANCELADA/ } })
              .sort({ date: 1 })
              .limit(3)
              .select("title date")
              .lean(),
            models.planning
              .findOne({ workspaceId: chat.workspaceId, date: { $lt: ahora }, title: { $not: /^CANCELADA/ } })
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
          return {
            agendable: true,
            con: equipoAtencionService.nombres(tema),
            horarios: horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
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
          const horarios = await onboardingBotService.horarios(sesion);
          return {
            con: def.responsable.nombre,
            etiqueta: def.etiqueta,
            link: def.link,
            horarios:
              horarios === null || !horarios.length
                ? `No pude ver los horarios: pásale el link ${def.link}`
                : horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
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
          const r = await onboardingBotService.agendar(chat, sesion, fecha);
          const def = SESIONES_ONBOARDING[sesion];
          return r.ok
            ? { ok: true, cuando: r.cuando, con: r.responsable, correo: def.responsable.email, llevarListo: def.requisitos }
            : { ok: false, motivo: r.motivo, link: def.link };
        },
      },

      verHorariosProduccion: {
        description:
          "Dice si el cliente puede agendar su producción (una cada 2 meses desde la última; con una ya agendada no puede otra) y los horarios libres de Karen Muñoz y Jean Ortega desde la fecha permitida.",
        inputSchema: z.object({}),
        execute: async () => {
          const { estado, horarios } = await atencionClienteService.horariosProduccion(chat.workspaceId!);
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
          "Agenda la producción en el calendario de Karen Muñoz y Jean Ortega y les avisa. Úsala solo con un horario que el cliente eligió de verHorariosProduccion. El sistema vuelve a validar la regla de 2 meses.",
        inputSchema: z.object({
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosProduccion"),
        }),
        execute: async ({ inicio }: { inicio: string }) => {
          const fecha = new Date(inicio);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "horario inválido" };
          const r = await atencionClienteService.reservarProduccion(chat, fecha);
          return r.ok
            ? { ok: true, cuando: r.cuando, con: equipoAtencionService.nombres("produccion"), correos: equipoAtencionService.correos("produccion") }
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
          const r = await atencionClienteService.reservarReunion(chat, tema, fecha);
          return r.ok
            ? { ok: true, cuando: r.cuando, con: equipoAtencionService.nombres(tema), correos: equipoAtencionService.correos(tema) }
            : { ok: false, motivo: r.motivo };
        },
      },

      verMisCitas: {
        description:
          "Citas futuras del cliente que se pueden gestionar (producción, sesiones del onboarding y reuniones), con su ref, con quién y si todavía se pueden mover o cancelar (hasta 48 h antes).",
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
            })),
          };
        },
      },

      verHorariosParaMover: {
        description:
          "Horarios libres para mover una cita (ref de verMisCitas). En producción respeta la regla de 2 meses desde la última grabación.",
        inputSchema: z.object({ ref: z.string().describe("ref exacta de verMisCitas") }),
        execute: async ({ ref }: { ref: string }) => {
          const r = await citasClienteService.horariosParaMover(chat, ref);
          if (!r.cita) return { ok: false, motivo: "No encontré esa cita. Usa verMisCitas." };
          if (r.motivo === "fuera_de_plazo")
            return { ok: false, motivo: "Faltan menos de 48 horas: ya no se puede mover desde aquí.", responsable: r.cita.con, correos: r.cita.correos };
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
        }),
        execute: async ({ ref, motivo }: { ref: string; motivo?: string | null }) => {
          const r = await citasClienteService.proponer(chat, { accion: "cancelar", ref, motivo: motivo ?? undefined });
          if (r.ok && "resumen" in r) turno.propuesta = true;
          return r.ok ? { ...r, siguiente: "Pídele que confirme con el botón o respondiéndote que sí." } : r;
        },
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
            ? { ok: true, accion: r.accion, monto: r.monto, dia: r.diaTexto, totalDelDia: r.totalDia, roas: r.roas }
            : r;
        },
      },

      verMetricas: {
        description:
          "Métricas del entorno: facturación, gasto en Meta y ROAS del mes actual y del anterior, días sin facturación registrada y los videos con más vistas del mes.",
        inputSchema: z.object({}),
        execute: async () => metricasClienteService.resumen(chat.workspaceId!),
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

  private async clasificar(historial: Mensaje[], texto: string): Promise<Clasificacion | null> {
    const { generateText } = await cargarAi();
    const contexto = historial
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`)
      .join("\n");
    const { text } = await generateText({
      model: modelo(),
      system: `Clasificas el ánimo de un cliente de una agencia de marketing según su último mensaje y el contexto. Responde SOLO un JSON válido, sin texto extra:
{"estado":"en_peligro|molesto|feliz|neutral","tema":"produccion|guiones|atencion","motivo":"...","frase":"frase exacta del cliente que lo muestra","recomendacion":"acción concreta para el equipo"}
tema: produccion si habla de grabaciones o fechas de producción; guiones si habla de guiones, contenido o videos; atencion para pagos, resultados, contrato o cualquier otra cosa.
en_peligro: quiere cancelar o pausar el SERVICIO con la agencia (no una cita, sesión o grabación puntual), no ve resultados, siente que pierde dinero, compara con otra agencia, amenaza con irse.
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
      if (c.estado !== "en_peligro" && c.estado !== "molesto") return;

      const previa = chat.ultimaAlerta;
      const empeoro = previa?.estado === "molesto" && c.estado === "en_peligro";
      if (previa?.en && Date.now() - new Date(previa.en).getTime() < ALERTA_CADA_MS && !empeoro) return;

      const urgente = c.estado === "en_peligro";
      const titulo = urgente ? `🔴 URGENTE · ${cliente.entorno} podría irse` : `🟠 ${cliente.entorno} está molesto`;
      const frase = c.frase || texto.slice(0, 300);
      const tema = c.tema;
      const mensaje = [
        `${urgente ? "🔴 Cliente en peligro" : "🟠 Cliente molesto"} (detectado por la IA en Telegram)`,
        `Tema: ${EQUIPO_ATENCION[tema].etiqueta} · responsable: ${equipoAtencionService.nombres(tema)}`,
        "",
        `Frase: “${frase}”`,
        `Motivo: ${c.motivo}`,
        `Recomendación: ${c.recomendacion}`,
        "",
        `Mensaje completo: “${texto.slice(0, 1000)}”`,
      ].join("\n");

      // Queja fuerte: va directo al responsable del tema y a los superadmins,
      // todos en el mismo aviso. Los contactos bloqueados los filtra cada canal.
      const [responsables, superadmins] = await Promise.all([
        equipoAtencionService.usuarios(tema),
        models.users.find({ role: "superadmin", isActive: true }).select("_id email").lean(),
      ]);
      const correos = [...new Set([...equipoAtencionService.correos(tema), ...superadmins.map((u) => u.email).filter(Boolean)])];
      const ids = [...new Map([...responsables, ...superadmins].map((u) => [String(u._id), u._id])).values()];
      await Promise.allSettled([
        ...ids.map((id) =>
          notificationService.create(id as any, "cliente_en_riesgo", titulo, `${cliente.nombre}: “${frase.slice(0, 240)}” · ${c.recomendacion}`, {
            workspaceId: chat.workspaceId!,
          })
        ),
        resendService.sendSolicitudClienteEmail({
          to: correos,
          tema: urgente ? "cliente en peligro" : "cliente molesto",
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
