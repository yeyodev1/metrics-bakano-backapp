import { z } from "zod";
import models from "../../models";
import { atencionClienteService, fechaEcuador, frecuenciaEnTexto } from "../../services/atencionCliente.service";
import { produccionAnticipadaService } from "../../services/produccionAnticipada.service";
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
      "Los 6 meses son el punto de partida, no un absoluto: contenido lo va ajustando cliente por cliente. " +
      "Aprobar sus guiones siempre le deja agendar al instante, y con pagos vencidos nunca puede. Confirma con la persona antes de cambiarlo.",
    perfiles: ["direccion", "pm", "contenido"],
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
        pidioGrabarAntes: estado.solicitudPendiente ?? false,
      };
    },
  },
  {
    nombre: "responder_produccion_antes",
    titulo: "Responder a un cliente que quiere grabar antes",
    descripcion:
      "Cuando un cliente pide grabar antes de lo que le toca por su frecuencia, el bot no le dice que no: te lo pasa y te lo recuerda cada día hasta que respondas. " +
      "Sin cliente: lista quién está esperando respuesta. Con cliente y 'aprobar': sí le abre 30 días para agendar ya; no, se le explica. El cliente se entera por Telegram al momento. " +
      "Confirma la decisión con la persona antes de mandarla.",
    perfiles: ["direccion", "pm", "contenido"],
    escribe: true,
    entrada: {
      cliente: z.string().optional(),
      aprobar: z.boolean().optional(),
      mensaje: z.string().max(500).optional().describe("Nota para el cliente, tal cual la leerá (opcional)"),
    },
    async correr(a, u) {
      if (!a.cliente) {
        const lista = await produccionAnticipadaService.pendientes();
        return lista.length
          ? lista.map((p) => ({ cliente: p.cliente, motivo: p.solicitud.motivo, pidioEl: fechaEcuador(new Date(p.solicitud.en)) }))
          : "Nadie está esperando respuesta para grabar antes.";
      }
      if (a.aprobar === undefined) throw new Error("Dime si se aprueba o no.");
      const ws = await resolverCliente(a.cliente);
      const r = await produccionAnticipadaService.responder(ws._id, a.aprobar, { nombre: u.nombre }, a.mensaje);
      if (!r.ok) throw new Error("No encontré ese cliente.");
      return a.aprobar
        ? `Listo: ${ws.name} puede agendar su producción ya (hasta el ${fechaEcuador(r.hasta!)}). Se lo avisé por Telegram.`
        : `Listo: le avisé a ${ws.name} por Telegram que por ahora no hace falta adelantar la producción.`;
    },
  },
];
