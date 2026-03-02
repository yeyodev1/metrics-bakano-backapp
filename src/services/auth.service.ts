import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import models from "../models";

export class AuthService {
  private readonly jwtSecret: string;

  constructor() {
    this.jwtSecret = process.env.JWT_SECRET || "default_jwt_secret_key";
  }

  public async login(email: string, passwordString: string) {
    const user = await models.users.findOne({ email }).lean();

    if (!user) {
      throw new Error("Invalid credentials");
    }

    if (!user.password) {
      throw new Error("Invalid credentials");
    }

    const isValidPassword = await bcrypt.compare(passwordString, user.password);

    if (!isValidPassword) {
      throw new Error("Invalid credentials");
    }

    // Exclude password from the returned object safely
    const { password, ...userWithoutPassword } = user;

    const token = jwt.sign(
      {
        _id: user._id,
        email: user.email,
        role: user.role,
        workspaceId: user.workspaceId
      },
      this.jwtSecret,
      { expiresIn: "24h" }
    );

    return {
      user: userWithoutPassword,
      token,
    };
  }
}
