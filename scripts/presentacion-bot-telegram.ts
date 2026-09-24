import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";
import { resendService } from "../src/services/resend.service";

/**
 * Le presenta el bot de Telegram a los clientes que ya usan la plataforma.
 *
 *   npx tsx scripts/presentacion-bot-telegram.ts            → ensayo, no envía
 *   npx tsx scripts/presentacion-bot-telegram.ts --enviar   → envía de verdad
 *   ... --solo dreyes@bakano.ec                             → un correo suelto
 *
 * Reglas:
 * - Solo usuarios activos de entornos ACTIVOS.
 * - Nunca al equipo de Bakano (isInternal o @bakano.ec), salvo con --solo.
 * - Uno por uno, con pausa: no es un envío en bloque, y si uno falla se
 *   anota y se sigue con el resto.
 * - Se marca a quién ya se le envió, para poder repetir la corrida sin que a
 *   nadie le llegue dos veces.
 */

const BOT_URL = process.env.TELEGRAM_BOT_URL || "https://t.me/BakanoAgencyBot";
const PAUSA_MS = 700;
const BLOQUEADOS = ["lreyes@bakano.ec"];

async function main() {
  const args = process.argv.slice(2);
  const enviar = args.includes("--enviar");
  const solo = args.includes("--solo") ? args[args.indexOf("--solo") + 1]?.toLowerCase() : undefined;

  await mongoose.connect(process.env.DB_URI!);

  const activos = await models.workspaces.find({ isActive: true }).select("_id name").lean();
  const nombrePorId = new Map(activos.map((w) => [String(w._id), w.name]));
  const ids = new Set(nombrePorId.keys());

  const usuarios = await models.users
    .find({ isActive: true })
    .select("name email isInternal workspaceId workspaces presentacionBotEnviadaEn")
    .lean();

  const destinatarios = usuarios
    .map((u: any) => {
      const propios = [u.workspaceId, ...(u.workspaces || []).map((w: any) => w.workspaceId?._id ?? w.workspaceId)]
        .filter(Boolean)
        .map(String);
      const entorno = propios.find((id) => ids.has(id));
      return entorno ? { ...u, entorno: nombrePorId.get(entorno)! } : null;
    })
    .filter(Boolean)
    .filter((u: any) => {
      const correo = String(u.email || "").toLowerCase();
      if (!correo || BLOQUEADOS.includes(correo)) return false;
      if (solo) return correo === solo;
      if (u.isInternal || correo.endsWith("@bakano.ec")) return false;
      return !u.presentacionBotEnviadaEn;
    }) as any[];

  console.log(`Entornos activos: ${activos.length}`);
  console.log(`Destinatarios: ${destinatarios.length}${solo ? ` (solo ${solo})` : ""}`);
  if (!enviar) {
    console.log("\nENSAYO — no se envía nada. Agrega --enviar para mandarlos.\n");
    destinatarios.slice(0, 10).forEach((u) => console.log(`  ${u.name} <${u.email}> · ${u.entorno}`));
    if (destinatarios.length > 10) console.log(`  … y ${destinatarios.length - 10} más`);
    await mongoose.disconnect();
    return;
  }

  let enviados = 0;
  const fallados: string[] = [];
  for (const [i, u] of destinatarios.entries()) {
    try {
      await resendService.sendPresentacionBot({
        to: u.email,
        recipientName: u.name,
        workspaceName: u.entorno,
        botUrl: BOT_URL,
        correoCliente: u.email,
      });
      await models.users.updateOne({ _id: u._id }, { $set: { presentacionBotEnviadaEn: new Date() } });
      enviados++;
      console.log(`  ${i + 1}/${destinatarios.length} ✓ ${u.email} · ${u.entorno}`);
    } catch (error: any) {
      fallados.push(u.email);
      console.error(`  ${i + 1}/${destinatarios.length} ✗ ${u.email}: ${error?.message || error}`);
    }
    await new Promise((r) => setTimeout(r, PAUSA_MS));
  }

  console.log(`\nEnviados: ${enviados} · Fallados: ${fallados.length}`);
  if (fallados.length) console.log(`Reintentar: ${fallados.join(", ")}`);
  await mongoose.disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
