import { Types } from "mongoose";
import models from "../models";
import { IPlanning } from "../models/planning.model";
import { ghlService } from "./ghl.service";

export class PlanningService {
  async createEntry(data: {
    workspaceId: string;
    title: string;
    date: Date;
    notes?: string;
    assignedTo?: string[];
    createdBy: string;
  }): Promise<IPlanning> {
    const entry = new models.planning({
      workspaceId: new Types.ObjectId(data.workspaceId),
      title: data.title,
      date: data.date,
      notes: data.notes,
      assignedTo: (data.assignedTo || []).map(id => new Types.ObjectId(id)),
      createdBy: new Types.ObjectId(data.createdBy),
    });
    await entry.save();
    await entry.populate("assignedTo", "name email internalRole");
    return entry;
  }

  /**
   * Las canceladas no se borran (pueden tener guiones), pero tampoco se
   * muestran: el cliente cancelaba desde Telegram y las seguia viendo aqui.
   */
  async listEntries(workspaceId: string, startDate?: Date, endDate?: Date, incluirCanceladas = false): Promise<IPlanning[]> {
    const query: any = { workspaceId: new Types.ObjectId(workspaceId) };
    if (!incluirCanceladas) {
      query.cancelada = { $ne: true };
      query.title = { $not: /^CANCELADA/ };
    }

    if (startDate || endDate) {
      query.date = {};
      if (startDate) query.date.$gte = startDate;
      if (endDate) query.date.$lte = endDate;
    }

    return await models.planning
      .find(query)
      .populate("assignedTo", "name email internalRole")
      .sort({ date: 1 });
  }

