import express, { Application } from "express";
import authRouter from "./auth.router";
import workspaceRouter from "./workspace.router";
import metaRouter from "./meta.router";
import adminRouter from "./admin.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
  router.use("/workspaces", workspaceRouter);
  router.use("/meta", metaRouter);
  router.use("/admin", adminRouter);
}

export default routerApi;

