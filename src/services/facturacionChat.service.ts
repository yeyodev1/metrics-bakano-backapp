import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { billingService } from "./billing.service";
import { recordatorioFacturacionService } from "./recordatorioFacturacion.service";

/**
 * Registrar la facturacion del dia DESDE EL CHAT.
 *
 * El cliente ya esta en Telegram cuando le llega el recordatorio: mandarlo a
 * la web para escribir un numero es perderlo. Aqui escribe el monto y queda
 * en Metrics igual que si lo hubiera cargado en la plataforma (misma foto
 * del gasto de Meta, mismo ROAS, mismos avisos), sin ruta paralela.
 */

const MS_DIA = 86_400_000;
/** Lo que pide el bot caduca: un "1250" de mañana no es la respuesta de hoy. */
export const ESPERA_MONTO_MS = 60 * 60_000;
const MONTO_MAXIMO = 10_000_000;

/** Medianoche de Ecuador, que es como se guardan las fechas de facturacion. */
export function diaEcuador(fecha: Date): Date {
  return billingService.normalizeDateToEcuador(fecha);
}

export function claveDia(fecha: Date): string {
  return diaEcuador(fecha).toISOString().slice(0, 10);
}

/** Dinero como lo escribe una persona: $1.250,50. */
export function comoPlata(monto: number): string {
  return `$${monto.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function nombreDia(fecha: Date): string {
  const dia = diaEcuador(fecha);
  const hoy = diaEcuador(new Date());
  const diff = Math.round((hoy.getTime() - dia.getTime()) / MS_DIA);
  const texto = dia.toLocaleDateString("es-EC", {
    weekday: "long",
    day: "numeric",
    month: "long",
    timeZone: "America/Guayaquil",
  });
  if (diff === 0) return `hoy (${texto})`;
  if (diff === 1) return `ayer (${texto})`;
  return texto;
}

/**
 * "1.250,50", "1,250.50", "$1250", "vendí 300 dolares" → 1250.5 / 300.
 * Devuelve null si el texto no trae un monto claro: es preferible preguntar
 * antes que registrar un numero que el cliente no quiso decir.
 */
export function parsearMonto(texto: string): number | null {
  const limpio = String(texto || "")
    .toLowerCase()
    .replace(/[$€]/g, " ")
    .replace(/\b(usd|dolares|dólares|dolar|dólar|pesos)\b/g, " ");
  // Un número con separadores opcionales; se rechaza si hay varios distintos.
  const encontrados = limpio.match(/\d[\d.,]*/g);
  if (!encontrados || encontrados.length !== 1) return null;

  let n = encontrados[0]!;
  const coma = n.lastIndexOf(",");
  const punto = n.lastIndexOf(".");
  if (coma > -1 && punto > -1) {
    // El último separador manda: "1.250,50" (es) o "1,250.50" (en).
    n = coma > punto ? n.replace(/\./g, "").replace(",", ".") : n.replace(/,/g, "");
  } else if (coma > -1) {
    // "1,250" son mil doscientos cincuenta; "1,5" es un decimal.
    n = n.length - coma === 4 ? n.replace(/,/g, "") : n.replace(",", ".");
  } else if (punto > -1) {
    n = n.length - punto === 4 ? n.replace(/\./g, "") : n;
  }

  const valor = Number(n);
  if (!Number.isFinite(valor) || valor < 0 || valor > MONTO_MAXIMO) return null;
  return Math.round(valor * 100) / 100;
}

/** Con qué comparar el día para poder decir algo útil, sin inventar. */
export interface ContextoDelDia {
  totalDia: number;
  gastoMeta: number;
  roasDia: number | null;
  /** Promedio diario del mes, sin contar el día que se acaba de registrar. */
  promedioMes: number | null;
  diasRegistradosMes: number;
  totalMes: number;
  diaAnterior: number | null;
  mismoDiaSemanaPasada: number | null;
  mejorDiaMes: number | null;
}

export type ResultadoFacturacion =
  | {
      ok: true;
      accion: "creada" | "actualizada";
      monto: number;
      dia: Date;
      diaTexto: string;
      totalDia: number;
      gastoMeta: number;
      roas: number | null;
      contexto: ContextoDelDia;
    }
  | { ok: false; motivo: "sin_entorno" | "sin_usuario" | "monto_invalido" | "dia_invalido" | "sin_permiso" | "error" };

/**
 * El contexto con los montos ya escritos como plata ($1.028,57). Si se le
 * pasan numeros crudos, la IA los copia tal cual y el cliente lee "$1028.57".
 */
export function contextoParaLaIa(c: ContextoDelDia): Record<string, unknown> {
  const plata = (n: number | null) => (n === null || n === undefined ? null : comoPlata(n));
  return {
    totalDelDia: plata(c.totalDia),
    gastoEnMeta: c.gastoMeta > 0 ? comoPlata(c.gastoMeta) : null,
    roasDelDia: c.roasDia,
    promedioDiarioDelMes: plata(c.promedioMes),
    diasRegistradosEsteMes: c.diasRegistradosMes,
    totalDelMes: plata(c.totalMes),
    diaAnterior: plata(c.diaAnterior),
    mismoDiaSemanaPasada: plata(c.mismoDiaSemanaPasada),
    mejorDiaDelMes: plata(c.mejorDiaMes),
  };
}

class FacturacionChatService {
  /** Días que le faltan por registrar, del más viejo al más nuevo, más hoy. */
  async diasPendientes(chat: ITelegramChat): Promise<{ fecha: Date; texto: string; registrado: boolean }[]> {
    if (!chat.workspaceId) return [];
    const workspace = await models.workspaces.findById(chat.workspaceId).select("createdAt").lean();
    const faltantes = await recordatorioFacturacionService.rachaSinFacturar(chat.workspaceId, workspace?.createdAt);
    const hoy = diaEcuador(new Date());
    const dias = [...faltantes].reverse();
    if (!dias.some((d) => d.getTime() === hoy.getTime())) dias.push(hoy);

    const registradas = new Set(
      (
        await models.dailyBilling
          .find({ workspaceId: chat.workspaceId, userId: chat.userId, date: { $in: dias } })
          .select("date")
          .lean()
      ).map((e: any) => claveDia(e.date))
    );
    return dias.map((fecha) => ({ fecha, texto: nombreDia(fecha), registrado: registradas.has(claveDia(fecha)) }));
  }

  /**
   * Con qué se compara ese día: promedio del mes, el día anterior y el mismo
   * día de la semana pasada. Sin esto, "registré $1.250" no dice nada; con
   * esto la IA puede cerrar con una lectura real.
   */
  async contextoDelDia(workspaceId: Types.ObjectId, dia: Date): Promise<ContextoDelDia> {
    const fecha = diaEcuador(dia);
    const ec = new Date(fecha.getTime() - 5 * 3_600_000);
    const inicioMes = new Date(Date.UTC(ec.getUTCFullYear(), ec.getUTCMonth(), 1, 5, 0, 0));

    const registros = await models.dailyBilling
      .find({ workspaceId, date: { $gte: inicioMes, $lte: fecha } })
      .select("date amount metaSpend")
      .lean();

    const porDia = new Map<string, { monto: number; gasto: number }>();
    for (const e of registros as any[]) {
      const clave = claveDia(e.date);
      const previo = porDia.get(clave) ?? { monto: 0, gasto: 0 };
      // El gasto de Meta se repite en cada entrada del día: no se suma.
      porDia.set(clave, { monto: previo.monto + (e.amount || 0), gasto: Math.max(previo.gasto, e.metaSpend || 0) });
    }

    const hoyClave = claveDia(fecha);
    const delDia = porDia.get(hoyClave) ?? { monto: 0, gasto: 0 };
    const otros = [...porDia.entries()].filter(([k]) => k !== hoyClave).map(([, v]) => v.monto);
    const totalMes = [...porDia.values()].reduce((a, v) => a + v.monto, 0);

    const valorDe = (offsetDias: number) => porDia.get(claveDia(new Date(fecha.getTime() - offsetDias * MS_DIA)))?.monto ?? null;
    return {
      totalDia: delDia.monto,
      gastoMeta: delDia.gasto,
      roasDia: delDia.gasto > 0 ? Math.round((delDia.monto / delDia.gasto) * 100) / 100 : null,
      promedioMes: otros.length ? Math.round((otros.reduce((a, b) => a + b, 0) / otros.length) * 100) / 100 : null,
      diasRegistradosMes: porDia.size,
      totalMes: Math.round(totalMes * 100) / 100,
      diaAnterior: valorDe(1),
      mismoDiaSemanaPasada: valorDe(7),
      mejorDiaMes: otros.length ? Math.max(...otros, delDia.monto) : delDia.monto,
    };
  }

  /** Lo que ya registró esa persona ese día (para ofrecer corregirlo). */
  async entradaDe(chat: ITelegramChat, fecha: Date) {
    if (!chat.workspaceId || !chat.userId) return null;
    return models.dailyBilling
      .findOne({ workspaceId: chat.workspaceId, userId: chat.userId, date: diaEcuador(fecha) })
      .lean();
  }

  /**
   * Guarda el monto del día. Si esa persona ya registró ese día, lo corrige
   * en vez de crear otra entrada (el índice de Mongo no deja duplicados).
   */
  async registrar(chat: ITelegramChat, monto: number, fecha: Date): Promise<ResultadoFacturacion> {
    if (!chat.workspaceId) return { ok: false, motivo: "sin_entorno" };
    if (!chat.userId) return { ok: false, motivo: "sin_usuario" };
    if (!Number.isFinite(monto) || monto < 0 || monto > MONTO_MAXIMO) return { ok: false, motivo: "monto_invalido" };

    const dia = diaEcuador(fecha);
    const hoy = diaEcuador(new Date());
    // Ni el futuro ni algo de hace meses: eso se corrige en la plataforma.
    if (dia.getTime() > hoy.getTime() || hoy.getTime() - dia.getTime() > 31 * MS_DIA) {
      return { ok: false, motivo: "dia_invalido" };
    }

    const workspaceId = String(chat.workspaceId);
    const userId = String(chat.userId);
    try {
      const existente = await this.entradaDe(chat, dia);
      let accion: "creada" | "actualizada" = "creada";
      if (existente) {
        await billingService.updateEntry(
          String(existente._id),
          workspaceId,
          userId,
          "user",
          monto,
          "Corregida desde Telegram"
        );
        accion = "actualizada";
      } else {
        await billingService.createEntry(workspaceId, userId, monto, "Registrada desde Telegram", dia);
      }

      const contexto = await this.contextoDelDia(chat.workspaceId, dia);
      return {
        ok: true,
        accion,
        monto,
        dia,
        diaTexto: nombreDia(dia),
        totalDia: contexto.totalDia,
        gastoMeta: contexto.gastoMeta,
        roas: contexto.roasDia,
        contexto,
      };
    } catch (error: any) {
      if (error?.message === "EDIT_NOT_ALLOWED") return { ok: false, motivo: "sin_permiso" };
      console.error("[Facturación chat] no se pudo registrar:", error?.message || error);
      return { ok: false, motivo: "error" };
    }
  }

  /** El bot queda esperando el monto de ese día. */
  async pedirMonto(chat: ITelegramChat, fecha: Date): Promise<void> {
    const dato = { fecha: diaEcuador(fecha), pedidoEn: new Date() };
    await models.telegramChats.updateOne({ _id: chat._id }, { $set: { facturacionEsperada: dato } });
    chat.facturacionEsperada = dato;
  }

  /** El día que el bot está esperando, si el pedido sigue vigente. */
  esperando(chat: ITelegramChat): Date | null {
    const e = chat.facturacionEsperada;
    if (!e?.fecha || !e.pedidoEn) return null;
    if (Date.now() - new Date(e.pedidoEn).getTime() > ESPERA_MONTO_MS) return null;
    return new Date(e.fecha);
  }

  async olvidarPedido(chat: ITelegramChat): Promise<void> {
    await models.telegramChats.updateOne({ _id: chat._id }, { $unset: { facturacionEsperada: 1 } });
    chat.facturacionEsperada = undefined;
  }
}

export const facturacionChatService = new FacturacionChatService();
