import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthService } from "../services/auth.service";

const authService = new AuthService();

export async function login(req: Request, res: Response, next: NextFunction) {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Email and password are required.",
      });
      return;
    }

    const authData = await authService.login(email, password);

    res.status(HttpStatusCode.Ok).send({
      message: "Login successfully.",
      user: authData.user,
      token: authData.token,
    });
    return;
  } catch (error: any) {
    console.error("Login Error:", error);

    if (error.message === "Invalid credentials") {
      res.status(HttpStatusCode.Unauthorized).send({
        message: "Invalid credentials.",
      });
      return;
    }

    res.status(HttpStatusCode.InternalServerError).send({
      message: "An internal server error occurred while logging in.",
    });
    return;
  }
}

export async function getMe(req: Request, res: Response, next: NextFunction) {
  try {
    const userId = (req as any).user?._id;
    if (!userId) {
      res.status(HttpStatusCode.Unauthorized).send({
        message: "Unauthorized.",
      });
      return;
    }

    const user = await authService.me(userId);

    res.status(HttpStatusCode.Ok).send({
      message: "User profile retrieved successfully.",
      user,
    });
    return;
  } catch (error: any) {
    console.error("GetMe Error:", error);

    res.status(HttpStatusCode.InternalServerError).send({
      message: "An internal server error occurred.",
    });
    return;
  }
}
