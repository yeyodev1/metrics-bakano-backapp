import { Types } from "mongoose";
import models from "../models";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";

/**
 * Como va el bot: quien lo conecto, quien lo usa y para que.
 *
 * El correo de presentacion se manda una vez y se pierde. Aqui viven dos
 * cosas: el recordatorio a quien todavia no lo conecto (durante dos semanas,
 * no para siempre) y el reporte semanal de uso con lo que conviene mejorar,
 * sacado de lo que la gente de verdad toca y no de lo que suponemos.
 */

const BOT_URL = process.env.TELEGRAM_BOT_URL || "https://t.me/BakanoAgencyBot";
const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
/** Se insiste dos semanas desde el primer correo. Despues se deja en paz. */
const VENTANA_RECORDATORIOS_DIAS = 14;
const CADA_DIAS = 4;
const MAX_RECORDATORIOS = 3;
const DIRECCION = ["dreyes@bakano.ec", "dquimi@bakano.ec"];

/** Lo que significa cada accion cuando se lo contamos a una persona. */
const NOMBRES: Record<string, string> = {
  "menu:ver": "Abrir el menú",
  "menu:onboarding": "Ver su onboarding",
  "menu:produccion": "Ver sus producciones",
  "menu:guiones": "Ver sus guiones",
  "menu:atencion": "Escribirle a su equipo",
  "menu:agendar": "Agendar una reunión",
  "menu:equipo": "Quién es quién en Bakano",
  "citas:ver": "Ver sus citas",
  "citas:cambiar": "Mover o cancelar una cita",
  "fact:ver": "Ver su facturación",
  "venta:donde": "Dónde captura la venta",
  mensaje: "Escribirle al bot con sus palabras",
};

function nombreAccion(accion: string): string {
  if (NOMBRES[accion]) return NOMBRES[accion];
  if (accion.startsWith("ia:")) return `IA · ${accion.slice(3)}`;
  if (accion.startsWith("cc:")) return "Mover o cancelar una cita";
  if (accion.startsWith("cs:") || accion.startsWith("prod:") || accion.startsWith("onbs:")) return "Elegir un horario";
  if (accion.startsWith("onb:")) return "Agendar una sesión del onboarding";
  if (accion.startsWith("sub:")) return "Mandar un archivo";
  if (accion.startsWith("fact:")) return "Registrar facturación";
  if (accion === "cita:si" || accion === "cita:no") return "Confirmar un cambio de cita";
  return accion;
}

export interface ResumenUso {
  desde: Date;
  hasta: Date;
  invitados: number;
  conectados: number;
  avisoVisto: number;
  activos: number;
  interacciones: number;
  porAccion: { accion: string; nombre: string; veces: number; clientes: number }[];
  porEntorno: { entorno: string; interacciones: number }[];
  nuncaConectaron: { nombre: string; email: string; entorno: string }[];
  sinUsarDesdeQueEntraron: string[];
}

