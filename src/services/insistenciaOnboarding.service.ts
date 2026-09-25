import { Types } from "mongoose";
import models from "../models";
import { telegramService } from "./telegram.service";
import { slackService } from "./slack.service";
import { contratoChatService } from "./contratoChat.service";
import { onboardingDatosService } from "./onboardingDatos.service";
import { onboardingBotService } from "./onboardingBot.service";

/**
 * Insistir con lo que solo puede hacer el cliente.
 *
 * El onboarding se traba casi siempre en el mismo lugar: cuatro datos del
 * contrato y nueve preguntas de marca que nadie puede contestar por el. Y
 * mientras eso no pasa, no hay guiones, no hay produccion y no hay campaña.
 *
 * Un recordatorio al dia es demasiado poco para algo que toma quince minutos.
 * Se insiste varias veces en el dia, diciendole con nombre y apellido que su
 * proceso esta detenido ahi y que se alarga por cada dia que pasa. Se corta
 * solo cuando ya no falta nada suyo.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
/** Entre un mensaje y el siguiente. El cron corre cada 3 horas laborales. */
const ESPERA_MS = 3.5 * 3_600_000;
/** Cuando llega a esto, el equipo tiene que levantar el telefono. */
const DIAS_PARA_ESCALAR = 3;

export interface Pendiente {
  clave: string;
  texto: string;
  boton: { text: string; callback_data?: string; url?: string };
}

class InsistenciaOnboardingService {
  /** Lo que depende del cliente y sigue sin hacerse. */
  async pendientesDelCliente(workspaceId: Types.ObjectId | string): Promise<Pendiente[]> {
    const lista: Pendiente[] = [];

    const contrato = await contratoChatService.estado(workspaceId).catch(() => null);
    if (contrato && !contrato.completo) {
      lista.push(
        contrato.faltan.length
          ? {
              clave: "contratoDatos",
              texto: `los ${contrato.faltan.length} datos que faltan de tu contrato`,
              boton: { text: `📝 Llenar mi contrato (${contrato.faltan.length})`, callback_data: "contrato:estado" },
            }
          : {
              clave: "contratoFirma",
              texto: "firmar tu contrato",
              boton: { text: "✍️ Leer y firmar mi contrato", url: contratoChatService.link(workspaceId) },
            }
      );
    }

    const datos = await onboardingDatosService.pendientes(workspaceId as Types.ObjectId).catch(() => null);
    const faltanMarca = (datos?.datosMarcaFaltantes || []).filter(
      (d: any) => d.campo !== "trafficDirection" && d.campo !== "trafficLink"
    );
    if (faltanMarca.length) {
      lista.push({
        clave: "datosMarca",
        texto: `contarme ${faltanMarca.length} cosas de tu negocio`,
        boton: { text: `✍️ Contarte de mi negocio (${faltanMarca.length})`, callback_data: "datos:contar" },
      });
    }

    const estado = await onboardingBotService.estado(workspaceId as Types.ObjectId).catch(() => null);
    const siguiente = estado?.sesiones.find((s: any) => s.sesion === estado.siguiente);
    if (siguiente) {
      lista.push({
        clave: `sesion:${siguiente.sesion}`,
        texto: `agendar tu ${siguiente.etiqueta.toLowerCase()}`,
        boton: { text: `📅 Agendar ${siguiente.etiqueta}`, callback_data: `onb:${siguiente.sesion}` },
      });
    }

    return lista;
  }

  /** El texto, mas duro con cada dia que pasa. */
  private mensaje(nombre: string, pendientes: Pendiente[], dias: number): string {
    const lista = pendientes.map((p) => `• ${p.texto}`).join("\n");
    const saludo = nombre ? `${nombre}, ` : "";

    if (dias <= 0) {
      return (
        `${saludo}tu proceso arranca <b>hoy</b> 🚀\n\n` +
        `Para poder empezar me falta esto, y es lo único que depende de ti:\n${lista}\n\n` +
        "Son <b>quince minutos aquí mismo</b>, por chat. Apenas lo tengas, tu equipo se pone a trabajar en tus guiones."
      );
    }
    if (dias === 1) {
      return (
        `${saludo}hagámoslo <b>hoy</b> 🙏\n\n` +
        `Tu proceso está detenido esperando esto:\n${lista}\n\n` +
        "Mientras no lo tengamos, <b>nadie puede empezar tus guiones ni agendar tu producción</b>. " +
        "Son quince minutos y desbloqueas todo."
      );
    }
    if (dias < DIAS_PARA_ESCALAR) {
      return (
        `${saludo}van <b>${dias} días</b> y tu proceso sigue parado ⏳\n\n` +
        `Falta únicamente esto, y solo lo puedes hacer tú:\n${lista}\n\n` +
        "Cada día que pasa es un día más para que tus videos salgan. " +
        "<b>Hagámoslo hoy</b> y mañana tu equipo ya está escribiendo."
      );
    }
    return (
      `${saludo}llevamos <b>${dias} días</b> esperándote ⚠️\n\n` +
      `Tu proceso está <b>completamente detenido</b> por esto:\n${lista}\n\n` +
      "No es un trámite: sin esto no hay guiones, no hay producción y no hay campaña. " +
      "Tu cronograma se está alargando y no es por nosotros.\n\n" +
      "Si algo te está trabando, <b>dímelo ahora mismo</b> y lo resolvemos juntos en este chat."
    );
  }

