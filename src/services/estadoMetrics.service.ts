import { Types } from "mongoose";
import models from "../models";
import { fechaEcuador } from "./atencionCliente.service";
import { citasClienteService } from "./citasCliente.service";
import { estadoPagoService } from "./estadoPago.service";
import { onboardingBotService } from "./onboardingBot.service";
import { CAMPOS_MARCA } from "./onboardingDatos.service";
import { SESIONES_ONBOARDING } from "./onboardingSesiones.service";

/**
 * Lo que HAY en Metrics de un entorno, en vivo: contrato, archivos, datos de
 * marca, facturacion, Meta, CRM, sesiones, citas (con su Meet), guiones y
 * videos.
 *
 * Es la misma foto para todos: el bot de Telegram (para no pedirle al
 * cliente lo que ya hizo en la plataforma), el MCP del equipo, la vista del
 * entorno en Metrics y Lucas. Antes el bot solo sabia lo que el cliente le
 * habia dicho por el chat: si firmo o subio el logo en la web, se lo seguia
 * pidiendo.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const DIAS_FACTURACION = 180;

export type EstadoItem = "listo" | "en_curso" | "pendiente";

export interface ArchivoEnMetrics {
  cantidad: number;
  ultimo?: { nombre: string; url: string; subidoEn: string | null };
}

export interface EstadoEnMetrics {
  entorno: { id: string; nombre: string; activo: boolean };
  generadoEn: string;
  contrato: { firmado: boolean; firmadoEn: string | null; verContrato: string | null };
  archivos: {
    logo: ArchivoEnMetrics;
    lineaGrafica: ArchivoEnMetrics;
    catalogo: ArchivoEnMetrics;
    otros: number;
    dondeSubir: string;
  };
  datosMarca: { completos: number; total: number; faltan: string[]; dondeVer: string };
  facturacion: { diasRegistrados: number; ultimoDia: string | null; dondeCargar: string };
  meta: { conectado: boolean };
  crm: { conectado: boolean; locationId: string | null; estado: string | null; whatsapp: string | null };
  onboarding: {
    sesiones: { sesion: string; etiqueta: string; con: string; estado: string; fecha: string | null }[];
    siguiente: string | null;
    completo: boolean;
  };
  citas: { cita: string; cuando: string; con: string; linkMeet: string | null; lugar: string | null }[];
  guiones: {
    total: number;
    aprobados: number;
    porRevisar: number;
    conCorrecciones: number;
    porProduccion: { produccion: string; total: number; aprobados: number; porRevisar: number }[];
    dondeVer: string;
  };
  videos: { editados: number; aprobadosPorCliente: number; porRevisar: number; publicados: number; dondeVer: string };
  pagos: { alDia: boolean; deuda: string | null };
  /** Lo que ya esta hecho en Metrics: el bot NO debe volver a pedirlo. */
  yaEsta: string[];
  /** Lo que falta de verdad, segun los datos. */
  falta: string[];
}

function iso(d?: Date | string | null): string | null {
  if (!d) return null;
  const f = new Date(d);
  return Number.isNaN(f.getTime()) ? null : f.toISOString();
}

function archivo(lista: any[]): ArchivoEnMetrics {
  const orden = [...lista].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
  const u = orden[0];
  return {
    cantidad: lista.length,
    ...(u ? { ultimo: { nombre: String(u.nombre || ""), url: String(u.url || ""), subidoEn: iso(u.createdAt) } } : {}),
  };
}

