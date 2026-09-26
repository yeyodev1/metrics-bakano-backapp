import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { telegramService, escaparHtml, type InlineButton } from "./telegram.service";
import { onboardingService } from "./onboarding.service";
import { resendService } from "./resend.service";
import { slackService } from "./slack.service";
import { PAUTA_MINIMA, PAUTA_TEMPORADA_ALTA, formatoDolares } from "./contratoTexto";

/**
 * El contrato se llena por el chat y se firma en una sola pantalla.
 *
 * Antes el cliente entraba a Metrics, escribia sus datos en un formulario
 * largo, firmaba y ademas agendaba una reunion, todo en la misma pagina. Se
 * caia en el primer paso. Ahora los datos se piden por Telegram —donde ya
 * esta hablando— y el link que recibe abre unicamente la firma.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";

export type CampoContrato = "rucCliente" | "nombreCliente" | "representanteCliente" | "email" | "presupuestoPauta";

export const CAMPOS_CONTRATO: CampoContrato[] = ["rucCliente", "nombreCliente", "representanteCliente", "email", "presupuestoPauta"];

export const PREGUNTA_CONTRATO: Record<CampoContrato, string> = {
  rucCliente:
    "Vamos con tu contrato 📝\n\nPrimero: ¿cuál es tu <b>RUC o cédula</b>?\n\nEscríbelo solo con números.",
  nombreCliente:
    "¿A nombre de quién va el contrato? Escribe tu <b>nombre o razón social</b>, tal como aparece en el RUC.",
  representanteCliente:
    "¿Quién es el <b>representante legal</b>? Nombre completo, como va a firmar.",
  email: "¿A qué <b>correo</b> te mandamos el contrato firmado?",
  presupuestoPauta:
    "Último: ¿cuánto te comprometes a <b>invertir al mes en anuncios</b> (pauta en Meta), sin impuestos?\n\n" +
    `El mínimo es <b>$${PAUTA_MINIMA}</b>: con menos no podemos asegurar cierres y los resultados pueden tardar más. ` +
    "Ese valor va creciendo a medida que crece tu facturación.\n\n" +
    `En octubre, noviembre y diciembre te recomendamos al menos <b>$${PAUTA_TEMPORADA_ALTA}</b>, porque hay más anunciantes compitiendo.\n\n` +
    "Escríbelo solo con números, por ejemplo: 300",
};

export const ETIQUETA_CONTRATO: Record<CampoContrato, string> = {
  rucCliente: "RUC o cédula",
  nombreCliente: "Nombre o razón social",
  representanteCliente: "Representante legal",
  email: "Correo para el contrato",
  presupuestoPauta: "Inversión mensual en anuncios",
};

/** "$350", "1.000", "1,200.50" → número. null si no se entiende. */
export function leerMonto(texto: string): number | null {
  let t = String(texto || "").replace(/[^\d.,]/g, "");
  if (!t) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(t)) t = t.replace(/[.,]/g, "");
  else t = t.replace(/,(?=\d{3}\b)/g, "").replace(",", ".");
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Como se le muestra un dato del contrato al cliente. */
export function mostrarDatoContrato(campo: CampoContrato, valor: unknown): string {
  if (campo === "presupuestoPauta" && Number(valor) > 0) return `${formatoDolares(Number(valor))} al mes`;
  return String(valor ?? "");
}

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Reenviar el firmado al correo, como mucho cada 10 minutos. */
const REENVIO_CADA_MS = 10 * 60_000;

/** Se recuerda una vez al dia. */
const CADA_MS = 20 * 3_600_000;
/** A los tres recordatorios sin firmar, el equipo se entera. */
const AVISAR_AL_EQUIPO_DESDE = 3;

class ContratoChatService {
  /** Lo que ya tiene guardado del contrato, aunque no lo haya firmado. */
  async datos(workspaceId: Types.ObjectId | string): Promise<Record<string, any>> {
    const w = await models.workspaces.findById(workspaceId).select("contractData onboardingStatus").lean();
    return ((w as any)?.contractData || {}) as Record<string, any>;
  }

