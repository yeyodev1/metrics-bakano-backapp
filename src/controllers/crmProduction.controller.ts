import type { Request, Response } from "express";
import { HttpStatusCode } from "axios";
import { ghlService } from "../services/ghl.service";
import { crmProductionSyncService } from "../services/crmProductionSync.service";

/**
 * GET /admin/crm/calendars — calendarios del CRM con su ID y nombre, y cuales
 * estan configurados como de produccion. Para que el superadmin vea desde
 * Metrics que calendario esta amarrado sin entrar a Vercel ni al CRM.
 */
export async function listCrmCalendars(_req: Request, res: Response): Promise<void> {
  if (!ghlService.isConfigured()) {
    res.status(HttpStatusCode.ServiceUnavailable).json({ message: "GHL_PIT_TOKEN / GHL_LOCATION_ID sin configurar." });
    return;
  }
  const [calendarios, produccion] = await Promise.all([ghlService.getCalendars(), crmProductionSyncService.calendariosDeProduccion()]);
  const idsProduccion = new Set(produccion.map((c) => c.id).filter(Boolean));
  res.json({
    configurados: crmProductionSyncService.configuracionCalendarios(),
    noEncontrados: produccion.filter((c) => !c.id).map((c) => c.nombre),
    webhookConfigurado: Boolean(process.env.GHL_PRODUCTION_WEBHOOK_SECRET || process.env.GHL_BOOKING_WEBHOOK_SECRET),
    calendarios: calendarios.map((c) => ({ id: c.id, nombre: c.name, esDeProduccion: idsProduccion.has(c.id) })),
  });
}

/** POST /admin/crm/production-sync — corre la reconciliacion a mano. */
export async function runCrmProductionSync(_req: Request, res: Response): Promise<void> {
  try {
    const result = await crmProductionSyncService.sincronizarDesdeCrm();
    res.json({ ok: true, ...result });
  } catch (err: any) {
    res.status(HttpStatusCode.InternalServerError).json({ ok: false, error: err.message });
  }
}
