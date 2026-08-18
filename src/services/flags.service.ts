import { Types } from "mongoose";
import models from "../models";
import type { EtapaRevision } from "../models/reviewEvent.model";

/**
 * Sistema de Banderas (rendimiento operativo).
 *
 * Todo sale del log de ReviewEvent: % de aprobacion = aprobados / decididos
 * dentro del periodo. Un rechazo cuenta aunque el item se haya corregido y
 * aprobado despues — ese es el punto: medir friccion, no estado final.
 */

export type FlagColor = "verde" | "amarillo" | "rojo";

export interface StageStats {
  aprobados: number;
  rechazados: number;
  total: number;
  /** null cuando no hubo decisiones en el periodo: sin datos no hay bandera. */
  pct: number | null;
  flag: FlagColor | null;
}

export function flagFor(pct: number | null): FlagColor | null {
  if (pct === null) return null;
  if (pct >= 85) return "verde";
  if (pct >= 70) return "amarillo";
  return "rojo";
}

function emptyStage(): StageStats {
  return { aprobados: 0, rechazados: 0, total: 0, pct: null, flag: null };
}

function closeStage(stage: StageStats): StageStats {
  stage.total = stage.aprobados + stage.rechazados;
  stage.pct = stage.total > 0 ? Math.round((stage.aprobados / stage.total) * 100) : null;
  stage.flag = flagFor(stage.pct);
  return stage;
}

function dateMatch(from?: Date, to?: Date): Record<string, unknown> {
  const range: Record<string, Date> = {};
  if (from) range.$gte = from;
  if (to) range.$lte = to;
  return Object.keys(range).length ? { createdAt: range } : {};
}

class FlagsService {
  /** Nivel 1 — banderas por cliente: contenido y edicion. */
  async clientFlags(from?: Date, to?: Date) {
    const rows = await models.reviewEvents.aggregate([
      { $match: dateMatch(from, to) },
      {
        $group: {
          _id: { workspaceId: "$workspaceId", etapa: "$etapa", resultado: "$resultado" },
          count: { $sum: 1 },
        },
      },
    ]);

    const byWorkspace = new Map<string, { contenido: StageStats; edicion: StageStats }>();
    for (const row of rows) {
      const wsId = String(row._id.workspaceId);
      if (!byWorkspace.has(wsId)) {
        byWorkspace.set(wsId, { contenido: emptyStage(), edicion: emptyStage() });
      }
      const stage = byWorkspace.get(wsId)![row._id.etapa as EtapaRevision];
      if (!stage) continue;
      if (row._id.resultado === "aprobado") stage.aprobados += row.count;
      else stage.rechazados += row.count;
    }

    const workspaces = await models.workspaces
      .find({ _id: { $in: [...byWorkspace.keys()].map((id) => new Types.ObjectId(id)) } })
      .select("name isActive")
      .lean();
    const wsInfo = new Map(workspaces.map((w) => [String(w._id), w]));

    const clientes = [...byWorkspace.entries()].map(([workspaceId, stages]) => ({
      workspaceId,
      nombre: wsInfo.get(workspaceId)?.name || "Cliente eliminado",
      isActive: wsInfo.get(workspaceId)?.isActive ?? false,
      contenido: closeStage(stages.contenido),
      edicion: closeStage(stages.edicion),
    }));

    // Los problemas primero: rojo < amarillo < verde < sin datos.
    const order: Record<string, number> = { rojo: 0, amarillo: 1, verde: 2 };
    const worst = (c: (typeof clientes)[number]) =>
      Math.min(
        c.contenido.flag ? order[c.contenido.flag] : 3,
        c.edicion.flag ? order[c.edicion.flag] : 3
      );
    clientes.sort((a, b) => worst(a) - worst(b) || a.nombre.localeCompare(b.nombre));
    return clientes;
  }

