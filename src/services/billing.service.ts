import axios from "axios";
import { Types } from "mongoose";
import models from "../models";
import { resendService } from "./resend.service";

export class BillingService {
  private readonly graphUrl = "https://graph.facebook.com/v22.0";

  /**
   * Normalizes a date to midnight UTC of the day in Ecuador (UTC-5).
   * Example: any time on 2026-03-30 in Ecuador → 2026-03-30T05:00:00.000Z
   */
  normalizeDateToEcuador(date: Date): Date {
    // Ecuador is UTC-5. Get the date components in Ecuador time.
    const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
    const ecuadorTime = new Date(date.getTime() + ecuadorOffsetMs);

    // Extract year, month, day in Ecuador local time
    const year = ecuadorTime.getUTCFullYear();
    const month = ecuadorTime.getUTCMonth();
    const day = ecuadorTime.getUTCDate();

    // Midnight Ecuador = midnight local + 5h = 05:00 UTC
    return new Date(Date.UTC(year, month, day, 5, 0, 0, 0));
  }

  /**
   * Formats a Date to YYYY-MM-DD string in Ecuador timezone
   */
  private dateToEcuadorString(date: Date): string {
    const ecuadorOffsetMs = -5 * 60 * 60 * 1000;
    const ecuadorTime = new Date(date.getTime() + ecuadorOffsetMs);
    const year = ecuadorTime.getUTCFullYear();
    const month = String(ecuadorTime.getUTCMonth() + 1).padStart(2, "0");
    const day = String(ecuadorTime.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  /**
   * Creates a billing entry for a user in a workspace.
   * Fetches metaSpend from Meta API if credentials are available.
   * Notifies all superadmins via email.
   */
  async createEntry(
    workspaceId: string,
    userId: string,
    amount: number,
    notes?: string
  ): Promise<InstanceType<typeof models.dailyBilling>> {
    const workspace = await models.workspaces.findById(workspaceId).lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const user = await models.users.findById(userId).lean();
    if (!user) throw new Error("USER_NOT_FOUND");

    const today = this.normalizeDateToEcuador(new Date());

    // Check for existing entry for this user/workspace/day
    const existing = await models.dailyBilling.findOne({
      userId: new Types.ObjectId(userId),
      workspaceId: new Types.ObjectId(workspaceId),
      date: today,
    });
    if (existing) throw new Error("ENTRY_ALREADY_EXISTS");

    // Fetch Meta spend for the day
    let metaSpend = 0;
    const accessToken = workspace.metaAds?.accessToken;
    const adAccountId = workspace.metaAds?.adAccountId;

    if (accessToken && adAccountId) {
      try {
        const dateStr = this.dateToEcuadorString(today);
        const dayInsights = await axios.get(
          `${this.graphUrl}/act_${adAccountId}/insights`,
          {
            params: {
              access_token: accessToken,
              level: "account",
              fields: "spend",
              time_range: JSON.stringify({ since: dateStr, until: dateStr }),
            },
          }
        );
        metaSpend = parseFloat(
          dayInsights.data.data?.[0]?.spend || "0"
        );
      } catch (error: any) {
        console.error("[BillingService] Failed to fetch Meta spend:", error.response?.data || error.message);
        metaSpend = 0;
      }
    }

    const roas = metaSpend > 0 ? amount / metaSpend : 0;

    const entry = await models.dailyBilling.create({
      workspaceId: new Types.ObjectId(workspaceId),
      userId: new Types.ObjectId(userId),
      userName: user.name || user.email,
      userEmail: user.email,
      date: today,
      amount,
      metaSpend,
      roas,
      notes,
    });

    // Get day total for notification
    const daySummary = await this.getDaySummary(workspaceId, today);

    // Notify superadmins + external collaborators
    try {
      const [superadmins, externals] = await Promise.all([
        models.users.find({ role: "superadmin", isActive: true }).lean(),
        this.getExternalCollaboratorEmails(workspaceId),
      ]);

      const superadminEmails = superadmins.map((sa) => sa.email);

      if (superadminEmails.length > 0) {
        await resendService.sendBillingEnteredNotification({
          superadminEmails,
          workspaceName: workspace.name,
          userName: user.name || user.email,
          amount,
          totalDay: daySummary.totalAmount,
          metaSpend,
          roas,
          date: today,
        });
      }

      if (externals.length > 0) {
        await resendService.sendBillingExternalNotification({
          recipients: externals,
          workspaceName: workspace.name,
          workspaceId,
          userName: user.name || user.email,
          amount,
          totalDay: daySummary.totalAmount,
          metaSpend,
          roas,
          date: today,
          isUpdate: false,
        });
      }
    } catch (emailError: any) {
      console.error("[BillingService] Failed to send billing notifications:", emailError.message);
    }

    return entry;
  }

  /**
   * Returns all entries for a workspace in a given month, grouped by day.
   */
  async getMonthEntries(
    workspaceId: string,
    year: number,
    month: number
  ): Promise<{
    days: Array<{
      date: Date;
      dateStr: string;
      totalAmount: number;
      totalMetaSpend: number;
      avgROAS: number;
      entries: any[];
    }>;
  }> {
    // Month is 1-indexed. Build start/end in Ecuador midnight UTC.
    const startDate = new Date(Date.UTC(year, month - 1, 1, 5, 0, 0, 0));
    const endDate = new Date(Date.UTC(year, month, 1, 5, 0, 0, 0));

    const entries = await models.dailyBilling
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        date: { $gte: startDate, $lt: endDate },
      })
      .sort({ date: 1 })
      .lean();

    // Group by date
    const dayMap = new Map<string, typeof entries>();
    for (const entry of entries) {
      const key = entry.date.toISOString();
      if (!dayMap.has(key)) dayMap.set(key, []);
      dayMap.get(key)!.push(entry);
    }

    const days = Array.from(dayMap.entries()).map(([isoDate, dayEntries]) => {
      const totalAmount = dayEntries.reduce((sum, e) => sum + e.amount, 0);
      const totalMetaSpend = dayEntries[0]?.metaSpend ?? 0;
      const avgROAS = totalMetaSpend > 0 ? totalAmount / totalMetaSpend : 0;
      const dateObj = new Date(isoDate);
      return {
        date: dateObj,
        dateStr: this.dateToEcuadorString(dateObj),
        totalAmount,
        totalMetaSpend,
        avgROAS,
        entries: dayEntries,
      };
    });

    return { days };
  }

