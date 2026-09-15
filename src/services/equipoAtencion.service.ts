import { Types } from "mongoose";
import models from "../models";

export type TemaAtencion = "produccion" | "guiones" | "atencion";

export interface PersonaAtencion {
  nombre: string;
  email: string;
}

/**
 * Quien atiende a los clientes por tema. Es igual para todos los entornos: en
 * el CRM ningun contacto tiene dueño asignado, asi que la persona no se puede
 * deducir por cliente. Se nombra siempre con nombre y apellido.
 *
 * Los correos salen directo de aqui (no dependen de que la persona tenga
 * usuario en la plataforma); la notificacion in-app llega solo a quien lo tenga.
 */
export const EQUIPO_ATENCION: Record<TemaAtencion, { etiqueta: string; personas: PersonaAtencion[] }> = {
  produccion: {
    etiqueta: "producción",
    personas: [
      { nombre: "Karen Muñoz", email: "kmunoz@bakano.ec" },
      { nombre: "Jean Ortega", email: "jortega@bakano.ec" },
    ],
  },
  guiones: {
    etiqueta: "revisión de guiones",
    personas: [{ nombre: "Ari Vera", email: "avera@bakano.ec" }],
  },
  atencion: {
    etiqueta: "atención al cliente",
    personas: [{ nombre: "Genesis Benalcazar", email: "gbenalcazar@bakano.ec" }],
  },
};

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
