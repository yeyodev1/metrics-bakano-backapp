import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { VideoPlanningService, infoProduccion, type InfoProduccion } from "./videoPlanning.service";
import { fechaEcuador } from "./atencionCliente.service";

/**
 * Revision de guiones por Telegram.
 *
 * La plataforma recibe la revision del cliente UNA sola vez y la bloquea, asi
 * que el bot no puede mandar correcciones sueltas: las junta en un borrador
 * del chat, se las muestra y, cuando el cliente confirma, envia todo junto
 * con el mismo `submitClientApproval` de la plataforma (plazo de 48 h, avisos
 * urgentes, bitacora de revisiones). Asi el bot y la web no se contradicen.
 *
 * Un motivo real guardado en la base era "no me gusta aun": con eso nadie
 * puede corregir. Por eso solo se anotan correcciones claras.
 */

/** Las de MOTIVO_CATEGORIAS que aplican a un guion (las demas son de edicion). */
export const CATEGORIAS_GUION = [
  "gancho_debil",
  "tono_incorrecto",
  "estructura",
  "informacion_incorrecta",
  "ortografia",
  "otro",
] as const;
export type CategoriaGuion = (typeof CATEGORIAS_GUION)[number];

const MIN_CARACTERES = 20;
const MAX_TEXTO = 1500;
// Arranques de queja generica. Solas no le dicen al equipo que cambiar.
const VAGAS = [
  /^no me gusta/,
  /^no me convence/,
  /^cambia(lo|r)?\b/,
  /^mejora(lo|r)?\b/,
  /^rehacer|^rehazlo|^hazlo de nuevo/,
  /^no va\b/,
  /^esta mal\b|^mal\b/,
  /^otro\b/,
];

export interface GuionParaRevisar {
  itemId: string;
  numero: number;
  tema: string;
  aprobacion: string;
  texto: string;
}

export interface RevisionPendiente {
  planningId: string;
  produccion: InfoProduccion | null;
  guiones: GuionParaRevisar[];
}

export interface CorreccionBorrador {
  itemId: string;
  numero: number;
  tema: string;
  texto: string;
  categoria?: string;
}

function textoDelGuion(item: any): string {
  const ia = item.guionIA;
  const partes = ia
    ? [
        ia.gancho && `Gancho: ${ia.gancho}`,
        ia.hook2 && `Hook 2: ${ia.hook2}`,
        ia.cuerpo && `Cuerpo: ${ia.cuerpo}`,
        ia.cta && `CTA: ${ia.cta}`,
      ].filter(Boolean)
    : [];
  return (partes.length ? partes.join("\n") : item.guion || "").trim();
}

