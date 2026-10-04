import { Types } from "mongoose";
import models from "../models";
import { CustomError } from "../errors/customError.error";
import type { CanalHallazgoCrm } from "../models/crmHallazgo.model";
import type { AsesorMetricaCrm, ICrmMetricaDiaria } from "../models/crmMetricaDiaria.model";
import type { ModoCrm } from "../models/crmIntegration.model";
import { diaEcuador } from "./atencionCliente.service";
import { canalDeTipo, CrmCliente, CrmTokenInvalidoError, esMensajeDeConversacion, type MensajeCrm } from "./crmCliente.service";
import { crmIntegracionService, vistaCrm } from "./crmIntegracion.service";

/**
 * Metricas diarias del CRM de cada cliente: conversaciones por dia y canal,
 * contactos que escribieron y como respondio cada asesor (tiempo de primera
 * respuesta, conversaciones que quedaron esperando).
 *
 * A diferencia de la revision diaria (una muestra de 30-60 conversaciones
 * para la IA), aqui se leen TODAS las conversaciones con actividad desde el
 * inicio del dia, con un tope de seguridad alto. Se busca desde ahora hacia
 * atras: GHL ordena por ultimo mensaje y una conversacion que siguio despues
 * del dia tiene su ultimo mensaje despues.
 *
 * Reglas del calculo (todo en hora de Ecuador):
 * - Cuenta solo mensajes de conversacion (WhatsApp, IG, FB, SMS, correo,
 *   llamadas...), no actividad del sistema.
 * - Saliente humano = trae userId y no viene de un flujo, campaña o accion
 *   masiva. Lo demas es automatico y no cuenta como respuesta.
 * - Turno: el primer mensaje del cliente despues de la ultima respuesta
 *   humana. La respuesta se cuenta el dia en que se envia (asi entra la de
 *   la mañana a un mensaje de la noche anterior) y se le atribuye a quien la
 *   escribio.
 * - Sin respuesta: el cliente escribio ese dia y al cierre del dia seguia
 *   esperando. Se le atribuye al asesor asignado a la conversacion.
 */

/** Tope de conversaciones por dia y entorno (cada una es una o mas llamadas de mensajes). */
const MAX_CONVERSACIONES_DIA = 1_500;
/** GHL limita ~100 llamadas cada 10 s por location. */
const CONCURRENCIA = 4;
const PRESUPUESTO_MS = 50_000;
/** Tiempo minimo para empezar un dia mas en la misma corrida. */
const MINIMO_PARA_DIA_MS = 15_000;
const EN_CURSO_CADUCA_MS = 3 * 60_000;
const MAX_INTENTOS = 3;
/** Dias hacia atras que el cron todavia intenta completar. */
const DIAS_ATRAS_MAX = 31;
/** Al conectar un CRM se calculan los ultimos dias para que el dashboard no arranque vacio. */
const DIAS_INICIALES = 7;
const MAX_TIEMPOS_POR_ASESOR = 300;
export const MAX_DIAS_RANGO = 31;
/** Fuentes de salientes que no escribio una persona. */
const FUENTES_AUTOMATICAS = /^(workflow|bulk_actions|campaign|automation|bot|ai)/i;

const DIA_MS = 86_400_000;
const RE_DIA = /^\d{4}-\d{2}-\d{2}$/;

function inicioDia(dia: string): Date {
  return new Date(`${dia}T00:00:00-05:00`);
}

function sumarDias(dia: string, n: number): string {
  return diaEcuador(new Date(inicioDia(dia).getTime() + n * DIA_MS + 12 * 3_600_000));
}

function ayer(): string {
  return sumarDias(diaEcuador(new Date()), -1);
}

