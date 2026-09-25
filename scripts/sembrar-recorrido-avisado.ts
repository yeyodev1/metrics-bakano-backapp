import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";
import { recorridoClienteService } from "../src/services/recorridoCliente.service";

/**
 * Marca como "ya avisado" todo lo que hoy esta cerrado, SIN mandar nada.
 *
 *   npx tsx scripts/sembrar-recorrido-avisado.ts            → ensayo
 *   npx tsx scripts/sembrar-recorrido-avisado.ts --aplicar  → escribe
 *
 * Sin esto, la primera corrida del cron le mandaria al cliente una felicitacion
 * por cada paso que cerro en las ultimas semanas, todas juntas. Se felicita de
 * aqui en adelante, no hacia atras.
 */
async function main() {
  const aplicar = process.argv.includes("--aplicar");
  await mongoose.connect(process.env.DB_URI!);

  const activos = await models.workspaces.find({ isActive: true }).select("name recorrido").lean();
  let entornos = 0;
  let pasos = 0;

  for (const w of activos as any[]) {
    const { etapas } = await recorridoClienteService.de(w._id).catch(() => ({ etapas: [] as any[] }));
    const marcas = (w.recorrido || {}) as Record<string, any>;
    const cerradas = etapas.filter((e: any) => e.estado === "listo" && marcas[e.etapa]?.avisadoComo !== "listo");
    if (!cerradas.length) continue;

    entornos++;
    pasos += cerradas.length;
    if (aplicar) {
      const cambios: Record<string, string> = {};
      for (const e of cerradas) cambios[`recorrido.${e.etapa}.avisadoComo`] = "listo";
      await models.workspaces.updateOne({ _id: w._id }, { $set: cambios });
    }
  }

  console.log(`Entornos activos: ${activos.length}`);
  console.log(`${aplicar ? "Sembrados" : "Se sembrarían"}: ${pasos} pasos en ${entornos} entornos`);
  if (!aplicar) console.log("\nENSAYO — nada se escribió. Agrega --aplicar.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