  async firmado(workspaceId: Types.ObjectId | string): Promise<boolean> {
    const w = await models.workspaces.findById(workspaceId).select("onboardingStatus").lean();
    return Boolean((w as any)?.onboardingStatus?.contractSubmitted);
  }

  /** Campos que todavia faltan, en orden. */
  async faltantes(workspaceId: Types.ObjectId | string): Promise<CampoContrato[]> {
    const datos = await this.datos(workspaceId);
    return CAMPOS_CONTRATO.filter((c) => !String(datos[c] ?? "").trim());
  }

  /** Valida y guarda un dato del contrato. */
  async guardar(chat: ITelegramChat, campo: string, valor: string): Promise<{ ok: boolean; motivo?: string }> {
    if (!CAMPOS_CONTRATO.includes(campo as CampoContrato)) return { ok: false, motivo: "campo_desconocido" };
    let limpio: string | number = String(valor || "").trim();

    if (campo === "rucCliente") {
      const digitos = limpio.replace(/\D/g, "");
      if (digitos.length < 10 || digitos.length > 13) {
        return { ok: false, motivo: "El RUC tiene 13 números y la cédula 10. Revísalo y mándamelo de nuevo." };
      }
      limpio = digitos;
    } else if (campo === "email") {
      limpio = limpio.toLowerCase();
      if (!CORREO_RE.test(limpio)) return { ok: false, motivo: "Ese correo no se ve bien. Escríbelo completo, por ejemplo nombre@empresa.com" };
    } else if (campo === "presupuestoPauta") {
      const monto = leerMonto(limpio);
      if (monto === null) return { ok: false, motivo: "Escríbelo solo con números, por ejemplo: 300" };
      if (monto < PAUTA_MINIMA) {
        return {
          ok: false,
          motivo: `El mínimo es $${PAUTA_MINIMA} al mes. Con menos no podemos asegurar cierres y los resultados pueden tardar más. Escríbeme un valor de ${PAUTA_MINIMA} o más.`,
        };
      }
      limpio = Math.round(monto * 100) / 100;
    } else {
      if (limpio.length < 3) return { ok: false, motivo: "Necesito el nombre completo." };
      limpio = limpio.slice(0, 160);
    }

    // contractData es un campo libre: se crea vacio si el entorno es nuevo.
    await models.workspaces.updateOne(
      { _id: chat.workspaceId, $or: [{ contractData: null }, { contractData: { $exists: false } }] },
      { $set: { contractData: {} } }
    );
    await models.workspaces.updateOne({ _id: chat.workspaceId }, { $set: { [`contractData.${campo}`]: limpio } });
    return { ok: true };
  }

  /**
   * Le manda el contrato como PDF por el chat, las veces que lo pida.
   *
   * Antes solo podia verlo abriendo el link de firma. Sin firmar va el
   * borrador con sus datos; firmado va el mismo texto que firmo.
   */
  async enviarPdf(chat: ITelegramChat): Promise<{ ok: boolean; firmado?: boolean; correo?: string }> {
    if (!chat.workspaceId) return { ok: false };
    const w = await models.workspaces
      .findById(chat.workspaceId)
      .select("contractData preNegotiatedContract onboardingStatus")
      .lean();
    if (!w) return { ok: false };

    const datos = { ...((w as any).preNegotiatedContract || {}), ...((w as any).contractData || {}) };
    const firmado = Boolean((w as any).onboardingStatus?.contractSubmitted);
    const correo = String(datos.email || "").trim();
    const faltan = CAMPOS_CONTRATO.filter((c) => !String(datos[c] ?? "").trim());

    const pdf = await onboardingService.generateContractPDF(datos, { firmado, borrador: !firmado });

    const caption = firmado
      ? `📄 <b>Tu contrato firmado</b>\n\nEsta misma copia está en tu correo${correo ? ` <b>${escaparHtml(correo)}</b>` : ""}. Pídemelo aquí cuando quieras.`
      : `📄 <b>Borrador de tu contrato</b> (todavía sin firma)\n\nLéelo con calma. ` +
        (correo
          ? `Cuando lo firmes, te llega una copia firmada a <b>${escaparHtml(correo)}</b>.`
          : "Cuando lo firmes, te llega una copia firmada al correo que me des.") +
        (faltan.length ? `\n\nTe ${faltan.length === 1 ? "falta 1 dato" : `faltan ${faltan.length} datos`} para poder firmarlo.` : "");

    const botones: InlineButton[][] = firmado
      ? [[{ text: "📧 Reenviármelo al correo", callback_data: "contrato:correo" }]]
      : faltan.length
        ? [[{ text: `📝 Completar mis datos (${faltan.length})`, callback_data: "contrato:llenar" }]]
        : [[{ text: "✍️ Firmar mi contrato", url: this.link(chat.workspaceId) }]];
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    await telegramService.sendDocument(
      chat.chatId,
      pdf,
      firmado ? "contrato_bakano_firmado.pdf" : "contrato_bakano_borrador.pdf",
      caption,
      botones
    );
    return { ok: true, firmado, correo: correo || undefined };
  }

