import { Types } from "mongoose";
import models from "../models";
import { slackService } from "./slack.service";
import { equipoAtencionService } from "./equipoAtencion.service";

/**
 * Lo que el cliente quiere destacar: un producto, un servicio, una promo nueva.
 *
 * Contenido planifica sobre esto. Antes habia que escribirle al cliente para
 * preguntarle; ahora el bot se lo pregunta cada tres semanas, el cliente lo
 * cuenta cuando quiera, y Ariana lo ve desde Claude o en la planificacion.
 */

/** Cada cuanto el bot le pregunta. */
export const DIAS_ENTRE_PREGUNTAS = 21;
/** Tope por corrida del cron: el dia que se despliega no se le escribe a todos juntos. */
const MAXIMO_POR_CORRIDA = 15;

export interface Destacado {
  texto: string;
  en: Date;
  porNombre?: string;
  fuente: "cliente" | "equipo";
}

export const PREGUNTA_DESTACAR =
  "📣 <b>¿Qué quieres que destaquemos en las próximas semanas?</b>\n\n" +
  "Un producto, un servicio, una promo nueva o algo de temporada. Cuéntamelo por aquí y lo usamos para armar tus próximos guiones ✍️";

class DestacarClienteService {
  /** Guarda lo que hay que destacar y avisa a contenido. */
  async guardar(workspaceId: Types.ObjectId | string, texto: string, quien: { nombre?: string; fuente: "cliente" | "equipo" }) {
    const limpio = texto.trim().slice(0, 1000);
    if (!limpio) return { ok: false as const, motivo: "vacio" };
    const destacado: Destacado = { texto: limpio, en: new Date(), porNombre: quien.nombre, fuente: quien.fuente };
    const ws = await models.workspaces.findOneAndUpdate(
      { _id: workspaceId },
      { $set: { "destacar.actual": destacado }, $push: { "destacar.historial": { $each: [destacado], $slice: -12 } } },
      { new: true }
    )
      .select("name")
      .lean();
    if (!ws) return { ok: false as const, motivo: "sin_entorno" };

    await slackService
      .avisarEquipo({
        titulo: `📣 ${ws.name} quiere destacar algo`,
        detalle: `${limpio}\n${quien.fuente === "cliente" ? "Lo contó el cliente por el bot" : `Lo registró ${quien.nombre || "el equipo"}`}`,
        correos: equipoAtencionService.correos("guiones"),
      })
      .catch((error) => console.error("[Destacar] Slack:", error?.message || error));
    return { ok: true as const };
  }

  /** Lo actual de un cliente y su historial reciente. */
  async de(workspaceId: Types.ObjectId | string): Promise<{ actual?: Destacado; historial: Destacado[]; preguntadoEn?: Date }> {
    const ws: any = await models.workspaces.findById(workspaceId).select("destacar").lean();
    return {
      actual: ws?.destacar?.actual,
      historial: [...(ws?.destacar?.historial || [])].reverse(),
      preguntadoEn: ws?.destacar?.preguntadoEn,
    };
  }

  /** Todos los clientes con algo por destacar reciente, lo mas nuevo primero. */
  async recientes(dias = 45): Promise<{ workspaceId: string; cliente: string; destacado: Destacado }[]> {
    const desde = new Date(Date.now() - dias * 86_400_000);
    const lista: any[] = await models.workspaces
      .find({ isActive: true, "destacar.actual.en": { $gte: desde } })
      .select("name destacar.actual")
      .lean();
    return lista
      .map((w) => ({ workspaceId: String(w._id), cliente: w.name, destacado: w.destacar.actual as Destacado }))
      .sort((a, b) => new Date(b.destacado.en).getTime() - new Date(a.destacado.en).getTime());
  }

  /**
   * El cron: a quien no se le pregunto hace tres semanas, se le pregunta. Solo
   * a clientes (no al equipo que tenga el bot conectado) y con tope diario.
   */
  async preguntarPendientes(): Promise<{ candidatos: number; preguntados: number }> {
    const { telegramService } = await import("./telegram.service");
    const limite = new Date(Date.now() - DIAS_ENTRE_PREGUNTAS * 86_400_000);

    const chats = await models.telegramChats
      .find({ estado: "listo", workspaceId: { $ne: null } })
      .select("chatId workspaceId userId")
      .lean();
    const internos = new Set(
      (
        await models.users
          .find({ _id: { $in: chats.map((c) => c.userId).filter(Boolean) }, $or: [{ isInternal: true }, { role: "superadmin" }] })
          .select("_id")
          .lean()
      ).map((u) => String(u._id))
    );
    const porEntorno = new Map<string, any[]>();
    for (const c of chats) {
      if (c.userId && internos.has(String(c.userId))) continue;
      porEntorno.set(String(c.workspaceId), [...(porEntorno.get(String(c.workspaceId)) || []), c]);
    }

    const candidatos: any[] = await models.workspaces
      .find({
        _id: { $in: [...porEntorno.keys()].map((id) => new Types.ObjectId(id)) },
        isActive: true,
        $and: [
          { $or: [{ "destacar.preguntadoEn": { $exists: false } }, { "destacar.preguntadoEn": { $lte: limite } }] },
          // Si ya lo contó hace poco, no se le pregunta de nuevo.
          { $or: [{ "destacar.actual.en": { $exists: false } }, { "destacar.actual.en": { $lte: limite } }] },
        ],
      })
      .sort({ "destacar.preguntadoEn": 1 })
      .limit(MAXIMO_POR_CORRIDA)
      .select("_id")
      .lean();

    let preguntados = 0;
    for (const w of candidatos) {
      let alguno = false;
      for (const c of porEntorno.get(String(w._id)) || []) {
        try {
          await telegramService.sendMessage(c.chatId, PREGUNTA_DESTACAR, [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]]);
          // En la memoria de la IA: cuando conteste, sabe a qué responde.
          await models.telegramChats.updateOne(
            { _id: c._id },
            {
              $push: {
                historial: {
                  $each: [{ rol: "bot", texto: PREGUNTA_DESTACAR.replace(/<[^>]+>/g, ""), en: new Date() }],
                  $slice: -20,
                },
              },
            }
          );
          alguno = true;
        } catch (error: any) {
          console.error("[Destacar] no se pudo preguntar:", error?.message || error);
        }
      }
      if (alguno) {
        await models.workspaces.updateOne({ _id: w._id }, { $set: { "destacar.preguntadoEn": new Date() } });
        preguntados++;
      }
    }
    return { candidatos: candidatos.length, preguntados };
  }
}

export const destacarClienteService = new DestacarClienteService();
