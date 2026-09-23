import { Types } from "mongoose";
import models from "../models";

export type TemaAtencion = "produccion" | "guiones" | "atencion";

export interface PersonaAtencion {
  nombre: string;
  email: string;
}

export interface EquipoTema {
  etiqueta: string;
  personas: PersonaAtencion[];
  /**
   * Calendario del CRM donde el bot agenda reuniones de este tema. Nunca uno
   * de produccion ("Equipo Alfa Lobo/Dinamita"): el sync del CRM convierte
   * esas citas en grabaciones del Planificador. Sin calendario, la reunion se
   * coordina por correo.
   */
  calendarioId?: string;
}

/**
 * Quien atiende a los clientes por tema. Es igual para todos los entornos: en
 * el CRM ningun contacto tiene dueño asignado, asi que la persona no se puede
 * deducir por cliente. Se nombra siempre con nombre y apellido.
 *
 * Los correos salen directo de aqui (no dependen de que la persona tenga
 * usuario en la plataforma); la notificacion in-app llega solo a quien lo tenga.
 */
export const EQUIPO_ATENCION: Record<TemaAtencion, EquipoTema> = {
  produccion: {
    etiqueta: "producción",
    personas: [
      { nombre: "Karen Muñoz", email: "kmunoz@bakano.ec" },
      { nombre: "Jean Ortega", email: "jortega@bakano.ec" },
    ],
  },
  guiones: {
    etiqueta: "revisión de guiones",
    personas: [{ nombre: "Ariana Vera", email: "avera@bakano.ec" }],
    calendarioId: "JDzGl2qjoWwAk5TvBNUp", // "Ariana - CONTENT STRATEGIST"
  },
  atencion: {
    etiqueta: "atención al cliente",
    personas: [{ nombre: "Genesis Benalcazar", email: "gbenalcazar@bakano.ec" }],
    calendarioId: "FWL0e2jCKpbamtlj31io", // "Project Manager"
  },
};

/**
 * Calendarios de produccion de Karen y Jean en el CRM ("Equipo Dinamita").
 * Aqui SI se agenda la produccion: el sync del CRM la convierte en la
 * grabacion del Planificador y avisa al equipo. Las reuniones no van aqui.
 */
export const CALENDARIOS_PRODUCCION = {
  standard: "hm9U34tabJCK5oeZm0Kg", // "Equipo dinamita - standard"
  premium: "gL4SsPMtjhuDFyUM3vQW", // "Equipo Dinamita - premium"
} as const;

export class EquipoAtencionService {
  /** "Karen Muñoz y Jean Ortega" */
  nombres(tema: TemaAtencion): string {
    const nombres = EQUIPO_ATENCION[tema].personas.map((p) => p.nombre);
    return nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}` : nombres[0];
  }

  correos(tema: TemaAtencion): string[] {
    return EQUIPO_ATENCION[tema].personas.map((p) => p.email);
  }

  /** Usuarios activos de la plataforma para el tema, para la notificacion in-app. */
  async usuarios(tema: TemaAtencion): Promise<{ _id: Types.ObjectId; email: string }[]> {
    const usuarios = await models.users
      .find({ email: { $in: this.correos(tema) }, isActive: true })
      .select("_id email")
      .lean();
    return usuarios.map((u) => ({ _id: u._id as Types.ObjectId, email: u.email }));
  }
}

export const equipoAtencionService = new EquipoAtencionService();