  /** Nivel 1 — leaderboard de colaboradores, una fila por (persona, etapa). */
  async collaboratorFlags(from?: Date, to?: Date) {
    const rows = await models.reviewEvents.aggregate([
      { $match: dateMatch(from, to) },
      {
        $group: {
          _id: { responsableId: "$responsableId", etapa: "$etapa", resultado: "$resultado" },
          count: { $sum: 1 },
          nombre: { $last: "$responsableNombre" },
        },
      },
    ]);

    const byKey = new Map<
      string,
      { userId: string | null; nombre: string; etapa: EtapaRevision; stats: StageStats }
    >();
    for (const row of rows) {
      const userId = row._id.responsableId ? String(row._id.responsableId) : null;
      const etapa = row._id.etapa as EtapaRevision;
      const key = `${userId}:${etapa}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          userId,
          nombre: row.nombre || "Sin asignar",
          etapa,
          stats: emptyStage(),
        });
      }
      const entry = byKey.get(key)!;
      if (row.nombre) entry.nombre = row.nombre;
      if (row._id.resultado === "aprobado") entry.stats.aprobados += row.count;
      else entry.stats.rechazados += row.count;
    }

    // Nombres frescos desde users (el denormalizado puede faltar en backfill).
    const ids = [...byKey.values()]
      .filter((e) => e.userId && e.nombre === "Sin asignar")
      .map((e) => new Types.ObjectId(e.userId!));
    if (ids.length) {
      const users = await models.users.find({ _id: { $in: ids } }).select("name email").lean();
      const names = new Map(users.map((u) => [String(u._id), u.name || u.email]));
      for (const entry of byKey.values()) {
        if (entry.userId && names.has(entry.userId)) entry.nombre = names.get(entry.userId)!;
      }
    }

    const colaboradores = [...byKey.values()].map((entry) => ({
      userId: entry.userId,
      nombre: entry.nombre,
      rol: entry.etapa === "contenido" ? "content" : "editor",
      etapa: entry.etapa,
      ...closeStage(entry.stats),
    }));

    colaboradores.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1) || b.total - a.total);
    return colaboradores;
  }

  /** Nivel 2 — radiografia: de donde vienen los rechazos de una persona. */
  async collaboratorDetail(userId: string, etapa?: EtapaRevision, from?: Date, to?: Date) {
    if (!Types.ObjectId.isValid(userId)) throw new Error("INVALID_ID");
    const match: Record<string, unknown> = {
      ...dateMatch(from, to),
      responsableId: new Types.ObjectId(userId),
    };
    if (etapa) match.etapa = etapa;

    const [totales, porCliente, porMotivo, recientes, user] = await Promise.all([
      models.reviewEvents.aggregate([
        { $match: match },
        { $group: { _id: "$resultado", count: { $sum: 1 } } },
      ]),
      models.reviewEvents.aggregate([
        { $match: { ...match, resultado: "rechazado" } },
        { $group: { _id: "$workspaceId", rechazados: { $sum: 1 } } },
        { $sort: { rechazados: -1 } },
      ]),
      models.reviewEvents.aggregate([
        { $match: { ...match, resultado: "rechazado" } },
        {
          $group: {
            _id: { $ifNull: ["$motivoCategoria", "otro"] },
            count: { $sum: 1 },
            ejemplos: { $push: "$motivo" },
          },
        },
        { $sort: { count: -1 } },
      ]),
      models.reviewEvents
        .find(match)
        .sort({ createdAt: -1 })
        .limit(20)
        .select("videoTema etapa resultado motivo motivoCategoria workspaceId createdAt fuente")
        .lean(),
      models.users.findById(userId).select("name email internalRole").lean(),
    ]);

    const stats = emptyStage();
    for (const t of totales) {
      if (t._id === "aprobado") stats.aprobados = t.count;
      if (t._id === "rechazado") stats.rechazados = t.count;
    }

    const wsIds = new Set<string>([
      ...porCliente.map((c) => String(c._id)),
      ...recientes.map((e) => String(e.workspaceId)),
    ]);
    const workspaces = await models.workspaces
      .find({ _id: { $in: [...wsIds].map((id) => new Types.ObjectId(id)) } })
      .select("name")
      .lean();
    const wsNames = new Map(workspaces.map((w) => [String(w._id), w.name]));

    return {
      colaborador: {
        userId,
        nombre: user?.name || user?.email || "Desconocido",
        internalRole: user?.internalRole,
      },
      ...closeStage(stats),
      porCliente: porCliente.map((c) => ({
        workspaceId: String(c._id),
        nombre: wsNames.get(String(c._id)) || "Cliente eliminado",
        rechazados: c.rechazados,
      })),
      motivos: porMotivo.map((m) => ({
        categoria: m._id,
        count: m.count,
        ejemplos: (m.ejemplos as (string | null)[])
          .filter((e): e is string => !!e && e.trim().length > 0)
          .slice(0, 5),
      })),
      eventosRecientes: recientes.map((e) => ({
        videoTema: e.videoTema,
        etapa: e.etapa,
        resultado: e.resultado,
        fuente: e.fuente,
        motivo: e.motivo,
        motivoCategoria: e.motivoCategoria,
        cliente: wsNames.get(String(e.workspaceId)) || "—",
        fecha: e.createdAt,
      })),
    };
  }
}

export const flagsService = new FlagsService();
