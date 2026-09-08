import { Router } from "express";
import { handleMetaSchedulingWebhook } from "../controllers/webhook.controller";
import { handleGhlSalesAppointment } from "../controllers/ghlBookingWebhook.controller";
import { handleGhlProductionAppointment } from "../controllers/ghlProductionWebhook.controller";

export const webhookRouter = Router();

webhookRouter.post("/meta-scheduling", handleMetaSchedulingWebhook);
webhookRouter.post("/ghl/sales-appointment", handleGhlSalesAppointment);
// Produccion agendada, movida o cancelada desde el link del CRM
webhookRouter.post("/ghl/production-appointment", handleGhlProductionAppointment);
