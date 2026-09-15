import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import type { NotificationType } from "../models/notification.model";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { ghlService } from "./ghl.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { escaparHtml, telegramService, type InlineButton, type TelegramUpdate } from "./telegram.service";

const TZ = "America/Guayaquil";

function fechaEcuador(fecha: Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: TZ,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  }).format(fecha);
}

/** "jue 18 · 10:30", para que el horario quepa en un boton. */
function horarioCorto(fecha: Date): string {
  const dia = new Intl.DateTimeFormat("es-EC", { timeZone: TZ, weekday: "short", day: "numeric" }).format(fecha);
  const hora = new Intl.DateTimeFormat("es-EC", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(fecha);
  return `${dia} · ${hora}`;
}

function diaEcuador(fecha: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(fecha);
}

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODIGO_MINUTOS = 10;
const CODIGO_MAX_INTENTOS = 5;
const REENVIO_SEGUNDOS = 60;
// Un boton por entorno; el equipo interno ve decenas y Telegram se vuelve ilegible.
const MAX_BOTONES_ENTORNO = 30;
const DIAS_AGENDA = 7;
const MAX_HORARIOS = 8;
// Nadie agenda para dentro de 10 minutos: el equipo necesita margen.
const ANTICIPACION_MS = 2 * 3_600_000;
const BLOQUEO_AGENDA_MS = 60_000;

const EMOJI_TEMA: Record<TemaAtencion, string> = { produccion: "🎬", guiones: "📝", atencion: "🤝" };

const PEDIR_CORREO =
  "¡Hola! 👋 Qué gusto tenerte por aquí. Soy tu asistente de <b>Bakano</b> 💛\n\n" +
  "Conmigo puedes:\n" +
  "🎬 Ver y coordinar tus producciones\n" +
  "📝 Comentar la revisión de tus guiones\n" +
  "📅 Agendar una reunión directo con tu equipo\n" +
  "📩 Escribirle a quien te atiende (le llega a su correo al instante)\n\n" +
  "Para empezar, escríbeme el correo con el que entras a <b>metrics.bakano.ec</b> ✨";

interface DatosCliente {
  entorno: string;
  nombre: string;
  firstName?: string;
  lastName?: string;
  email?: string;
}

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
 *
 * Ya conectado, el cliente elige un tema: su siguiente mensaje le llega a
 * quien lo atiende, o agenda una reunion en el calendario del CRM.
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
      if (chat.estado === "listo" && chat.workspaceId) {
        const nombre = chat.firstName ? `, ${escaparHtml(chat.firstName)}` : "";
        return this.mostrarMenu(chat, undefined, `¡Hola de nuevo${nombre}! 👋 Qué bueno verte.`);
      }
      if (chat.userId) return this.pedirEntorno(chat);
      return this.reiniciar(chat, PEDIR_CORREO);
    }
    if (comando === "/salir") {
      return this.reiniciar(
        chat,
        "Listo, desconecté tu cuenta de este chat 👋 Cuando quieras volver, escribe /start. ¡Aquí te espero! 💛"
      );
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
        return this.mostrarMenu(
          chat,
          undefined,
          "¡Te leo! 😊 Para pasarle tu mensaje a la persona correcta, elige primero el tema:"
        );
    }
  }

  private async recibirCorreo(chat: ITelegramChat, texto: string): Promise<void> {
    const correo = texto.toLowerCase();
    if (!CORREO_RE.test(correo)) {
      await telegramService.sendMessage(
        chat.chatId,
        "¡Con muchísimo gusto te ayudo con eso! 😊\n\n" +
          "Pero antes necesito saber quién eres, para mostrarte <b>tu</b> información y no la de otra persona 🔐\n\n" +
          "👉 Escríbeme el correo con el que entras a <b>metrics.bakano.ec</b>\n" +
          "Por ejemplo: <i>nombre@tuempresa.com</i>\n\n" +
          "Te llega un código y en menos de un minuto estamos conectados ✨"
      );
      return;
    }

    if (chat.codigoEnviadoEn && Date.now() - chat.codigoEnviadoEn.getTime() < REENVIO_SEGUNDOS * 1000) {
      await telegramService.sendMessage(
        chat.chatId,
        "¡Ya te mandé un código hace un momentito! 📬 Revisa tu bandeja (y el spam, por si acaso). Si no llega, espera un minuto y vuelve a escribir tu correo."
      );
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
      `¡Perfecto! 📬 Si <b>${escaparHtml(correo)}</b> tiene cuenta en metrics.bakano.ec, te acabo de enviar un código de 6 dígitos.\n\n` +
        `Escríbelo aquí 👇 (vence en ${CODIGO_MINUTOS} minutos). ¿Te equivocaste de correo? Solo escribe el correcto.`
    );
  }

  private async recibirCodigo(chat: ITelegramChat, texto: string): Promise<void> {
    const codigo = texto.replace(/\s/g, "");

    if (!chat.codigoHash || !chat.codigoExpira || chat.codigoExpira.getTime() < Date.now()) {
      return this.reiniciar(chat, "Ese código ya venció ⌛ Escríbeme tu correo otra vez y te mando uno nuevo al toque.");
    }
    if (!/^\d{6}$/.test(codigo)) {
      await telegramService.sendMessage(chat.chatId, "El código tiene 6 números 🔢 Búscalo en tu correo y escríbelo aquí.");
      return;
    }

    if (!mismoHash(hashCodigo(chat.chatId, codigo), chat.codigoHash)) {
      chat.codigoIntentos += 1;
      if (chat.codigoIntentos >= CODIGO_MAX_INTENTOS) {
        return this.reiniciar(
          chat,
          "Hubo demasiados intentos, así que por seguridad lo reinicié 🔒 Escríbeme tu correo otra vez y te mando un código nuevo."
        );
      }
      await chat.save();
      const quedan = CODIGO_MAX_INTENTOS - chat.codigoIntentos;
      await telegramService.sendMessage(
        chat.chatId,
        `Ups, ese código no coincide 😅 Te queda${quedan === 1 ? "" : "n"} ${quedan} intento${quedan === 1 ? "" : "s"}.`
      );
      return;
    }

    const usuario = await models.users.findOne({ email: chat.correoPendiente, isActive: true }).select("_id name").lean();
    if (!usuario) {
      return this.reiniciar(
        chat,
        "No encontré una cuenta activa con ese correo 🤔 Escríbelo otra vez o pídenos ayuda en soporte@bakano.ec."
      );
    }

    chat.userId = usuario._id as Types.ObjectId;
    chat.vinculadoEn = new Date();
    chat.correoPendiente = undefined;
    chat.codigoHash = undefined;
    chat.codigoExpira = undefined;
    chat.codigoIntentos = 0;
    await chat.save();

    const nombre = usuario.name ? `, ${escaparHtml(usuario.name.split(" ")[0])}` : "";
    await telegramService.sendMessage(chat.chatId, `¡Listo${nombre}! 🎉 Tu cuenta quedó conectada. Qué bueno tenerte aquí.`);
    return this.pedirEntorno(chat);
  }

  // ── Botones ────────────────────────────────────────────────────────────────
  private async onBoton(chat: ITelegramChat, data: string): Promise<void> {
    if (!chat.userId) return this.reiniciar(chat, PEDIR_CORREO);

    if (data.startsWith("ws:")) return this.elegirEntorno(chat, data.slice(3));
    if (data === "menu:entorno") return this.pedirEntorno(chat);
    if (!chat.workspaceId) return this.pedirEntorno(chat);

    if (data === "menu:agendar") return this.elegirTemaReunion(chat);

    const [accion, tema, extra] = data.split(":") as [string, TemaAtencion, string | undefined];
    if (!(tema in EQUIPO_ATENCION)) return this.mostrarMenu(chat);

    if (accion === "menu") return this.elegirTema(chat, tema);
    if (accion === "ag") return this.mostrarHorarios(chat, tema);
    if (accion === "slot" && extra) return this.agendar(chat, tema, extra);
    return this.mostrarMenu(chat);
  }

  private async elegirTema(chat: ITelegramChat, tema: TemaAtencion): Promise<void> {
    chat.tema = tema;
    await chat.save();

    const { etiqueta, personas } = EQUIPO_ATENCION[tema];
    let contexto = "";
    if (tema === "produccion") {
      const proxima = await this.proximaProduccion(chat.workspaceId!);
      contexto = proxima
        ? `🎬 Tu próxima producción es el <b>${fechaEcuador(proxima)}</b>.\n\n`
        : "🎬 Todavía no tienes una producción agendada.\n\n";
    }
    await telegramService.sendMessage(
      chat.chatId,
      `${contexto}${EMOJI_TEMA[tema]} Para ${etiqueta} te atiende${personas.length > 1 ? "n" : ""} <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> 💛\n\n` +
        "Cuéntame qué necesitas y se lo paso ahora mismo a su correo 📩\n\n" +
        "¿Prefieres hablarlo en persona? Toca abajo 👇",
      [[{ text: "📅 Agendar una reunión", callback_data: `ag:${tema}` }]]
    );
  }

  // ── Reuniones ──────────────────────────────────────────────────────────────
  private async elegirTemaReunion(chat: ITelegramChat): Promise<void> {
    const botones: InlineButton[][] = (Object.keys(EQUIPO_ATENCION) as TemaAtencion[]).map((tema) => [
      {
        text: `${EMOJI_TEMA[tema]} ${equipoAtencionService.nombres(tema)}`,
        callback_data: `ag:${tema}`,
      },
    ]);
    await telegramService.sendMessage(
      chat.chatId,
      "📅 ¡Claro que sí! Me encanta que quieras hablar directo con nosotros 🙌\n\n" +
        "Lo dejo agendado en el calendario del equipo y les aviso a su correo. ¿Con quién te quieres reunir?\n\n" +
        "🎬 Producción · 📝 Guiones · 🤝 Atención",
      botones
    );
  }

  private async mostrarHorarios(chat: ITelegramChat, tema: TemaAtencion, aviso?: string): Promise<void> {
    const { calendarioId } = EQUIPO_ATENCION[tema];
    if (!calendarioId || !ghlService.isConfigured()) return this.coordinarPorCorreo(chat, tema, aviso);

    let horarios: Date[] = [];
    try {
      const desde = new Date(Date.now() + ANTICIPACION_MS);
      horarios = await ghlService.getFreeSlots(calendarioId, desde, new Date(desde.getTime() + DIAS_AGENDA * 86_400_000));
    } catch (error: any) {
      console.error("[Telegram] horarios del CRM:", error.response?.data || error.message);
    }
    if (!horarios.length) {
      return this.coordinarPorCorreo(chat, tema, "No encontré horarios libres esta semana en su calendario 😅");
    }

    // Hasta dos por dia (el primero y uno a mitad de jornada) para ofrecer variedad.
    const porDia = new Map<string, Date[]>();
    for (const h of horarios) porDia.set(diaEcuador(h), [...(porDia.get(diaEcuador(h)) ?? []), h]);
    const elegidos = [...porDia.values()]
      .flatMap((dia) => [...new Set([dia[0], dia[Math.floor(dia.length / 2)]])])
      .slice(0, MAX_HORARIOS);

    const botones: InlineButton[][] = [];
    for (let i = 0; i < elegidos.length; i += 2) {
      botones.push(
        elegidos.slice(i, i + 2).map((h) => ({
          text: `🗓️ ${horarioCorto(h)}`,
          callback_data: `slot:${tema}:${Math.floor(h.getTime() / 1000)}`,
        }))
      );
    }
    botones.push([{ text: "✍️ Prefiero escribirles", callback_data: `menu:${tema}` }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${aviso ? `${aviso}\n\n` : ""}¡Genial! 🙌 Estos son los próximos horarios libres de <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> (hora Ecuador).\n\nElige el que mejor te quede 👇`,
      botones
    );
  }

  /** Sin calendario propio (produccion) o sin horarios: la reunion se coordina por correo. */
  private async coordinarPorCorreo(chat: ITelegramChat, tema: TemaAtencion, aviso?: string): Promise<void> {
    chat.tema = tema;
    await chat.save();
    const { etiqueta, personas } = EQUIPO_ATENCION[tema];
    await telegramService.sendMessage(
      chat.chatId,
      `${aviso ? `${aviso}\n\n` : ""}${EMOJI_TEMA[tema]} Para ${etiqueta} te atiende${personas.length > 1 ? "n" : ""} <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> 💪\n\n` +
        "Cuéntame qué día y hora te quedan mejor, y de qué quieres hablar. Se lo paso ahora mismo a su correo para que coordinen contigo 📩"
    );
  }

  private async agendar(chat: ITelegramChat, tema: TemaAtencion, segundos: string): Promise<void> {
    const { calendarioId, etiqueta } = EQUIPO_ATENCION[tema];
    const inicio = new Date(Number(segundos) * 1000);
    if (!calendarioId || Number.isNaN(inicio.getTime())) return this.mostrarHorarios(chat, tema);
    if (inicio.getTime() < Date.now()) return this.mostrarHorarios(chat, tema, "Ese horario ya pasó ⌛ Te muestro los que siguen libres.");

    const tomado = await models.telegramChats.findOneAndUpdate(
      {
        _id: chat._id,
        $or: [{ agendandoDesde: { $exists: false } }, { agendandoDesde: null }, { agendandoDesde: { $lt: new Date(Date.now() - BLOQUEO_AGENDA_MS) } }],
      },
      { $set: { agendandoDesde: new Date() } }
    );
    if (!tomado) {
      await telegramService.sendMessage(chat.chatId, "Estoy terminando de agendar tu reunión ⏳ Dame un segundito.");
      return;
    }

    try {
      await telegramService.sendMessage(chat.chatId, "⏳ Un segundito, estoy reservando tu reunión...");
      const cliente = await this.datosCliente(chat);

      let citaId: string | null = null;
      try {
        // El horario pudo ocuparse mientras el cliente elegia.
        const libres = await ghlService.getFreeSlots(calendarioId, new Date(inicio.getTime() - 60_000), new Date(inicio.getTime() + 86_400_000));
        if (libres.some((h) => h.getTime() === inicio.getTime()) && cliente.email) {
          const contactId = await ghlService.upsertContact({
            email: cliente.email,
            firstName: cliente.firstName,
            lastName: cliente.lastName,
            companyName: cliente.entorno,
          });
          citaId = await ghlService.createAppointment({
            calendarId: calendarioId,
            contactId,
            startTime: inicio,
            title: `${cliente.entorno} · Reunión de ${etiqueta} (Telegram)`,
          });
        }
      } catch (error: any) {
        console.error("[Telegram] no se pudo agendar en el CRM:", error.response?.data || error.message);
      }

      if (!citaId) {
        return this.mostrarHorarios(chat, tema, "Uy, no pude reservar ese horario 😕 Puede que alguien lo haya tomado justo ahora.");
      }

      const cuando = fechaEcuador(inicio);
      const nombres = equipoAtencionService.nombres(tema);
      await this.avisarEquipo(chat, tema, cliente, {
        tipo: "reunion_agendada",
        titulo: `${cliente.entorno} agendó una reunión · ${cuando}`,
        cuerpo: `${cliente.nombre} agendó por Telegram una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        mensaje: `📅 Agendó una reunión de ${etiqueta} para el ${cuando} (hora Ecuador). Ya está en el calendario del CRM.`,
        asunto: `📅 ${cliente.entorno} agendó una reunión contigo · ${cuando}`,
        encabezado: `${cliente.entorno} agendó una reunión`,
      });

      await telegramService.sendMessage(
        chat.chatId,
        "¡Listo, quedó agendada! 🎉\n\n" +
          `📅 <b>${cuando}</b> (hora Ecuador)\n` +
          `👤 Con <b>${escaparHtml(nombres)}</b>\n\n` +
          "Ya está en su calendario y le avisé a su correo. ¡Nos vemos pronto! 💛"
      );
      return this.mostrarMenu(chat, undefined, "¿Te ayudo con algo más? 😊");
    } finally {
      await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { agendandoDesde: 1 } });
    }
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

  private async datosCliente(chat: ITelegramChat): Promise<DatosCliente> {
    const [workspace, cliente] = await Promise.all([
      models.workspaces.findById(chat.workspaceId).select("name").lean(),
      models.users.findById(chat.userId).select("name lastName email").lean(),
    ]);
    return {
      entorno: workspace?.name || "Cliente",
      nombre: [cliente?.name, cliente?.lastName].filter(Boolean).join(" ") || cliente?.email || "Cliente",
      firstName: cliente?.name,
      lastName: cliente?.lastName,
      email: cliente?.email,
    };
  }

  /** Correo + notificacion in-app a quien atiende el tema. true si llego por algun lado. */
  private async avisarEquipo(
    chat: ITelegramChat,
    tema: TemaAtencion,
    cliente: DatosCliente,
    aviso: { tipo: NotificationType; titulo: string; cuerpo: string; mensaje: string; asunto?: string; encabezado?: string }
  ): Promise<boolean> {
    const { etiqueta } = EQUIPO_ATENCION[tema];
    const [internos, proxima] = await Promise.all([
      equipoAtencionService.usuarios(tema),
      tema === "produccion" ? this.proximaProduccion(chat.workspaceId!) : null,
    ]);

    const avisosInApp = await Promise.allSettled(
      internos.map((u) => notificationService.create(u._id, aviso.tipo, aviso.titulo, aviso.cuerpo, { workspaceId: chat.workspaceId! }))
    );

    let correoEnviado = false;
    try {
      await resendService.sendSolicitudClienteEmail({
        to: equipoAtencionService.correos(tema),
        tema: etiqueta,
        workspaceName: cliente.entorno,
        clienteNombre: cliente.nombre,
        clienteEmail: cliente.email,
        telegramUsername: chat.telegramUsername,
        mensaje: aviso.mensaje,
        proximaProduccion: proxima ? fechaEcuador(proxima) : undefined,
        asunto: aviso.asunto,
        encabezado: aviso.encabezado,
      });
      correoEnviado = true;
    } catch (error) {
      console.error("[Telegram] no se pudo enviar el correo al equipo:", error);
    }

    return correoEnviado || avisosInApp.some((r) => r.status === "fulfilled");
  }

  /** El mensaje del cliente llega por correo y en la plataforma a quien atiende el tema. */
  private async enviarSolicitud(chat: ITelegramChat, tema: TemaAtencion, texto: string): Promise<void> {
    const mensaje = texto.slice(0, 3000);
    const cliente = await this.datosCliente(chat);
    const { etiqueta, personas } = EQUIPO_ATENCION[tema];

    const entregado = await this.avisarEquipo(chat, tema, cliente, {
      tipo: "solicitud_cliente",
      titulo: `${cliente.entorno} escribió por Telegram · ${etiqueta}`,
      cuerpo: `${cliente.nombre}: “${mensaje.slice(0, 280)}”`,
      mensaje,
    });

    // Solo se confirma al cliente si el mensaje llego por algun lado.
    if (!entregado) {
      await telegramService.sendMessage(
        chat.chatId,
        "Uy, no pude enviar tu mensaje ahora mismo 😕 Inténtalo de nuevo en unos minutos o escríbenos a soporte@bakano.ec."
      );
      return;
    }

    chat.tema = undefined;
    await chat.save();
    await telegramService.sendMessage(
      chat.chatId,
      `¡Listo! ✅ Le pasé tu mensaje a <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b>. ` +
        `${personas.length > 1 ? "Te van" : "Te va"} a contactar lo antes posible 💛`
    );
    return this.mostrarMenu(chat, undefined, "¿Te ayudo con algo más? 😊");
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
        "Tu cuenta todavía no tiene entornos activos 😕 Escríbenos a soporte@bakano.ec y lo resolvemos contigo."
      );
      return;
    }

    if (entornos.length === 1) return this.fijarEntorno(chat, entornos[0]);

    chat.estado = "eligiendo_entorno";
    await chat.save();
    const botones: InlineButton[][] = entornos
      .slice(0, MAX_BOTONES_ENTORNO)
      .map((w) => [{ text: w.name, callback_data: `ws:${w._id.toString()}` }]);
    await telegramService.sendMessage(chat.chatId, `Tienes ${entornos.length} entornos 🙌 ¿De cuál quieres hablar hoy?`, botones);
  }

  private async elegirEntorno(chat: ITelegramChat, workspaceId: string): Promise<void> {
    // El callback_data viene del cliente: se valida contra el acceso real.
    const entorno = (await this.entornosDe(chat.userId!)).find((w) => w._id.toString() === workspaceId);
    if (!entorno) {
      await telegramService.sendMessage(chat.chatId, "Ese entorno ya no está disponible para tu cuenta 😕 Elige otro:");
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

  private async mostrarMenu(chat: ITelegramChat, nombreEntorno?: string, saludo?: string): Promise<void> {
    const nombre =
      nombreEntorno ?? (await models.workspaces.findById(chat.workspaceId).select("name").lean())?.name ?? "tu entorno";
    await telegramService.sendMessage(
      chat.chatId,
      `${saludo ? `${saludo}\n\n` : ""}Estamos hablando de <b>${escaparHtml(nombre)}</b> 💛 ¿En qué te ayudo hoy?\n\n` +
        "💬 ¿Quieres hablar directo con nosotros? Toca <b>Agendar una reunión</b> y lo dejo en el calendario del equipo, o elige un tema y tu mensaje les llega a su correo.",
      [
        [{ text: "🎬 Producciones", callback_data: "menu:produccion" }],
        [{ text: "📝 Revisión de guiones", callback_data: "menu:guiones" }],
        [{ text: "🤝 Atención al cliente", callback_data: "menu:atencion" }],
        [{ text: "📅 Agendar una reunión", callback_data: "menu:agendar" }],
        [{ text: "🔄 Cambiar de entorno", callback_data: "menu:entorno" }],
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
