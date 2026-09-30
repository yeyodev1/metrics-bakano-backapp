import { Types } from "mongoose";
import models from "../models";
import { slackService } from "./slack.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";

/**
 * Grabar antes de tiempo.
 *
 * La frecuencia de produccion (6 meses por defecto, ajustable por cliente) es
 * un punto de partida, no un absoluto. Si el cliente necesita grabar antes, el
 * bot no le dice que no: le pasa la solicitud a contenido (Ariana), que decide
 * segun la estrategia. Hasta que ella responda se le vuelve a recordar cada
 * dia, y el cliente se entera apenas decide.
 */

/** Cada cuanto se le recuerda a contenido una solicitud sin respuesta. */
const RECORDAR_CADA_MS = 24 * 3_600_000;
/** Cuanto dura la ventana cuando se aprueba: tiempo para elegir horario. */
const DIAS_VENTANA_APROBADA = 30;

export interface SolicitudProduccion {
  en: Date;
  motivo: string;
  porNombre?: string;
  recordadaEn?: Date;
}

class ProduccionAnticipadaService {
  private async avisarContenido(workspaceId: Types.ObjectId | string, nombre: string, s: SolicitudProduccion, recordatorio: boolean) {
    const correos = equipoAtencionService.correos("guiones");
    const titulo = recordatorio
      ? `⏰ Sigue esperando respuesta: ${nombre} quiere grabar antes de tiempo`
      : `🎬 ${nombre} quiere grabar antes de tiempo`;
    const detalle =
      `Motivo: ${s.motivo}\n` +
      `Lo pidió ${s.porNombre || "el cliente"}. Decide desde Claude con responder_produccion_antes (aprobar o no). ` +
      "Hasta que respondas, el cliente espera y esto se te recuerda cada día.";
    const usuarios = await models.users.find({ email: { $in: correos }, isActive: { $ne: false } }).select("_id").lean();
    await Promise.all([
      ...usuarios.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle, { workspaceId: new Types.ObjectId(String(workspaceId)) })
      ),
      slackService.avisarEquipo({ titulo, detalle, correos }).catch(() => false),
    ]);
  }

  /** El cliente (o el equipo por el) pide grabar antes de lo que le toca. */
  async solicitar(workspaceId: Types.ObjectId | string, motivo: string, porNombre?: string): Promise<{ ok: boolean; yaPendiente?: boolean }> {
    const ws: any = await models.workspaces.findById(workspaceId).select("name produccion").lean();
    if (!ws) return { ok: false };
    if (ws.produccion?.solicitud?.en) return { ok: true, yaPendiente: true };
    const solicitud: SolicitudProduccion = { en: new Date(), motivo: motivo.trim().slice(0, 500) || "Sin motivo", porNombre, recordadaEn: new Date() };
    await models.workspaces.updateOne({ _id: ws._id }, { $set: { "produccion.solicitud": solicitud } });
    await this.avisarContenido(ws._id, ws.name, solicitud, false).catch((e) => console.error("[Producción antes] aviso:", e?.message || e));
    return { ok: true };
  }

  /** Las solicitudes que esperan respuesta. */
  async pendientes(): Promise<{ workspaceId: string; cliente: string; solicitud: SolicitudProduccion }[]> {
    const lista: any[] = await models.workspaces
      .find({ "produccion.solicitud.en": { $exists: true } })
      .select("name produccion.solicitud")
      .lean();
    return lista
      .map((w) => ({ workspaceId: String(w._id), cliente: w.name, solicitud: w.produccion.solicitud }))
      .sort((a, b) => new Date(a.solicitud.en).getTime() - new Date(b.solicitud.en).getTime());
  }

  /**
   * Contenido decide. Si aprueba, se abre la ventana para agendar ya; si no,
   * se le explica al cliente. En los dos casos el cliente se entera por el bot.
   */
  async responder(
    workspaceId: Types.ObjectId | string,
    aprobar: boolean,
    quien: { nombre: string },
    mensaje?: string
  ): Promise<{ ok: boolean; motivo?: string; hasta?: Date }> {
    const ws: any = await models.workspaces.findById(workspaceId).select("name produccion").lean();
    if (!ws) return { ok: false, motivo: "sin_entorno" };
    const set: Record<string, unknown> = {};
    let hasta: Date | undefined;
    if (aprobar) {
      hasta = new Date(Date.now() + DIAS_VENTANA_APROBADA * 86_400_000);
      set["produccion.excepcionHasta"] = hasta;
      set["produccion.excepcionPorNombre"] = quien.nombre;
      set["produccion.excepcionMotivo"] = ws.produccion?.solicitud?.motivo || mensaje || "Grabar antes por estrategia";
    }
    await models.workspaces.updateOne({ _id: ws._id }, { ...(Object.keys(set).length ? { $set: set } : {}), $unset: { "produccion.solicitud": "" } });

    const { telegramService } = await import("./telegram.service");
    const chats = await models.telegramChats.find({ workspaceId: ws._id, estado: "listo" }).select("chatId").lean();
    const nota = mensaje?.trim() ? `\n\n💬 ${mensaje.trim().replace(/</g, "&lt;")}` : "";
    const texto = aprobar
      ? `🎬 <b>¡Listo! ${quien.nombre.split(" ")[0]} aprobó que grabes antes.</b>${nota}\n\nYa puedes agendar tu producción 👇`
      : `🎬 Sobre tu pedido de grabar antes: por ahora <b>no hace falta adelantar la producción</b>.${nota}\n\nSi algo cambia, cuéntame y lo volvemos a ver.`;
    const botones = aprobar
      ? [[{ text: "🎬 Agendar mi producción", callback_data: "ag:produccion" }], [{ text: "📋 Ver menú", callback_data: "menu:ver" }]]
      : [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]];
    for (const c of chats as any[]) {
      await telegramService.sendMessage(c.chatId, texto, botones).catch((e: any) => console.error("[Producción antes] Telegram:", e?.message || e));
    }
    return { ok: true, hasta };
  }

  /** Cron diario: lo que sigue sin respuesta se le vuelve a recordar a contenido. */
  async recordarPendientes(): Promise<{ pendientes: number; recordadas: number }> {
    const lista = await this.pendientes();
    let recordadas = 0;
    for (const p of lista) {
      const ultima = p.solicitud.recordadaEn ? new Date(p.solicitud.recordadaEn).getTime() : 0;
      if (Date.now() - ultima < RECORDAR_CADA_MS - 3_600_000) continue;
      await this.avisarContenido(p.workspaceId, p.cliente, p.solicitud, true).catch(() => undefined);
      await models.workspaces.updateOne({ _id: new Types.ObjectId(p.workspaceId) }, { $set: { "produccion.solicitud.recordadaEn": new Date() } });
      recordadas++;
    }
    return { pendientes: lista.length, recordadas };
  }
}

export const produccionAnticipadaService = new ProduccionAnticipadaService();
