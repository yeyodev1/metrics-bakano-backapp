import { z } from "zod";
import axios from "axios";
import { fecha, resolverCliente, type ToolMcp } from "./base";

/**
 * Lucas vive en su propio backend y su propia base. Se le pide un resumen por
 * entorno con la misma llave que Lucas usa para escribirle a Metrics.
 */
const LUCAS_API = (process.env.LUCAS_API_URL || "https://lucas-by-bakano-backapp.vercel.app/api").replace(/\/$/, "");

export const toolsLucas: ToolMcp[] = [
  {
    nombre: "lucas_cliente",
    titulo: "Cómo le va al cliente con Lucas",
    descripcion:
      "Si el cliente ya usa a Lucas (el agente de ventas por WhatsApp) y cómo le va: quién de su negocio lo usa, cuántas conversaciones le pasó y cuándo fue la última, si eligió las respuestas que Lucas sugirió, sus leads por etapa con temperatura, lo que falta para cerrar y el siguiente paso recomendado, y las alertas de Lucas. Por defecto, los últimos 30 días. Solo lectura.",
    perfiles: ["direccion", "pm", "campanas", "contenido"],
    entrada: {
      cliente: z.string().describe("Nombre o id del cliente"),
      dias: z.number().int().min(1).max(90).optional(),
    },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const llave = process.env.METRICS_PROXY_KEY;
      if (!llave) throw new Error("Falta METRICS_PROXY_KEY en el servidor: no puedo hablar con Lucas.");
      let r: any;
      try {
        const res = await axios.get(`${LUCAS_API}/metrics/entornos/${ws._id}/resumen`, {
          headers: { "x-metrics-key": llave },
          params: { dias: a.dias ?? 30 },
          timeout: 20_000,
        });
        r = res.data;
      } catch (error: any) {
        const estado = error?.response?.status;
        throw new Error(estado === 401 ? "Lucas rechazó la llave compartida." : `Lucas no respondió (${estado || error?.message}).`);
      }
      if (!r?.usaLucas) return { cliente: ws.name, usaLucas: false, nota: "Este cliente todavía no tiene su negocio en Lucas (nunca entró a @LucasByBakanoBot)." };
      const f = (d: any) => fecha(d) ?? undefined;
      return {
        cliente: ws.name,
        usaLucas: true,
        periodo: `últimos ${r.dias} días`,
        negocios: r.negocios.map((n: any) => ({ ...n, desde: f(n.desde) })),
        quienesLoUsan: r.quienesLoUsan.map((o: any) => ({ ...o, desde: f(o.desde) })),
        uso: { ...r.uso, ultimaVez: f(r.uso.ultimaVez) ?? "nunca" },
        leads: { ...r.leads, recientes: r.leads.recientes.map((c: any) => ({ ...c, ultimoContacto: f(c.ultimoContacto) })) },
        alertas: r.alertas.map((x: any) => ({ ...x, en: f(x.en) })),
      };
    },
  },
];