class ReporteBotService {
  /** Foto del uso en un rango. Es la base del reporte y de las mejoras. */
  async resumen(dias = 7): Promise<ResumenUso> {
    const hasta = new Date();
    const desde = new Date(hasta.getTime() - dias * 86_400_000);

    const [invitados, chats, eventos, entornos] = await Promise.all([
      models.users.find({ presentacionBotEnviadaEn: { $exists: true, $ne: null } }).select("name email workspaceId workspaces avisoBotVistoEn").lean(),
      models.telegramChats.find({ estado: "listo" }).select("chatId workspaceId userId").lean(),
      models.usoBot.find({ en: { $gte: desde, $lte: hasta } }).select("accion chatId workspaceId").lean(),
      models.workspaces.find({ isActive: true }).select("_id name").lean(),
    ]);

    const nombrePorEntorno = new Map(entornos.map((w: any) => [String(w._id), w.name as string]));
    const conectadosPorUsuario = new Set(chats.map((c: any) => String(c.userId)).filter(Boolean));

    const porAccion = new Map<string, { veces: number; clientes: Set<number> }>();
    const porEntorno = new Map<string, number>();
    const chatsActivos = new Set<number>();
    for (const e of eventos as any[]) {
      chatsActivos.add(e.chatId);
      const a = porAccion.get(e.accion) || { veces: 0, clientes: new Set<number>() };
      a.veces++;
      a.clientes.add(e.chatId);
      porAccion.set(e.accion, a);
      const ws = String(e.workspaceId || "");
      if (ws) porEntorno.set(ws, (porEntorno.get(ws) || 0) + 1);
    }

    const nuncaConectaron = (invitados as any[])
      .filter((u) => !conectadosPorUsuario.has(String(u._id)))
      .map((u) => {
        const ids = [u.workspaceId, ...(u.workspaces || []).map((w: any) => w.workspaceId?._id ?? w.workspaceId)].filter(Boolean).map(String);
        return { nombre: u.name || "(sin nombre)", email: u.email, entorno: nombrePorEntorno.get(ids.find((i) => nombrePorEntorno.has(i)) || "") || "—" };
      });

    const sinUsar = (chats as any[])
      .filter((c) => !chatsActivos.has(c.chatId))
      .map((c) => nombrePorEntorno.get(String(c.workspaceId)) || "—");

    return {
      desde,
      hasta,
      invitados: invitados.length,
      conectados: chats.length,
      avisoVisto: (invitados as any[]).filter((u) => u.avisoBotVistoEn).length,
      activos: chatsActivos.size,
      interacciones: eventos.length,
      porAccion: [...porAccion.entries()]
        .map(([accion, v]) => ({ accion, nombre: nombreAccion(accion), veces: v.veces, clientes: v.clientes.size }))
        .sort((a, b) => b.veces - a.veces),
      porEntorno: [...porEntorno.entries()]
        .map(([id, n]) => ({ entorno: nombrePorEntorno.get(id) || id, interacciones: n }))
        .sort((a, b) => b.interacciones - a.interacciones),
      nuncaConectaron,
      sinUsarDesdeQueEntraron: [...new Set(sinUsar)],
    };
  }

  /**
   * Lo que conviene mejorar, sacado de los numeros y no de la intuicion.
   * Son reglas explicitas a proposito: un reporte que cambia de criterio cada
   * semana no sirve para comparar.
   */
  mejoras(r: ResumenUso): string[] {
    const mejoras: string[] = [];
    const conexion = r.invitados ? Math.round((r.conectados / r.invitados) * 100) : 0;

    if (conexion < 40) {
      mejoras.push(
        `Solo ${conexion}% de los invitados conectó el bot (${r.conectados} de ${r.invitados}). ` +
          "Vale que el equipo lo mencione en las sesiones y en las reuniones: el correo solo no alcanza."
      );
    }
    if (r.conectados && r.activos / r.conectados < 0.5) {
      mejoras.push(
        `${r.conectados - r.activos} de ${r.conectados} clientes conectados no lo tocaron esta semana. ` +
          "Conviene que el bot escriba primero cuando tenga algo útil que decir, en vez de esperar."
      );
    }
    const texto = r.porAccion.find((a) => a.accion === "mensaje");
    const botones = r.porAccion.filter((a) => a.accion !== "mensaje").reduce((n, a) => n + a.veces, 0);
    if (texto && texto.veces > botones) {
      mejoras.push(
        `Escriben más de lo que tocan botones (${texto.veces} mensajes contra ${botones} toques). ` +
          "Hay que mirar de qué escriben: si preguntan algo que ya existe como botón, el menú no se entiende."
      );
    }
    const sinUso = ["fact:ver", "menu:guiones", "citas:ver", "menu:produccion"].filter(
      (a) => !r.porAccion.some((x) => x.accion === a)
    );
    if (sinUso.length) {
      mejoras.push(`Nadie usó esta semana: ${sinUso.map(nombreAccion).join(", ")}. O no lo necesitan, o no saben que está.`);
    }
    if (!mejoras.length) mejoras.push("Sin señales de alarma esta semana: el uso está repartido y la adopción avanza.");
    return mejoras;
  }

