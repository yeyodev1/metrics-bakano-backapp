import { Router } from "express";
import {
  login,
  getMe,
  forgotPassword,
  verifyResetToken,
  resetPassword,
} from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

const authRouter = Router();

authRouter.post("/login", login);
authRouter.get("/me", authMiddleware, getMe);

// Recuperación de contraseña. Las tres son públicas por definición: quien las
// usa es justamente alguien que no puede entrar.
authRouter.post("/forgot-password", forgotPassword);
authRouter.get("/reset-password/:token", verifyResetToken);
authRouter.post("/reset-password", resetPassword);

export default authRouter;
