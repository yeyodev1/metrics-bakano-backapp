import { Types } from "mongoose";
import models from "../models";
import { onboardingBotService } from "./onboardingBot.service";
import type { PasoOnboarding } from "../models/onboardingEvento.model";

/**
 * Nuevo o de siempre: el bot no se lo pregunta al cliente, lo deduce.
 *
 * La antiguedad del entorno no sirve como señal (hay entornos de 5 meses sin
 * una sola produccion). Lo que separa a un cliente que arranca de uno en
 * marcha es la actividad real: si ya grabo y si ya tiene guiones.
 */
export type TipoCliente = "nuevo" | "en_onboarding" | "activo";

export interface PerfilCliente {
  tipo: TipoCliente;
  /** Quien escribe es del equipo de Bakano, no el cliente: nada de onboarding. */
  esEquipo: boolean;
  entorno: string;
  diasDesdeCreacion?: number;
  tieneProducciones: boolean;
  tieneGuiones: boolean;
  sesionesAgendadas: number;
  sesionesCumplidas: number;
  siguientePaso?: PasoOnboarding;
  /** Fecha de la proxima sesion o produccion, lo que venga primero. */
  proximaCita?: Date;
}

class PerfilClienteService {
  async de(workspaceId: Types.ObjectId, userId?: Types.ObjectId): Promise<PerfilCliente> {
    const [workspace, producciones, guiones, onboarding, usuario] = await Promise.all([
      models.workspaces.findById(workspaceId).select("name createdAt").lean(),
      models.planning.countDocuments({ workspaceId }),
      models.videoPlanning.countDocuments({ workspaceId }),
      onboardingBotService.estado(workspaceId),
      userId ? models.users.findById(userId).select("isInternal role").lean() : null,
    ]);

    const sesiones = onboarding.sesiones;
    const sesionesAgendadas = sesiones.filter((s) => s.agendada).length;
    const sesionesCumplidas = sesiones.filter((s) => s.estado === "cumplida").length;
    const tieneProducciones = producciones > 0;
    const tieneGuiones = guiones > 0;

    const tipo: TipoCliente =
      tieneProducciones || tieneGuiones ? "activo" : sesionesAgendadas > 0 ? "en_onboarding" : "nuevo";

    const fechasSesiones = sesiones.map((s) => s.fecha).filter(Boolean) as Date[];
    const candidatas = [...fechasSesiones, onboarding.produccion.agendada].filter(
      (f): f is Date => Boolean(f) && (f as Date).getTime() > Date.now()
    );

    return {
      tipo,
      esEquipo: Boolean(usuario?.isInternal || usuario?.role === "superadmin"),
      entorno: workspace?.name || "Cliente",
      diasDesdeCreacion: workspace?.createdAt
        ? Math.floor((Date.now() - new Date(workspace.createdAt).getTime()) / 86_400_000)
        : undefined,
      tieneProducciones,
      tieneGuiones,
      sesionesAgendadas,
      sesionesCumplidas,
      siguientePaso: onboarding.siguiente,
      proximaCita: candidatas.sort((a, b) => a.getTime() - b.getTime())[0],
    };
  }

  /** Lo que el bot le dice a la IA para que trate distinto a cada cliente. */
  describir(perfil: PerfilCliente): string {
    if (perfil.esEquipo) {
      return `Estás hablando con alguien del equipo de Bakano que está viendo la cuenta de ${perfil.entorno}, no con el cliente. Trátalo como colega: dale los datos directos, sin onboarding ni explicaciones de venta, y no le ofrezcas agendar como si fuera el cliente.`;
    }
    if (perfil.tipo === "activo") {
      return `Cliente en marcha: ya tiene ${perfil.tieneProducciones ? "producciones" : "guiones"} con nosotros. No lo trates como si empezara; ayúdalo con lo que pida.`;
    }
    if (perfil.tipo === "en_onboarding") {
      return `Cliente en pleno arranque: ya agendó ${perfil.sesionesAgendadas} de 3 sesiones y todavía no graba. Guíalo al siguiente paso sin repetirle lo que ya hizo.`;
    }
    return "Cliente nuevo: todavía no agenda ninguna sesión ni tiene producciones. Guíalo desde el principio, paso por paso, y agéndale su primera sesión.";
  }
}

export const perfilClienteService = new PerfilClienteService();
