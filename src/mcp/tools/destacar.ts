import { z } from "zod";
import { destacarClienteService } from "../../services/destacarCliente.service";
import { fecha, resolverCliente, type ToolMcp } from "./base";

/** Lo que cada cliente quiere destacar, para planificar sin tener que preguntarle. */
export const toolsDestacar: ToolMcp[] = [
  {
    nombre: "que_destacar",
    titulo: "Qué quiere destacar el cliente",
    descripcion:
      "Productos, servicios o promociones que el cliente quiere destacar en sus próximos videos. Se lo pregunta el bot cada 3 semanas y el cliente lo cuenta cuando quiere. " +
      "Sin cliente: todos los que contaron algo en los últimos 45 días. Con cliente: lo actual y su historial. " +
      "Con 'registrar' guardas lo que el cliente te dijo por otro lado (llamada, reunión) y avisa a contenido.",
    perfiles: ["direccion", "pm", "contenido"],
    entrada: {
      cliente: z.string().optional(),
      registrar: z.string().optional().describe("Lo que el cliente quiere destacar, si te lo dijo a ti"),
    },
    async correr(a, u) {
      if (!a.cliente) {
        if (a.registrar) throw new Error("Dime de qué cliente es.");
        const lista = await destacarClienteService.recientes();
        return {
          total: lista.length,
          clientes: lista.map((x) => ({
            cliente: x.cliente,
            destacar: x.destacado.texto,
            cuando: fecha(x.destacado.en),
            contó: x.destacado.fuente === "cliente" ? "el cliente, por el bot" : x.destacado.porNombre,
          })),
        };
      }
      const ws = await resolverCliente(a.cliente);
      if (a.registrar) {
        const r = await destacarClienteService.guardar(ws._id, a.registrar, { nombre: u.nombre, fuente: "equipo" });
        if (!r.ok) throw new Error("No se pudo guardar.");
      }
      const d = await destacarClienteService.de(ws._id);
      return {
        cliente: ws.name,
        ...(a.registrar ? { registrado: true } : {}),
        actual: d.actual
          ? { destacar: d.actual.texto, cuando: fecha(d.actual.en), contó: d.actual.fuente === "cliente" ? "el cliente, por el bot" : d.actual.porNombre }
          : "Todavía no ha contado qué quiere destacar.",
        historial: d.historial.slice(1, 6).map((h) => ({ destacar: h.texto, cuando: fecha(h.en) })),
        ultimaVezQueSeLePregunto: d.preguntadoEn ? fecha(d.preguntadoEn) : null,
      };
    },
  },
];
