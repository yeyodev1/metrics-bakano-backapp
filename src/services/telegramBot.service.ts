import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { resendService } from "./resend.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { atencionClienteService, diaEcuador, fechaEcuador, horarioCorto } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { perfilClienteService } from "./perfilCliente.service";
import { onboardingDatosService } from "./onboardingDatos.service";
import { citasClienteService } from "./citasCliente.service";
import { comoPlata, contextoParaLaIa, facturacionChatService, claveDia, nombreDia, parsearMonto } from "./facturacionChat.service";
import { archivosClienteService, ETIQUETA_CATEGORIA, type CategoriaRecurso } from "./archivosCliente.service";
import { revisionGuionesService, type RevisionPendiente } from "./revisionGuiones.service";
import { SESIONES_ONBOARDING, type SesionOnboarding } from "./onboardingSesiones.service";
import { telegramAgentService } from "./telegramAgent.service";
import { escaparHtml, telegramService, type InlineButton, type TelegramUpdate } from "./telegram.service";

/**
 * "quiero mover la grabación", "cancela mi sesión", "moverla al jueves"...
 * Verbo de cambio + algo que sea una cita (o el pronombre "-la"), para no
 * atrapar "cancelaron mi pedido".
 */
const VERBO_CAMBIO = /\b(mover|muev[eao]|reprogram\w*|cancel\w*|pospon\w*|posterg\w*|cambi\w*|pasar)\b/i;
const OBJETO_CITA =
  /\b(cita|sesi[oó]n|reuni[oó]n|grabaci[oó]n|producci[oó]n|fecha|hora|d[ií]a|lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo|semana)\b|\b(mover|cancelar|reprogramar|posponer|postergar|pasar)la\b/i;
