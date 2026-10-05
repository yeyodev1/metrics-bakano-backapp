import { z } from "zod";
import { publicidadClienteService } from "../../services/publicidadCliente.service";
import { resolverCliente, type ToolMcp } from "./base";

/** Hoy y hace N dias en hora de Ecuador, como AAAA-MM-DD. */
function diaEc(diasAtras = 0): string {
  return new Date(Date.now() - 5 * 3_600_000 - diasAtras * 86_400_000).toISOString().slice(0, 10);
}

export const toolsPauta: ToolMcp[] = [
  {
    nombre: "pauta_cliente",
    titulo: "Pauta de Meta de un cliente",
    descripcion:
      "Lo mismo que ve el bot cuando el cliente pregunta por su pauta: qué está corriendo (gasto de los últimos 7 días), lo encendido sin gasto, y los resultados de un periodo (gasto, alcance, clics, conversaciones/leads/compras y costo por resultado, por campaña y día a día). Sin fechas: últimos 7 días. Solo lectura.",
    perfiles: ["direccion", "pm", "campanas"],
    entrada: {
      cliente: z.string(),
      desde: z.string().optional().describe("AAAA-MM-DD (hora Ecuador)"),
      hasta: z.string().optional().describe("AAAA-MM-DD (hora Ecuador)"),
    },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const [ahora, periodo] = await Promise.all([
        publicidadClienteService.paraElCliente(ws._id),
        publicidadClienteService.resultadosEnRango(ws._id, a.desde || diaEc(6), a.hasta || diaEc(0)),
      ]);
      return { cliente: ws.name, ahora, periodo };
    },
  },
];
