import axios from "axios";
import { z } from "zod";
import { TODOS } from "../perfiles";
import type { UsuarioMcp } from "../perfiles";
import type { ToolMcp } from "./base";

/**
 * Bakano Finanzas (finances.bakano.ec) dentro del MCP.
 *
 * El permiso NO lo decide el perfil del MCP sino el usuario de Finanzas de la
 * persona (por su correo): sin cuenta activa no ve nada, `viewer` solo
 * consulta y registrar pagos es de superadmin, admin y vendedor. Por eso las
 * tools aparecen para todos: Finanzas responde quién puede.
 */

const METODOS = ["transferencia", "stripe", "cheque", "transferencia_o_cheque", "efectivo", "no_paga", "otro"] as const;

async function finanzas(u: UsuarioMcp, metodo: "get" | "post", ruta: string, datos?: Record<string, unknown>) {
  const base = process.env.FINANCES_API_URL;
  const llave = process.env.METRICS_PROXY_KEY;
  if (!base || !llave) throw new Error("Finanzas no está conectado en este servidor (FINANCES_API_URL / METRICS_PROXY_KEY).");
  try {
    const { data } = await axios.request({
      method: metodo,
      url: `${base.replace(/\/+$/, "")}/portal/mcp/${ruta}`,
      ...(metodo === "get" ? { params: datos } : { data: datos }),
      timeout: 20000,
      headers: { "x-finance-source": "metrics-mcp", "x-metrics-key": llave, "x-actor-email": u.email },
    });
    return data;
  } catch (e: any) {
    throw new Error(e.response?.data?.message || "No pude hablar con Bakano Finanzas. Inténtalo en un momento.");
  }
}

export const toolsFinanzas: ToolMcp[] = [
  {
    nombre: "finanzas_clientes",
    titulo: "Clientes en Finanzas",
    descripcion:
      "Clientes de Bakano Finanzas (finances.bakano.ec): mensualidad, método, día de cobro, responsable de cobro y cuánto tienen vencido. Filtra por nombre o solo los que deben. " +
      "Solo responde si la persona tiene usuario activo en Finanzas.",
    perfiles: TODOS,
    entrada: {
      texto: z.string().optional().describe("Parte del nombre"),
      solo_deben: z.boolean().optional(),
    },
    correr: (a, u) => finanzas(u, "get", "clientes", { q: a.texto, soloDeben: a.solo_deben ? "true" : undefined }),
  },
  {
    nombre: "finanzas_cliente",
    titulo: "Ficha financiera de un cliente",
    descripcion:
      "La ficha de un cliente en Finanzas: total cobrado histórico, lo vencido, sus últimos cobros (período, monto, pagado, estado), sus últimos pagos (fecha, método, referencia, quién lo registró) y sus ventas con cuotas. Acepta nombre, id de Finanzas o id del entorno de Metrics.",
    perfiles: TODOS,
    entrada: { cliente: z.string() },
    correr: (a, u) => finanzas(u, "get", "cliente", { cliente: a.cliente }),
  },
  {
    nombre: "finanzas_resumen",
    titulo: "Resumen de cobranza del mes",
    descripcion:
      "Cobrado, por cobrar y esperado del mes en Finanzas, tasa de cobro, ideal mensual, meta de ventas y la lista de cobros vencidos. periodo = AAAA-MM (por defecto el mes actual).",
    perfiles: TODOS,
    entrada: { periodo: z.string().optional() },
    correr: (a, u) => finanzas(u, "get", "resumen", { periodo: a.periodo }),
  },
  {
    nombre: "finanzas_registrar_pago",
    titulo: "Registrar un pago en Finanzas",
    descripcion:
      "Registra un pago de un cliente en Finanzas, como 'Registrar pago' de la plataforma: se reparte entre sus cobros abiertos (el más viejo primero) y, si no tiene ninguno, crea el cobro del mes del pago. " +
      "Si con el pago queda al día, Finanzas reactiva su entorno y manda el correo de pago registrado. No registra dos veces la misma referencia (número de comprobante). " +
      "Sin confirmar=true solo muestra lo que va a hacer: enséñaselo a la persona y confirma antes. Necesita usuario de Finanzas superadmin, admin o vendedor.",
    perfiles: TODOS,
    escribe: true,
    entrada: {
      cliente: z.string(),
      monto: z.number().positive(),
      fecha: z.string().optional().describe("Fecha del pago AAAA-MM-DD (hora Ecuador). Por defecto hoy"),
      metodo: z.enum(METODOS).optional(),
      referencia: z.string().optional().describe("Número de comprobante o transacción"),
      notas: z.string().optional().describe("Ej: quién transfirió, banco"),
      confirmar: z.boolean().optional(),
    },
    correr: (a, u) => finanzas(u, "post", "pagos", a),
  },
];
