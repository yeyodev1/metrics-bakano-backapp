import axios from "axios";
import { Types } from "mongoose";
import models from "../models";

/**
 * Acceso a Bakanology para los clientes.
 *
 * Bakanology es la academia: como vender, como hablarle a un cliente, como
 * leer sus numeros. El cliente contrata y desde ese momento la tiene, sin que
 * nadie tenga que acordarse de darle el acceso a mano.
 *
 * Se llama a la API de la academia servidor a servidor con una clave
 * compartida; alla se crea la cuenta (o se le extiende el acceso si ya la
 * tenia) y sale el correo con sus datos.
 */

const BAKANOLOGY_API = (process.env.BAKANOLOGY_API_URL || "https://bakanology-backapp.vercel.app").replace(/\/$/, "");
const CLAVE = process.env.BAKANOLOGY_KEY || "";
const MESES = Number(process.env.BAKANOLOGY_MESES) > 0 ? Number(process.env.BAKANOLOGY_MESES) : 12;

class BakanologyService {
  configurado(): boolean {
    return Boolean(CLAVE);
  }

  /** Le da acceso a la academia. No revienta nada si falla: se anota y sigue. */
  async darAcceso(datos: { email: string; nombre?: string; apellido?: string; userId?: Types.ObjectId | string }): Promise<boolean> {
    if (!this.configurado()) {
      console.warn("[Bakanology] sin BAKANOLOGY_KEY: no se pidió el acceso para", datos.email);
      return false;
    }
    try {
      const { data } = await axios.post(
        `${BAKANOLOGY_API}/api/admin/acceso-cliente`,
        { email: datos.email, name: datos.nombre, lastName: datos.apellido, months: MESES },
        { headers: { "x-bakano-key": CLAVE }, timeout: 15_000 }
      );
      console.log(`[Bakanology] acceso ${data?.data?.accion || "ok"} para ${datos.email}`);
      if (datos.userId) {
        await models.users.updateOne({ _id: datos.userId }, { $set: { accesoBakanologyEn: new Date() } }).catch(() => undefined);
      }
      return true;
    } catch (error: any) {
      console.error("[Bakanology] no se pudo dar el acceso:", error.response?.data || error.message);
      return false;
    }
  }

  /**
   * Desde el alta de un usuario.
   *
   * Se ESPERA a proposito. En Vercel la funcion se congela apenas responde, y
   * una promesa suelta se queda sin ejecutar: asi fue como alguien entro a un
   * entorno y nunca recibio su acceso. Son un par de segundos y el alta ya de
   * por si tarda mas que eso.
   */
  async alDarDeAlta(userId: Types.ObjectId | string): Promise<boolean> {
    try {
      const u: any = await models.users.findById(userId).select("name email isInternal isActive").lean();
      if (!u?.email || !u.isActive) return false;
      if (u.isInternal || String(u.email).toLowerCase().endsWith("@bakano.ec")) return false;
      const partes = String(u.name || "").trim().split(/\s+/);
      return await this.darAcceso({
        email: u.email,
        nombre: partes[0] || undefined,
        apellido: partes.slice(1).join(" ") || undefined,
        userId,
      });
    } catch (error: any) {
      console.error("[Bakanology] alta:", error?.message || error);
      return false;
    }
  }

  /**
   * Los que quedaron sin acceso: altas de antes de esto, o llamadas que se
   * perdieron. Se revisa a diario para que nadie se quede afuera en silencio.
   */
  async alcanzarPendientes(maximo = 15): Promise<{ pendientes: number; otorgados: number }> {
    const activos = await models.workspaces.find({ isActive: true }).select("_id").lean();
    const ids = activos.map((w) => w._id);

    const usuarios = await models.users
      .find({
        isActive: true,
        isInternal: { $ne: true },
        accesoBakanologyEn: { $exists: false },
        $or: [{ workspaceId: { $in: ids } }, { "workspaces.workspaceId": { $in: ids } }],
      })
      .select("name email")
      .lean();

    const candidatos = (usuarios as any[]).filter((u) => u.email && !String(u.email).toLowerCase().endsWith("@bakano.ec"));
    let otorgados = 0;
    for (const u of candidatos.slice(0, maximo)) {
      const partes = String(u.name || "").trim().split(/\s+/);
      const ok = await this.darAcceso({
        email: u.email,
        nombre: partes[0] || undefined,
        apellido: partes.slice(1).join(" ") || undefined,
        userId: u._id,
      });
      if (ok) otorgados++;
      await new Promise((r) => setTimeout(r, 600));
    }
    return { pendientes: candidatos.length, otorgados };
  }
}

export const bakanologyService = new BakanologyService();
