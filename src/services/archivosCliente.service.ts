import { Types } from "mongoose";
import models from "../models";
import cloudinary from "../config/cloudinary";
import type { ITelegramChat } from "../models/telegramChat.model";
import type { ArchivoDeTelegram } from "./telegram.service";
import { onboardingDatosService } from "./onboardingDatos.service";

/**
 * Archivos que el cliente manda POR EL CHAT.
 *
 * Mandar el logo por Telegram es lo natural para el cliente, pero el archivo
 * tiene que terminar en su entorno de metrics.bakano.ec (es lo que usan los
 * guiones y las piezas), no perdido en una conversacion. Aqui se valida, se
 * sube a Cloudinary y se guarda en `workspace.resources`, igual que si lo
 * hubiera subido desde la plataforma.
 */

export type CategoriaRecurso = "logo" | "linea_grafica" | "catalogo" | "otro";

const TIPOS_PERMITIDOS = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"];
/** Lo que el bot pidió caduca: un archivo de mañana no es la respuesta de hoy. */
export const ESPERA_ARCHIVO_MS = 2 * 60 * 60_000;
const MAX_BYTES = 10 * 1024 * 1024;

export const ETIQUETA_CATEGORIA: Record<CategoriaRecurso, string> = {
  logo: "logo",
  linea_grafica: "línea gráfica",
  catalogo: "catálogo",
  otro: "archivo",
};

/** Entregable del onboarding que queda cubierto al subir cada cosa. */
const ENTREGABLE_DE: Partial<Record<CategoriaRecurso, string>> = {
  logo: "archivosMarca",
  linea_grafica: "archivosMarca",
  catalogo: "catalogo",
};

export type ResultadoArchivo =
  | { ok: true; categoria: CategoriaRecurso; nombre: string; recursoId: string; preguntarCategoria: boolean }
  | { ok: false; motivo: "sin_entorno" | "tipo" | "peso" | "logo_no_png" | "logo_comprimido" | "error" };

