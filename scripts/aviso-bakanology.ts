import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";
import { resendService } from "../src/services/resend.service";

/**
 * Le recuerda a los clientes que Bakanology va incluido en su suscripcion.
 *
 *   npx tsx scripts/aviso-bakanology.ts                  → ensayo
 *   npx tsx scripts/aviso-bakanology.ts --enviar         → envia a quien no lo recibio
 *   npx tsx scripts/aviso-bakanology.ts --enviar --todos → envia otra vez a todos
 *   ... --solo correo@cliente.com                        → uno suelto
 *
 * Se puede correr cuando haga falta: cuando alguien pregunta si tiene que
 * pagarla, despues de una tanda de altas, o para recordarles que la tienen.
 */
const ACADEMIA_URL = process.env.BAKANOLOGY_URL || "https://bakanology.com";
const PAUSA_MS = 700;
const BLOQUEADOS = ["lreyes@bakano.ec"];

async function main() {
  const args = process.argv.slice(2);
  const enviar = args.includes("--enviar");
  const todos = args.includes("--todos");
  const solo = args.includes("--solo") ? args[args.indexOf("--solo") + 1]?.toLowerCase() : undefined;

  await mongoose.connect(process.env.DB_URI!);
  const activos = await models.workspaces.find({ isActive: true }).select("_id name").lean();
  const nombrePorId = new Map(activos.map((w) => [String(w._id), w.name]));
  const ids = new Set(nombrePorId.keys());

  const usuarios = await models.users
    .find({ isActive: true })
    .select("name email isInternal workspaceId workspaces avisoBakanologyEn")
    .lean();

  const destinatarios = (usuarios as any[])
    .map((u) => {
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
      return todos || !u.avisoBakanologyEn;
    }) as any[];

  console.log(`Entornos activos: ${activos.length}`);
  console.log(`Destinatarios: ${destinatarios.length}${solo ? ` (solo ${solo})` : ""}${todos ? " · reenvío a todos" : ""}`);
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
      await resendService.sendBakanologyIncluido({
        to: u.email,
        recipientName: u.name,
        workspaceName: u.entorno,
        academiaUrl: ACADEMIA_URL,
      });
      await models.users.updateOne({ _id: u._id }, { $set: { avisoBakanologyEn: new Date() } });
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
