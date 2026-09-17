import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { resendService } from "./resend.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { atencionClienteService, diaEcuador, fechaEcuador, horarioCorto } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { perfilClienteService } from "./perfilCliente.service";
import { SESIONES_ONBOARDING, type SesionOnboarding } from "./onboardingSesiones.service";
import { telegramAgentService } from "./telegramAgent.service";
import { escaparHtml, telegramService, type InlineButton, type TelegramUpdate } from "./telegram.service";

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODIGO_MINUTOS = 10;
const CODIGO_MAX_INTENTOS = 5;
const REENVIO_SEGUNDOS = 60;
// Un boton por entorno; el equipo interno ve decenas y Telegram se vuelve ilegible.
const MAX_BOTONES_ENTORNO = 30;
const MAX_HORARIOS = 8;

const EMOJI_TEMA: Record<TemaAtencion, string> = { produccion: "🎬", guiones: "📝", atencion: "🤝" };

const PEDIR_CORREO =
  "Holaaa 👋 qué gusto tenerte por aquí. Soy tu asistente de <b>Bakano</b>\n\n" +
  "Conmigo puedes:\n" +
  "🎬 Ver y coordinar tus producciones\n" +
  "📝 Comentar la revisión de tus guiones\n" +
  "📅 Agendar una reunión directo con tu equipo\n" +
  "📩 Escribirle a quien te atiende (le llega a su correo al instante)\n\n" +
  "Para empezar, escríbeme el correo con el que entras a <b>metrics.bakano.ec</b> ✨";

function hashCodigo(chatId: number, codigo: string): string {
  // El secreto del webhook sirve de pimienta: sin el, el hash de 6 digitos se rompe en segundos.
  return createHash("sha256")
    .update(`${chatId}:${codigo}:${process.env.TELEGRAM_WEBHOOK_SECRET || ""}`)
    .digest("hex");
}

/**
 * Palabra de seguridad para que el cliente borre su historial con el bot.
 * Se guarda el sha256, no la palabra: el repo no la deja en texto plano.
 * TELEGRAM_BORRAR_HISTORIAL_HASH permite cambiarla sin tocar codigo.
 */
const HASH_PALABRA_BORRAR = "22a4a9f9bf19b9e349054789a4e05179b5aac108ac250cc6acad5887b5d53672";

