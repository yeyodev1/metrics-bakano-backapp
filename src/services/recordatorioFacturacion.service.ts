import { Types } from "mongoose";
import models from "../models";
import { telegramService, type InlineButton } from "./telegram.service";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";

/**
 * Recordatorio diario de facturacion por Telegram.
 *
 * Sin la facturacion del dia el ROAS es una adivinanza: no se sabe si las
 * campanas estan trayendo plata. El correo diario existe hace rato, pero el
 * cliente vive en el chat, asi que aqui se lo recuerda por ahi, con el link
 * de SU entorno. A los 3 dias deja de ser un olvido y el equipo se entera.
 *
 * Solo clientes: los chats del equipo de Bakano no reciben nada.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
/** A partir de aqui ya no es un olvido: se avisa al equipo. */
const DIAS_PARA_ESCALAR = 3;
/** Dias hacia atras que se miran para armar la racha. */
const DIAS_VENTANA = 10;
/** Un entorno recien creado no arrastra deuda: primero se le da margen. */
const DIAS_DE_GRACIA = 3;
const MS_DIA = 86_400_000;

/** Medianoche de Ecuador (05:00 UTC), que es como se guardan las fechas. */
function diaEcuador(fecha: Date): Date {
  const ec = new Date(fecha.getTime() - 5 * 3_600_000);
  return new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate(), 5, 0, 0));
}

function comoTexto(dia: Date): string {
  return dia.toLocaleDateString("es-EC", { weekday: "long", day: "numeric", month: "long", timeZone: "America/Guayaquil" });
}

export interface EntornoSinFacturar {
  workspaceId: Types.ObjectId;
  entorno: string;
  /** Dias seguidos sin registrar, contando desde ayer hacia atras. */
  racha: number;
  dias: Date[];
  chats: number[];
}

class RecordatorioFacturacionService {
  /**
   * Dias seguidos sin facturacion registrada, contando desde AYER: el dia en
   * curso no cuenta porque la facturacion se registra al cierre.
   */
  async rachaSinFacturar(workspaceId: Types.ObjectId, creadoEn?: Date): Promise<Date[]> {
    const ayer = new Date(diaEcuador(new Date()).getTime() - MS_DIA);
    const desde = new Date(ayer.getTime() - (DIAS_VENTANA - 1) * MS_DIA);
    const registrados = new Set(
      (await models.dailyBilling.distinct("date", { workspaceId, date: { $gte: desde } })).map((d: Date) =>
        new Date(d).toISOString().slice(0, 10)
      )
    );
    const arranque = creadoEn ? new Date(diaEcuador(creadoEn).getTime() + DIAS_DE_GRACIA * MS_DIA) : null;

    const faltan: Date[] = [];
    for (let i = 0; i < DIAS_VENTANA; i++) {
      const dia = new Date(ayer.getTime() - i * MS_DIA);
      if (arranque && dia.getTime() < arranque.getTime()) break;
      if (registrados.has(dia.toISOString().slice(0, 10))) break; // la racha se corta
      faltan.push(dia);
    }
    return faltan;
  }

  /** Entornos activos, con chat de cliente, que no registraron ayer. */
  async pendientes(): Promise<EntornoSinFacturar[]> {
    const chats = await models.telegramChats
      .find({ estado: "listo", workspaceId: { $ne: null } })
      .select("chatId workspaceId userId")
      .lean();
    if (!chats.length) return [];

    // El bot es para los clientes: un chat del equipo no recibe recordatorios.
    const internos = new Set(
      (
        await models.users
          .find({ _id: { $in: chats.map((c) => c.userId).filter(Boolean) }, $or: [{ isInternal: true }, { role: "superadmin" }] })
          .select("_id")
          .lean()
      ).map((u) => String(u._id))
    );

    const porEntorno = new Map<string, number[]>();
    for (const c of chats) {
      if (c.userId && internos.has(String(c.userId))) continue;
      const clave = String(c.workspaceId);
      porEntorno.set(clave, [...(porEntorno.get(clave) ?? []), c.chatId]);
    }
    if (!porEntorno.size) return [];

    const workspaces = await models.workspaces
      .find({ _id: { $in: [...porEntorno.keys()].map((id) => new Types.ObjectId(id)) }, isActive: true })
      .select("name createdAt")
      .lean();

    const pendientes: EntornoSinFacturar[] = [];
    for (const w of workspaces) {
      const dias = await this.rachaSinFacturar(w._id as Types.ObjectId, w.createdAt);
      if (!dias.length) continue;
      pendientes.push({
        workspaceId: w._id as Types.ObjectId,
        entorno: w.name,
        racha: dias.length,
        dias,
        chats: porEntorno.get(String(w._id)) ?? [],
      });
    }
    return pendientes;
  }

