import express, { Application } from "express";
import authRouter from "./auth.router";
import workspaceRouter from "./workspace.router";
import metaRouter from "./meta.router";
import adminRouter from "./admin.router";
import planningRouter from "./planning.router";
import surveyRouter from "./survey.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
  router.use("/workspaces", workspaceRouter);
  router.use("/meta", metaRouter);
  router.use("/admin", adminRouter);
  router.use("/planning", planningRouter);
  router.use("/surveys", surveyRouter);
}

export default routerApi;