class EstadoMetricsService {
  async de(workspaceId: Types.ObjectId | string): Promise<EstadoEnMetrics | null> {
    const id = String(workspaceId);
    if (!Types.ObjectId.isValid(id)) return null;
    const wsId = new Types.ObjectId(id);

    const [workspace, crm, dias, ultimoDia, entradas, onboarding, citas, bloqueo] = await Promise.all([
      models.workspaces
        .findById(wsId)
        .select("name isActive onboardingStatus contractData resources brandProfile metaAds")
        .lean(),
      models.crmIntegrations.findOne({ workspaceId: wsId }).select("locationId estado whatsapp").lean().catch(() => null),
      models.dailyBilling
        .distinct("date", { workspaceId: wsId, date: { $gte: new Date(Date.now() - DIAS_FACTURACION * 86_400_000) } })
        .then((d) => d.length)
        .catch(() => 0),
      models.dailyBilling.findOne({ workspaceId: wsId }).sort({ date: -1 }).select("date").lean().catch(() => null),
      models.planning
        .find({ workspaceId: wsId, date: { $gte: new Date(Date.now() - 120 * 86_400_000) }, title: { $not: /^CANCELADA/ } })
        .sort({ date: 1 })
        .select("_id date")
        .lean(),
      onboardingBotService.estado(wsId).catch(() => null),
      citasClienteService
        .listarDeEntorno(wsId)
        .then((c) => citasClienteService.conEnlaces(c))
        .catch(() => []),
      estadoPagoService.bloqueo(id).catch(() => null),
    ]);
    if (!workspace) return null;
    const w = workspace as any;

    const planes = entradas.length
      ? await models.videoPlanning
          .find({ planningEntryId: { $in: entradas.map((e) => e._id) } })
          .select("planningEntryId items.clienteAprobacion items.edicion items.videoClienteAprobacion items.estadoPublicacion items.linkVideo")
          .lean()
      : [];

    // Archivos: lo que se subio por la web o por el chat termina igual en resources.
    const recursos = (w.resources || []) as any[];
    const de = (c: string) => recursos.filter((r) => r.categoria === c);

    // Datos de marca.
    const marca = (w.brandProfile || {}) as Record<string, unknown>;
    const camposMarca = Object.keys(CAMPOS_MARCA);
    const faltanMarca = camposMarca.filter((c) => !String(marca[c] ?? "").trim());

    // Guiones y videos.
    let total = 0;
    let aprobados = 0;
    let porRevisar = 0;
    let conCorrecciones = 0;
    let editados = 0;
    let videosAprobados = 0;
    let videosPorRevisar = 0;
    let publicados = 0;
    const porProduccion: EstadoEnMetrics["guiones"]["porProduccion"] = [];
    for (const e of entradas) {
      const plan = planes.find((p: any) => String(p.planningEntryId) === String(e._id)) as any;
      const items = (plan?.items || []) as any[];
      if (!items.length) continue;
      const a = items.filter((i) => i.clienteAprobacion === "APROBADO").length;
      const p = items.filter((i) => (i.clienteAprobacion || "PENDIENTE") === "PENDIENTE").length;
      total += items.length;
      aprobados += a;
      porRevisar += p;
      conCorrecciones += items.filter((i) => i.clienteAprobacion === "RECHAZADO").length;
      porProduccion.push({ produccion: fechaEcuador(new Date(e.date)), total: items.length, aprobados: a, porRevisar: p });
      for (const i of items) {
        if (i.edicion === "EDITADO" || i.linkVideo) {
          editados++;
          if (i.videoClienteAprobacion === "APROBADO") videosAprobados++;
          else if ((i.videoClienteAprobacion || "PENDIENTE") === "PENDIENTE") videosPorRevisar++;
        }
        if (i.estadoPublicacion === "PUBLICADO") publicados++;
      }
    }

    const firmado = Boolean(w.onboardingStatus?.contractSubmitted);
    const base = `${APP_URL}/app/workspaces/${id}`;
    const estado: EstadoEnMetrics = {
      entorno: { id, nombre: String(w.name || ""), activo: w.isActive !== false },
      generadoEn: new Date().toISOString(),
      contrato: {
        firmado,
        firmadoEn: iso(w.contractData?.firmadoEn),
        verContrato: firmado ? `${APP_URL}/app/workspaces/${id}/legal` : null,
      },
      archivos: {
        logo: archivo(de("logo")),
        lineaGrafica: archivo(de("linea_grafica")),
        catalogo: archivo(de("catalogo")),
        otros: de("otro").length,
        dondeSubir: `${base}/resources`,
      },
      datosMarca: {
        completos: camposMarca.length - faltanMarca.length,
        total: camposMarca.length,
        faltan: faltanMarca.map((c) => CAMPOS_MARCA[c] || c),
        dondeVer: `${base}/brand-profile`,
      },
      facturacion: { diasRegistrados: dias, ultimoDia: iso((ultimoDia as any)?.date), dondeCargar: `${base}/billing` },
      meta: { conectado: Boolean(w.metaAds?.adAccountId || w.metaAds?.pageId) },
      crm: {
        conectado: Boolean(crm && (crm as any).estado === "conectado"),
        locationId: (crm as any)?.locationId ?? null,
        estado: (crm as any)?.estado ?? null,
        whatsapp: (crm as any)?.whatsapp ?? null,
      },
      onboarding: {
        sesiones: (onboarding?.sesiones || []).map((s) => ({
          sesion: s.sesion,
          etiqueta: s.etiqueta,
          con: s.responsable,
          estado: s.pasada && s.estado === "agendada" ? "ya_paso_sin_cerrar" : s.estado,
          fecha: s.fecha ? fechaEcuador(new Date(s.fecha)) : null,
        })),
        siguiente: onboarding?.siguiente
          ? `${SESIONES_ONBOARDING[onboarding.siguiente].etiqueta} (${SESIONES_ONBOARDING[onboarding.siguiente].responsable.nombre})`
          : null,
        completo: Boolean(onboarding?.completo),
      },
      citas: citas.map((c) => ({
        cita: c.etiqueta,
        cuando: fechaEcuador(c.inicio),
        con: c.con,
        linkMeet: c.enlace ?? null,
        lugar: c.lugar ?? null,
      })),
      guiones: { total, aprobados, porRevisar, conCorrecciones, porProduccion, dondeVer: `${base}/planning` },
      videos: { editados, aprobadosPorCliente: videosAprobados, porRevisar: videosPorRevisar, publicados, dondeVer: `${base}/planning` },
      pagos: { alDia: !bloqueo, deuda: bloqueo?.deudaTexto ?? null },
      yaEsta: [],
      falta: [],
    };

    // Resumen en palabras: lo que el bot NO debe pedir y lo que si falta.
    const ya = estado.yaEsta;
    const falta = estado.falta;
    if (firmado) ya.push(`Contrato firmado en Metrics${estado.contrato.firmadoEn ? ` (${fechaEcuador(new Date(estado.contrato.firmadoEn))})` : ""}`);
    else falta.push("Firmar el contrato");
    (estado.archivos.logo.cantidad ? ya : falta).push(estado.archivos.logo.cantidad ? `Logo subido (${estado.archivos.logo.cantidad})` : "Subir el logo");
    (estado.archivos.lineaGrafica.cantidad ? ya : falta).push(
      estado.archivos.lineaGrafica.cantidad ? `Línea gráfica subida (${estado.archivos.lineaGrafica.cantidad})` : "Subir la línea gráfica"
    );
    (estado.archivos.catalogo.cantidad ? ya : falta).push(
      estado.archivos.catalogo.cantidad ? `Catálogo subido (${estado.archivos.catalogo.cantidad})` : "Subir el catálogo"
    );
    if (dias) ya.push(`Facturación cargada (${dias} días en los últimos 6 meses)`);
    else falta.push("Cargar la facturación de los últimos 6 meses");
    if (estado.meta.conectado) ya.push("Cuenta de Meta conectada");
    if (estado.crm.conectado) ya.push("CRM conectado a Metrics");
    if (!faltanMarca.length) ya.push("Datos de marca completos");
    for (const s of estado.onboarding.sesiones) {
      if (s.estado === "cumplida") ya.push(`${s.etiqueta}: ya se hizo`);
      else if (s.estado === "agendada") ya.push(`${s.etiqueta}: agendada para ${s.fecha}`);
      else if (s.estado === "no_aplica") continue;
      else if (s.estado !== "ya_paso_sin_cerrar") falta.push(`Agendar ${s.etiqueta}`);
    }
    for (const c of estado.citas) ya.push(`Cita agendada: ${c.cita}, ${c.cuando} con ${c.con}`);
    if (aprobados) ya.push(`${aprobados} guion${aprobados === 1 ? "" : "es"} aprobado${aprobados === 1 ? "" : "s"} (en su planificación de Metrics)`);
    if (porRevisar) falta.push(`Revisar ${porRevisar} guion${porRevisar === 1 ? "" : "es"} en su planificación`);
    if (videosAprobados) ya.push(`${videosAprobados} video${videosAprobados === 1 ? "" : "s"} aprobado${videosAprobados === 1 ? "" : "s"}`);
    if (videosPorRevisar) falta.push(`Revisar ${videosPorRevisar} video${videosPorRevisar === 1 ? "" : "s"} editado${videosPorRevisar === 1 ? "" : "s"}`);
    if (bloqueo) falta.push(`Ponerse al día con el pago (${bloqueo.deudaTexto})`);
    return estado;
  }

