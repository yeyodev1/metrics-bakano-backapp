import { Types } from "mongoose";
import models from "../models";
import { IPlanning } from "../models/planning.model";

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

  async listEntries(workspaceId: string, startDate?: Date, endDate?: Date): Promise<IPlanning[]> {
    const query: any = { workspaceId: new Types.ObjectId(workspaceId) };

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
    const query: any = { date: { $gte: startDate, $lte: endDate } };
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
    const query: any = { date: { $gte: start, $lt: end } };
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
