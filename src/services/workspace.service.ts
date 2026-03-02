import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import models from "../models";

export interface CreateWorkspacePayload {
  name: string;
}

export interface CreateAdminPayload {
  email: string;
  password: string;
  workspaceId: string;
}

export class WorkspaceService {
  // ── Workspaces ────────────────────────────────────────────

  async createWorkspace(payload: CreateWorkspacePayload) {
    const existing = await models.workspaces.findOne({ name: payload.name.trim() }).lean();

    if (existing) {
      throw new Error("WORKSPACE_NAME_TAKEN");
    }

    const workspace = await models.workspaces.create({ name: payload.name.trim() });
    return workspace;
  }

  async listWorkspaces() {
    return models.workspaces
      .find({ isActive: true })
      .populate("adminId", "email role")
      .sort({ createdAt: -1 })
      .lean();
  }

  async getWorkspaceById(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new Error("INVALID_ID");
    }
    const workspace = await models.workspaces
      .findById(workspaceId)
      .populate("adminId", "email role isActive")
      .lean();

    if (!workspace) throw new Error("NOT_FOUND");
    return workspace;
  }

  // ── Admins within a workspace ─────────────────────────────

  async createAdmin(payload: CreateAdminPayload) {
    if (!Types.ObjectId.isValid(payload.workspaceId)) {
      throw new Error("INVALID_ID");
    }

    const workspace = await models.workspaces.findById(payload.workspaceId).lean();
    if (!workspace) throw new Error("WORKSPACE_NOT_FOUND");

    const existingUser = await models.users.findOne({ email: payload.email.toLowerCase() }).lean();
    if (existingUser) throw new Error("EMAIL_TAKEN");

    const hashed = await bcrypt.hash(payload.password, 10);

    const admin = await models.users.create({
      email: payload.email.toLowerCase().trim(),
      password: hashed,
      role: "admin",
      workspaceId: new Types.ObjectId(payload.workspaceId),
      isActive: true,
    });

    // Link admin to workspace
    await models.workspaces.findByIdAndUpdate(payload.workspaceId, {
      adminId: admin._id,
    });

    const { password, ...adminWithoutPassword } = admin.toObject();
    return adminWithoutPassword;
  }

  async listAdminsByWorkspace(workspaceId: string) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      throw new Error("INVALID_ID");
    }
    return models.users
      .find({ workspaceId: new Types.ObjectId(workspaceId), role: "admin" })
      .select("-password")
      .lean();
  }
}
