import { Types } from "mongoose";
import models from "../models";
import { billingService } from "./billing.service";
import { notificationService } from "./notification.service";
import { resendService } from "./resend.service";

export interface PulseAlert {
  level: "critico" | "atencion" | "info";
  code:
    | "sin_meta"
    | "dias_sin_registro"
    | "ritmo_atrasado"
    | "roas_bajo"
    | "sin_gasto_meta"
    | "meta_alcanzada";
  message: string;
}

export interface TeamContribution {
  userId: string;
  name: string;
  email: string;
  internalRole?: string;
  photoUrl?: string;
  isInternal: boolean;
  entryCount: number;
  amount: number;
  lastEntryDate: string | null;
}

/**
 * Pulso interno de un cliente: junta la facturacion diaria, la meta del mes y
 * el equipo asignado en una sola foto. Es interno a proposito — el cliente ve
 * su facturacion, pero la meta, el ritmo y quien no esta registrando son
 * conversaciones del equipo de Bakano.
 */
export class InternalPulseService {
  /** Hoy en Ecuador como YYYY-MM-DD. La operacion vive en UTC-5, no en UTC. */
  private todayEcuador(): string {
    const ahora = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const y = ahora.getUTCFullYear();
    const m = String(ahora.getUTCMonth() + 1).padStart(2, "0");
    const d = String(ahora.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  private dateStr(date: Date): string {
    const ec = new Date(date.getTime() - 5 * 60 * 60 * 1000);
    return `${ec.getUTCFullYear()}-${String(ec.getUTCMonth() + 1).padStart(2, "0")}-${String(
      ec.getUTCDate()
    ).padStart(2, "0")}`;
  }

  /** Limites del mes en medianoche de Ecuador, igual que guarda billing. */
  private monthBounds(year: number, month: number) {
    return {
      start: new Date(Date.UTC(year, month - 1, 1, 5, 0, 0, 0)),
      end: new Date(Date.UTC(year, month, 1, 5, 0, 0, 0)),
      daysInMonth: new Date(year, month, 0).getDate(),
    };
  }

  /**
   * Cuantos dias del mes ya pasaron. En un mes futuro es 0 y en uno cerrado son
   * todos: sin esto el % de avance de un mes pasado se compara contra un mes
   * que "sigue corriendo" y siempre sale atrasado.
   */
  private elapsedDays(year: number, month: number, daysInMonth: number): number {
    const hoy = this.todayEcuador();
    const [hy, hm, hd] = hoy.split("-").map(Number);
    if (year > hy || (year === hy && month > hm)) return 0;
    if (year < hy || (year === hy && month < hm)) return daysInMonth;
    return hd;
  }

  private esMesEnCurso(year: number, month: number): boolean {
    const [hy, hm] = this.todayEcuador().split("-").map(Number);
    return year === hy && month === hm;
  }

  // ── Metas ───────────────────────────────────────────────────────

  async getTarget(workspaceId: string, year: number, month: number) {
    return models.monthlyTargets
      .findOne({ workspaceId: new Types.ObjectId(workspaceId), year, month })
      .lean();
  }

  /**
   * Ultima meta definida antes de este mes. Se usa para proponer un numero
   * cuando el mes arranca sin meta: es mas facil confirmar una cifra que
   * inventarla desde cero, y asi ningun cliente se queda sin meta por pereza.
   */
  async getPreviousTarget(workspaceId: string, year: number, month: number) {
    return models.monthlyTargets
      .findOne({
        workspaceId: new Types.ObjectId(workspaceId),
        $or: [{ year: { $lt: year } }, { year, month: { $lt: month } }],
      })
      .sort({ year: -1, month: -1 })
      .lean();
  }

  async setTarget(
    workspaceId: string,
    year: number,
    month: number,
    payload: {
      targetAmount: number;
      stretchAmount?: number;
      notes?: string;
      source?: "manual" | "carryover";
    },
    user: { _id: string; name?: string; email: string }
  ) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    if (!Number.isFinite(payload.targetAmount) || payload.targetAmount < 0) {
      throw new Error("INVALID_AMOUNT");
    }
    if (month < 1 || month > 12) throw new Error("INVALID_MONTH");
    if (payload.stretchAmount !== undefined && payload.stretchAmount < payload.targetAmount) {
      throw new Error("STRETCH_BELOW_TARGET");
    }

    const target = await models.monthlyTargets.findOneAndUpdate(
      { workspaceId: new Types.ObjectId(workspaceId), year, month },
      {
        $set: {
          targetAmount: payload.targetAmount,
          stretchAmount: payload.stretchAmount,
          notes: payload.notes,
          source: payload.source || "manual",
          setBy: {
            userId: new Types.ObjectId(user._id),
            name: user.name || user.email,
            email: user.email,
          },
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    return target.toObject();
  }

  /** Meta vs facturado real de los ultimos N meses, para ver la tendencia. */
  async getTargetHistory(workspaceId: string, months = 6) {
    const hoy = this.todayEcuador();
    const [hy, hm] = hoy.split("-").map(Number);

    const periodos: { year: number; month: number }[] = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(hy, hm - 1 - i, 1));
      periodos.push({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 });
    }

    return Promise.all(
      periodos.map(async ({ year, month }) => {
        const [target, resumen] = await Promise.all([
          this.getTarget(workspaceId, year, month),
          this.getBilledTotals(workspaceId, year, month),
        ]);
        const targetAmount = target?.targetAmount ?? 0;
        return {
          year,
          month,
          label: `${year}-${String(month).padStart(2, "0")}`,
          targetAmount,
          billedAmount: resumen.billed,
          progressPct: targetAmount > 0 ? (resumen.billed / targetAmount) * 100 : 0,
          hasTarget: !!target,
        };
      })
    );
  }

  // ── Facturacion agregada (solo base de datos, sin llamar a Meta) ──

  private async getBilledTotals(workspaceId: string, year: number, month: number) {
    const { start, end } = this.monthBounds(year, month);
    const entries = await models.dailyBilling
      .find({ workspaceId: new Types.ObjectId(workspaceId), date: { $gte: start, $lt: end } })
      .select("date amount onlineRevenue metaSpend userId userName userEmail")
      .lean();

    let billed = 0;
    let online = 0;
    const porDia = new Map<string, number>();
    for (const e of entries) {
      billed += e.amount || 0;
      online += e.onlineRevenue || 0;
      const key = this.dateStr(e.date);
      porDia.set(key, (porDia.get(key) || 0) + (e.amount || 0));
    }

    return { billed, online, entries, porDia };
  }

  // ── Pulso completo de un cliente ─────────────────────────────────

  async getWorkspacePulse(workspaceId: string, year: number, month: number) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces
      .findById(workspaceId)
      .select("name isActive metaAds.adAccountName teamInfo")
      .lean();
    if (!workspace) throw new Error("NOT_FOUND");

    const { daysInMonth } = this.monthBounds(year, month);
    const elapsed = this.elapsedDays(year, month, daysInMonth);
    const remaining = Math.max(daysInMonth - elapsed, 0);

    const [{ days }, target, previousTarget, team] = await Promise.all([
      billingService.getMonthEntries(workspaceId, year, month),
      this.getTarget(workspaceId, year, month),
      this.getPreviousTarget(workspaceId, year, month),
      this.getAssignedTeam(workspaceId),
    ]);

    const totalBilled = days.reduce((s, d) => s + d.totalAmount, 0);
    const totalOnline = days.reduce((s, d) => s + d.totalOnlineRevenue, 0);
    const totalMetaSpend = days.reduce((s, d) => s + d.totalMetaSpend, 0);
    const roas = totalMetaSpend > 0 ? totalBilled / totalMetaSpend : 0;

    const targetAmount = target?.targetAmount ?? 0;
    const hasTarget = !!target;
    const progressPct = targetAmount > 0 ? (totalBilled / targetAmount) * 100 : 0;
    const gap = Math.max(targetAmount - totalBilled, 0);

    // Ritmo: cuanto deberia llevar facturado a esta altura del mes si la meta
    // se repartiera parejo entre los dias. No es una prediccion, es la vara.
    const expectedPct = daysInMonth > 0 ? (elapsed / daysInMonth) * 100 : 0;
    const expectedAmount = (targetAmount * expectedPct) / 100;
    const paceDiff = totalBilled - expectedAmount;
    const avgDaily = elapsed > 0 ? totalBilled / elapsed : 0;
    const projection = avgDaily * daysInMonth;
    const projectedPct = targetAmount > 0 ? (projection / targetAmount) * 100 : 0;
    const dailyNeeded = remaining > 0 ? gap / remaining : gap;

    let paceStatus: "sin_meta" | "adelante" | "en_linea" | "atrasado" | "cumplida" = "sin_meta";
    if (hasTarget && targetAmount > 0) {
      if (progressPct >= 100) paceStatus = "cumplida";
      else if (progressPct >= expectedPct + 5) paceStatus = "adelante";
      else if (progressPct >= expectedPct - 5) paceStatus = "en_linea";
      else paceStatus = "atrasado";
    }

    // Dias ya cerrados. El dia de hoy no cuenta como hueco ni corta la racha:
    // la facturacion se registra al cierre, y marcarlo en rojo a las 9am es una
    // alerta falsa que ensena al equipo a ignorar el tablero.
    const esMesActual = this.esMesEnCurso(year, month);
    const diasCerrados = Math.max(elapsed - (esMesActual ? 1 : 0), 0);
    const diasTranscurridos = days.filter((d) => Number(d.dateStr.split("-")[2]) <= elapsed);
    const diasEvaluables = days.filter((d) => Number(d.dateStr.split("-")[2]) <= diasCerrados);
    const missingDays = diasEvaluables.filter((d) => d.entryCount === 0).map((d) => d.dateStr);
    const conRegistro = diasTranscurridos.filter((d) => d.entryCount > 0);
    const lastEntryDate = conRegistro.length ? conRegistro[conRegistro.length - 1].dateStr : null;

    const hoy = this.todayEcuador();
    const daysSinceLastEntry = lastEntryDate
      ? Math.round(
          (Date.parse(`${hoy}T00:00:00Z`) - Date.parse(`${lastEntryDate}T00:00:00Z`)) / 86400000
        )
      : null;

    // Racha: dias seguidos con registro contando hacia atras. Arranca en hoy si
    // hoy ya tiene registro, y si no, en ayer — asi la racha no aparece rota
    // durante todo el dia hasta que alguien registre.
    const paraRacha = diasTranscurridos.length
      && diasTranscurridos[diasTranscurridos.length - 1].entryCount === 0
      && esMesActual
      ? diasTranscurridos.slice(0, -1)
      : diasTranscurridos;
    let streak = 0;
    for (let i = paraRacha.length - 1; i >= 0; i--) {
      if (paraRacha[i].entryCount > 0) streak++;
      else break;
    }

    const bestDay = diasTranscurridos.reduce<{ dateStr: string; amount: number } | null>(
      (mejor, d) =>
        !mejor || d.totalAmount > mejor.amount ? { dateStr: d.dateStr, amount: d.totalAmount } : mejor,
      null
    );

    const contributions = this.buildContributions(days, team);
    const alerts = this.buildAlerts({
      hasTarget,
      paceStatus,
      progressPct,
      missingDays,
      daysSinceLastEntry,
      roas,
      totalMetaSpend,
      elapsed,
    });

    return {
      workspace: {
        _id: String(workspace._id),
        name: workspace.name,
        isActive: workspace.isActive,
        adAccountName: workspace.metaAds?.adAccountName || null,
      },
      period: { year, month, daysInMonth, elapsedDays: elapsed, remainingDays: remaining },
      target: hasTarget
        ? {
            _id: String(target!._id),
            targetAmount,
            stretchAmount: target!.stretchAmount ?? null,
            notes: target!.notes ?? null,
            source: target!.source,
            setBy: target!.setBy
              ? { name: target!.setBy.name, email: target!.setBy.email }
              : null,
            updatedAt: target!.updatedAt,
          }
        : null,
      suggestedTarget: previousTarget
        ? {
            targetAmount: previousTarget.targetAmount,
            fromLabel: `${previousTarget.year}-${String(previousTarget.month).padStart(2, "0")}`,
          }
        : null,
      totals: {
        billed: totalBilled,
        online: totalOnline,
        metaSpend: totalMetaSpend,
        roas,
        avgDaily,
        bestDay,
      },
      progress: {
        hasTarget,
        progressPct,
        expectedPct,
        expectedAmount,
        paceDiff,
        paceStatus,
        gap,
        projection,
        projectedPct,
        dailyNeeded,
        stretchPct:
          target?.stretchAmount && target.stretchAmount > 0
            ? (totalBilled / target.stretchAmount) * 100
            : null,
      },
      discipline: {
        missingDays,
        missingCount: missingDays.length,
        lastEntryDate,
        daysSinceLastEntry,
        streak,
        registeredDays: conRegistro.length,
      },
      team: contributions,
      alerts,
      days: days.map((d) => ({
        dateStr: d.dateStr,
        amount: d.totalAmount,
        metaSpend: d.totalMetaSpend,
        roas: d.avgROAS,
        entryCount: d.entryCount,
        targetDaily: targetAmount > 0 ? targetAmount / daysInMonth : 0,
      })),
    };
  }

  /** Equipo interno asignado al cliente, ordenado por rol. */
  private async getAssignedTeam(workspaceId: string) {
    const wsId = new Types.ObjectId(workspaceId);
    return models.users
      .find({
        isActive: true,
        isInternal: true,
        $or: [{ "workspaces.workspaceId": wsId }, { workspaceId: wsId }],
      })
      .select("name lastName email internalRole photoUrl isInternal")
      .sort({ internalRole: 1, name: 1 })
      .lean();
  }

  /**
   * Cruza el equipo asignado con quien realmente registro facturacion este mes.
   * Aparecen tambien los externos que registraron: el equipo necesita ver quien
   * esta alimentando el dato, sea del cliente o de Bakano.
   */
  private buildContributions(days: any[], team: any[]): TeamContribution[] {
    const porUsuario = new Map<string, TeamContribution>();

    for (const miembro of team) {
      porUsuario.set(String(miembro._id), {
        userId: String(miembro._id),
        name: [miembro.name, miembro.lastName].filter(Boolean).join(" ") || miembro.email,
        email: miembro.email,
        internalRole: miembro.internalRole,
        photoUrl: miembro.photoUrl,
        isInternal: true,
        entryCount: 0,
        amount: 0,
        lastEntryDate: null,
      });
    }

    for (const dia of days) {
      for (const entry of dia.entries || []) {
        const id = String(entry.userId);
        const actual = porUsuario.get(id);
        if (actual) {
          actual.entryCount++;
          actual.amount += entry.amount || 0;
          actual.lastEntryDate = dia.dateStr;
        } else {
          porUsuario.set(id, {
            userId: id,
            name: entry.userName,
            email: entry.userEmail,
            isInternal: false,
            entryCount: 1,
            amount: entry.amount || 0,
            lastEntryDate: dia.dateStr,
          });
        }
      }
    }

    return [...porUsuario.values()].sort((a, b) => b.amount - a.amount);
  }

  private buildAlerts(ctx: {
    hasTarget: boolean;
    paceStatus: string;
    progressPct: number;
    missingDays: string[];
    daysSinceLastEntry: number | null;
    roas: number;
    totalMetaSpend: number;
    elapsed: number;
  }): PulseAlert[] {
    const alerts: PulseAlert[] = [];

    if (!ctx.hasTarget) {
      alerts.push({
        level: "critico",
        code: "sin_meta",
        message: "Este cliente no tiene meta mensual definida. Sin meta no hay contra que medir.",
      });
    }

    if (ctx.daysSinceLastEntry !== null && ctx.daysSinceLastEntry >= 3) {
      alerts.push({
        level: ctx.daysSinceLastEntry >= 7 ? "critico" : "atencion",
        code: "dias_sin_registro",
        message: `Hace ${ctx.daysSinceLastEntry} dias que nadie registra facturacion.`,
      });
    } else if (ctx.daysSinceLastEntry === null && ctx.elapsed > 0) {
      alerts.push({
        level: "critico",
        code: "dias_sin_registro",
        message: "No hay ni un dia de facturacion registrado este mes.",
      });
    }

    if (ctx.missingDays.length >= 3) {
      alerts.push({
        level: "atencion",
        code: "dias_sin_registro",
        message: `${ctx.missingDays.length} dias del mes sin registro. El ROAS del mes queda inflado.`,
      });
    }

    if (ctx.paceStatus === "atrasado") {
      alerts.push({
        level: "atencion",
        code: "ritmo_atrasado",
        message: `Va al ${ctx.progressPct.toFixed(0)}% de la meta y el mes ya corrio mas que eso.`,
      });
    }

    if (ctx.paceStatus === "cumplida") {
      alerts.push({
        level: "info",
        code: "meta_alcanzada",
        message: "Meta del mes cumplida. Toca subir la vara.",
      });
    }

    if (ctx.totalMetaSpend === 0 && ctx.elapsed > 2) {
      alerts.push({
        level: "atencion",
        code: "sin_gasto_meta",
        message: "Sin gasto de Meta registrado: revisa la cuenta publicitaria vinculada.",
      });
    } else if (ctx.totalMetaSpend > 0 && ctx.roas > 0 && ctx.roas < 1) {
      alerts.push({
        level: "critico",
        code: "roas_bajo",
        message: `ROAS del mes en ${ctx.roas.toFixed(2)}: se esta gastando mas de lo que entra.`,
      });
    }

    return alerts;
  }

  // ── Estado rapido (para el menu) ─────────────────────────────────

  /**
   * Estado mínimo de la meta de un cliente. No llama a Meta ni arma el pulso
   * completo: lo consume el menú lateral en cada navegación, y esperar a la
   * Graph API para pintar una etiqueta dejaría el menú en blanco varios
   * segundos.
   */
  async getTargetStatus(workspaceId: string, year: number, month: number) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const { daysInMonth } = this.monthBounds(year, month);
    const elapsed = this.elapsedDays(year, month, daysInMonth);
    const expectedPct = daysInMonth > 0 ? (elapsed / daysInMonth) * 100 : 0;

    const [target, { billed }] = await Promise.all([
      this.getTarget(workspaceId, year, month),
      this.getBilledTotals(workspaceId, year, month),
    ]);

    const targetAmount = target?.targetAmount ?? 0;
    const progressPct = targetAmount > 0 ? (billed / targetAmount) * 100 : 0;

    let paceStatus: "sin_meta" | "adelante" | "en_linea" | "atrasado" | "cumplida" = "sin_meta";
    if (targetAmount > 0) {
      if (progressPct >= 100) paceStatus = "cumplida";
      else if (progressPct >= expectedPct + 5) paceStatus = "adelante";
      else if (progressPct >= expectedPct - 5) paceStatus = "en_linea";
      else paceStatus = "atrasado";
    }

    return { hasTarget: !!target, targetAmount, billed, progressPct, expectedPct, paceStatus };
  }

