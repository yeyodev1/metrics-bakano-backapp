import express, { Application } from "express";
import authRouter from "./auth.router";
import workspaceRouter from "./workspace.router";
import metaRouter from "./meta.router";
import adminRouter from "./admin.router";
import planningRouter from "./planning.router";
import surveyRouter from "./survey.router";
import { planningEntriesRouter, videoPlanningRouter } from "./videoPlanning.router";
import clientMeetingRouter from "./clientMeeting.router";
import notificationRouter from "./notification.router";
import billingRouter from "./billing.router";
import teamKpiRouter from "./teamKpi.router";
import visitLogRouter from "./visitLog.router";
import changelogRouter from "./changelog.router";
import salesSummaryRouter from "./salesSummary.router";
import cronRouter from "./cron.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
  router.use("/workspaces", workspaceRouter);
  router.use("/meta", metaRouter);
  router.use("/admin", adminRouter);
  router.use("/planning", planningRouter);
  router.use("/surveys", surveyRouter);
  router.use("/planning-entries", planningEntriesRouter);
  router.use("/video-planning", videoPlanningRouter);
  router.use("/meetings", clientMeetingRouter);
  router.use("/notifications", notificationRouter);
  router.use("/billing", billingRouter);
  router.use("/team-kpis", teamKpiRouter);
  router.use("/visit-logs", visitLogRouter);
  router.use("/changelog", changelogRouter);
  router.use("/sales-summary", salesSummaryRouter);
  router.use("/cron", cronRouter);
}

export default routerApi;

