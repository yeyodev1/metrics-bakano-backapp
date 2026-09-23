import { Types } from "mongoose";
import models from "../models";
import type { GravedadIncidente } from "../models/incidente.model";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";

/**
 * Incidentes de clientes: lo que la IA detecta en Telegram y alguien tiene
 * que atender.
 *
 * Antes esto era un correo que cada quien leía (o no) y ahí moría. Ahora
 * queda en Metrics: el equipo entero ve de qué cliente es, qué dijo, qué se
 * recomienda y si ya alguien lo tomó. Genesis Benalcazar, que es quien
 * coordina atención, recibe además el aviso directo y se le insiste mientras
 * nadie lo tome.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const GENESIS = "gbenalcazar@bakano.ec";
/** Cada cuánto se vuelve a insistir por un incidente que nadie toma. */
const PING_CADA_MS = 30 * 60_000;

/** Ecuador: fuera de 08:00-17:00 de lunes a viernes no hay nadie en oficina. */
export function fueraDeHorario(ahora = new Date()): boolean {
  const ec = new Date(ahora.getTime() - 5 * 3_600_000);
  const dia = ec.getUTCDay();
  const hora = ec.getUTCHours();
  return dia === 0 || dia === 6 || hora < 8 || hora >= 17;
}

const ETIQUETA: Record<GravedadIncidente, string> = {
  molesto: "🟠 Cliente molesto",
  angustiado: "🔴 Cliente angustiado",
  en_peligro: "🔴 Cliente en peligro de irse",
};

export interface DatosIncidente {
  workspaceId: Types.ObjectId;
  workspaceName: string;
  gravedad: GravedadIncidente;
  tema: string;
  cliente: { nombre?: string; email?: string; telegram?: string; chatId?: number };
  frase: string;
  motivo?: string;
  recomendacion?: string;
  mensajeCompleto?: string;
}

class IncidentesService {
  /** Abre el incidente y avisa. Devuelve el id para enlazarlo en los avisos. */
  async abrir(datos: DatosIncidente): Promise<Types.ObjectId | null> {
    try {
      const incidente = await models.incidentes.create({
        workspaceId: datos.workspaceId,
        workspaceName: datos.workspaceName,
        origen: "telegram",
        gravedad: datos.gravedad,
        tema: datos.tema,
        responsableNombre: equipoAtencionService.nombres(datos.tema as any),
        responsableEmail: equipoAtencionService.correos(datos.tema as any)[0],
        cliente: datos.cliente,
        frase: datos.frase.slice(0, 1000),
        motivo: datos.motivo,
        recomendacion: datos.recomendacion,
        mensajeCompleto: datos.mensajeCompleto?.slice(0, 4000),
        fueraDeHorario: fueraDeHorario(),
      });

      if (datos.gravedad !== "molesto") await this.avisarAGenesis(incidente as any);
      return incidente._id as Types.ObjectId;
    } catch (error: any) {
      console.error("[Incidentes] no se pudo abrir:", error?.message || error);
      return null;
    }
  }

  /** El link del incidente en Metrics, para pegarlo en correos y Slack. */
  link(incidenteId: Types.ObjectId | string): string {
    return `${APP_URL}/app/incidentes?id=${incidenteId}`;
  }

