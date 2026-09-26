import { Types } from "mongoose";
import { z } from "zod";
import models from "../models";
import type { CanalHallazgoCrm, TipoHallazgoCrm } from "../models/crmHallazgo.model";
import type { EstadoWhatsappCrm } from "../models/crmIntegration.model";
import { diaEcuador } from "./atencionCliente.service";
import { CrmTokenInvalidoError, type ConversacionCrm, type OportunidadCrm } from "./crmCliente.service";
import { bakanologyUrl, crmIntegracionService, linkIntegraciones } from "./crmIntegracion.service";
import { escaparHtml, telegramService, type InlineButton } from "./telegram.service";

/**
 * Revision diaria "cierres casi solos".
 *
 * Cada mañana se leen las ultimas 24 h del CRM de cada cliente conectado
 * (conversaciones y oportunidades) y la IA busca las ventas que el negocio
 * tenia casi hechas y dejo ir: el lead dijo que quiere, cuanto, cuando y
 * como paga, y nadie le pidio el cierre. Se guardan como CrmHallazgo y el
 * cliente recibe UN mensaje por Telegram con como retomarlas.
 *
 * Vercel corta a los 60 s: cada corrida toma los entornos que no se
 * revisaron hoy (los mas atrasados primero), en paralelo y con tope de
 * tiempo. El cron corre varias veces en la mañana y sigue donde quedo; la
 * CrmRevision del dia es el candado y la constancia.
 */

const modelo = () => process.env.AI_MODEL || "google/gemini-3.8-flash";
const HORAS_VENTANA = 24;
const MAX_HALLAZGOS = 5;
const MAX_CONVERSACIONES = 30;
/** Entornos revisados a la vez en una corrida. */
const EN_PARALELO = 4;
/** Presupuesto de la corrida: Vercel corta a los 60 s. */
const PRESUPUESTO_MS = 50_000;
/** No se arranca un lote nuevo si queda menos que esto. */
const MINIMO_PARA_LOTE_MS = 35_000;
const LIMITE_IA_MS = 30_000;
/** Una revision "en_curso" mas vieja que esto se considera caida y se retoma. */
const EN_CURSO_CADUCA_MS = 3 * 60_000;
const MAX_INTENTOS = 3;
/** Un lead ya reportado no se vuelve a mandar a la IA en estos dias. */
const DIAS_SIN_REPETIR = 7;

// ── AI SDK ────────────────────────────────────────────────────────────────
// Mismo patron que telegramAgent.service.ts (ver alli el porque): `ai` es
// solo ESM, se carga perezosamente y el require literal hace que Vercel lo
// empaquete. Se duplica a proposito para no tocar el cargador del bot.
type AiSdk = typeof import("ai");
let aiSdk: Promise<AiSdk> | null = null;
const importarEsm = new Function("modulo", "return import(modulo)") as (modulo: string) => Promise<any>;
async function traerAi(): Promise<AiSdk> {
  try {
    return require("ai") as AiSdk;
  } catch (error: any) {
    if (error?.code !== "ERR_REQUIRE_ESM" && !/ES Module/i.test(String(error?.message))) throw error;
    return (await importarEsm("ai")) as AiSdk;
  }
}
function cargarAi(): Promise<AiSdk> {
  aiSdk ??= traerAi().catch((error) => {
    aiSdk = null;
    throw error;
  });
  return aiSdk;
}

const sinApertura = (s: string) => s.replace(/[¡¿]/g, "").trim();

const hallazgoSchema = z.object({
  ref: z.string().describe("Referencia exacta del lead en la lista: C1, C2... u O1, O2..."),
  tipo: z.enum(["cierre_casi_solo", "lead_sin_respuesta", "oportunidad_estancada"]),
  resumen: z.string().describe("Qué dijo o dio el lead, concreto (qué quiere, cantidad, fecha, presupuesto, pago)"),
  porQueEsCierre: z.string().describe("Por qué era una venta casi hecha y qué faltó del lado del negocio"),
  queHacer: z.string().describe("Acción concreta para hoy"),
  mensajeSugerido: z.string().describe("Mensaje listo para mandarle al lead"),
  monto: z.number().nullable().describe("Monto estimado en dólares si se deduce; null si no"),
});
const analisisSchema = z.object({ hallazgos: z.array(hallazgoSchema) });
type HallazgoIa = z.infer<typeof hallazgoSchema>;

