import type { Request, Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthService, MIN_PASSWORD_LENGTH } from "../services/auth.service";
import { resendService } from "../services/resend.service";

const authService = new AuthService();

const APP_URL = "https://metrics.bakano.ec";
const RESET_TTL_MINUTES = 60;

/**
 * La misma respuesta exista o no el correo.
 *
 * Si dijéramos "ese correo no está registrado", cualquiera podría probar
 * direcciones contra el formulario y averiguar quién es cliente de Bakano.
 */
const RESPUESTA_NEUTRA = {
  message:
    "Si ese correo tiene una cuenta, te enviamos un enlace para restablecer la contraseña.",
};

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

export async function forgotPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { email } = req.body as { email?: string };

    if (!email || !email.includes("@")) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Escribe un correo válido.",
      });
      return;
    }

    const solicitud = await authService.requestPasswordReset(email);

    // Correo desconocido o cuenta desactivada: se responde igual y no se manda
    // nada. Quien pregunta no puede distinguir un caso del otro.
    if (!solicitud) {
      res.status(HttpStatusCode.Ok).send(RESPUESTA_NEUTRA);
      return;
    }

    await resendService.sendPasswordResetEmail({
      to: solicitud.user.email,
      recipientName: solicitud.user.name,
      resetUrl: `${APP_URL}/restablecer-contrasena/${solicitud.token}`,
      expiresInMinutes: RESET_TTL_MINUTES,
    });

    res.status(HttpStatusCode.Ok).send(RESPUESTA_NEUTRA);
    return;
  } catch (error: any) {
    console.error("ForgotPassword Error:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "No pudimos enviar el correo. Intenta de nuevo en un momento.",
    });
    return;
  }
}

/** Permite mostrar "este enlace venció" antes de pedir la contraseña nueva. */
export async function verifyResetToken(req: Request, res: Response, next: NextFunction) {
  try {
    const token = req.params["token"] as string;
    const datos = await authService.verifyResetToken(token);

    if (!datos) {
      res.status(HttpStatusCode.NotFound).send({
        message: "Este enlace ya venció o se usó. Pide uno nuevo.",
        valid: false,
      });
      return;
    }

    res.status(HttpStatusCode.Ok).send({ valid: true, email: datos.email });
    return;
  } catch (error: any) {
    console.error("VerifyResetToken Error:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "No pudimos verificar el enlace.",
      valid: false,
    });
    return;
  }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const { token, password } = req.body as { token?: string; password?: string };

    if (!token || !password) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Falta el enlace o la contraseña.",
      });
      return;
    }

    if (password.length < MIN_PASSWORD_LENGTH) {
      res.status(HttpStatusCode.BadRequest).send({
        message: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      });
      return;
    }

    await authService.resetPassword(token, password);

    res.status(HttpStatusCode.Ok).send({
      message: "Listo, tu contraseña quedó cambiada. Ya puedes iniciar sesión.",
    });
    return;
  } catch (error: any) {
    if (error.message === "Invalid or expired token") {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Este enlace ya venció o se usó. Pide uno nuevo.",
      });
      return;
    }

    if (error.message === "Password too short") {
      res.status(HttpStatusCode.BadRequest).send({
        message: `La contraseña necesita al menos ${MIN_PASSWORD_LENGTH} caracteres.`,
      });
      return;
    }

    console.error("ResetPassword Error:", error);
    res.status(HttpStatusCode.InternalServerError).send({
      message: "No pudimos cambiar la contraseña. Intenta de nuevo.",
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
