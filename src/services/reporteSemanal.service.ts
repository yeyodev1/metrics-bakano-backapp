import { Types } from "mongoose";
import models from "../models";
import { resendService } from "./resend.service";
import { telegramService, escaparHtml } from "./telegram.service";
import { chatsDeClienteDelEntorno, chatsDeUsuario } from "./chatsTelegram.service";
import { planningNotificationService } from "./planningNotification.service";
import { crmMetricasService, duracionLegible } from "./crmMetricas.service";
import { esperaVeredicto } from "./videoReviewNotification.service";

/**
 * Reporte semanal: cada viernes a las 6 pm (Ecuador) cada cliente recibe por
 * Telegram y correo todo lo que Bakano hizo por el esa semana, con cuanto
 * tardo cada etapa y quien la hizo, lo que queda pendiente y su CRM. Diego
 * (direccion) recibe el consolidado de todos con los tiempos por persona.
 *
 * Los tiempos salen de las fechas de etapa de cada video (guionCreadoEn,
 * guionAprobadoEn, grabadoEn, versiones, videoAprobadoEn). Lo historico sin
 * fecha se cuenta como "sin dato": no se inventa.
 *
 * Idempotente por semana (ReporteSemanal es el candado): el cron corre varias
 * veces el viernes y cada corrida sigue donde quedo la anterior.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const HORA_MS = 3_600_000;
const DIA_MS = 24 * HORA_MS;
/** Ecuador: UTC-5 todo el ano. */
const OFFSET_MS = 5 * HORA_MS;
const PRESUPUESTO_MS = 45_000;

// ── Semana ────────────────────────────────────────────────────────────────
/**
 * El viernes 18:00 de Ecuador (23:00 UTC) de la semana en curso. Si todavia
 * no llega, el reporte es "en curso" hasta ahora (para previsualizar).
 */
export function rangoSemana(ahora = new Date()): { semana: string; desde: Date; hasta: Date; cerrada: boolean } {
  const ec = new Date(ahora.getTime() - OFFSET_MS);
  const hastaViernes = (5 - ec.getUTCDay() + 7) % 7;
  const viernes = new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), ec.getUTCDate() + hastaViernes));
  const corte = new Date(viernes.getTime() + 23 * HORA_MS);
  const cerrada = ahora.getTime() >= corte.getTime();
  const hasta = cerrada ? corte : ahora;
  return { semana: viernes.toISOString().slice(0, 10), desde: new Date(corte.getTime() - 7 * DIA_MS), hasta, cerrada };
}

// ── Tipos ─────────────────────────────────────────────────────────────────
export type EtapaTiempo = "guion" | "grabacion" | "edicion" | "revision_cliente" | "correccion";

export const ETIQUETA_ETAPA: Record<EtapaTiempo, string> = {
  guion: "Guion escrito → aprobado por ti",
  grabacion: "Guion aprobado → grabado",
  edicion: "Grabado → video entregado",
  revision_cliente: "Video entregado → aprobado por ti",
  correccion: "Tus cambios → nueva versión",
};

/** Etiquetas para el equipo (consolidado). */
const ETIQUETA_ETAPA_EQUIPO: Record<EtapaTiempo, string> = {
  guion: "Guion → aprobado",
  grabacion: "Aprobado → grabado",
  edicion: "Grabado → entregado",
  revision_cliente: "Entregado → aprobado (cliente)",
  correccion: "Cambios → nueva versión",
};

export interface Medicion {
  etapa: EtapaTiempo;
  horas: number;
  quien?: string;
}

export interface TiempoEtapa {
  etapa: EtapaTiempo;
  etiqueta: string;
  promedioHoras: number | null;
  muestras: number;
  sinDato: number;
  quienes: { nombre: string; promedioHoras: number; muestras: number }[];
}

export interface ReporteCliente {
  workspaceId: string;
  cliente: string;
  semana: string;
  desde: Date;
  hasta: Date;
  guiones: { escritos: number; aprobados: number; corregidos: number };
  producciones: { titulo: string; fecha: Date; por?: string }[];
  videos: { entregados: number; nuevasVersiones: number; aprobados: number; rondasCorreccion: number; publicados: number };
  tiempos: TiempoEtapa[];
  pendientes: {
    guionesPorAprobar: number;
    videosPorRevisar: number;
    videosPorEditar: number;
    reEdiciones: number;
    proximaProduccion: { titulo: string; fecha: Date } | null;
  };
  crm: {
    conversaciones: number;
    contactos: number;
    sinRespuesta: number;
    medianaRespuesta: string | null;
    masRapido: string | null;
  } | null;
  hayMovimiento: boolean;
  hayPendientes: boolean;
}

// ── Calculo puro (probado sin base) ───────────────────────────────────────
const enRango = (d: unknown, desde: Date, hasta: Date): d is Date =>
  d instanceof Date ? d >= desde && d < hasta : d ? enRango(new Date(d as any), desde, hasta) : false;
