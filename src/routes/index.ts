import express, { Application } from "express";
import authRouter from "./auth.router";
import workspaceRouter from "./workspace.router";
import metaRouter from "./meta.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
  router.use("/workspaces", workspaceRouter);
  router.use("/meta", metaRouter);
}

export default routerApi;
