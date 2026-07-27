import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { SalesAppointmentModel } from "../models/salesAppointment.model";
import models from "../models";

function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

export async function handleGhlSalesAppointment(req: Request, res: Response): Promise<void> {
  const secret = process.env.GHL_BOOKING_WEBHOOK_SECRET;
  const calendarId = process.env.GHL_SALES_CALENDAR_ID;
  if (!secret || !calendarId) {
    res.status(503).json({ message: "La integración de agenda GHL no está configurada." });
    return;
  }
  if (!secretMatches(req.header("x-ghl-webhook-secret"), secret)) {
    res.status(401).json({ message: "Webhook no autorizado." });
    return;
  }

  const body = req.body || {};
  const appointmentId = String(body.appointmentId || body.appointment?.id || "");
  const payloadCalendarId = String(body.calendarId || body.appointment?.calendarId || "");
  const workspaceId = String(body.workspaceId || body.customData?.workspaceId || "");
  const contactEmail = String(body.contactEmail || body.contact?.email || "").trim().toLowerCase();
  const startsAt = new Date(body.startsAt || body.appointment?.startTime || body.startTime);
  const endsAtRaw = body.endsAt || body.appointment?.endTime || body.endTime;

  if (!appointmentId || !workspaceId || !contactEmail || Number.isNaN(startsAt.getTime()) || payloadCalendarId !== calendarId) {
    res.status(400).json({ message: "Evento de cita GHL incompleto o de un calendario no autorizado." });
    return;
  }

  const user = await models.users.findOne({
    email: contactEmail,
    isActive: true,
    $or: [{ "workspaces.workspaceId": workspaceId }, { workspaceId }],
  }).lean();
  if (!user) {
    res.status(404).json({ message: "No se encontró un usuario activo para este workspace y correo." });
    return;
  }

  const appointment = await SalesAppointmentModel.findOneAndUpdate(
    { ghlAppointmentId: appointmentId },
    {
      workspaceId,
      userId: user._id,
      contactEmail,
      calendarId: payloadCalendarId,
      status: String(body.status || body.appointment?.status || "confirmed").toLowerCase(),
      startsAt,
      endsAt: endsAtRaw ? new Date(endsAtRaw) : undefined,
    },
    { new: true, upsert: true, runValidators: true }
  );
  res.status(200).json({ message: "Cita de ventas registrada.", appointmentId: appointment._id });
}
