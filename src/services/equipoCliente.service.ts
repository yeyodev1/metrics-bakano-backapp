import crypto from "crypto";
import { Types } from "mongoose";
import models from "../models";
import type { BotAcceso } from "../models/user.model";
import { WorkspaceService, normalizarBots } from "./workspace.service";
import { resendService } from "./resend.service";
import { normalizarTelefono } from "../utils/telefono";
import { correoBloqueado } from "../utils/contactosBloqueados";

/**
 * El admin del cliente maneja su equipo desde el chat: ve quién entra a cada
 * entorno suyo y agrega o cambia personas (rol y a qué agentes entran:
 * Bakano People, Lucas o los dos), cuando quiera. Es lo mismo que puede hacer
 * en metrics.bakano.ec → Configuración, con las mismas reglas y los mismos
 * correos de acceso (workspaceService.createUser / updateUser).
 *
 * Solo en los entornos donde ES admin. No puede tocar al equipo de Bakano ni
 * quitar personas (eso sigue en la plataforma, con su confirmación).
 */

const workspaceService = new WorkspaceService();

export interface EntornoAdmin {
  id: string;
  nombre: string;
}

function contrasenaFacil(): string {
  const letras = "abcdefghjkmnpqrstuvwxyz23456789";
  const t = Array.from(crypto.randomBytes(12), (b) => letras[b % letras.length]).join("");
  return `${t.slice(0, 4)}-${t.slice(4, 8)}-${t.slice(8, 12)}`;
}

const NOMBRE_AGENTE: Record<BotAcceso, string> = { bakano: "Bakano People", lucas: "Lucas" };

export function agentesEnTexto(bots: BotAcceso[]): string {
  return bots.map((b) => NOMBRE_AGENTE[b]).join(" y ");
}

class EquipoClienteService {
  /** Entornos activos donde esta persona es admin. */
  async entornosDondeEsAdmin(userId: Types.ObjectId | string | undefined): Promise<EntornoAdmin[]> {
    if (!userId) return [];
    const u: any = await models.users.findById(userId).select("role workspaces workspaceId isInternal").lean();
    if (!u) return [];
    const ids = new Set<string>();
    for (const w of u.workspaces || []) if (w.role === "admin") ids.add(String(w.workspaceId));
    if (u.workspaceId && u.role === "admin" && !(u.workspaces || []).some((w: any) => String(w.workspaceId) === String(u.workspaceId))) {
      ids.add(String(u.workspaceId));
    }
    if (!ids.size) return [];
    const ws = await models.workspaces
      .find({ _id: { $in: [...ids].map((i) => new Types.ObjectId(i)) }, isActive: { $ne: false } })
      .select("name")
      .sort({ name: 1 })
      .lean();
    return ws.map((w: any) => ({ id: String(w._id), nombre: w.name }));
  }

  /**
   * El entorno sobre el que se actua: el que nombra (por nombre o id) entre
   * los suyos, o el del chat. Lanza un error en palabras si no es admin ahi.
   */
  async resolver(userId: Types.ObjectId | string | undefined, actual: Types.ObjectId | string | undefined, pedido?: string): Promise<EntornoAdmin> {
    const suyos = await this.entornosDondeEsAdmin(userId);
    if (!suyos.length) throw new Error("no_es_admin");
    const t = String(pedido || "").trim().toLowerCase();
    if (t) {
      const exacto = suyos.find((w) => w.id === t || w.nombre.toLowerCase() === t);
      if (exacto) return exacto;
      const parecidos = suyos.filter((w) => w.nombre.toLowerCase().includes(t));
      if (parecidos.length === 1) return parecidos[0]!;
      throw new Error(parecidos.length ? `ambiguo:${parecidos.map((w) => w.nombre).join(", ")}` : `no_es_suyo:${suyos.map((w) => w.nombre).join(", ")}`);
    }
    const delChat = suyos.find((w) => w.id === String(actual));
    if (delChat) return delChat;
    if (suyos.length === 1) return suyos[0]!;
    throw new Error(`elegir:${suyos.map((w) => w.nombre).join(", ")}`);
  }

  /** Quién entra a ese entorno, con su rol y sus agentes. Sin el equipo de Bakano. */
  async personas(workspaceId: string) {
    const users = (await workspaceService.listUsersByWorkspace(workspaceId)) as any[];
    return users
      .filter((u) => !u.isInternal && u.role !== "superadmin" && !/@bakano\.ec$/i.test(u.email || ""))
      .map((u) => ({
        nombre: [u.name, u.lastName].filter(Boolean).join(" ") || null,
        correo: u.email,
        rol: u.role === "admin" ? "administrador" : "colaborador",
        agentes: agentesEnTexto(u.bots || ["bakano", "lucas"]),
      }));
  }

