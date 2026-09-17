import { Types } from "mongoose";
import models from "../models";
import type { EstadoSesionOnboarding } from "../models/workspace.model";
import type { PasoOnboarding } from "../models/onboardingEvento.model";
import { slackService } from "./slack.service";
import { telegramService } from "./telegram.service";
import { atencionClienteService, fechaEcuador } from "./atencionCliente.service";
import { equipoAtencionService } from "./equipoAtencion.service";
import { ORDEN_SESIONES, SESIONES_ONBOARDING, type SesionOnboarding } from "./onboardingSesiones.service";

/**
 * Progreso del onboarding visto desde adentro: cada responsable mueve su paso
 * y, si algo no avanza, deja el motivo. Sin esto el avance vivia en la cabeza
 * de cada quien y nadie podia responder "por que este cliente sigue parado".
 */

export const PASOS: PasoOnboarding[] = [...ORDEN_SESIONES, "produccion"];

const ETIQUETA_PASO: Record<PasoOnboarding, string> = {
  meta: SESIONES_ONBOARDING.meta.etiqueta,
  crm: SESIONES_ONBOARDING.crm.etiqueta,
  estrategia: SESIONES_ONBOARDING.estrategia.etiqueta,
  produccion: "Primera producción",
};

const RESPONSABLE_PASO: Record<PasoOnboarding, string> = {
  meta: SESIONES_ONBOARDING.meta.responsable.nombre,
  crm: SESIONES_ONBOARDING.crm.responsable.nombre,
  estrategia: SESIONES_ONBOARDING.estrategia.responsable.nombre,
  produccion: equipoAtencionService.nombres("produccion"),
};

const CORREO_PASO: Record<PasoOnboarding, string[]> = {
  meta: [SESIONES_ONBOARDING.meta.responsable.email],
  crm: [SESIONES_ONBOARDING.crm.responsable.email],
  estrategia: [SESIONES_ONBOARDING.estrategia.responsable.email],
  produccion: equipoAtencionService.correos("produccion"),
};

export interface PasoProgreso {
  paso: PasoOnboarding;
  etiqueta: string;
  responsable: string;
  estado: EstadoSesionOnboarding;
  fecha?: Date;
  motivo?: string;
  nota?: string;
  pendienteDelCliente?: string;
  actualizadoPorNombre?: string;
  actualizadoEn?: Date;
}

export interface ProgresoEntorno {
  workspaceId: string;
  entorno: string;
  pasos: PasoProgreso[];
  /** 0-100, cuenta cumplidas sobre el total de pasos. */
  porcentaje: number;
  siguiente?: PasoOnboarding;
  bloqueado: boolean;
  motivoBloqueo?: string;
  /** Dias desde el ultimo movimiento; sirve para ver quien lleva parado. */
  diasSinMover?: number;
  tieneTelegram: boolean;
}

function dias(desde?: Date): number | undefined {
  if (!desde) return undefined;
  return Math.floor((Date.now() - desde.getTime()) / 86_400_000);
}

class OnboardingProgresoService {
  private async progresoDe(workspace: any): Promise<ProgresoEntorno> {
    const sesiones = workspace.onboardingSesiones || {};
    const [produccionEstado, chat] = await Promise.all([
      atencionClienteService.estadoProduccion(workspace._id),
      models.telegramChats.exists({ workspaceId: workspace._id, estado: "listo" }),
    ]);

    const pasos: PasoProgreso[] = PASOS.map((paso) => {
      const s = paso === "produccion" ? sesiones.produccion : sesiones[paso as SesionOnboarding];
      const fecha = paso === "produccion" ? (produccionEstado.proxima ?? s?.fecha) : s?.fecha;
      // El estado guardado manda; si nadie lo movio, se deduce de la agenda.
      const estado: EstadoSesionOnboarding =
        s?.estado && s.estado !== "pendiente" ? s.estado : fecha ? "agendada" : "pendiente";
      return {
        paso,
        etiqueta: ETIQUETA_PASO[paso],
        responsable: RESPONSABLE_PASO[paso],
        estado,
        fecha,
        motivo: s?.motivo,
        nota: s?.nota,
        pendienteDelCliente: s?.pendienteDelCliente,
        actualizadoPorNombre: s?.actualizadoPorNombre,
        actualizadoEn: s?.actualizadoEn,
      };
    });

    const cumplidos = pasos.filter((p) => p.estado === "cumplida" || p.estado === "no_aplica").length;
    const bloqueado = pasos.find((p) => p.estado === "bloqueada");
    const ultimoMovimiento = pasos
      .map((p) => p.actualizadoEn?.getTime() ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);

    return {
      workspaceId: String(workspace._id),
      entorno: workspace.name,
      pasos,
      porcentaje: Math.round((cumplidos / PASOS.length) * 100),
      siguiente: pasos.find((p) => p.estado !== "cumplida" && p.estado !== "no_aplica")?.paso,
      bloqueado: Boolean(bloqueado),
      motivoBloqueo: bloqueado?.motivo,
      diasSinMover: ultimoMovimiento ? dias(new Date(ultimoMovimiento)) : dias(workspace.createdAt),
      tieneTelegram: Boolean(chat),
    };
  }