  /** Corre una vez al dia: recuerda al cliente y, a los 3 dias, avisa al equipo. */
  async enviarRecordatorios(): Promise<{ avisados: number; escalados: number; detalle: string[] }> {
    const pendientes = await this.pendientes();
    let avisados = 0;
    let escalados = 0;
    const detalle: string[] = [];

    for (const p of pendientes) {
      const link = `${APP_URL}/app/workspaces/${p.workspaceId}/billing`;
      // Registrar por el chat va primero: el cliente ya está aquí.
      const botones: InlineButton[][] = [
        [{ text: "💵 Registrar por aquí", callback_data: "fact:ver" }],
        [{ text: "🌐 Abrir metrics.bakano.ec", url: link }],
        [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
      ];
      const texto =
        p.racha === 1
          ? `Hola! Ayer (${comoTexto(p.dias[0]!)}) no quedó registrada tu facturación 💵\n\n` +
            "Escríbeme el monto por aquí y yo lo subo a metrics.bakano.ec. Si vendiste 0 también se registra, así no queda hueco."
          : p.racha < DIAS_PARA_ESCALAR
            ? `Llevas <b>${p.racha} días</b> sin registrar tu facturación (${p.dias.map((d) => comoTexto(d)).join(" y ")}) 💵\n\n` +
              "Con esos números medimos tu ROAS y decidimos dónde poner la pauta. Mándamelos por aquí y los subo yo, uno por día."
            : `Llevas <b>${p.racha} días seguidos</b> sin registrar tu facturación 😕\n\n` +
              "Sin eso no podemos saber si la pauta está trayendo plata ni ajustar las campañas. " +
              "Ya le avisé a tu equipo para que te dé una mano, pero si lo cargas ahora quedamos al día.";

      for (const chatId of p.chats) {
        await telegramService.sendMessage(chatId, texto, botones).catch((error: any) => {
          console.error(`[Facturación] no se pudo avisar al chat ${chatId}:`, error?.message || error);
        });
      }
      avisados++;
      detalle.push(`${p.entorno}: ${p.racha} día(s)`);

      if (p.racha >= DIAS_PARA_ESCALAR) {
        await this.avisarAlEquipo(p, link);
        escalados++;
      }
    }

    return { avisados, escalados, detalle };
  }

  /** A los 3 dias el equipo tiene que enterarse: ya no alcanza con recordarle al cliente. */
  private async avisarAlEquipo(p: EntornoSinFacturar, link: string): Promise<void> {
    const titulo = `💵 ${p.entorno} lleva ${p.racha} días sin registrar facturación`;
    const detalle =
      `Sin esos números no se puede calcular el ROAS ni decidir la pauta.\n\n` +
      `Días sin registrar: ${p.dias.map((d) => comoTexto(d)).join(", ")}.\n` +
      `Ya se lo recordé por Telegram cada día. Su pantalla: ${link}`;

    const correos = [...new Set([...equipoAtencionService.correos("atencion"), "dquimi@bakano.ec"])];
    const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos }),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle, { workspaceId: p.workspaceId })
      ),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: "facturación sin registrar",
        workspaceName: p.entorno,
        clienteNombre: p.entorno,
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
  }
}

export const recordatorioFacturacionService = new RecordatorioFacturacionService();
