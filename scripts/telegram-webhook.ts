import "dotenv/config";
import axios from "axios";

/**
 * Registra (o revisa) el webhook de @BakanoAgencyBot.
 *
 *   npx ts-node scripts/telegram-webhook.ts set https://<backend>/v1/webhooks/telegram
 *   npx ts-node scripts/telegram-webhook.ts info
 *   npx ts-node scripts/telegram-webhook.ts delete
 *
 * Usa TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET del .env. El secreto viaja
 * en cada update como `X-Telegram-Bot-Api-Secret-Token` y el backend lo exige.
 */
const token = process.env.TELEGRAM_BOT_TOKEN;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
const api = `https://api.telegram.org/bot${token}`;

async function main() {
  const [accion, url] = process.argv.slice(2);
  if (!token) throw new Error("Falta TELEGRAM_BOT_TOKEN en el .env");

  if (accion === "set") {
    if (!url?.startsWith("https://")) throw new Error("Pasa la URL https del webhook");
    if (!secret || !/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
      throw new Error("TELEGRAM_WEBHOOK_SECRET debe tener solo letras, números, _ o - (máx. 256)");
    }
    const { data } = await axios.post(`${api}/setWebhook`, {
      url,
      secret_token: secret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    console.log(data);
  } else if (accion === "delete") {
    const { data } = await axios.post(`${api}/deleteWebhook`, { drop_pending_updates: true });
    console.log(data);
  }

  const { data } = await axios.get(`${api}/getWebhookInfo`);
  console.log(data.result);
}

main().catch((error) => {
  console.error(error.response?.data ?? error.message);
  process.exit(1);
});