function fecha(valor: unknown): Date | null {
  if (valor === null || valor === undefined || valor === "") return null;
  const d = typeof valor === "number" ? new Date(valor) : new Date(String(valor));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mediana(valores: number[]): number | null {
  if (!valores.length) return null;
  const o = [...valores].sort((a, b) => a - b);
  const m = Math.floor(o.length / 2);
  return Math.round(o.length % 2 ? o[m]! : (o[m - 1]! + o[m]!) / 2);
}

function promedio(valores: number[]): number | null {
  return valores.length ? Math.round(valores.reduce((a, b) => a + b, 0) / valores.length) : null;
}

function esHumano(m: MensajeCrm): boolean {
  return m.direccion === "outbound" && Boolean(m.userId) && !FUENTES_AUTOMATICAS.test(String(m.fuente || ""));
}

type Calculo = Pick<
  ICrmMetricaDiaria,
  | "conversaciones"
  | "nuevas"
  | "porCanal"
  | "mensajesEntrantes"
  | "mensajesSalientes"
  | "mensajesAutomaticos"
  | "contactosQueEscribieron"
  | "sinRespuesta"
  | "medianaRespuestaSeg"
  | "asesores"
  | "truncado"
>;

type IntegracionMetricas = {
  workspaceId: Types.ObjectId;
  locationId: string;
  tokenCifrado?: string | null;
  modo?: ModoCrm | null;
};

/**
 * Calcula un dia con los mensajes ya leidos. Separado de la lectura para
 * poder probarlo sin GHL.
 */
export function calcularDia(
  dia: string,
  conversaciones: { id: string; contactId: string | null; asignadoA: string | null; creada: Date | null; mensajes: MensajeCrm[]; completo: boolean }[],
  nombres: Map<string, string>
): Omit<Calculo, "truncado"> {
  const inicio = inicioDia(dia).getTime();
  const fin = inicio + DIA_MS - 1;
  const porCanal = { whatsapp: 0, instagram: 0, facebook: 0, sms: 0, otro: 0 };
  const contactos = new Set<string>();
  const asesores = new Map<string, AsesorMetricaCrm & { convs: Set<string> }>();
  const asesor = (userId: string) => {
    let a = asesores.get(userId);
    if (!a) {
      a = { userId, nombre: nombres.get(userId) || "", mensajes: 0, conversaciones: 0, respuestas: 0, tiemposSeg: [], sinRespuesta: 0, convs: new Set() };
      asesores.set(userId, a);
    }
    return a;
  };
  const tiempos: number[] = [];
  let total = 0;
  let nuevas = 0;
  let entrantes = 0;
  let salientes = 0;
  let automaticos = 0;
  let sinRespuesta = 0;

  for (const c of conversaciones) {
    const mensajes = c.mensajes.filter((m) => m.fecha && esMensajeDeConversacion(m.tipo) && m.fecha.getTime() <= fin);
    const delDia = mensajes.filter((m) => m.fecha!.getTime() >= inicio);
    if (!delDia.length) continue;
    total++;

    // Nueva: GHL la creo ese dia; si no trae fecha, su primer mensaje leido es de ese dia.
    const creada = c.creada?.getTime() ?? (c.completo && mensajes[0] ? mensajes[0].fecha!.getTime() : null);
    if (creada !== null && creada >= inicio && creada <= fin) nuevas++;

    const cuenta = new Map<CanalHallazgoCrm, number>();
    for (const m of delDia) cuenta.set(canalDeTipo(m.tipo), (cuenta.get(canalDeTipo(m.tipo)) ?? 0) + 1);
    const canal = [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    porCanal[canal in porCanal ? (canal as keyof typeof porCanal) : "otro"]++;

    let esperandoDesde: number | null = null;
    for (const m of mensajes) {
      const t = m.fecha!.getTime();
      const enElDia = t >= inicio;
      if (m.direccion === "inbound") {
        if (enElDia) {
          entrantes++;
          if (c.contactId) contactos.add(c.contactId);
        }
        if (esperandoDesde === null) esperandoDesde = t;
      } else if (m.direccion === "outbound") {
        if (!esHumano(m)) {
          if (enElDia) automaticos++;
          continue;
        }
        if (enElDia) {
          salientes++;
          const a = asesor(m.userId!);
          a.mensajes++;
          a.convs.add(c.id);
          if (esperandoDesde !== null) {
            const seg = Math.max(0, Math.round((t - esperandoDesde) / 1000));
            a.respuestas++;
            if (a.tiemposSeg.length < MAX_TIEMPOS_POR_ASESOR) a.tiemposSeg.push(seg);
            tiempos.push(seg);
          }
        }
        esperandoDesde = null;
      }
    }
    if (esperandoDesde !== null && esperandoDesde >= inicio) {
      sinRespuesta++;
      if (c.asignadoA) asesor(c.asignadoA).sinRespuesta++;
    }
  }

  return {
    conversaciones: total,
    nuevas,
    porCanal,
    mensajesEntrantes: entrantes,
    mensajesSalientes: salientes,
    mensajesAutomaticos: automaticos,
    contactosQueEscribieron: contactos.size,
    sinRespuesta,
    medianaRespuestaSeg: mediana(tiempos),
    asesores: [...asesores.values()]
      .map(({ convs, ...a }) => ({ ...a, conversaciones: convs.size }))
      .sort((a, b) => b.mensajes - a.mensajes),
  };
}

export interface ResultadoCorridaMetricas {
  calculados: number;
  errores: string[];
  pendientes: number;
}

export interface DiaMetricasVista {
  dia: string;
  /** null: todavia no se calculo ese dia. */
  estado: ICrmMetricaDiaria["estado"] | null;
  conversaciones: number;
  nuevas: number;
  contactosQueEscribieron: number;
  mensajesEntrantes: number;
  mensajesSalientes: number;
  mensajesAutomaticos: number;
  sinRespuesta: number;
  medianaRespuestaSeg: number | null;
  asesoresActivos: number;
}

export interface AsesorMetricasVista {
  userId: string;
  nombre: string;
  mensajes: number;
  conversaciones: number;
  respuestas: number;
  medianaRespuestaSeg: number | null;
  promedioRespuestaSeg: number | null;
  sinRespuesta: number;
  diasActivo: number;
}

export interface MetricasCrmVista {
  conectado: boolean;
  estadoCrm: "conectado" | "error" | null;
  problema: string | null;
  advertencias: string[];
  desde: string;
  hasta: string;
  dias: DiaMetricasVista[];
  totales: {
    /** Suma por dia: una conversacion activa dos dias cuenta dos veces. */
    conversaciones: number;
    nuevas: number;
    /** Suma por dia de contactos distintos. */
    contactosQueEscribieron: number;
    mensajesEntrantes: number;
    mensajesSalientes: number;
    mensajesAutomaticos: number;
    sinRespuesta: number;
    /** Asesores que escribieron al menos un mensaje en el rango. */
    asesoresActivos: number;
    medianaRespuestaSeg: number | null;
    promedioRespuestaSeg: number | null;
  };
  porCanal: { whatsapp: number; instagram: number; facebook: number; sms: number; otro: number };
  asesores: AsesorMetricasVista[];
  /** Dias del rango que faltan calcular (el cron los va completando). */
  pendientes: number;
  /** Algun dia quedo con algo sin leer (tope de conversaciones o de tiempo). */
  truncado: boolean;
}

class CrmMetricasService {
  /** Lee el CRM y calcula un dia. Lanza CrmTokenInvalidoError si el token no sirve. */
  private async leerYCalcular(cliente: CrmCliente, dia: string, limiteMs: number): Promise<Calculo> {
    const inicio = inicioDia(dia);
    const [{ crudas, truncado: listaTruncada }, usuarios] = await Promise.all([
      cliente.conversacionesActivasDesde(inicio, { max: MAX_CONVERSACIONES_DIA, limiteMs }),
      cliente.usuarios(),
    ]);
    const nombres = new Map(usuarios.map((u) => [u.id, u.nombre]));

    let truncado = listaTruncada;
    const leidas: Parameters<typeof calcularDia>[1] = [];
    for (let i = 0; i < crudas.length; i += CONCURRENCIA) {
      if (Date.now() > limiteMs) {
        truncado = true;
        break;
      }
      const lote = await Promise.all(
        crudas.slice(i, i + CONCURRENCIA).map(async (c) => {
          const r = await cliente.mensajesDesde(String(c.id), inicio);
          if (!r.ok) {
            if (r.tipo === "no_autorizado") throw new CrmTokenInvalidoError();
            return null;
          }
          return {
            id: String(c.id),
            contactId: typeof c?.contactId === "string" ? c.contactId : null,
            asignadoA: typeof c?.assignedTo === "string" && c.assignedTo ? c.assignedTo : null,
            creada: fecha(c?.dateAdded),
            mensajes: r.data.mensajes,
            completo: r.data.completo,
          };
        })
      );
      for (const x of lote) {
        if (!x) truncado = true;
        else {
          if (!x.completo) truncado = true;
          leidas.push(x);
        }
      }
    }
    return { ...calcularDia(dia, leidas, nombres), truncado };
  }

  /** Toma el candado de un dia. null si otra corrida lo tiene o ya termino. */
  private async tomar(workspaceId: Types.ObjectId, dia: string) {
    return models.crmMetricasDiarias.findOneAndUpdate(
      {
        workspaceId,
        dia,
        $or: [
          { estado: "pendiente" },
          { estado: "fallida", intentos: { $lt: MAX_INTENTOS } },
          { estado: "en_curso", iniciadaEn: { $lt: new Date(Date.now() - EN_CURSO_CADUCA_MS) } },
        ],
      },
      { $set: { estado: "en_curso", iniciadaEn: new Date(), error: null }, $inc: { intentos: 1 } },
      { new: true }
    );
  }

  /** Calcula un dia ya marcado como pendiente. true si quedo terminado. */
  private async procesarDia(integracion: IntegracionMetricas, dia: string, limiteMs: number): Promise<boolean> {
    const candado = await this.tomar(integracion.workspaceId, dia);
    if (!candado) return false;
    try {
      const cliente = await crmIntegracionService.cliente(integracion);
      const calculo = await this.leerYCalcular(cliente, dia, limiteMs);
      // Se acabo el tiempo de esta corrida: se reintenta entero con otra (hasta
      // MAX_INTENTOS); al ultimo intento se guarda lo que alcanzo, marcado truncado.
      if (calculo.truncado && Date.now() > limiteMs && candado.intentos < MAX_INTENTOS) {
        await models.crmMetricasDiarias.updateOne({ _id: candado._id }, { $set: { estado: "fallida", error: "Sin tiempo: se reintenta en la siguiente corrida." } });
        return false;
      }
      await models.crmMetricasDiarias.updateOne(
        { _id: candado._id },
        { $set: { ...calculo, estado: "terminada", terminadaEn: new Date(), error: null } }
      );
      return true;
    } catch (error: any) {
      const mensaje = String(error?.message || error).slice(0, 300);
      await models.crmMetricasDiarias.updateOne(
        { _id: candado._id },
        // Token invalido: no tiene sentido reintentar hasta que lo reconecten.
        { $set: { estado: "fallida", error: mensaje, ...(error instanceof CrmTokenInvalidoError ? { intentos: MAX_INTENTOS } : {}) } }
      );
      throw error;
    }
  }

  /** Deja pendientes los dias que faltan (sin pisar los que ya existen). */
  private async marcarPendientes(workspaceId: Types.ObjectId, dias: string[]): Promise<void> {
    if (!dias.length) return;
    await models.crmMetricasDiarias.bulkWrite(
      dias.map((dia) => ({
        updateOne: { filter: { workspaceId, dia }, update: { $setOnInsert: { workspaceId, dia, estado: "pendiente" } }, upsert: true },
      })),
      { ordered: false }
    );
  }

  /** Integraciones conectadas de entornos activos. */
  private async conectadas(): Promise<IntegracionMetricas[]> {
    const integraciones = await models.crmIntegrations
      .find({ estado: "conectado" })
      .select("+tokenCifrado workspaceId locationId modo")
      .lean();
    if (!integraciones.length) return [];
    const activos = await models.workspaces
      .find({ _id: { $in: integraciones.map((i) => i.workspaceId) }, isActive: true })
      .select("_id")
      .lean();
    const ids = new Set(activos.map((w) => String(w._id)));
    return integraciones
      .filter((i) => ids.has(String(i.workspaceId)))
      .map((i) => ({
        workspaceId: i.workspaceId as Types.ObjectId,
        locationId: i.locationId,
        tokenCifrado: (i as any).tokenCifrado ?? null,
        modo: (i as any).modo ?? null,
      }));
  }

  /**
   * Cron: deja pendiente ayer para cada CRM conectado (y los ultimos 7 dias
   * si es la primera vez) y calcula lo pendiente, ayer primero, hasta que se
   * acabe el tiempo. La siguiente corrida sigue donde quedo.
   */
  async correr(): Promise<ResultadoCorridaMetricas> {
    const limite = Date.now() + PRESUPUESTO_MS;
    const resultado: ResultadoCorridaMetricas = { calculados: 0, errores: [], pendientes: 0 };
    const integraciones = await this.conectadas();
    if (!integraciones.length) return resultado;

    const diaAyer = ayer();
    const conHistorial = new Set(
      (await models.crmMetricasDiarias.distinct("workspaceId", { workspaceId: { $in: integraciones.map((i) => i.workspaceId) } })).map(String)
    );
    for (const i of integraciones) {
      const dias = conHistorial.has(String(i.workspaceId))
        ? [diaAyer]
        : Array.from({ length: DIAS_INICIALES }, (_, n) => sumarDias(diaAyer, -n));
      await this.marcarPendientes(i.workspaceId, dias);
    }

    const porWs = new Map(integraciones.map((i) => [String(i.workspaceId), i]));
    const cola = await models.crmMetricasDiarias
      .find({
        workspaceId: { $in: integraciones.map((i) => i.workspaceId) },
        dia: { $gte: sumarDias(diaAyer, -DIAS_ATRAS_MAX) },
        $or: [
          { estado: "pendiente" },
          { estado: "fallida", intentos: { $lt: MAX_INTENTOS } },
          { estado: "en_curso", iniciadaEn: { $lt: new Date(Date.now() - EN_CURSO_CADUCA_MS) } },
        ],
      })
      .select("workspaceId dia")
      .sort({ dia: -1 })
      .lean();

    // Un token que fallo no se vuelve a intentar en la misma corrida.
    const caidos = new Set<string>();
    let i = 0;
    for (; i < cola.length && limite - Date.now() > MINIMO_PARA_DIA_MS; i++) {
      const pendiente = cola[i]!;
      const ws = String(pendiente.workspaceId);
      const integracion = porWs.get(ws);
      if (!integracion || caidos.has(ws)) continue;
      try {
        if (await this.procesarDia(integracion, pendiente.dia, limite)) resultado.calculados++;
      } catch (error: any) {
        if (error instanceof CrmTokenInvalidoError) caidos.add(ws);
        resultado.errores.push(`${ws} ${pendiente.dia}: ${error?.message || error}`);
      }
    }
    resultado.pendientes = cola.length - i;
    return resultado;
  }

  /**
   * Solo equipo: vuelve a calcular un rango (maximo 31 dias, hasta ayer).
   * Calcula lo que alcance en esta llamada; el cron sigue con el resto.
   */
  async recalcular(workspaceId: string, desdeCrudo: unknown, hastaCrudo: unknown): Promise<{ dias: number; calculados: number; pendientes: number; errores: string[] }> {
    const desde = String(desdeCrudo || "");
    const hasta = String(hastaCrudo || "");
    if (!RE_DIA.test(desde) || !RE_DIA.test(hasta)) throw new CustomError("Fechas inválidas: usa YYYY-MM-DD en «desde» y «hasta».", 400);
    if (desde > hasta) throw new CustomError("«desde» no puede ser después de «hasta».", 400);
    if (hasta > ayer()) throw new CustomError("Solo se pueden calcular días ya cerrados (hasta ayer).", 400);
    const dias: string[] = [];
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
      dias.push(d);
      if (dias.length > MAX_DIAS_RANGO) throw new CustomError(`Como mucho ${MAX_DIAS_RANGO} días por vez.`, 400);
    }

    const doc = await models.crmIntegrations.findOne({ workspaceId }).select("+tokenCifrado workspaceId locationId modo estado").lean();
    if (!doc) throw new CustomError("Este entorno todavía no tiene un CRM conectado.", 404);
    const integracion: IntegracionMetricas = {
      workspaceId: doc.workspaceId as Types.ObjectId,
      locationId: doc.locationId,
      tokenCifrado: (doc as any).tokenCifrado ?? null,
      modo: (doc as any).modo ?? null,
    };

    // Se reabren los dias (menos los que esta calculando otra corrida ahora).
    await models.crmMetricasDiarias.bulkWrite(
      dias.map((dia) => ({
        updateOne: {
          filter: {
            workspaceId: integracion.workspaceId,
            dia,
            $nor: [{ estado: "en_curso", iniciadaEn: { $gte: new Date(Date.now() - EN_CURSO_CADUCA_MS) } }],
          },
          update: { $set: { estado: "pendiente", intentos: 0, error: null }, $setOnInsert: { workspaceId: integracion.workspaceId, dia } },
          upsert: true,
        },
      })),
      { ordered: false }
    ).catch((error: any) => {
      // E11000: el dia existe y esta en curso; se deja como esta.
      if (error?.code !== 11000 && !String(error?.message).includes("E11000")) throw error;
    });

    const limite = Date.now() + PRESUPUESTO_MS - 5_000;
    let calculados = 0;
    const errores: string[] = [];
    for (const dia of [...dias].reverse()) {
      if (limite - Date.now() < MINIMO_PARA_DIA_MS) break;
      try {
        if (await this.procesarDia(integracion, dia, limite)) calculados++;
      } catch (error: any) {
        errores.push(`${dia}: ${error?.message || error}`);
        if (error instanceof CrmTokenInvalidoError) break;
      }
    }
    const pendientes = await models.crmMetricasDiarias.countDocuments({
      workspaceId: integracion.workspaceId,
      dia: { $gte: desde, $lte: hasta },
      estado: { $ne: "terminada" },
    });
    return { dias: dias.length, calculados, pendientes, errores };
  }

  /** Los ultimos `diasCrudo` dias cerrados (hasta ayer) para el dashboard y el bot. */
  async rango(workspaceId: string, diasCrudo: unknown = 7): Promise<MetricasCrmVista> {
    const n = Math.min(MAX_DIAS_RANGO, Math.max(1, Math.round(Number(diasCrudo) || 7)));
    const hasta = ayer();
    const desde = sumarDias(hasta, -(n - 1));
    const [crm, docs] = await Promise.all([
      models.crmIntegrations.findOne({ workspaceId }).lean(),
      models.crmMetricasDiarias.find({ workspaceId, dia: { $gte: desde, $lte: hasta } }).lean(),
    ]);
    const vista = vistaCrm(crm as any);
    const porDia = new Map(docs.map((d) => [d.dia, d]));

    const dias: DiaMetricasVista[] = [];
    const porCanal = { whatsapp: 0, instagram: 0, facebook: 0, sms: 0, otro: 0 };
    const asesores = new Map<string, AsesorMetricasVista & { tiempos: number[] }>();
    const tiempos: number[] = [];
    let pendientes = 0;
    let truncado = false;
    for (let d = desde; d <= hasta; d = sumarDias(d, 1)) {
      const doc = porDia.get(d);
      const listo = doc?.estado === "terminada";
      if (!listo) pendientes++;
      if (listo && doc.truncado) truncado = true;
      const activos = listo ? doc.asesores.filter((a) => a.mensajes > 0).length : 0;
      dias.push({
        dia: d,
        estado: doc?.estado ?? null,
        conversaciones: listo ? doc.conversaciones : 0,
        nuevas: listo ? doc.nuevas : 0,
        contactosQueEscribieron: listo ? doc.contactosQueEscribieron : 0,
        mensajesEntrantes: listo ? doc.mensajesEntrantes : 0,
        mensajesSalientes: listo ? doc.mensajesSalientes : 0,
        mensajesAutomaticos: listo ? doc.mensajesAutomaticos : 0,
        sinRespuesta: listo ? doc.sinRespuesta : 0,
        medianaRespuestaSeg: listo ? doc.medianaRespuestaSeg : null,
        asesoresActivos: activos,
      });
      if (!listo) continue;
      for (const canal of Object.keys(porCanal) as (keyof typeof porCanal)[]) porCanal[canal] += doc.porCanal?.[canal] ?? 0;
      for (const a of doc.asesores) {
        let acc = asesores.get(a.userId);
        if (!acc) {
          acc = {
            userId: a.userId,
            nombre: a.nombre,
            mensajes: 0,
            conversaciones: 0,
            respuestas: 0,
            medianaRespuestaSeg: null,
            promedioRespuestaSeg: null,
            sinRespuesta: 0,
            diasActivo: 0,
            tiempos: [],
          };
          asesores.set(a.userId, acc);
        }
        if (a.nombre) acc.nombre = a.nombre;
        acc.mensajes += a.mensajes;
        acc.conversaciones += a.conversaciones;
        acc.respuestas += a.respuestas;
        acc.sinRespuesta += a.sinRespuesta;
        if (a.mensajes > 0) acc.diasActivo++;
        acc.tiempos.push(...a.tiemposSeg);
        tiempos.push(...a.tiemposSeg);
      }
    }

    const suma = (campo: keyof DiaMetricasVista) => dias.reduce((t, d) => t + (Number(d[campo]) || 0), 0);
    const listaAsesores = [...asesores.values()]
      .map(({ tiempos: t, ...a }) => ({
        ...a,
        nombre: a.nombre || `Asesor ${a.userId.slice(-4)}`,
        medianaRespuestaSeg: mediana(t),
        promedioRespuestaSeg: promedio(t),
      }))
      .sort((a, b) => b.respuestas - a.respuestas || b.mensajes - a.mensajes);

    // CRM conectado y sin nada calculado todavia: se piden los dias para que el cron los llene.
    if (vista?.estado === "conectado" && !docs.length && crm) {
      await this.marcarPendientes(crm.workspaceId as Types.ObjectId, dias.slice(-DIAS_INICIALES).map((d) => d.dia)).catch(() => undefined);
    }

    return {
      conectado: vista?.estado === "conectado",
      estadoCrm: vista?.estado ?? null,
      problema: vista?.ultimoError ?? null,
      advertencias: vista?.advertencias ?? [],
      desde,
      hasta,
      dias,
      totales: {
        conversaciones: suma("conversaciones"),
        nuevas: suma("nuevas"),
        contactosQueEscribieron: suma("contactosQueEscribieron"),
        mensajesEntrantes: suma("mensajesEntrantes"),
        mensajesSalientes: suma("mensajesSalientes"),
        mensajesAutomaticos: suma("mensajesAutomaticos"),
        sinRespuesta: suma("sinRespuesta"),
        asesoresActivos: listaAsesores.filter((a) => a.mensajes > 0).length,
        medianaRespuestaSeg: mediana(tiempos),
        promedioRespuestaSeg: promedio(tiempos),
      },
      porCanal,
      asesores: listaAsesores,
      pendientes,
      truncado,
    };
  }
}

/** "3 min", "1 h 20 min", "2 d 4 h": para el bot y los correos. */
export function duracionLegible(seg: number | null): string | null {
  if (seg === null) return null;
  if (seg < 60) return `${seg} s`;
  const min = Math.round(seg / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export const crmMetricasService = new CrmMetricasService();
