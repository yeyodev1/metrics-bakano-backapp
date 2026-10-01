import { z } from "zod";
import { TODOS } from "../perfiles";
import { resolverCliente, type ToolMcp } from "./base";
import { estadoMetricsService } from "../../services/estadoMetrics.service";
import { crmSubcuentaService } from "../../services/crmSubcuenta.service";

/**
 * Lo que hay en Metrics de un cliente, en vivo: la misma foto que usa el bot
 * de Telegram para no pedirle al cliente lo que ya hizo. Y el ID de su
 * subcuenta del CRM, con el que se reconoce al negocio.
 */
export const toolsEstadoMetrics: ToolMcp[] = [
  {
    nombre: "estado_en_metrics",
    titulo: "Qué hay en Metrics de un cliente",
    descripcion:
      "Foto en vivo de un cliente en metrics.bakano.ec: contrato (firmado y cuándo), logo, línea gráfica y catálogo subidos, datos de marca, facturación cargada, Meta y CRM conectados, sesiones del onboarding, citas futuras con su link de Meet, guiones y videos (aprobados o por revisar) y pagos. Trae `yaEsta` (lo hecho) y `falta` (lo pendiente de verdad). Es lo mismo que ve el bot de Telegram. Solo lectura.",
    perfiles: TODOS,
    entrada: { cliente: z.string().describe("Nombre o id del cliente") },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const e = await estadoMetricsService.de(ws._id);
      if (!e) throw new Error("No pude leer ese entorno.");
      return e;
    },
  },
  {
    nombre: "vincular_crm_subcuenta",
    titulo: "Vincular la subcuenta del CRM a un entorno",
    descripcion:
      "Guarda el ID de la subcuenta (location) de GoHighLevel del cliente en su entorno, para reconocer al negocio en el CRM. Si el servidor tiene el token de agencia, además conecta el CRM para que Metrics y Lucas lo lean. Una subcuenta no puede quedar en dos entornos. No avisa al cliente. Confirma el ID con la persona antes.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: {
      cliente: z.string().describe("Nombre o id del cliente"),
      locationId: z.string().describe("ID de la subcuenta de GoHighLevel (Location ID)"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const r = await crmSubcuentaService.vincular(String(ws._id), a.locationId, { _id: u._id, name: u.nombre, email: u.email });
      return { cliente: ws.name, ...r };
    },
  },
  {
    nombre: "ver_crm_subcuenta",
    titulo: "Subcuenta del CRM de un entorno",
    descripcion: "Qué subcuenta de GoHighLevel tiene vinculada un cliente, quién la vinculó y si Metrics ya puede leer ese CRM. También sirve al revés: pasa un locationId y te dice de qué cliente es. Solo lectura.",
    perfiles: TODOS,
    entrada: {
      cliente: z.string().optional().describe("Nombre o id del cliente"),
      locationId: z.string().optional().describe("Para buscar a qué cliente pertenece una subcuenta"),
    },
    async correr(a) {
      if (a.locationId) {
        const ws = await crmSubcuentaService.entornoDe(a.locationId);
        return ws ? { locationId: a.locationId, cliente: ws.name, id: String(ws._id) } : { locationId: a.locationId, cliente: null, nota: "Ningún entorno tiene esa subcuenta." };
      }
      if (!a.cliente) throw new Error("Dime el cliente o el locationId.");
      const ws = await resolverCliente(a.cliente);
      return { cliente: ws.name, ...(await crmSubcuentaService.ver(String(ws._id))) };
    },
  },
];