const pideCambioCita = (texto: string) => VERBO_CAMBIO.test(texto) && OBJETO_CITA.test(texto) || /\b(mover|cancelar|reprogramar|posponer|postergar)la\b/i.test(texto);
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
      if (!(await this.esNuevo(doc, update.update_id))) return;
      await this.onBoton(doc, cq.data);
      return;
    }

    const msg = update.message;
    // Solo chats privados: en un grupo cualquiera leeria el codigo.
    if (!msg || msg.chat.type !== "private" || !msg.from) return;

    // El cliente manda su logo o su catálogo por el chat: es lo natural para
    // él, y el archivo tiene que terminar en su entorno, no en la conversación.
    if (msg.photo?.length || msg.document) {
      const doc = await this.cargarChat(msg.chat.id, msg.from);
      if (!(await this.esNuevo(doc, update.update_id))) return;
      await this.onArchivo(doc, msg);
      return;
    }

    if (typeof msg.text !== "string") return;
    const doc = await this.cargarChat(msg.chat.id, msg.from);
    if (!(await this.esNuevo(doc, update.update_id))) return;
    await this.onTexto(doc, msg.text.trim());
  }

  /**
   * Telegram reenvia el mismo update si tardamos en responder (la IA puede
   * tomarse casi un minuto). Sin esto, el cliente veia la respuesta dos veces
   * o dos menus seguidos, y una cita se podia procesar dos veces.
   */
  private async esNuevo(chat: ITelegramChat, updateId?: number): Promise<boolean> {
    if (!updateId) return true;
    const r = await models.telegramChats.updateOne(
      { _id: chat._id, updatesVistos: { $ne: updateId } },
      { $push: { updatesVistos: { $each: [updateId], $slice: -40 } } }
    );
    if (!r.modifiedCount) console.log(`[Telegram] update ${updateId} repetido: se ignora`);
    return Boolean(r.modifiedCount);
  }

  /** El cliente va a mandar un archivo por el chat: se le dice exactamente cómo. */
  private async pedirArchivo(chat: ITelegramChat, categoria: CategoriaRecurso): Promise<void> {
    if (!["logo", "linea_grafica", "catalogo"].includes(categoria)) return this.mostrarMenu(chat);
    await archivosClienteService.pedirArchivo(chat, categoria);

    const instrucciones: Record<string, string> = {
      logo:
        "Dale, mándame tu logo por aquí 📎\n\n" +
        "Importante: adjúntalo con el clip y elige <b>Archivo</b> (no Foto), y que sea <b>PNG con fondo transparente</b>. " +
        "Si Telegram lo manda como foto, lo comprime y el logo pierde el fondo.\n\n" +
        "Si tienes varias versiones, mándamelas una por una y las guardo todas.",
      linea_grafica:
        "Mándame tu línea gráfica por aquí 📎\n\n" +
        "Puede ser tu manual de marca, la paleta de colores o ejemplos de piezas: PNG, JPG, WEBP o PDF.",
      catalogo:
        "Mándame tu catálogo por aquí 📎\n\n" +
        "Puede ser un PDF o una foto de la lista de precios. Si prefieres, <b>escríbelo en un mensaje</b> " +
        "(productos con sus precios) y yo lo guardo igual.",
    };
    await telegramService.sendMessage(chat.chatId, instrucciones[categoria]!, [
      [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }],
      [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
    ]);
  }

  /** Foto o archivo enviado al chat: se valida, se guarda y se confirma. */
  private async onArchivo(chat: ITelegramChat, msg: NonNullable<TelegramUpdate["message"]>): Promise<void> {
    if (chat.estado !== "listo" || !chat.workspaceId) {
      await telegramService.sendMessage(
        chat.chatId,
        "Para guardarte archivos primero necesito saber quién eres 🔐\n\nEscríbeme el correo con el que entras a <b>metrics.bakano.ec</b> y seguimos."
      );
      return;
    }

    const comprimido = Boolean(msg.photo?.length && !msg.document);
    const foto = msg.photo?.[msg.photo.length - 1];
    const fileId = msg.document?.file_id || foto?.file_id;
    if (!fileId) return;

    // Lo que dice el pie manda; si no dice nada, vale lo que el bot pidió.
    const categoria = archivosClienteService.categoriaPorTexto(msg.caption) ?? archivosClienteService.esperando(chat);
    await telegramService.sendChatAction(chat.chatId, "typing").catch(() => undefined);
    const buffer = await telegramService.descargarArchivo(fileId);
    if (!buffer) {
      await telegramService.sendMessage(chat.chatId, "Se me complicó bajar ese archivo 😅 me lo reenvías?");
      return;
    }

    const r = await archivosClienteService.guardar(
      chat,
      {
        buffer,
        nombre: msg.document?.file_name || `foto-${Date.now()}.jpg`,
        mime: msg.document?.mime_type || "image/jpeg",
        comprimido,
      },
      categoria
    );

    if (!r.ok) {
      const explicacion: Record<string, string> = {
        logo_comprimido:
          "Ese logo me llegó como foto y Telegram lo comprime a JPG, así que pierde el fondo transparente 😕\n\n" +
          "Mándamelo otra vez con el clip 📎 → <b>Archivo</b> (no como foto), en PNG.",
        logo_no_png:
          "Para el logo necesito un <b>PNG</b> con fondo transparente 🙏 Si lo tienes en .ai, .psd o .jpg, expórtalo a PNG y me lo mandas.",
        tipo: "Ese formato no lo puedo guardar 😕 Acepto PNG, JPG, WEBP o PDF (y el logo siempre en PNG).",
        peso: "Ese archivo pesa más de 10 MB y no me entra 😅 Mándamelo más liviano.",
        sin_entorno: "Primero elige de qué entorno hablamos y te lo guardo.",
        error: "No pude guardarlo 😕 inténtalo de nuevo o súbelo desde metrics.bakano.ec.",
      };
      await telegramService.sendMessage(chat.chatId, explicacion[r.motivo] || explicacion["error"]!, [
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]);
      return;
    }

    await archivosClienteService.olvidarPedido(chat);
    if (r.preguntarCategoria) {
      await telegramService.sendMessage(
        chat.chatId,
        `Recibido <b>${escaparHtml(r.nombre)}</b> ✅ ya lo guardé en tu entorno.\n\nQué es, para dejarlo en su lugar?`,
        [
          [
            { text: "🎨 Mi logo", callback_data: `arch:logo:${r.recursoId}` },
            { text: "🖌️ Línea gráfica", callback_data: `arch:linea_grafica:${r.recursoId}` },
          ],
          [{ text: "🏷️ Catálogo o precios", callback_data: `arch:catalogo:${r.recursoId}` }],
        ]
      );
      return;
    }

    await telegramService.sendMessage(
      chat.chatId,
      `Listo, guardé tu <b>${ETIQUETA_CATEGORIA[r.categoria]}</b> en tu entorno ✅\n\nYa le avisé al equipo para que lo revise. Seguimos?`,
      [
        [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
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
        // Guiones con revision abierta: lo que escribe son correcciones, y esas
        // las junta la IA en el borrador en vez de reenviarlas sueltas.
        if (chat.tema === "guiones" && chat.workspaceId && (await revisionGuionesService.pendiente(chat.workspaceId))) {
          chat.tema = undefined;
          await chat.save();
        }
        // Le pedimos un monto: lo que escriba se lee como facturación antes
        // que nada, si no se lo llevaría la IA y no quedaría registrado.
        // Pidió el catálogo y lo está escribiendo en el mensaje.
        const archivoEsperado = archivosClienteService.esperando(chat);
        if (archivoEsperado === "catalogo" && chat.workspaceId && texto.trim().length >= 25) {
          await archivosClienteService.olvidarPedido(chat);
          const guardado = await archivosClienteService.guardarTexto(chat, texto.trim(), "catalogo");
          await telegramService.sendMessage(
            chat.chatId,
            guardado.ok
              ? "Listo, guardé tu catálogo en tu entorno ✅ ya le avisé al equipo para que lo revise."
              : "No pude guardarlo 😕 inténtalo de nuevo o mándamelo como archivo.",
            [
              [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }],
              [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
            ]
          );
          return;
        }

        const diaEsperado = facturacionChatService.esperando(chat);
        if (diaEsperado && chat.workspaceId) {
          const monto = parsearMonto(texto);
          const mencionado = facturacionChatService.diaMencionado(texto);
          // "ayer fueron 300" cuando se esperaba el de hoy: no se adivina.
          if (monto !== null && mencionado && claveDia(mencionado) !== claveDia(diaEsperado)) {
            await telegramService.sendMessage(
              chat.chatId,
              `Ojo, para no equivocarme: esos <b>${comoPlata(monto)}</b> son de ${nombreDia(mencionado)} o de ${nombreDia(diaEsperado)}?`,
              [
                [{ text: `📅 ${nombreDia(mencionado).replace(/ \(.*\)/, "")}`, callback_data: `fact:set:${claveDia(mencionado)}:${monto}` }],
                [{ text: `📅 ${nombreDia(diaEsperado).replace(/ \(.*\)/, "")}`, callback_data: `fact:set:${claveDia(diaEsperado)}:${monto}` }],
              ]
            );
            return;
          }
          if (monto !== null) return this.registrarFacturacion(chat, monto, diaEsperado);

          // Ventana abierta después de registrar: si escribe cualquier otra
          // cosa, no se le insiste con el monto, sigue la conversación normal.
          if ((chat.facturacionEsperada as any)?.modo === "correccion") {
            await facturacionChatService.olvidarPedido(chat);
          } else {
            if (/^(cancel|olvid|dejalo|déjalo|no$)/i.test(texto.trim())) {
              await facturacionChatService.olvidarPedido(chat);
              await telegramService.sendMessage(chat.chatId, "Listo, lo dejamos para después 👌", [
                [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
              ]);
              return;
            }
            await telegramService.sendMessage(
              chat.chatId,
              `No le encontré el monto a eso 😅 mándame solo el número de ${nombreDia(diaEsperado)}, por ejemplo <i>1250</i>. Si prefieres dejarlo, escribe <i>cancelar</i>. Si es de otro día, dime cuál.`
            );
            return;
          }
        }

        // Mover o cancelar una cita lo resuelve la IA con el calendario, no se
        // reenvia suelto al equipo aunque haya un tema elegido.
        if (chat.tema && chat.workspaceId && pideCambioCita(texto)) {
          const tema = chat.tema;
          chat.tema = undefined;
          await chat.save();
          if (await telegramAgentService.responder(chat, texto)) return;
          // La IA no respondio: el pedido no se pierde, va a quien atiende el tema.
          return this.enviarSolicitud(chat, tema, texto);
        }
        // Eligio un tema en el menu: su mensaje va directo a esa persona.
        if (chat.tema && chat.workspaceId) return this.enviarSolicitud(chat, chat.tema, texto);
        if (chat.workspaceId && (await telegramAgentService.responder(chat, texto))) return;
        // La IA no pudo: mensaje corto y humano, no el menú completo otra vez.
        await telegramService.sendMessage(
          chat.chatId,
          "Uy, se me trabó eso 😅 dame un minuto y escríbemelo otra vez.\n\nSi es algo urgente, toca el botón y se lo paso a una persona del equipo ahora mismo.",
          [
            [{ text: "💬 Pasarlo a una persona", callback_data: "menu:atencion" }],
            [{ text: "🗓️ Mis citas", callback_data: "citas:ver" }],
            [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
          ]
        );
        return;
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
        `Escríbelo aquí 👇 (vence en ${CODIGO_MINUTOS} minutos). Te equivocaste de correo? Solo escribe el correcto.\n\n` +
        "Si en unos minutos no te llega, revisa el spam. Si tampoco está, ese correo todavía no tiene un <b>entorno creado</b> en metrics.bakano.ec: pídele a tu asesor de Bakano que lo cree o escríbenos a soporte@bakano.ec. Sin entorno no puedo conectarte."
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
    if (data === "cita:si" || data === "cita:no") return this.responderCambioCita(chat, data === "cita:si");
    if (data === "citas:ver") return this.mostrarCitas(chat);
    if (data === "fact:ver") return this.mostrarFacturacion(chat);
    if (data.startsWith("sub:")) return this.pedirArchivo(chat, data.slice(4) as CategoriaRecurso);
    if (data === "fact:metricas") {
      chat.tema = undefined;
      await chat.save();
      if (await telegramAgentService.responder(chat, "Muéstrame mis métricas del mes")) return;
      return this.mostrarMenu(chat);
    }
    if (data.startsWith("fact:dia:")) return this.pedirMontoDelDia(chat, data.slice(9));
    if (data.startsWith("fact:set:")) {
      const [dia, monto] = data.slice(9).split(":");
      const fecha = new Date(`${dia}T05:00:00.000Z`);
      if (Number.isNaN(fecha.getTime()) || !Number.isFinite(Number(monto))) return this.mostrarFacturacion(chat);
      return this.registrarFacturacion(chat, Number(monto), fecha);
    }
    if (data.startsWith("arch:")) {
      const [, categoria, recursoId] = data.split(":");
      const r = await archivosClienteService.recategorizar(chat, recursoId!, categoria as CategoriaRecurso);
      await telegramService.sendMessage(
        chat.chatId,
        r.ok
          ? `Perfecto, lo dejé como <b>${ETIQUETA_CATEGORIA[categoria as CategoriaRecurso]}</b> ✅ ya le avisé al equipo.`
          : r.motivo === "logo_no_png"
            ? `Para el logo necesito un <b>PNG</b> con fondo transparente 🙏 "${escaparHtml(r.nombre || "ese archivo")}" no lo es, así que lo dejé guardado igual. Mándame el PNG cuando puedas (con el clip 📎 → Archivo).`
            : "No encontré ese archivo 😕 me lo reenvías?",
        [[{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
      );
      return;
    }
    if (data === "datos:contar") {
      chat.tema = undefined;
      await chat.save();
      if (await telegramAgentService.responder(chat, "Quiero contarte de mi negocio para que lo dejes en el sistema")) return;
      return this.mostrarMenu(chat);
    }
    // cc:m:<ref> mueve · cc:c:<ref> cancela · cs:<epoch>:<ref> elige horario
    if (data.startsWith("cc:m:")) return this.mostrarHorariosParaMover(chat, data.slice(5));
    if (data.startsWith("cc:c:")) return this.pedirConfirmacionCita(chat, { accion: "cancelar", ref: data.slice(5) });
    if (data.startsWith("cs:")) {
      const resto = data.slice(3);
      const corte = resto.indexOf(":");
      return this.pedirConfirmacionCita(chat, {
        accion: "reprogramar",
        ref: resto.slice(corte + 1),
        inicio: new Date(Number(resto.slice(0, corte)) * 1000),
      });
    }
    if (data === "citas:cambiar") {
      chat.tema = undefined;
      await chat.save();
      if (await telegramAgentService.responder(chat, "Quiero mover o cancelar una de mis citas")) return;
      return this.mostrarMenu(chat);
    }
    if (data === "rev:lista") return this.mostrarGuionesParaRevisar(chat);
    if (data.startsWith("onbl:")) return this.enviarLinkOnboarding(chat, data.slice(5) as SesionOnboarding);
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
    if (tema === "guiones") {
      const revision = await revisionGuionesService.pendiente(chat.workspaceId!);
      if (revision && !revision.produccion?.ventanaCerrada) return this.invitarARevisar(chat, revision);
    }
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

  // ── Revision de guiones ────────────────────────────────────────────────────
  /** Hay revision abierta: se invita a corregir conversando, no a mandar un mensaje suelto. */
  private async invitarARevisar(chat: ITelegramChat, revision: RevisionPendiente): Promise<void> {
    chat.tema = undefined;
    await chat.save();
    const pendientes = revision.guiones.filter((g) => g.aprobacion !== "APROBADO").length;
    const plazo = revision.produccion
      ? ` Tu producción es el ${fechaEcuador(revision.produccion.fecha)} y puedes pedir cambios hasta el <b>${fechaEcuador(revision.produccion.correccionesHasta)}</b>.`
      : "";
    await telegramService.sendMessage(
      chat.chatId,
      `📝 Tienes <b>${pendientes} guiones</b> esperando tu revisión.${plazo}\n\n` +
        "Escríbeme con tus palabras qué quieres cambiar, por ejemplo:\n" +
        "<i>en el guion 3 cambia el gancho, que empiece con una pregunta sobre precios</i>\n\n" +
        `Voy anotando cada corrección y al final te muestro el resumen para enviarlo todo junto a <b>${escaparHtml(equipoAtencionService.nombres("guiones"))}</b>.`,
      [
        [{ text: "📋 Ver mis guiones", callback_data: "rev:lista" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async mostrarGuionesParaRevisar(chat: ITelegramChat): Promise<void> {
    const r = await revisionGuionesService.resumen(chat);
    if (!r) {
      await telegramService.sendMessage(chat.chatId, "No tienes guiones esperando revisión ahora mismo 🙂");
      return this.mostrarMenu(chat);
    }
    const anotados = new Set(r.correcciones.map((c) => c.numero));
    const lineas = r.revision.guiones.map((g) => {
      const marca = anotados.has(g.numero) ? "✏️" : g.aprobacion === "APROBADO" ? "✅" : "⏳";
      return `${marca} #${String(g.numero).padStart(2, "0")} ${escaparHtml(g.tema)}`;
    });
    await telegramService.sendMessage(
      chat.chatId,
      `📝 <b>Tus guiones</b>\n\n${lineas.join("\n")}\n\n` +
        "✏️ ya tiene corrección anotada · ⏳ por revisar\n\n" +
        "Dime el número y qué cambiarías. Si quieres leer uno primero, escríbeme <i>muéstrame el 3</i>." +
        (r.plazo.cerrado ? "\n\n⚠️ El plazo para pedir cambios ya cerró." : ""),
      [[{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
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
  /**
   * El onboarding en una pantalla: en qué paso va, UNA acción principal y
   * botones que llevan directo a subir lo que falta. Antes era una lista larga
   * con links pegados en el texto y el cliente no sabía por dónde empezar.
   */
  private async mostrarOnboarding(chat: ITelegramChat): Promise<void> {
    const [estado, pendientes] = await Promise.all([
      onboardingBotService.estado(chat.workspaceId!),
      onboardingDatosService.pendientes(chat.workspaceId!).catch(() => null),
    ]);

    const hecha = (s: { agendada: boolean; estado?: string }) => s.estado === "cumplida" || s.estado === "no_aplica";
    const listas = estado.sesiones.filter(hecha).length;
    const lineas = estado.sesiones.map((s) =>
      hecha(s)
        ? `✅ ${s.emoji} ${s.etiqueta}`
        : s.agendada
          ? `🗓️ ${s.emoji} ${s.etiqueta} · ${s.fecha ? fechaEcuador(s.fecha) : "agendada"}`
          : `⬜ ${s.emoji} ${s.etiqueta}`
    );
    lineas.push(
      estado.produccion.agendada
        ? `🗓️ 🎬 Tu primera producción · ${fechaEcuador(estado.produccion.agendada)}`
        : "⬜ 🎬 Tu primera producción"
    );

    // Una sola cosa por hacer ahora. El resto queda en los botones de abajo.
    const siguiente = estado.sesiones.find((s) => s.sesion === estado.siguiente);
    const agendada = estado.sesiones.find((s) => s.agendada && !hecha(s));
    const ahora = siguiente
      ? `👉 <b>Ahora:</b> agenda tu sesión de <b>${siguiente.etiqueta}</b> con <b>${escaparHtml(siguiente.responsable)}</b>.\n` +
        `${siguiente.resumen}\n\nTen listo:\n${siguiente.requisitos.map((r) => `• ${r}`).join("\n")}`
      : agendada
        ? `👉 <b>Ahora:</b> tu sesión de <b>${agendada.etiqueta}</b> es el <b>${agendada.fecha ? fechaEcuador(agendada.fecha) : "día agendado"}</b>. ` +
          `Cuando ${escaparHtml(agendada.responsable)} la dé por cerrada, te aviso y seguimos.`
        : estado.produccion.agendada
          ? "👉 <b>Ahora:</b> a preparar tu producción. Cualquier duda me escribes 💛"
          : "👉 <b>Ahora:</b> agenda tu primera producción y arrancamos 🎬";

    const faltaEnviar = (pendientes?.entregables || []).filter((e) => e.estado === "pendiente");
    const faltaContar = pendientes?.datosMarcaFaltantes || [];

    const botones: InlineButton[][] = [];
    if (siguiente) botones.push([{ text: `📅 Agendar ${siguiente.etiqueta}`, callback_data: `onb:${siguiente.sesion}` }]);
    else if (estado.produccion.puedeAgendar) botones.push([{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }]);

    // Un botón por cosa pendiente, que abre la pantalla exacta donde se sube.
    // Todo se hace por el chat: el cliente ya está aquí y mandarlo a la web
    // era justo donde se caía. La web queda como opción al final.
    const ACCION_POR_CHAT: Record<string, { texto: string; data: string }> = {
      archivosMarca: { texto: "📤 Mandarte mis logos", data: "sub:logo" },
      facturacion: { texto: "💵 Registrar mi facturación", data: "fact:ver" },
      catalogo: { texto: "🏷️ Mandarte mi catálogo", data: "sub:catalogo" },
    };
    for (const e of faltaEnviar) {
      const accion = ACCION_POR_CHAT[e.clave];
      if (accion) botones.push([{ text: accion.texto, callback_data: accion.data }]);
    }
    if (faltaContar.length) botones.push([{ text: `✍️ Contarte de mi negocio (${faltaContar.length})`, callback_data: "datos:contar" }]);
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const invitacionMeta = faltaEnviar.find((e) => e.clave === "invitacionMeta");
    await telegramService.sendMessage(
      chat.chatId,
      `🚀 <b>Tu onboarding</b> · ${listas} de ${estado.sesiones.length} sesiones listas\n\n` +
        `${lineas.join("\n")}\n\n${ahora}` +
        (invitacionMeta
          ? `\n\n📣 Falta además invitar a <b>${escaparHtml(invitacionMeta.invitarA || "")}</b> a tu portafolio de Meta con permisos de administración. Eso se hace dentro de Meta Business y lo vemos en la sesión con Joel Jimenez.`
          : "") +
        (faltaEnviar.some((e) => e.link) || faltaContar.length
          ? "\n\nTodo eso me lo puedes mandar por aquí mismo con los botones de abajo: yo lo subo a tu entorno. Si ya lo subiste tú, dímelo y le aviso al equipo."
          : ""),
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
          `Puedes agendar desde aquí: ${def.link}\n\nO cuéntame qué día te queda mejor y se lo paso. ` +
          `Si quieres agilizarlo, también puedes escribirle a ${def.responsable.email}`
      );
      chat.tema = "atencion";
      await chat.save();
      return;
    }

    const botones = this.botonesHorarios(horarios, (h) => `onbs:${sesion}:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "🔗 Prefiero el link", callback_data: `onbl:${sesion}` }, { text: "📋 Menú", callback_data: "menu:ver" }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${intro}${def.emoji} <b>${def.etiqueta}</b> con <b>${escaparHtml(def.responsable.nombre)}</b>\n\n` +
        `${def.resumen}\n\nAntes de la sesión ten listo:\n${def.requisitos.map((r) => `• ${r}`).join("\n")}\n\n` +
        "Elige el horario que te quede mejor 👇",
      botones
    );
  }

  /**
   * Facturación desde el chat: qué días faltan y botones para registrarlos.
   * El cliente ya está aquí; mandarlo a la web solo para escribir un número
   * es donde se perdía.
   */
  private async mostrarFacturacion(chat: ITelegramChat): Promise<void> {
    const dias = await facturacionChatService.diasPendientes(chat);
    const faltan = dias.filter((d) => !d.registrado);
    const botones: InlineButton[][] = faltan.map((d) => [
      { text: `💵 ${d.texto.replace(/ \(.*\)/, "")} · ${d.fecha.toLocaleDateString("es-EC", { day: "numeric", month: "short", timeZone: "America/Guayaquil" })}`, callback_data: `fact:dia:${claveDia(d.fecha)}` },
    ]);
    const yaEstan = dias.filter((d) => d.registrado);
    for (const d of yaEstan.slice(-2)) {
      botones.push([{ text: `✏️ Corregir ${d.texto.replace(/ \(.*\)/, "")}`, callback_data: `fact:dia:${claveDia(d.fecha)}` }]);
    }
    botones.push([{ text: "📊 Ver mis métricas", callback_data: "fact:metricas" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const lineas = dias.map((d) => `${d.registrado ? "✅" : "⬜"} ${d.texto}`);
    await telegramService.sendMessage(
      chat.chatId,
      faltan.length
        ? `💵 <b>Tu facturación</b>\n\n${lineas.join("\n")}\n\nToca el día y me escribes el monto por aquí: yo lo subo a metrics.bakano.ec.`
        : `💵 <b>Tu facturación</b>\n\n${lineas.join("\n")}\n\nEstás al día 🙌 si quieres corregir un monto, toca el día.`,
      botones
    );
  }

  private async pedirMontoDelDia(chat: ITelegramChat, clave: string): Promise<void> {
    const fecha = new Date(`${clave}T05:00:00.000Z`);
    if (Number.isNaN(fecha.getTime())) return this.mostrarFacturacion(chat);
    await facturacionChatService.pedirMonto(chat, fecha);
    const previa = await facturacionChatService.entradaDe(chat, fecha);
    await telegramService.sendMessage(
      chat.chatId,
      previa
        ? `Ya tienes <b>${comoPlata((previa as any).amount)}</b> registrados para ${nombreDia(fecha)}.\n\nEscríbeme el monto correcto y lo actualizo 👇`
        : `Cuánto facturaste ${nombreDia(fecha)}?\n\nEscríbeme solo el monto (por ejemplo <i>1250</i> o <i>1.250,50</i>) y yo lo subo a metrics.bakano.ec. Si fue 0, también cuenta.`
    );
  }

  /** Guarda el monto que el cliente escribió y ofrece seguir con otro día. */
  private async registrarFacturacion(chat: ITelegramChat, monto: number, fecha: Date): Promise<void> {
    const r = await facturacionChatService.registrar(chat, monto, fecha);
    await facturacionChatService.olvidarPedido(chat);
    if (!r.ok) {
      const explicacion: Record<string, string> = {
        sin_permiso: "Ese día ya no lo puedo corregir desde aquí (pasaron más de 7 días). Escríbele a tu equipo y lo ajustan.",
        dia_invalido: "Ese día no lo puedo registrar desde el chat. Los de más de un mes se cargan en metrics.bakano.ec.",
        monto_invalido: "Ese monto no me cuadra 😅 mándame solo el número, por ejemplo 1250.",
        sin_usuario: "Necesito saber quién eres para registrarlo. Escribe /start y nos conectamos.",
        sin_entorno: "Primero dime de qué entorno hablamos.",
        error: "No pude guardarlo 😕 inténtalo de nuevo o cárgalo en metrics.bakano.ec.",
      };
      await telegramService.sendMessage(chat.chatId, explicacion[r.motivo] || explicacion["error"]!, [
        [{ text: "💵 Ver mi facturación", callback_data: "fact:ver" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]);
      return;
    }

    // Queda abierta la corrección: si se equivocó, escribe el monto correcto
    // y se actualiza ese mismo día, sin volver a tocar botones.
    await facturacionChatService.pedirMonto(chat, r.dia, "correccion");
    const pendientes = (await facturacionChatService.diasPendientes(chat)).filter((d) => !d.registrado);
    const botones: InlineButton[][] = [];
    if (pendientes.length) {
      botones.push([
        {
          text: `💵 Registrar ${pendientes[0]!.texto.replace(/ \(.*\)/, "")}`,
          callback_data: `fact:dia:${claveDia(pendientes[0]!.fecha)}`,
        },
      ]);
    }
    botones.push(
      [{ text: "✏️ Corregir este monto", callback_data: `fact:dia:${claveDia(r.dia)}` }],
      [{ text: "📊 Ver mis métricas", callback_data: "fact:metricas" }],
      [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]
    );

    // El cierre lo escribe la IA con los números del día: una plantilla dice
    // "registré $1.250" y ya; la lectura es lo que al cliente le sirve.
    const comentario = await telegramAgentService.comentar(
      chat,
      `Acabas de ${r.accion === "creada" ? "registrar" : "actualizar"} su facturación de ${r.diaTexto} en metrics.bakano.ec. ` +
        "Confírmaselo con el monto y cierra con una lectura corta de lo que significa: compáralo con el promedio del mes, " +
        "con el día anterior o con el mismo día de la semana pasada, y menciona el ROAS del día solo si hay gasto de Meta " +
        "(si metaConectado es false, no nombres Meta ni ROAS). " +
        "Cierra diciéndole que si se equivocó, me escriba el monto correcto y lo actualizo. " +
        (pendientes.length ? `Recuérdale al final que todavía falta registrar ${pendientes[0]!.texto}.` : "Dile que queda al día."),
      { montoRegistrado: comoPlata(r.monto), dia: r.diaTexto, ...contextoParaLaIa(r.contexto) }
    );

    const respaldo =
      `Listo ✅ ${r.accion === "creada" ? "registré" : "actualicé"} <b>${comoPlata(r.monto)}</b> de ${r.diaTexto}.\n\n` +
      `Total del día en Metrics: <b>${comoPlata(r.totalDia)}</b>` +
      (r.roas ? ` · gasto en Meta ${comoPlata(r.gastoMeta)} · ROAS <b>${r.roas}</b>` : "") +
      (pendientes.length ? `\n\nTodavía falta ${pendientes[0]!.texto}.` : "\n\nCon eso quedas al día 🙌");

    await telegramService.sendMessage(chat.chatId, comentario ? escaparHtml(comentario) : respaldo, botones);
  }

  /**
   * Citas del cliente con botones para moverlas o cancelarlas. Es el mismo
   * servicio que usa la IA, pero sin depender de ella: si el modelo esta
   * lento o caido, el cliente igual puede cambiar su cita.
   */
  private async mostrarCitas(chat: ITelegramChat): Promise<void> {
    const citas = await citasClienteService.listar(chat);
    if (!citas.length) {
      await telegramService.sendMessage(
        chat.chatId,
        "No tienes citas agendadas por ahora 🗓️\n\nCuando agendes tu producción, una sesión o una reunión, van a aparecer aquí y las vas a poder mover o cancelar.",
        [
          [{ text: "🚀 Cómo va mi onboarding", callback_data: "menu:onboarding" }],
          [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
        ]
      );
      return;
    }

    // Cada cita va numerada y sus botones llevan el MISMO número: con los
    // nombres largos, Telegram los recortaba ("Mover sesión de…") y no se
    // sabía a cuál cita correspondía cada botón.
    const lineas: string[] = [];
    const botones: InlineButton[][] = [];
    let cambiables = 0;
    citas.forEach((cita, i) => {
      const n = i + 1;
      const editable = citasClienteService.editable(cita);
      if (editable) cambiables++;
      lineas.push(
        `<b>${n}.</b> 🗓️ <b>${escaparHtml(cita.etiqueta)}</b>\n     ${fechaEcuador(cita.inicio)}\n     con ${escaparHtml(cita.con)}` +
          (editable
            ? ""
            : `\n     ⏰ faltan menos de 48 h: esta la coordinas directo con ${escaparHtml(cita.correos.join(" o "))}`)
      );
      if (editable) {
        botones.push([
          { text: `🔄 Mover ${n}`, callback_data: `cc:m:${cita.ref}` },
          { text: `✖️ Cancelar ${n}`, callback_data: `cc:c:${cita.ref}` },
        ]);
      }
    });
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const cierre =
      cambiables === 0
        ? "Todas están a menos de 48 horas, así que esas las coordinas directo con la persona de cada una."
        : cambiables === citas.length
          ? "Toca el número de la que quieras mover o cancelar 👇"
          : `Solo ${cambiables === 1 ? "la marcada con botón" : "las marcadas con botón"} se puede${cambiables === 1 ? "" : "n"} cambiar desde aquí: las demás están a menos de 48 horas.`;
    await telegramService.sendMessage(chat.chatId, `Estas son tus citas 👇\n\n${lineas.join("\n\n")}\n\n${cierre}`, botones);
  }

  private async mostrarHorariosParaMover(chat: ITelegramChat, ref: string): Promise<void> {
    const { cita, horarios, motivo } = await citasClienteService.horariosParaMover(chat, ref);
    if (!cita) return this.mostrarCitas(chat);
    if (motivo === "fuera_de_plazo") {
      await telegramService.sendMessage(
        chat.chatId,
        `Faltan menos de 48 horas para tu ${escaparHtml(cita.etiqueta.toLowerCase())}, así que esa ya la coordinas directo con <b>${escaparHtml(cita.con)}</b> 🙏\n\n` +
          `Escríbele a ${escaparHtml(cita.correos.join(" o "))} y lo resuelven al toque.`,
        [[{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
      );
      return;
    }
    if (!horarios.length) {
      await telegramService.sendMessage(
        chat.chatId,
        `No me aparecen horarios libres para mover tu ${escaparHtml(cita.etiqueta.toLowerCase())} 😕\n\n` +
          `Cuéntame qué día te queda bien y se lo paso a <b>${escaparHtml(cita.con)}</b>.`,
        [[{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
      );
      return;
    }
    const botones = this.botonesHorarios(horarios, (h) => `cs:${Math.floor(h.getTime() / 1000)}:${ref}`);
    botones.push([{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }]);
    await telegramService.sendMessage(
      chat.chatId,
      `Tu <b>${escaparHtml(cita.etiqueta.toLowerCase())}</b> está para el <b>${fechaEcuador(cita.inicio)}</b>.\n\nElige la nueva fecha 👇`,
      botones
    );
  }

  /** Antes de tocar el calendario, el cliente confirma qué se va a hacer. */
  private async pedirConfirmacionCita(
    chat: ITelegramChat,
    cambio: { accion: "cancelar" | "reprogramar"; ref: string; inicio?: Date }
  ): Promise<void> {
    const r = await citasClienteService.proponer(chat, {
      accion: cambio.accion,
      ref: cambio.ref,
      inicio: cambio.inicio?.toISOString(),
    });
    if (!r.ok) {
      const correos = "correos" in r && r.correos?.length ? ` Escríbele a ${escaparHtml(r.correos.join(" o "))}.` : "";
      const texto =
        r.motivo === "fuera_de_plazo"
          ? `Faltan menos de 48 horas para esa cita, así que esa ya la coordinas directo con tu equipo 🙏${correos}`
          : r.motivo === "horario_no_disponible"
            ? "Uy, ese horario se ocupó justo ahora 😕 elige otro."
            : "No pude preparar ese cambio 😕 cuéntame qué necesitas y se lo paso a tu equipo.";
      await telegramService.sendMessage(chat.chatId, texto, [
        [{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]);
      return;
    }
    await telegramService.sendMessage(
      chat.chatId,
      `Ojo, esto es lo que voy a hacer 👇\n\n<b>${escaparHtml(r.resumen)}</b> (hora Ecuador).\n\nLo confirmo?`,
      [
        [
          { text: "✅ Sí, hazlo", callback_data: "cita:si" },
          { text: "✖️ No, déjalo así", callback_data: "cita:no" },
        ],
      ]
    );
  }

  /** Boton de confirmacion de un cambio de cita (propuesto por la IA o por el menú). */
  private async responderCambioCita(chat: ITelegramChat, confirma: boolean): Promise<void> {
    if (!confirma) {
      await citasClienteService.descartar(chat);
      await telegramService.sendMessage(chat.chatId, "Listo, no cambié nada 👌 tu cita sigue igual.", [
        [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
      ]);
      return;
    }
    await telegramService.sendMessage(chat.chatId, "⏳ Un segundito, lo estoy cambiando en el calendario...");
    const r = await citasClienteService.confirmar(chat);
    let texto: string;
    if (r.ok) {
      texto =
        r.accion === "cancelada"
          ? `Listo, quedó cancelada ✅\n\n${escaparHtml(r.cita)} del ${r.antes}. Ya le avisé a <b>${escaparHtml(r.con)}</b>.`
          : `Listo, quedó movida ✅\n\n${escaparHtml(r.cita)}\n📅 Ahora: <b>${r.ahora}</b> (hora Ecuador)\n👤 Con <b>${escaparHtml(r.con)}</b>, ya le avisé.`;
    } else if (r.motivo === "sin_cambio_pendiente" || r.motivo === "cambio_vencido") {
      texto = "Ese cambio ya no está vigente 😅 cuéntame de nuevo qué quieres mover o cancelar y lo armamos.";
    } else if (r.motivo === "en_curso") {
      texto = "Ya lo estoy procesando, dame un segundito 🙏";
    } else if (r.motivo === "fuera_de_plazo") {
      texto =
        "Ya faltan menos de 48 horas para esa cita, así que no puedo cambiarla desde aquí." +
        (r.correos?.length ? ` Escríbele directo a ${escaparHtml(r.correos.join(" o "))} y lo coordinan.` : "");
    } else if (r.motivo === "horario_no_disponible") {
      texto = "Uy, ese horario ya se ocupó 😕 dime y te muestro otros.";
    } else {
      texto =
        "No pude hacer el cambio desde aquí 😕" +
        (r.correos?.length ? ` Escríbele a ${escaparHtml(r.correos.join(" o "))} y lo resuelven.` : " Cuéntame y se lo paso al equipo.");
    }
    await telegramService.sendMessage(chat.chatId, texto, [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]]);
    // Queda en la memoria de la IA: si el cliente sigue escribiendo, sabe que ya se hizo.
    await models.telegramChats.updateOne(
      { _id: chat._id },
      { $push: { historial: { $each: [{ rol: "bot", texto: texto.replace(/<[^>]+>/g, "").slice(0, 2000), en: new Date() }], $slice: -20 } } }
    );
  }

  private async enviarLinkOnboarding(chat: ITelegramChat, sesion: SesionOnboarding): Promise<void> {
    if (!(sesion in SESIONES_ONBOARDING)) return this.mostrarOnboarding(chat);
    const def = SESIONES_ONBOARDING[sesion];
    await telegramService.sendMessage(
      chat.chatId,
      `${def.emoji} Dale, agenda tu sesión de <b>${def.etiqueta}</b> con <b>${escaparHtml(def.responsable.nombre)}</b> aquí:\n${def.link}\n\n` +
        "Apenas la agendes me entero y la marco en tu onboarding 🙌",
      [[{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
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
      if (r.motivo === "en_curso") {
        await telegramService.sendMessage(chat.chatId, "Ya estoy agendando, dame un segundito 🙏");
        return;
      }
      if (r.motivo === "ocupado" || r.motivo === "pasado") {
        return this.mostrarHorariosOnboarding(chat, sesion, "Uy, ese horario lo tomaron justo ahora 😕");
      }
      const def = SESIONES_ONBOARDING[sesion];
      await telegramService.sendMessage(
        chat.chatId,
        `Uy, el calendario no me dejó reservarlo desde aquí 😕\n\n` +
          `Agéndalo en este link y quedamos listos: ${def.link}\n\n` +
          `Apenas lo agendes me entero y lo marco en tu onboarding. Ya le avisé al equipo para que lo revisen.`,
        [[{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
      );
      return;
    }

    const def = SESIONES_ONBOARDING[sesion];
    await telegramService.sendMessage(
      chat.chatId,
      `Listo, quedó agendada 🎉\n\n${def.emoji} <b>${def.etiqueta}</b>\n📅 <b>${r.cuando}</b> (hora Ecuador)\n👤 Con <b>${escaparHtml(r.responsable)}</b> (${def.responsable.email})\n\n` +
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
          "Agendamos una producción cada 2 meses, así que no puedo reservar otra por ahora.\n\n" +
          "Si necesitas moverla o cancelarla, toca abajo (se puede hasta 48 horas antes). " +
          `Para otro tema de producción, cuéntame aquí y se lo paso a <b>${nombres}</b> 📩`,
        [
          [{ text: "🔄 Mover o cancelar", callback_data: "citas:cambiar" }],
          [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
        ]
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
        "Para que todo funcione (tu onboarding, tus sesiones, tus guiones y tus métricas) necesitas un <b>entorno creado</b> en metrics.bakano.ec, y tu cuenta todavía no tiene uno activo 😕\n\n" +
          "Pídele a tu asesor de Bakano que lo cree o escríbenos a soporte@bakano.ec. Cuando esté listo, escríbeme /start y seguimos."
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
      `${saludo ? `${saludo}\n\n` : ""}Estás en <b>${escaparHtml(nombre)}</b> 💛\n\n` +
        "Escríbeme como le escribirías a una persona. Por ejemplo:\n" +
        "· <i>cómo van mis guiones?</i>\n" +
        "· <i>quiero mover mi grabación al jueves</i>\n" +
        "· <i>cómo va mi facturación este mes?</i>\n\n" +
        "O toca una opción 👇",
      [
        [{ text: "💵 Mi facturación del día", callback_data: "fact:ver" }],
        [{ text: "🗓️ Mis citas (mover o cancelar)", callback_data: "citas:ver" }],
        [{ text: "🚀 Cómo va mi onboarding", callback_data: "menu:onboarding" }],
        [{ text: "🎬 Mis producciones", callback_data: "menu:produccion" }],
        [{ text: "📝 Revisar mis guiones", callback_data: "menu:guiones" }],
        [{ text: "📅 Agendar una reunión", callback_data: "menu:agendar" }],
        [{ text: "💬 Escribirle a mi equipo", callback_data: "menu:atencion" }],
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
