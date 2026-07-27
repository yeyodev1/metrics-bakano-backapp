import type { Response } from "express";
import { SalesAppointmentModel } from "../models/salesAppointment.model";
import { SalesBookingRequestModel } from "../models/salesBookingRequest.model";
import type { AuthRequest } from "../types/AuthRequest";
import models from "../models";

function ecuadorDayEnd(value: Date): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Guayaquil", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(value)
    .reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return new Date(`${parts.year}-${parts.month}-${parts.day}T23:59:59.999-05:00`);
}

function ecuadorDateParts(value: Date): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Guayaquil", year: "numeric", month: "numeric", day: "numeric" })
    .formatToParts(value)
    .reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function ecuadorDate(year: number, month: number, day: number, endOfDay = false): Date {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDay);
  return new Date(`${year}-${String(month).padStart(2, "0")}-${String(safeDay).padStart(2, "0")}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}-05:00`);
}

export async function getUpcomingSalesMeetings(req: AuthRequest, res: Response): Promise<void> {
  const appointments = await SalesAppointmentModel.find({
    startsAt: { $gte: new Date() },
    status: { $nin: ["cancelled", "canceled"] },
  })
    .sort({ startsAt: 1 })
    .populate("userId", "name email")
    .populate("workspaceId", "name")
    .lean();

  const requests = await SalesBookingRequestModel.find({
    $or: appointments.map((appointment) => ({ workspaceId: appointment.workspaceId, userId: appointment.userId })),
  }).lean();
  const requestsByMeeting = new Map(requests.map((request) => [`${request.workspaceId}:${request.userId}`, request]));

  res.json({
    meetings: appointments.map((appointment: any) => {
      const client = appointment.userId;
      const workspace = appointment.workspaceId;
      const request = requestsByMeeting.get(`${workspace?._id || workspace}:${client?._id || client}`);
      return {
        id: appointment._id,
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        status: appointment.status,
        client: { name: client?.name || "Cliente", email: client?.email || appointment.contactEmail },
        workspace: { id: workspace?._id || workspace, name: workspace?.name || "Entorno" },
        diagnostic: request ? {
          salesApproach: request.salesApproach,
          commonObjection: request.commonObjection,
          otherObjection: request.otherObjection,
          evidence: request.lostSaleEvidence,
        } : null,
      };
    }),
  });
}

export async function getSalesBookingForms(req: AuthRequest, res: Response): Promise<void> {
  const forms = await SalesBookingRequestModel.find()
    .sort({ createdAt: -1 })
    .populate("userId", "name email")
    .populate("workspaceId", "name")
    .lean();

  const enrichedForms = await Promise.all(forms.map(async (form: any) => {
    const billingEntries = await models.dailyBilling.find({
      workspaceId: form.workspaceId._id || form.workspaceId,
      userId: form.userId._id || form.userId,
      date: { $lte: ecuadorDayEnd(form.createdAt) },
    }).select("date amount metaSpend roas").sort({ date: -1 }).lean();
    const totalRevenue = billingEntries.reduce((total, entry) => total + entry.amount, 0);
    const totalMetaSpend = billingEntries.reduce((total, entry) => total + entry.metaSpend, 0);
    const submittedDate = ecuadorDateParts(form.createdAt);
    const currentMonthStart = ecuadorDate(submittedDate.year, submittedDate.month, 1);
    const previousMonth = submittedDate.month === 1 ? { year: submittedDate.year - 1, month: 12 } : { year: submittedDate.year, month: submittedDate.month - 1 };
    const previousMonthStart = ecuadorDate(previousMonth.year, previousMonth.month, 1);
    const previousMonthCutoff = ecuadorDate(previousMonth.year, previousMonth.month, submittedDate.day, true);
    const currentMonthRevenue = billingEntries.filter((entry) => entry.date >= currentMonthStart).reduce((total, entry) => total + entry.amount, 0);
    const previousMonthRevenue = billingEntries.filter((entry) => entry.date >= previousMonthStart && entry.date <= previousMonthCutoff).reduce((total, entry) => total + entry.amount, 0);
    return {
      id: form._id,
      submittedAt: form.createdAt,
      client: { name: form.userId?.name || "Cliente", email: form.userId?.email || "" },
      workspace: { id: form.workspaceId?._id || form.workspaceId, name: form.workspaceId?.name || "Entorno" },
      diagnostic: {
        salesApproach: form.salesApproach,
        commonObjection: form.commonObjection,
        otherObjection: form.otherObjection,
        evidence: form.lostSaleEvidence,
      },
      billing: {
        cutoffDate: ecuadorDayEnd(form.createdAt),
        totalRevenue,
        totalMetaSpend,
        roas: totalMetaSpend > 0 ? totalRevenue / totalMetaSpend : 0,
        registeredDays: billingEntries.length,
        entries: billingEntries,
        monthlyComparison: {
          currentMonthStart,
          previousMonthStart,
          currentMonthRevenue,
          previousMonthRevenue,
          changePercent: previousMonthRevenue > 0 ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 : null,
        },
      },
    };
  }));
  res.json({ forms: enrichedForms });
}


