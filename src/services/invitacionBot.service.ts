import { Types } from "mongoose";
import models from "../models";
import { resendService } from "./resend.service";

/**
 * Invitacion al bot al entrar a un entorno.
 *
 * El flujo cambio: lo que antes se hacia entrando a Metrics ahora se resuelve
 * por chat. Asi que a quien sumamos a un entorno le llega la invitacion al
 * bot en el momento, sin que nadie se acuerde de mandarla.
 *
 * Dos cuidados: al equipo de Bakano no se le escribe (el bot es para
 * clientes), y si el entorno acaba de mandar su correo de bienvenida del
 * onboarding no se duplica, porque ese correo ya explica el bot.
 */

const BOT_URL = process.env.TELEGRAM_BOT_URL || "https://t.me/BakanoAgencyBot";
/** Si la bienvenida salio hace menos de esto, ese correo ya cubre la invitacion. */
const MARGEN_BIENVENIDA_MS = 10 * 60_000;

class InvitacionBotService {
  /**
   * Le manda la invitacion al bot. No bloquea ni revienta nada: si falla, se
   * anota y el cron de recordatorios lo vuelve a intentar.
   */
  async invitar(
    userId: Types.ObjectId | string,
    workspaceIds: (Types.ObjectId | string)[],
    opciones: { forzar?: boolean } = {}
  ): Promise<boolean> {
    try {
      const user = await models.users
        .findById(userId)
        .select("name email isInternal isActive presentacionBotEnviadaEn")
        .lean();
      if (!user?.email || !user.isActive) return false;
      if (user.isInternal || user.email.toLowerCase().endsWith("@bakano.ec")) return false;
      // Forzado = lo pidió una persona desde el panel: ahí se manda igual,
      // aunque ya se le haya escrito antes.
      if (!opciones.forzar && (user as any).presentacionBotEnviadaEn) return false;

      const entornos = await models.workspaces
        .find({ _id: { $in: workspaceIds.filter(Boolean) }, isActive: true })
        .select("name onboardingBienvenidaEnviadaEn")
        .lean();
      if (!entornos.length) return false;

      // Si la bienvenida del onboarding acaba de salir, ese correo ya le
      // explica el bot: dos correos seguidos diciendo lo mismo es ruido.
      const reciente = entornos.some((w: any) => {
        const en = w.onboardingBienvenidaEnviadaEn ? new Date(w.onboardingBienvenidaEnviadaEn).getTime() : 0;
        return en && Date.now() - en < MARGEN_BIENVENIDA_MS;
      });
      if (reciente && !opciones.forzar) {
        console.log(`[Bot] invitacion omitida para ${user.email}: la bienvenida del onboarding ya salio`);
        return false;
      }

      await resendService.sendPresentacionBot({
        to: user.email,
        recipientName: user.name,
        workspaceName: entornos[0]!.name,
        botUrl: BOT_URL,
        correoCliente: user.email,
      });
      const ahora = new Date();
      await models.users.updateOne({ _id: userId }, { $set: { presentacionBotEnviadaEn: ahora, presentacionBotUltimoEn: ahora } });
      console.log(`[Bot] invitacion enviada a ${user.email} (${entornos[0]!.name})`);
      return true;
    } catch (error: any) {
      console.error("[Bot] no se pudo invitar:", error?.message || error);
      return false;
    }
  }

  /**
   * A mano desde el panel: se manda aunque ya se le haya escrito, y se usa
   * cualquier entorno activo suyo. Devuelve el motivo si no se pudo.
   */
  async reenviar(userId: Types.ObjectId | string): Promise<{ ok: boolean; motivo?: string; email?: string }> {
    const user = await models.users.findById(userId).select("email isInternal isActive workspaceId workspaces").lean();
    if (!user) return { ok: false, motivo: "no_encontrado" };
    if (!user.isActive) return { ok: false, motivo: "inactivo" };
    if (user.isInternal || String(user.email || "").toLowerCase().endsWith("@bakano.ec")) {
      return { ok: false, motivo: "es_del_equipo" };
    }
    const entornos = [user.workspaceId, ...((user.workspaces || []) as any[]).map((w) => w.workspaceId?._id ?? w.workspaceId)].filter(Boolean);
    if (!entornos.length) return { ok: false, motivo: "sin_entorno" };

    const ok = await this.invitar(userId, entornos as any[], { forzar: true });
    return ok ? { ok: true, email: user.email } : { ok: false, motivo: "no_se_pudo_enviar" };
  }

  /** Version que no espera: para llamarla desde el alta de un usuario. */
  invitarEnSegundoPlano(userId: Types.ObjectId | string, workspaceIds: (Types.ObjectId | string)[]): void {
    this.invitar(userId, workspaceIds).catch(() => undefined);
  }
}

export const invitacionBotService = new InvitacionBotService();