/**
 * A veces el modelo devuelve el objeto envuelto ({"input": {...}} o
 * {"text": {...}}) y Output.object lo rechaza. Se intenta desenvolver: si es
 * un objeto de una sola clave cuyo valor es objeto, se valida eso.
 */
function rescatarObjeto(textoCrudo: string | undefined): z.infer<typeof analisisSchema> | null {
  const json = textoCrudo?.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  let valor: unknown;
  try {
    valor = JSON.parse(json);
  } catch {
    return null;
  }
  const directo = analisisSchema.safeParse(valor);
  if (directo.success) return directo.data;
  if (valor && typeof valor === "object" && !Array.isArray(valor)) {
    const claves = Object.keys(valor);
    const interno = claves.length === 1 ? (valor as Record<string, unknown>)[claves[0]!] : null;
    if (interno && typeof interno === "object") {
      const r = analisisSchema.safeParse(interno);
      if (r.success) return r.data;
    }
  }
  return null;
}

const INSTRUCCIONES = `Eres un asesor de ventas de Bakano, una agencia de marketing en Ecuador. Revisas las conversaciones y oportunidades de las últimas 24 horas del CRM de un negocio cliente y encuentras las ventas que se le están escapando.

Tipos de hallazgo:
- cierre_casi_solo: el lead mostró intención clara y dio datos que normalmente cierran la venta (qué quiere, cantidad o presupuesto, fecha, ubicación, forma de pago, pidió precio o la cuenta para pagar) y el negocio NO cerró: no respondió, respondió tarde, respondió frío o incompleto, o no pidió el cierre.
- lead_sin_respuesta: el lead escribió con interés y lleva horas sin respuesta del negocio.
- oportunidad_estancada: oportunidad abierta con monto que no se mueve de etapa hace días.

Reglas:
- Máximo ${MAX_HALLAZGOS} hallazgos, los más valiosos (más cerca de pagar y de mayor monto primero). Si no hay nada que valga la pena, devuelve la lista vacía. No inventes: todo debe salir de los mensajes.
- Ignora spam, proveedores, mensajes automáticos, conversaciones donde la venta ya se cerró o el lead dijo que no.
- ref: usa exactamente la referencia de la lista (C1, O2...).
- resumen: qué pidió o dio el lead, con sus datos concretos. Una o dos frases.
- porQueEsCierre: por qué era casi una venta y qué faltó. Sin culpar ni humillar al negocio.
- queHacer: una acción concreta para hoy.
- mensajeSugerido: el texto que el negocio le puede mandar al lead ahora mismo. Natural, cálido, en español de Ecuador, corto (2 a 4 frases), que retome lo que el lead pidió con sus datos y cierre con una pregunta fácil de contestar o el siguiente paso (confirmar, mandar la cuenta, agendar). Usa el nombre del lead si lo tienes. SIN signos de apertura ¡ ¿ (solo los de cierre). Sin emojis de más.
- monto: estimado en dólares si se deduce de la conversación o de la oportunidad; si no, null.
- Todo en español, sin markdown.`;

function haceHoras(fecha: Date | null): string {
  if (!fecha) return "?";
  const h = Math.max(0, Math.round((Date.now() - fecha.getTime()) / 3_600_000));
  return h < 1 ? "menos de 1 h" : `${h} h`;
}

function haceDias(fecha: Date | null): string {
  if (!fecha) return "?";
  return `${Math.max(0, Math.round((Date.now() - fecha.getTime()) / 86_400_000))} días`;
}

function horaEcuador(fecha: Date | null): string {
  if (!fecha) return "";
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(fecha);
}

type Lead =
  | { ref: string; clase: "conversacion"; conversacion: ConversacionCrm }
  | { ref: string; clase: "oportunidad"; oportunidad: OportunidadCrm };

