import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import models from "../models";

/** Una hora: suficiente para revisar el correo, corto si alguien lo reenvía. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;

/** Mínimo de la contraseña nueva. Se valida aquí, no solo en el formulario. */
export const MIN_PASSWORD_LENGTH = 8;

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export class AuthService {
  // Instead of caching in the constructor, we will read it dynamically
  // to ensure process.env.JWT_SECRET is loaded by dotenv before usage.
  private get jwtSecret(): string {
    return process.env.JWT_SECRET || "default_jwt_secret_key";
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
        isInternal: user.isInternal ?? false,
        internalRole: user.internalRole ?? null,
      },
      this.jwtSecret,
      { expiresIn: "14d" }
    );

    return {
      user: userWithoutPassword,
      token,
    };
  }

  public async me(userId: string) {
    const user = await models.users.findById(userId).lean();
    if (!user) {
      throw new Error("User not found");
    }
    const { password, ...userWithoutPassword } = user;
    return userWithoutPassword;
  }

  /**
   * Empieza la recuperación de contraseña.
   *
   * Devuelve el token en claro **solo** para que el controlador arme el enlace
   * del correo; en la base queda únicamente su hash. Si el correo no existe o
   * la cuenta está desactivada devuelve null: quien llama responde lo mismo en
   * los dos casos, para no convertir esto en un detector de correos
   * registrados.
   */
  public async requestPasswordReset(email: string) {
    const user = await models.users.findOne({
      email: email.toLowerCase().trim(),
    });

    if (!user || user.isActive === false) return null;

    const token = crypto.randomBytes(32).toString("hex");

    user.passwordResetTokenHash = hashToken(token);
    user.passwordResetExpiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    await user.save();

    return { user, token, expiresAt: user.passwordResetExpiresAt };
  }

  /** Un token sirve mientras no venza y no se haya usado. */
  private async findUserByResetToken(token: string) {
    if (!token) return null;

    return models.users
      .findOne({
        passwordResetTokenHash: hashToken(token),
        passwordResetExpiresAt: { $gt: new Date() },
      })
      .select("+passwordResetTokenHash +passwordResetExpiresAt");
  }

  /**
   * Comprueba el enlace antes de pedir la contraseña nueva, para no hacer que
   * alguien escriba una contraseña dos veces y recién ahí decirle que el
   * enlace venció.
   */
  public async verifyResetToken(token: string) {
    const user = await this.findUserByResetToken(token);
    if (!user) return null;
    return { email: user.email, name: user.name };
  }

  public async resetPassword(token: string, newPassword: string) {
    if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error("Password too short");
    }

    const user = await this.findUserByResetToken(token);
    if (!user) throw new Error("Invalid or expired token");

    user.password = await bcrypt.hash(newPassword, 10);
    // El token se quema al usarlo: el mismo enlace no vale dos veces.
    user.passwordResetTokenHash = undefined;
    user.passwordResetExpiresAt = undefined;
    await user.save();

    return { email: user.email, name: user.name };
  }
}
