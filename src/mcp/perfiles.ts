import type { InternalRole } from "../models/user.model";

/**
 * Perfil con el que cada persona usa el MCP. Sale del rol interno de la
 * plataforma y decide qué tools ve: una tool que no te toca ni aparece en la
 * lista, así el modelo no puede ofrecértela ni razonar sobre permisos falsos.
 *
 * - direccion: superadmin. Todo.
 * - pm: relación con el cliente, calendario, onboarding, Telegram completo.
 * - contenido: guiones, referencias y feedback; Telegram solo en lo de guiones.
 * - produccion: producciones y su calendario.
 * - edicion: videos por editar y su revisión.
 * - campanas: métricas y pauta.
 * - equipo: el resto del equipo interno, solo consulta.
 */
export type PerfilMcp = "direccion" | "pm" | "contenido" | "produccion" | "edicion" | "campanas" | "equipo";

export const NOMBRE_PERFIL: Record<PerfilMcp, string> = {
  direccion: "Dirección",
  pm: "Project Manager",
  contenido: "Contenido",
  produccion: "Producción",
  edicion: "Edición",
  campanas: "Campañas",
  equipo: "Equipo",
};

const POR_ROL: Partial<Record<InternalRole, PerfilMcp>> = {
  director: "direccion",
  project_manager: "pm",
  account_manager: "pm",
  content_manager: "contenido",
  community_manager: "contenido",
  estratega: "contenido",
  copywriter: "contenido",
  productor: "produccion",
  asistente_produccion: "produccion",
  editor: "edicion",
  disenador: "edicion",
  trafficker: "campanas",
};

export interface UsuarioMcp {
  _id: string;
  email: string;
  nombre: string;
  role: string;
  isInternal: boolean;
  internalRole?: string | null;
  perfil: PerfilMcp;
}

/** null = no es del equipo interno: no entra al MCP. */
export function perfilDe(u: { role?: string; isInternal?: boolean; internalRole?: string | null; isActive?: boolean }): PerfilMcp | null {
  if (u.isActive === false) return null;
  if (u.role === "superadmin") return "direccion";
  if (u.isInternal !== true) return null;
  return POR_ROL[u.internalRole as InternalRole] ?? "equipo";
}

/** Atajo para declarar a quién le toca cada tool. */
export const TODOS: PerfilMcp[] = ["direccion", "pm", "contenido", "produccion", "edicion", "campanas", "equipo"];