  /**
   * Returns the summary for a specific day in a workspace.
   */
  async getDaySummary(
    workspaceId: string,
    date: Date
  ): Promise<{
    totalAmount: number;
    totalMetaSpend: number;
    avgROAS: number;
    entries: any[];
    entryCount: number;
  }> {
    const normalizedDate = this.normalizeDateToEcuador(date);

    const entries = await models.dailyBilling
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        date: normalizedDate,
      })
      .lean();

    const totalAmount = entries.reduce((sum, e) => sum + e.amount, 0);
    const totalMetaSpend = entries[0]?.metaSpend ?? 0;
    const avgROAS = totalMetaSpend > 0 ? totalAmount / totalMetaSpend : 0;

    return {
      totalAmount,
      totalMetaSpend,
      avgROAS,
      entries,
      entryCount: entries.length,
    };
  }

  /**
   * Returns all external collaborator emails for a workspace.
   */
  private async getExternalCollaboratorEmails(workspaceId: string): Promise<{ email: string; name: string }[]> {
    const externals = await models.users.find({
      isInternal: false,
      isActive: true,
      "workspaces.workspaceId": new Types.ObjectId(workspaceId),
    }).lean();
    return externals.map(u => ({ email: u.email, name: u.name || u.email }));
  }

  /**
   * Updates a billing entry. Superadmin can always edit.
   * Others can edit entries up to 7 days old (within the week).
   * Sends email notifications to all external collaborators after update.
   */
  async updateEntry(
    entryId: string,
    workspaceId: string,
    requesterId: string,
    requesterRole: string,
    newAmount: number,
    notes?: string
  ): Promise<InstanceType<typeof models.dailyBilling>> {
    const entry = await models.dailyBilling.findById(entryId);
    if (!entry) throw new Error("ENTRY_NOT_FOUND");

    // Check edit permission
    if (requesterRole !== "superadmin") {
      const today = this.normalizeDateToEcuador(new Date());
      const entryDate = this.normalizeDateToEcuador(entry.date);
      const diffDays = Math.round((today.getTime() - entryDate.getTime()) / (1000 * 60 * 60 * 24));

      if (diffDays > 7) {
        throw new Error("EDIT_NOT_ALLOWED");
      }

      if (entry.userId.toString() !== requesterId) {
        throw new Error("EDIT_NOT_ALLOWED");
      }
    }

    const metaSpend = entry.metaSpend;
    const roas = metaSpend > 0 ? newAmount / metaSpend : 0;

    entry.amount = newAmount;
    entry.roas = roas;
    if (notes !== undefined) entry.notes = notes;

    await entry.save();

    // Notify external collaborators after update
    try {
      const workspace = await models.workspaces.findById(workspaceId).lean();
      const externals = await this.getExternalCollaboratorEmails(workspaceId);
      const daySummary = await this.getDaySummary(workspaceId, entry.date);

      if (externals.length > 0 && workspace) {
        await resendService.sendBillingExternalNotification({
          recipients: externals,
          workspaceName: workspace.name,
          workspaceId,
          userName: entry.userName,
          amount: newAmount,
          totalDay: daySummary.totalAmount,
          metaSpend,
          roas,
          date: entry.date,
          isUpdate: true,
        });
      }
    } catch (emailError: any) {
      console.error("[BillingService] Failed to send external notification after update:", emailError.message);
    }

    return entry;
  }

  /**
   * Checks if a user has an entry for the current day in a workspace.
   */
  async getUserEntryForDay(
    userId: string,
    workspaceId: string,
    date: Date
  ): Promise<InstanceType<typeof models.dailyBilling> | null> {
    const normalizedDate = this.normalizeDateToEcuador(date);
    return models.dailyBilling.findOne({
      userId: new Types.ObjectId(userId),
      workspaceId: new Types.ObjectId(workspaceId),
      date: normalizedDate,
    });
  }
}

export const billingService = new BillingService();
