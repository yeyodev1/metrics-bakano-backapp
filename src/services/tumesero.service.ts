import axios from "axios";
import { Types } from "mongoose";
import { SalesDailySummaryModel } from "../models/salesDailySummary.model";
import { TumeseroUsageModel } from "../models/tumeseroUsage.model";

// ── Constants ──────────────────────────────────────────────────────────────────
const TUMESERO_API_URL = "https://www.tumesero.com/api_sesiones_kuikers.php";
const TUMESERO_TOKEN = "SLKDJ20934831SKDJkjsooK3O399jgrehlhb90764aaqTYH_387JJyu";
const BOLONCITY_WORKSPACE_ID = "69bdadc67386136fc3682734";
const DAILY_CALL_LIMIT = 50;

// ── Types ──────────────────────────────────────────────────────────────────────
interface TumeseroSession {
  id_sesion: number;
  fec_sesion: string;
  fec_validada: string | null;
  id_menu_actual: number;
  cod_tienda: string | null;
  nombre_tienda: string | null;
  id_orden: number | null;
  telefono: string;
  nombre_corto: string | null;
  nombre_cliente: string | null;
  estado: string;
  latitud: string | null;
  longitud: string | null;
  primer_mensaje: string | null;
  estado_orden: string | null;
  forma_pago: string | null;
  estado_pago: string | null;
  subtotal_neto: string | null;
  costo_delivery: string | null;
  subtotal_desc: string | null;
  estado_funnel: "CON_ORDEN" | "CON_PAGO" | "SIN_ORDEN";
}

interface TumeseroApiResponse {
  status: string;
  total: number;
  desde: string;
  hasta: string;
  data: TumeseroSession[];
}

