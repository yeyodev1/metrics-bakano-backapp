import { generateText, isStepCount, tool } from "ai";
import { z } from "zod";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { atencionClienteService, fechaEcuador, type DatosCliente } from "./atencionCliente.service";
import { horasDeCorreccion } from "./videoPlanning.service";
import { escaparHtml, telegramService } from "./telegram.service";

/**
 * La IA que conversa con el cliente por Telegram.
 *
 * Corre con el AI SDK sobre Vercel AI Gateway: el modelo es un string
 * "proveedor/modelo" y en Vercel se autentica solo (OIDC), o con
 * AI_GATEWAY_API_KEY si existe. Cambiar de modelo es cambiar AI_MODEL.
 *
 * Nunca inventa datos: producciones, guiones y horarios salen de las
 * herramientas. En paralelo clasifica el animo del cliente y avisa a la
 * project manager si esta molesto o en peligro de irse.
 */

const modelo = () => process.env.AI_MODEL || "google/gemini-3.8-flash";
// Vercel corta la funcion a los 60 s y Telegram reintenta si no respondemos.
const LIMITE_MS = 35_000;
const MAX_HISTORIAL = 20;
const ALERTA_CADA_MS = 24 * 3_600_000;

const TEMAS = ["produccion", "guiones", "atencion"] as const;

type Mensaje = { role: "user" | "assistant"; content: string };

const clasificacionSchema = z.object({
  estado: z.enum(["en_peligro", "molesto", "feliz", "neutral"]),
  motivo: z.string().default(""),
  frase: z.string().default(""),
  recomendacion: z.string().default(""),
});
type Clasificacion = z.infer<typeof clasificacionSchema>;