const fecha = (d: unknown): Date | null => (d ? new Date(d as any) : null);

/**
 * Lo que paso con los videos en la semana: conteos y mediciones de tiempo.
 * `fechaProduccion` da la fecha real de grabacion cuando el item no la tiene
 * (la produccion se marco cumplida sin pasar cada guion a GRABADO).
 */
export function medirItems(
  items: any[],
  desde: Date,
  hasta: Date,
  fechaProduccion: (item: any) => Date | null = () => null
) {
  const conteo = { escritos: 0, aprobados: 0, entregados: 0, nuevasVersiones: 0, videosAprobados: 0, rondas: 0, publicados: 0 };
  const mediciones: Medicion[] = [];
  const sinDato: Record<EtapaTiempo, number> = { guion: 0, grabacion: 0, edicion: 0, revision_cliente: 0, correccion: 0 };
  const medir = (etapa: EtapaTiempo, inicio: Date | null, fin: Date | null, quien?: string) => {
    if (!fin || !enRango(fin, desde, hasta)) return;
    if (!inicio || inicio > fin) {
      sinDato[etapa]++;
      return;
    }
    mediciones.push({ etapa, horas: (fin.getTime() - inicio.getTime()) / HORA_MS, quien: quien || undefined });
  };

  for (const it of items) {
    if (enRango(it.guionCreadoEn, desde, hasta)) conteo.escritos++;
    if (enRango(it.guionAprobadoEn, desde, hasta)) conteo.aprobados++;
    if (enRango(it.videoAprobadoEn, desde, hasta)) conteo.videosAprobados++;
    if (enRango(it.publicadoEn, desde, hasta)) conteo.publicados++;

    const versiones: any[] = [...(it.versiones ?? [])].sort((a, b) => a.n - b.n);
    for (const v of versiones) {
      if (!enRango(v.en, desde, hasta)) continue;
      if (v.n === 1) conteo.entregados++;
      else conteo.nuevasVersiones++;
    }
    // Entrega hecha antes de existir el historial de versiones.
    if (!versiones.length && enRango(it.editadoEn, desde, hasta)) conteo.entregados++;

    const correcciones: any[] = it.correccionesVideo ?? [];
    const rondas = new Map<number, Date>();
    for (const c of correcciones) {
      const en = fecha(c.en)!;
      if (!rondas.has(c.ronda) || en < rondas.get(c.ronda)!) rondas.set(c.ronda, en);
    }
    for (const en of rondas.values()) if (enRango(en, desde, hasta)) conteo.rondas++;

    const grabado = fecha(it.grabadoEn) ?? fechaProduccion(it);
    const primeraEntrega = versiones.length ? fecha(versiones[0].en) : fecha(it.editadoEn);
    medir("guion", fecha(it.guionCreadoEn), fecha(it.guionAprobadoEn), it.guionPorNombre);
    medir("grabacion", fecha(it.guionAprobadoEn), grabado);
    medir("edicion", grabado, primeraEntrega, versiones[0]?.subidoPorNombre || it.editorPorNombre);
    // La revision del cliente se mide sobre la version que aprobo.
    const vigente = versiones.length ? fecha(versiones[versiones.length - 1].en) : fecha(it.editadoEn);
    medir("revision_cliente", vigente, fecha(it.videoAprobadoEn));
    // Cada ronda de cambios → la version que la resolvio.
    for (const [ronda, en] of rondas) {
      const resolvio = versiones.find((v) => v.n === ronda + 1);
      if (resolvio) medir("correccion", en, fecha(resolvio.en), resolvio.subidoPorNombre);
    }
  }
  return { conteo, mediciones, sinDato };
}

export function resumirTiempos(
  mediciones: Medicion[],
  sinDato: Record<EtapaTiempo, number>,
  etiquetas: Record<EtapaTiempo, string> = ETIQUETA_ETAPA
): TiempoEtapa[] {
  const etapas: EtapaTiempo[] = ["guion", "grabacion", "edicion", "revision_cliente", "correccion"];
  const prom = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  return etapas
    .map((etapa) => {
      const deEtapa = mediciones.filter((m) => m.etapa === etapa);
      const porQuien = new Map<string, number[]>();
      for (const m of deEtapa) if (m.quien) porQuien.set(m.quien, [...(porQuien.get(m.quien) ?? []), m.horas]);
      return {
        etapa,
        etiqueta: etiquetas[etapa],
        promedioHoras: prom(deEtapa.map((m) => m.horas)),
        muestras: deEtapa.length,
        sinDato: sinDato[etapa] ?? 0,
        quienes: [...porQuien.entries()]
          .map(([nombre, xs]) => ({ nombre, promedioHoras: prom(xs)!, muestras: xs.length }))
          .sort((a, b) => a.promedioHoras - b.promedioHoras),
      };
    })
    .filter((t) => t.muestras || t.sinDato);
}

