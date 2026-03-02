import { Schema, model, Document, Types } from "mongoose";

export interface IUser extends Document {
  name?: string;
  email: string;
  password?: string;
  role: "superadmin" | "admin" | "colaborador";
  workspaceId?: Types.ObjectId;
  isActive: boolean;
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
      enum: ["superadmin", "admin", "colaborador"],
      default: "colaborador",
    },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

export const UserModel = model<IUser>("User", UserSchema);
