import { z } from "zod";
import models from "../../models";
import { atencionClienteService, fechaEcuador, frecuenciaEnTexto } from "../../services/atencionCliente.service";
import { resolverCliente, type ToolMcp } from "./base";

/**
 * Cada cliente graba a su ritmo: hay quien necesita una producción al mes y
 * quien con una cada seis meses tiene de sobra. Esto lo ajusta el equipo, y el
 * bot lo respeta cuando el cliente agenda solo.
 */
export const toolsProduccionCliente: ToolMcp[] = [
  {
    nombre: "frecuencia_produccion",
    titulo: "Cada cuánto graba un cliente",
    descripcion:
      "Cambia cada cuántos meses puede agendar su producción un cliente (1 = una al mes). Sin 'meses' solo muestra cómo está y desde cuándo puede agendar. " +
      "Aprobar sus guiones siempre le deja agendar al instante, y con pagos vencidos nunca puede. Confirma con la persona antes de cambiarlo.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: {
      cliente: z.string(),
      meses: z.number().int().min(1).max(12).optional().describe("Cada cuántos meses; vacío para solo consultar"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      if (a.meses) {
        await models.workspaces.updateOne(
          { _id: ws._id },
          { $set: { "produccion.mesesEntre": a.meses, "produccion.mesesEntrePorNombre": u.nombre } }
        );
      }
      const estado = await atencionClienteService.estadoProduccion(ws._id);
      return {
        cliente: ws.name,
        frecuencia: frecuenciaEnTexto(estado.mesesEntre ?? 6),
        ...(a.meses ? { cambiado: true } : {}),
        puedeAgendar: estado.puedeAgendar,
        motivo:
          estado.bloqueo === "pago_pendiente"
            ? `Tiene pagos vencidos (${estado.deudaTexto}).`
            : estado.bloqueo === "ya_agendada"
              ? `Ya tiene una agendada el ${fechaEcuador(estado.proxima!)}.`
              : estado.bloqueo === "falta_ariana"
                ? "Le falta la reunión con Ariana."
                : undefined,
        desde: estado.habilitadaDesde ? fechaEcuador(estado.habilitadaDesde) : null,
        porGuionesAprobados: estado.porGuionesAprobados ?? false,
      };
    },
  },
];