/** 5 → "5 h", 30 → "1,3 días", 0.4 → "24 min". */
export function duracionHoras(horas: number | null): string {
  if (horas === null || !Number.isFinite(horas)) return "sin dato";
  if (horas < 1) return `${Math.max(1, Math.round(horas * 60))} min`;
  if (horas < 48) return `${Math.round(horas)} h`;
  return `${(horas / 24).toFixed(1).replace(".", ",").replace(",0", "")} días`;
}

const fechaCorta = (d: Date) =>
  new Intl.DateTimeFormat("es-EC", { timeZone: "America/Guayaquil", weekday: "short", day: "numeric", month: "short" }).format(d);
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

// ── Textos ────────────────────────────────────────────────────────────────
export function textoTelegram(r: ReporteCliente): string {
  const l: string[] = [`📊 <b>Tu semana con Bakano</b> · ${escaparHtml(r.cliente)}`, `<i>${fechaCorta(r.desde)} – ${fechaCorta(r.hasta)}</i>`, ""];
  const hecho: string[] = [];
  if (r.guiones.escritos) hecho.push(`✍️ ${plural(r.guiones.escritos, "guion escrito", "guiones escritos")}`);
  if (r.guiones.aprobados) hecho.push(`✅ ${plural(r.guiones.aprobados, "guion aprobado", "guiones aprobados")}`);
  if (r.guiones.corregidos) hecho.push(`📝 ${plural(r.guiones.corregidos, "guion corregido", "guiones corregidos")} con tus cambios`);
  for (const p of r.producciones) hecho.push(`🎬 Producción realizada: ${escaparHtml(p.titulo)} (${fechaCorta(p.fecha)})`);
  if (r.videos.entregados) hecho.push(`🎞️ ${plural(r.videos.entregados, "video entregado", "videos entregados")}`);
  if (r.videos.nuevasVersiones) hecho.push(`🔁 ${plural(r.videos.nuevasVersiones, "nueva versión", "nuevas versiones")} con tus correcciones`);
  if (r.videos.aprobados) hecho.push(`👍 ${plural(r.videos.aprobados, "video aprobado", "videos aprobados")} por ti`);
  if (r.videos.publicados) hecho.push(`📣 ${plural(r.videos.publicados, "video publicado", "videos publicados")}`);
  if (hecho.length) l.push("<b>Lo que hicimos</b>", ...hecho, "");
  else l.push("Esta semana no hubo entregas nuevas.", "");

  const tiempos = r.tiempos.filter((t) => t.muestras);
  if (tiempos.length) {
    l.push("<b>Cuánto tardó cada cosa</b>");
    for (const t of tiempos) {
      const quien = t.quienes.length ? ` · ${t.quienes.map((q) => escaparHtml(q.nombre.split(" ")[0])).join(", ")}` : "";
      l.push(`⏱️ ${t.etiqueta}: <b>${duracionHoras(t.promedioHoras)}</b>${quien}`);
    }
    l.push("");
  }

  const p = r.pendientes;
  const pend: string[] = [];
  if (p.videosPorRevisar) pend.push(`🎬 Tienes ${plural(p.videosPorRevisar, "video", "videos")} por revisar`);
  if (p.guionesPorAprobar) pend.push(`📝 Tienes ${plural(p.guionesPorAprobar, "guion", "guiones")} por aprobar`);
  if (p.reEdiciones) pend.push(`✂️ Estamos aplicando tus cambios en ${plural(p.reEdiciones, "video", "videos")}`);
  if (p.videosPorEditar) pend.push(`🎞️ ${plural(p.videosPorEditar, "video", "videos")} en edición`);
  if (p.proximaProduccion) pend.push(`📅 Próxima producción: ${fechaCorta(p.proximaProduccion.fecha)}`);
  if (pend.length) l.push("<b>Para la próxima semana</b>", ...pend, "");

  if (r.crm) {
    l.push(
      "<b>Tu CRM</b>",
      `💬 ${plural(r.crm.conversaciones, "conversación", "conversaciones")} · ${plural(r.crm.contactos, "contacto escribió", "contactos escribieron")}`
    );
    if (r.crm.medianaRespuesta) l.push(`⚡ Tu equipo respondió en ${r.crm.medianaRespuesta} (mediana)${r.crm.masRapido ? ` · el más rápido: ${escaparHtml(r.crm.masRapido)}` : ""}`);
    if (r.crm.sinRespuesta) l.push(`⚠️ ${plural(r.crm.sinRespuesta, "conversación quedó", "conversaciones quedaron")} sin respuesta`);
    l.push("");
  }
  l.push("Gracias por confiar en nosotros 💛");
  return l.join("\n");
}

