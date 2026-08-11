/**
 * backfill-script-meta.ts
 *
 * Clasifica con IA la estructura (objetivo, gancho, formato, elementos) de los
 * guiones ya existentes, para que el motor de Pareto tenga dimensiones sobre
 * las cuales agrupar el rendimiento.
 *
 * Uso:
 *   npx ts-node scripts/backfill-script-meta.ts              # todos los workspaces
 *   npx ts-node scripts/backfill-script-meta.ts <workspaceId>
 *   npx ts-node scripts/backfill-script-meta.ts <workspaceId> --force
 *
 * `--force` re-clasifica también lo que ya estaba clasificado (incluido lo
 * marcado como "humano"). Sin el flag, esos ítems se respetan.
 */

import "dotenv/config";
import mongoose, { Types } from "mongoose";
import { VideoPlanningModel } from "../src/models/videoPlanning.model";
import { scriptClassifierService } from "../src/services/scriptClassifier.service";

// Pausa entre llamadas para no golpear el rate limit de Gemini
const DELAY_MS = 600;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const workspaceId = args.find((a) => !a.startsWith("--"));

  if (workspaceId && !Types.ObjectId.isValid(workspaceId)) {
    console.error(`workspaceId inválido: ${workspaceId}`);
    process.exit(1);
  }

  const dbUri = process.env.DB_URI;
  if (!dbUri) {
    console.error("Falta DB_URI en el entorno.");
    process.exit(1);
  }

  await mongoose.connect(dbUri);
  console.log("Conectado a MongoDB.");

  const query = workspaceId ? { workspaceId: new Types.ObjectId(workspaceId) } : {};
  const plannings = await VideoPlanningModel.find(query);

  let classified = 0;
  let skipped = 0;
  let failed = 0;

  for (const planning of plannings) {
    let dirty = false;

    for (const item of planning.items) {
      const alreadyDone = !!item.scriptMeta?.clasificadoPor;
      const isHuman = item.scriptMeta?.clasificadoPor === "humano";

      if (alreadyDone && !force) {
        skipped++;
        continue;
      }
      if (isHuman && !force) {
        skipped++;
        continue;
      }

      try {
        const scriptMeta = await scriptClassifierService.classify(item);
        if (!scriptMeta) {
          skipped++;
          continue;
        }
        item.scriptMeta = scriptMeta;
        dirty = true;
        classified++;
        console.log(
          `✓ ${planning._id}/${item._id} — ${scriptMeta.objetivo}/${scriptMeta.hookType}`
        );
      } catch (err: any) {
        failed++;
        console.warn(`✗ ${planning._id}/${item._id}: ${err.message}`);
      }

      await sleep(DELAY_MS);
    }

    if (dirty) await planning.save();
  }

  console.log(
    `\nListo — clasificados: ${classified}, omitidos: ${skipped}, fallidos: ${failed}`
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
