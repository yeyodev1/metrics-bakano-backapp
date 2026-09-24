import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";
import { resendService } from "../src/services/resend.service";

/**
 * Le explica a todos los clientes que la produccion es para su avatar y sus
 * productos, y que se hace una cada 6 meses.
 *
 *   npx tsx scripts/aviso-regla-produccion.ts            → ensayo
 *   npx tsx scripts/aviso-regla-produccion.ts --enviar   → envia
 *   ... --solo correo@cliente.com                        → uno suelto
 *
 * Mismas reglas que el resto de envios masivos: solo clientes de entornos
 * activos, nunca el equipo de Bakano, uno por uno con pausa, y se marca a
 * quien ya se le escribio para que repetir la corrida no duplique correos.
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
    .select("name email isInternal workspaceId workspaces avisoReglaProduccionEn")
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
      return !u.avisoReglaProduccionEn;
    }) as any[];

  console.log(`Entornos activos: ${activos.length}`);
  console.log(`Destinatarios: ${destinatarios.length}${solo ? ` (solo ${solo})` : ""}`);
  if (!enviar) {
    console.log("\nENSAYO — no se envía nada. Agrega --enviar.\n");
    destinatarios.slice(0, 8).forEach((u) => console.log(`  ${u.name} <${u.email}> · ${u.entorno}`));
    if (destinatarios.length > 8) console.log(`  … y ${destinatarios.length - 8} más`);
    await mongoose.disconnect();
    return;
  }

  let enviados = 0;
  const fallados: string[] = [];
  for (const [i, u] of destinatarios.entries()) {
    try {
      await resendService.sendReglaProduccion({
        to: u.email,
        recipientName: u.name,
        workspaceName: u.entorno,
        botUrl: BOT_URL,
      });
      await models.users.updateOne({ _id: u._id }, { $set: { avisoReglaProduccionEn: new Date() } });
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
