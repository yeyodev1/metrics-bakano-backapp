import bcrypt from "bcryptjs";
import { Types } from "mongoose";
import models from "../models";
import { notificationService } from "./notification.service";

export interface CreateWorkspacePayload {
  name: string;
}

export interface CreateUserPayload {
  name?: string;
  email: string;
  password: string;
  role: "admin" | "colaborador";
  workspaceId: string;
  phoneNumber?: string;
  phoneExtension?: string;
}

export interface CreateGlobalUserPayload {
  name?: string;
  email: string;
  password?: string;
  workspaces: {
    workspaceId: string;
    role: "admin" | "colaborador";
  }[];
  phoneNumber?: string;
  phoneExtension?: string;
  isInternal?: boolean;
  internalRole?: string | null;
}

export interface UpdateGlobalUserPayload {
  name?: string;
  email?: string;
  password?: string;
  workspaces?: {
    workspaceId: string;
    role: "admin" | "colaborador";
  }[];
  phoneNumber?: string;
  phoneExtension?: string;
  isInternal?: boolean;
  internalRole?: string | null;
}

export interface UpdateUserPayload {
  name?: string;
  email?: string;
  password?: string;
  role?: "admin" | "colaborador";
  phoneNumber?: string;
  phoneExtension?: string;
}

export class WorkspaceService {
  // ── Workspaces ────────────────────────────────────────────

  async createWorkspace(payload: CreateWorkspacePayload) {
    const existing = await models.workspaces.findOne({ name: payload.name.trim() }).lean();
    if (existing) throw new Error("WORKSPACE_NAME_TAKEN");

    const workspace = await models.workspaces.create({ name: payload.name.trim() });
    return workspace;
  }