  /**
   * Entradas de varios entornos en UNA consulta, con el nombre del entorno
   * ya resuelto. `workspaceIds` null = sin filtro de entorno.
   */
  async listEntriesAcross(workspaceIds: string[] | null, startDate: Date, endDate: Date) {
    const query: any = { date: { $gte: startDate, $lte: endDate }, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } };
    if (workspaceIds) {
      query.workspaceId = { $in: workspaceIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)) };
    }
    const entries = await models.planning
      .find(query)
      .select("workspaceId title date endsAt assignedTo source crm cumplida cumplidaEn cumplidaPorNombre")
      .populate("workspaceId", "name photo")
      .sort({ date: 1 })
      .lean();
    return entries.map((e: any) => {
      const ws = e.workspaceId && typeof e.workspaceId === "object" ? e.workspaceId : null;
      return {
        ...e,
        workspaceId: ws ? ws._id : e.workspaceId,
        workspaceName: ws?.name ?? "Workspace",
        workspacePhoto: ws?.photo ?? null,
      };
    });
  }

  /**
   * Mover una produccion que vino del CRM tambien la mueve EN el CRM.
   *
   * Antes solo se guardaba en Mongo y el siguiente sync (cron cada 30 min o la
   * carga de la semana) la devolvia a la fecha del CRM: el equipo la movia y
   * "regresaba sola" a la fecha anterior, una y otra vez.
   */
  async updateEntry(
    entryId: string,
    data: {
      title?: string;
      date?: Date | string;
      notes?: string;
      assignedTo?: string[];
    }
  ): Promise<IPlanning | null> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");

    const updateData: any = {};
    if (data.date !== undefined) {
      const actual = await models.planning.findById(entryId).select("date endsAt source crm").lean();
      if (!actual) throw new Error("NOT_FOUND");
      const nueva = new Date(data.date as string);
      if (Number.isNaN(nueva.getTime())) throw new Error("FECHA_INVALIDA");
      const mueve = Math.abs(nueva.getTime() - new Date(actual.date).getTime()) > 60_000;

      if (mueve && actual.source === "crm" && actual.crm?.appointmentId) {
        try {
          await ghlService.updateAppointment(actual.crm.appointmentId, { startTime: nueva, forzar: true });
        } catch (error: any) {
          console.error("[Planificador] no se pudo mover la cita en el CRM:", error.response?.data || error.message);
          throw Object.assign(
            new Error(
              "Moví la fecha en Metrics pero el CRM la rechazó, así que no la guardo: en la próxima sincronización volvería a la fecha anterior. Revisa la cita en el CRM e inténtalo de nuevo."
            ),
            { status: 502 }
          );
        }
        updateData["crm.syncedAt"] = new Date();
        // La duracion se conserva: el CRM ya recalculo su fin con el calendario.
        const duracion = actual.endsAt ? new Date(actual.endsAt).getTime() - new Date(actual.date).getTime() : 0;
        if (duracion > 0) updateData.endsAt = new Date(nueva.getTime() + duracion);
      }
    }
    if (data.title !== undefined) updateData.title = data.title;
    if (data.date !== undefined) updateData.date = new Date(data.date as string);
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.assignedTo !== undefined) {
      updateData.assignedTo = data.assignedTo.map(id => new Types.ObjectId(id));
    }

    const entry = await models.planning
      .findByIdAndUpdate(entryId, { $set: updateData }, { new: true })
      .populate("assignedTo", "name email internalRole");

    if (!entry) throw new Error("NOT_FOUND");
    return entry;
  }

  async deleteEntry(entryId: string): Promise<void> {
    if (!Types.ObjectId.isValid(entryId)) throw new Error("INVALID_ID");

    const result = await models.planning.findByIdAndDelete(entryId);
    if (!result) throw new Error("NOT_FOUND");
  }

  /**
   * Da por cumplida la produccion. Idempotente: si ya estaba cumplida devuelve
   * `null` para que quien llama no vuelva a avisar. Se dispara cuando el
   * productor marca el primer guion como GRABADO.
   */
  async marcarCumplida(
    entryId: Types.ObjectId | string,
    actor?: { id?: string; nombre?: string }
  ): Promise<IPlanning | null> {
    if (!Types.ObjectId.isValid(entryId.toString())) return null;
    const set: Record<string, unknown> = { cumplida: true, cumplidaEn: new Date() };
    if (actor?.id && Types.ObjectId.isValid(actor.id)) set.cumplidaPorId = new Types.ObjectId(actor.id);
    if (actor?.nombre) set.cumplidaPorNombre = actor.nombre;
    return await models.planning.findOneAndUpdate(
      { _id: new Types.ObjectId(entryId.toString()), cumplida: { $ne: true } },
      { $set: set },
      { new: true }
    );
  }

  /**
   * Estado de la produccion del mes por entorno: cumplida si al menos una
   * produccion de ese mes (hora Ecuador) ya se grabo. Devuelve tambien la
   * proxima fecha para pintar "pendiente para el 12 de sep".
   */
  async monthlyStatus(year: number, month: number, workspaceIds?: string[] | null) {
    // Mes en hora Ecuador (UTC-5, sin horario de verano).
    const start = new Date(Date.UTC(year, month - 1, 1, 5, 0, 0));
    const end = new Date(Date.UTC(year, month, 1, 5, 0, 0));
    // Una produccion cancelada no cuenta como la del mes.
    const query: any = { date: { $gte: start, $lt: end }, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } };
    if (workspaceIds) {
      query.workspaceId = {
        $in: workspaceIds.filter((id) => Types.ObjectId.isValid(id)).map((id) => new Types.ObjectId(id)),
      };
    }
    const entries = await models.planning
      .find(query)
      .select("workspaceId date cumplida cumplidaEn source")
      .sort({ date: 1 })
      .lean();

    const byWorkspace: Record<
      string,
      { cumplida: boolean; cumplidaEn: Date | null; producciones: number; proximaFecha: Date | null; fechaCumplida: Date | null }
    > = {};
    for (const e of entries as any[]) {
      const key = e.workspaceId.toString();
      const cur = byWorkspace[key] || {
        cumplida: false,
        cumplidaEn: null,
        producciones: 0,
        proximaFecha: null,
        fechaCumplida: null,
      };
      cur.producciones += 1;
      if (e.cumplida) {
        cur.cumplida = true;
        if (!cur.cumplidaEn || (e.cumplidaEn && e.cumplidaEn < cur.cumplidaEn)) cur.cumplidaEn = e.cumplidaEn || null;
        if (!cur.fechaCumplida) cur.fechaCumplida = e.date;
      } else if (!cur.proximaFecha) {
        cur.proximaFecha = e.date;
      }
      byWorkspace[key] = cur;
    }
    return byWorkspace;
  }
}