  /** El reporte de la semana a dirección: correo y Slack. */
  async reporteSemanal(): Promise<ResumenUso> {
    const r = await this.resumen(7);
    const conexion = r.invitados ? Math.round((r.conectados / r.invitados) * 100) : 0;
    const top = r.porAccion.slice(0, 8).map((a) => `• ${a.nombre}: ${a.veces} veces · ${a.clientes} clientes`).join("\n");
    const entornos = r.porEntorno.slice(0, 8).map((e) => `• ${e.entorno}: ${e.interacciones}`).join("\n");

    const titulo = `📊 Bot de Telegram · semana del ${r.desde.toLocaleDateString("es-EC", { timeZone: "America/Guayaquil", day: "numeric", month: "long" })}`;
    const detalle =
      `Conectaron el bot: ${r.conectados} de ${r.invitados} invitados (${conexion}%).\n` +
      `Marcaron el aviso en Metrics: ${r.avisoVisto}.\n` +
      `Lo usaron esta semana: ${r.activos} clientes, ${r.interacciones} interacciones.\n\n` +
      `LO QUE MÁS USAN\n${top || "• Nada todavía"}\n\n` +
      `ENTORNOS MÁS ACTIVOS\n${entornos || "• Ninguno todavía"}\n\n` +
      `QUÉ MEJORAR\n${this.mejoras(r).map((m) => `• ${m}`).join("\n")}\n\n` +
      (r.nuncaConectaron.length
        ? `SIN CONECTAR (${r.nuncaConectaron.length}): ${r.nuncaConectaron.slice(0, 15).map((u) => u.entorno).join(", ")}${r.nuncaConectaron.length > 15 ? "…" : ""}\n\n`
        : "") +
      `Metrics: ${APP_URL}`;

    const internos = await models.users.find({ email: { $in: DIRECCION }, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos: DIRECCION }),
      ...DIRECCION.map((c) => slackService.mensajeDirecto(c, titulo, detalle)),
      ...internos.map((u) => notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle)),
      resendService.sendSolicitudClienteEmail({
        to: DIRECCION,
        tema: "reporte semanal del bot",
        workspaceName: "Bakano",
        clienteNombre: "Bot de Telegram",
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
    return r;
  }

  /**
   * Recordatorio a quien recibio el correo y todavia no conecto el bot. Se
   * insiste cada 4 dias, como maximo 3 veces y solo dentro de las dos
   * semanas siguientes al primer correo: pasado eso, insistir es molestar.
   */
  async recordatorios(): Promise<{ candidatos: number; enviados: number }> {
    const ahora = Date.now();
    const chats = await models.telegramChats.find({ estado: "listo" }).select("userId").lean();
    const conectados = new Set(chats.map((c: any) => String(c.userId)).filter(Boolean));

    const invitados = await models.users
      .find({
        isActive: true,
        presentacionBotEnviadaEn: { $gte: new Date(ahora - VENTANA_RECORDATORIOS_DIAS * 86_400_000) },
      })
      .select("name email workspaceId workspaces presentacionBotEnviadaEn presentacionBotRecordatorios presentacionBotUltimoEn isInternal")
      .lean();

    const entornos = await models.workspaces.find({ isActive: true }).select("_id name").lean();
    const nombrePorEntorno = new Map(entornos.map((w: any) => [String(w._id), w.name as string]));

    const candidatos = (invitados as any[]).filter((u) => {
      if (u.isInternal || String(u.email || "").endsWith("@bakano.ec")) return false;
      if (conectados.has(String(u._id))) return false;
      if ((u.presentacionBotRecordatorios || 0) >= MAX_RECORDATORIOS) return false;
      const ultimo = new Date(u.presentacionBotUltimoEn || u.presentacionBotEnviadaEn).getTime();
      return ahora - ultimo >= CADA_DIAS * 86_400_000;
    });

    let enviados = 0;
    for (const u of candidatos) {
      const ids = [u.workspaceId, ...(u.workspaces || []).map((w: any) => w.workspaceId?._id ?? w.workspaceId)].filter(Boolean).map(String);
      const entorno = nombrePorEntorno.get(ids.find((i) => nombrePorEntorno.has(i)) || "");
      if (!entorno) continue;
      try {
        await resendService.sendPresentacionBot({ to: u.email, recipientName: u.name, workspaceName: entorno, botUrl: BOT_URL, correoCliente: u.email });
        await models.users.updateOne(
          { _id: u._id },
          { $set: { presentacionBotUltimoEn: new Date() }, $inc: { presentacionBotRecordatorios: 1 } }
        );
        enviados++;
      } catch (error: any) {
        console.error(`[Bot] recordatorio a ${u.email}:`, error?.message || error);
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { candidatos: candidatos.length, enviados };
  }
}

export const reporteBotService = new ReporteBotService();
