import { Types } from "mongoose";
import models from "../models";

/**
 * Ventas privadas por entorno. Por defecto todos los usuarios del entorno ven
 * su facturación, ROAS y meta del mes. Si el cliente la vuelve privada, solo
 * las personas que él elige (`visiblePara`) la ven y la reciben: web, correos
 * y Telegram. El equipo de Bakano la sigue viendo (opera la pauta con ella).
 */
export interface ConfigFacturacionPrivada {
  activa: boolean;
  visiblePara: string[];
}

interface UsuarioLike {
  _id?: unknown;
  role?: string;
  isInternal?: boolean;
}

class FacturacionPrivadaService {
  async config(workspaceId: unknown): Promise<ConfigFacturacionPrivada> {
    if (!workspaceId || !Types.ObjectId.isValid(String(workspaceId))) return { activa: false, visiblePara: [] };
    const ws: any = await models.workspaces.findById(workspaceId).select("facturacionPrivada").lean();
    const fp = ws?.facturacionPrivada;
    return { activa: fp?.activa === true, visiblePara: (fp?.visiblePara ?? []).map(String) };
  }

  /** Sin config cargada: la lee. Para listas, usar `filtro`. */
  async puedeVer(usuario: UsuarioLike | null | undefined, workspaceId: unknown): Promise<boolean> {
    return (await this.filtro(workspaceId))(usuario);
  }

  /**
   * Una función que dice si cada usuario (o userId) puede ver las ventas del
   * entorno. Lee la config una sola vez: sirve para filtrar destinatarios.
   * Un userId suelto sin datos de rol se trata como cliente.
   */
  async filtro(workspaceId: unknown): Promise<(usuario: UsuarioLike | string | null | undefined) => boolean> {
    const cfg = await this.config(workspaceId);
    if (!cfg.activa) return () => true;
    const permitidos = new Set(cfg.visiblePara);
    return (usuario) => {
      if (!usuario) return false;
      if (typeof usuario === "string") return permitidos.has(usuario);
      if (usuario.role === "superadmin" || usuario.isInternal === true) return true;
      return permitidos.has(String(usuario._id));
    };
  }

  /** Un chat de Telegram (cliente en su entorno) puede ver o registrar ventas. */
  async chatPuede(chat: { workspaceId?: unknown; userId?: unknown }): Promise<boolean> {
    const cfg = await this.config(chat.workspaceId);
    if (!cfg.activa) return true;
    if (!chat.userId) return false;
    const u: any = await models.users.findById(chat.userId).select("role isInternal").lean();
    return (await this.filtro(chat.workspaceId))(u ? { ...u, _id: chat.userId } : String(chat.userId));
  }

  readonly MENSAJE_PRIVADA =
    "La facturación de este negocio es privada: solo la ven y la registran las personas que eligió el administrador. Si necesitas verla, pídeselo a él.";

  /**
   * Entornos con facturación privada → userIds del cliente que la ven. Para
   * los envíos masivos (Telegram): una sola consulta. Los chats del equipo ya
   * se descartan antes; aquí un chat sin usuario no la recibe.
   */
  async privadas(): Promise<Map<string, Set<string>>> {
    const ws: any[] = await models.workspaces.find({ "facturacionPrivada.activa": true }).select("facturacionPrivada.visiblePara").lean();
    return new Map(ws.map((w) => [String(w._id), new Set<string>((w.facturacionPrivada?.visiblePara ?? []).map(String))]));
  }

  /** El chat de ese usuario puede recibir las ventas de ese entorno. */
  chatPuedeVer(privadas: Map<string, Set<string>>, workspaceId: unknown, userId: unknown): boolean {
    const permitidos = privadas.get(String(workspaceId));
    return !permitidos || (Boolean(userId) && permitidos.has(String(userId)));
  }
}

export const facturacionPrivadaService = new FacturacionPrivadaService();
