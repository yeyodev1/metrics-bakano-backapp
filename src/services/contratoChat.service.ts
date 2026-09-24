import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";

/**
 * El contrato se llena por el chat y se firma en una sola pantalla.
 *
 * Antes el cliente entraba a Metrics, escribia sus datos en un formulario
 * largo, firmaba y ademas agendaba una reunion, todo en la misma pagina. Se
 * caia en el primer paso. Ahora los datos se piden por Telegram —donde ya
 * esta hablando— y el link que recibe abre unicamente la firma.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";

export type CampoContrato = "rucCliente" | "nombreCliente" | "representanteCliente" | "email";

export const CAMPOS_CONTRATO: CampoContrato[] = ["rucCliente", "nombreCliente", "representanteCliente", "email"];

export const PREGUNTA_CONTRATO: Record<CampoContrato, string> = {
  rucCliente:
    "Vamos con tu contrato 📝\n\nPrimero: ¿cuál es tu <b>RUC o cédula</b>?\n\nEscríbelo solo con números.",
  nombreCliente:
    "¿A nombre de quién va el contrato? Escribe tu <b>nombre o razón social</b>, tal como aparece en el RUC.",
  representanteCliente:
    "¿Quién es el <b>representante legal</b>? Nombre completo, como va a firmar.",
  email: "¿A qué <b>correo</b> te mandamos el contrato firmado?",
};

export const ETIQUETA_CONTRATO: Record<CampoContrato, string> = {
  rucCliente: "RUC o cédula",
  nombreCliente: "Nombre o razón social",
  representanteCliente: "Representante legal",
  email: "Correo para el contrato",
};

const CORREO_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

class ContratoChatService {
  /** Lo que ya tiene guardado del contrato, aunque no lo haya firmado. */
  async datos(workspaceId: Types.ObjectId | string): Promise<Record<string, any>> {
    const w = await models.workspaces.findById(workspaceId).select("contractData onboardingStatus").lean();
    return ((w as any)?.contractData || {}) as Record<string, any>;
  }

  async firmado(workspaceId: Types.ObjectId | string): Promise<boolean> {
    const w = await models.workspaces.findById(workspaceId).select("onboardingStatus").lean();
    return Boolean((w as any)?.onboardingStatus?.contractSubmitted);
  }

  /** Campos que todavia faltan, en orden. */
  async faltantes(workspaceId: Types.ObjectId | string): Promise<CampoContrato[]> {
    const datos = await this.datos(workspaceId);
    return CAMPOS_CONTRATO.filter((c) => !String(datos[c] ?? "").trim());
  }

  /** Valida y guarda un dato del contrato. */
  async guardar(chat: ITelegramChat, campo: string, valor: string): Promise<{ ok: boolean; motivo?: string }> {
    if (!CAMPOS_CONTRATO.includes(campo as CampoContrato)) return { ok: false, motivo: "campo_desconocido" };
    let limpio = String(valor || "").trim();

    if (campo === "rucCliente") {
      const digitos = limpio.replace(/\D/g, "");
      if (digitos.length < 10 || digitos.length > 13) {
        return { ok: false, motivo: "El RUC tiene 13 números y la cédula 10. Revísalo y mándamelo de nuevo." };
      }
      limpio = digitos;
    } else if (campo === "email") {
      limpio = limpio.toLowerCase();
      if (!CORREO_RE.test(limpio)) return { ok: false, motivo: "Ese correo no se ve bien. Escríbelo completo, por ejemplo nombre@empresa.com" };
    } else {
      if (limpio.length < 3) return { ok: false, motivo: "Necesito el nombre completo." };
      limpio = limpio.slice(0, 160);
    }

    // contractData es un campo libre: se crea vacio si el entorno es nuevo.
    await models.workspaces.updateOne(
      { _id: chat.workspaceId, $or: [{ contractData: null }, { contractData: { $exists: false } }] },
      { $set: { contractData: {} } }
    );
    await models.workspaces.updateOne({ _id: chat.workspaceId }, { $set: { [`contractData.${campo}`]: limpio } });
    return { ok: true };
  }

  /** El link que abre solo la pantalla de firma. */
  link(workspaceId: Types.ObjectId | string): string {
    return `${APP_URL}/onboarding/${workspaceId}`;
  }

  /** Resumen de lo cargado, para confirmarlo antes de mandar el link. */
  async resumen(workspaceId: Types.ObjectId | string): Promise<string> {
    const datos = await this.datos(workspaceId);
    return CAMPOS_CONTRATO.map((c) => `• <b>${ETIQUETA_CONTRATO[c]}:</b> ${datos[c] || "—"}`).join("\n");
  }
}

export const contratoChatService = new ContratoChatService();
