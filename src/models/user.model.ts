import { Schema, model, Document, Types } from "mongoose";

export interface IUserWorkspaceAccess {
  workspaceId: Types.ObjectId;
  role: "admin" | "colaborador";
}

export interface IUser extends Document {
  name?: string;
  email: string;
  password?: string;
  role: "superadmin" | "user" | "admin" | "colaborador";
  workspaceId?: Types.ObjectId;
  workspaces: IUserWorkspaceAccess[];
  isActive: boolean;
  phoneNumber?: string;
  phoneExtension?: string;
  createdAt: Date;
  updatedAt: Date;
}

const UserSchema = new Schema<IUser>(
  {
    name: {
      type: String,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ["superadmin", "user", "admin", "colaborador"],
      default: "user",
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
    },
    workspaces: [
      {
        workspaceId: {
          type: Schema.Types.ObjectId,
          ref: "Workspace",
          required: true,
        },
        role: {
          type: String,
          enum: ["admin", "colaborador"],
          required: true,
        },
      }
    ],
    isActive: {
      type: Boolean,
      default: true,
    },
    phoneNumber: {
      type: String,
      trim: true,
    },
    phoneExtension: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const UserModel = model<IUser>("User", UserSchema);
