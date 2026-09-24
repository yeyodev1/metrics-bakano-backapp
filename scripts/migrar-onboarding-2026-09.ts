import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";

/**
 * Migra el onboarding al proceso del 24/09/2026.
 *
 *   npx tsx scripts/migrar-onboarding-2026-09.ts            → ensayo
 *   npx tsx scripts/migrar-onboarding-2026-09.ts --aplicar  → escribe
 *
 * Las sesiones viejas se conservan tal cual (no se borra nada): se COPIAN a
 * las nuevas para que nadie pierda su avance.
 *   meta       → especializacion   (es la misma reunión con Joel)
 *   estrategia → levantamiento     (es la misma reunión con Ariana)
 *   crm        → se queda como historial; ya no es un paso del proceso
 *
 * Y la bienvenida: a quien ya arrancó el onboarding no se le puede pedir que
 * agende una bienvenida que ya pasó, así que queda "no_aplica".
 */
async function main() {
  const aplicar = process.argv.includes("--aplicar");
  await mongoose.connect(process.env.DB_URI!);

  const entornos: any[] = await models.workspaces
    .find({ onboardingSesiones: { $exists: true, $ne: null } })
    .select("name onboardingSesiones")
    .lean();

  let tocados = 0;
  const resumen: string[] = [];
  for (const w of entornos) {
    const s = w.onboardingSesiones || {};
    const cambios: any = {};

    if (s.meta && !s.especializacion) cambios["onboardingSesiones.especializacion"] = s.meta;
    if (s.estrategia && !s.levantamiento) cambios["onboardingSesiones.levantamiento"] = s.estrategia;
    if (!s.bienvenida) {
      cambios["onboardingSesiones.bienvenida"] = {
        agendada: false,
        estado: "no_aplica",
        nota: "Arrancó con el proceso anterior, antes de que existiera la bienvenida.",
        actualizadoPorNombre: "Migración del proceso",
        actualizadoEn: new Date(),
      };
    }

    if (!Object.keys(cambios).length) continue;
    tocados++;
    resumen.push(`${w.name}: ${Object.keys(cambios).map((k) => k.split(".")[1]).join(", ")}`);
    if (aplicar) await models.workspaces.updateOne({ _id: w._id }, { $set: cambios });
  }

  console.log(`Entornos con onboarding: ${entornos.length}`);
  console.log(`${aplicar ? "Migrados" : "Se migrarían"}: ${tocados}`);
  resumen.slice(0, 12).forEach((r) => console.log(`  · ${r}`));
  if (resumen.length > 12) console.log(`  … y ${resumen.length - 12} más`);
  if (!aplicar) console.log("\nENSAYO — nada se escribió. Agrega --aplicar.");
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
