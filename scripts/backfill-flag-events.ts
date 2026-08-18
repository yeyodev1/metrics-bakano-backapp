import "dotenv/config";
import mongoose from "mongoose";
import models from "../src/models";
import { inferMotivoCategoria } from "../src/models/reviewEvent.model";

/**
 * Backfill del Sistema de Banderas.
 *
 * Los ReviewEvent solo existen desde que se desplego la captura de
 * transiciones; sin este script los dashboards de Genesis arrancarian vacios.
 * Sintetiza un evento por cada estado decidido ya presente en los items
 * (estadoIdea, edicion, clienteAprobacion). Es re-ejecutable: borra los
 * eventos `backfilled: true` antes de volver a crearlos, y nunca toca los
 * eventos reales capturados en vivo.
 *
 * Limitaciones conocidas (documentadas para no sobre-leer las metricas):
 * - Solo ve el estado FINAL: un guion rechazado y luego aprobado aparece
 *   una vez como aprobado.
 * - Sin responsable: los items viejos no tienen guionPor/editorPor.
 * - La fecha del evento es updatedAt del planning (no hay nada mejor).
 *
 * Uso: npx ts-node-dev --transpile-only scripts/backfill-flag-events.ts
 */

const DB_URI = process.env.DB_URI!;

async function run() {
  await mongoose.connect(DB_URI);
  console.log("Connected:", mongoose.connection.host);

  const removed = await models.reviewEvents.deleteMany({ backfilled: true });
  console.log(`Eventos backfilled previos eliminados: ${removed.deletedCount}`);

  const plannings = await models.videoPlanning.find({}).lean();
  console.log(`Plannings: ${plannings.length}`);

  const events: Record<string, unknown>[] = [];

  for (const planning of plannings) {
    const fecha = planning.updatedAt || planning.createdAt || new Date();
    for (const item of planning.items || []) {
      const base = {
        workspaceId: planning.workspaceId,
        planningId: planning._id,
        videoItemId: item._id,
        videoTema: item.tema,
        responsableId: item.guionPorId ?? undefined,
        responsableNombre: item.guionPorNombre ?? undefined,
        backfilled: true,
        createdAt: fecha,
        updatedAt: fecha,
      };

      // Contenido: el veredicto del cliente pesa mas que el interno — si el
      // cliente ya decidio, ese es el evento; si no, vale la revision interna.
      if (item.clienteAprobacion === "APROBADO" || item.clienteAprobacion === "RECHAZADO") {
        const rechazado = item.clienteAprobacion === "RECHAZADO";
        events.push({
          ...base,
          etapa: "contenido",
          resultado: rechazado ? "rechazado" : "aprobado",
          fuente: "cliente",
          motivo: rechazado ? item.motivoRechazo : undefined,
          motivoCategoria: rechazado ? inferMotivoCategoria(item.motivoRechazo) : undefined,
        });
      } else if (item.estadoIdea === "APROBADO" || item.estadoIdea === "RECHAZADO") {
        const rechazado = item.estadoIdea === "RECHAZADO";
        events.push({
          ...base,
          etapa: "contenido",
          resultado: rechazado ? "rechazado" : "aprobado",
          fuente: "interno",
          motivo: rechazado ? item.motivoRechazo : undefined,
          motivoCategoria: rechazado ? inferMotivoCategoria(item.motivoRechazo) : undefined,
        });
      }

      if (item.edicion === "EDITADO" || item.edicion === "RECHAZADO") {
        const rechazado = item.edicion === "RECHAZADO";
        events.push({
          ...base,
          responsableId: item.editorPorId ?? undefined,
          responsableNombre: item.editorPorNombre ?? undefined,
          etapa: "edicion",
          resultado: rechazado ? "rechazado" : "aprobado",
          fuente: "interno",
          motivo: rechazado ? item.motivoRechazo : undefined,
          motivoCategoria: rechazado ? inferMotivoCategoria(item.motivoRechazo) : undefined,
        });
      }
    }
  }

  if (events.length) {
    // timestamps:false en insertMany no existe: mongoose respeta createdAt
    // provisto solo si se inserta crudo. Usamos la coleccion directa.
    await models.reviewEvents.collection.insertMany(events as any[]);
  }
  console.log(`Eventos sintetizados: ${events.length}`);

  await mongoose.disconnect();
  console.log("Listo.");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