/** Lo que se le pasa a la IA: compacto y con referencias cortas (no ids reales). */
function armarContexto(entorno: string, leads: Lead[]): string {
  const partes: string[] = [`Negocio: ${entorno}`, `Ahora (Ecuador): ${horaEcuador(new Date())}`, ""];
  let largo = 0;
  for (const l of leads) {
    let bloque: string;
    if (l.clase === "conversacion") {
      const c = l.conversacion;
      const lineas = c.mensajes.map(
        (m) => `  - ${horaEcuador(m.fecha)} ${m.direccion === "inbound" ? "LEAD" : "NEGOCIO"}: ${m.texto.replace(/\s+/g, " ").slice(0, 400)}`
      );
      bloque =
        `[${l.ref}] Conversación · canal ${c.canal} · lead: ${c.nombre || "sin nombre"}` +
        ` · último mensaje hace ${haceHoras(c.ultimaFecha)}${c.ultimaDireccion ? ` (${c.ultimaDireccion === "inbound" ? "del lead" : "del negocio"})` : ""}` +
        `${c.noLeidos ? ` · ${c.noLeidos} sin leer` : ""}\n` +
        (lineas.length ? lineas.join("\n") : "  (sin mensajes legibles)");
    } else {
      const o = l.oportunidad;
      bloque =
        `[${l.ref}] Oportunidad "${o.nombre}" · estado ${o.estado} · monto ${o.monto ?? "sin monto"}` +
        ` · pipeline ${o.pipeline || "?"} / etapa ${o.etapa || "?"} · sin cambiar de etapa hace ${haceDias(o.ultimoCambioEtapa)}` +
        ` · lead: ${o.contacto.nombre || "sin nombre"}`;
    }
    // Tope de contexto: lo mas reciente va primero, lo que no entra se omite.
    if (largo + bloque.length > 40_000) break;
    largo += bloque.length;
    partes.push(bloque, "");
  }
  return partes.join("\n");
}

async function analizarConIa(contexto: string, limiteMs: number): Promise<HallazgoIa[]> {
  const { generateText, Output, NoObjectGeneratedError } = await cargarAi();
  try {
    const r = await generateText({
      model: modelo(),
      system: INSTRUCCIONES,
      prompt: contexto,
      output: Output.object({ schema: analisisSchema }),
      abortSignal: AbortSignal.timeout(limiteMs),
    });
    return r.output.hallazgos;
  } catch (error) {
    if (NoObjectGeneratedError.isInstance(error)) {
      const rescatado = rescatarObjeto(error.text);
      if (rescatado) return rescatado.hallazgos;
    }
    throw error;
  }
}

const PRIORIDAD: Record<TipoHallazgoCrm, number> = { cierre_casi_solo: 0, lead_sin_respuesta: 1, oportunidad_estancada: 2 };
const NOMBRE_CANAL: Record<CanalHallazgoCrm, string> = {
  whatsapp: "WhatsApp",
  sms: "SMS",
  instagram: "Instagram",
  facebook: "Facebook",
  otro: "el CRM",
  oportunidad: "el pipeline",
};

export interface ResultadoCorridaCrm {
  revisados: number;
  hallazgos: number;
  avisados: number;
  errores: string[];
  /** Entornos que quedaron para la siguiente corrida (no alcanzo el tiempo). */
  pendientes: number;
}

class CrmRevisionService {
  /** Corre la revision del dia sobre los entornos pendientes, con tope de tiempo. */
  async correr(): Promise<ResultadoCorridaCrm> {
    const inicio = Date.now();
    const limite = inicio + PRESUPUESTO_MS;
    const dia = diaEcuador(new Date());
    const resultado: ResultadoCorridaCrm = { revisados: 0, hallazgos: 0, avisados: 0, errores: [], pendientes: 0 };

    const cola = await this.pendientesDeHoy(dia);
    while (cola.length && limite - Date.now() > MINIMO_PARA_LOTE_MS) {
      const lote = cola.splice(0, EN_PARALELO);
      const r = await Promise.allSettled(lote.map((i) => this.revisarEntorno(i, dia, limite)));
      r.forEach((x, idx) => {
        if (x.status === "fulfilled") {
          if (!x.value) return;
          resultado.revisados++;
          resultado.hallazgos += x.value.hallazgos;
          resultado.avisados += x.value.avisados;
          if (x.value.error) resultado.errores.push(`${lote[idx]!.workspaceId}: ${x.value.error}`);
        } else {
          resultado.errores.push(`${lote[idx]!.workspaceId}: ${x.reason?.message || x.reason}`);
        }
      });
    }
    resultado.pendientes = cola.length;
    return resultado;
  }