export interface SyncResult {
  date: string;
  totalSessions: number;
  totalOrders: number;
  conversionRate: number;
  totalRevenue: number;
  totalBilled: number;
  byStore: { storeName: string; sessions: number; orders: number; revenue: number; deliveryCost: number }[];
  syncedAt: Date;
  apiCallsUsedToday: number;
  apiCallsRemainingToday: number;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Returns today's date as YYYY-MM-DD in Ecuador timezone (UTC-5).
 */
export function getTodayEcuador(): string {
  const now = new Date();
  const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
  const ecuadorTime = new Date(now.getTime() + ecuadorOffsetMs);
  const year = ecuadorTime.getUTCFullYear();
  const month = String(ecuadorTime.getUTCMonth() + 1).padStart(2, "0");
  const day = String(ecuadorTime.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ── Service ────────────────────────────────────────────────────────────────────

export class TumeseroService {
  /**
   * Fetches sessions from tumesero API for the given date range.
   * Automatically tracks API usage and enforces daily limit.
   */
  async fetchSessions(desde: string, hasta: string): Promise<TumeseroSession[]> {
    const todayStr = getTodayEcuador();

    // Check and update daily usage
    const usage = await TumeseroUsageModel.findOneAndUpdate(
      { date: todayStr },
      { $inc: { callCount: 1 }, $set: { lastCallAt: new Date() } },
      { upsert: true, new: true }
    );

    if (usage.callCount > DAILY_CALL_LIMIT) {
      throw new Error(
        `Límite diario de ${DAILY_CALL_LIMIT} llamadas a Tumesero alcanzado. Intenta mañana.`
      );
    }

    const response = await axios.get<TumeseroApiResponse>(TUMESERO_API_URL, {
      params: { desde, hasta, token: TUMESERO_TOKEN },
      timeout: 15000,
    });

    if (response.data.status !== "ok") {
      throw new Error("Tumesero API returned non-ok status");
    }

    return response.data.data;
  }

  /**
   * Fetches and aggregates sessions for a single date, then upserts the
   * SalesDailySummary document for that workspace+date.
   */
  async syncDailyData(workspaceId: string, date: string): Promise<SyncResult> {
    const sessions = await this.fetchSessions(date, date);

    // Aggregate totals
    let totalOrders = 0;
    let totalRevenue = 0;
    let totalDelivery = 0;
    let totalBilled = 0;
    const storeMap = new Map<
      string,
      { sessions: number; orders: number; revenue: number; deliveryCost: number }
    >();

    for (const s of sessions) {
      const isOrder = s.estado_funnel === "CON_ORDEN" || s.estado_funnel === "CON_PAGO";
      const storeName = s.nombre_tienda || "Sin tienda";

      if (!storeMap.has(storeName)) {
        storeMap.set(storeName, { sessions: 0, orders: 0, revenue: 0, deliveryCost: 0 });
      }
      const storeData = storeMap.get(storeName)!;
      storeData.sessions++;

      if (isOrder) {
        totalOrders++;
        storeData.orders++;

        const rev = parseFloat(s.subtotal_neto ?? "0") || 0;
        const del = parseFloat(s.costo_delivery ?? "0") || 0;
        const billed = parseFloat(s.subtotal_desc ?? "0") || 0;

        totalRevenue += rev;
        totalDelivery += del;
        totalBilled += billed;
        storeData.revenue += rev;
        storeData.deliveryCost += del;
      }
    }

    const totalSessions = sessions.length;
    const conversionRate =
      totalSessions > 0 ? parseFloat(((totalOrders / totalSessions) * 100).toFixed(2)) : 0;

    const byStore = Array.from(storeMap.entries()).map(([storeName, data]) => ({
      storeName,
      ...data,
    }));

    const syncedAt = new Date();

    // Upsert the daily summary
    await SalesDailySummaryModel.findOneAndUpdate(
      { workspaceId: new Types.ObjectId(workspaceId), date },
      {
        $set: {
          totalSessions,
          totalOrders,
          conversionRate,
          totalRevenue: parseFloat(totalRevenue.toFixed(2)),
          totalDelivery: parseFloat(totalDelivery.toFixed(2)),
          totalBilled: parseFloat(totalBilled.toFixed(2)),
          byStore,
          syncedAt,
        },
      },
      { upsert: true, new: true }
    );

    // Return usage info for the response
    const todayStr = getTodayEcuador();
    const usageDoc = await TumeseroUsageModel.findOne({ date: todayStr });
    const apiCallsUsedToday = usageDoc?.callCount ?? 1;

    return {
      date,
      totalSessions,
      totalOrders,
      conversionRate,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalBilled: parseFloat(totalBilled.toFixed(2)),
      byStore,
      syncedAt,
      apiCallsUsedToday,
      apiCallsRemainingToday: Math.max(0, DAILY_CALL_LIMIT - apiCallsUsedToday),
    };
  }

  /**
   * Returns the daily summary documents for a given month.
   */
  async getMonthSummary(workspaceId: string, year: number, month: number) {
    const pad = (n: number) => String(n).padStart(2, "0");
    const desde = `${year}-${pad(month)}-01`;
    // Last day of month
    const lastDay = new Date(year, month, 0).getDate();
    const hasta = `${year}-${pad(month)}-${pad(lastDay)}`;

    const docs = await SalesDailySummaryModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
      date: { $gte: desde, $lte: hasta },
    })
      .sort({ date: 1 })
      .lean();

    // Month-level aggregates
    const monthTotals = docs.reduce(
      (acc, d) => {
        acc.totalSessions += d.totalSessions;
        acc.totalOrders += d.totalOrders;
        acc.totalRevenue += d.totalRevenue;
        acc.totalBilled += d.totalBilled;
        return acc;
      },
      { totalSessions: 0, totalOrders: 0, totalRevenue: 0, totalBilled: 0 }
    );

    const monthConversionRate =
      monthTotals.totalSessions > 0
        ? parseFloat(
            ((monthTotals.totalOrders / monthTotals.totalSessions) * 100).toFixed(2)
          )
        : 0;

    return {
      days: docs,
      ...monthTotals,
      monthConversionRate,
    };
  }

  /**
   * Returns current daily API usage for Boloncity token.
   */
  async getApiUsage() {
    const todayStr = getTodayEcuador();
    const usage = await TumeseroUsageModel.findOne({ date: todayStr }).lean();
    const callCount = usage?.callCount ?? 0;
    return {
      date: todayStr,
      callsUsedToday: callCount,
      callsRemainingToday: Math.max(0, DAILY_CALL_LIMIT - callCount),
      dailyLimit: DAILY_CALL_LIMIT,
      tokenExpiresAt: "2026-07-31 23:59:59",
    };
  }

  getBoloncityWorkspaceId() {
    return BOLONCITY_WORKSPACE_ID;
  }
}

export const tumeseroService = new TumeseroService();
