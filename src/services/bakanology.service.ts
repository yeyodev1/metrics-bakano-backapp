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
  async darAcceso(datos: { email: string; nombre?: string; apellido?: string }): Promise<boolean> {
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
      return true;
    } catch (error: any) {
      console.error("[Bakanology] no se pudo dar el acceso:", error.response?.data || error.message);
      return false;
    }
  }

  /** Desde el alta de un usuario: no se espera, no bloquea la respuesta. */
  enSegundoPlano(userId: Types.ObjectId | string): void {
    models.users
      .findById(userId)
      .select("name email isInternal isActive")
      .lean()
      .then((u: any) => {
        if (!u?.email || !u.isActive) return;
        if (u.isInternal || String(u.email).toLowerCase().endsWith("@bakano.ec")) return;
        const partes = String(u.name || "").trim().split(/\s+/);
        return this.darAcceso({
          email: u.email,
          nombre: partes[0] || undefined,
          apellido: partes.slice(1).join(" ") || undefined,
        });
      })
      .catch((error: any) => console.error("[Bakanology] alta:", error?.message || error));
  }
}

export const bakanologyService = new BakanologyService();
