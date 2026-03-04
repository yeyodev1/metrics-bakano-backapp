import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import models from "../models";

export interface CreateWorkspacePayload {
  name: string;
}

export interface CreateUserPayload {
  name?: string;
  email: string;
  password: string;
  role: "admin" | "colaborador";
  workspaceId: string;
}

export interface UpdateUserPayload {
  name?: string;
  email?: string;
  password?: string;
}

export class WorkspaceService {
  // ── Workspaces ────────────────────────────────────────────

  async createWorkspace(payload: CreateWorkspacePayload) {
    const existing = await models.workspaces.findOne({ name: payload.name.trim() }).lean();
    if (existing) throw new Error("WORKSPACE_NAME_TAKEN");

    const workspace = await models.workspaces.create({ name: payload.name.trim() });
    return workspace;
  }

  async listWorkspaces() {
    return models.workspaces
      .find({ isActive: true })
      .populate("adminId", "email role name")
      .sort({ createdAt: -1 })
      .lean();
  }

  async listWorkspacesForUser(userId: string) {
    if (!Types.ObjectId.isValid(userId)) throw new Error("INVALID_ID");
    const user = await models.users.findById(userId).lean();
    if (!user) return [];

    const workspaceIds = user.workspaces ? user.workspaces.map((w: any) => w.workspaceId.toString()) : [];

    // Add legacy workspaceId if it exists and hasn't been migrated
    if (user.workspaceId && !workspaceIds.includes(user.workspaceId.toString())) {
      workspaceIds.push(user.workspaceId.toString());
    }

    if (workspaceIds.length === 0) return [];

    return models.workspaces
      .find({ _id: { $in: workspaceIds }, isActive: true })
      .populate("adminId", "email role name")
      .sort({ createdAt: -1 })
      .lean();
  }

  async getWorkspaceById(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces
      .findById(workspaceId)
      .populate("adminId", "email role name isActive")
      .lean();

    if (!workspace) throw new Error("NOT_FOUND");
    return workspace;
  }

  async updateWorkspaceName(workspaceId: string, name: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const existing = await models.workspaces.findOne({
      name: name.trim(),
      _id: { $ne: new Types.ObjectId(workspaceId) },
    }).lean();

    if (existing) throw new Error("WORKSPACE_NAME_TAKEN");

    const workspace = await models.workspaces.findByIdAndUpdate(
      workspaceId,
      { name: name.trim() },
      { new: true }
    ).lean();

    if (!workspace) throw new Error("NOT_FOUND");
    return workspace;
  }

  // ── Users within a workspace ──────────────────────────────

  async listUsersByWorkspace(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const users = await models.users
      .find({
        "workspaces.workspaceId": new Types.ObjectId(workspaceId)
      })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    // Map role from workspaces to top-level for backwards compatibility in frontend
    return users.map(user => {
      const wsAccess = user.workspaces?.find(w => w.workspaceId.toString() === workspaceId);
      return {
        ...user,
        role: wsAccess?.role || user.role, // show the workspace role specifically
        workspaceId // append workspaceId
      };
    });
  }

  async createUser(payload: CreateUserPayload) {
    if (!Types.ObjectId.isValid(payload.workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces.findById(payload.workspaceId).lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    let user = await models.users.findOne({ email: payload.email.toLowerCase().trim() });

    if (user) {
      if (!user.workspaces) user.workspaces = [];

      // Migrar antiguo workspaceId al array si no está
      if (user.workspaceId) {
        const oldIdStr = user.workspaceId.toString();
        const hasOld = user.workspaces.some(w => w.workspaceId.toString() === oldIdStr);
        if (!hasOld) {
          user.workspaces.push({
            workspaceId: user.workspaceId,
            role: (user.role === "superadmin" || user.role === "user") ? "colaborador" : (user.role as "admin" | "colaborador")
          });
        }
      }

      // Revisamos si ya está en este nuevo workspace
      const alreadyInWorkspace = user.workspaces.some(w => w.workspaceId.toString() === payload.workspaceId);
      if (alreadyInWorkspace) throw new Error("EMAIL_TAKEN");

      // Migración on-the-fly para el campo "role" legacy
      if (user.role !== "superadmin" && user.role !== "user") {
        user.role = "user";
      }

      user.workspaces.push({
        workspaceId: new Types.ObjectId(payload.workspaceId),
        role: payload.role as "admin" | "colaborador"
      });
      await user.save();
    } else {
      // Si no existe, creamos el usuario base
      const hashed = await bcrypt.hash(payload.password, 10);

      user = await models.users.create({
        name: payload.name?.trim(),
        email: payload.email.toLowerCase().trim(),
        password: hashed,
        role: "user",
        workspaces: [{
          workspaceId: new Types.ObjectId(payload.workspaceId),
          role: payload.role as "admin" | "colaborador"
        }],
        isActive: true,
      });
    }

    // If the assigned role is admin, link them to the workspace (superficial backward compatibility)
    if (payload.role === "admin") {
      await models.workspaces.findByIdAndUpdate(payload.workspaceId, { adminId: user._id });
    }

    const { password, ...userWithoutPassword } = user.toObject();

    // Return mapped role for frontend
    return {
      ...userWithoutPassword,
      role: payload.role,
      workspaceId: payload.workspaceId
    };
  }

  async updateUser(workspaceId: string, userId: string, payload: UpdateUserPayload) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      throw new Error("INVALID_ID");
    }

    const user = await models.users.findOne({
      _id: new Types.ObjectId(userId),
      "workspaces.workspaceId": new Types.ObjectId(workspaceId)
    });
    if (!user) throw new Error("NOT_FOUND");

    if (payload.email) {
      const emailTaken = await models.users.findOne({
        email: payload.email.toLowerCase(),
        _id: { $ne: new Types.ObjectId(userId) },
      }).lean();
      if (emailTaken) throw new Error("EMAIL_TAKEN");
      user.email = payload.email.toLowerCase().trim();
    }

    if (payload.name !== undefined) user.name = payload.name.trim() || undefined;
    if (payload.password) user.password = await bcrypt.hash(payload.password, 10);

    // If role updating was supported, we would map over user.workspaces and update it.
    await user.save();

    const updated = user.toObject();
    const wsAccess = updated.workspaces?.find((w: any) => w.workspaceId.toString() === workspaceId);

    const { password, ...withoutPassword } = updated;
    return {
      ...withoutPassword,
      role: wsAccess?.role || updated.role,
      workspaceId
    };
  }

  async deleteUser(workspaceId: string, userId: string) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      throw new Error("INVALID_ID");
    }

    // Instead of deleting the user, remove the workspaceId from their workspaces array
    const user = await models.users.findOneAndUpdate(
      {
        _id: new Types.ObjectId(userId),
        "workspaces.workspaceId": new Types.ObjectId(workspaceId),
        role: { $ne: "superadmin" }
      },
      {
        $pull: { workspaces: { workspaceId: new Types.ObjectId(workspaceId) } }
      },
      { new: true }
    );

    if (!user) throw new Error("NOT_FOUND");

    // If the workspace array is now empty, fully delete the user to save DB space
    if (!user.workspaces || user.workspaces.length === 0) {
      await models.users.findByIdAndDelete(userId);
    }

    // If admin was deleted, unlink from workspace loosely
    await models.workspaces.updateOne(
      { _id: new Types.ObjectId(workspaceId), adminId: new Types.ObjectId(userId) },
      { $unset: { adminId: "" } }
    );

    return true;
  }
}
