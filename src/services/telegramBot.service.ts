import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { escaparHtml, telegramService, type InlineButton, type TelegramUpdate } from "./telegram.service";

function fechaEcuador(fecha: Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(fecha);
}

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODIGO_MINUTOS = 10;
const CODIGO_MAX_INTENTOS = 5;
const REENVIO_SEGUNDOS = 60;
// Un boton por entorno; el equipo interno ve decenas y Telegram se vuelve ilegible.
const MAX_BOTONES_ENTORNO = 30;

const PEDIR_CORREO =
  "Hola, soy el asistente de <b>Bakano</b>. Te ayudo con producciones, revisión de guiones y atención.\n\n" +
  "Para empezar, escribe el correo con el que entras a <b>metrics.bakano.ec</b>.";

function hashCodigo(chatId: number, codigo: string): string {
  // El secreto del webhook sirve de pimienta: sin el, el hash de 6 digitos se rompe en segundos.
  return createHash("sha256")
    .update(`${chatId}:${codigo}:${process.env.TELEGRAM_WEBHOOK_SECRET || ""}`)
    .digest("hex");
}

function mismoHash(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/**
 * Conversacion de @BakanoAgencyBot.
 *
 * esperando_correo → esperando_codigo → eligiendo_entorno → listo
 *
 * El codigo llega al correo de la cuenta: escribir el correo de otra persona
 * no alcanza para hablar en su nombre. La respuesta al correo es la misma
 * exista o no la cuenta, para no revelar quien es cliente.
 */
export class TelegramBotService {
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.callback_query) {
      const cq = update.callback_query;
      const chat = cq.message?.chat;
      await telegramService.answerCallbackQuery(cq.id).catch(() => undefined);
      if (!chat || chat.type !== "private" || !cq.data) return;
      const doc = await this.cargarChat(chat.id, cq.from);
      await this.onBoton(doc, cq.data);
      return;
    }

    const msg = update.message;
    // Solo chats privados: en un grupo cualquiera leeria el codigo.
    if (!msg || msg.chat.type !== "private" || !msg.from || typeof msg.text !== "string") return;

    const doc = await this.cargarChat(msg.chat.id, msg.from);
    await this.onTexto(doc, msg.text.trim());
  }

  private async cargarChat(
    chatId: number,
    from: { id: number; username?: string; first_name?: string }
  ): Promise<ITelegramChat> {
    const doc = await models.telegramChats
      .findOneAndUpdate(
        { chatId },
        {
          $set: { telegramUserId: from.id, telegramUsername: from.username, firstName: from.first_name },
          $setOnInsert: { chatId, estado: "esperando_correo" },
        },
        { upsert: true, new: true }
      )
      .select("+codigoHash");
    return doc!;
  }

  // ── Texto ──────────────────────────────────────────────────────────────────
  private async onTexto(chat: ITelegramChat, texto: string): Promise<void> {
    const comando = texto.split(/[\s@]/)[0].toLowerCase();

    if (comando === "/start") {
      if (chat.estado === "listo" && chat.workspaceId) return this.mostrarMenu(chat);
      if (chat.userId) return this.pedirEntorno(chat);
      return this.reiniciar(chat, PEDIR_CORREO);
    }
    if (comando === "/salir") {
      return this.reiniciar(chat, "Listo, desconecté tu cuenta de este chat. Escribe /start cuando quieras volver.");
    }
    if (comando === "/entorno") {
      if (!chat.userId) return this.reiniciar(chat, PEDIR_CORREO);
      return this.pedirEntorno(chat);
    }

    switch (chat.estado) {
      case "esperando_correo":
        return this.recibirCorreo(chat, texto);
      case "esperando_codigo":
        // Si escribe otro correo, asumimos que se equivoco en el primero.
        if (CORREO_RE.test(texto)) return this.recibirCorreo(chat, texto);
        return this.recibirCodigo(chat, texto);
      case "eligiendo_entorno":
        return this.pedirEntorno(chat);
      case "listo":
        if (chat.tema && chat.workspaceId) return this.enviarSolicitud(chat, chat.tema, texto);
        await telegramService.sendMessage(
          chat.chatId,
          "Te leo. Elige primero el tema para pasarle tu mensaje a la persona correcta:"
        );
        return this.mostrarMenu(chat);
    }
  }

  private async recibirCorreo(chat: ITelegramChat, texto: string): Promise<void> {
    const correo = texto.toLowerCase();
    if (!CORREO_RE.test(correo)) {
      await telegramService.sendMessage(
        chat.chatId,
        "Ese no parece un correo. Escribe el correo con el que entras a <b>metrics.bakano.ec</b>."
      );
      return;
    }

    if (chat.codigoEnviadoEn && Date.now() - chat.codigoEnviadoEn.getTime() < REENVIO_SEGUNDOS * 1000) {
      await telegramService.sendMessage(chat.chatId, "Acabo de enviar un código. Espera un minuto antes de pedir otro.");
      return;
    }

    const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const usuario = await models.users.findOne({ email: correo, isActive: true }).select("name email").lean();

    chat.correoPendiente = correo;
    chat.codigoHash = hashCodigo(chat.chatId, codigo);
    chat.codigoExpira = new Date(Date.now() + CODIGO_MINUTOS * 60_000);
    chat.codigoEnviadoEn = new Date();
    chat.codigoIntentos = 0;
    chat.estado = "esperando_codigo";
    await chat.save();

    // Sin cuenta no se manda nada, pero el chat pasa igual a esperar codigo: ninguno sirve.
    if (usuario) {
      try {
        await resendService.sendTelegramLoginCode({
          to: usuario.email,
          recipientName: usuario.name,
          codigo,
          expiresInMinutes: CODIGO_MINUTOS,
        });
      } catch (error) {
        console.error("[Telegram] no se pudo enviar el código:", error);
      }
    }

    await telegramService.sendMessage(
      chat.chatId,
      `Si <b>${escaparHtml(correo)}</b> tiene cuenta en metrics.bakano.ec, te llegó un código de 6 dígitos. Escríbelo aquí.\n\n` +
        `Vence en ${CODIGO_MINUTOS} minutos. ¿Correo equivocado? Escribe el correcto.`
    );
  }

  private async recibirCodigo(chat: ITelegramChat, texto: string): Promise<void> {
    const codigo = texto.replace(/\s/g, "");

    if (!chat.codigoHash || !chat.codigoExpira || chat.codigoExpira.getTime() < Date.now()) {
      return this.reiniciar(chat, "El código venció. Escribe tu correo otra vez y te mando uno nuevo.");
    }
    if (!/^\d{6}$/.test(codigo)) {
      await telegramService.sendMessage(chat.chatId, "El código tiene 6 dígitos. Revisa tu correo y escríbelo aquí.");
      return;
    }

    if (!mismoHash(hashCodigo(chat.chatId, codigo), chat.codigoHash)) {
      chat.codigoIntentos += 1;
      if (chat.codigoIntentos >= CODIGO_MAX_INTENTOS) {
        return this.reiniciar(chat, "Demasiados intentos. Escribe tu correo otra vez para recibir un código nuevo.");
      }
      await chat.save();
      const quedan = CODIGO_MAX_INTENTOS - chat.codigoIntentos;
      await telegramService.sendMessage(
        chat.chatId,
        `Código incorrecto. Te queda${quedan === 1 ? "" : "n"} ${quedan} intento${quedan === 1 ? "" : "s"}.`
      );
      return;
    }

    const usuario = await models.users.findOne({ email: chat.correoPendiente, isActive: true }).select("_id name").lean();
    if (!usuario) {
      return this.reiniciar(chat, "No encontré una cuenta activa con ese correo. Escribe tu correo otra vez.");
    }

    chat.userId = usuario._id as Types.ObjectId;
    chat.vinculadoEn = new Date();
    chat.correoPendiente = undefined;
    chat.codigoHash = undefined;
    chat.codigoExpira = undefined;
    chat.codigoIntentos = 0;
    await chat.save();

    const nombre = usuario.name ? `, ${escaparHtml(usuario.name.split(" ")[0])}` : "";
    await telegramService.sendMessage(chat.chatId, `Listo${nombre}. Tu cuenta quedó conectada.`);
    return this.pedirEntorno(chat);
  }

  // ── Botones ────────────────────────────────────────────────────────────────
  private async onBoton(chat: ITelegramChat, data: string): Promise<void> {
    if (!chat.userId) return this.reiniciar(chat, PEDIR_CORREO);

    if (data.startsWith("ws:")) return this.elegirEntorno(chat, data.slice(3));
    if (data === "menu:entorno") return this.pedirEntorno(chat);
    if (!chat.workspaceId) return this.pedirEntorno(chat);

    const tema = data.slice("menu:".length) as TemaAtencion;
    if (!data.startsWith("menu:") || !(tema in EQUIPO_ATENCION)) return this.mostrarMenu(chat);

    chat.tema = tema;
    await chat.save();

    const { etiqueta, personas } = EQUIPO_ATENCION[tema];
    let contexto = "";
    if (tema === "produccion") {
      const proxima = await this.proximaProduccion(chat.workspaceId);
      contexto = proxima
        ? `Tu próxima producción es el <b>${fechaEcuador(proxima)}</b>.\n\n`
        : "Todavía no tienes una producción agendada.\n\n";
    }
    await telegramService.sendMessage(
      chat.chatId,
      `${contexto}Para ${etiqueta} te atiende${personas.length > 1 ? "n" : ""} <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b>.\n\n` +
        "Escríbeme aquí qué necesitas y se lo paso ahora mismo."
    );
  }

  // ── Solicitudes al equipo ──────────────────────────────────────────────────
  private async proximaProduccion(workspaceId: Types.ObjectId): Promise<Date | null> {
    const proxima = await models.planning
      .findOne({ workspaceId, date: { $gte: new Date() }, title: { $not: /^CANCELADA/ } })
      .sort({ date: 1 })
      .select("date")
      .lean();
    return proxima?.date ?? null;
  }

  /** El mensaje del cliente llega por correo y en la plataforma a quien atiende el tema. */
  private async enviarSolicitud(chat: ITelegramChat, tema: TemaAtencion, texto: string): Promise<void> {
    const mensaje = texto.slice(0, 3000);
    const [workspace, cliente, internos, proxima] = await Promise.all([
      models.workspaces.findById(chat.workspaceId).select("name").lean(),
      models.users.findById(chat.userId).select("name lastName email").lean(),
      equipoAtencionService.usuarios(tema),
      tema === "produccion" ? this.proximaProduccion(chat.workspaceId!) : null,
    ]);
    const nombreEntorno = workspace?.name || "Cliente";
    const nombreCliente = [cliente?.name, cliente?.lastName].filter(Boolean).join(" ") || cliente?.email || "Cliente";
    const { etiqueta, personas } = EQUIPO_ATENCION[tema];

    const avisosInApp = await Promise.allSettled(
      internos.map((u) =>
        notificationService.create(
          u._id,
          "solicitud_cliente",
          `${nombreEntorno} escribió por Telegram · ${etiqueta}`,
          `${nombreCliente}: “${mensaje.slice(0, 280)}”`,
          { workspaceId: chat.workspaceId! }
        )
      )
    );

    let correoEnviado = false;
    try {
      await resendService.sendSolicitudClienteEmail({
        to: equipoAtencionService.correos(tema),
        tema: etiqueta,
        workspaceName: nombreEntorno,
        clienteNombre: nombreCliente,
        clienteEmail: cliente?.email,
        telegramUsername: chat.telegramUsername,
        mensaje,
        proximaProduccion: proxima ? fechaEcuador(proxima) : undefined,
      });
      correoEnviado = true;
    } catch (error) {
      console.error("[Telegram] no se pudo enviar el correo de la solicitud:", error);
    }

    // Solo se confirma al cliente si el mensaje llego por algun lado.
    if (!correoEnviado && !avisosInApp.some((r) => r.status === "fulfilled")) {
      await telegramService.sendMessage(
        chat.chatId,
        "No pude pasar tu mensaje ahora. Inténtalo de nuevo en unos minutos o escríbenos a soporte@bakano.ec."
      );
      return;
    }

    chat.tema = undefined;
    await chat.save();
    await telegramService.sendMessage(
      chat.chatId,
      `Listo. Le pasé tu mensaje a <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b>. ` +
        `${personas.length > 1 ? "Te van" : "Te va"} a contactar lo antes posible.`
    );
    return this.mostrarMenu(chat);
  }

  // ── Entornos ───────────────────────────────────────────────────────────────
  /** Entornos activos a los que el usuario tiene acceso. Se recalcula siempre: el acceso puede cambiar. */
  private async entornosDe(userId: Types.ObjectId): Promise<{ _id: Types.ObjectId; name: string }[]> {
    const usuario = await models.users.findById(userId).select("workspaceId workspaces isActive").lean();
    if (!usuario?.isActive) return [];
    const ids = [usuario.workspaceId, ...(usuario.workspaces || []).map((w) => w.workspaceId)].filter(Boolean);
    return models.workspaces
      .find({ _id: { $in: ids }, isActive: true })
      .select("_id name")
      .sort({ name: 1 })
      .lean() as Promise<{ _id: Types.ObjectId; name: string }[]>;
  }

  private async pedirEntorno(chat: ITelegramChat): Promise<void> {
    const entornos = await this.entornosDe(chat.userId!);

    if (entornos.length === 0) {
      chat.estado = "eligiendo_entorno";
      chat.workspaceId = undefined;
      await chat.save();
      await telegramService.sendMessage(
        chat.chatId,
        "Tu cuenta no tiene entornos activos. Escríbenos a soporte@bakano.ec y lo revisamos."
      );
      return;
    }

    if (entornos.length === 1) return this.fijarEntorno(chat, entornos[0]);

    chat.estado = "eligiendo_entorno";
    await chat.save();
    const botones: InlineButton[][] = entornos
      .slice(0, MAX_BOTONES_ENTORNO)
      .map((w) => [{ text: w.name, callback_data: `ws:${w._id.toString()}` }]);
    await telegramService.sendMessage(
      chat.chatId,
      `Tienes acceso a ${entornos.length} entornos. ¿Sobre cuál quieres hablar?`,
      botones
    );
  }

  private async elegirEntorno(chat: ITelegramChat, workspaceId: string): Promise<void> {
    // El callback_data viene del cliente: se valida contra el acceso real.
    const entorno = (await this.entornosDe(chat.userId!)).find((w) => w._id.toString() === workspaceId);
    if (!entorno) {
      await telegramService.sendMessage(chat.chatId, "Ese entorno ya no está disponible para tu cuenta.");
      return this.pedirEntorno(chat);
    }
    return this.fijarEntorno(chat, entorno);
  }

  private async fijarEntorno(chat: ITelegramChat, entorno: { _id: Types.ObjectId; name: string }): Promise<void> {
    chat.workspaceId = entorno._id;
    chat.tema = undefined;
    chat.estado = "listo";
    await chat.save();
    return this.mostrarMenu(chat, entorno.name);
  }

  private async mostrarMenu(chat: ITelegramChat, nombreEntorno?: string): Promise<void> {
    const nombre =
      nombreEntorno ?? (await models.workspaces.findById(chat.workspaceId).select("name").lean())?.name ?? "tu entorno";
    await telegramService.sendMessage(
      chat.chatId,
      `Estamos hablando de <b>${escaparHtml(nombre)}</b>. ¿En qué te ayudo?`,
      [
        [{ text: "Producciones", callback_data: "menu:produccion" }],
        [{ text: "Revisión de guiones", callback_data: "menu:guiones" }],
        [{ text: "Atención al cliente", callback_data: "menu:atencion" }],
        [{ text: "Cambiar de entorno", callback_data: "menu:entorno" }],
      ]
    );
  }

  private async reiniciar(chat: ITelegramChat, mensaje: string): Promise<void> {
    chat.estado = "esperando_correo";
    chat.userId = undefined;
    chat.workspaceId = undefined;
    chat.tema = undefined;
    chat.correoPendiente = undefined;
    chat.codigoHash = undefined;
    chat.codigoExpira = undefined;
    chat.codigoIntentos = 0;
    await chat.save();
    await telegramService.sendMessage(chat.chatId, mensaje);
  }
}

export const telegramBotService = new TelegramBotService();
