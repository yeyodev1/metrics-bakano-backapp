import axios from "axios";
import { createHmac, timingSafeEqual } from "crypto";
import { z } from "zod";
import { Types } from "mongoose";
import models from "../models";
import { equipoAtencionService } from "./equipoAtencion.service";

/**
 * Tickets de soporte@bakano.ec → Slack.
 *
 * Google reenvia el buzon a la direccion de recepcion de Resend. Resend manda
 * `email.received` (solo metadatos) al webhook; aqui se trae el correo
 * completo, se identifica al cliente por su correo, la IA clasifica tema y
 * urgencia, y se publica en el canal de soporte etiquetando a quien atiende.
 */

export type TemaSoporte = "produccion" | "guiones" | "atencion" | "meta_ads" | "crm" | "tecnologia";

const TEMAS: Record<TemaSoporte, { etiqueta: string; emoji: string; correos: () => string[] }> = {
  produccion: { etiqueta: "Producción", emoji: "🎬", correos: () => equipoAtencionService.correos("produccion") },
  guiones: { etiqueta: "Guiones y contenido", emoji: "📝", correos: () => equipoAtencionService.correos("guiones") },
  atencion: { etiqueta: "Atención, pagos y contrato", emoji: "🤝", correos: () => equipoAtencionService.correos("atencion") },
  meta_ads: { etiqueta: "Meta Ads y campañas", emoji: "📣", correos: () => ["dquimi@bakano.ec"] },
  crm: { etiqueta: "CRM", emoji: "🗂️", correos: () => ["drobles@bakano.ec"] },
  tecnologia: { etiqueta: "metrics.bakano.ec y tecnología", emoji: "💻", correos: () => ["dreyes@bakano.ec"] },
};
const TEMAS_IDS = Object.keys(TEMAS) as [TemaSoporte, ...TemaSoporte[]];

// Urgente o cliente molesto: se suma quien atiende la cuenta.
const correosEscalamiento = () => equipoAtencionService.correos("atencion");

const URGENCIA_EMOJI: Record<string, string> = { alta: "🔴 Alta", media: "🟠 Media", baja: "🟢 Baja" };
const ANIMO_EMOJI: Record<string, string> = { en_peligro: "🚨 En peligro", molesto: "😠 Molesto", neutral: "😐 Neutral", feliz: "😊 Feliz" };

// Resend firma con Svix; se rechazan firmas de mas de 5 minutos (replay).
const TOLERANCIA_FIRMA_S = 5 * 60;
// Resend espera ~15 s por el webhook: si la IA tarda, el ticket sale igual como "atención".
const LIMITE_IA_MS = 10_000;

const clasificacionSchema = z.object({
  tema: z.enum(TEMAS_IDS),
  urgencia: z.enum(["alta", "media", "baja"]),
  animo: z.enum(["en_peligro", "molesto", "neutral", "feliz"]),
  resumen: z.string().default(""),
  accion: z.string().default(""),
});
type Clasificacion = z.infer<typeof clasificacionSchema>;

type AiSdk = typeof import("ai");
let aiSdk: Promise<AiSdk> | null = null;
// `ai` es solo ESM: se carga al usarse, nunca al importar (tumbaria la API).
function cargarAi(): Promise<AiSdk> {
  aiSdk ??= import("ai").catch((error) => {
    aiSdk = null;
    throw error;
  });
  return aiSdk;
}

function remitente(valor: string | undefined): { nombre?: string; email?: string } {
  if (!valor) return {};
  const conNombre = valor.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (conNombre) return { nombre: conNombre[1].trim() || undefined, email: conNombre[2].trim().toLowerCase() };
  return { email: valor.trim().toLowerCase() };
}