class TelegramAgentService {
  /** Responde con IA. false si la IA fallo: el bot vuelve al menu. */
  async responder(chat: ITelegramChat, texto: string): Promise<boolean> {
    const cliente = await atencionClienteService.datosCliente(chat);
    const historial: Mensaje[] = (chat.historial || []).slice(-MAX_HISTORIAL).map((m) => ({
      role: m.rol === "cliente" ? "user" : "assistant",
      content: m.texto,
    }));
    await telegramService.sendChatAction(chat.chatId, "typing").catch(() => undefined);

    let respuesta = "";
    try {
      const [resultado, clasificacion] = await Promise.all([
        generateText({
          model: modelo(),
          system: this.instrucciones(cliente),
          messages: [...historial, { role: "user", content: texto }],
          tools: this.herramientas(chat, texto),
          stopWhen: isStepCount(6),
          abortSignal: AbortSignal.timeout(LIMITE_MS),
        }),
        this.clasificar(historial, texto).catch((error) => {
          console.error("[Telegram IA] clasificación:", error?.message || error);
          return null;
        }),
      ]);
      respuesta = resultado.text.replace(/\*\*?|__|#+ /g, "").trim();
      if (clasificacion) await this.alertarSiHaceFalta(chat, cliente, clasificacion, texto);
    } catch (error: any) {
      console.error("[Telegram IA] respuesta:", error?.message || error);
      return false;
    }
    if (!respuesta) return false;

    await telegramService.sendMessage(chat.chatId, escaparHtml(respuesta).slice(0, 4000), [
      [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
    ]);
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
    return true;
  }

  private instrucciones(cliente: DatosCliente): string {
    const equipo = (Object.keys(EQUIPO_ATENCION) as TemaAtencion[])
      .map(
        (t) =>
          `- ${EQUIPO_ATENCION[t].etiqueta}: ${equipoAtencionService.nombres(t)}` +
          (EQUIPO_ATENCION[t].calendarioId ? " (se puede agendar reunión en su calendario)" : " (sin calendario: las reuniones se coordinan por correo)")
      )
      .join("\n");

    return `Eres el asistente de Bakano, una agencia de marketing de Ecuador. Atiendes por Telegram a ${cliente.nombre}, del cliente "${cliente.entorno}".
Hoy es ${fechaEcuador(new Date())} (hora Ecuador).

Tu estilo:
- Súper amigable, cálido y cercano. Tratas de tú. Usas emojis con naturalidad, entre 2 y 4 por mensaje.
- Mensajes cortos, máximo 6 líneas. Nada de párrafos largos.
- Texto plano: sin markdown, sin asteriscos, sin almohadillas.
- Siempre nombras a las personas del equipo con nombre y apellido.

Quién atiende a este cliente:
${equipo}

Reglas:
- Nunca inventes datos. Para producciones, guiones u horarios usa siempre las herramientas. Si no hay dato, dilo con honestidad y ofrece pasarle el mensaje al equipo.
- Si el cliente quiere hablar con alguien o tiene algo que no puedes resolver, ofrécele dos caminos: agendar una reunión (solo guiones y atención tienen calendario) o pasarle su mensaje por correo a la persona.
- Para agendar: consulta horarios libres, ofrece 3 o 4 opciones y agenda solo cuando el cliente elija un horario concreto. Usa exactamente el valor "inicio" que devuelve la herramienta.
- Antes de pasar un mensaje al equipo asegúrate de entender qué necesita. Después confírmale a quién se lo enviaste.
- Si el cliente está molesto, reconoce cómo se siente, pide disculpas sin excusas y ofrece una solución concreta.
- No prometas descuentos, reembolsos, cambios de contrato ni fechas que el equipo no confirmó.
- Solo hablas de la cuenta de ${cliente.entorno}. Si pregunta algo ajeno a Bakano, redirígelo con amabilidad.
- Si una herramienta falla, discúlpate y ofrece pasar el mensaje al equipo.`;
  }

  private herramientas(chat: ITelegramChat, textoCliente: string) {
    return {
      verProducciones: tool({
        description: "Próximas producciones (grabaciones) del cliente y la última realizada.",
        inputSchema: z.object({}),
        execute: async () => {
          const ahora = new Date();
          const [proximas, ultima] = await Promise.all([
            models.planning.find({ workspaceId: chat.workspaceId, date: { $gte: ahora } }).sort({ date: 1 }).limit(3).select("title date").lean(),
            models.planning.findOne({ workspaceId: chat.workspaceId, date: { $lt: ahora } }).sort({ date: -1 }).select("title date cumplida").lean(),
          ]);
          return {
            atienden: equipoAtencionService.nombres("produccion"),
            proximas: proximas.map((p) => ({ fecha: fechaEcuador(p.date), titulo: p.title, cancelada: /^CANCELADA/.test(p.title) })),
            ultima: ultima ? { fecha: fechaEcuador(ultima.date), titulo: ultima.title, grabada: ultima.cumplida } : null,
          };
        },
      }),

      verGuiones: tool({
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
      }),

      verHorariosLibres: tool({
        description: "Horarios libres de los próximos 7 días para reunirse con la persona de un tema.",
        inputSchema: z.object({ tema: z.enum(TEMAS) }),
        execute: async ({ tema }) => {
          const horarios = await atencionClienteService.horariosLibres(tema);
          if (horarios === null) {
            return {
              agendable: false,
              nota: `Con ${equipoAtencionService.nombres(tema)} la reunión se coordina por correo: pregunta qué día y hora prefiere y usa pasarMensajeAlEquipo.`,
            };
          }
          return {
            agendable: true,
            con: equipoAtencionService.nombres(tema),
            horarios: horarios.slice(0, 12).map((h) => ({ inicio: h.toISOString(), texto: fechaEcuador(h) })),
          };
        },
      }),

      agendarReunion: tool({
        description:
          "Agenda la reunión en el calendario del CRM y avisa por correo a la persona. Úsala solo con un horario que el cliente eligió de verHorariosLibres.",
        inputSchema: z.object({
          tema: z.enum(["guiones", "atencion"]),
          inicio: z.string().describe("Valor 'inicio' exacto devuelto por verHorariosLibres"),
        }),
        execute: async ({ tema, inicio }) => {
          const fecha = new Date(inicio);
          if (Number.isNaN(fecha.getTime())) return { ok: false, motivo: "horario inválido" };
          const r = await atencionClienteService.reservarReunion(chat, tema, fecha);
          return r.ok ? { ok: true, cuando: r.cuando, con: equipoAtencionService.nombres(tema) } : { ok: false, motivo: r.motivo };
        },
      }),

      pasarMensajeAlEquipo: tool({
        description: "Envía por correo y notificación el pedido del cliente a la persona que atiende el tema.",
        inputSchema: z.object({
          tema: z.enum(TEMAS),
          resumen: z.string().describe("Qué necesita el cliente, con los detalles: días, horarios, número de guion"),
        }),
        execute: async ({ tema, resumen }) => {
          const ok = await atencionClienteService.enviarMensaje(
            chat,
            tema,
            `${resumen}\n\nÚltimo mensaje del cliente: “${textoCliente.slice(0, 1000)}”`
          );
          return ok ? { ok: true, enviadoA: equipoAtencionService.nombres(tema) } : { ok: false };
        },
      }),
    };
  }

  private async clasificar(historial: Mensaje[], texto: string): Promise<Clasificacion | null> {
    const contexto = historial
      .slice(-6)
      .map((m) => `${m.role === "user" ? "Cliente" : "Bot"}: ${m.content}`)
      .join("\n");
    const { text } = await generateText({
      model: modelo(),
      system: `Clasificas el ánimo de un cliente de una agencia de marketing según su último mensaje y el contexto. Responde SOLO un JSON válido, sin texto extra:
{"estado":"en_peligro|molesto|feliz|neutral","motivo":"...","frase":"frase exacta del cliente que lo muestra","recomendacion":"acción concreta para la project manager"}
en_peligro: quiere cancelar o pausar, no ve resultados, siente que pierde dinero, compara con otra agencia, amenaza con irse.
molesto: queja, frustración, reclamo por demoras o errores, tono duro.
feliz: satisfacción clara, agradecimiento entusiasta, buenos resultados.
neutral: todo lo demás. Ante la duda, neutral.`,
      prompt: `${contexto ? `Contexto:\n${contexto}\n\n` : ""}Último mensaje del cliente: ${texto}`,
      abortSignal: AbortSignal.timeout(LIMITE_MS),
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
      await atencionClienteService.avisarEquipo(chat, "atencion", cliente, {
        tipo: "cliente_en_riesgo",
        titulo,
        cuerpo: `${cliente.nombre}: “${frase.slice(0, 240)}” · ${c.recomendacion}`,
        mensaje: [
          `${urgente ? "🔴 Cliente en peligro" : "🟠 Cliente molesto"} (detectado por la IA en Telegram)`,
          "",
          `Frase: “${frase}”`,
          `Motivo: ${c.motivo}`,
          `Recomendación: ${c.recomendacion}`,
          "",
          `Mensaje completo: “${texto.slice(0, 1000)}”`,
        ].join("\n"),
        asunto: `${titulo} (Telegram)`,
        encabezado: titulo,
      });
      await models.telegramChats.updateOne({ _id: chat._id }, { $set: { ultimaAlerta: { estado: c.estado, en: new Date() } } });
    } catch (error: any) {
      console.error("[Telegram IA] alerta:", error?.message || error);
    }
  }
}

export const telegramAgentService = new TelegramAgentService();