  /** Reenvia el contrato firmado al correo que dio. */
  async reenviarPorCorreo(chat: ITelegramChat): Promise<{ ok: boolean; correo?: string; motivo?: string }> {
    if (!chat.workspaceId) return { ok: false, motivo: "sin_entorno" };
    const w = await models.workspaces.findById(chat.workspaceId).select("contractData onboardingStatus").lean();
    const datos = ((w as any)?.contractData || {}) as Record<string, any>;
    if (!(w as any)?.onboardingStatus?.contractSubmitted) return { ok: false, motivo: "sin_firmar" };
    if (!datos.email) return { ok: false, motivo: "sin_correo" };

    const ultimo = datos.ultimoReenvioCorreoEn ? new Date(datos.ultimoReenvioCorreoEn).getTime() : 0;
    if (Date.now() - ultimo < REENVIO_CADA_MS) return { ok: false, correo: datos.email, motivo: "reciente" };

    const pdf = await onboardingService.generateContractPDF(datos as any, { firmado: true });
    await resendService.sendContractEmail({ to: datos.email, recipientName: datos.representanteCliente || "", pdfBuffer: pdf });
    await models.workspaces.updateOne({ _id: chat.workspaceId }, { $set: { "contractData.ultimoReenvioCorreoEn": new Date() } });
    return { ok: true, correo: datos.email };
  }

  /** El link que abre solo la pantalla de firma. */
  link(workspaceId: Types.ObjectId | string): string {
    return `${APP_URL}/onboarding/${workspaceId}`;
  }

