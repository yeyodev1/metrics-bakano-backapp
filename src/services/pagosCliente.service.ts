import { CustomError } from "../errors/customError.error";
import * as billingPortalService from "./billingPortal.service";

/**
 * Lo que el cliente le debe a Bakano, visto desde el bot de Telegram.
 *
 * La facturación vive en finanzas; se consulta por el mismo proxy del portal
 * (billingPortal.service). El link de pago es un checkout de Stripe que cobra
 * solo lo que falta de la factura, y al terminar devuelve al cliente al bot.
 */

const BOT_URL = process.env.TELEGRAM_BOT_URL || "https://t.me/BakanoAgencyBot";
const ABIERTAS = ["pending", "partial", "overdue"];
// El menú consulta el saldo cada vez que se muestra: sin caché serían varias
// llamadas a finanzas por minuto con un cliente navegando.
const CACHE_MS = 2 * 60_000;

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];

export interface FacturaPendiente {
  id: string;
  periodo: string;
  texto: string;
  saldo: number;
  vencida: boolean;
  vence?: Date;
}

export interface EstadoPagos {
  /** false: el entorno no tiene facturación vinculada en finanzas (o finanzas no está configurado). */
  vinculado: boolean;
  saldo: number;
  facturas: FacturaPendiente[];
  vencidas: number;
  pagoConTarjeta: boolean;
}

const cache = new Map<string, { en: number; estado: EstadoPagos }>();

export function comoDolares(monto: number): string {
  return `$${monto.toFixed(2)}`;
}

function textoPeriodo(periodo: string, etiqueta?: string): string {
  const [anio, mes] = periodo.split("-").map(Number);
  const base = MESES[(mes ?? 0) - 1] ? `${MESES[mes! - 1]} ${anio}` : periodo;
  return etiqueta ? `${base} (${etiqueta})` : base;
}

class PagosClienteService {
  async estado(workspaceId: string, fresco = false): Promise<EstadoPagos> {
    const guardado = cache.get(workspaceId);
    if (!fresco && guardado && Date.now() - guardado.en < CACHE_MS) return guardado.estado;

    let data: any;
    try {
      data = await billingPortalService.getBilling(workspaceId);
    } catch (error) {
      // 404: sin facturación vinculada. 503: finanzas no configurado. Para el
      // cliente es lo mismo: no hay nada que mostrarle.
      const status = error instanceof CustomError ? error.status : 0;
      if (status !== 404 && status !== 503) console.error("[Pagos] saldo:", (error as Error)?.message || error);
      const vacio = { vinculado: false, saldo: 0, facturas: [], vencidas: 0, pagoConTarjeta: false };
      if (status === 404) cache.set(workspaceId, { en: Date.now(), estado: vacio });
      return vacio;
    }

    const facturas: FacturaPendiente[] = (data?.invoices ?? [])
      .filter((inv: any) => ABIERTAS.includes(inv.status))
      .map((inv: any) => ({
        id: String(inv._id ?? inv.id),
        periodo: String(inv.period),
        texto: textoPeriodo(String(inv.period), inv.splitLabel),
        saldo: Number(Math.max(Number(inv.amount) - Number(inv.paidAmount || 0), 0).toFixed(2)),
        vencida: inv.status === "overdue",
        vence: inv.dueDate ? new Date(inv.dueDate) : undefined,
      }))
      .filter((f: FacturaPendiente) => f.saldo > 0)
      // La más antigua primero: es la que se paga primero.
      .sort((a: FacturaPendiente, b: FacturaPendiente) => a.periodo.localeCompare(b.periodo));

    const estado: EstadoPagos = {
      vinculado: true,
      saldo: Number(facturas.reduce((acc, f) => acc + f.saldo, 0).toFixed(2)),
      facturas,
      vencidas: facturas.filter((f) => f.vencida).length,
      pagoConTarjeta: Boolean(data?.summary?.stripeEnabled),
    };
    cache.set(workspaceId, { en: Date.now(), estado });
    return estado;
  }

  /** Checkout de Stripe para una factura. Al pagar, Stripe devuelve al cliente al bot. */
  async link(workspaceId: string, invoiceId: string): Promise<string> {
    const returnUrl = `${BOT_URL}?start=pago`;
    const data: any = await billingPortalService.createCheckout(workspaceId, invoiceId, returnUrl);
    if (!data?.url) throw new CustomError("No se pudo generar el link de pago.", 502);
    // El saldo cambia apenas pague: que el próximo menú lo consulte de nuevo.
    cache.delete(workspaceId);
    return String(data.url);
  }

  /** Para la IA del bot: números ya redondeados y en palabras. */
  async paraLaIa(workspaceId: string) {
    const e = await this.estado(workspaceId, true);
    if (!e.vinculado) {
      return {
        vinculado: false,
        nota: "Su entorno no tiene facturación vinculada. Si pregunta por pagos, ofrécele pasarle el mensaje al equipo.",
      };
    }
    return {
      vinculado: true,
      alDia: e.saldo === 0,
      saldoPendiente: comoDolares(e.saldo),
      facturasVencidas: e.vencidas,
      puedePagarConTarjeta: e.pagoConTarjeta,
      facturas: e.facturas.map((f) => ({
        invoiceId: f.id,
        mes: f.texto,
        saldo: comoDolares(f.saldo),
        estado: f.vencida ? "vencida" : "pendiente",
      })),
      nota: "Para cobrar una factura usa generarLinkDePago con su invoiceId exacto.",
    };
  }
}

export const pagosClienteService = new PagosClienteService();
