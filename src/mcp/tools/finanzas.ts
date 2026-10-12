import axios from "axios";
import { z } from "zod";
import type { UsuarioMcp } from "../perfiles";
import type { ToolMcp } from "./base";

/**
 * Bakano Finanzas (finances.bakano.ec) dentro del MCP.
 *
 * Solo superadmin (pedido de Diego 2026-10-12): nadie más ve estas tools.
 * Leen y escriben todo. Finanzas además valida el usuario de Finanzas de la
 * persona por su correo, así cada pago queda con su nombre.
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
      "Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
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
    perfiles: ["direccion"],
    soloSuperadmin: true,
    entrada: { cliente: z.string() },
    correr: (a, u) => finanzas(u, "get", "cliente", { cliente: a.cliente }),
  },
  {
    nombre: "finanzas_resumen",
    titulo: "Resumen de cobranza del mes",
    descripcion:
      "Cobrado, por cobrar y esperado del mes en Finanzas, tasa de cobro, ideal mensual, meta de ventas y la lista de cobros vencidos. periodo = AAAA-MM (por defecto el mes actual).",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    entrada: { periodo: z.string().optional() },
    correr: (a, u) => finanzas(u, "get", "resumen", { periodo: a.periodo }),
  },
  {
    nombre: "finanzas_registrar_pago",
    titulo: "Registrar un pago en Finanzas",
    descripcion:
      "Registra un pago de un cliente en Finanzas, como 'Registrar pago' de la plataforma: se reparte entre sus cobros abiertos (el más viejo primero) y, si no tiene ninguno, crea el cobro del mes del pago. " +
      "Si con el pago queda al día, Finanzas reactiva su entorno y manda el correo de pago registrado. No registra dos veces la misma referencia (número de comprobante). " +
      "Sin confirmar=true solo muestra lo que va a hacer: enséñaselo a la persona y confirma antes. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
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
  {
    nombre: "finanzas_bloqueos",
    titulo: "Fechas de bloqueo de los que deben",
    descripcion:
      "Todos los clientes con cobros vencidos y CUÁNDO se les bloquea el entorno: fecha de bloqueo (vencimiento + días de gracia + 1), si ya está bloqueado, si tiene acceso abierto por excepción (hasta cuándo, por qué y quién lo dio) o si el bloqueo automático está apagado. Ordenado por el bloqueo más cercano. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    entrada: {},
    correr: (_a, u) => finanzas(u, "get", "bloqueos"),
  },
  {
    nombre: "finanzas_vincular_entorno",
    titulo: "Vincular un cliente de Finanzas con su entorno",
    descripcion:
      "Vincula un cliente de Finanzas con su entorno de Metrics (así el bloqueo por mora y el estado de pagos se aplican a ese entorno). Sin workspace_id devuelve a qué está vinculado y las 5 sugerencias más parecidas. desvincular=true lo suelta. Sin confirmar=true solo muestra lo que hará. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      cliente: z.string().describe("Nombre o id del cliente en Finanzas"),
      workspace_id: z.string().optional().describe("Id del entorno de Metrics (de buscar_clientes)"),
      desvincular: z.boolean().optional(),
      confirmar: z.boolean().optional(),
    },
    correr: (a, u) => finanzas(u, "post", "vincular", { cliente: a.cliente, workspaceId: a.workspace_id, desvincular: a.desvincular, confirmar: a.confirmar }),
  },
  {
    nombre: "finanzas_acceso",
    titulo: "Liberar o cerrar el acceso de un cliente que debe",
    descripcion:
      "accion=abrir: le abre el entorno a un cliente en mora por excepción, con el MOTIVO (obligatorio, queda registrado y se avisa) y hasta qué fecha (hasta=AAAA-MM-DD; sin fecha no se vuelve a bloquear solo). Al vencer, el cron lo bloquea si sigue debiendo. " +
      "accion=cerrar: quita la excepción y lo vuelve a bloquear si sigue debiendo. Sin confirmar=true solo muestra lo que hará. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      cliente: z.string(),
      accion: z.enum(["abrir", "cerrar"]),
      motivo: z.string().optional().describe("Por qué (obligatorio para abrir)"),
      hasta: z.string().optional().describe("AAAA-MM-DD: hasta cuándo queda abierto"),
      confirmar: z.boolean().optional(),
    },
    correr: (a, u) => finanzas(u, "post", "acceso", a),
  },
  {
    nombre: "finanzas_plazo",
    titulo: "Dar plazo de pago (nueva fecha de bloqueo)",
    descripcion:
      "Acuerdo de pago: mueve el vencimiento de un cobro (el más viejo abierto si no das cobro_id, de finanzas_bloqueos o finanzas_cliente) a nueva_fecha, con su MOTIVO. La fecha de bloqueo pasa a nueva_fecha + días de gracia. " +
      "Si el cliente ya estaba bloqueado, se le abre el acceso hasta esa nueva fecha de bloqueo (reabrir=false para no abrirlo). Finanzas le manda al cliente el correo del acuerdo. Sin confirmar=true solo muestra lo que hará. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      cliente: z.string(),
      nueva_fecha: z.string().describe("AAAA-MM-DD: nuevo vencimiento"),
      motivo: z.string(),
      cobro_id: z.string().optional(),
      reabrir: z.boolean().optional(),
      confirmar: z.boolean().optional(),
    },
    correr: (a, u) => finanzas(u, "post", "plazo", a),
  },
];