function filaHtml(texto: string, valor: string): string {
  return `<tr><td style="padding:9px 0;border-bottom:1px solid #eceaf1;font-size:14px;color:#374151;">${texto}</td><td style="padding:9px 0;border-bottom:1px solid #eceaf1;font-size:14px;font-weight:700;color:#191423;text-align:right;white-space:nowrap;">${valor}</td></tr>`;
}

function seccionHtml(titulo: string, filas: string[]): string {
  if (!filas.length) return "";
  return `<tr><td style="padding:20px 40px 4px;"><p style="margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:0.08em;color:#6b7280;text-transform:uppercase;">${titulo}</p><table width="100%" cellpadding="0" cellspacing="0">${filas.join("")}</table></td></tr>`;
}

export function bloquesCorreoCliente(r: ReporteCliente): string {
  const esc = escaparHtml;
  const hecho: string[] = [];
  if (r.guiones.escritos) hecho.push(filaHtml("Guiones escritos", String(r.guiones.escritos)));
  if (r.guiones.aprobados) hecho.push(filaHtml("Guiones aprobados", String(r.guiones.aprobados)));
  if (r.guiones.corregidos) hecho.push(filaHtml("Guiones corregidos con tus cambios", String(r.guiones.corregidos)));
  for (const p of r.producciones) hecho.push(filaHtml(`Producción realizada · ${esc(p.titulo)}`, fechaCorta(p.fecha)));
  if (r.videos.entregados) hecho.push(filaHtml("Videos entregados", String(r.videos.entregados)));
  if (r.videos.nuevasVersiones) hecho.push(filaHtml("Nuevas versiones con tus correcciones", String(r.videos.nuevasVersiones)));
  if (r.videos.aprobados) hecho.push(filaHtml("Videos aprobados por ti", String(r.videos.aprobados)));
  if (r.videos.publicados) hecho.push(filaHtml("Videos publicados", String(r.videos.publicados)));
  if (!hecho.length) hecho.push(filaHtml("Entregas nuevas", "Ninguna esta semana"));

  const tiempos = r.tiempos
    .filter((t) => t.muestras)
    .map((t) => filaHtml(`${t.etiqueta}${t.quienes.length ? ` <span style="color:#9ca3af;">· ${t.quienes.map((q) => esc(q.nombre)).join(", ")}</span>` : ""}`, duracionHoras(t.promedioHoras)));

  const p = r.pendientes;
  const pend: string[] = [];
  if (p.videosPorRevisar) pend.push(filaHtml("Videos que esperan tu revisión", String(p.videosPorRevisar)));
  if (p.guionesPorAprobar) pend.push(filaHtml("Guiones que esperan tu aprobación", String(p.guionesPorAprobar)));
  if (p.reEdiciones) pend.push(filaHtml("Videos con tus cambios en proceso", String(p.reEdiciones)));
  if (p.videosPorEditar) pend.push(filaHtml("Videos en edición", String(p.videosPorEditar)));
  if (p.proximaProduccion) pend.push(filaHtml(`Próxima producción · ${esc(p.proximaProduccion.titulo)}`, fechaCorta(p.proximaProduccion.fecha)));

  const crm: string[] = [];
  if (r.crm) {
    crm.push(filaHtml("Conversaciones", String(r.crm.conversaciones)));
    crm.push(filaHtml("Contactos que escribieron", String(r.crm.contactos)));
    if (r.crm.medianaRespuesta) crm.push(filaHtml("Tiempo de respuesta de tu equipo (mediana)", r.crm.medianaRespuesta));
    if (r.crm.masRapido) crm.push(filaHtml("Asesor más rápido", esc(r.crm.masRapido)));
    crm.push(filaHtml("Conversaciones sin respuesta", String(r.crm.sinRespuesta)));
  }

  return [
    seccionHtml("Lo que hicimos", hecho),
    seccionHtml("Cuánto tardó cada cosa (promedio)", tiempos),
    seccionHtml("Para la próxima semana", pend),
    seccionHtml("Tu CRM", crm),
  ].join("");
}

export interface FilaConsolidado {
  cliente: string;
  r: ReporteCliente;
}