  async listWorkspaces(options: { search?: string; page?: number; limit?: number } = {}) {
    const { search, page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;

    const query: any = {};
    if (search) {
      query.name = { $regex: search, $options: "i" };
    }

    const [workspaces, total] = await Promise.all([
      models.workspaces
        .find(query)
        .populate("adminId", "email role name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      models.workspaces.countDocuments(query)
    ]);

    return {
      workspaces,
      total,
      page,
      limit,
      hasMore: total > skip + workspaces.length
    };
  }

  async listWorkspacesForUser(
    userId: string,
    options: { search?: string; page?: number; limit?: number } = {}
  ) {
    if (!Types.ObjectId.isValid(userId)) throw new Error("INVALID_ID");
    const user = await models.users.findById(userId).lean();
    if (!user) return { workspaces: [], total: 0, page: 1, limit: 10, hasMore: false };

    const workspaceIds = user.workspaces ? user.workspaces.map((w: any) => w.workspaceId.toString()) : [];

    // Add legacy workspaceId if it exists and hasn't been migrated
    if (user.workspaceId && !workspaceIds.includes(user.workspaceId.toString())) {
      workspaceIds.push(user.workspaceId.toString());
    }

    if (workspaceIds.length === 0) {
      return { workspaces: [], total: 0, page: 1, limit: options.limit ?? 10, hasMore: false };
    }

    const { search, page = 1, limit = 10 } = options;
    const skip = (page - 1) * limit;

    const query: any = { _id: { $in: workspaceIds }, isActive: true };
    if (search) query.name = { $regex: search, $options: "i" };

    const [workspaces, total] = await Promise.all([
      models.workspaces
        .find(query)
        .populate("adminId", "email role name")
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      models.workspaces.countDocuments(query),
    ]);

    // Inyectar el rol del usuario que está solicitando la lista en cada workspace objeto
    const result = workspaces.map((ws: any) => {
      let userRole: "admin" | "colaborador" = "colaborador";

      const wsAccess = user.workspaces?.find((w: any) => w.workspaceId.toString() === ws._id.toString());
      if (wsAccess) {
        userRole = wsAccess.role;
      } else if (user.workspaceId && user.workspaceId.toString() === ws._id.toString()) {
        userRole = (user.role === "admin") ? "admin" : "colaborador";
      }

      return { ...ws, userRole };
    });

    return { workspaces: result, total, page, limit, hasMore: total > skip + result.length };
  }

  async getWorkspaceById(workspaceId: string, userId?: string) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");

    const workspace = await models.workspaces
      .findById(workspaceId)
      .populate("adminId", "email role name isActive")
      .lean();

    if (!workspace) throw new Error("NOT_FOUND");

    // Inject user role if userId is provided
    let userRole: "admin" | "colaborador" | undefined;
    if (userId && Types.ObjectId.isValid(userId)) {
      const user = await models.users.findById(userId).lean();
      if (user) {
        const wsAccess = user.workspaces?.find((w: any) => w.workspaceId.toString() === workspaceId);
        if (wsAccess) {
          userRole = wsAccess.role;
        } else if (user.workspaceId && user.workspaceId.toString() === workspaceId) {
          userRole = user.role === "admin" ? "admin" : "colaborador";
        }
      }
    }

    return {
      ...workspace,
      userRole
    };
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
        $or: [
          { "workspaces.workspaceId": new Types.ObjectId(workspaceId) },
          { workspaceId: new Types.ObjectId(workspaceId) }
        ]
      })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    // Map role from workspaces to top-level for backwards compatibility in frontend
    return users.map(user => {
      const wsAccess = user.workspaces?.find(w => w.workspaceId.toString() === workspaceId);
      return {
        ...user,
        role: wsAccess?.role || (user.role === 'superadmin' || user.role === 'user' ? 'colaborador' : user.role), // show the workspace role specifically, or falcback
        workspaceId // append workspaceId
      };
    });
  }

  async listAllCollaborators(search?: string, workspaceId?: string) {
    // Only users who are not superadmins and have workspaces assigned or were legacy workspace owners
    const query: any = { 
      role: { $ne: "superadmin" },
      $or: [
        { workspaces: { $exists: true, $not: { $size: 0 } } },
        { workspaceId: { $exists: true } }
      ]
    };

    if (search) {
      const searchRegex = new RegExp(search, "i");
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { name: searchRegex },
          { email: searchRegex }
        ]
      });
    }

    if (workspaceId && Types.ObjectId.isValid(workspaceId)) {
      const wsId = new Types.ObjectId(workspaceId);
      query.$and = query.$and || [];
      query.$and.push({
        $or: [
          { "workspaces.workspaceId": wsId },
          { workspaceId: wsId }
        ]
      });
    }

    const users = await models.users
      .find(query)
      .populate("workspaces.workspaceId", "name")
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
      
    return users;
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

      if (payload.phoneNumber !== undefined) user.phoneNumber = payload.phoneNumber;
      if (payload.phoneExtension !== undefined) user.phoneExtension = payload.phoneExtension;

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
        phoneNumber: payload.phoneNumber,
        phoneExtension: payload.phoneExtension,
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
      $or: [
        { "workspaces.workspaceId": new Types.ObjectId(workspaceId) },
        { workspaceId: new Types.ObjectId(workspaceId) }
      ]
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
    if (payload.phoneNumber !== undefined) user.phoneNumber = payload.phoneNumber;
    if (payload.phoneExtension !== undefined) user.phoneExtension = payload.phoneExtension;

    if (payload.role) {
      let roleApplied = false;

      // 1. Try updating the array if it exists
      if (user.workspaces && user.workspaces.length > 0) {
        const wsAccess = user.workspaces.find((w: any) => w.workspaceId.toString() === workspaceId);
        if (wsAccess) {
          wsAccess.role = payload.role;
          roleApplied = true;
        }
      }

      // 2. If not in array or array is missing, but matches legacy workspaceId
      if (user.workspaceId && user.workspaceId.toString() === workspaceId) {
        user.role = payload.role;
        roleApplied = true;

        // Proactive migration: if they have a legacy workspace matches, add them to the array too
        if (!user.workspaces) user.workspaces = [];
        const hasWorkspacesArrayAccess = user.workspaces.some((w: any) => w.workspaceId.toString() === workspaceId);

        if (!hasWorkspacesArrayAccess) {
          user.workspaces.push({
            workspaceId: new Types.ObjectId(workspaceId),
            role: payload.role
          });
          // Set global role to 'user' to indicate they are now using the array logic
          user.role = 'user';
        }
      }

      // 3. Fallback for manual role sync if we didn't migrate yet
      if (!roleApplied && (user.role === 'admin' || user.role === 'colaborador')) {
        user.role = payload.role;
      }
    }

    await user.save();

    // Sync adminId in workspace if role changed to admin (backward compatibility)
    if (payload.role === "admin") {
      await models.workspaces.findByIdAndUpdate(workspaceId, { adminId: user._id });
    }

    const updated = user.toObject();
    const wsAccess = updated.workspaces?.find((w: any) => w.workspaceId.toString() === workspaceId);

    const { password, ...withoutPassword } = updated;
    return {
      ...withoutPassword,
      role: wsAccess?.role || (updated.role === 'superadmin' || updated.role === 'user' ? 'colaborador' : updated.role),
      workspaceId
    };
  }

  async deleteUser(workspaceId: string, userId: string) {
    if (!Types.ObjectId.isValid(workspaceId) || !Types.ObjectId.isValid(userId)) {
      throw new Error("INVALID_ID");
    }

    // Find user by either the new workspaces array or the legacy workspaceId
    const user = await models.users.findOne({
      _id: new Types.ObjectId(userId),
      $or: [
        { "workspaces.workspaceId": new Types.ObjectId(workspaceId) },
        { workspaceId: new Types.ObjectId(workspaceId) }
      ],
      role: { $ne: "superadmin" }
    });

    if (!user) throw new Error("NOT_FOUND");

    if (user.workspaces && user.workspaces.length > 0) {
      // New array logic: pull the workspace
      user.workspaces = user.workspaces.filter(w => w.workspaceId.toString() !== workspaceId);

      // If array is empty, we can choose to delete or keep as 'zombie'. 
      // Existing logic was to delete if empty.
      if (user.workspaces.length === 0) {
        await models.users.findByIdAndDelete(userId);
      } else {
        await user.save();
      }
    } else {
      // Legacy user found via workspaceId fallback: just delete since they only had this one
      await models.users.findByIdAndDelete(userId);
    }

    // If admin was deleted, unlink from workspace loosely
    await models.workspaces.updateOne(
      { _id: new Types.ObjectId(workspaceId), adminId: new Types.ObjectId(userId) },
      { $unset: { adminId: "" } }
    );

    return true;
  }

  // ── Global Superadmin Management ─────────────────────────────
  // These methods operate on users with role="superadmin" and are NOT
  // scoped to any workspace. They have full system access.

  async listSuperadmins() {
    const admins = await models.users
      .find({ role: "superadmin" })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();
    return admins;
  }

  async createSuperadmin(payload: { name?: string; email: string; password: string }) {
    const existing = await models.users.findOne({ email: payload.email.toLowerCase().trim() }).lean();
    if (existing) throw new Error("EMAIL_TAKEN");

    const hashed = await bcrypt.hash(payload.password, 10);
    const user = await models.users.create({
      name: payload.name?.trim(),
      email: payload.email.toLowerCase().trim(),
      password: hashed,
      role: "superadmin",
      workspaces: [],
      isActive: true,
    });

    const { password, ...withoutPassword } = user.toObject();
    return withoutPassword;
  }

  async deleteSuperadmin(requestingUserId: string, targetUserId: string) {
    if (!Types.ObjectId.isValid(targetUserId)) throw new Error("INVALID_ID");

    // Cannot delete yourself
    if (requestingUserId === targetUserId) throw new Error("CANNOT_DELETE_SELF");

    const user = await models.users.findOne({ _id: targetUserId, role: "superadmin" });
    if (!user) throw new Error("NOT_FOUND");

    await models.users.findByIdAndDelete(targetUserId);
    return true;
  }

  // ── Global User Management (Multi-workspace) ─────────────────

  async createGlobalUser(payload: CreateGlobalUserPayload) {
    let user = await models.users.findOne({ email: payload.email.toLowerCase().trim() });
    let newWorkspaceIds: string[] = [];

    if (user) {
      if (user.role === "superadmin") throw new Error("CANNOT_MOD_SUPERADMIN");

      // Track which workspaces are actually new
      const oldIds = new Set((user.workspaces || []).map(w => w.workspaceId.toString()));
      newWorkspaceIds = payload.workspaces
        .filter(ws => !oldIds.has(ws.workspaceId))
        .map(ws => ws.workspaceId);

      // Update basic info
      if (payload.name !== undefined) user.name = payload.name.trim();
      if (payload.password) user.password = await bcrypt.hash(payload.password, 10);
      if (payload.phoneNumber !== undefined) user.phoneNumber = payload.phoneNumber;
      if (payload.phoneExtension !== undefined) user.phoneExtension = payload.phoneExtension;
      if (payload.isInternal !== undefined) user.isInternal = payload.isInternal;
      if (payload.internalRole !== undefined) (user as any).internalRole = payload.internalRole;

      // Ensure user role is 'user' for multi-workspace logic
      user.role = "user";

      // Replace or update workspaces
      user.workspaces = payload.workspaces.map(ws => ({
        workspaceId: new Types.ObjectId(ws.workspaceId),
        role: ws.role
      }));

      await user.save();
      await user.populate("workspaces.workspaceId", "name");
    } else {
      if (!payload.password) throw new Error("PASSWORD_REQUIRED");
      const hashed = await bcrypt.hash(payload.password, 10);

      user = await models.users.create({
        name: payload.name?.trim(),
        email: payload.email.toLowerCase().trim(),
        password: hashed,
        role: "user",
        workspaces: payload.workspaces.map(ws => ({
          workspaceId: new Types.ObjectId(ws.workspaceId),
          role: ws.role
        })),
        isActive: true,
        phoneNumber: payload.phoneNumber,
        phoneExtension: payload.phoneExtension,
        isInternal: payload.isInternal || false,
        internalRole: payload.internalRole || null,
      });
      await user.populate("workspaces.workspaceId", "name");
      // All workspaces are new for a brand-new user
      newWorkspaceIds = payload.workspaces.map(ws => ws.workspaceId);
    }

    // Fire notifications for newly assigned workspaces (non-blocking)
    if (newWorkspaceIds.length > 0) {
      const userId = user._id.toString();
      const wsNames = await models.workspaces
        .find({ _id: { $in: newWorkspaceIds } })
        .select("name")
        .lean();
      for (const ws of wsNames) {
        notificationService
          .create(userId, "new_client_assigned", "Nuevo cliente asignado", `Se te ha asignado el cliente: ${ws.name}`, {
            workspaceId: ws._id.toString(),
          })
          .catch(() => {});
      }
    }

    const { password, ...withoutPassword } = user.toObject();
    return withoutPassword;
  }

  async updateGlobalUser(userId: string, payload: UpdateGlobalUserPayload) {
    if (!Types.ObjectId.isValid(userId)) throw new Error("INVALID_ID");

    const user = await models.users.findById(userId);
    if (!user) throw new Error("NOT_FOUND");
    if (user.role === "superadmin") throw new Error("CANNOT_MOD_SUPERADMIN");

    if (payload.email) {
      const emailTaken = await models.users.findOne({
        email: payload.email.toLowerCase(),
        _id: { $ne: new Types.ObjectId(userId) },
      }).lean();
      if (emailTaken) throw new Error("EMAIL_TAKEN");
      user.email = payload.email.toLowerCase().trim();
    }

    if (payload.name !== undefined) user.name = payload.name.trim();
    if (payload.password) user.password = await bcrypt.hash(payload.password, 10);
    if (payload.phoneNumber !== undefined) user.phoneNumber = payload.phoneNumber;
    if (payload.phoneExtension !== undefined) user.phoneExtension = payload.phoneExtension;
    if (payload.isInternal !== undefined) user.isInternal = payload.isInternal;
    if (payload.internalRole !== undefined) (user as any).internalRole = payload.internalRole;

    let newWorkspaceIds: string[] = [];
    if (payload.workspaces) {
      const oldIds = new Set((user.workspaces || []).map(w => w.workspaceId.toString()));
      newWorkspaceIds = payload.workspaces
        .filter(ws => !oldIds.has(ws.workspaceId))
        .map(ws => ws.workspaceId);

      user.workspaces = payload.workspaces.map(ws => ({
        workspaceId: new Types.ObjectId(ws.workspaceId),
        role: ws.role
      }));
    }

    await user.save();
    await user.populate("workspaces.workspaceId", "name");

    // Fire notifications for newly assigned workspaces (non-blocking)
    if (newWorkspaceIds.length > 0) {
      const wsNames = await models.workspaces
        .find({ _id: { $in: newWorkspaceIds } })
        .select("name")
        .lean();
      for (const ws of wsNames) {
        notificationService
          .create(userId, "new_client_assigned", "Nuevo cliente asignado", `Se te ha asignado el cliente: ${ws.name}`, {
            workspaceId: ws._id.toString(),
          })
          .catch(() => {});
      }
    }

    const { password, ...withoutPassword } = user.toObject();
    return withoutPassword;
  }

  async toggleWorkspaceActive(workspaceId: string, isActive: boolean) {
    if (!Types.ObjectId.isValid(workspaceId)) throw new Error("INVALID_ID");
    const workspace = await models.workspaces.findByIdAndUpdate(
      workspaceId,
      { isActive },
      { new: true }
    ).lean();
    if (!workspace) throw new Error("NOT_FOUND");
    return workspace;
  }
}