  /**
   * Revisa todos los entornos activos y le escribe a quien tenga algo suyo
   * pendiente. Solo a los que ya estan en el chat: al que no conecto el bot
   * se le insiste por correo desde otro lado.
   */
  async insistir(): Promise<{ revisados: number; avisados: number; escalados: number }> {
    const chats = await models.telegramChats.find({ estado: "listo" }).select("chatId workspaceId userId").lean();
    let avisados = 0;
    let escalados = 0;

    for (const chat of chats as any[]) {
      if (!chat.workspaceId) continue;
      const workspace: any = await models.workspaces
        .findOne({ _id: chat.workspaceId, isActive: true })
        .select("name createdAt insistenciaOnboarding")
        .lean();
      if (!workspace) continue;

      const pendientes = await this.pendientesDelCliente(workspace._id);
      if (!pendientes.length) continue;

      const estado = workspace.insistenciaOnboarding || {};
      const ultimo = estado.ultimoEn ? new Date(estado.ultimoEn).getTime() : 0;
      if (Date.now() - ultimo < ESPERA_MS) continue;

      const dias = Math.floor((Date.now() - new Date(workspace.createdAt).getTime()) / 86_400_000);
      const usuario: any = chat.userId ? await models.users.findById(chat.userId).select("name").lean() : null;
      const nombre = usuario?.name ? String(usuario.name).trim().split(/\s+/)[0] : "";

      const botones = pendientes.map((p) => [p.boton]);
      botones.push([{ text: "💬 Necesito ayuda con esto", callback_data: "menu:atencion" }]);

      await telegramService
        .sendMessage(chat.chatId, this.mensaje(nombre, pendientes, dias), botones as any)
        .catch((error: any) => console.error("[Insistencia] no se pudo escribir:", error?.message || error));

      const veces = Number(estado.veces || 0) + 1;
      await models.workspaces.updateOne(
        { _id: workspace._id },
        { $set: { "insistenciaOnboarding.ultimoEn": new Date(), "insistenciaOnboarding.veces": veces } }
      );
      avisados++;

      // A los tres dias esto deja de ser cosa del bot: alguien tiene que llamar.
      if (dias >= DIAS_PARA_ESCALAR && !estado.escaladoEn) {
        await slackService
          .avisarEquipo({
            titulo: `⚠️ ${workspace.name} lleva ${dias} días sin completar su onboarding`,
            detalle:
              `Le falta: ${pendientes.map((p) => p.texto).join(", ")}.\n\n` +
              `Ya se le insistió ${veces} veces por el bot y no avanza. Esto necesita una llamada.\n\n` +
              `${APP_URL}/onboarding`,
            correos: ["gbenalcazar@bakano.ec"],
          })
          .catch(() => undefined);
        await models.workspaces.updateOne(
          { _id: workspace._id },
          { $set: { "insistenciaOnboarding.escaladoEn": new Date() } }
        );
        escalados++;
      }
    }

    return { revisados: chats.length, avisados, escalados };
  }

  /** Para empujar a un cliente puntual sin esperar al reloj. */
  async insistirAhora(workspaceId: Types.ObjectId | string): Promise<{ ok: boolean; pendientes: number }> {
    await models.workspaces.updateOne({ _id: workspaceId }, { $unset: { "insistenciaOnboarding.ultimoEn": "" } });
    const pendientes = await this.pendientesDelCliente(workspaceId);
    if (!pendientes.length) return { ok: false, pendientes: 0 };
    const r = await this.insistir();
    return { ok: r.avisados > 0, pendientes: pendientes.length };
  }
}

export const insistenciaOnboardingService = new InsistenciaOnboardingService();
