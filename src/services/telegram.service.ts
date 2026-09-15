import axios from "axios";

/**
 * Cliente minimo de la Bot API de Telegram (https://core.telegram.org/bots/api).
 * Solo lo que usa el bot: mandar mensajes con botones y contestar clics.
 */

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
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

export class TelegramService {
  // Lazy: se lee el env al llamar, no al importar el modulo.
  private get api(): string {
    return `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;
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
