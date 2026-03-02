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

  async getWorkspaceById(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces
      .findById(workspaceId)
      .populate("adminId", "email role name isActive")
      .lean();

    if (!workspace) throw new Error("NOT_FOUND");
    return workspace;
  }

  // ── Users within a workspace ──────────────────────────────

  async listUsersByWorkspace(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    return models.users
      .find({
        workspaceId: new Types.ObjectId(workspaceId),
        role: { $in: ["admin", "colaborador"] },
      })
      .select("-password")
      .sort({ role: 1, createdAt: -1 })
      .lean();
  }

  async createUser(payload: CreateUserPayload) {
    if (!Types.ObjectId.isValid(payload.workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces.findById(payload.workspaceId).lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const existing = await models.users.findOne({ email: payload.email.toLowerCase() }).lean();
    if (existing) throw new Error("EMAIL_TAKEN");

    const hashed = await bcrypt.hash(payload.password, 10);

    const user = await models.users.create({
      name: payload.name?.trim(),
      email: payload.email.toLowerCase().trim(),
      password: hashed,
      role: payload.role,
      workspaceId: new Types.ObjectId(payload.workspaceId),
      isActive: true,
    });

    // If the new user is admin, link them to the workspace
    if (payload.role === "admin") {
      await models.workspaces.findByIdAndUpdate(payload.workspaceId, { adminId: user._id });
    }

    const { password, ...userWithoutPassword } = user.toObject();
    return userWithoutPassword;
  }

  async updateUser(workspaceId: string, userId: string, payload: UpdateUserPayload) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      throw new Error("INVALID_ID");
    }

    const user = await models.users.findOne({
      _id: new Types.ObjectId(userId),
      workspaceId: new Types.ObjectId(workspaceId),
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

    await user.save();

    const updated = user.toObject();
    const { password, ...withoutPassword } = updated;
    return withoutPassword;
  }

  async deleteUser(workspaceId: string, userId: string) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      throw new Error("INVALID_ID");
    }

    const user = await models.users.findOneAndDelete({
      _id: new Types.ObjectId(userId),
      workspaceId: new Types.ObjectId(workspaceId),
      role: { $ne: "superadmin" }, // Protect superadmin from deletion
    });

    if (!user) throw new Error("NOT_FOUND");

    // If admin was deleted, unlink from workspace
    await models.workspaces.updateOne(
      { _id: new Types.ObjectId(workspaceId), adminId: new Types.ObjectId(userId) },
      { $unset: { adminId: "" } }
    );

    return true;
  }
}
