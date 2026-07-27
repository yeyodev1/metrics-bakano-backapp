import { Router } from "express";
import { handleMetaSchedulingWebhook } from "../controllers/webhook.controller";
import { handleGhlSalesAppointment } from "../controllers/ghlBookingWebhook.controller";

export const webhookRouter = Router();

webhookRouter.post("/meta-scheduling", handleMetaSchedulingWebhook);
webhookRouter.post("/ghl/sales-appointment", handleGhlSalesAppointment);
