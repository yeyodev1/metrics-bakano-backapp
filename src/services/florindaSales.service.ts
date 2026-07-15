import axios from "axios";
import { Types } from "mongoose";
import { FlorindaDailySalesModel } from "../models/florindaDailySales.model";
import { getTodayEcuador } from "./tumesero.service";

export const FLORINDA_WORKSPACE_ID = "69d7c73318a77b5e0db9f74e";

interface FlorindaLoginResponse {
  token?: string;
}

interface FlorindaSale {
  fecha_orden: string;
  vendedor?: string | null;
  factura?: string | null;
  canal?: string | null;
  subtotal_sin_iva?: string | number | null;
  valor_iva?: string | number | null;
  valor_descuento?: string | number | null;
  precio_total?: string | number | null;
  estado?: string | null;
}

interface FlorindaSalesResponse {
  success?: boolean;
  data?: FlorindaSale[];
  message?: string;
}

interface BreakdownAccumulator {
  invoices: Set<string>;
  totalSales: number;
}

function amount(value: string | number | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Number(value.toFixed(2));
}

function apiDate(date: string): string {
  return date.replace(/-/g, "/");
}

export class FlorindaSalesService {
  private getConfig() {
    const user = process.env.FLORINDA_API_USER;
    const password = process.env.FLORINDA_API_PASSWORD;
    if (!user || !password) {
      throw new Error("Faltan FLORINDA_API_USER y FLORINDA_API_PASSWORD.");
    }

    return {
      baseUrl: (process.env.FLORINDA_API_BASE_URL || "https://florindafloreria.techncore.com").replace(/\/$/, ""),
      salesPath: process.env.FLORINDA_SALES_PATH || "/api/reportes/detalleventas",
      user,
      password,
    };
  }

  private async authenticate(): Promise<string> {
    const config = this.getConfig();
    const response = await axios.post<FlorindaLoginResponse>(`${config.baseUrl}/api/login`, null, {
      params: { user: config.user, password: config.password },
      timeout: 15000,
    });
    if (!response.data.token) throw new Error("La API de Florinda no devolvió un token.");
    return response.data.token;
  }

  private async fetchSales(from: string, to: string): Promise<FlorindaSale[]> {
    const config = this.getConfig();
    const token = await this.authenticate();
    const response = await axios.get<FlorindaSalesResponse>(`${config.baseUrl}${config.salesPath}`, {
      params: { fechaInicio: apiDate(from), fechaFin: apiDate(to) },
      headers: { Authorization: `Bearer ${token}` },
      timeout: 60000,
    });

    if (response.data.success === false || !Array.isArray(response.data.data)) {
      throw new Error(response.data.message || "Respuesta inválida de la API de Florinda.");
    }
    return response.data.data;
  }

  async syncRange(workspaceId: string, from: string, to: string) {
    if (workspaceId !== FLORINDA_WORKSPACE_ID) throw new Error("WORKSPACE_NOT_SUPPORTED");
    const sales = (await this.fetchSales(from, to)).filter(
      (sale) => !["ANULADA", "CANCELADA"].includes((sale.estado || "").toUpperCase())
    );
    const days = new Map<string, FlorindaSale[]>();

    for (const sale of sales) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(sale.fecha_orden)) continue;
      const entries = days.get(sale.fecha_orden) || [];
      entries.push(sale);
      days.set(sale.fecha_orden, entries);
    }

    const workspaceObjectId = new Types.ObjectId(workspaceId);
    const syncedAt = new Date();
    const dates: string[] = [];
    for (let current = new Date(`${from}T00:00:00Z`); current <= new Date(`${to}T00:00:00Z`); current.setUTCDate(current.getUTCDate() + 1)) {
      dates.push(current.toISOString().slice(0, 10));
    }

    const operations = dates.map((date) => {
      const daySales = days.get(date) || [];
      const invoices = new Set<string>();
      const channels = new Map<string, BreakdownAccumulator>();
      const sellers = new Map<string, BreakdownAccumulator>();
      let netSales = 0;
      let tax = 0;
      let discount = 0;
      let totalSales = 0;

      const addBreakdown = (map: Map<string, BreakdownAccumulator>, name: string, invoice: string, total: number) => {
        const current = map.get(name) || { invoices: new Set<string>(), totalSales: 0 };
        current.invoices.add(invoice);
        current.totalSales += total;
        map.set(name, current);
      };

      daySales.forEach((sale, index) => {
        const invoice = sale.factura || `${date}-${index}`;
        const lineTotal = amount(sale.precio_total);
        invoices.add(invoice);
        netSales += amount(sale.subtotal_sin_iva);
        tax += amount(sale.valor_iva);
        discount += amount(sale.valor_descuento);
        totalSales += lineTotal;
        addBreakdown(channels, sale.canal || "Sin canal", invoice, lineTotal);
        addBreakdown(sellers, sale.vendedor || "Sin vendedor", invoice, lineTotal);
      });

      const serialize = (map: Map<string, BreakdownAccumulator>) =>
        Array.from(map.entries())
          .map(([name, data]) => ({ name, invoiceCount: data.invoices.size, totalSales: round(data.totalSales) }))
          .sort((a, b) => b.totalSales - a.totalSales);

      return {
        updateOne: {
          filter: { workspaceId: workspaceObjectId, date },
          update: {
            $set: {
              invoiceCount: invoices.size,
              lineItemCount: daySales.length,
              netSales: round(netSales),
              tax: round(tax),
              discount: round(discount),
              totalSales: round(totalSales),
              byChannel: serialize(channels),
              bySeller: serialize(sellers),
              syncedAt,
            },
          },
          upsert: true,
        },
      };
    });

    if (operations.length) await FlorindaDailySalesModel.bulkWrite(operations);
    return { from, to, daysSynced: operations.length, lineItems: sales.length, syncedAt };
  }

  async syncCurrentYear(workspaceId = FLORINDA_WORKSPACE_ID) {
    const today = getTodayEcuador();
    return this.syncRange(workspaceId, `${today.slice(0, 4)}-01-01`, today);
  }

  async getMonthSummary(workspaceId: string, year: number, month: number) {
    const from = `${year}-${String(month).padStart(2, "0")}-01`;
    const to = `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
    const days = await FlorindaDailySalesModel.find({
      workspaceId: new Types.ObjectId(workspaceId),
      date: { $gte: from, $lte: to },
    }).sort({ date: 1 }).lean();

    const totals = days.reduce(
      (sum, day) => ({
        invoiceCount: sum.invoiceCount + day.invoiceCount,
        lineItemCount: sum.lineItemCount + day.lineItemCount,
        netSales: round(sum.netSales + day.netSales),
        tax: round(sum.tax + day.tax),
        discount: round(sum.discount + day.discount),
        totalSales: round(sum.totalSales + day.totalSales),
      }),
      { invoiceCount: 0, lineItemCount: 0, netSales: 0, tax: 0, discount: 0, totalSales: 0 }
    );
    return { days, ...totals };
  }
}

export const florindaSalesService = new FlorindaSalesService();
