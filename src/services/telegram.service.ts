import axios from "axios";

/**
 * Cliente minimo de la Bot API de Telegram (https://core.telegram.org/bots/api).
 * Solo lo que usa el bot: mandar mensajes con botones y contestar clics.
 */

/** Telegram exige exactamente uno: o `callback_data` o `url`. */
export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    /** Pie de foto o del archivo: ahí suele venir "este es mi logo". */
    caption?: string;
    /** Foto comprimida por Telegram (varios tamaños, el último es el mayor). */
    photo?: { file_id: string; file_size?: number; width?: number; height?: number }[];
    /** Archivo enviado "como archivo": conserva el formato original. */
    document?: { file_id: string; file_name?: string; mime_type?: string; file_size?: number };
  };
  callback_query?: {
    id: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number; type: string } };
    data?: string;
  };
}

/** Telegram parsea HTML: cualquier nombre de cliente va escapado. */
export function escaparHtml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Un archivo que mandó el cliente, ya descargado de Telegram. */
export interface ArchivoDeTelegram {
  buffer: Buffer;
  nombre: string;
  mime: string;
  /** true si Telegram lo comprimió a JPG (se envió como foto, no como archivo). */
  comprimido: boolean;
}

export class TelegramService {
  // Lazy: se lee el env al llamar, no al importar el modulo.
  private get api(): string {
    return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
  }

  /**
   * Descarga un archivo del chat. Telegram da primero una ruta temporal y
   * luego el binario; el token va en la URL, por eso no se loguea.
   */
  async descargarArchivo(fileId: string): Promise<Buffer | null> {
    try {
      const { data } = await axios.get(`${this.api}/getFile`, { params: { file_id: fileId }, timeout: 15_000 });
      const ruta = data?.result?.file_path;
      if (!ruta) return null;
      const archivo = await axios.get(`https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${ruta}`, {
        responseType: "arraybuffer",
        timeout: 30_000,
      });
      return Buffer.from(archivo.data);
    } catch (error: any) {
      console.error("[Telegram] no se pudo descargar el archivo:", error.response?.status || error.message);
      return null;
    }
  }

  async sendMessage(chatId: number, text: string, botones?: InlineButton[][]): Promise<void> {
    await axios.post(`${this.api}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      ...(botones ? { reply_markup: { inline_keyboard: botones } } : {}),
    });
  }

  /** Manda un archivo (el PDF del contrato) con un texto y botones abajo. */
  async sendDocument(
    chatId: number,
    archivo: Buffer,
    nombre: string,
    caption?: string,
    botones?: InlineButton[][]
  ): Promise<void> {
    const form = new FormData();
    form.append("chat_id", String(chatId));
    form.append("document", new Blob([new Uint8Array(archivo)], { type: "application/pdf" }), nombre);
    if (caption) {
      form.append("caption", caption.slice(0, 1024));
      form.append("parse_mode", "HTML");
    }
    if (botones) form.append("reply_markup", JSON.stringify({ inline_keyboard: botones }));
    await axios.post(`${this.api}/sendDocument`, form, { timeout: 60_000 });
  }

  /** "escribiendo..." mientras la IA piensa. Dura 5 s o hasta el siguiente mensaje. */
  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    await axios.post(`${this.api}/sendChatAction`, { chat_id: chatId, action });
  }

  /** Sin esto el boton se queda con el relojito girando en Telegram. */
  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await axios.post(`${this.api}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }
}

export const telegramService = new TelegramService();
