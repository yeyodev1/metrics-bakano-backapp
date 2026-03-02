import express, { Application } from "express";
import authRouter from "./auth.router";
import workspaceRouter from "./workspace.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
  router.use("/workspaces", workspaceRouter);
}

export default routerApi;