  /** Agrega a alguien a un entorno suyo. Mismas reglas y correos que la plataforma. */
  async agregar(
    workspaceId: string,
    datos: { correo: string; nombre?: string; telefono?: string; prefijoPais?: string; rol: "admin" | "colaborador"; bots: BotAcceso[] }
  ): Promise<{ ok: true; resumen: string; cuentaNueva: boolean } | { ok: false; motivo: string }> {
    const correo = String(datos.correo || "").toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return { ok: false, motivo: "Ese correo no se ve bien: pídeselo completo." };
    if (/@bakano\.ec$/i.test(correo)) return { ok: false, motivo: "Es un correo del equipo de Bakano: a ellos los agrega Bakano." };
    if (await correoBloqueado(correo)) return { ok: false, motivo: "A ese correo no se le puede dar acceso." };
    const bots = normalizarBots(datos.bots);
    const existe: any = await models.users.findOne({ email: correo }).select("name role isInternal phoneNumber").lean();
    if (existe?.role === "superadmin" || existe?.isInternal) return { ok: false, motivo: "Es alguien del equipo de Bakano: a ellos los agrega Bakano." };

    let password: string | undefined;
    if (!existe) {
      if (bots.includes("bakano") && !datos.nombre) return { ok: false, motivo: "falta_nombre" };
      if (bots.includes("bakano") && !datos.telefono) return { ok: false, motivo: "falta_telefono" };
      password = contrasenaFacil();
    }
    if (datos.telefono) {
      const tel = normalizarTelefono(String(datos.telefono), datos.prefijoPais || "593");
      if (!tel.valido) return { ok: false, motivo: tel.error || "Ese teléfono no es válido: pídeselo con el código de país si no es de Ecuador." };
    }
    // Ya tiene cuenta y entra a Bakano: el alta exige teléfono; si ya lo tiene, se usa ese.
    const telefono = datos.telefono || (existe?.phoneNumber ? String(existe.phoneNumber) : undefined);
    if (bots.includes("bakano") && !telefono) return { ok: false, motivo: "falta_telefono" };

    try {
      await workspaceService.createUser({
        name: datos.nombre ?? existe?.name,
        email: correo,
        password: password as string,
        role: datos.rol,
        workspaceId,
        ...(telefono ? { phoneNumber: telefono, phoneExtension: datos.telefono ? datos.prefijoPais || "593" : undefined } : {}),
        bots,
      } as any);
    } catch (error: any) {
      if (error?.message === "EMAIL_TAKEN") return { ok: false, motivo: "Esa persona ya tiene acceso a este entorno. Si quieres, le cambio el rol o los agentes." };
      throw error;
    }
    // La bienvenida de Metrics (con su contraseña) es parte del acceso de Bakano.
    if (password && bots.includes("bakano")) {
      await resendService
        .sendWelcomeEmail({ to: correo, recipientName: datos.nombre, email: correo, password, isInternal: false })
        .catch((e: any) => console.error("[Equipo cliente] bienvenida:", e?.message || e));
    }
    return {
      ok: true,
      cuentaNueva: !existe,
      resumen: `Listo: ${datos.nombre || correo} entra como ${datos.rol === "admin" ? "administrador" : "colaborador"} a ${agentesEnTexto(bots)}. Le llega el acceso a su correo (${correo}).`,
    };
  }

  /** Cambia el rol o los agentes de alguien de su entorno. Le llega el acceso a lo nuevo. */
  async cambiar(
    workspaceId: string,
    datos: { correo: string; rol?: "admin" | "colaborador"; bots?: BotAcceso[] }
  ): Promise<{ ok: true; resumen: string } | { ok: false; motivo: string }> {
    const correo = String(datos.correo || "").toLowerCase().trim();
    const u: any = await models.users
      .findOne({
        email: correo,
        $or: [{ "workspaces.workspaceId": new Types.ObjectId(workspaceId) }, { workspaceId: new Types.ObjectId(workspaceId) }],
      })
      .select("_id name isInternal role")
      .lean();
    if (!u) return { ok: false, motivo: "Esa persona no tiene acceso a este entorno. Si quieres, la agrego." };
    if (u.isInternal || u.role === "superadmin") return { ok: false, motivo: "Es alguien del equipo de Bakano: eso lo maneja Bakano." };
    if (!datos.rol && !datos.bots?.length) return { ok: false, motivo: "Dime qué le cambio: el rol o los agentes." };
    await workspaceService.updateUser(workspaceId, String(u._id), {
      ...(datos.rol ? { role: datos.rol } : {}),
      ...(datos.bots?.length ? { bots: normalizarBots(datos.bots) } : {}),
    } as any);
    const partes = [
      datos.rol ? `ahora es ${datos.rol === "admin" ? "administrador" : "colaborador"}` : "",
      datos.bots?.length ? `entra a ${agentesEnTexto(normalizarBots(datos.bots))}` : "",
    ].filter(Boolean);
    return { ok: true, resumen: `Listo: ${u.name || correo} ${partes.join(" y ")}.` };
  }
}

export const equipoClienteService = new EquipoClienteService();