  /**
   * Aviso directo a Genesis, que coordina atención: correo, notificación en
   * Metrics y Slack, aunque ya le haya llegado el aviso general. Un cliente
   * angustiado no puede depender de que alguien mire el correo.
   */
  private async avisarAGenesis(incidente: any): Promise<void> {
    const titulo = `${ETIQUETA[incidente.gravedad as GravedadIncidente]} · ${incidente.workspaceName} — tómalo, por favor`;
    const cuerpo = [
      `Lo detecté yo en la conversación de Telegram y ya avisé a todo el equipo.`,
      "",
      `Cliente: ${incidente.cliente?.nombre || "—"} (${incidente.workspaceName})`,
      `Frase: “${incidente.frase}”`,
      incidente.motivo ? `Motivo: ${incidente.motivo}` : "",
      incidente.recomendacion ? `Recomendación: ${incidente.recomendacion}` : "",
      incidente.fueraDeHorario ? "Llegó fuera de horario de oficina." : "",
      "",
      `Tómalo aquí: ${this.link(incidente._id)}`,
    ]
      .filter(Boolean)
      .join("\n");

    const usuario = await models.users.findOne({ email: GENESIS, isActive: true }).select("_id").lean();
    // Con allSettled a secas, un correo que no sale no deja rastro: aquí se
    // registra canal por canal, que es lo único que permite comprobarlo.
    const canales = await Promise.allSettled([
      // DM directo primero: es lo que de verdad la interrumpe.
      slackService.mensajeDirecto(GENESIS, titulo, cuerpo).then(async (ok) => {
        await slackService.avisarEquipo({ titulo, detalle: cuerpo, correos: [GENESIS] });
        return ok;
      }),
      usuario
        ? notificationService.create(usuario._id as Types.ObjectId, "cliente_en_riesgo", titulo, cuerpo.slice(0, 500), {
            workspaceId: incidente.workspaceId,
          })
        : Promise.resolve(null),
      resendService.sendSolicitudClienteEmail({
        to: [GENESIS],
        tema: "incidente de cliente",
        workspaceName: incidente.workspaceName,
        clienteNombre: incidente.cliente?.nombre || incidente.workspaceName,
        clienteEmail: incidente.cliente?.email,
        mensaje: cuerpo,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
    const nombres = ["slack (DM + canal)", "notificación", "correo"];
    canales.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[Incidentes] ${nombres[i]} a Genesis falló:`, (r.reason as any)?.message || r.reason);
      } else {
        console.log(`[Incidentes] ${nombres[i]} a Genesis: ok`);
      }
    });
    await models.incidentes.updateOne({ _id: incidente._id }, { $set: { ultimoPingEn: new Date() } });
  }

  /** Incidentes que nadie tomó y ya llevan rato: se vuelve a insistir. */
  async insistirPendientes(): Promise<number> {
    const limite = new Date(Date.now() - PING_CADA_MS);
    const pendientes = await models.incidentes
      .find({ estado: "abierto", gravedad: { $ne: "molesto" }, $or: [{ ultimoPingEn: { $lte: limite } }, { ultimoPingEn: null }] })
      .sort({ createdAt: 1 })
      .limit(10);

    for (const incidente of pendientes) {
      const minutos = Math.round((Date.now() - new Date(incidente.createdAt).getTime()) / 60_000);
      const titulo = `⏰ Sigue sin tomar: ${incidente.workspaceName} (${minutos} min)`;
      const cuerpo =
        `${ETIQUETA[incidente.gravedad]} · “${incidente.frase}”\n\n` +
        `Nadie lo ha tomado todavía. Tómalo aquí: ${this.link(incidente._id as Types.ObjectId)}`;
      const usuario = await models.users.findOne({ email: GENESIS, isActive: true }).select("_id").lean();
      await Promise.allSettled([
        slackService.mensajeDirecto(GENESIS, titulo, cuerpo),
        slackService.avisarEquipo({ titulo, detalle: cuerpo, correos: [GENESIS] }),
        usuario
          ? notificationService.create(usuario._id as Types.ObjectId, "cliente_en_riesgo", titulo, cuerpo.slice(0, 500), {
              workspaceId: incidente.workspaceId,
            })
          : Promise.resolve(),
      ]);
      incidente.ultimoPingEn = new Date();
      await incidente.save();
    }
    return pendientes.length;
  }

  /** Lo que ve el equipo en Metrics. Todos ven todo; `mios` filtra lo suyo. */
  async listar(filtros: { estado?: string; workspaceId?: string; correo?: string; mios?: boolean; limite?: number }) {
    const query: Record<string, unknown> = {};
    if (filtros.estado && filtros.estado !== "todos") query.estado = filtros.estado;
    if (filtros.workspaceId && Types.ObjectId.isValid(filtros.workspaceId)) {
      query.workspaceId = new Types.ObjectId(filtros.workspaceId);
    }
    if (filtros.mios && filtros.correo) query.responsableEmail = filtros.correo.toLowerCase();

    const [incidentes, abiertos] = await Promise.all([
      models.incidentes.find(query).sort({ estado: 1, createdAt: -1 }).limit(Math.min(filtros.limite ?? 50, 200)).lean(),
      models.incidentes.countDocuments({ estado: "abierto" }),
    ]);
    return { incidentes, abiertos };
  }

  /** Uno solo, para cuando se entra por el link del correo o del DM. */
  async uno(id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    return models.incidentes.findById(id).lean();
  }

  /** Alguien se hace cargo: queda su nombre y deja de insistirse. */
  async tomar(id: string, usuario: { _id: Types.ObjectId; name?: string; email?: string }) {
    if (!Types.ObjectId.isValid(id)) throw new Error("INVALID_ID");
    const incidente = await models.incidentes.findOneAndUpdate(
      { _id: new Types.ObjectId(id), estado: "abierto" },
      { $set: { estado: "tomado", tomadoPor: { userId: usuario._id, nombre: usuario.name || usuario.email || "—", en: new Date() } } },
      { new: true }
    );
    if (!incidente) throw new Error("NOT_FOUND");

    await slackService
      .avisarEquipo({
        titulo: `✋ ${usuario.name || usuario.email} tomó el caso de ${incidente.workspaceName}`,
        detalle: `“${incidente.frase}”\n\n${this.link(incidente._id as Types.ObjectId)}`,
        correos: [GENESIS, incidente.responsableEmail].filter(Boolean) as string[],
      })
      .catch(() => undefined);
    return incidente;
  }

  async cerrar(id: string, usuario: { _id: Types.ObjectId; name?: string; email?: string }, nota?: string) {
    if (!Types.ObjectId.isValid(id)) throw new Error("INVALID_ID");
    const incidente = await models.incidentes.findOneAndUpdate(
      { _id: new Types.ObjectId(id), estado: { $ne: "cerrado" } },
      {
        $set: {
          estado: "cerrado",
          cerradoPor: { userId: usuario._id, nombre: usuario.name || usuario.email || "—", en: new Date() },
          ...(nota ? { nota: nota.slice(0, 2000) } : {}),
        },
      },
      { new: true }
    );
    if (!incidente) throw new Error("NOT_FOUND");
    return incidente;
  }
}

export const incidentesService = new IncidentesService();