  /** La foto en texto corto, para el system prompt de las IA. */
  enTexto(e: EstadoEnMetrics): string {
    const citas = e.citas.length
      ? e.citas.map((c) => `- ${c.cita}: ${c.cuando} con ${c.con}${c.linkMeet ? ` · Meet: ${c.linkMeet}` : ""}${c.lugar ? ` · Lugar: ${c.lugar}` : ""}`).join("\n")
      : "- Ninguna cita futura";
    return [
      `YA ESTÁ HECHO EN METRICS (no lo vuelvas a pedir; si sale el tema, dile que ya está listo en Metrics):`,
      e.yaEsta.length ? e.yaEsta.map((x) => `- ${x}`).join("\n") : "- Nada todavía",
      ``,
      `LO QUE FALTA DE VERDAD:`,
      e.falta.length ? e.falta.map((x) => `- ${x}`).join("\n") : "- Nada: está al día",
      ``,
      `CITAS AGENDADAS (con su link de Meet si es videollamada):`,
      citas,
      ``,
      `Guiones: ${e.guiones.total} en total, ${e.guiones.aprobados} aprobados, ${e.guiones.porRevisar} por revisar, ${e.guiones.conCorrecciones} con correcciones. Se ven y aprueban en ${e.guiones.dondeVer}`,
      `Videos: ${e.videos.editados} editados, ${e.videos.aprobadosPorCliente} aprobados, ${e.videos.porRevisar} por revisar, ${e.videos.publicados} publicados.`,
    ].join("\n");
  }
}

export const estadoMetricsService = new EstadoMetricsService();