  /**
   * Cuántos clientes activos siguen sin meta este mes. Es el número que el menú
   * muestra como pendiente: sin él, "faltan metas" es una frase que nadie ve.
   */
  async countMissingTargets(year: number, month: number) {
    // Dos conteos en paralelo en vez de traerse los entornos: esto lo pide el
    // menu en cada navegacion, y bajar 99 documentos para contarlos costaba
    // segundos de espera por una etiqueta.
    const metas = await models.monthlyTargets.find({ year, month }).select("workspaceId").lean();
    const ids = metas.map((t) => t.workspaceId);

    const [total, withTarget] = await Promise.all([
      models.workspaces.countDocuments({ isActive: true }),
      ids.length ? models.workspaces.countDocuments({ isActive: true, _id: { $in: ids } }) : 0,
    ]);

    return { total, withTarget, missing: Math.max(total - withTarget, 0) };
  }

  // ── Vista global del equipo ──────────────────────────────────────

  /**
   * Una fila por cliente activo con meta, facturado y ritmo. No llama a Meta:
   * son decenas de clientes y la vista tiene que abrir rapido; el gasto y el
   * ROAS del mes viven en el detalle de cada cliente.
   */
  async getOverview(year: number, month: number) {
    const workspaces = await models.workspaces
      .find({ isActive: true })
      .select("name")
      .sort({ name: 1 })
      .lean();

    const { daysInMonth } = this.monthBounds(year, month);
    const elapsed = this.elapsedDays(year, month, daysInMonth);
    const diasCerrados = Math.max(elapsed - (this.esMesEnCurso(year, month) ? 1 : 0), 0);
    const expectedPct = daysInMonth > 0 ? (elapsed / daysInMonth) * 100 : 0;

    const targets = await models.monthlyTargets.find({ year, month }).lean();
    const targetPorWs = new Map(targets.map((t) => [String(t.workspaceId), t]));

    const rows = await Promise.all(
      workspaces.map(async (ws) => {
        const wsId = String(ws._id);
        const { billed, porDia } = await this.getBilledTotals(wsId, year, month);
        const target = targetPorWs.get(wsId);
        const targetAmount = target?.targetAmount ?? 0;
        const progressPct = targetAmount > 0 ? (billed / targetAmount) * 100 : 0;

        let missingCount = 0;
        for (let d = 1; d <= diasCerrados; d++) {
          const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
          if (!porDia.has(key)) missingCount++;
        }

        let paceStatus: "sin_meta" | "adelante" | "en_linea" | "atrasado" | "cumplida" = "sin_meta";
        if (targetAmount > 0) {
          if (progressPct >= 100) paceStatus = "cumplida";
          else if (progressPct >= expectedPct + 5) paceStatus = "adelante";
          else if (progressPct >= expectedPct - 5) paceStatus = "en_linea";
          else paceStatus = "atrasado";
        }

        return {
          workspaceId: wsId,
          name: ws.name,
          hasTarget: !!target,
          targetAmount,
          billed,
          progressPct,
          expectedPct,
          gap: Math.max(targetAmount - billed, 0),
          projection: elapsed > 0 ? (billed / elapsed) * daysInMonth : 0,
          missingCount,
          paceStatus,
        };
      })
    );

    const conMeta = rows.filter((r) => r.hasTarget);
    return {
      period: { year, month, daysInMonth, elapsedDays: elapsed, expectedPct },
      totals: {
        clients: rows.length,
        withTarget: conMeta.length,
        withoutTarget: rows.length - conMeta.length,
        targetAmount: conMeta.reduce((s, r) => s + r.targetAmount, 0),
        billed: rows.reduce((s, r) => s + r.billed, 0),
        behind: rows.filter((r) => r.paceStatus === "atrasado").length,
      },
      rows: rows.sort((a, b) => {
        // Primero lo que duele: sin meta, luego atrasados, luego el resto.
        const orden = { sin_meta: 0, atrasado: 1, en_linea: 2, adelante: 3, cumplida: 4 } as const;
        return orden[a.paceStatus] - orden[b.paceStatus] || b.billed - a.billed;
      }),
    };
  }