  /**
   * Integraciones conectadas de entornos activos que hoy todavia no tienen
   * revision terminada. Primero las que llevan mas tiempo sin revisarse.
   */
  private async pendientesDeHoy(dia: string) {
    const integraciones = await models.crmIntegrations
      .find({ estado: "conectado" })
      .select("+tokenCifrado workspaceId locationId ultimaRevision")
      .sort({ ultimaRevision: 1 })
      .lean();
    if (!integraciones.length) return [];

    const ids = integraciones.map((i) => i.workspaceId);
    const [activos, revisiones] = await Promise.all([
      models.workspaces.find({ _id: { $in: ids }, isActive: true }).select("_id name").lean(),
      models.crmRevisiones.find({ workspaceId: { $in: ids }, dia }).select("workspaceId estadoRevision iniciadaEn intentos").lean(),
    ]);
    const nombre = new Map(activos.map((w) => [String(w._id), w.name as string]));
    const hecha = new Set(
      revisiones
        .filter(
          (r: any) =>
            r.estadoRevision === "terminada" ||
            (r.estadoRevision === "fallida" && (r.intentos ?? 0) >= MAX_INTENTOS) ||
            (r.estadoRevision === "en_curso" && Date.now() - new Date(r.iniciadaEn).getTime() < EN_CURSO_CADUCA_MS)
        )
        .map((r) => String(r.workspaceId))
    );
    return integraciones
      .filter((i) => nombre.has(String(i.workspaceId)) && !hecha.has(String(i.workspaceId)))
      .map((i) => ({
        _id: i._id as Types.ObjectId,
        workspaceId: i.workspaceId as Types.ObjectId,
        entorno: nombre.get(String(i.workspaceId)) || "Cliente",
        locationId: i.locationId,
        tokenCifrado: (i as any).tokenCifrado as string,
      }));
  }

  /** Toma el candado del dia. null si otra corrida ya lo tiene o ya termino. */
  private async tomarCandado(workspaceId: Types.ObjectId, dia: string) {
    const ahora = new Date();
    try {
      return await models.crmRevisiones.findOneAndUpdate(
        {
          workspaceId,
          dia,
          $or: [
            { estadoRevision: "fallida", intentos: { $lt: MAX_INTENTOS } },
            { estadoRevision: "en_curso", iniciadaEn: { $lt: new Date(ahora.getTime() - EN_CURSO_CADUCA_MS) } },
          ],
        },
        { $set: { estadoRevision: "en_curso", iniciadaEn: ahora, error: null }, $inc: { intentos: 1 } },
        { upsert: true, new: true }
      );
    } catch (error: any) {
      // E11000: ya existe una del dia que no cumple el filtro (terminada o en curso).
      if (error?.code === 11000) return null;
      throw error;
    }
  }