export async function getSalesBookingFormById(req: AuthRequest, res: Response): Promise<void> {
  try {
    const form = await SalesBookingRequestModel.findById(req.params.formId)
      .populate('userId', 'name email')
      .populate('workspaceId', 'name')
      .lean();
    if (!form) { res.status(404).json({ message: 'Formulario no encontrado.' }); return; }

    const billingEntries = await models.dailyBilling.find({
      workspaceId: form.workspaceId._id || form.workspaceId,
      userId: form.userId._id || form.userId,
      date: { $lte: ecuadorDayEnd(form.createdAt) },
    }).select('date amount metaSpend roas').sort({ date: -1 }).lean();
    const totalRevenue = billingEntries.reduce((total, entry) => total + entry.amount, 0);
    const totalMetaSpend = billingEntries.reduce((total, entry) => total + entry.metaSpend, 0);
    const submittedDate = ecuadorDateParts(form.createdAt);
    const currentMonthStart = ecuadorDate(submittedDate.year, submittedDate.month, 1);
    const previousMonth = submittedDate.month === 1 ? { year: submittedDate.year - 1, month: 12 } : { year: submittedDate.year, month: submittedDate.month - 1 };
    const previousMonthStart = ecuadorDate(previousMonth.year, previousMonth.month, 1);
    const previousMonthCutoff = ecuadorDate(previousMonth.year, previousMonth.month, submittedDate.day, true);
    const currentMonthRevenue = billingEntries.filter((entry) => entry.date >= currentMonthStart).reduce((total, entry) => total + entry.amount, 0);
    const previousMonthRevenue = billingEntries.filter((entry) => entry.date >= previousMonthStart && entry.date <= previousMonthCutoff).reduce((total, entry) => total + entry.amount, 0);
    res.json({
      form: {
        id: form._id,
        submittedAt: form.createdAt,
        client: { name: (form.userId as any)?.name || 'Cliente', email: (form.userId as any)?.email || '' },
        workspace: { id: (form.workspaceId as any)?._id || form.workspaceId, name: (form.workspaceId as any)?.name || 'Entorno' },
        diagnostic: {
          salesApproach: form.salesApproach,
          commonObjection: form.commonObjection,
          otherObjection: form.otherObjection,
          evidence: form.lostSaleEvidence,
        },
        billing: {
          cutoffDate: ecuadorDayEnd(form.createdAt),
          totalRevenue,
          totalMetaSpend,
          roas: totalMetaSpend > 0 ? totalRevenue / totalMetaSpend : 0,
          registeredDays: billingEntries.length,
          entries: billingEntries,
          monthlyComparison: {
            currentMonthStart,
            previousMonthStart,
            currentMonthRevenue,
            previousMonthRevenue,
            changePercent: previousMonthRevenue > 0 ? ((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100 : null,
          },
        },
      },
    });
  } catch (err: any) {
    res.status(500).json({ message: err.message || 'Error al obtener el formulario.' });
  }
}
