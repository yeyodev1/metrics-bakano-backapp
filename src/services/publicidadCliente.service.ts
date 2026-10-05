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
  /** Gasto de los ultimos 7 dias: lo que de verdad esta corriendo ahora. */
  gasto7: number;
  impresiones: number;
  desde: string | null;
}

export type Publicidad =
  | { conectado: true; anuncios: AnuncioActivo[]; gastoUltimos30: number; gastoUltimos7: number; gasto7Disponible: boolean; cuenta: string | null; cuentaId: string }
  | { conectado: false; motivo: "sin_cuenta" | "sin_token" | "error_meta"; detalle?: string };

/** Lo que Meta cuenta como resultado, en palabras del cliente. */
const RESULTADOS: { tipos: string[]; nombre: string }[] = [
  { tipos: ["onsite_conversion.messaging_conversation_started_7d"], nombre: "conversaciones iniciadas" },
  { tipos: ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"], nombre: "leads" },
  { tipos: ["purchase", "offsite_conversion.fb_pixel_purchase", "onsite_web_purchase"], nombre: "compras" },
  { tipos: ["onsite_conversion.post_save", "post_engagement"], nombre: "interacciones" },
];
/** Meta guarda insights hasta 37 meses atras. */
const MESES_HISTORIA = 37;
const MAX_DIAS_RANGO = 366;

export function resultadosDe(actions: any[] | undefined, gasto: number): { tipo: string; cantidad: number; costoPorResultado: string | null }[] {
  const lista = Array.isArray(actions) ? actions : [];
  const salida: { tipo: string; cantidad: number; costoPorResultado: string | null }[] = [];
  for (const r of RESULTADOS) {
    // Un mismo resultado puede venir con varios nombres: se toma el mayor, no la suma.
    const cantidad = Math.max(0, ...lista.filter((a) => r.tipos.includes(a?.action_type)).map((a) => Number(a.value || 0)));
    if (cantidad > 0) salida.push({ tipo: r.nombre, cantidad, costoPorResultado: gasto > 0 ? comoPlata(gasto / cantidad) : null });
  }
  return salida;
}

/** Valida fechas YYYY-MM-DD: en orden, no futuras (hora Ecuador) y dentro de lo que guarda Meta. */
export function validarRango(desde: string, hasta: string, hoy = new Date()): { desde: string; hasta: string; dias: number } | { error: string } {
  const formato = /^\d{4}-\d{2}-\d{2}$/;
  if (!formato.test(desde || "") || !formato.test(hasta || "")) return { error: "Las fechas deben venir como AAAA-MM-DD." };
  const hoyEc = new Date(hoy.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
  let fin = hasta;
  if (desde > hasta) return { error: "La fecha de inicio es posterior a la de fin." };
  if (desde > hoyEc) return { error: "Ese periodo todavía no ha pasado: no hay datos de días futuros." };
  if (fin > hoyEc) fin = hoyEc;
  const limite = new Date(hoy);
  limite.setUTCMonth(limite.getUTCMonth() - MESES_HISTORIA);
  if (desde < limite.toISOString().slice(0, 10)) return { error: `Meta solo guarda los resultados de los últimos ${MESES_HISTORIA} meses.` };
  const dias = Math.round((Date.parse(fin) - Date.parse(desde)) / 86_400_000) + 1;
  if (dias > MAX_DIAS_RANGO) return { error: "Pide como mucho un año a la vez." };
  return { desde, hasta: fin, dias };
}

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
          limit: 100,
          effective_status: JSON.stringify(["ACTIVE"]),
          fields:
            "id,name,created_time,campaign{name}," +
            "creative{effective_object_story_id,instagram_permalink_url,thumbnail_url}," +
            "insights.date_preset(last_30d){spend,impressions}",
        },
        timeout: 20_000,
      });

      // Gasto de 7 dias por anuncio en una consulta aparte (nivel anuncio).
      // Si falla, no tumba la lectura: queda en 0 y se ve como "sin gasto reciente".
      const gasto7 = new Map<string, number>();
      let gasto7Ok = true;
      await axios
        .get(`${GRAPH}/act_${String(adAccountId).replace(/^act_/, "")}/insights`, {
          params: { access_token: token, level: "ad", date_preset: "last_7d", fields: "ad_id,spend", limit: 500 },
          timeout: 20_000,
        })
        .then((r) => {
          for (const fila of r.data?.data ?? []) gasto7.set(String(fila.ad_id), Number(fila.spend || 0));
        })
        .catch((e: any) => {
          gasto7Ok = false;
          console.warn("[Publicidad] gasto de 7 días:", e.response?.data?.error?.message || e.message);
        });

      const anuncios: AnuncioActivo[] = (data?.data ?? []).map((ad: any) => {
        const insights = ad.insights?.data?.[0] ?? {};
        return {
          id: ad.id,
          nombre: ad.name || "Sin nombre",
          campana: ad.campaign?.name ?? null,
          link: this.linkDelAnuncio(ad),
          gasto: Number(insights.spend || 0),
          // Sin el dato de 7 dias, se usa el de 30 para no declarar "sin gasto" lo que si gasta.
          gasto7: gasto7Ok ? gasto7.get(String(ad.id)) ?? 0 : Number(insights.spend || 0),
          impresiones: Number(insights.impressions || 0),
          desde: ad.created_time ?? null,
        };
      });

      return {
        conectado: true,
        anuncios,
        gastoUltimos30: Math.round(anuncios.reduce((a, b) => a + b.gasto, 0) * 100) / 100,
        gastoUltimos7: Math.round(anuncios.reduce((a, b) => a + b.gasto7, 0) * 100) / 100,
        cuenta: workspace.metaAds?.adAccountName ?? null,
        cuentaId: String(adAccountId).replace(/^act_/, ""),
        gasto7Disponible: gasto7Ok,
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
      // "Corriendo" = gasto en los ultimos 7 dias. Encendido en Meta sin gasto
      // reciente (anuncios viejos, conjunto sin presupuesto) no es pauta viva:
      // contarlo como activo confunde al cliente.
      const corriendo = [...p.anuncios].filter((a) => a.gasto7 > 0).sort((a, b) => b.gasto7 - a.gasto7);
      const sinGastoReciente = p.anuncios.filter((a) => a.gasto7 === 0);
      return {
        hayDatos: true,
        cuenta: p.cuenta,
        anunciosCorriendo: corriendo.length,
        gastoUltimos7Dias: comoPlata(p.gastoUltimos7),
        gastoUltimos30Dias: comoPlata(p.gastoUltimos30),
        anuncios: corriendo.slice(0, 8).map((a) => ({
          nombre: a.nombre,
          campana: a.campana,
          link: a.link,
          gastoUltimos7Dias: comoPlata(a.gasto7),
          gastoUltimos30Dias: comoPlata(a.gasto),
        })),
        encendidosSinGastoReciente: sinGastoReciente.length,
        ejemplosSinGastoReciente: sinGastoReciente.slice(0, 5).map((a) => a.nombre),
        sinLink: corriendo.some((a) => !a.link),
        activosSinInversion: p.anuncios.length > 0 && p.gastoUltimos7 === 0,
        ...(p.gasto7Disponible ? {} : { aviso: "No se pudo leer el gasto de los últimos 7 días: lo de 'corriendo' usa el gasto de 30 días." }),
        siguiente:
          "Para resultados (mensajes, leads, costo por resultado) o un periodo concreto, usa verPautaPorFechas.",
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

  /**
   * Resultados de la pauta entre dos fechas (YYYY-MM-DD, dia de Ecuador =
   * dia de la cuenta): gasto, alcance, clics, resultados (mensajes, leads,
   * compras), por campaña y dia a dia si el rango es corto. Mismo trato que
   * paraElCliente cuando no hay dato: se avisa y no se inventa.
   */
  async resultadosEnRango(workspaceId: Types.ObjectId, desde: string, hasta: string): Promise<Record<string, unknown>> {
    const rango = validarRango(desde, hasta);
    if ("error" in rango) return { hayDatos: false, rangoInvalido: true, motivo: rango.error };

    const workspace: any = await models.workspaces.findById(workspaceId).select("metaAds").lean();
    const adAccountId = workspace?.metaAds?.adAccountId;
    const token = adAccountId ? workspace.metaAds?.accessToken || (await metaService.getGlobalAccessToken().catch(() => null)) : null;
    if (!adAccountId || !token) {
      const motivo = adAccountId ? "sin_token" : "sin_cuenta";
      const avisado = await this.avisarSinDatos(workspaceId, motivo);
      return {
        hayDatos: false,
        motivo,
        encargadoNotificado: avisado,
        encargado: "Denisse Quimi",
        siguiente:
          motivo === "sin_cuenta"
            ? "Dile que su cuenta publicitaria todavía no está conectada a Metrics, por eso no puedes ver su pauta por fechas, y que ya avisaste a Denisse Quimi para conectarla. No inventes cifras."
            : "Dile que ahora mismo no puedes leer su pauta, que ya avisaste a Denisse Quimi y que ella se comunica. No inventes cifras.",
      };
    }

    const cuenta = `${GRAPH}/act_${String(adAccountId).replace(/^act_/, "")}/insights`;
    const base = { access_token: token, time_range: JSON.stringify({ since: rango.desde, until: rango.hasta }) };
    const campos = "spend,impressions,reach,clicks,inline_link_clicks,ctr,cpm,frequency,actions";
    try {
      const [total, campanas, diario] = await Promise.all([
        axios.get(cuenta, { params: { ...base, level: "account", fields: campos }, timeout: 20_000 }),
        axios.get(cuenta, { params: { ...base, level: "campaign", fields: `campaign_name,${campos}`, limit: 50 }, timeout: 20_000 }),
        rango.dias <= 31
          ? axios.get(cuenta, { params: { ...base, level: "account", fields: "spend,actions", time_increment: 1, limit: 40 }, timeout: 20_000 })
          : Promise.resolve(null),
      ]);
      const t = total.data?.data?.[0];
      if (!t) {
        return { hayDatos: true, desde: rango.desde, hasta: rango.hasta, sinActividad: true, gasto: comoPlata(0) };
      }
      return {
        hayDatos: true,
        desde: rango.desde,
        hasta: rango.hasta,
        cuenta: workspace.metaAds?.adAccountName ?? null,
        gasto: comoPlata(Number(t.spend || 0)),
        alcance: Number(t.reach || 0),
        impresiones: Number(t.impressions || 0),
        frecuencia: t.frequency ? Math.round(Number(t.frequency) * 100) / 100 : null,
        clicsEnElEnlace: Number(t.inline_link_clicks || 0),
        ctr: t.ctr ? `${Math.round(Number(t.ctr) * 100) / 100}%` : null,
        cpm: t.cpm ? comoPlata(Number(t.cpm)) : null,
        resultados: resultadosDe(t.actions, Number(t.spend || 0)),
        porCampana: (campanas.data?.data ?? [])
          .map((c: any) => ({ campana: c.campaign_name, gastoNum: Number(c.spend || 0), c }))
          .sort((a: any, b: any) => b.gastoNum - a.gastoNum)
          .slice(0, 8)
          .map(({ campana, gastoNum, c }: any) => ({
            campana,
            gasto: comoPlata(gastoNum),
            alcance: Number(c.reach || 0),
            clicsEnElEnlace: Number(c.inline_link_clicks || 0),
            resultados: resultadosDe(c.actions, gastoNum),
          })),
        diaADia: diario
          ? (diario.data?.data ?? []).map((d: any) => ({
              dia: d.date_start,
              gasto: comoPlata(Number(d.spend || 0)),
              resultados: resultadosDe(d.actions, Number(d.spend || 0)).map((r) => `${r.cantidad} ${r.tipo}`).join(", ") || "sin resultados",
            }))
          : null,
      };
    } catch (error: any) {
      const detalle = error.response?.data?.error?.message || error.message;
      console.error("[Publicidad] Meta no respondió (rango):", detalle);
      const avisado = await this.avisarSinDatos(workspaceId, "error_meta", detalle);
      return {
        hayDatos: false,
        motivo: "error_meta",
        encargadoNotificado: avisado,
        encargado: "Denisse Quimi",
        siguiente: "Dile que ahora mismo no puedes leer su pauta, que ya avisaste a Denisse Quimi y que ella se comunica. No inventes cifras.",
      };
    }
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
