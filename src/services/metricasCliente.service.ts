import { Types } from "mongoose";
import models from "../models";
import { scriptPerformanceService } from "./scriptPerformance.service";

/**
 * Metricas que el cliente puede ver por el bot: facturacion, gasto en Meta y
 * ROAS del mes, comparados con el mes anterior, y sus videos con mas vistas.
 *
 * Solo lectura de Mongo (rapido y seguro). No usa el Pulso Interno (la meta
 * mensual es del equipo) ni billingService.getMonthEntries (escribe y llama
 * a Meta). El gasto de Meta se cuenta UNA vez por dia: cada registro del dia
 * repite el mismo `metaSpend`, y sumarlos inflaba el gasto y bajaba el ROAS.
 * Las fechas se guardan a las 05:00 UTC (medianoche de Ecuador).
 */

const MS_DIA = 86_400_000;

function rangoMes(offsetMeses: number): { desde: Date; hasta: Date; clave: string; diasTranscurridos: number } {
  const ec = new Date(Date.now() - 5 * 3_600_000);
  const y = ec.getUTCFullYear();
  const m = ec.getUTCMonth() + offsetMeses;
  const desde = new Date(Date.UTC(y, m, 1, 5, 0, 0));
  const hasta = new Date(Date.UTC(y, m + 1, 1, 5, 0, 0));
  const inicioMes = new Date(Date.UTC(y, m, 1));
  const clave = `${inicioMes.getUTCFullYear()}-${String(inicioMes.getUTCMonth() + 1).padStart(2, "0")}`;
  // El dia en curso no cuenta: la facturacion se registra al cierre.
  const diasTranscurridos =
    offsetMeses === 0 ? ec.getUTCDate() - 1 : Math.round((hasta.getTime() - desde.getTime()) / MS_DIA);
  return { desde, hasta, clave, diasTranscurridos };
}

function redondear(n: number): number {
  return Math.round(n * 100) / 100;
}

class MetricasClienteService {
  private async mes(workspaceId: Types.ObjectId, offset: number) {
    const r = rangoMes(offset);
    const registros = await models.dailyBilling
      .find({ workspaceId, date: { $gte: r.desde, $lt: r.hasta } })
      .select("date amount metaSpend")
      .lean();
    const gastoPorDia = new Map<string, number>();
    let facturacion = 0;
    for (const e of registros as any[]) {
      facturacion += e.amount || 0;
      const dia = new Date(e.date).toISOString().slice(0, 10);
      // Mismo gasto repetido por registro; si uno quedo en 0 (sin snapshot), vale el mayor.
      gastoPorDia.set(dia, Math.max(gastoPorDia.get(dia) ?? 0, e.metaSpend || 0));
    }
    const gastoMeta = [...gastoPorDia.values()].reduce((a, b) => a + b, 0);
    const diasSinGasto = [...gastoPorDia.values()].filter((g) => g === 0).length;
    return {
      mes: r.clave,
      facturacion: redondear(facturacion),
      gastoMeta: redondear(gastoMeta),
      roas: gastoMeta > 0 ? redondear(facturacion / gastoMeta) : null,
      diasConRegistro: gastoPorDia.size,
      diasTranscurridos: r.diasTranscurridos,
      diasSinRegistro: Math.max(0, r.diasTranscurridos - gastoPorDia.size),
      /** Dias con facturacion pero sin el gasto de Meta guardado: inflan el ROAS. */
      diasSinGastoMeta: diasSinGasto,
    };
  }

  async resumen(workspaceId: Types.ObjectId) {
    const [actual, anterior, workspace, videos] = await Promise.all([
      this.mes(workspaceId, 0),
      this.mes(workspaceId, -1),
      models.workspaces.findById(workspaceId).select("metaAds.adAccountId metaAds.pageId").lean(),
      scriptPerformanceService
        .getWorkspacePerformance(String(workspaceId), { metric: "views", month: rangoMes(0).clave })
        .then((p) => p.videos.slice(0, 3).map((v) => ({ numero: v.numero, tema: v.tema, vistas: Math.round(v.value) })))
        .catch(() => []),
    ]);
    const metaConectado = Boolean((workspace as any)?.metaAds?.adAccountId);
    if (!metaConectado) {
      // Sin cuenta publicitaria el gasto 0 es real y el ROAS no significa nada.
      for (const m of [actual, anterior]) (m as any).roas = null;
    }
    return {
      mesActual: actual,
      mesAnterior: anterior,
      videosConMasVistasDelMes: videos,
      metaConectado,
      notas: [
        actual.diasSinRegistro > 0
          ? `Faltan ${actual.diasSinRegistro} días de facturación por registrar este mes: el ROAS está incompleto.`
          : null,
        !metaConectado
          ? "No tiene cuenta publicitaria de Meta conectada en metrics.bakano.ec: no hay ROAS. Eso se resuelve en la sesión de Meta con Joel Jimenez."
          : actual.diasSinGastoMeta > 0
            ? `En ${actual.diasSinGastoMeta} de ${actual.diasConRegistro} días el gasto de Meta guardado es 0: puede que no hubo campañas activas o que el gasto no quedó registrado. Si fue lo segundo, el ROAS real es menor. No lo des como dato firme.`
            : null,
        metaConectado
          ? "El gasto de cada día se guarda cuando se registra la facturación; si se registró durante el mismo día puede ser parcial. El detalle exacto está en metrics.bakano.ec."
          : null,
      ].filter(Boolean),
    };
  }
}

export const metricasClienteService = new MetricasClienteService();
