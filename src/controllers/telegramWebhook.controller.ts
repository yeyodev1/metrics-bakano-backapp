import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { telegramBotService } from "../services/telegramBot.service";
import type { TelegramUpdate } from "../services/telegram.service";

function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * POST /v1/webhooks/telegram
 *
 * Telegram manda cada mensaje de @BakanoAgencyBot aqui, con la cabecera
 * `X-Telegram-Bot-Api-Secret-Token` = `TELEGRAM_WEBHOOK_SECRET` (se fija al
 * registrar el webhook con `scripts/telegram-webhook.ts`).
 *
 * Se procesa antes de responder: en Vercel la funcion se congela al enviar la
 * respuesta. Siempre 200, aun con error: Telegram reintenta y el cliente
 * recibiria el mismo mensaje varias veces.
 */
export async function handleTelegramUpdate(req: Request, res: Response): Promise<void> {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!secret || !process.env.TELEGRAM_BOT_TOKEN) {
    res.status(503).json({ message: "El bot de Telegram no está configurado." });
    return;
  }
  if (!secretMatches(req.header("x-telegram-bot-api-secret-token"), secret)) {
    res.status(401).json({ message: "Webhook no autorizado." });
    return;
  }

  try {
    await telegramBotService.handleUpdate(req.body as TelegramUpdate);
  } catch (error) {
    console.error("[Telegram] error procesando update:", error);
  }
  res.sendStatus(200);
}
