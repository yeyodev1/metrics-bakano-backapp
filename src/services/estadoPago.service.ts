import axios from "axios";
import { Types } from "mongoose";
import models from "../models";
import { comoDolares, pagosClienteService } from "./pagosCliente.service";

/**
 * Quien esta al dia con Bakano, leido de Bakano Finanzas.
 *
 * Sirve para dos cosas: que el cliente que debe no vea ni apruebe sus guiones
 * hasta pagar, y que el equipo sepa a quien planificarle sin tener que ir a
 * preguntar quien pago.
 *
 * Solo bloquea una factura abierta cuya fecha de pago ya paso. La del mes que
 * todavia no vence no bloquea. Si Finanzas no responde o el espacio no tiene
 * facturacion vinculada, NO se bloquea: un fallo nuestro no puede dejar al
 * cliente sin sus guiones.
 */

export interface BloqueoPago {
  deuda: number;
  deudaTexto: string;
  facturasVencidas: number;
  /** Id de la factura mas antigua vencida, para armar el link de pago. */
  facturaId?: string;
  mensaje: string;
}

export interface EstadoPagoFila {
  workspaceId: string;
  cliente: string;
  alDia: boolean;
  deuda: number;
  facturasVencidas: number;
  pagadoMesActual?: boolean;
  ultimoPago?: string | null;
  excepcion?: string | null;
  vinculado: boolean;
}

const VIGENCIA_MS = 5 * 60 * 1000;
let cacheTodos: { en: number; filas: EstadoPagoFila[] } | null = null;

export const MENSAJE_BLOQUEO =
  "Tus guiones ya están listos, pero para verlos y aprobarlos primero hay que ponerse al día con el pago.";

class EstadoPagoService {
  /** Excepcion puesta por el equipo en Metrics: ve sus guiones aunque deba. */
  private async excepcion(workspaceId: string): Promise<string | null> {
    const ws = await models.workspaces.findById(workspaceId).select("guionesSinPago").lean();
    const ex = (ws as any)?.guionesSinPago;
    if (ex?.hasta && new Date(ex.hasta) > new Date()) return ex.motivo || "Excepción del equipo";
    return null;
  }

  /** null = puede ver y aprobar sus guiones. */
  async bloqueo(workspaceId: string, fresco = false): Promise<BloqueoPago | null> {
    const estado = await pagosClienteService.estado(String(workspaceId), fresco);
    if (!estado.vinculado) return null;
    const ahora = Date.now();
    const vencidas = estado.facturas.filter((f) => f.vencida || (f.vence && f.vence.getTime() <= ahora));
    if (!vencidas.length) return null;
    if (await this.excepcion(String(workspaceId))) return null;
    const deuda = Number(vencidas.reduce((acc, f) => acc + f.saldo, 0).toFixed(2));
    return {
      deuda,
      deudaTexto: comoDolares(deuda),
      facturasVencidas: vencidas.length,
      facturaId: vencidas[0]?.id,
      mensaje: MENSAJE_BLOQUEO,
    };
  }

  /**
   * Todos los espacios activos, para el equipo. Usa el resumen de Finanzas de
   * una sola llamada; si Finanzas todavia no lo tiene, consulta uno por uno.
   */
  async todos(): Promise<EstadoPagoFila[]> {
    if (cacheTodos && Date.now() - cacheTodos.en < VIGENCIA_MS) return cacheTodos.filas;

    const activos = await models.workspaces
      .find({ isActive: true })
      .select("name guionesSinPago")
      .lean();
    const ahora = new Date();
    const excepcionDe = (w: any) =>
      w.guionesSinPago?.hasta && new Date(w.guionesSinPago.hasta) > ahora ? w.guionesSinPago.motivo || "Excepción del equipo" : null;

    const resumen = await this.resumenFinanzas();
    let filas: EstadoPagoFila[];
    if (resumen) {
      filas = activos.map((w: any) => {
        const r = resumen.get(String(w._id));
        const excepcion = excepcionDe(w) || r?.excepcion || null;
        return {
          workspaceId: String(w._id),
          cliente: w.name,
          vinculado: Boolean(r),
          alDia: !r || Boolean(excepcion) || r.alDia,
          deuda: r?.deuda ?? 0,
          facturasVencidas: r?.facturasVencidas ?? 0,
          pagadoMesActual: r?.pagadoMesActual,
          ultimoPago: r?.ultimoPago ?? null,
          excepcion,
        };
      });
    } else {
      filas = [];
      // De a pocos: son decenas de espacios y cada uno es una consulta a Finanzas.
      for (let i = 0; i < activos.length; i += 8) {
        const lote = activos.slice(i, i + 8);
        filas.push(
          ...(await Promise.all(
            lote.map(async (w: any) => {
              const e = await pagosClienteService.estado(String(w._id));
              const vencidas = e.facturas.filter((f) => f.vencida || (f.vence && f.vence <= ahora));
              const excepcion = excepcionDe(w);
              return {
                workspaceId: String(w._id),
                cliente: w.name,
                vinculado: e.vinculado,
                alDia: !e.vinculado || Boolean(excepcion) || vencidas.length === 0,
                deuda: Number(vencidas.reduce((acc, f) => acc + f.saldo, 0).toFixed(2)),
                facturasVencidas: vencidas.length,
                excepcion,
              };
            })
          ))
        );
      }
    }
    cacheTodos = { en: Date.now(), filas };
    return filas;
  }

  private async resumenFinanzas(): Promise<Map<string, any> | null> {
    if (!process.env.FINANCES_API_URL || !process.env.METRICS_PROXY_KEY) return null;
    try {
      const { data } = await axios.get<{ estados: any[] }>(
        `${(process.env.FINANCES_API_URL as string).replace(/\/+$/, "")}/portal/estado-pagos`,
        { timeout: 10000, headers: { "x-finance-source": "metrics", "x-metrics-key": process.env.METRICS_PROXY_KEY } }
      );
      return new Map(data.estados.map((e) => [String(e.workspaceId), e]));
    } catch (error: any) {
      // 404 mientras Finanzas no tenga el resumen desplegado: se cae al uno por uno.
      if (error?.response?.status !== 404) console.error("[EstadoPago] resumen de Finanzas:", error?.message || error);
      return null;
    }
  }

  /** El equipo deja ver los guiones aunque deba (un acuerdo de pago, un error de registro). */
  async ponerExcepcion(workspaceId: string, dias: number, motivo: string, porNombre: string): Promise<Date> {
    const hasta = new Date(Date.now() + Math.max(1, Math.min(dias, 60)) * 86_400_000);
    await models.workspaces.updateOne(
      { _id: new Types.ObjectId(workspaceId) },
      { $set: { guionesSinPago: { hasta, motivo: motivo.trim().slice(0, 300), porNombre, en: new Date() } } }
    );
    cacheTodos = null;
    return hasta;
  }
}

export const estadoPagoService = new EstadoPagoService();