  /** Tablero: todos los entornos activos, los trabados primero. */
  async resumen(opts: { soloBloqueados?: boolean; soloPendientes?: boolean } = {}): Promise<ProgresoEntorno[]> {
    const workspaces = await models.workspaces
      .find({ isActive: true })
      .select("name onboardingSesiones createdAt")
      .lean();

    const progresos = await Promise.all(workspaces.map((w) => this.progresoDe(w)));
    return progresos
      .filter((p) => (opts.soloBloqueados ? p.bloqueado : true))
      .filter((p) => (opts.soloPendientes ? p.porcentaje < 100 : true))
      .sort((a, b) => Number(b.bloqueado) - Number(a.bloqueado) || (b.diasSinMover ?? 0) - (a.diasSinMover ?? 0));
  }

  async detalle(workspaceId: string): Promise<{ progreso: ProgresoEntorno; bitacora: any[] } | null> {
    const workspace = await models.workspaces.findById(workspaceId).select("name onboardingSesiones createdAt").lean();
    if (!workspace) return null;
    const [progreso, bitacora] = await Promise.all([
      this.progresoDe(workspace),
      models.onboardingEventos.find({ workspaceId: new Types.ObjectId(workspaceId) }).sort({ createdAt: -1 }).limit(50).lean(),
    ]);
    return { progreso, bitacora };
  }

  /** El responsable mueve el paso. "bloqueada" exige motivo. */
  async marcar(
    workspaceId: string,
    paso: PasoOnboarding,
    datos: {
      estado: EstadoSesionOnboarding;
      motivo?: string;
      nota?: string;
      pendienteDelCliente?: string;
      porId?: string;
      porNombre?: string;
      origen?: "equipo" | "sistema";
    }
  ): Promise<ProgresoEntorno> {
    if (datos.estado === "bloqueada" && !datos.motivo?.trim()) {
      throw new Error("MOTIVO_REQUERIDO");
    }
    const workspace = await models.workspaces.findById(workspaceId).select("name onboardingSesiones createdAt");
    if (!workspace) throw new Error("NOT_FOUND");

    const ruta = `onboardingSesiones.${paso}`;
    await models.workspaces.updateOne(
      { _id: workspace._id },
      {
        $set: {
          [`${ruta}.estado`]: datos.estado,
          [`${ruta}.motivo`]: datos.motivo?.trim() || undefined,
          [`${ruta}.nota`]: datos.nota?.trim() || undefined,
          [`${ruta}.pendienteDelCliente`]: datos.pendienteDelCliente?.trim() || undefined,
          [`${ruta}.actualizadoPorId`]: datos.porId ? new Types.ObjectId(datos.porId) : undefined,
          [`${ruta}.actualizadoPorNombre`]: datos.porNombre,
          [`${ruta}.actualizadoEn`]: new Date(),
          ...(datos.estado === "cumplida" ? { [`${ruta}.agendada`]: true } : {}),
        },
      }
    );

    await models.onboardingEventos.create({
      workspaceId: workspace._id,
      paso,
      estado: datos.estado,
      motivo: datos.motivo?.trim(),
      nota: datos.nota?.trim(),
      pendienteDelCliente: datos.pendienteDelCliente?.trim(),
      origen: datos.origen || "equipo",
      porId: datos.porId ? new Types.ObjectId(datos.porId) : undefined,
      porNombre: datos.porNombre,
    });

    // Un bloqueo tiene que verse: se avisa al equipo del paso y a seguimiento.
    if (datos.estado === "bloqueada") {
      await slackService
        .avisarEquipo({
          titulo: `⛔ Onboarding trabado · ${workspace.name} · ${ETIQUETA_PASO[paso]}`,
          detalle:
            `Motivo: ${datos.motivo}\n` +
            (datos.pendienteDelCliente ? `Falta del cliente: ${datos.pendienteDelCliente}\n` : "") +
            (datos.nota ? `Nota: ${datos.nota}\n` : "") +
            `Marcado por ${datos.porNombre || "el equipo"}`,
          correos: [...CORREO_PASO[paso], "gbenalcazar@bakano.ec"],
        })
        .catch((error) => console.error("[Onboarding] Slack bloqueo:", error?.message || error));
    }

    const actualizado = await models.workspaces.findById(workspace._id).select("name onboardingSesiones createdAt").lean();
    return this.progresoDe(actualizado);
  }

  /** Recordatorio al cliente por Telegram con lo que falta de su lado. */
  async recordarAlCliente(workspaceId: string, paso: PasoOnboarding, texto?: string): Promise<{ enviado: boolean }> {
    const [workspace, chat] = await Promise.all([
      models.workspaces.findById(workspaceId).select("name onboardingSesiones").lean(),
      models.telegramChats.findOne({ workspaceId: new Types.ObjectId(workspaceId), estado: "listo" }).lean(),
    ]);
    if (!workspace || !chat) return { enviado: false };

    const s = (workspace.onboardingSesiones as any)?.[paso];
    const pendiente = texto?.trim() || s?.pendienteDelCliente || s?.motivo;
    if (!pendiente) return { enviado: false };

    const cuando = s?.fecha ? `\n\nTu sesión está para el ${fechaEcuador(new Date(s.fecha))}.` : "";
    await telegramService.sendMessage(
      chat.chatId,
      `Hola! Te escribo por tu <b>${ETIQUETA_PASO[paso]}</b> 🙂\n\n` +
        `Para seguir avanzando necesitamos:\n• ${pendiente}${cuando}\n\n` +
        "Cuando lo tengas me avisas por aquí y seguimos."
    );
    await models.workspaces.updateOne({ _id: workspace._id }, { $set: { [`onboardingSesiones.${paso}.recordatorioEn`]: new Date() } });
    return { enviado: true };
  }
}

export const onboardingProgresoService = new OnboardingProgresoService();
