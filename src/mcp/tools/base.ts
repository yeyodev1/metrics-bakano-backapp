import { Types } from "mongoose";
import type { ZodRawShape } from "zod";
import models from "../../models";
import type { PerfilMcp, UsuarioMcp } from "../perfiles";

/**
 * Una tool del MCP. `perfiles` decide quién la ve; la descripción es lo único
 * que el modelo lee, así que tiene que decir la verdad sobre qué hace y a
 * quién avisa.
 */
export interface ToolMcp {
  nombre: string;
  titulo: string;
  descripcion: string;
  perfiles: PerfilMcp[];
  /** Cambia datos o avisa a alguien. Claude pide confirmación antes. */
  escribe?: boolean;
  /** Borra o corta algo que no se deshace solo. Claude lo trata con más cuidado. */
  destructiva?: boolean;
  /**
   * Solo superadmin, no todo el perfil Dirección: un director (internalRole)
   * también es Dirección, pero en la plataforma estas acciones son de superadmin.
   */
  soloSuperadmin?: boolean;
  entrada: ZodRawShape;
  correr: (args: any, u: UsuarioMcp) => Promise<unknown>;
}

/** Lo que decide si una tool aparece para esta persona. */
export function leToca(tool: ToolMcp, u: UsuarioMcp): boolean {
  if (!tool.perfiles.includes(u.perfil)) return false;
  return !tool.soloSuperadmin || u.role === "superadmin";
}

export const ZONA = "America/Guayaquil";

export function fecha(d?: Date | string | null, conHora = true): string | null {
  if (!d) return null;
  const f = new Date(d);
  if (Number.isNaN(f.getTime())) return null;
  return f.toLocaleString("es-EC", {
    timeZone: ZONA,
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(conHora ? { hour: "2-digit", minute: "2-digit" } : {}),
  });
}

/**
 * "2026-10-03" o "2026-10-03T10:00" se leen en hora de Ecuador (UTC-5, sin
 * horario de verano). Con zona explícita se respeta la que venga.
 */
export function leerFecha(texto: string): Date {
  const t = String(texto || "").trim();
  const conZona = /(Z|[+-]\d{2}:?\d{2})$/.test(t);
  const base = /^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T09:00` : t;
  const d = new Date(conZona ? base : `${base}-05:00`);
  if (Number.isNaN(d.getTime())) throw new Error(`No entiendo la fecha "${texto}". Usa AAAA-MM-DD o AAAA-MM-DDTHH:mm.`);
  return d;
}

function escaparRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Encuentra un cliente (entorno) por id o por nombre. Si el nombre es
 * ambiguo no adivina: devuelve las opciones para que la persona elija.
 */
export async function resolverCliente(texto: string): Promise<{ _id: Types.ObjectId; name: string }> {
  const t = String(texto || "").trim();
  if (!t) throw new Error("Dime qué cliente.");
  if (Types.ObjectId.isValid(t) && t.length === 24) {
    const ws = await models.workspaces.findById(t).select("name").lean();
    if (ws) return ws as any;
  }
  const exacto = await models.workspaces
    .find({ name: new RegExp(`^${escaparRegex(t)}$`, "i") })
    .select("name isActive")
    .lean();
  if (exacto.length === 1) return exacto[0] as any;
  const parecidos = await models.workspaces
    .find({ name: new RegExp(escaparRegex(t), "i") })
    .select("name isActive")
    .sort({ isActive: -1, name: 1 })
    .limit(10)
    .lean();
  const activos = parecidos.filter((w: any) => w.isActive !== false);
  if (activos.length === 1) return activos[0] as any;
  if (!parecidos.length) throw new Error(`No encontré ningún cliente que se llame "${t}". Prueba con buscar_clientes.`);
  throw new Error(
    `"${t}" coincide con varios clientes: ${parecidos.map((w: any) => `${w.name} (${w._id})`).join(", ")}. Dime cuál.`
  );
}

export function recortar(texto: string | undefined | null, max = 400): string | undefined {
  if (!texto) return undefined;
  return texto.length > max ? `${texto.slice(0, max)}…` : texto;
}