export function bloquesCorreoConsolidado(filas: FilaConsolidado[], equipo: TiempoEtapa[]): string {
  const esc = escaparHtml;
  const total = filas.reduce(
    (a, { r }) => ({
      guiones: a.guiones + r.guiones.escritos,
      aprobados: a.aprobados + r.guiones.aprobados,
      producciones: a.producciones + r.producciones.length,
      entregados: a.entregados + r.videos.entregados,
      versiones: a.versiones + r.videos.nuevasVersiones,
      videosOk: a.videosOk + r.videos.aprobados,
      rondas: a.rondas + r.videos.rondasCorreccion,
    }),
    { guiones: 0, aprobados: 0, producciones: 0, entregados: 0, versiones: 0, videosOk: 0, rondas: 0 }
  );
  const resumen = [
    filaHtml("Guiones escritos / aprobados", `${total.guiones} / ${total.aprobados}`),
    filaHtml("Producciones realizadas", String(total.producciones)),
    filaHtml("Videos entregados / nuevas versiones", `${total.entregados} / ${total.versiones}`),
    filaHtml("Videos aprobados por clientes", String(total.videosOk)),
    filaHtml("Rondas de corrección pedidas", String(total.rondas)),
  ];
  const tiempos: string[] = [];
  for (const t of equipo.filter((x) => x.muestras || x.sinDato)) {
    tiempos.push(filaHtml(`<b>${t.etiqueta}</b>${t.sinDato ? ` <span style="color:#9ca3af;">(${t.sinDato} sin dato)</span>` : ""}`, duracionHoras(t.promedioHoras)));
    for (const q of t.quienes) tiempos.push(filaHtml(`&nbsp;&nbsp;&nbsp;${esc(q.nombre)} · ${q.muestras}`, duracionHoras(q.promedioHoras)));
  }
  const porCliente = filas.map(({ cliente, r }) => {
    const partes = [
      r.guiones.escritos && `${r.guiones.escritos} guiones`,
      r.producciones.length && `${r.producciones.length} prod.`,
      (r.videos.entregados || r.videos.nuevasVersiones) && `${r.videos.entregados + r.videos.nuevasVersiones} videos`,
      r.videos.rondasCorreccion && `${r.videos.rondasCorreccion} rondas`,
    ].filter(Boolean);
    const pend = [
      r.pendientes.videosPorRevisar && `${r.pendientes.videosPorRevisar} por revisar`,
      r.pendientes.guionesPorAprobar && `${r.pendientes.guionesPorAprobar} guiones por aprobar`,
      r.pendientes.reEdiciones && `${r.pendientes.reEdiciones} re-ediciones`,
    ].filter(Boolean);
    return filaHtml(
      `<b>${esc(cliente)}</b>${pend.length ? `<br><span style="font-size:12px;color:#b45309;">${pend.join(" · ")}</span>` : ""}`,
      partes.length ? partes.join(" · ") : "sin movimiento"
    );
  });
  return [seccionHtml("Bakano esta semana", resumen), seccionHtml("Tiempos por etapa y persona", tiempos), seccionHtml("Por cliente", porCliente)].join("");
}

export function textoTelegramConsolidado(filas: FilaConsolidado[], equipo: TiempoEtapa[], semana: { desde: Date; hasta: Date }): string {
  const sum = (f: (r: ReporteCliente) => number) => filas.reduce((a, x) => a + f(x.r), 0);
  const l = [
    `📊 <b>Bakano esta semana</b> · ${fechaCorta(semana.desde)} – ${fechaCorta(semana.hasta)}`,
    "",
    `✍️ ${sum((r) => r.guiones.escritos)} guiones escritos · ✅ ${sum((r) => r.guiones.aprobados)} aprobados`,
    `🎬 ${sum((r) => r.producciones.length)} producciones`,
    `🎞️ ${sum((r) => r.videos.entregados)} videos entregados · 🔁 ${sum((r) => r.videos.nuevasVersiones)} nuevas versiones`,
    `👍 ${sum((r) => r.videos.aprobados)} videos aprobados · ✏️ ${sum((r) => r.videos.rondasCorreccion)} rondas de cambios`,
    "",
  ];
  const t = equipo.filter((x) => x.muestras);
  if (t.length) {
    l.push("<b>Tiempos</b>");
    for (const x of t) {
      l.push(`⏱️ ${x.etiqueta}: <b>${duracionHoras(x.promedioHoras)}</b>`);
      for (const q of x.quienes.slice(0, 4)) l.push(`   · ${escaparHtml(q.nombre)}: ${duracionHoras(q.promedioHoras)} (${q.muestras})`);
    }
    l.push("");
  }
  const atrasados = filas.filter((x) => x.r.pendientes.videosPorRevisar || x.r.pendientes.reEdiciones || x.r.pendientes.guionesPorAprobar);
  if (atrasados.length) {
    l.push("<b>Pendientes</b>");
    for (const x of atrasados.slice(0, 12)) {
      const p = x.r.pendientes;
      const partes = [
        p.videosPorRevisar && `${p.videosPorRevisar} por revisar`,
        p.guionesPorAprobar && `${p.guionesPorAprobar} guiones`,
        p.reEdiciones && `${p.reEdiciones} re-ediciones`,
      ].filter(Boolean);
      l.push(`• ${escaparHtml(x.cliente)}: ${partes.join(", ")}`);
    }
  }
  l.push("", "El detalle completo está en tu correo.");
  return l.join("\n");
}

// ── Servicio ──────────────────────────────────────────────────────────────
export interface Generado {
  reporte: ReporteCliente;
  mediciones: Medicion[];
  sinDato: Record<EtapaTiempo, number>;
}

