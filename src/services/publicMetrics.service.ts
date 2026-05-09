import { Types } from "mongoose";
import models from "../models";

export class PublicMetricsService {
  normalizeDateToEcuador(date: Date): Date {
    const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
    const ecuadorTime = new Date(date.getTime() + ecuadorOffsetMs);
    const year = ecuadorTime.getUTCFullYear();
    const month = ecuadorTime.getUTCMonth();
    const day = ecuadorTime.getUTCDate();
    return new Date(Date.UTC(year, month, day, 5, 0, 0, 0));
  }

  dateToEcuadorString(date: Date): string {
    const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
    const ecuadorTime = new Date(date.getTime() + ecuadorOffsetMs);
    const year = ecuadorTime.getUTCFullYear();
    const month = String(ecuadorTime.getUTCMonth() + 1).padStart(2, "0");
    const day = String(ecuadorTime.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async getWorkspaceMetricsSingle(workspaceId: string, targetDate: Date) {
    const workspace = await models.workspaces.findById(workspaceId).lean();
    if (!workspace) return null;

    const dayEntries = await models.dailyBilling
      .find({ workspaceId: new Types.ObjectId(workspaceId), date: targetDate })
      .lean();

    const totalBillingToday = dayEntries.reduce((sum, e) => sum + (e.amount || 0), 0);
    const totalMetaSpendToday = dayEntries.length > 0 ? (dayEntries[0]?.metaSpend ?? 0) : 0;
    const avgROASToday =
      totalMetaSpendToday > 0 ? totalBillingToday / totalMetaSpendToday : 0;

    const ecuadorNow = new Date(new Date().getTime() + -5 * 60 * 60 * 1000);
    const monthStart = new Date(Date.UTC(ecuadorNow.getUTCFullYear(), ecuadorNow.getUTCMonth(), 1, 5, 0, 0, 0));
    const monthEnd = new Date(Date.UTC(ecuadorNow.getUTCFullYear(), ecuadorNow.getUTCMonth() + 1, 1, 5, 0, 0, 0));

    const monthEntries = await models.dailyBilling
      .find({ workspaceId: new Types.ObjectId(workspaceId), date: { $gte: monthStart, $lt: monthEnd } })
      .lean();

    const totalMonthBilling = monthEntries.reduce((sum, e) => sum + (e.amount || 0), 0);
    const totalMonthSpend = monthEntries.reduce((sum, e) => sum + (e.metaSpend || 0), 0);

    const yesterday = new Date(targetDate.getTime() - 24 * 60 * 60 * 1000);
    const hasYesterdayBilling = await models.dailyBilling.exists({
      workspaceId: new Types.ObjectId(workspaceId),
      date: yesterday,
    });

    return {
      workspaceId: workspace._id.toString(),
      name: workspace.name,
      isActive: workspace.isActive,
      metaAds: {
        adAccountName: workspace.metaAds?.adAccountName ?? null,
        lastSyncedAt: workspace.metaAds?.lastSyncedAt ?? null,
        connected: !!workspace.metaAds?.accessToken,
      },
      today: {
        date: this.dateToEcuadorString(targetDate),
        totalBilling: totalBillingToday,
        totalMetaSpend: totalMetaSpendToday,
        avgROAS: avgROASToday,
        entryCount: dayEntries.length,
      },
      month: {
        totalBilling: totalMonthBilling,
        totalMetaSpend: totalMonthSpend,
        avgROAS: totalMonthSpend > 0 ? totalMonthBilling / totalMonthSpend : 0,
      },
      hasBillingToday: dayEntries.length > 0,
      hasBillingYesterday: !!hasYesterdayBilling,
    };
  }

  async getAllWorkspacesMetrics(page: number, limit: number, workspaceId?: string, date?: Date) {
    const targetDate = this.normalizeDateToEcuador(date ?? new Date());
    const filter: Record<string, any> = {};
    if (workspaceId) filter._id = new Types.ObjectId(workspaceId);

    const total = await models.workspaces.countDocuments(filter);
    const workspaces = await models.workspaces
      .find(filter)
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    const data = await Promise.all(
      workspaces.map((ws) => this.getWorkspaceMetricsSingle(ws._id.toString(), targetDate))
    );

    return {
      data: data.filter(Boolean),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async getSingleWorkspaceMetrics(workspaceId: string, date?: Date, month?: number, year?: number) {
    const targetDate = this.normalizeDateToEcuador(date ?? new Date());
    const dayMetrics = await this.getWorkspaceMetricsSingle(workspaceId, targetDate);
    if (!dayMetrics) return null;

    if (month && year) {
      const monthStart = new Date(Date.UTC(year, month - 1, 1, 5, 0, 0, 0));
      const monthEnd = new Date(Date.UTC(year, month, 1, 5, 0, 0, 0));
      const monthEntries = await models.dailyBilling
        .find({ workspaceId: new Types.ObjectId(workspaceId), date: { $gte: monthStart, $lt: monthEnd } })
        .lean();

      const grouped: Record<string, { totalBilling: number; totalMetaSpend: number; entryCount: number }> = {};
      for (const e of monthEntries) {
        const key = this.dateToEcuadorString(e.date);
        if (!grouped[key]) grouped[key] = { totalBilling: 0, totalMetaSpend: 0, entryCount: 0 };
        grouped[key].totalBilling += e.amount || 0;
        grouped[key].totalMetaSpend = e.metaSpend || 0;
        grouped[key].entryCount++;
      }

      return { ...dayMetrics, monthDetail: grouped };
    }

    return dayMetrics;
  }

  async getBillingAlerts() {
    const today = this.normalizeDateToEcuador(new Date());
    const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);

    const workspaces = await models.workspaces.find({ isActive: true }).lean();

    const results = await Promise.all(
      workspaces.map(async (ws) => {
        const hasYesterday = await models.dailyBilling.exists({
          workspaceId: ws._id,
          date: yesterday,
        });
        return {
          workspaceId: ws._id.toString(),
          name: ws.name,
          hasBillingYesterday: !!hasYesterday,
          metaConnected: !!ws.metaAds?.accessToken,
        };
      })
    );

    return {
      date: this.dateToEcuadorString(yesterday),
      missing: results.filter((r) => !r.hasBillingYesterday),
      filled: results.filter((r) => r.hasBillingYesterday),
      totalWorkspaces: results.length,
    };
  }
}

export const publicMetricsService = new PublicMetricsService();