  private async revisarEntorno(
    integracion: { _id: Types.ObjectId; workspaceId: Types.ObjectId; entorno: string; locationId: string; tokenCifrado: string },
    dia: string,
    limite: number
  ): Promise<{ hallazgos: number; avisados: number; error?: string } | null> {
    const { workspaceId } = integracion;
    const revision = await this.tomarCandado(workspaceId, dia);
    if (!revision) return null;

    let conversaciones: ConversacionCrm[] = [];
    let oportunidades = { actualizadas: [] as OportunidadCrm[], estancadas: [] as OportunidadCrm[] };
    let whatsapp: EstadoWhatsappCrm = "desconocido";
    try {
      const cliente = await crmIntegracionService.cliente(integracion);
      try {
        conversaciones = await cliente.conversacionesRecientes(HORAS_VENTANA, MAX_CONVERSACIONES);
      } catch (error) {
        if (error instanceof CrmTokenInvalidoError) {
          // El token dejo de servir: se marca el CRM en error y no se reintenta hoy.
          await Promise.all([
            models.crmIntegrations.updateOne({ _id: integracion._id }, { $set: { estado: "error", ultimoError: error.message } }),
            models.crmRevisiones.updateOne(
              { _id: revision._id },
              { $set: { estadoRevision: "fallida", intentos: MAX_INTENTOS, terminadaEn: new Date(), error: error.message } }
            ),
          ]);
          return { hallazgos: 0, avisados: 0, error: error.message };
        }
        throw error;
      }
      const [opps, wa] = await Promise.all([
        cliente.oportunidades(HORAS_VENTANA).catch((e) => {
          console.error(`[CRM cierres] oportunidades ${workspaceId}:`, e?.message || e);
          return { actualizadas: [], estancadas: [], disponible: false };
        }),
        cliente.detectarWhatsapp(conversaciones).catch(() => "desconocido" as EstadoWhatsappCrm),
      ]);
      oportunidades = opps;
      whatsapp = wa;

      // Leads ya reportados hace poco no se vuelven a mandar a la IA.
      const recientes = await models.crmHallazgos
        .find({ workspaceId, createdAt: { $gte: new Date(Date.now() - DIAS_SIN_REPETIR * 86_400_000) } })
        .select("conversationId opportunityId")
        .lean();
      const yaVistos = new Set(recientes.flatMap((h) => [h.conversationId, h.opportunityId]).filter(Boolean) as string[]);

      const opsUnicas = new Map<string, OportunidadCrm>();
      for (const o of [...oportunidades.actualizadas, ...oportunidades.estancadas]) opsUnicas.set(o.id, o);
      const leads: Lead[] = [
        ...conversaciones
          .filter((c) => !yaVistos.has(c.id) && c.mensajes.some((m) => m.direccion === "inbound"))
          .map((c, i) => ({ ref: `C${i + 1}`, clase: "conversacion" as const, conversacion: c })),
        ...[...opsUnicas.values()]
          .filter((o) => !yaVistos.has(o.id) && o.estado === "open")
          .slice(0, 20)
          .map((o, i) => ({ ref: `O${i + 1}`, clase: "oportunidad" as const, oportunidad: o })),
      ];

      let nuevos: Types.ObjectId[] = [];
      if (leads.length) {
        const tiempo = Math.min(LIMITE_IA_MS, limite - Date.now() - 3_000);
        if (tiempo < 5_000) throw new Error("sin tiempo para el análisis: sigue en la próxima corrida");
        const ia = await analizarConIa(armarContexto(integracion.entorno, leads), tiempo);
        nuevos = await this.guardarHallazgos(workspaceId, dia, leads, ia);
      }

      await Promise.all([
        models.crmIntegrations.updateOne(
          { _id: integracion._id },
          { $set: { ultimaRevision: new Date(), whatsapp, estado: "conectado", ultimoError: null } }
        ),
        models.crmRevisiones.updateOne(
          { _id: revision._id },
          {
            $set: {
              estadoRevision: "terminada",
              terminadaEn: new Date(),
              conversaciones: conversaciones.length,
              oportunidades: opsUnicas.size,
              hallazgos: nuevos.length,
              whatsapp,
              error: null,
            },
          }
        ),
      ]);

      const avisados = nuevos.length ? await this.avisarCliente(workspaceId).catch((e) => {
        console.error(`[CRM cierres] aviso ${workspaceId}:`, e?.message || e);
        return 0;
      }) : 0;
      return { hallazgos: nuevos.length, avisados };
    } catch (error: any) {
      const mensaje = String(error?.message || error).slice(0, 300);
      console.error(`[CRM cierres] ${workspaceId}:`, mensaje);
      await models.crmRevisiones.updateOne(
        { _id: revision._id },
        {
          $set: {
            estadoRevision: "fallida",
            terminadaEn: new Date(),
            conversaciones: conversaciones.length,
            oportunidades: oportunidades.actualizadas.length + oportunidades.estancadas.length,
            whatsapp,
            error: mensaje,
          },
        }
      );
      return { hallazgos: 0, avisados: 0, error: mensaje };
    }
  }

