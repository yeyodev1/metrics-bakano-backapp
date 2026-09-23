import axios from "axios";
import { Types } from "mongoose";
import models from "../models";
import { metaService } from "./meta.service";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { equipoAtencionService } from "./equipoAtencion.service";
import { comoPlata } from "./facturacionChat.service";

/**
 * Que le estamos anunciando HOY a cada cliente.
 *
 * El cliente pregunta "que estan pautando?" y la respuesta no puede ser "lo
 * reviso": aqui salen los anuncios activos de su cuenta de Meta, con el link
 * para verlos y lo gastado. Si el dato no esta (sin cuenta conectada, token
 * vencido o Meta caido), no se inventa nada: se avisa al encargado y se le
 * dice al cliente que lo van a contactar.
 */

const GRAPH = "https://graph.facebook.com/v22.0";
const DENISSE = "dquimi@bakano.ec";
/** Mismo aviso al encargado, como mucho una vez al dia por entorno. */
const AVISO_CADA_MS = 24 * 3_600_000;
/** Si la pauta no cambia en este tiempo, el equipo tiene que decidir si rota. */
const DIAS_MISMOS_ANUNCIOS = 20;
/** Cada cuanto se le cuenta al cliente que estamos anunciando. */
const DIAS_RESUMEN_CLIENTE = 21;

export interface AnuncioActivo {
  id: string;
  nombre: string;
  campana: string | null;
  link: string | null;
  gasto: number;
  impresiones: number;
  desde: string | null;
}

export type Publicidad =
  | { conectado: true; anuncios: AnuncioActivo[]; gastoUltimos30: number; cuenta: string | null }
  | { conectado: false; motivo: "sin_cuenta" | "sin_token" | "error_meta"; detalle?: string };

class PublicidadClienteService {
  /**
   * Anuncios ACTIVOS de la cuenta, con gasto de los ultimos 30 dias.
   * Nunca lanza: si algo falla devuelve `conectado: false` con el motivo, que
   * es lo que dispara el aviso al encargado.
   */
  async activos(workspaceId: Types.ObjectId | string): Promise<Publicidad> {
    const workspace: any = await models.workspaces.findById(workspaceId).select("metaAds").lean();
    const adAccountId = workspace?.metaAds?.adAccountId;
    if (!adAccountId) return { conectado: false, motivo: "sin_cuenta" };

    const token = workspace.metaAds?.accessToken || (await metaService.getGlobalAccessToken().catch(() => null));
    if (!token) return { conectado: false, motivo: "sin_token" };

    try {
      const { data } = await axios.get(`${GRAPH}/act_${String(adAccountId).replace(/^act_/, "")}/ads`, {
        params: {
          access_token: token,
          limit: 25,
          effective_status: JSON.stringify(["ACTIVE"]),
          fields:
            "id,name,created_time,campaign{name}," +
            "creative{effective_object_story_id,instagram_permalink_url,thumbnail_url}," +
            "insights.date_preset(last_30d){spend,impressions}",
        },
        timeout: 20_000,
      });

      const anuncios: AnuncioActivo[] = (data?.data ?? []).map((ad: any) => {
        const insights = ad.insights?.data?.[0] ?? {};
        return {
          id: ad.id,
          nombre: ad.name || "Sin nombre",
          campana: ad.campaign?.name ?? null,
          link: this.linkDelAnuncio(ad),
          gasto: Number(insights.spend || 0),
          impresiones: Number(insights.impressions || 0),
          desde: ad.created_time ?? null,
        };
      });

      return {
        conectado: true,
        anuncios,
        gastoUltimos30: Math.round(anuncios.reduce((a, b) => a + b.gasto, 0) * 100) / 100,
        cuenta: workspace.metaAds?.adAccountName ?? null,
      };
    } catch (error: any) {
      console.error("[Publicidad] Meta no respondió:", error.response?.data?.error?.message || error.message);
      return { conectado: false, motivo: "error_meta", detalle: error.response?.data?.error?.message || error.message };
    }
  }

  /** El link para VER el anuncio: Instagram si lo hay, si no la publicación de Facebook. */
  private linkDelAnuncio(ad: any): string | null {
    const permalink = ad?.creative?.instagram_permalink_url;
    if (permalink) return permalink;
    const story = ad?.creative?.effective_object_story_id;
    if (story && story.includes("_")) {
      const [pagina, post] = story.split("_");
      return `https://www.facebook.com/${pagina}/posts/${post}`;
    }
    return null;
  }