function sinAcentos(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/** Una correccion sirve si dice que cambiar y como, no solo que algo no gusta. */
export function esCorreccionClara(texto: string): { clara: boolean; motivo?: string } {
  const t = sinAcentos(texto || "");
  if (t.length < MIN_CARACTERES) return { clara: false, motivo: "muy corta: falta qué parte cambiar y cómo lo quiere" };
  if (VAGAS.some((re) => re.test(t)) && t.split(/\s+/).length < 8) {
    return { clara: false, motivo: "es una queja general: falta qué parte cambiar y qué quiere en su lugar" };
  }
  return { clara: true };
}

class RevisionGuionesService {
  private planning = new VideoPlanningService();

  /** Produccion y plazo de correcciones. Aparte para poder simularlo en pruebas. */
  produccionDe(planningEntryId: Types.ObjectId | string): Promise<InfoProduccion | null> {
    return infoProduccion(planningEntryId).catch(() => null);
  }

  /**
   * La planificacion que el cliente tiene por revisar: lista para el cliente y
   * sin respuesta. Si hay varias, la de la produccion futura mas cercana.
   */
  async pendiente(workspaceId: Types.ObjectId): Promise<RevisionPendiente | null> {
    const planes = await models.videoPlanning
      .find({ workspaceId, listaParaCliente: true, clienteAprobado: { $ne: true } })
      .select("_id planningEntryId items")
      .lean();
    if (!planes.length) return null;

    const conFecha = await Promise.all(planes.map(async (p) => ({ p, prod: await this.produccionDe(p.planningEntryId) })));
    const ahora = Date.now();
    const futuras = conFecha
      .filter((x) => x.prod && x.prod.fecha.getTime() > ahora)
      .sort((a, b) => a.prod!.fecha.getTime() - b.prod!.fecha.getTime());
    const elegida =
      futuras[0] ?? conFecha.sort((a, b) => (b.prod?.fecha.getTime() ?? 0) - (a.prod?.fecha.getTime() ?? 0))[0];

    return {
      planningId: String(elegida.p._id),
      produccion: elegida.prod,
      guiones: [...(elegida.p.items || [])]
        .sort((a: any, b: any) => a.numero - b.numero)
        .map((i: any) => ({
          itemId: String(i._id),
          numero: i.numero,
          tema: i.tema,
          aprobacion: i.clienteAprobacion,
          texto: textoDelGuion(i),
        })),
    };
  }

  /** Borrador vigente: si quedo de una planificacion anterior, no cuenta. */
  borrador(chat: ITelegramChat, planningId?: string): CorreccionBorrador[] {
    const r = chat.revisionGuiones;
    if (!r?.correcciones?.length) return [];
    if (planningId && String(r.planningId) !== planningId) return [];
    return r.correcciones.map((c) => ({ ...c }));
  }

  private async guardar(chat: ITelegramChat, planningId: string, correcciones: CorreccionBorrador[]): Promise<void> {
    if (correcciones.length) {
      const revision = { planningId: new Types.ObjectId(planningId), correcciones, actualizadoEn: new Date() };
      chat.revisionGuiones = revision as any;
      await models.telegramChats.updateOne({ _id: chat._id }, { $set: { revisionGuiones: revision } });
    } else {
      chat.revisionGuiones = undefined;
      await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { revisionGuiones: 1 } });
    }
  }

  private plazo(revision: RevisionPendiente): { cerrado: boolean; hasta?: string; produccion?: string } {
    const p = revision.produccion;
    return {
      cerrado: Boolean(p?.ventanaCerrada),
      hasta: p ? fechaEcuador(p.correccionesHasta) : undefined,
      produccion: p ? fechaEcuador(p.fecha) : undefined,
    };
  }

  async anotar(chat: ITelegramChat, numero: number, texto: string, categoria?: string) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return { ok: false as const, motivo: "no hay guiones esperando revisión" };
    const plazo = this.plazo(revision);
    if (plazo.cerrado) return { ok: false as const, motivo: "plazo_cerrado", hasta: plazo.hasta };

    const guion = revision.guiones.find((g) => g.numero === Number(numero));
    if (!guion) {
      return { ok: false as const, motivo: `no existe el guion #${numero}`, disponibles: revision.guiones.map((g) => g.numero) };
    }
    const claridad = esCorreccionClara(texto);
    if (!claridad.clara) return { ok: false as const, motivo: "poco_clara", detalle: claridad.motivo };

    const cat = (CATEGORIAS_GUION as readonly string[]).includes(categoria || "") ? categoria! : "otro";
    const correcciones = this.borrador(chat, revision.planningId);
    const previa = correcciones.find((c) => c.itemId === guion.itemId);
    const limpio = texto.trim().slice(0, MAX_TEXTO);
    if (previa) {
      if (!previa.texto.includes(limpio)) previa.texto = `${previa.texto}\n${limpio}`.slice(0, MAX_TEXTO);
      previa.categoria = cat;
    } else {
      correcciones.push({ itemId: guion.itemId, numero: guion.numero, tema: guion.tema, texto: limpio, categoria: cat });
    }
    await this.guardar(chat, revision.planningId, correcciones);
    return { ok: true as const, guion: `#${guion.numero} ${guion.tema}`, correccionesEnBorrador: correcciones.length };
  }

  async quitar(chat: ITelegramChat, numero: number) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return { ok: false as const, motivo: "no hay guiones esperando revisión" };
    const correcciones = this.borrador(chat, revision.planningId);
    const restantes = correcciones.filter((c) => c.numero !== Number(numero));
    if (restantes.length === correcciones.length) return { ok: false as const, motivo: `el guion #${numero} no tenía corrección anotada` };
    await this.guardar(chat, revision.planningId, restantes);
    return { ok: true as const, correccionesEnBorrador: restantes.length };
  }

  /** Lo que se enviaria hoy, para mostrarselo al cliente antes de confirmar. */
  async resumen(chat: ITelegramChat) {
    const revision = await this.pendiente(chat.workspaceId!);
    if (!revision) return null;
    const correcciones = this.borrador(chat, revision.planningId);
    const corregidos = new Set(correcciones.map((c) => c.itemId));
    return {
      revision,
      plazo: this.plazo(revision),
      correcciones,
      sinCorreccion: revision.guiones.filter((g) => !corregidos.has(g.itemId) && g.aprobacion !== "APROBADO"),
    };
  }

  /**
   * Envia todo junto. Los guiones sin correccion se aprueban solo si el
   * cliente lo decidio (`aprobarResto`): la revision se envia una vez y la
   * planificacion queda cerrada, asi que nada puede quedar a medias.
   */
  async enviar(chat: ITelegramChat, aprobarResto: boolean) {
    const r = await this.resumen(chat);
    if (!r) return { ok: false as const, motivo: "no hay guiones esperando revisión (ya se envió o no está lista)" };
    if (!r.correcciones.length && !aprobarResto) return { ok: false as const, motivo: "nada_que_enviar" };
    if (r.sinCorreccion.length && !aprobarResto) {
      return {
        ok: false as const,
        motivo: "falta_decidir_resto",
        sinCorreccion: r.sinCorreccion.map((g) => `#${g.numero} ${g.tema}`),
      };
    }
    if (r.correcciones.length && r.plazo.cerrado) return { ok: false as const, motivo: "plazo_cerrado", hasta: r.plazo.hasta };

    const approvals = [
      ...r.correcciones.map((c) => ({
        itemId: c.itemId,
        clienteAprobacion: "RECHAZADO" as const,
        motivoRechazo: c.texto,
        motivoCategoria: c.categoria,
      })),
      ...(aprobarResto ? r.sinCorreccion.map((g) => ({ itemId: g.itemId, clienteAprobacion: "APROBADO" as const })) : []),
    ];

    try {
      await this.planning.submitClientApproval(r.revision.planningId, approvals, String(chat.userId));
    } catch (error: any) {
      if (error?.message === "CORRECTION_WINDOW_CLOSED") return { ok: false as const, motivo: "plazo_cerrado", hasta: r.plazo.hasta };
      if (error?.message === "LOCKED") return { ok: false as const, motivo: "ya se había enviado la revisión de esta planificación" };
      console.error("[Revisión guiones] envío:", error?.message || error);
      return { ok: false as const, motivo: "error al enviar" };
    }

    await this.guardar(chat, r.revision.planningId, []);
    return {
      ok: true as const,
      corregidos: r.correcciones.map((c) => `#${c.numero} ${c.tema}`),
      aprobados: aprobarResto ? r.sinCorreccion.length : 0,
      correccionesHasta: r.plazo.hasta,
      produccion: r.plazo.produccion,
    };
  }
}

export const revisionGuionesService = new RevisionGuionesService();