/** Lo guardado en Mongo vuelve con fechas como Date. */
function revivir(g: any): Generado {
  const r = g.reporte;
  return {
    ...g,
    reporte: {
      ...r,
      desde: new Date(r.desde),
      hasta: new Date(r.hasta),
      producciones: (r.producciones ?? []).map((p: any) => ({ ...p, fecha: new Date(p.fecha) })),
      pendientes: {
        ...r.pendientes,
        proximaProduccion: r.pendientes?.proximaProduccion
          ? { ...r.pendientes.proximaProduccion, fecha: new Date(r.pendientes.proximaProduccion.fecha) }
          : null,
      },
    },
  };
}

class ReporteSemanalService {
  /** Arma el reporte de un cliente para la semana (sin enviar nada). */
  async generar(workspaceId: string, ahora = new Date()): Promise<Generado> {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    const { semana, desde, hasta } = rangoSemana(ahora);
    const wsId = new Types.ObjectId(workspaceId);
    const workspace = await models.workspaces.findById(wsId).select("name").lean();
    if (!workspace) throw new Error("NOT_FOUND");

    // Planificaciones que se movieron hace poco (una etapa que termina esta
    // semana pudo empezar semanas atras, pero el documento se guardo ahora).
    const vps = await models.videoPlanning
      .find({ workspaceId: wsId, updatedAt: { $gte: new Date(desde.getTime() - 45 * DIA_MS) } })
      .select("planningEntryId listaParaCliente clienteAprobado items")
      .lean();
    const entradas = await models.planning
      .find({ _id: { $in: vps.map((v) => v.planningEntryId) } })
      .select("_id date cumplida")
      .lean();
    const produccionDe = new Map(entradas.map((e) => [String(e._id), e.cumplida ? new Date(e.date) : null]));

    const items: any[] = [];
    const planningDeItem = new Map<any, string>();
    for (const vp of vps) for (const it of vp.items) {
      items.push(it);
      planningDeItem.set(it, String(vp.planningEntryId));
    }
    const { conteo, mediciones, sinDato } = medirItems(items, desde, hasta, (it) => produccionDe.get(planningDeItem.get(it) || "") ?? null);

    const [corregidos, realizadas, proxima, crm] = await Promise.all([
      models.reviewEvents.countDocuments({
        workspaceId: wsId,
        etapa: "contenido",
        fuente: "cliente",
        resultado: "rechazado",
        createdAt: { $gte: desde, $lt: hasta },
      }),
      models.planning
        .find({ workspaceId: wsId, cumplida: true, cumplidaEn: { $gte: desde, $lt: hasta } })
        .select("title date cumplidaPorNombre")
        .sort({ date: 1 })
        .lean(),
      models.planning
        .findOne({ workspaceId: wsId, date: { $gte: hasta }, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } })
        .select("title date")
        .sort({ date: 1 })
        .lean(),
      crmMetricasService.rango(workspaceId, 7).catch(() => null),
    ]);

    const pendientes = {
      guionesPorAprobar: vps
        .filter((v) => v.listaParaCliente && !v.clienteAprobado)
        .reduce((a, v) => a + v.items.filter((i) => i.clienteAprobacion === "PENDIENTE").length, 0),
      videosPorRevisar: items.filter(esperaVeredicto).length,
      videosPorEditar: items.filter((i) => i.edicion === "POR_EDITAR" && i.estadoProduccion === "GRABADO" && i.estadoIdea !== "RECHAZADO").length,
      reEdiciones: items.filter((i) => i.edicion === "RECHAZADO").length,
      proximaProduccion: proxima ? { titulo: proxima.title, fecha: new Date(proxima.date) } : null,
    };

    const crmResumen =
      crm?.conectado && crm.totales.conversaciones
        ? {
            conversaciones: crm.totales.conversaciones,
            contactos: crm.totales.contactosQueEscribieron,
            sinRespuesta: crm.totales.sinRespuesta,
            medianaRespuesta: duracionLegible(crm.totales.medianaRespuestaSeg),
            masRapido:
              [...(crm.asesores ?? [])]
                .filter((a: any) => a.medianaRespuestaSeg !== null && a.respuestas >= 3)
                .sort((a: any, b: any) => a.medianaRespuestaSeg - b.medianaRespuestaSeg)[0]?.nombre ?? null,
          }
        : null;