  /**
   * Lo que el cliente ve, ya listo para que la IA lo cuente. Si no hay dato,
   * avisa al encargado (una vez al día) y devuelve que ya fue notificado: eso
   * es lo que el bot le promete al cliente.
   */
  async paraElCliente(workspaceId: Types.ObjectId): Promise<Record<string, unknown>> {
    const p = await this.activos(workspaceId);
    if (p.conectado) {
      return {
        hayDatos: true,
        anunciosActivos: p.anuncios.length,
        gastoUltimos30Dias: comoPlata(p.gastoUltimos30),
        anuncios: p.anuncios.slice(0, 8).map((a) => ({
          nombre: a.nombre,
          campana: a.campana,
          link: a.link,
          gastoUltimos30Dias: comoPlata(a.gasto),
          impresiones: a.impresiones,
        })),
        sinLink: p.anuncios.some((a) => !a.link),
        // Anuncios encendidos pero sin gasto: pasa de verdad (presupuesto en
        // cero, conjunto pausado). Decirlo es mejor que cantar "$0,00" seco.
        activosSinInversion: p.anuncios.length > 0 && p.gastoUltimos30 === 0,
      };
    }

    const avisado = await this.avisarSinDatos(workspaceId, p.motivo, p.detalle);
    return {
      hayDatos: false,
      motivo: p.motivo,
      encargadoNotificado: avisado,
      encargado: "Denisse Quimi",
      siguiente:
        "Dile que no puedes ver la pauta en este momento, que ya avisaste a Denisse Quimi y que ella se comunica " +
        "para resolverlo. No inventes anuncios, gastos ni fechas.",
    };
  }

