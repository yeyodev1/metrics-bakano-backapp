import { Router } from "express";
import { handleMetaSchedulingWebhook } from "../controllers/webhook.controller";

export const webhookRouter = Router();

webhookRouter.post("/meta-scheduling", handleMetaSchedulingWebhook);