  /** Guarda lo que encontro la IA, sin duplicar. Devuelve los ids nuevos. */
  private async guardarHallazgos(workspaceId: Types.ObjectId, dia: string, leads: Lead[], ia: HallazgoIa[]): Promise<Types.ObjectId[]> {
    const porRef = new Map(leads.map((l) => [l.ref.toUpperCase(), l]));
    const validos = ia
      .map((h) => ({ h, lead: porRef.get(String(h.ref).trim().toUpperCase()) }))
      // La IA no puede inventar un lead: la referencia tiene que existir.
      .filter((x): x is { h: HallazgoIa; lead: Lead } => Boolean(x.lead))
      .sort((a, b) => PRIORIDAD[a.h.tipo] - PRIORIDAD[b.h.tipo] || (b.h.monto ?? 0) - (a.h.monto ?? 0))
      .slice(0, MAX_HALLAZGOS);

    const nuevos: Types.ObjectId[] = [];
    for (const { h, lead } of validos) {
      const esConversacion = lead.clase === "conversacion";
      const tipo: TipoHallazgoCrm = esConversacion && h.tipo === "oportunidad_estancada" ? "cierre_casi_solo" : h.tipo;
      const contacto = esConversacion
        ? { nombre: lead.conversacion.nombre, telefono: lead.conversacion.telefono, email: lead.conversacion.email }
        : lead.oportunidad.contacto;
      const filtro = esConversacion
        ? { workspaceId, conversationId: lead.conversacion.id, tipo }
        : { workspaceId, opportunityId: lead.oportunidad.id, tipo };
      const monto = typeof h.monto === "number" && h.monto > 0 ? h.monto : esConversacion ? null : lead.oportunidad.monto;
      const r = await models.crmHallazgos.updateOne(
        filtro,
        {
          $setOnInsert: {
            dia,
            canal: esConversacion ? lead.conversacion.canal : "oportunidad",
            contacto,
            resumen: sinApertura(h.resumen).slice(0, 600),
            porQueEsCierre: sinApertura(h.porQueEsCierre).slice(0, 600),
            queHacer: sinApertura(h.queHacer).slice(0, 400),
            mensajeSugerido: sinApertura(h.mensajeSugerido).slice(0, 700),
            monto,
            conversationId: esConversacion ? lead.conversacion.id : null,
            opportunityId: esConversacion ? null : lead.oportunidad.id,
            avisadoClienteEn: null,
            leidoPorLucasEn: null,
          },
        },
        { upsert: true }
      );
      if (r.upsertedId) nuevos.push(r.upsertedId as Types.ObjectId);
    }
    return nuevos;
  }

  /**
   * UN mensaje por chat del cliente con los hallazgos sin avisar. Nunca al
   * equipo interno. Tono: animo, no reproche.
   */
  async avisarCliente(workspaceId: Types.ObjectId): Promise<number> {
    // Solo lo fresco: un lead de hace una semana ya no se retoma con "ayer".
    const hallazgos = await models.crmHallazgos
      .find({ workspaceId, avisadoClienteEn: null, createdAt: { $gte: new Date(Date.now() - 48 * 3_600_000) } })
      .lean();
    if (!hallazgos.length) return 0;
    hallazgos.sort((a, b) => PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo] || (b.monto ?? 0) - (a.monto ?? 0));

    const chats = await models.telegramChats.find({ workspaceId, estado: "listo" }).select("chatId userId firstName").lean();
    const internos = new Set(
      (
        await models.users
          .find({ _id: { $in: chats.map((c) => c.userId).filter(Boolean) }, $or: [{ isInternal: true }, { role: "superadmin" }] })
          .select("_id")
          .lean()
      ).map((u) => String(u._id))
    );
    const destinos = chats.filter((c) => !(c.userId && internos.has(String(c.userId))));
    if (!destinos.length) return 0;

