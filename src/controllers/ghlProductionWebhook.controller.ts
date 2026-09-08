import { timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import { crmProductionSyncService, normalizarCita } from "../services/crmProductionSync.service";

function secretMatches(received: string | undefined, expected: string): boolean {
  if (!received) return false;
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

/**
 * POST /v1/webhooks/ghl/production-appointment
 *
 * Lo llama el workflow del CRM cuando el cliente agenda, mueve o cancela una
 * produccion por el link de agendamiento. Se acepta el secreto en la cabecera
 * `x-ghl-webhook-secret` o en `?secret=` (el webhook del workflow de GHL
 * permite cabeceras, pero por si acaso).
 *
 * Responde 200 tambien cuando la cita se ignora o no encuentra entorno: el
 * CRM reintenta ante errores y volveria a mandar lo mismo.
 */
export async function handleGhlProductionAppointment(req: Request, res: Response): Promise<void> {
  const secret = process.env.GHL_PRODUCTION_WEBHOOK_SECRET || process.env.GHL_BOOKING_WEBHOOK_SECRET;
  if (!secret) {
    res.status(503).json({ message: "La integración de producción con el CRM no está configurada." });
    return;
  }
  const recibido = req.header("x-ghl-webhook-secret") || (typeof req.query.secret === "string" ? req.query.secret : undefined);
  if (!secretMatches(recibido, secret)) {
    res.status(401).json({ message: "Webhook no autorizado." });
    return;
  }

  const cita = normalizarCita(req.body);
  if (!cita) {
    console.warn("[CRM Producción] webhook sin cita reconocible:", JSON.stringify(req.body).slice(0, 500));
    res.status(400).json({ message: "No se reconoció la cita en el payload (falta id o fecha de inicio)." });
    return;
  }

  try {
    const resultado = await crmProductionSyncService.aplicarCita(cita, "webhook");
    console.log(`[CRM Producción] ${cita.appointmentId} → ${resultado.accion}${resultado.motivo ? ` (${resultado.motivo})` : ""}`);
    res.status(200).json({
      message: "Cita de producción procesada.",
      accion: resultado.accion,
      motivo: resultado.motivo,
      entryId: resultado.entry?._id ?? null,
      workspaceId: resultado.workspaceId ?? null,
    });
  } catch (err: any) {
    console.error("[CRM Producción] webhook falló:", err);
    res.status(500).json({ message: "No se pudo registrar la producción.", error: err.message });
  }
}
