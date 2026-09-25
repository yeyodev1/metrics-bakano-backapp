import "dotenv/config";
import fs from "fs";
import mongoose from "mongoose";
import models from "../src/models";

/**
 * Saca el CSV de clientes para darles acceso a Bakanology.
 *
 *   npx tsx scripts/csv-clientes-bakanology.ts [salida.csv]
 *
 * Todos los usuarios activos de entornos ACTIVOS, sin el equipo de Bakano y
 * sin contactos bloqueados. El CSV lo consume grant-client-access.ts de la
 * academia, que crea o extiende el acceso y manda el correo por lotes.
 */
const BLOQUEADOS = ["lreyes@bakano.ec"];

async function main() {
  const salida = process.argv[2] || "clientes-bakanology.csv";
  await mongoose.connect(process.env.DB_URI!);

  const activos = await models.workspaces.find({ isActive: true }).select("_id name").lean();
  const ids = new Set(activos.map((w) => String(w._id)));

  const usuarios = await models.users.find({ isActive: true }).select("name email isInternal workspaceId workspaces").lean();

  const filas = (usuarios as any[])
    .filter((u) => {
      const correo = String(u.email || "").toLowerCase();
      if (!correo || BLOQUEADOS.includes(correo)) return false;
      if (u.isInternal || correo.endsWith("@bakano.ec")) return false;
      const propios = [u.workspaceId, ...(u.workspaces || []).map((w: any) => w.workspaceId?._id ?? w.workspaceId)]
        .filter(Boolean)
        .map(String);
      return propios.some((id) => ids.has(id));
    })
    .map((u) => {
      const partes = String(u.name || "").trim().split(/\s+/);
      const nombre = (partes[0] || "").replace(/,/g, " ");
      const apellido = partes.slice(1).join(" ").replace(/,/g, " ");
      return `${String(u.email).toLowerCase()},${nombre},${apellido}`;
    });

  const unicas = [...new Set(filas)];
  fs.writeFileSync(salida, ["email,name,lastName", ...unicas].join("\n") + "\n");

  console.log(`Entornos activos: ${activos.length}`);
  console.log(`Clientes en el CSV: ${unicas.length}`);
  console.log(`Archivo: ${salida}`);
  await mongoose.disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
