import crypto from "crypto";
import { CustomError } from "../errors/customError.error";

/**
 * Cifrado del token del CRM de cada cliente (AES-256-GCM).
 *
 * La clave es CRM_TOKEN_SECRET: 64 caracteres hex (32 bytes). Es propia de
 * esto y no cae a JWT_SECRET a proposito: si se rota el JWT no se pierden
 * todas las conexiones, y si se filtra uno no se abre el otro.
 *
 * Formato guardado: "v1.<iv>.<tag>.<cifrado>" en base64url.
 */

const VERSION = "v1";

function clave(): Buffer | null {
  const hex = (process.env.CRM_TOKEN_SECRET || "").trim();
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  return Buffer.from(hex, "hex");
}

/** true si CRM_TOKEN_SECRET esta bien configurada. */
export function cifradoCrmDisponible(): boolean {
  return clave() !== null;
}

function claveObligatoria(): Buffer {
  const k = clave();
  if (!k) {
    throw new CustomError(
      "La conexión del CRM no está disponible todavía: falta configurar la clave de cifrado en el servidor. Avísale al equipo de Bakano.",
      503
    );
  }
  return k;
}

/** Lanza el 503 con el mensaje claro si falta la clave. */
export function exigirCifradoCrm(): void {
  claveObligatoria();
}

export function cifrarTokenCrm(token: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", claveObligatoria(), iv);
  const cifrado = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), cifrado.toString("base64url")].join(".");
}

export function descifrarTokenCrm(valor: string): string {
  const [version, iv, tag, cifrado] = String(valor || "").split(".");
  if (version !== VERSION || !iv || !tag || !cifrado) {
    throw new CustomError("La conexión guardada del CRM no es válida: vuelve a conectarlo.", 500);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", claveObligatoria(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(cifrado, "base64url")), decipher.final()]).toString("utf8");
}
