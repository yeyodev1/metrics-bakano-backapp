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
}
