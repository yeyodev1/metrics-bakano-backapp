import express, { Application } from "express";
import authRouter from "./auth.router";

function routerApi(app: Application) {
  const router = express.Router();
  app.use("/api", router);

  router.use("/auth", authRouter);
}

export default routerApi;