  // ── Recordatorios al equipo asignado ─────────────────────────────

  /**
   * Avisa al equipo asignado: si falta la meta del mes, si el ritmo va atrasado
   * o si nadie registra facturacion.
   *
   * Va un solo correo por persona con todos sus clientes, no uno por cliente:
   * el equipo interno esta asignado a casi todos los entornos, asi que la
   * version "un aviso por cliente" mandaba ~900 correos diarios y el
   * recordatorio se volvia ruido que la gente filtra a la papelera.
   */
  async runTargetReminders(opts: { onlyWorkspaceId?: string; sendEmail?: boolean } = {}) {
    const hoy = this.todayEcuador();
    const [year, month] = hoy.split("-").map(Number);
    const { daysInMonth } = this.monthBounds(year, month);
    const elapsed = this.elapsedDays(year, month, daysInMonth);
    const diasCerrados = Math.max(elapsed - 1, 0);
    const expectedPct = daysInMonth > 0 ? (elapsed / daysInMonth) * 100 : 0;

    const filtro: any = { isActive: true };
    if (opts.onlyWorkspaceId) filtro._id = new Types.ObjectId(opts.onlyWorkspaceId);
    const workspaces = await models.workspaces.find(filtro).select("name").lean();

    type ClienteEnRiesgo = {
      workspaceId: string;
      name: string;
      hasTarget: boolean;
      targetAmount: number;
      billed: number;
      progressPct: number;
      missingCount: number;
      motivos: string[];
    };

    const porPersona = new Map<
      string,
      { email: string; name: string; clientes: ClienteEnRiesgo[] }
    >();
    const resultados: Array<{ workspaceId: string; name: string; notified: number; motivos: string[] }> = [];

    for (const ws of workspaces) {
      const wsId = String(ws._id);
      const [{ billed, porDia }, target, team] = await Promise.all([
        this.getBilledTotals(wsId, year, month),
        this.getTarget(wsId, year, month),
        this.getAssignedTeam(wsId),
      ]);

      if (!team.length) continue;

      const targetAmount = target?.targetAmount ?? 0;
      const progressPct = targetAmount > 0 ? (billed / targetAmount) * 100 : 0;

      let missingCount = 0;
      for (let d = 1; d <= diasCerrados; d++) {
        const key = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        if (!porDia.has(key)) missingCount++;
      }

      const motivos: string[] = [];
      if (!target) motivos.push("no tiene meta mensual definida");
      if (targetAmount > 0 && progressPct < expectedPct - 5) {
        motivos.push(
          `va al ${progressPct.toFixed(0)}% de la meta cuando el mes ya corrio el ${expectedPct.toFixed(0)}%`
        );
      }
      if (missingCount >= 3) motivos.push(`${missingCount} dias del mes sin facturacion registrada`);

      if (!motivos.length) continue;

      const cliente: ClienteEnRiesgo = {
        workspaceId: wsId,
        name: ws.name,
        hasTarget: !!target,
        targetAmount,
        billed,
        progressPct,
        missingCount,
        motivos,
      };

      for (const miembro of team) {
        const id = String(miembro._id);
        if (!porPersona.has(id)) {
          porPersona.set(id, {
            email: miembro.email,
            name: [miembro.name, miembro.lastName].filter(Boolean).join(" ") || miembro.email,
            clientes: [],
          });
        }
        porPersona.get(id)!.clientes.push(cliente);
      }

      resultados.push({ workspaceId: wsId, name: ws.name, notified: team.length, motivos });
    }

    // Los que peor estan van primero: sin meta, y dentro de esos, los de mayor
    // facturacion — es donde una meta ausente cuesta mas plata.
    const ordenar = (clientes: ClienteEnRiesgo[]) =>
      [...clientes].sort(
        (a, b) => Number(a.hasTarget) - Number(b.hasTarget) || b.billed - a.billed
      );

    const avisos = [...porPersona.entries()].map(async ([userId, persona]) => {
      const clientes = ordenar(persona.clientes);
      const sinMeta = clientes.filter((c) => !c.hasTarget).length;
      const conRiesgo = clientes.length - sinMeta;

      const title =
        clientes.length === 1
          ? clientes[0].hasTarget
            ? `${clientes[0].name}: la meta del mes necesita atencion`
            : `${clientes[0].name}: falta definir la meta del mes`
          : `${clientes.length} clientes con la meta del mes en rojo`;

      const body =
        clientes.length === 1
          ? `${clientes[0].motivos.join(", ")}. Facturado ${this.money(clientes[0].billed)}${
              clientes[0].targetAmount > 0 ? ` de ${this.money(clientes[0].targetAmount)}` : ""
            }.`
          : `${sinMeta} sin meta definida${conRiesgo ? ` y ${conRiesgo} fuera de ritmo` : ""}: ` +
            clientes
              .slice(0, 4)
              .map((c) => c.name)
              .join(", ") +
            (clientes.length > 4 ? ` y ${clientes.length - 4} mas.` : ".");

      await notificationService.create(
        userId,
        sinMeta ? "monthly_target_missing" : "monthly_target_pace",
        title,
        body,
        clientes.length === 1 ? { workspaceId: clientes[0].workspaceId } : {}
      );

      if (opts.sendEmail !== false) {
        await resendService.sendMonthlyTargetDigest({
          to: persona.email,
          recipientName: persona.name,
          year,
          month,
          expectedPct,
          clients: clientes.map((c) => ({
            workspaceId: c.workspaceId,
            name: c.name,
            hasTarget: c.hasTarget,
            targetAmount: c.targetAmount,
            billed: c.billed,
            progressPct: c.progressPct,
            missingCount: c.missingCount,
            motivos: c.motivos,
          })),
        });
      }
    });

    await Promise.allSettled(avisos);

    return {
      period: { year, month },
      reviewed: workspaces.length,
      notifiedPeople: porPersona.size,
      alerted: resultados,
    };
  }

  private money(value: number): string {
    return `$${value.toLocaleString("es-EC", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}

export const internalPulseService = new InternalPulseService();