  /** Aviso al equipo de que la pauta de un cliente no se puede leer. */
  private async avisarSinDatos(workspaceId: Types.ObjectId, motivo: string, detalle?: string): Promise<boolean> {
    const workspace = await models.workspaces.findById(workspaceId).select("name publicidad").lean();
    const ultimo = (workspace as any)?.publicidad?.avisoSinDatosEn;
    if (ultimo && Date.now() - new Date(ultimo).getTime() < AVISO_CADA_MS) return true;

    const razon: Record<string, string> = {
      sin_cuenta: "el entorno no tiene cuenta publicitaria de Meta conectada en metrics.bakano.ec",
      sin_token: "no hay token de Meta disponible para esa cuenta",
      error_meta: `Meta respondió con error: ${detalle || "sin detalle"}`,
      sin_inversion: "tiene anuncios activos pero no gastó nada en los últimos 30 días",
    };
    const esSinInversion = motivo === "sin_inversion";
    const titulo = esSinInversion
      ? `💸 ${workspace?.name} tiene anuncios activos sin inversión`
      : `📣 No puedo ver la pauta de ${workspace?.name}`;
    const cuerpo = esSinInversion
      ? `Los anuncios de ${workspace?.name} están activos pero no registran gasto en los últimos 30 días. ` +
        "Revisa el presupuesto o si los conjuntos están pausados: el cliente ve que está anunciando y no está saliendo."
      : `El cliente preguntó qué estamos anunciando y no pude responder porque ${razon[motivo] || motivo}.\n\n` +
        "Le dije que tú te comunicas para resolverlo. Revisa la conexión en metrics.bakano.ec.";

    const correos = [...new Set([DENISSE, ...equipoAtencionService.correos("atencion")])];
    const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle: cuerpo, correos }),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, cuerpo, { workspaceId })
      ),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: "pauta sin datos",
        workspaceName: workspace?.name || "Cliente",
        clienteNombre: workspace?.name || "Cliente",
        mensaje: cuerpo,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
    await models.workspaces.updateOne({ _id: workspaceId }, { $set: { "publicidad.avisoSinDatosEn": new Date() } });
    return true;
  }

  /**
   * Revision semanal por entorno. Hace dos cosas:
   *  - si llevamos DIAS_MISMOS_ANUNCIOS con exactamente los mismos anuncios,
   *    avisa al equipo (la pauta que no rota se quema);
   *  - cada DIAS_RESUMEN_CLIENTE le cuenta al cliente que estamos anunciando,
   *    con sus links y lo gastado.
   */
  async revisar(): Promise<{ revisados: number; avisosMismos: number; resumenes: number; sinDatos: number }> {
    const { telegramService } = await import("./telegram.service");
    const { telegramAgentService } = await import("./telegramAgent.service");

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
    const porEntorno = new Map<string, number[]>();
    for (const c of chats) {
      if (c.userId && internos.has(String(c.userId))) continue;
      porEntorno.set(String(c.workspaceId), [...(porEntorno.get(String(c.workspaceId)) ?? []), c.chatId]);
    }

    const workspaces = await models.workspaces
      .find({ _id: { $in: [...porEntorno.keys()] }, isActive: true })
      .select("name publicidad metaAds.adAccountId")
      .lean();

    let avisosMismos = 0;
    let resumenes = 0;
    let sinDatos = 0;

    for (const w of workspaces) {
      const id = w._id as Types.ObjectId;
      const p = await this.activos(id);
      if (!p.conectado) {
        await this.avisarSinDatos(id, p.motivo, p.detalle);
        sinDatos++;
        continue;
      }

      // Encendidos pero sin gastar un dólar en 30 días: el equipo tiene que verlo.
      if (p.anuncios.length && p.gastoUltimos30 === 0) {
        await this.avisarSinDatos(id, "sin_inversion");
        sinDatos++;
      }

      const seguimiento = (w as any).publicidad || {};
      const ids = p.anuncios.map((a) => a.id).sort();
      const iguales =
        Array.isArray(seguimiento.snapshotIds) &&
        seguimiento.snapshotIds.length === ids.length &&
        seguimiento.snapshotIds.slice().sort().join("|") === ids.join("|");

      const cambios: Record<string, unknown> = {};
      if (!iguales) {
        // La pauta cambio: el reloj de "llevamos lo mismo" arranca de cero.
        cambios["publicidad.snapshotIds"] = ids;
        cambios["publicidad.snapshotDesde"] = new Date();
      } else if (ids.length) {
        const desde = seguimiento.snapshotDesde ? new Date(seguimiento.snapshotDesde) : null;
        const dias = desde ? Math.floor((Date.now() - desde.getTime()) / 86_400_000) : 0;
        const yaAvisado =
          seguimiento.avisoMismosEn && Date.now() - new Date(seguimiento.avisoMismosEn).getTime() < DIAS_MISMOS_ANUNCIOS * 86_400_000;
        if (dias >= DIAS_MISMOS_ANUNCIOS && !yaAvisado) {
          await this.avisarMismosAnuncios(id, w.name, p, dias);
          cambios["publicidad.avisoMismosEn"] = new Date();
          avisosMismos++;
        }
      }

      const ultimoResumen = seguimiento.ultimoResumenEn ? new Date(seguimiento.ultimoResumenEn) : null;
      const tocaResumen =
        p.anuncios.length > 0 &&
        (!ultimoResumen || Date.now() - ultimoResumen.getTime() >= DIAS_RESUMEN_CLIENTE * 86_400_000);
      if (tocaResumen) {
        const chatIds = porEntorno.get(String(id)) ?? [];
        const chatBase = chatIds.length ? await models.telegramChats.findOne({ chatId: chatIds[0] }) : null;
        const texto = chatBase
          ? await telegramAgentService.comentar(
              chatBase,
              "Cuéntale qué le estamos anunciando ahora mismo en Meta y cuánto se ha invertido en los últimos 30 días. " +
                "Nombra los anuncios y pásale los links tal cual vienen (los que tengan). Si alguno no tiene link, no lo inventes. " +
                "Máximo 6 líneas, en positivo y sin prometer resultados.",
              {
                anunciosActivos: p.anuncios.length,
                inversionUltimos30Dias: comoPlata(p.gastoUltimos30),
                anuncios: p.anuncios.slice(0, 6).map((a) => ({
                  nombre: a.nombre,
                  campana: a.campana,
                  link: a.link,
                  gasto: comoPlata(a.gasto),
                })),
              }
            )
          : null;
        const respaldo =
          `📣 <b>Esto es lo que estamos anunciando</b>\n\n` +
          p.anuncios
            .slice(0, 6)
            .map((a) => `• ${a.nombre}${a.link ? `\n   ${a.link}` : ""}`)
            .join("\n") +
          `\n\nInversión de los últimos 30 días: <b>${comoPlata(p.gastoUltimos30)}</b>`;

        for (const chatId of chatIds) {
          await telegramService
            .sendMessage(chatId, texto || respaldo, [
              [{ text: "📊 Ver mis métricas", callback_data: "fact:metricas" }],
              [{ text: "📋 Volver al menú", callback_data: "menu:ver" }],
            ])
            .catch((error: any) => console.error("[Publicidad] no se pudo avisar al cliente:", error?.message || error));
        }
        cambios["publicidad.ultimoResumenEn"] = new Date();
        resumenes++;
      }

      if (Object.keys(cambios).length) await models.workspaces.updateOne({ _id: id }, { $set: cambios });
    }

    return { revisados: workspaces.length, avisosMismos, resumenes, sinDatos };
  }

  /** "Llevamos N días con los mismos anuncios": lo decide el equipo, no el bot. */
  private async avisarMismosAnuncios(
    workspaceId: Types.ObjectId,
    entorno: string,
    p: Extract<Publicidad, { conectado: true }>,
    dias: number
  ): Promise<void> {
    const titulo = `🔁 ${entorno} lleva ${dias} días con los mismos anuncios`;
    const cuerpo =
      `Siguen activos los mismos ${p.anuncios.length} anuncios desde hace ${dias} días ` +
      `(${comoPlata(p.gastoUltimos30)} invertidos en los últimos 30).\n\n` +
      p.anuncios
        .slice(0, 8)
        .map((a) => `• ${a.nombre}${a.campana ? ` · ${a.campana}` : ""}${a.link ? `\n   ${a.link}` : ""}`)
        .join("\n") +
      "\n\nToca decidir: seguimos con lo mismo o rotamos creativos.";

    const correos = [...new Set([DENISSE, ...equipoAtencionService.correos("atencion")])];
    const internos = await models.users.find({ email: { $in: correos }, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle: cuerpo, correos }),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, cuerpo, { workspaceId })
      ),
      resendService.sendSolicitudClienteEmail({
        to: correos,
        tema: "rotación de pauta",
        workspaceName: entorno,
        clienteNombre: entorno,
        mensaje: cuerpo,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
  }
}

export const publicidadClienteService = new PublicidadClienteService();