function htmlATexto(html?: string | null): string {
  if (!html) return "";
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Slack interpreta & < > en mrkdwn. */
function slackEscape(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

class SoporteService {
  private slackIds = new Map<string, string | null>();

  /** Firma Svix: HMAC-SHA256 de `id.timestamp.cuerpo` con el secreto `whsec_…` en base64. */
  verificarFirma(cuerpo: string, headers: Record<string, string | string[] | undefined>, secreto: string): boolean {
    const id = String(headers["svix-id"] || "");
    const timestamp = String(headers["svix-timestamp"] || "");
    const firmas = String(headers["svix-signature"] || "");
    if (!id || !timestamp || !firmas) return false;
    if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCIA_FIRMA_S) return false;

    const clave = Buffer.from(secreto.replace(/^whsec_/, ""), "base64");
    const esperada = Buffer.from(createHmac("sha256", clave).update(`${id}.${timestamp}.${cuerpo}`).digest("base64"));
    return firmas.split(" ").some((f) => {
      const firma = Buffer.from(f.split(",")[1] || "");
      return firma.length === esperada.length && timingSafeEqual(firma, esperada);
    });
  }

  async procesar(evento: any): Promise<{ estado: string }> {
    if (evento?.type !== "email.received" || !evento?.data?.email_id) return { estado: "ignorado" };
    const emailId = String(evento.data.email_id);
    const asunto = String(evento.data.subject || "(sin asunto)").slice(0, 300);

    let ticketId: Types.ObjectId;
    try {
      const creado = await models.soporteTickets.create({ emailId, asunto, estado: "recibido" });
      ticketId = creado._id as Types.ObjectId;
    } catch (error: any) {
      if (error?.code === 11000) return { estado: "duplicado" };
      throw error;
    }

    const correo = await this.obtenerCorreo(emailId).catch((error) => {
      console.error("[Soporte] no se pudo leer el correo en Resend:", error.response?.data || error.message);
      return null;
    });
    const de = remitente(correo?.headers?.from || correo?.from || evento.data.from);
    const texto = (correo?.text || htmlATexto(correo?.html) || "").slice(0, 20000);
    const cliente = de.email ? await this.identificarCliente(de.email) : null;

    const clasificacion: Clasificacion =
      (await this.clasificar(asunto, texto, cliente?.entorno).catch((error) => {
        console.error("[Soporte] clasificación:", error?.message || error);
        return null;
      })) ?? { tema: "atencion", urgencia: "media", animo: "neutral", resumen: asunto, accion: "" };

    const escalar = clasificacion.urgencia === "alta" || clasificacion.animo === "molesto" || clasificacion.animo === "en_peligro";
    const correos = [...new Set([...TEMAS[clasificacion.tema].correos(), ...(escalar ? correosEscalamiento() : [])])];
    const mencionados = (await Promise.all(correos.map((c) => this.slackIdPorCorreo(c)))).filter((id): id is string => Boolean(id));

    const slackTs = await this.publicarEnSlack({ asunto, texto, de, cliente, clasificacion, mencionados }).catch((error) => {
      console.error("[Soporte] no se pudo publicar en Slack:", error?.message || error);
      return null;
    });

    await models.soporteTickets.updateOne(
      { _id: ticketId },
      {
        $set: {
          deNombre: de.nombre,
          deEmail: de.email,
          texto,
          tema: clasificacion.tema,
          urgencia: clasificacion.urgencia,
          animo: clasificacion.animo,
          resumen: clasificacion.resumen,
          accionSugerida: clasificacion.accion,
          workspaceId: cliente?.workspaceId ?? null,
          userId: cliente?.userId ?? null,
          entorno: cliente?.entorno,
          mencionados,
          slackTs: slackTs ?? undefined,
          estado: slackTs ? "publicado" : "sin_slack",
        },
      }
    );
    return { estado: slackTs ? "publicado" : "sin_slack" };
  }

  /** El webhook trae solo metadatos: el cuerpo se pide aparte. */
  private async obtenerCorreo(emailId: string): Promise<any> {
    const { data } = await axios.get(`https://api.resend.com/emails/receiving/${emailId}`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      timeout: 15_000,
    });
    return data;
  }

  private async identificarCliente(
    email: string
  ): Promise<{ userId: Types.ObjectId; workspaceId?: Types.ObjectId; entorno?: string } | null> {
    const usuario = await models.users.findOne({ email, isActive: true }).select("_id workspaceId workspaces isInternal").lean();
    if (!usuario) return null;
    const workspaceId = (usuario.workspaceId || usuario.workspaces?.[0]?.workspaceId) as Types.ObjectId | undefined;
    const workspace = workspaceId ? await models.workspaces.findById(workspaceId).select("name").lean() : null;
    return {
      userId: usuario._id as Types.ObjectId,
      workspaceId,
      entorno: usuario.isInternal ? "Equipo Bakano" : workspace?.name,
    };
  }

  private async clasificar(asunto: string, texto: string, entorno?: string): Promise<Clasificacion | null> {
    const { generateText } = await cargarAi();
    const { text } = await generateText({
      model: process.env.AI_MODEL || "google/gemini-3.8-flash",
      system: `Clasificas correos que llegan al soporte de Bakano, una agencia de marketing de Ecuador. Responde SOLO un JSON válido, sin texto extra:
{"tema":"${TEMAS_IDS.join("|")}","urgencia":"alta|media|baja","animo":"en_peligro|molesto|neutral|feliz","resumen":"1 o 2 frases con lo que pide","accion":"qué debería hacer el equipo, en una frase"}
Temas:
- produccion: grabaciones, fechas de producción, equipo de filmación, videos grabados
- guiones: guiones, ideas de contenido, correcciones de guion, publicaciones
- atencion: pagos, facturas, contrato, reuniones con la project manager, quejas generales, cualquier otra cosa
- meta_ads: campañas de Facebook o Instagram, anuncios, presupuesto de pauta, métricas de ads
- crm: CRM, GoHighLevel, automatizaciones, calendarios de agendamiento, WhatsApp del CRM
- tecnologia: metrics.bakano.ec, acceso a la plataforma, contraseñas, errores del sistema, bot de Telegram
urgencia alta: algo detenido o perdiendo ventas, fecha inminente, cliente muy molesto. baja: consultas sin apuro.
animo en_peligro: quiere cancelar o pausar, no ve resultados, amenaza con irse.`,
      prompt: `${entorno ? `Cliente: ${entorno}\n` : ""}Asunto: ${asunto}\n\n${texto.slice(0, 6000)}`,
      abortSignal: AbortSignal.timeout(LIMITE_IA_MS),
    });
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return null;
    const r = clasificacionSchema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  }

  private async slackIdPorCorreo(email: string): Promise<string | null> {
    if (this.slackIds.has(email)) return this.slackIds.get(email)!;
    try {
      const { data } = await axios.get("https://slack.com/api/users.lookupByEmail", {
        params: { email },
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
        timeout: 10_000,
      });
      const id = data?.ok ? (data.user.id as string) : null;
      if (!data?.ok) console.warn(`[Soporte] ${email} no está en Slack: ${data?.error}`);
      this.slackIds.set(email, id);
      return id;
    } catch (error: any) {
      console.error("[Soporte] lookupByEmail:", error.message);
      return null;
    }
  }

  private async publicarEnSlack(t: {
    asunto: string;
    texto: string;
    de: { nombre?: string; email?: string };
    cliente: { entorno?: string } | null;
    clasificacion: Clasificacion;
    mencionados: string[];
  }): Promise<string | null> {
    const canal = process.env.SLACK_SOPORTE_CHANNEL_ID;
    if (!canal || !process.env.SLACK_BOT_TOKEN) throw new Error("Slack sin configurar");

    const tema = TEMAS[t.clasificacion.tema];
    const quien = t.de.nombre ? `${t.de.nombre} <${t.de.email}>` : t.de.email || "Desconocido";
    const menciones = t.mencionados.length ? t.mencionados.map((id) => `<@${id}>`).join(" ") : "_nadie encontrado en Slack_";
    // La primera persona del tema es la responsable; el resto (y la escalada) apoya.
    const responsable = t.mencionados[0] ? `<@${t.mencionados[0]}>` : "_nadie encontrado en Slack_";
    const apoyo = t.mencionados.slice(1).map((id) => `<@${id}>`).join(" ");
    const extracto = t.texto.replace(/\n{2,}/g, "\n").slice(0, 700);

    const { data } = await axios.post(
      "https://slack.com/api/chat.postMessage",
      {
        channel: canal,
        text: `🎫 ${t.asunto} · ${tema.emoji} ${tema.etiqueta} · ${menciones}`,
        unfurl_links: false,
        blocks: [
          { type: "header", text: { type: "plain_text", text: `🎫 ${t.asunto}`.slice(0, 150), emoji: true } },
          {
            type: "section",
            fields: [
              { type: "mrkdwn", text: `*De:*\n${slackEscape(quien)}` },
              { type: "mrkdwn", text: `*Cliente:*\n${slackEscape(t.cliente?.entorno || "No identificado")}` },
              { type: "mrkdwn", text: `*Tema:*\n${tema.emoji} ${tema.etiqueta}` },
              {
                type: "mrkdwn",
                text: `*Urgencia · ánimo:*\n${URGENCIA_EMOJI[t.clasificacion.urgencia]} · ${ANIMO_EMOJI[t.clasificacion.animo]}`,
              },
            ],
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `*Resumen:* ${slackEscape(t.clasificacion.resumen || t.asunto)}` +
                (t.clasificacion.accion ? `\n*Qué hacer:* ${slackEscape(t.clasificacion.accion)}` : ""),
            },
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text:
                `*Responsable:* ${responsable}` +
                (apoyo ? `\n*Apoyo:* ${apoyo}` : "") +
                `\n*Responder a:* ${slackEscape(t.de.email || "—")} (desde soporte@bakano.ec)`,
            },
          },
          ...(extracto
            ? [{ type: "context", elements: [{ type: "mrkdwn", text: `>${slackEscape(extracto).replace(/\n/g, "\n>")}` }] }]
            : []),
          {
            type: "context",
            elements: [
              { type: "mrkdwn", text: "👀 reacciona cuando lo tomes · 💬 conversa en el hilo · ✅ reacciona cuando quede resuelto" },
            ],
          },
        ],
      },
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, "content-type": "application/json; charset=utf-8" }, timeout: 15_000 }
    );
    if (!data?.ok) throw new Error(`Slack: ${data?.error}`);
    return data.ts as string;
  }
}

export const soporteService = new SoporteService();