    const principal = hallazgos[0]!;
    const otros = hallazgos.slice(1, MAX_HALLAZGOS);
    const quien = (h: (typeof hallazgos)[number]) => escaparHtml(h.contacto?.nombre || "un cliente");
    const hayCierres = hallazgos.some((h) => h.tipo === "cierre_casi_solo");

    const cuerpo =
      (principal.tipo === "cierre_casi_solo"
        ? `Ayer <b>${quien(principal)}</b> te dio casi todo para cerrar por ${NOMBRE_CANAL[principal.canal]}: ${escaparHtml(principal.resumen)}\n\n` +
          `Eso era un cierre casi solo 💪 ${escaparHtml(principal.porQueEsCierre)}`
        : principal.tipo === "lead_sin_respuesta"
          ? `<b>${quien(principal)}</b> te escribió con ganas de comprar por ${NOMBRE_CANAL[principal.canal]} y todavía está esperando respuesta: ${escaparHtml(principal.resumen)}`
          : `La oportunidad de <b>${quien(principal)}</b>${principal.monto ? ` (${`$${principal.monto.toFixed(2)}`})` : ""} lleva días sin moverse: ${escaparHtml(principal.resumen)}`) +
      `\n\n👉 ${escaparHtml(principal.queHacer)}` +
      (principal.mensajeSugerido ? `\n\nTe dejo cómo retomarlo, listo para copiar:\n<i>${escaparHtml(principal.mensajeSugerido)}</i>` : "") +
      (otros.length
        ? `\n\nTambién vale la pena retomar hoy:\n${otros
            .map((h) => `· <b>${quien(h)}</b>: ${escaparHtml(h.resumen.slice(0, 160))}`)
            .join("\n")}`
        : "") +
      (hayCierres ? "\n\nSi quieres cerrar más de estas, en Bakanology tienes el curso de ventas 👇" : "");

    const botones: InlineButton[][] = [
      ...(hayCierres ? [[{ text: "🎓 Curso de ventas en Bakanology", url: bakanologyUrl() }]] : []),
      [{ text: "🔌 Ver mi CRM en Metrics", url: linkIntegraciones(workspaceId) }],
      [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
    ];

    let enviados = 0;
    for (const chat of destinos) {
      const saludo = chat.firstName ? `Buenos días, ${escaparHtml(chat.firstName)} ☀️` : "Buenos días ☀️";
      const texto = `${saludo} Revisé tu CRM de ayer y encontré ${
        hallazgos.length === 1 ? "una venta" : `${Math.min(hallazgos.length, MAX_HALLAZGOS)} ventas`
      } que todavía puedes cerrar.\n\n${cuerpo}`;
      try {
        await telegramService.sendMessage(chat.chatId, texto.slice(0, 4000), botones);
        enviados++;
      } catch (error: any) {
        console.error(`[CRM cierres] Telegram ${chat.chatId}:`, error?.response?.data?.description || error?.message);
      }
    }
    if (enviados) {
      await models.crmHallazgos.updateMany(
        { _id: { $in: hallazgos.map((h) => h._id) } },
        { $set: { avisadoClienteEn: new Date() } }
      );
    }
    return enviados;
  }

  /** Para el bot: los ultimos hallazgos del entorno, en corto. */
  async recientes(workspaceId: string | Types.ObjectId, dias = 7) {
    const lista = await models.crmHallazgos
      .find({ workspaceId, createdAt: { $gte: new Date(Date.now() - dias * 86_400_000) } })
      .sort({ createdAt: -1 })
      .limit(MAX_HALLAZGOS)
      .lean();
    return lista.map((h) => ({
      dia: h.dia,
      tipo: h.tipo,
      canal: h.canal,
      lead: h.contacto?.nombre || null,
      resumen: h.resumen,
      queHacer: h.queHacer,
      mensajeSugerido: h.mensajeSugerido,
      monto: h.monto,
    }));
  }
}

export const crmRevisionService = new CrmRevisionService();