    const reporte: ReporteCliente = {
      workspaceId,
      cliente: workspace.name,
      semana,
      desde,
      hasta,
      guiones: { escritos: conteo.escritos, aprobados: conteo.aprobados, corregidos },
      producciones: realizadas.map((p) => ({ titulo: p.title, fecha: new Date(p.date), por: p.cumplidaPorNombre })),
      videos: {
        entregados: conteo.entregados,
        nuevasVersiones: conteo.nuevasVersiones,
        aprobados: conteo.videosAprobados,
        rondasCorreccion: conteo.rondas,
        publicados: conteo.publicados,
      },
      tiempos: resumirTiempos(mediciones, sinDato),
      pendientes,
      crm: crmResumen,
      hayMovimiento: Boolean(
        conteo.escritos || conteo.aprobados || corregidos || realizadas.length || conteo.entregados || conteo.nuevasVersiones || conteo.videosAprobados || conteo.publicados || conteo.rondas
      ),
      hayPendientes: Boolean(pendientes.guionesPorAprobar || pendientes.videosPorRevisar || pendientes.reEdiciones || pendientes.videosPorEditar),
    };
    return { reporte, mediciones, sinDato };
  }

  /** Lo que se mandaria, para que el equipo lo vea antes (no envia nada). */
  async previsualizar(workspaceId: string) {
    const { reporte } = await this.generar(workspaceId);
    return { reporte, telegram: textoTelegram(reporte), correoHtml: this.correoCliente(reporte) };
  }

  private correoCliente(r: ReporteCliente): string {
    return resendService.htmlReporteSemanal({
      titulo: "Tu semana con Bakano",
      subtitulo: `${r.cliente} · ${fechaCorta(r.desde)} – ${fechaCorta(r.hasta)}`,
      bloques: bloquesCorreoCliente(r),
      boton: { texto: "Ver en Metrics", url: `${APP_URL}/app/workspaces/${r.workspaceId}/planning` },
      pie: "Este reporte sale cada viernes a las 6 pm. Si algo no cuadra, respóndenos por Telegram.",
    });
  }

  /** Envia el reporte de un cliente (Telegram + correo). Solo lo envia. */
  async enviarCliente(r: ReporteCliente, soloCorreo?: string): Promise<{ telegram: number; correos: number }> {
    const html = this.correoCliente(r);
    const asunto = `Tu semana con Bakano · ${r.cliente}`;
    if (soloCorreo) {
      await resendService.sendReporteSemanal({ to: [soloCorreo], asunto: `[Prueba] ${asunto}`, html });
      return { telegram: 0, correos: 1 };
    }
    let telegram = 0;
    for (const c of await chatsDeClienteDelEntorno(r.workspaceId)) {
      try {
        await telegramService.sendMessage(c.chatId, textoTelegram(r), [[{ text: "📋 Ver menú", callback_data: "menu:ver" }]]);
        telegram++;
      } catch (e: any) {
        console.warn("[Reporte semanal] Telegram:", e?.message);
      }
    }
    const { correos } = await planningNotificationService.destinatarios(new Types.ObjectId(r.workspaceId));
    if (correos.length) await resendService.sendReporteSemanal({ to: correos, asunto, html });
    return { telegram, correos: correos.length };
  }

  /**
   * Consolidado para direccion: todos los clientes activos de la semana y
   * los tiempos por persona del equipo.
   */
  async consolidado(ahora = new Date(), guardados?: Generado[]) {
    const { desde, hasta } = rangoSemana(ahora);
    let generados = guardados;
    if (!generados) {
      // En vivo (previsualizacion): de a 5 clientes a la vez.
      const activos = await models.workspaces.find({ isActive: true }).select("_id name").lean();
      generados = [];
      for (let i = 0; i < activos.length; i += 5) {
        const lote = await Promise.all(
          activos.slice(i, i + 5).map((ws) =>
            this.generar(String(ws._id), ahora).catch((e: any) => {
              console.warn(`[Reporte semanal] consolidado ${ws.name}:`, e?.message);
              return null;
            })
          )
        );
        generados.push(...(lote.filter(Boolean) as Generado[]));
      }
    }
    const filas: FilaConsolidado[] = [];
    const mediciones: Medicion[] = [];
    const sinDato: Record<EtapaTiempo, number> = { guion: 0, grabacion: 0, edicion: 0, revision_cliente: 0, correccion: 0 };
    for (const g of generados.sort((a, b) => a.reporte.cliente.localeCompare(b.reporte.cliente))) {
      if (!g.reporte.hayMovimiento && !g.reporte.hayPendientes) continue;
      filas.push({ cliente: g.reporte.cliente, r: g.reporte });
      mediciones.push(...g.mediciones);
      for (const k of Object.keys(sinDato) as EtapaTiempo[]) sinDato[k] += g.sinDato[k] ?? 0;
    }
    const equipo = resumirTiempos(mediciones, sinDato, ETIQUETA_ETAPA_EQUIPO);
    return {
      filas,
      equipo,
      telegram: textoTelegramConsolidado(filas, equipo, { desde, hasta }),
      correoHtml: resendService.htmlReporteSemanal({
        titulo: "Bakano esta semana",
        subtitulo: `${filas.length} clientes con movimiento · ${fechaCorta(desde)} – ${fechaCorta(hasta)}`,
        bloques: bloquesCorreoConsolidado(filas, equipo),
        boton: { texto: "Abrir Metrics", url: `${APP_URL}/app/clients` },
        pie: "Tiempos promedio de las etapas que terminaron esta semana. Lo que no tenía fecha registrada cuenta como sin dato.",
      }),
    };
  }

  private async enviarConsolidado(c: Awaited<ReturnType<ReporteSemanalService["consolidado"]>>): Promise<{ telegram: number; correos: number }> {
    const direccion = await models.users.find({ role: "superadmin", isActive: { $ne: false } }).select("_id email").lean();
    let telegram = 0;
    for (const u of direccion) {
      for (const chatId of await chatsDeUsuario(u._id)) {
        try {
          await telegramService.sendMessage(chatId, c.telegram);
          telegram++;
        } catch (e: any) {
          console.warn("[Reporte semanal] Telegram dirección:", e?.message);
        }
      }
    }
    const correos = direccion.map((u) => u.email).filter(Boolean) as string[];
    if (correos.length) await resendService.sendReporteSemanal({ to: correos, asunto: "Bakano esta semana · reporte consolidado", html: c.correoHtml });
    return { telegram, correos: correos.length };
  }

  /**
   * Corrida del cron (viernes 18:00 Ecuador en adelante). Cada cliente activo
   * una vez por semana; al final, el consolidado. Corta antes de los 60 s de
   * Vercel y la siguiente corrida sigue.
   */
  async correr(ahora = new Date()): Promise<{ semana: string; enviados: number; omitidos: number; fallidos: number; pendientes: number; consolidado: boolean }> {
    const limite = Date.now() + PRESUPUESTO_MS;
    const { semana, cerrada } = rangoSemana(ahora);
    const resultado = { semana, enviados: 0, omitidos: 0, fallidos: 0, pendientes: 0, consolidado: false };
    if (!cerrada) return resultado;

    const [activos, hechos] = await Promise.all([
      models.workspaces.find({ isActive: true }).select("_id name").lean(),
      models.reportesSemanales.find({ semana }).select("workspaceId").lean(),
    ]);
    const listos = new Set(hechos.map((h) => String(h.workspaceId)));
    const faltan = activos.filter((w) => !listos.has(String(w._id)));

    for (const ws of faltan) {
      if (Date.now() > limite) break;
      // El candado se toma antes de enviar: dos corridas a la vez no duplican.
      let lock;
      try {
        lock = await models.reportesSemanales.create({ semana, workspaceId: ws._id, estado: "omitido", motivo: "en curso" });
      } catch {
        continue;
      }
      try {
        const generado = await this.generar(String(ws._id), ahora);
        const { reporte } = generado;
        if (!reporte.hayMovimiento && !reporte.hayPendientes) {
          await models.reportesSemanales.updateOne({ _id: lock._id }, { $set: { motivo: "sin movimiento ni pendientes" } });
          resultado.omitidos++;
          continue;
        }
        const r = await this.enviarCliente(reporte);
        await models.reportesSemanales.updateOne(
          { _id: lock._id },
          {
            $set: {
              estado: r.telegram || r.correos ? "enviado" : "omitido",
              telegram: r.telegram,
              correos: r.correos,
              motivo: r.telegram || r.correos ? undefined : "sin Telegram ni correos",
              datos: generado,
            },
          }
        );
        if (r.telegram || r.correos) resultado.enviados++;
        else resultado.omitidos++;
      } catch (e: any) {
        await models.reportesSemanales.updateOne({ _id: lock._id }, { $set: { estado: "fallido", motivo: String(e?.message || e).slice(0, 300) } });
        resultado.fallidos++;
      }
    }

    const quedan = await models.reportesSemanales.countDocuments({ semana, workspaceId: { $ne: null } });
    resultado.pendientes = Math.max(0, activos.length - quedan);
    if (!resultado.pendientes && Date.now() < limite) {
      try {
        const lock = await models.reportesSemanales.create({ semana, workspaceId: null, estado: "omitido", motivo: "en curso" });
        try {
          const guardados = await models.reportesSemanales
            .find({ semana, workspaceId: { $ne: null }, datos: { $exists: true } })
            .select("datos")
            .lean();
          const c = await this.consolidado(ahora, guardados.map((g) => revivir(g.datos)));
          const r = await this.enviarConsolidado(c);
          await models.reportesSemanales.updateOne({ _id: lock._id }, { $set: { estado: "enviado", telegram: r.telegram, correos: r.correos, motivo: undefined } });
          resultado.consolidado = true;
        } catch (e: any) {
          await models.reportesSemanales.updateOne({ _id: lock._id }, { $set: { estado: "fallido", motivo: String(e?.message || e).slice(0, 300) } });
        }
      } catch {
        // Ya lo tomo otra corrida.
      }
    }
    return resultado;
  }
}

export const reporteSemanalService = new ReporteSemanalService();