class ArchivosClienteService {
  /**
   * "te mando mi logo" → logo. Si no queda claro, se le pregunta con botones.
   *
   * Se quitan los acentos ANTES de comparar: con la tilde, "catálogo" tiene
   * un borde de palabra antes de "logo" y el catálogo se guardaba como logo.
   */
  categoriaPorTexto(texto?: string): CategoriaRecurso | null {
    const t = (texto || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
    if (/catalogo|lista de precios|\bprecios\b|\bmenu\b|\bcarta\b/.test(t)) return "catalogo";
    if (/\blogo(s|tipo)?\b|isotipo|imagotipo/.test(t)) return "logo";
    if (/linea grafica|manual de marca|identidad|tipograf|colores|paleta/.test(t)) return "linea_grafica";
    return null;
  }

  /** El bot queda esperando ese tipo de archivo. */
  async pedirArchivo(chat: ITelegramChat, categoria: CategoriaRecurso): Promise<void> {
    const dato = { categoria, pedidoEn: new Date() };
    await models.telegramChats.updateOne({ _id: chat._id }, { $set: { archivoEsperado: dato } });
    chat.archivoEsperado = dato;
  }

  /** Qué archivo está esperando el bot, si el pedido sigue vigente. */
  esperando(chat: ITelegramChat): CategoriaRecurso | null {
    const e = chat.archivoEsperado;
    if (!e?.categoria || !e.pedidoEn) return null;
    if (Date.now() - new Date(e.pedidoEn).getTime() > ESPERA_ARCHIVO_MS) return null;
    return e.categoria as CategoriaRecurso;
  }

  async olvidarPedido(chat: ITelegramChat): Promise<void> {
    await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { archivoEsperado: 1 } });
    chat.archivoEsperado = undefined;
  }

  /** El catálogo escrito a mano en el chat se guarda como archivo de texto. */
  async guardarTexto(chat: ITelegramChat, texto: string, categoria: CategoriaRecurso): Promise<ResultadoArchivo> {
    return this.guardar(
      chat,
      {
        buffer: Buffer.from(texto, "utf8"),
        nombre: `${categoria}-${new Date().toISOString().slice(0, 10)}.txt`,
        mime: "text/plain",
        comprimido: false,
      },
      categoria
    );
  }

  async guardar(
    chat: ITelegramChat,
    archivo: ArchivoDeTelegram,
    categoria: CategoriaRecurso | null
  ): Promise<ResultadoArchivo> {
    if (!chat.workspaceId) return { ok: false, motivo: "sin_entorno" };
    if (!TIPOS_PERMITIDOS.includes(archivo.mime)) return { ok: false, motivo: "tipo" };
    if (archivo.buffer.length > MAX_BYTES) return { ok: false, motivo: "peso" };

    // El logo va a los videos y a las piezas: se necesita PNG. Una foto que
    // Telegram comprimio llega como JPG y pierde la transparencia, asi que se
    // le pide que la mande "como archivo".
    if (categoria === "logo") {
      if (archivo.comprimido) return { ok: false, motivo: "logo_comprimido" };
      if (archivo.mime !== "image/png") return { ok: false, motivo: "logo_no_png" };
    }

    // Si no dijo qué es, se guarda como "otro" y después se le pregunta: así
    // el archivo nunca se pierde por no saber en qué cajón va.
    const destino: CategoriaRecurso = categoria ?? "otro";
    try {
      const esPdf = archivo.mime === "application/pdf";
      const esTexto = archivo.mime === "text/plain";
      const subido = await new Promise<{ url: string; public_id: string }>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: `resources/${chat.workspaceId}`,
            resource_type: esPdf || esTexto ? "raw" : "image",
            ...(esPdf ? { public_id: `${destino}-${Date.now()}.pdf` } : {}),
            ...(esTexto ? { public_id: `${destino}-${Date.now()}.txt` } : {}),
          },
          (error, result) => (error || !result ? reject(error) : resolve({ url: result.secure_url, public_id: result.public_id }))
        );
        stream.end(archivo.buffer);
      });

      const recurso = {
        _id: new Types.ObjectId(),
        nombre: archivo.nombre,
        url: subido.url,
        publicId: subido.public_id,
        tipo: archivo.mime,
        categoria: destino,
        uploadedBy: chat.userId,
        createdAt: new Date(),
      };
      await models.workspaces.updateOne({ _id: chat.workspaceId }, { $push: { resources: recurso as any } });
      if (categoria) await this.marcarEntregable(chat, destino, archivo.nombre);

      return { ok: true, categoria: destino, nombre: archivo.nombre, recursoId: String(recurso._id), preguntarCategoria: !categoria };
    } catch (error: any) {
      console.error("[Archivos] no se pudo guardar:", error?.message || error);
      return { ok: false, motivo: "error" };
    }
  }

  /**
   * El cliente dice qué era el archivo que ya subimos como "otro". Cambiar a
   * logo exige PNG: si mandó un JPG, se queda donde está y se le explica.
   */
  async recategorizar(
    chat: ITelegramChat,
    recursoId: string,
    categoria: CategoriaRecurso
  ): Promise<{ ok: boolean; motivo?: "no_encontrado" | "logo_no_png"; nombre?: string }> {
    if (!Types.ObjectId.isValid(recursoId)) return { ok: false, motivo: "no_encontrado" };
    const workspace = await models.workspaces.findById(chat.workspaceId).select("resources").lean();
    const recurso = (workspace?.resources || []).find((r: any) => String(r._id) === recursoId) as any;
    if (!recurso) return { ok: false, motivo: "no_encontrado" };
    if (categoria === "logo" && recurso.tipo !== "image/png") return { ok: false, motivo: "logo_no_png", nombre: recurso.nombre };

    await models.workspaces.updateOne(
      { _id: chat.workspaceId, "resources._id": new Types.ObjectId(recursoId) },
      { $set: { "resources.$.categoria": categoria } }
    );
    await this.marcarEntregable(chat, categoria, recurso.nombre);
    return { ok: true, nombre: recurso.nombre };
  }

  /** Subir por el chat cuenta igual que subir por la plataforma. */
  private async marcarEntregable(chat: ITelegramChat, categoria: CategoriaRecurso, nombre: string): Promise<void> {
    const clave = ENTREGABLE_DE[categoria];
    if (!clave) return;
    await onboardingDatosService
      .registrarEntregable(chat, clave, `Subido por Telegram: ${nombre}`)
      .catch((error: any) => console.error("[Archivos] no se pudo registrar el entregable:", error?.message || error));
  }
}

export const archivosClienteService = new ArchivosClienteService();