  /**
   * Le recuerda al cliente que su contrato sigue sin firmar.
   *
   * Un "mas tarde" sin recordatorio es un contrato que no se firma nunca: el
   * cliente cierra el chat y el tema se muere ahi. Se insiste una vez al dia,
   * cambiando el tono, y al tercer recordatorio el equipo se entera.
   */
  async recordarPendientes(): Promise<{ revisados: number; recordados: number }> {
    const entornos = await models.workspaces
      .find({ isActive: true, "onboardingStatus.contractSubmitted": { $ne: true } })
      .select("name contractData")
      .lean();

    let recordados = 0;
    for (const w of entornos as any[]) {
      const chats = await models.telegramChats.find({ workspaceId: w._id, estado: "listo" }).select("chatId").lean();
      if (!chats.length) continue;

      const datos = (w.contractData || {}) as Record<string, any>;
      const ultimo = datos.ultimoRecordatorioEn ? new Date(datos.ultimoRecordatorioEn).getTime() : 0;
      if (Date.now() - ultimo < CADA_MS) continue;

      const veces = Number(datos.recordatorios || 0) + 1;
      const faltan = CAMPOS_CONTRATO.filter((c) => !String(datos[c] ?? "").trim());
      const link = this.link(w._id);

      const texto = faltan.length
        ? (veces === 1
            ? "📝 Te quedó pendiente tu contrato.\n\nSon cinco datos y los llenamos aquí mismo, en un minuto."
            : veces < AVISAR_AL_EQUIPO_DESDE
              ? `📝 Seguimos sin tu contrato: faltan ${faltan.length} datos.\n\nSin el contrato firmado no podemos arrancar con tus guiones ni con tu producción.`
              : "📝 Tu contrato sigue sin llenarse y ya van varios días.\n\nEs lo único que nos frena para empezar. Si algo te está trabando, dímelo y lo resolvemos ahora.")
        : (veces === 1
            ? "✍️ Ya tengo todos tus datos: solo falta tu firma.\n\nSe abre, lo lees y lo firmas con el dedo. Dos minutos."
            : veces < AVISAR_AL_EQUIPO_DESDE
              ? "✍️ Tu contrato sigue sin firmar.\n\nEs el único paso que falta para arrancar: sin eso no empiezan tus guiones ni tu producción."
              : "✍️ Tu contrato lleva días esperando tu firma.\n\nNo podemos avanzar sin eso. Si prefieres que alguien te acompañe a firmarlo, dímelo y te llamamos.");

      const botones = faltan.length
        ? [[{ text: `📝 Llenar mi contrato (${faltan.length})`, callback_data: "contrato:llenar" }], [{ text: "📋 Ver menú", callback_data: "menu:ver" }]]
        : [[{ text: "✍️ Leer y firmar ahora", url: link }], [{ text: "📋 Ver menú", callback_data: "menu:ver" }]];

      for (const chat of chats as any[]) {
        await telegramService
          .sendMessage(chat.chatId, texto, botones as any)
          .catch((error: any) => console.error("[Contrato] recordatorio:", error?.message || error));
      }

      await models.workspaces.updateOne(
        { _id: w._id },
        { $set: { "contractData.ultimoRecordatorioEn": new Date(), "contractData.recordatorios": veces } }
      );
      recordados++;

      if (veces === AVISAR_AL_EQUIPO_DESDE) {
        await slackService
          .avisarEquipo({
            titulo: `📝 ${w.name} lleva ${veces} recordatorios y no firma su contrato`,
            detalle:
              (faltan.length
                ? `Todavía le faltan datos: ${faltan.join(", ")}.`
                : "Tiene todos los datos cargados y no entra a firmar.") +
              `\n\nLink de firma: ${link}`,
            correos: ["gbenalcazar@bakano.ec"],
          })
          .catch(() => undefined);
      }
    }

    return { revisados: entornos.length, recordados };
  }

  /** Resumen de lo cargado, para confirmarlo antes de mandar el link. */
  async resumen(workspaceId: Types.ObjectId | string): Promise<string> {
    const datos = await this.datos(workspaceId);
    return CAMPOS_CONTRATO.map((c) => `• <b>${ETIQUETA_CONTRATO[c]}:</b> ${mostrarDatoContrato(c, datos[c]) || "—"}`).join("\n");
  }

  /**
   * El estado completo: que dato ya esta, cual falta y si falta la firma.
   * Es lo que se le muestra cada vez que vuelve, para que no tenga que
   * acordarse de por donde iba.
   */
  async estado(workspaceId: Types.ObjectId | string): Promise<{
    texto: string;
    faltan: CampoContrato[];
    firmado: boolean;
    completo: boolean;
  }> {
    const [datos, firmado] = await Promise.all([this.datos(workspaceId), this.firmado(workspaceId)]);
    const faltan = CAMPOS_CONTRATO.filter((c) => !String(datos[c] ?? "").trim());
    const lineas = CAMPOS_CONTRATO.map((c) => {
      const valor = mostrarDatoContrato(c, datos[c]).trim();
      return valor ? `✅ <b>${ETIQUETA_CONTRATO[c]}:</b> ${valor}` : `⬜ <b>${ETIQUETA_CONTRATO[c]}:</b> falta`;
    });
    lineas.push(firmado ? "✅ <b>Tu firma:</b> listo" : "⬜ <b>Tu firma:</b> pendiente");
    return { texto: lineas.join("\n"), faltan, firmado, completo: !faltan.length && firmado };
  }
}

export const contratoChatService = new ContratoChatService();
