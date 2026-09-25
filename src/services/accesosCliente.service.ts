import type { ITelegramChat } from "../models/telegramChat.model";
import models from "../models";
import { AuthService } from "./auth.service";
import { resendService } from "./resend.service";
import axios from "axios";

/**
 * Contraseñas y accesos, desde el chat.
 *
 * El cliente no pierde una contraseña: pierde dos, la de Metrics y la de
 * Bakanology, y son distintas. Cuando pregunta, la respuesta util no es
 * "entra a la web y busca el link": es mandarle el correo de recuperacion en
 * el momento.
 *
 * Lo que NO se hace, a proposito: decirle una contraseña por el chat. Ni las
 * guardamos en claro ni tendria sentido mandarlas por un canal que puede
 * quedar abierto en un celular prestado. El correo de recuperacion llega solo
 * a su bandeja, que es donde tiene que estar.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const BAKANOLOGY_API = (process.env.BAKANOLOGY_API_URL || "https://bakanology-backapp.vercel.app").replace(/\/$/, "");
const BAKANOLOGY_WEB = process.env.BAKANOLOGY_URL || "https://bakanology.com";

export type Plataforma = "metrics" | "bakanology";

const authService = new AuthService();

class AccesosClienteService {
  /** El correo con el que entra a las dos plataformas. */
  async correoDe(chat: ITelegramChat): Promise<string | null> {
    if (!chat.userId) return null;
    const user = await models.users.findById(chat.userId).select("email name").lean();
    return (user as any)?.email || null;
  }

  /** Manda el correo para crear una contraseña nueva. Nunca manda la actual. */
  async recuperar(chat: ITelegramChat, plataforma: Plataforma): Promise<{ ok: boolean; correo?: string; motivo?: string }> {
    const correo = await this.correoDe(chat);
    if (!correo) return { ok: false, motivo: "sin_correo" };

    if (plataforma === "metrics") {
      const solicitud = await authService.requestPasswordReset(correo).catch(() => null);
      // Cuenta desconocida o desactivada: se responde igual, sin decir cual es.
      if (!solicitud) return { ok: true, correo };
      try {
        await resendService.sendPasswordResetEmail({
          to: correo,
          recipientName: solicitud.user?.name,
          resetUrl: `${APP_URL}/restablecer-contrasena/${solicitud.token}`,
          expiresInMinutes: 60,
        });
        return { ok: true, correo };
      } catch (error: any) {
        console.error("[Accesos] correo de Metrics:", error?.message || error);
        return { ok: false, motivo: "no_se_pudo_enviar" };
      }
    }

    const r = await axios
      .post(`${BAKANOLOGY_API}/api/auth/forgot-password`, { email: correo }, { timeout: 15_000, validateStatus: () => true })
      .catch((error: any) => {
        console.error("[Accesos] correo de Bakanology:", error.message);
        return null;
      });

    if (r && r.status >= 200 && r.status < 300) return { ok: true, correo };

    // Todavia no tiene cuenta en la academia: en vez de dejarlo con un error,
    // se le crea ahi mismo y le llega el correo con sus datos.
    if (r && r.status === 404) {
      const { bakanologyService } = await import("./bakanology.service");
      const creada = await bakanologyService.darAcceso({ email: correo });
      return creada ? { ok: true, correo, motivo: "cuenta_creada" } : { ok: false, motivo: "no_se_pudo_enviar" };
    }

    console.error("[Accesos] Bakanology respondió:", r?.status, r?.data);
    return { ok: false, motivo: "no_se_pudo_enviar" };
  }

  /** Dónde entra a cada cosa, para decírselo sin que pregunte dos veces. */
  enlaces() {
    return {
      metrics: `${APP_URL}/login`,
      bakanology: `${BAKANOLOGY_WEB}/login`,
      bakanologyRecuperar: `${BAKANOLOGY_WEB}/recuperar-contrasena`,
    };
  }
}

export const accesosClienteService = new AccesosClienteService();
