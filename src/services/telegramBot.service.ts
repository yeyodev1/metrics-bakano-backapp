import { createHash, randomInt, timingSafeEqual } from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { resendService } from "./resend.service";
import { EQUIPO_ATENCION, equipoAtencionService, type TemaAtencion } from "./equipoAtencion.service";
import { atencionClienteService, diaEcuador, fechaEcuador, horarioCorto } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { produccionPlanificacionService } from "./produccionPlanificacion.service";
import { contenidoClienteService } from "./contenidoCliente.service";
import { recorridoClienteService } from "./recorridoCliente.service";
import { perfilClienteService } from "./perfilCliente.service";
import { CAMPOS_MARCA, OPCIONES_MARCA, PREGUNTA_MARCA, onboardingDatosService } from "./onboardingDatos.service";
import { citasClienteService } from "./citasCliente.service";
import { equipoEnTexto, DIRECCION } from "./equipoBakano.service";
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
const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
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
      this.registrarUso(doc, cq.data, "boton");
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
        // "cambiar correo", "me equivoqué de mail"…: pedirle el correcto en vez
        // de repetirle que el código tiene 6 números, que es lo que hacía antes.
        if (/correo|mail|equivoqu|corregir|cambiar/i.test(texto) && !/^\d/.test(texto.trim())) {
          await telegramService.sendMessage(
            chat.chatId,
            "Claro 😊 escríbeme aquí el correo correcto (el que usas en <b>metrics.bakano.ec</b>) y te mando el código ahí."
          );
          return;
        }
        return this.recibirCodigo(chat, texto);
      case "eligiendo_entorno":
        return this.pedirEntorno(chat);
      case "listo":
        this.registrarUso(chat, "mensaje", "texto", texto);
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

        // Le pedimos el link o el número donde cae la venta: eso se lee antes
        // que la IA, si no se pierde en la conversación y nunca queda guardado.
        if (chat.datoEsperado?.campo && chat.workspaceId && texto.trim()) {
          const campo = chat.datoEsperado.campo;
          const r = await onboardingDatosService.registrarDatoMarca(chat, campo, texto.trim(), true);
          if (r.ok) {
            chat.datoEsperado = undefined;
            await chat.save();
            // Encadena: guardado uno, va el siguiente. Preguntar de a uno y
            // seguir solo es lo que hace que esto se termine.
            if (campo === "trafficLink") {
              await telegramService.sendMessage(
                chat.chatId,
                "Listo, lo guardé ✅ Con eso ya sabemos a dónde mandar a la gente que vea tus videos."
              );
              return this.preguntarSiguienteDato(chat);
            }
            return this.preguntarSiguienteDato(chat);
          }
          await telegramService.sendMessage(
            chat.chatId,
            `${escaparHtml(String((r as any).motivo || "No pude guardarlo"))}\n\nInténtalo de nuevo 👇`,
            [
              [{ text: "⏭️ Saltar por ahora", callback_data: "dm:saltar" }],
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
        // La IA no pudo. Antes contestaba "se me trabó" y el cliente se quedaba
        // igual que al principio: ahora se le lleva a la pantalla de lo que
        // estaba pidiendo, que es lo que habría hecho una persona.
        return this.atajoPorLoQuePidio(chat, texto);
        return;
    }
  }

  /**
   * Cuando la IA no alcanza a contestar, el cliente no se queda en el aire: se
   * lee lo que pidió y se le abre esa pantalla. Si no se entiende, se le
   * ofrece pasarlo a una persona, que es lo único que nunca falla.
   */
  private async atajoPorLoQuePidio(chat: ITelegramChat, texto: string): Promise<void> {
    const t = texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    const disculpa = "Uy, se me trabó eso 😅 pero no te dejo esperando";

    if (/(cita|agend|reagend|reprogram|mover|cancel|horario)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Te muestro tus citas 👇`);
      return this.mostrarCitas(chat);
    }
    if (/(guion|libreto|script)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Vamos a tus guiones 👇`);
      return this.mostrarGuiones(chat);
    }
    if (/(produccion|grabacion|grabar|rodaje)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Vamos a tu producción 👇`);
      return this.mostrarProducciones(chat);
    }
    if (/(factur|venta|vendi|ingreso|monto)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Vamos a tu facturación 👇`);
      return this.mostrarFacturacion(chat);
    }
    if (/(onboarding|arranc|empez|comenz|inicio)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Así va tu onboarding 👇`);
      return this.mostrarOnboarding(chat);
    }
    if (/(hablar|habla|alguien|persona|humano|asesor|urgent|ayuda|contact|llam)/.test(t)) {
      await telegramService.sendMessage(chat.chatId, `${disculpa}. Te paso con una persona ahora mismo 👇`);
      return this.elegirTema(chat, "atencion");
    }
    await telegramService.sendMessage(
      chat.chatId,
      `${disculpa} 🙏\n\nDime con otras palabras qué necesitas, o toca una opción y lo resolvemos por aquí.`,
      [
        [{ text: "💬 Pasarlo a una persona", callback_data: "menu:atencion" }],
        [{ text: "🗓️ Mis citas", callback_data: "citas:ver" }],
        [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async recibirCorreo(chat: ITelegramChat, texto: string): Promise<void> {
    const correo = texto.toLowerCase().trim();
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

    // Escribio OTRO correo mientras esperaba el codigo: se equivoco en el
    // primero. La correccion se aplica sola y el flujo sigue; el anterior
    // queda a un boton de distancia por si el equivocado era este.
    const corrigio = chat.estado === "esperando_codigo" && Boolean(chat.correoPendiente) && correo !== chat.correoPendiente;
    const anterior = corrigio ? chat.correoPendiente : undefined;

    // El limite de reenvio es por correo: si esta corrigiendo el suyo, no se
    // le puede decir "ya te mande uno" y dejarlo esperando un minuto.
    if (correo === chat.correoPendiente && chat.codigoEnviadoEn && Date.now() - chat.codigoEnviadoEn.getTime() < REENVIO_SEGUNDOS * 1000) {
      await telegramService.sendMessage(
        chat.chatId,
        "Ya te mandé un código hace un momentito! 📬 Revisa tu bandeja (y el spam, por si acaso). Si no llega, espera un minuto y vuelve a escribir tu correo."
      );
      return;
    }

    const codigo = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const usuario = await models.users.findOne({ email: correo, isActive: true }).select("name email").lean();

    chat.correoPendiente = correo;
    // Se guarda el anterior para el boton de "no, era el otro".
    chat.correoPropuesto = anterior;
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

    const botones: InlineButton[][] = [];
    if (anterior) botones.push([{ text: `↩️ No, era ${anterior.slice(0, 28)}`, callback_data: "mail:no" }]);
    botones.push([{ text: "✉️ Escribir otro correo", callback_data: "mail:otro" }]);

    await telegramService.sendMessage(
      chat.chatId,
      (anterior
        ? `Listo, lo corregí ✅\n\nCambié tu correo a <b>${escaparHtml(correo)}</b> y te mandé ahí el código de 6 dígitos ` +
          `(el de <s>${escaparHtml(anterior)}</s> ya no sirve).\n\n`
        : `Perfecto! 📬 Si <b>${escaparHtml(correo)}</b> tiene cuenta en metrics.bakano.ec, te acabo de enviar un código de 6 dígitos.\n\n`) +
        `Escríbelo aquí 👇 (vence en ${CODIGO_MINUTOS} minutos). Si te volviste a equivocar, solo escribe el correo correcto.\n\n` +
        "Si en unos minutos no te llega, revisa el spam. Si tampoco está, ese correo todavía no tiene un <b>entorno creado</b> en metrics.bakano.ec: pídele a tu asesor de Bakano que lo cree o escríbenos a soporte@bakano.ec. Sin entorno no puedo conectarte.",
      botones
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

  /**
   * Queda registro de lo que el cliente hace aqui. Nunca bloquea ni rompe la
   * respuesta: si el registro falla, el bot sigue contestando igual.
   */
  private registrarUso(chat: ITelegramChat, accion: string, origen: "boton" | "texto" | "ia", detalle?: string): void {
    if (chat.estado !== "listo") return;
    models.usoBot
      .create({
        workspaceId: chat.workspaceId,
        userId: chat.userId,
        chatId: chat.chatId,
        accion: accion.slice(0, 120),
        origen,
        detalle: detalle?.slice(0, 500),
        en: new Date(),
      })
      .catch((error: any) => console.error("[Uso] no se pudo registrar:", error?.message || error));
  }

  // ── Botones ────────────────────────────────────────────────────────────────
  private async onBoton(chat: ITelegramChat, data: string): Promise<void> {
    // Corregir el correo pasa ANTES de estar vinculado: si no, el boton
    // reiniciaba el login y el cliente volvia al punto de partida.
    // Se arrepintio del cambio: se vuelve al correo anterior y se le manda un
    // codigo nuevo ahi mismo, sin hacerlo esperar el minuto de reenvio.
    if (data === "mail:no") {
      const anterior = chat.correoPropuesto;
      chat.correoPropuesto = undefined;
      chat.codigoEnviadoEn = undefined;
      await chat.save();
      if (!anterior) return this.reiniciar(chat, PEDIR_CORREO);
      return this.recibirCorreo(chat, anterior);
    }
    if (data === "mail:otro") {
      await telegramService.sendMessage(
        chat.chatId,
        "Claro 😊 escríbeme aquí el correo correcto (el que usas en <b>metrics.bakano.ec</b>) y te mando el código ahí."
      );
      return;
    }
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
    if (data === "menu:equipo") return this.mostrarEquipo(chat);
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
    if (data === "datos:contar") return this.preguntarSiguienteDato(chat);
    // dm:<campo>:<indice> — eligió una de las opciones fijas.
    if (data.startsWith("dm:")) {
      const [, campo, indice] = data.split(":");
      const opcion = OPCIONES_MARCA[campo || ""]?.[Number(indice)];
      if (!campo || !opcion) return this.preguntarSiguienteDato(chat);
      await onboardingDatosService.registrarDatoMarca(chat, campo, opcion.valor, true);
      return this.preguntarSiguienteDato(chat);
    }
    if (data === "dm:saltar") {
      const campo = chat.datoEsperado?.campo;
      chat.datoEsperado = undefined;
      await chat.save();
      return this.preguntarSiguienteDato(chat, campo);
    }
    if (data === "venta:donde") return this.preguntarDondeCaeLaVenta(chat);
    if (data === "venta:wh") return this.guardarDireccionVenta(chat, "WhatsApp");
    if (data === "venta:ghl") return this.guardarDireccionVenta(chat, "GHL / Agenda");
    if (data === "venta:nose") return this.ayudaConLaVenta(chat);
    // cc:m:<ref> mueve · cc:c:<ref> cancela · cs:<epoch>:<ref> elige horario
    if (data.startsWith("cc:m:")) return this.mostrarHorariosParaMover(chat, data.slice(5));
    if (data.startsWith("cc:c:")) return this.pedirConfirmacionCita(chat, { accion: "cancelar", ref: data.slice(5) });
    // cc:u:<m|c>:<ref> — es en menos de dos días: no lo cambia él, lo coordina el equipo.
    if (data.startsWith("cc:u:")) return this.avisarCambioSobreLaHora(chat, data.slice(7), data[5] === "m" ? "mover" : "cancelar");
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

  /** El equipo en cadena: quién hace qué y con quién se habla en cada paso. */
  private async mostrarEquipo(chat: ITelegramChat): Promise<void> {
    await telegramService.sendMessage(
      chat.chatId,
      "👥 <b>Así trabajamos contigo</b>\n\n" +
        `${equipoEnTexto()}\n\n` +
        `${escaparHtml(DIRECCION.texto)}\n\n` +
        "Escríbeme lo que necesites y yo lo dirijo a quien le toca 💛",
      [
        [{ text: "📅 Agendar una reunión", callback_data: "menu:agendar" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async elegirTema(chat: ITelegramChat, tema: TemaAtencion): Promise<void> {
    if (tema === "guiones") {
      const revision = await revisionGuionesService.pendiente(chat.workspaceId!);
      if (revision && !revision.produccion?.ventanaCerrada) return this.invitarARevisar(chat, revision);
      return this.mostrarGuiones(chat);
    }
    if (tema === "produccion") return this.mostrarProducciones(chat);
    chat.tema = tema;
    await chat.save();

    // Producción y guiones tienen su propia pantalla con datos; aquí llega
    // atención, donde lo útil es que escriba y se lo pasemos.
    const { etiqueta, personas } = EQUIPO_ATENCION[tema];
    await telegramService.sendMessage(
      chat.chatId,
      `${EMOJI_TEMA[tema]} Para ${etiqueta} te atiende${personas.length > 1 ? "n" : ""} <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> 💛\n\n` +
        "Cuéntame qué necesitas y se lo paso ahora mismo a su correo 📩\n\n" +
        "Prefieres hablarlo en persona? Toca abajo 👇",
      [
        [{ text: "📅 Agendar una reunión", callback_data: `ag:${tema}` }],
        [{ text: "👥 Quién es quién en Bakano", callback_data: "menu:equipo" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  /** Cuántos guiones hay, en qué estado, y el link para verlos en Metrics. */
  private async mostrarGuiones(chat: ITelegramChat): Promise<void> {
    // Aquí SÍ entran las producciones canceladas: los guiones escritos no se
    // van con la fecha. Si se movió o se canceló la grabación, el cliente
    // igual tiene que poder revisar lo que Ariana ya escribió.
    const entradas = await models.planning
      .find({ workspaceId: chat.workspaceId })
      .sort({ date: -1 })
      .limit(6)
      .select("_id date title cancelada")
      .lean();
    const planes = entradas.length
      ? await models.videoPlanning
          .find({ planningEntryId: { $in: entradas.map((e) => e._id) } })
          .select("planningEntryId items listaParaCliente")
          .lean()
      : [];

    const botones: InlineButton[][] = [];
    const lineas: string[] = [];
    for (const e of entradas) {
      const plan = planes.find((p) => String(p.planningEntryId) === String(e._id));
      const total = plan?.items?.length ?? 0;
      if (!total) continue;
      const aprobados = (plan?.items || []).filter((i: any) => i.clienteAprobacion === "APROBADO").length;
      lineas.push(
        `📝 <b>${total} guiones</b> · producción del ${fechaEcuador(e.date)}${(e as any).cancelada ? " (grabación cancelada)" : ""}\n` +
          `     ${aprobados} aprobados · ${plan?.listaParaCliente ? "listos para tu revisión" : "en preparación"}`
      );
      if (plan?.listaParaCliente) {
        botones.push([
          {
            text: `📝 Ver los ${total} guiones en Metrics`,
            url: `${APP_URL}/app/workspaces/${chat.workspaceId}/planning/${e._id}/video-planning/client`,
          },
        ]);
      }
    }

    botones.push([{ text: "📅 Ver mi calendario", url: `${APP_URL}/app/workspaces/${chat.workspaceId}/planning` }]);
    botones.push([{ text: "📅 Agendar reunión con Ariana", callback_data: "ag:guiones" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    await telegramService.sendMessage(
      chat.chatId,
      lineas.length
        ? `📝 <b>Tus guiones</b>\n\n${lineas.join("\n\n")}\n\n` +
            `Los escribe <b>${escaparHtml(equipoAtencionService.nombres("guiones"))}</b> a partir de tu estrategia. ` +
            "Puedes verlos en Metrics, o decirme por aquí qué cambiarías y yo se lo paso."
        : "📝 Todavía no tienes guiones cargados.\n\n" +
            `Los escribe <b>${escaparHtml(equipoAtencionService.nombres("guiones"))}</b> después de tu sesión de estrategia y de tu producción. ` +
            "Apenas estén listos te aviso por aquí para que los revises.",
      botones
    );
  }

  /** Si hay producciones o no, con el calendario de Metrics a un toque. */
  private async mostrarProducciones(chat: ITelegramChat): Promise<void> {
    const ahora = new Date();
    const [proximas, ultima, estado] = await Promise.all([
      models.planning
        .find({ workspaceId: chat.workspaceId, date: { $gte: ahora }, title: { $not: /^CANCELADA/ }, cancelada: { $ne: true } })
        .sort({ date: 1 })
        .limit(3)
        .select("date title")
        .lean(),
      models.planning
        .findOne({ workspaceId: chat.workspaceId, date: { $lt: ahora }, title: { $not: /^CANCELADA/ }, cancelada: { $ne: true } })
        .sort({ date: -1 })
        .select("date cumplida")
        .lean(),
      atencionClienteService.estadoProduccion(chat.workspaceId!),
    ]);

    const lineas = [
      proximas.length
        ? proximas.map((p) => `🎬 <b>${fechaEcuador(p.date)}</b>`).join("\n")
        : "🎬 No tienes ninguna producción agendada.",
      ultima ? `\nLa última fue el ${fechaEcuador(ultima.date)}${ultima.cumplida ? " y ya quedó grabada ✅" : ""}.` : "",
      `\nGraban <b>${escaparHtml(equipoAtencionService.nombres("produccion"))}</b>: tu avatar, tus productos y los recursos que hagan falta.`,
      estado.reserva ? `\n${contenidoClienteService.enTexto(estado.reserva)}` : "",
      // Grabamos hasta quedarnos sin contenido: si ya no queda nada escrito
      // por grabar, no se le dice "espera al mes que viene".
      estado.sinContenido
        ? "\n👉 <b>Toca agendar la siguiente ya</b>: cuando salga lo que está en edición, no queda nada más que publicar."
        : estado.puedeAgendar && estado.habilitadaDesde
          ? `\nPuedes agendar la siguiente desde el ${fechaEcuador(estado.habilitadaDesde)}.`
          : "",
    ]
      .filter(Boolean)
      .join("\n");

    const botones: InlineButton[][] = [
      [{ text: "📅 Ver mi calendario en Metrics", url: `${APP_URL}/app/workspaces/${chat.workspaceId}/planning` }],
    ];
    if (estado.puedeAgendar) botones.push([{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }]);
    else if (proximas.length) botones.push([{ text: "🗓️ Mover o cancelar", callback_data: "citas:ver" }]);
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    await telegramService.sendMessage(chat.chatId, `🎬 <b>Tus producciones</b>\n\n${lineas}`, botones);
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


  /**
   * Ultimo filtro antes de reservar: el boton pudo quedarse abierto desde
   * antes de que agendara otra cosa. Si ya tiene esa hora ocupada, se lo dice
   * con nombre y apellido en vez de dejarlo con dos citas a la vez.
   */
  private async chocaConSuAgenda(chat: ITelegramChat, inicio: Date, duracionMs?: number): Promise<boolean> {
    const r = await citasClienteService.puedeA(chat, inicio, { duracionMs });
    if (r.ok) return false;
    await telegramService.sendMessage(
      chat.chatId,
      `A esa hora <b>ya tienes algo con nosotros</b> ⛔\n\n` +
        `🗓️ <b>${escaparHtml(r.choca.etiqueta)}</b> · ${r.choca.cuando}\n     con ${escaparHtml(r.choca.con)}\n\n` +
        "Aunque el equipo esté libre a esa hora, tú no puedes estar en las dos. " +
        "Elige otro horario, o si prefieres mover la que ya tienes, dale a “Ver mis citas”.",
      [
        [{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
    return true;
  }

  /** Lo que se le dice cuando se le quitaron horarios por su propia agenda. */
  private avisoChoques(quitados: number): string {
    if (!quitados) return "";
    return (
      `\n\n🔒 Quité ${quitados === 1 ? "un horario" : `${quitados} horarios`} en los que <b>ya tienes algo agendado con nosotros</b>. ` +
      "Aunque el equipo esté libre a esa hora, tú no puedes estar en dos reuniones a la vez."
    );
  }

  private async mostrarHorarios(chat: ITelegramChat, tema: TemaAtencion, aviso?: string): Promise<void> {
    const crudos = await atencionClienteService.horariosLibres(tema);
    if (crudos === null) return this.coordinarPorCorreo(chat, tema, aviso);
    if (!crudos.length) {
      return this.coordinarPorCorreo(chat, tema, "No encontré horarios libres esta semana en su calendario 😅");
    }
    // El cliente es uno solo: si a esa hora ya tiene otra cita con nosotros,
    // no se la ofrecemos aunque el calendario del equipo esté libre.
    const { horarios, quitados } = await citasClienteService.sinChoques(chat, crudos);
    if (!horarios.length) {
      return this.coordinarPorCorreo(
        chat,
        tema,
        "Todos los horarios libres de esta semana chocan con citas que ya tienes con nosotros 😅"
      );
    }

    const botones = this.botonesHorarios(horarios, (h) => `slot:${tema}:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "✍️ Prefiero escribirles", callback_data: `menu:${tema}` }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${aviso ? `${aviso}\n\n` : ""}Genial! 🙌 Estos son los próximos horarios libres de <b>${escaparHtml(equipoAtencionService.nombres(tema))}</b> (hora Ecuador).\n\nElige el que mejor te quede 👇` +
        this.avisoChoques(quitados),
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
    const recorrido = await recorridoClienteService.de(chat.workspaceId!).catch(() => null);
    // Una sesión cuya fecha ya pasó no se pinta como "la tienes agendada": en
    // "Mis citas" ya no aparece (ahí solo van las futuras) y el cliente veía
    // dos respuestas distintas a la misma pregunta.
    // El recorrido entero, también lo que pasa dentro del equipo: saber que su
    // video está en la mesa de Javier y no "en proceso" evita media docena de
    // mensajes preguntando.
    const lineas = recorrido ? [recorridoClienteService.enTexto(recorrido.etapas)] : [];

    // Una sola cosa por hacer ahora. El resto queda en los botones de abajo.
    const siguiente = estado.sesiones.find((s) => s.sesion === estado.siguiente);
    const agendada = estado.sesiones.find((s) => s.agendada && !hecha(s) && !s.pasada);
    const pasada = estado.sesiones.find((s) => s.pasada && !hecha(s));
    const ahora = siguiente
      ? `👉 <b>Ahora:</b> agenda tu sesión de <b>${siguiente.etiqueta}</b> con <b>${escaparHtml(siguiente.responsable)}</b>.\n` +
        `${siguiente.resumen}\n\nTen listo:\n${siguiente.requisitos.map((r) => `• ${r}`).join("\n")}`
      : agendada
        ? `👉 <b>Ahora:</b> tu sesión de <b>${agendada.etiqueta}</b> es el <b>${agendada.fecha ? fechaEcuador(agendada.fecha) : "día agendado"}</b>. ` +
          `Cuando ${escaparHtml(agendada.responsable)} la dé por cerrada, te aviso y seguimos.`
        : pasada
          ? `👉 <b>Ahora:</b> tu sesión de <b>${pasada.etiqueta}</b> fue el <b>${pasada.fecha ? fechaEcuador(pasada.fecha) : "día agendado"}</b>, así que ya no aparece en tus citas. ` +
            `Estoy esperando que <b>${escaparHtml(pasada.responsable)}</b> la dé por cerrada. Si al final no se hizo, la reagendamos ahora mismo 👇`
          : estado.produccion.agendada
          ? "👉 <b>Ahora:</b> a preparar tu producción. Cualquier duda me escribes 💛"
          : "👉 <b>Ahora:</b> agenda tu primera producción y arrancamos 🎬";

    const faltaEnviar = (pendientes?.entregables || []).filter((e) => e.estado === "pendiente");
    const faltaContar = pendientes?.datosMarcaFaltantes || [];

    const botones: InlineButton[][] = [];
    if (siguiente) botones.push([{ text: `📅 Agendar ${siguiente.etiqueta}`, callback_data: `onb:${siguiente.sesion}` }]);
    else if (pasada) botones.push([{ text: `🔄 No se hizo, reagendar ${pasada.etiqueta}`, callback_data: `onb:${pasada.sesion}` }]);
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
    // Dónde cae la venta tiene su propio botón: sin ese dato los videos no
    // tienen a dónde mandar a la gente, y preguntarlo suelto no funcionaba.
    const faltaVenta = faltaContar.some((d) => d.campo === "trafficDirection" || d.campo === "trafficLink");
    if (faltaVenta) botones.push([{ text: "🎯 Dónde capturo mis ventas", callback_data: "venta:donde" }]);
    const otrosDatos = faltaContar.filter((d) => d.campo !== "trafficDirection" && d.campo !== "trafficLink");
    if (otrosDatos.length) botones.push([{ text: `✍️ Contarte de mi negocio (${otrosDatos.length})`, callback_data: "datos:contar" }]);
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const invitacionMeta = faltaEnviar.find((e) => e.clave === "invitacionMeta");
    await telegramService.sendMessage(
      chat.chatId,
      `🚀 <b>Tu recorrido con Bakano</b> · ${recorrido?.listas ?? 0} de ${recorrido?.etapas.length ?? 12} pasos listos\n\n` +
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

  /**
   * Va preguntando los datos de marca uno por uno, en el orden del proceso, y
   * se detiene solo cuando no queda ninguno. Con botones donde la respuesta es
   * una de tres: nadie debería tener que escribir "semicasual".
   */
  private async preguntarSiguienteDato(chat: ITelegramChat, saltar?: string): Promise<void> {
    const pendientes = await onboardingDatosService.pendientes(chat.workspaceId!).catch(() => null);
    const faltan = (pendientes?.datosMarcaFaltantes || [])
      .map((d) => d.campo)
      .filter((c) => c !== saltar && c !== "trafficDirection" && c !== "trafficLink");

    if (!faltan.length) {
      chat.datoEsperado = undefined;
      await chat.save();
      const faltaVenta = (pendientes?.datosMarcaFaltantes || []).some(
        (d) => d.campo === "trafficDirection" || d.campo === "trafficLink"
      );
      await telegramService.sendMessage(
        chat.chatId,
        "Listo, ya tengo los datos de tu marca ✅\n\n" +
          "Con esto Ariana escribe guiones que suenan a ti y no a cualquiera." +
          (faltaVenta ? "\n\nNos falta una sola cosa: a dónde mandamos a la gente que vea tus videos 👇" : ""),
        faltaVenta
          ? [
              [{ text: "🎯 Dónde capturo mis ventas", callback_data: "venta:donde" }],
              [{ text: "🚀 Cómo va mi onboarding", callback_data: "menu:onboarding" }],
            ]
          : [
              [{ text: "🚀 Cómo va mi onboarding", callback_data: "menu:onboarding" }],
              [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
            ]
      );
      return;
    }

    const campo = faltan[0]!;
    chat.datoEsperado = { campo, pedidoEn: new Date() };
    await chat.save();

    const opciones = OPCIONES_MARCA[campo];
    const botones: InlineButton[][] = [];
    if (opciones) {
      // Máximo dos por fila: con tres, Telegram recorta los nombres largos.
      for (let i = 0; i < opciones.length; i += 2) {
        botones.push(
          opciones.slice(i, i + 2).map((o, j) => ({ text: o.etiqueta, callback_data: `dm:${campo}:${i + j}` }))
        );
      }
    }
    botones.push([{ text: "⏭️ Saltar por ahora", callback_data: "dm:saltar" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const restantes = faltan.length - 1;
    await telegramService.sendMessage(
      chat.chatId,
      (PREGUNTA_MARCA[campo] || `Cuéntame: ${CAMPOS_MARCA[campo]}`) +
        (restantes ? `\n\n<i>Después de esta quedan ${restantes}.</i>` : "\n\n<i>Es la última.</i>"),
      botones
    );
  }

  /**
   * Dónde cae la venta: el dato que define a dónde mandamos a la gente que ve
   * los videos. Con botones, no preguntándolo suelto: es una decisión de dos
   * opciones y el cliente muchas veces no sabe cómo se llama cada una.
   */
  private async preguntarDondeCaeLaVenta(chat: ITelegramChat): Promise<void> {
    await telegramService.sendMessage(
      chat.chatId,
      "🎯 <b>Dónde capturas la venta</b>\n\n" +
        "Cuando alguien vea tu video y quiera comprarte, <b>a dónde lo mandamos?</b>\n\n" +
        "📱 <b>WhatsApp</b> · te escriben directo a tu número y tú cierras la venta ahí.\n" +
        "🗓️ <b>GHL / Agenda</b> · agendan una cita contigo en tu calendario y queda registrada en el CRM.\n\n" +
        "Si no sabes cuál te conviene, dale a “Todavía no lo sé” y lo vemos con el equipo 👇",
      [
        [
          { text: "📱 WhatsApp", callback_data: "venta:wh" },
          { text: "🗓️ GHL / Agenda", callback_data: "venta:ghl" },
        ],
        [{ text: "🤝 Todavía no lo sé", callback_data: "venta:nose" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async guardarDireccionVenta(chat: ITelegramChat, eleccion: string): Promise<void> {
    const r = await onboardingDatosService.registrarDatoMarca(chat, "trafficDirection", eleccion, true);
    if (!r.ok) return this.preguntarDondeCaeLaVenta(chat);
    const porWhatsapp = /whats/i.test(eleccion);
    chat.datoEsperado = { campo: "trafficLink", pedidoEn: new Date() };
    await chat.save();
    await telegramService.sendMessage(
      chat.chatId,
      `Perfecto, ${porWhatsapp ? "<b>WhatsApp</b>" : "<b>GHL / Agenda</b>"} ✅\n\n` +
        (porWhatsapp
          ? "Ahora mándame el <b>número de WhatsApp</b> al que quieres que te escriban, con código de país.\nPor ejemplo: <code>+593 99 123 4567</code>"
          : "Ahora mándame el <b>link de tu agenda</b> (el de tu calendario o formulario), pegándolo aquí.\nPor ejemplo: <code>https://...</code>") +
        "\n\nSi todavía no lo tienes, dale al botón y lo armamos con el equipo 👇",
      [[{ text: "🤝 Todavía no lo tengo", callback_data: "venta:nose" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]]
    );
  }

  private async ayudaConLaVenta(chat: ITelegramChat): Promise<void> {
    const campo = chat.datoEsperado?.campo === "trafficLink" ? "trafficLink" : "trafficDirection";
    chat.datoEsperado = undefined;
    await chat.save();
    const r = await onboardingDatosService.pedirAyudaConDato(chat, campo, "Lo dijo por el botón “Todavía no lo sé” del bot.");
    await telegramService.sendMessage(
      chat.chatId,
      r.ok
        ? `Tranquilo, esto lo armamos juntos 💛\n\nYa le avisé a <b>${escaparHtml(r.responsable)}</b> y lo dejan listo en <b>${escaparHtml(r.donde)}</b>. ` +
          "No lo pierdas de vista: sin ese dato los videos no tienen a dónde mandar a la gente, así que es de lo primero que vemos."
        : "Listo, lo dejo anotado y lo vemos con el equipo 💛",
      [
        [{ text: "🚀 Ver mi onboarding", callback_data: "menu:onboarding" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async mostrarHorariosOnboarding(chat: ITelegramChat, sesion: SesionOnboarding, aviso?: string): Promise<void> {
    if (!(sesion in SESIONES_ONBOARDING)) return this.mostrarOnboarding(chat);
    const def = SESIONES_ONBOARDING[sesion];
    const crudos = await onboardingBotService.horarios(sesion);
    const { horarios, quitados } = crudos?.length
      ? await citasClienteService.sinChoques(chat, crudos)
      : { horarios: crudos || [], quitados: 0 };
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
        "Elige el horario que te quede mejor 👇" +
        this.avisoChoques(quitados),
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
      // Aquí solo van las futuras. Si tiene una sesión cuya fecha ya pasó y
      // nadie la cerró, se le dice: si no, en el onboarding la ve con fecha y
      // aquí le decimos que no tiene nada, y son dos verdades distintas.
      const estado = await onboardingBotService.estado(chat.workspaceId!).catch(() => null);
      const pasadas = (estado?.sesiones || []).filter((s) => s.pasada && s.estado !== "cumplida" && s.estado !== "no_aplica");
      const nota = pasadas.length
        ? "\n\n" +
          pasadas
            .map(
              (s) =>
                `⏳ Tu sesión de <b>${escaparHtml(s.etiqueta)}</b> fue el ${s.fecha ? fechaEcuador(s.fecha) : "día agendado"}, por eso ya no sale aquí. ` +
                `Estoy esperando que ${escaparHtml(s.responsable)} la dé por cerrada.`
            )
            .join("\n\n")
        : "";
      await telegramService.sendMessage(
        chat.chatId,
        "No tienes citas agendadas por ahora 🗓️\n\nCuando agendes tu producción, una sesión o una reunión, van a aparecer aquí y las vas a poder mover o cancelar." +
          nota,
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
    let urgentes = 0;
    citas.forEach((cita, i) => {
      const n = i + 1;
      const urgente = citasClienteService.esUrgente(cita);
      if (urgente) urgentes++;
      lineas.push(
        `<b>${n}.</b> 🗓️ <b>${escaparHtml(cita.etiqueta)}</b>\n     ${fechaEcuador(cita.inicio)}\n     con ${escaparHtml(cita.con)}` +
          (urgente ? "\n     ⏰ falta menos de 2 días: la cambio igual, pero aviso a todo el equipo" : "")
      );
      // Hasta dos días antes la cambia él. Más cerca, el botón avisa al equipo.
      botones.push([
        { text: `🔄 Mover ${n}`, callback_data: `cc:m:${cita.ref}` },
        { text: `✖️ Cancelar ${n}`, callback_data: `cc:c:${cita.ref}` },
      ]);
    });
    botones.push([{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    const cierre =
      "Toca el número de la que quieras mover o cancelar 👇\n\n" +
      "ℹ️ <b>Lo ideal es avisar con más de 2 días.</b> Si falta menos, igual te la cambio, solo que le aviso a todo el equipo de esa cita para que reacomoden su día.\n\n" +
      `Y revisa tu planificación para que no se te cruce nada 👉 ${APP_URL}/app/workspaces/${chat.workspaceId}/planning` +
      (urgentes
        ? `\n\n⏰ ${urgentes === 1 ? "Una está" : `${urgentes} están`} dentro de esos 2 días: ${urgentes === 1 ? "esa la cambio" : "esas las cambio"} avisando a todo el equipo.`
        : "");
    await telegramService.sendMessage(chat.chatId, `Estas son tus citas 👇\n\n${lineas.join("\n\n")}\n\n${cierre}`, botones);
  }

  /**
   * Falta menos de dos días: no se toca el calendario a ciegas. Se le dice
   * claro, se avisa a todos los encargados de esa cita y se le recuerda mirar
   * la planificación.
   */
  private async avisarCambioSobreLaHora(chat: ITelegramChat, ref: string, accion: "mover" | "cancelar"): Promise<void> {
    const r = await citasClienteService.solicitarCambio(chat, ref, accion);
    if (!r.ok) return this.mostrarCitas(chat);
    await telegramService.sendMessage(
      chat.chatId,
      `Tu <b>${escaparHtml(r.etiqueta!.toLowerCase())}</b> del <b>${r.cuando}</b> es en menos de 2 días ⏰\n\n` +
        "Por eso no la cambio yo solo: ya le avisé a <b>todo el equipo de esa cita</b> " +
        `(${escaparHtml(r.correos!.join(", "))}) para que lo coordinen contigo hoy mismo.\n\n` +
        "Para la próxima: <b>mover o cancelar por tu cuenta se puede hasta 2 días antes</b>. " +
        "Revisa tu planificación y avísame con tiempo y lo hacemos al toque 👇",
      [
        [{ text: "📅 Ver mi planificación", url: `${APP_URL}/app/workspaces/${chat.workspaceId}/planning` }],
        [{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }],
        [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
      ]
    );
  }

  private async mostrarHorariosParaMover(chat: ITelegramChat, ref: string): Promise<void> {
    const { cita, horarios, motivo } = await citasClienteService.horariosParaMover(chat, ref);
    if (!cita) return this.mostrarCitas(chat);
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
      `Tu <b>${escaparHtml(cita.etiqueta.toLowerCase())}</b> está para el <b>${fechaEcuador(cita.inicio)}</b>.` +
        (citasClienteService.esUrgente(cita)
          ? "\n\n⏰ Es en menos de 2 días: te la muevo igual, solo que le aviso a todo el equipo de esa cita para que reacomoden su día."
          : "") +
        "\n\nElige la nueva fecha 👇",
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
        r.motivo === "horario_no_disponible"
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
      texto +=
        `\n\n📅 Échale un ojo a tu planificación para que no se te cruce nada: ${APP_URL}/app/workspaces/${chat.workspaceId}/planning\n\n` +
        "ℹ️ Recuerda: los cambios los puedes hacer tú hasta <b>2 días antes</b> de la cita.";
    } else if (r.motivo === "sin_cambio_pendiente" || r.motivo === "cambio_vencido") {
      texto = "Ese cambio ya no está vigente 😅 cuéntame de nuevo qué quieres mover o cancelar y lo armamos.";
    } else if (r.motivo === "en_curso") {
      texto = "Ya lo estoy procesando, dame un segundito 🙏";
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
    if (await this.chocaConSuAgenda(chat, inicio)) return;

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
    const { estado, horarios: crudos } = await atencionClienteService.horariosProduccion(chat.workspaceId!);
    // La grabación se lleva media mañana: si ya tiene algo cerca, no se ofrece.
    const { horarios, quitados } = crudos?.length
      ? await citasClienteService.sinChoques(chat, crudos, { duracionMs: 3 * 3_600_000 })
      : { horarios: crudos, quitados: 0 };
    const nombres = escaparHtml(equipoAtencionService.nombres("produccion"));
    const intro = aviso ? `${aviso}\n\n` : "";

    if (!estado.puedeAgendar) {
      chat.tema = "produccion";
      await chat.save();
      await telegramService.sendMessage(
        chat.chatId,
        `${intro}🎬 Ya tienes una producción agendada para el <b>${fechaEcuador(estado.proxima!)}</b>.\n\n` +
          (estado.reserva ? `${contenidoClienteService.enTexto(estado.reserva)}\n\n` : "") +
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
      estado.sinContenido && estado.ultima
        ? "Y esto es lo importante: <b>ya grabamos todo lo que estaba escrito</b>, así que no hay que esperar nada. Mientras antes grabemos, antes vuelves a tener contenido saliendo 🎯\n\n"
        : estado.esperar && estado.ultima
          ? `Tu última producción fue el ${fechaEcuador(estado.ultima)} y agendamos una cada 2 meses, así que te muestro horarios desde el <b>${fechaEcuador(estado.habilitadaDesde!)}</b>.\n\n`
          : "";
    const botones = this.botonesHorarios(horarios, (h) => `prod:${Math.floor(h.getTime() / 1000)}`);
    botones.push([{ text: "✍️ Prefiero escribirles", callback_data: "menu:produccion" }]);

    await telegramService.sendMessage(
      chat.chatId,
      `${intro}🎬 Agendemos tu producción con <b>${nombres}</b>.\n\n` +
        "Es la sesión en ambiente controlado para grabar las tomas de tu avatar y de los productos que vamos a promocionar.\n\n" +
        (estado.reserva ? `${contenidoClienteService.enTexto(estado.reserva)}\n\n` : "") +
        `${regla}Elige el horario que te quede mejor 👇` +
        this.avisoChoques(quitados),
      botones
    );
  }

  private async agendarProduccion(chat: ITelegramChat, segundos: string): Promise<void> {
    const inicio = new Date(Number(segundos) * 1000);
    if (Number.isNaN(inicio.getTime())) return this.mostrarHorariosProduccion(chat);
    if (await this.chocaConSuAgenda(chat, inicio, 3 * 3_600_000)) return;

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

    // Producción y planificación van juntas: si no tiene guiones, se lo dice
    // aquí mismo y el equipo de contenido ya quedó avisado.
    const estadoOnb = await onboardingBotService.estado(chat.workspaceId!).catch(() => null);
    const crmPendiente = Boolean(
      estadoOnb?.sesiones.find((x) => x.sesion === "especializacion" && x.estado !== "cumplida" && x.estado !== "no_aplica" && !x.agendada)
    );
    const botones: InlineButton[][] = [
      [{ text: "📋 Ver mi planificación", url: `${APP_URL}/app/workspaces/${chat.workspaceId}/planning` }],
    ];
    if (crmPendiente) botones.push([{ text: `📅 Agendar con ${SESIONES_ONBOARDING.especializacion.responsable.nombre.split(" ")[0]}`, callback_data: "onb:crm" }]);
    botones.push([{ text: "🗓️ Ver mis citas", callback_data: "citas:ver" }], [{ text: "📋 Volver al menú", callback_data: "menu:ver" }]);

    await telegramService.sendMessage(
      chat.chatId,
      "Listo, tu producción quedó agendada 🎬\n\n" +
        `📅 <b>${reserva.cuando}</b> (hora Ecuador)\n` +
        `👥 Con <b>${escaparHtml(equipoAtencionService.nombres("produccion"))}</b>\n\n` +
        "Ya está en su calendario y les avisé. Ten listos los productos que vamos a promocionar 💪" +
        produccionPlanificacionService.textoParaElCliente(reserva.planificacion ?? null, chat.workspaceId!, crmPendiente),
      botones
    );
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
    if (await this.chocaConSuAgenda(chat, inicio)) return;

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
        [{ text: "👥 Quién es quién en Bakano", callback_data: "menu:equipo" }],
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