function esPalabraBorrarHistorial(texto: string): boolean {
  const hash = createHash("sha256").update(texto.trim().toLowerCase()).digest("hex");
  return mismoHash(hash, process.env.TELEGRAM_BORRAR_HISTORIAL_HASH || HASH_PALABRA_BORRAR);
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
 * Ya conectado, lo que el cliente escribe libre lo contesta la IA
 * (telegramAgent.service). El menu sigue ahi para quien prefiera botones y
 * como respaldo si la IA falla.
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

    if (esPalabraBorrarHistorial(texto)) return this.borrarHistorial(chat);

    if (comando === "/start") {
      if (chat.estado === "listo" && chat.workspaceId) {
        const nombre = chat.firstName ? `, ${escaparHtml(chat.firstName)}` : "";
        return this.mostrarMenu(chat, undefined, `Hola de nuevo${nombre}! 👋 Qué bueno verte.`);
      }
      if (chat.userId) return this.pedirEntorno(chat);
      return this.reiniciar(chat, PEDIR_CORREO);
    }
    if (comando === "/salir") {
      return this.reiniciar(
        chat,
        "Listo, desconecté tu cuenta de este chat 👋 Cuando quieras volver, escribe /start. Aquí te espero! 💛"
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
        // Eligio un tema en el menu: su mensaje va directo a esa persona.
        if (chat.tema && chat.workspaceId) return this.enviarSolicitud(chat, chat.tema, texto);
        if (chat.workspaceId && (await telegramAgentService.responder(chat, texto))) return;
        return this.mostrarMenu(
          chat,
          undefined,
          "Te leo! 😊 Para pasarle tu mensaje a la persona correcta, elige primero el tema:"
        );
    }
  }

  private async recibirCorreo(chat: ITelegramChat, texto: string): Promise<void> {
    const correo = texto.toLowerCase();
    if (!CORREO_RE.test(correo)) {
      await telegramService.sendMessage(
        chat.chatId,
        "Con muchísimo gusto te ayudo con eso! 😊\n\n" +
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
        "Ya te mandé un código hace un momentito! 📬 Revisa tu bandeja (y el spam, por si acaso). Si no llega, espera un minuto y vuelve a escribir tu correo."
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
      `Perfecto! 📬 Si <b>${escaparHtml(correo)}</b> tiene cuenta en metrics.bakano.ec, te acabo de enviar un código de 6 dígitos.\n\n` +
        `Escríbelo aquí 👇 (vence en ${CODIGO_MINUTOS} minutos). Te equivocaste de correo? Solo escribe el correcto.`
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
    await telegramService.sendMessage(chat.chatId, `Listo${nombre}! 🎉 Tu cuenta quedó conectada. Qué bueno tenerte aquí.`);
    return this.pedirEntorno(chat);
  }

  // ── Botones ────────────────────────────────────────────────────────────────
  private async onBoton(chat: ITelegramChat, data: string): Promise<void> {
    if (!chat.userId) return this.reiniciar(chat, PEDIR_CORREO);

    if (data.startsWith("ws:")) return this.elegirEntorno(chat, data.slice(3));
    if (data === "menu:entorno") return this.pedirEntorno(chat);
    if (!chat.workspaceId) return this.pedirEntorno(chat);

    if (data === "menu:ver") {
      chat.tema = undefined;
      await chat.save();
      return this.mostrarMenu(chat);
    }
    if (data === "menu:agendar") return this.elegirTemaReunion(chat);
    if (data === "menu:onboarding") return this.mostrarOnboarding(chat);
    if (data.startsWith("onb:")) return this.mostrarHorariosOnboarding(chat, data.slice(4) as SesionOnboarding);
    if (data.startsWith("onbs:")) {
      const [, sesion, segundos] = data.split(":");
      return this.agendarOnboarding(chat, sesion as SesionOnboarding, segundos);
    }

    if (data.startsWith("prod:")) return this.agendarProduccion(chat, data.slice(5));

    const [accion, tema, extra] = data.split(":") as [string, TemaAtencion, string | undefined];
    if (!(tema in EQUIPO_ATENCION)) return this.mostrarMenu(chat);

    if (accion === "menu") return this.elegirTema(chat, tema);
    if (accion === "ag") return tema === "produccion" ? this.mostrarHorariosProduccion(chat) : this.mostrarHorarios(chat, tema);
    if (accion === "slot" && extra) return this.agendar(chat, tema, extra);
    return this.mostrarMenu(chat);
  }

  private async elegirTema(chat: ITelegramChat, tema: TemaAtencion): Promise<void> {
    chat.tema = tema;
    await chat.save();

    const { etiqueta, personas } = EQUIPO_ATENCION[tema];
    let contexto = "";
    if (tema === "produccion") {
      const proxima = await atencionClienteService.proximaProduccion(chat.workspaceId!);
      contexto = proxima
        ? `🎬 Tu próxima producción es el <b>${fechaEcuador(proxima)}</b>.\n\n`
        : "🎬 Todavía no tienes una producción agendada.\n\n";
    }
    await telegramService.sendMessage(
      chat.chatId,
      `${contexto}${EMOJI_TEMA[tema]} Para ${etiqueta} te atiende${personas.length > 1 ? "n" : ""} <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> 💛\n\n` +
        "Cuéntame qué necesitas y se lo paso ahora mismo a su correo 📩\n\n" +
        "Prefieres hablarlo en persona? Toca abajo 👇",
      [
        [{ text: tema === "produccion" ? "🎬 Agendar mi producción" : "📅 Agendar una reunión", callback_data: `ag:${tema}` }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  // ── Reuniones ──────────────────────────────────────────────────────────────
  private async elegirTemaReunion(chat: ITelegramChat): Promise<void> {
    const botones: InlineButton[][] = (Object.keys(EQUIPO_ATENCION) as TemaAtencion[]).map((tema) => [
      { text: `${EMOJI_TEMA[tema]} ${equipoAtencionService.nombres(tema)}`, callback_data: `ag:${tema}` },
    ]);
    await telegramService.sendMessage(
      chat.chatId,
      "📅 Claro que sí! Me encanta que quieras hablar directo con nosotros 🙌\n\n" +
        "Lo dejo agendado en el calendario del equipo y les aviso a su correo. Con quién te quieres reunir?\n\n" +
        "🎬 Producción · 📝 Guiones · 🤝 Atención",
      botones
    );
  }

  private async mostrarHorarios(chat: ITelegramChat, tema: TemaAtencion, aviso?: string): Promise<void> {
    const horarios = await atencionClienteService.horariosLibres(tema);
    if (horarios === null) return this.coordinarPorCorreo(chat, tema, aviso);
    if (!horarios.length) {
      return this.coordinarPorCorreo(chat, tema, "No encontré horarios libres esta semana en su calendario 😅");
    }

    const botones = this.botonesHorarios(horarios, (h) => `slot:${tema}:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "✍️ Prefiero escribirles", callback_data: `menu:${tema}` }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${aviso ? `${aviso}\n\n` : ""}Genial! 🙌 Estos son los próximos horarios libres de <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> (hora Ecuador).\n\nElige el que mejor te quede 👇`,
      botones
    );
  }

  /** Hasta dos horarios por dia (el primero y uno a mitad de jornada), en filas de dos. */
  private botonesHorarios(horarios: Date[], callback: (h: Date) => string): InlineButton[][] {
    const porDia = new Map<string, Date[]>();
    for (const h of horarios) porDia.set(diaEcuador(h), [...(porDia.get(diaEcuador(h)) ?? []), h]);
    const elegidos = [...porDia.values()]
      .flatMap((dia) => [...new Set([dia[0], dia[Math.floor(dia.length / 2)]])])
      .slice(0, MAX_HORARIOS);

    const botones: InlineButton[][] = [];
    for (let i = 0; i < elegidos.length; i += 2) {
      botones.push(elegidos.slice(i, i + 2).map((h) => ({ text: `🗓️ ${horarioCorto(h)}`, callback_data: callback(h) })));
    }
    return botones;
  }

  // ── Onboarding ─────────────────────────────────────────────────────────────
  /** En que paso va el cliente, con botones para agendar lo que falte. */
  private async mostrarOnboarding(chat: ITelegramChat): Promise<void> {
    const estado = await onboardingBotService.estado(chat.workspaceId!);
    const lineas = estado.sesiones.map((s) =>
      s.agendada
        ? `✅ ${s.emoji} ${s.etiqueta} · con ${escaparHtml(s.responsable)}\n     ${s.fecha ? fechaEcuador(s.fecha) : "agendada"}`
        : `⬜ ${s.emoji} ${s.etiqueta} · con ${escaparHtml(s.responsable)}`
    );
    const produccion = estado.produccion.agendada
      ? `✅ 🎬 Producción · ${fechaEcuador(estado.produccion.agendada)}`
      : estado.completo
        ? "⬜ 🎬 Producción · agéndala cuando quieras"
        : "⬜ 🎬 Producción · después de tus sesiones";

    const botones: InlineButton[][] = estado.sesiones
      .filter((s) => !s.agendada)
      .map((s) => [{ text: `📅 Agendar ${s.etiqueta}`, callback_data: `onb:${s.sesion}` }]);
    if (estado.completo && estado.produccion.puedeAgendar) {
      botones.push([{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }]);
    }
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const siguiente = estado.sesiones.find((s) => s.sesion === estado.siguiente);
    await telegramService.sendMessage(
      chat.chatId,
      "🚀 <b>Así va tu onboarding</b>\n\n" +
        `${lineas.join("\n")}\n${produccion}\n\n` +
        (siguiente
          ? `Lo que sigue es <b>${siguiente.etiqueta}</b> con <b>${escaparHtml(siguiente.responsable)}</b>.\n${siguiente.resumen}\n\nPara esa sesión necesitas:\n${siguiente.requisitos.map((r) => `• ${r}`).join("\n")}`
          : "Ya tienes todas tus sesiones agendadas 🎉 cualquier duda me escribes."),
      botones
    );
  }

  private async mostrarHorariosOnboarding(chat: ITelegramChat, sesion: SesionOnboarding, aviso?: string): Promise<void> {
    if (!(sesion in SESIONES_ONBOARDING)) return this.mostrarOnboarding(chat);
    const def = SESIONES_ONBOARDING[sesion];
    const horarios = await onboardingBotService.horarios(sesion);
    const intro = aviso ? `${aviso}\n\n` : "";

    if (!horarios || !horarios.length) {
      await telegramService.sendMessage(
        chat.chatId,
        `${intro}${def.emoji} No pude ver los horarios de <b>${escaparHtml(def.responsable.nombre)}</b> ahora mismo 😅\n\n` +
          `Puedes agendar desde aquí: ${def.link}\n\nO cuéntame qué día te queda mejor y se lo paso.`
      );
      chat.tema = "atencion";
      await chat.save();
      return;
    }

    const botones = this.botonesHorarios(horarios, (h) => `onbs:${sesion}:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "🔗 Prefiero el link", callback_data: `onb:${sesion}` }, { text: "📋 Menú", callback_data: "menu:ver" }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${intro}${def.emoji} <b>${def.etiqueta}</b> con <b>${escaparHtml(def.responsable.nombre)}</b>\n\n` +
        `${def.resumen}\n\nAntes de la sesión ten listo:\n${def.requisitos.map((r) => `• ${r}`).join("\n")}\n\n` +
        "Elige el horario que te quede mejor 👇",
      botones
    );
  }

  private async agendarOnboarding(chat: ITelegramChat, sesion: SesionOnboarding, segundos: string): Promise<void> {
    if (!(sesion in SESIONES_ONBOARDING)) return this.mostrarOnboarding(chat);
    const inicio = new Date(Number(segundos) * 1000);
    if (Number.isNaN(inicio.getTime())) return this.mostrarHorariosOnboarding(chat, sesion);

    await telegramService.sendMessage(chat.chatId, "⏳ Un segundito, estoy agendando tu sesión...");
    const r = await onboardingBotService.agendar(chat, sesion, inicio);

    if (!r.ok) {
      if (r.motivo === "ya_agendada") return this.mostrarOnboarding(chat);
      if (r.motivo === "ocupado") {
        return this.mostrarHorariosOnboarding(chat, sesion, "Uy, ese horario lo tomaron justo ahora 😕");
      }
      const def = SESIONES_ONBOARDING[sesion];
      await telegramService.sendMessage(
        chat.chatId,
        `No pude agendarlo desde aquí 😕 agéndalo en este link y quedamos listos: ${def.link}`
      );
      return;
    }

    const def = SESIONES_ONBOARDING[sesion];
    await telegramService.sendMessage(
      chat.chatId,
      `Listo, quedó agendada 🎉\n\n${def.emoji} <b>${def.etiqueta}</b>\n📅 <b>${r.cuando}</b> (hora Ecuador)\n👤 Con <b>${escaparHtml(r.responsable)}</b>\n\n` +
        `Ya le avisé. Recuerda tener listo:\n${def.requisitos.map((x) => `• ${x}`).join("\n")}`
    );
    return this.mostrarOnboarding(chat);
  }

  // ── Produccion ─────────────────────────────────────────────────────────────
  private async mostrarHorariosProduccion(chat: ITelegramChat, aviso?: string): Promise<void> {
    const { estado, horarios } = await atencionClienteService.horariosProduccion(chat.workspaceId!);
    const nombres = escaparHtml(equipoAtencionService.nombres("produccion"));
    const intro = aviso ? `${aviso}\n\n` : "";

    if (!estado.puedeAgendar) {
      chat.tema = "produccion";
      await chat.save();
      await telegramService.sendMessage(
        chat.chatId,
        `${intro}🎬 Ya tienes una producción agendada para el <b>${fechaEcuador(estado.proxima!)}</b>.\n\n` +
          "Agendamos una producción cada 2 meses, así que no puedo reservar otra por ahora. " +
          `Si necesitas moverla o tienes otro tema de producción, cuéntame aquí y se lo paso a <b>${nombres}</b> 📩`
      );
      return;
    }
    if (horarios === null) return this.coordinarPorCorreo(chat, "produccion", aviso);
    if (!horarios.length) {
      return this.coordinarPorCorreo(
        chat,
        "produccion",
        `${intro}No encontré horarios libres de producción desde el ${fechaEcuador(estado.habilitadaDesde!)} 😅`
      );
    }

    const regla =
      estado.esperar && estado.ultima
        ? `Tu última producción fue el ${fechaEcuador(estado.ultima)} y agendamos una cada 2 meses, así que te muestro horarios desde el <b>${fechaEcuador(estado.habilitadaDesde!)}</b>.\n\n`
        : "";
    const botones = this.botonesHorarios(horarios, (h) => `prod:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "✍️ Prefiero escribirles", callback_data: "menu:produccion" }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${intro}🎬 Agendemos tu producción con <b>${nombres}</b>.\n\n` +
        "Es la sesión en ambiente controlado para grabar las tomas de tu avatar y de los productos que vamos a promocionar.\n\n" +
        `${regla}Elige el horario que te quede mejor 👇`,
      botones
    );
  }

  private async agendarProduccion(chat: ITelegramChat, segundos: string): Promise<void> {
    const inicio = new Date(Number(segundos) * 1000);
    if (Number.isNaN(inicio.getTime())) return this.mostrarHorariosProduccion(chat);

    await telegramService.sendMessage(chat.chatId, "⏳ Un segundito, estoy reservando tu producción...");
    const reserva = await atencionClienteService.reservarProduccion(chat, inicio);

    if (!reserva.ok) {
      if (reserva.motivo === "en_curso") {
        await telegramService.sendMessage(chat.chatId, "Estoy terminando de agendar tu producción ⏳ dame un segundito.");
        return;
      }
      if (reserva.motivo === "sin_calendario") return this.coordinarPorCorreo(chat, "produccion");
      if (reserva.motivo === "ya_agendada" || reserva.motivo === "antes_de_tiempo") return this.mostrarHorariosProduccion(chat);
      return this.mostrarHorariosProduccion(chat, "Uy, no pude reservar ese horario 😕 puede que lo hayan tomado justo ahora.");
    }

    await telegramService.sendMessage(
      chat.chatId,
      "Listo, tu producción quedó agendada 🎬\n\n" +
        `📅 <b>${reserva.cuando}</b> (hora Ecuador)\n` +
        `👥 Con <b>${escaparHtml(equipoAtencionService.nombres("produccion"))}</b>\n\n` +
        "Ya está en su calendario y les avisé. Ten listos los productos que vamos a promocionar 💪"
    );
    return this.mostrarMenu(chat, undefined, "Te ayudo con algo más? 😊");
  }

  /** Sin calendario propio o sin horarios: se coordina por mensaje con quien atiende. */
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
    const inicio = new Date(Number(segundos) * 1000);
    if (Number.isNaN(inicio.getTime())) return this.mostrarHorarios(chat, tema);
    if (inicio.getTime() < Date.now()) return this.mostrarHorarios(chat, tema, "Ese horario ya pasó ⌛ Te muestro los que siguen libres.");

    await telegramService.sendMessage(chat.chatId, "⏳ Un segundito, estoy reservando tu reunión...");
    const reserva = await atencionClienteService.reservarReunion(chat, tema, inicio);

    if (!reserva.ok) {
      if (reserva.motivo === "en_curso") {
        await telegramService.sendMessage(chat.chatId, "Estoy terminando de agendar tu reunión ⏳ Dame un segundito.");
        return;
      }
      if (reserva.motivo === "sin_calendario") return this.coordinarPorCorreo(chat, tema);
      return this.mostrarHorarios(chat, tema, "Uy, no pude reservar ese horario 😕 Puede que alguien lo haya tomado justo ahora.");
    }

    await telegramService.sendMessage(
      chat.chatId,
      "Listo, quedó agendada! 🎉\n\n" +
        `📅 <b>${reserva.cuando}</b> (hora Ecuador)\n` +
        `👤 Con <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b>\n\n` +
        "Ya está en su calendario y le avisé a su correo. Nos vemos pronto! 💛"
    );
    return this.mostrarMenu(chat, undefined, "Te ayudo con algo más? 😊");
  }

  // ── Solicitudes al equipo ──────────────────────────────────────────────────
  private async enviarSolicitud(chat: ITelegramChat, tema: TemaAtencion, texto: string): Promise<void> {
    const entregado = await atencionClienteService.enviarMensaje(chat, tema, texto);

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
    const { personas } = EQUIPO_ATENCION[tema];
    await telegramService.sendMessage(
      chat.chatId,
      `Listo! ✅ Le pasé tu mensaje a <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b>. ` +
        `${personas.length > 1 ? "Te van" : "Te va"} a contactar lo antes posible 💛`
    );
    return this.mostrarMenu(chat, undefined, "Te ayudo con algo más? 😊");
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
    await telegramService.sendMessage(chat.chatId, `Tienes ${entornos.length} entornos 🙌 De cuál quieres hablar hoy?`, botones);
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
    // La conversacion de la IA es por entorno: no se mezcla con la del anterior.
    if (String(chat.workspaceId) !== String(entorno._id)) chat.set("historial", []);
    chat.workspaceId = entorno._id;
    chat.tema = undefined;
    chat.estado = "listo";
    await chat.save();

    // Cliente nuevo o a medio arrancar: lo primero que ve es su onboarding,
    // no un menu generico. El que ya esta en marcha va directo al menu.
    const perfil = await perfilClienteService.de(entorno._id, chat.userId);
    if (!perfil.esEquipo && perfil.tipo !== "activo") {
      await telegramService.sendMessage(
        chat.chatId,
        `Perfecto, estamos en <b>${escaparHtml(entorno.name)}</b> 💛\n\n` +
          (perfil.tipo === "nuevo"
            ? "Te acompaño desde el inicio: son tres sesiones cortas y después grabamos tu primera producción."
            : "Sigamos donde quedamos, te falta poco para grabar tu primera producción.")
      );
      return this.mostrarOnboarding(chat);
    }
    return this.mostrarMenu(chat, entorno.name);
  }

  private async mostrarMenu(chat: ITelegramChat, nombreEntorno?: string, saludo?: string): Promise<void> {
    const nombre =
      nombreEntorno ?? (await models.workspaces.findById(chat.workspaceId).select("name").lean())?.name ?? "tu entorno";
    await telegramService.sendMessage(
      chat.chatId,
      `${saludo ? `${saludo}\n\n` : ""}Estamos hablando de <b>${escaparHtml(nombre)}</b> 💛 En qué te ayudo hoy?\n\n` +
        "✍️ Escríbeme lo que necesites con tus palabras, por ejemplo <i>cómo van mis guiones?</i> o <i>quiero mover la grabación</i>.\n\n" +
        "💬 Prefieres hablar directo con nosotros? Toca <b>Agendar una reunión</b> y lo dejo en el calendario del equipo.",
      [
        [{ text: "🚀 Mi onboarding", callback_data: "menu:onboarding" }],
        [{ text: "🎬 Producciones", callback_data: "menu:produccion" }],
        [{ text: "📝 Revisión de guiones", callback_data: "menu:guiones" }],
        [{ text: "🤝 Atención al cliente", callback_data: "menu:atencion" }],
        [{ text: "📅 Agendar una reunión", callback_data: "menu:agendar" }],
        [{ text: "🔄 Cambiar de entorno", callback_data: "menu:entorno" }],
      ]
    );
  }

  /**
   * Borra lo que el bot recuerda de este chat (conversacion con la IA, tema y
   * lecturas de animo). La cuenta sigue conectada. Los mensajes ya visibles en
   * Telegram no se pueden borrar desde el bot.
   */
  private async borrarHistorial(chat: ITelegramChat): Promise<void> {
    await models.telegramChats.updateOne(
      { _id: chat._id },
      { $set: { historial: [] }, $unset: { tema: 1, ultimoAnimo: 1, ultimaAlerta: 1 } }
    );
    await telegramService.sendMessage(
      chat.chatId,
      "Listo, borré todo tu historial conmigo 🧹 arrancamos de cero.\n\n" +
        (chat.userId
          ? "Tu cuenta sigue conectada. Si también quieres desconectarla escribe /salir."
          : "Escríbeme el correo con el que entras a <b>metrics.bakano.ec</b> para empezar.")
    );
  }

  private async reiniciar(chat: ITelegramChat, mensaje: string): Promise<void> {
    chat.estado = "esperando_correo";
    chat.userId = undefined;
    chat.workspaceId = undefined;
    chat.tema = undefined;
    chat.set("historial", []);
    chat.correoPendiente = undefined;
    chat.codigoHash = undefined;
    chat.codigoExpira = undefined;
    chat.codigoIntentos = 0;
    await chat.save();
    await telegramService.sendMessage(chat.chatId, mensaje);
  }
}

export const telegramBotService = new TelegramBotService();
