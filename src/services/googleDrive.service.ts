import axios from "axios";
import jwt from "jsonwebtoken";

/**
 * Entrega de videos maestros a Google Drive (unidad compartida).
 *
 * Los archivos NUNCA pueden ser propiedad de la service account: su My Drive
 * tiene un tope duro de 15GB. Todo se crea dentro de la unidad compartida
 * (DRIVE_SHARED_DRIVE_ID), donde el dueño es la unidad y el almacenamiento
 * sale del pool del Workspace. Por eso cada llamada lleva
 * `supportsAllDrives=true`.
 *
 * La subida del archivo NO pasa por aqui: este backend corre en Vercel, que
 * corta el body en ~4.5MB. El backend solo inicia la sesion resumable y el
 * navegador sube directo a googleapis.com.
 */

const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SCOPE = "https://www.googleapis.com/auth/drive";

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

export interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
  parents?: string[];
  webViewLink?: string;
}

function loadKey(): ServiceAccountKey {
  const b64 = process.env.GOOGLE_DRIVE_SA_KEY_B64;
  if (!b64) throw new Error("DRIVE_NOT_CONFIGURED");
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    throw new Error("DRIVE_NOT_CONFIGURED");
  }
}

export function driveSharedDriveId(): string {
  const id = process.env.DRIVE_SHARED_DRIVE_ID;
  if (!id) throw new Error("DRIVE_NOT_CONFIGURED");
  return id;
}

/** Caracteres invalidos en nombres de archivo de Drive/OS. */
export function sanitizeDriveName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, "-").replace(/\s+/g, " ").trim().slice(0, 120);
}

class GoogleDriveService {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && this.tokenCache.expiresAt > Date.now() + 60_000) {
      return this.tokenCache.token;
    }
    const key = loadKey();
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      { iss: key.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600 },
      key.private_key,
      { algorithm: "RS256" }
    );
    const res = await axios.post(
      TOKEN_URL,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    this.tokenCache = {
      token: res.data.access_token,
      expiresAt: Date.now() + res.data.expires_in * 1000,
    };
    return this.tokenCache.token;
  }

  private async headers(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.getAccessToken()}` };
  }

  /** Busca una carpeta hija por nombre exacto dentro de la unidad compartida. */
  async findChildFolder(parentId: string, name: string): Promise<DriveFile | null> {
    const q = [
      `name='${name.replace(/'/g, "\\'")}'`,
      `'${parentId}' in parents`,
      "mimeType='application/vnd.google-apps.folder'",
      "trashed=false",
    ].join(" and ");
    const res = await axios.get(`${DRIVE_API}/files`, {
      headers: await this.headers(),
      params: {
        q,
        corpora: "drive",
        driveId: driveSharedDriveId(),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: "files(id,name,webViewLink)",
        pageSize: 1,
      },
    });
    return res.data.files?.[0] ?? null;
  }

  async createFolder(parentId: string, name: string): Promise<DriveFile> {
    const res = await axios.post(
      `${DRIVE_API}/files`,
      { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
      {
        headers: await this.headers(),
        params: { supportsAllDrives: true, fields: "id,name,webViewLink" },
      }
    );
    return res.data;
  }

  /** Idempotente: si ya existe con ese nombre, la reusa (evita duplicados). */
  async ensureFolder(parentId: string, name: string): Promise<DriveFile> {
    const existing = await this.findChildFolder(parentId, name);
    return existing ?? (await this.createFolder(parentId, name));
  }

  /**
   * "Cualquiera con el enlace puede ver". Se aplica UNA vez sobre la carpeta
   * del cliente; meses y archivos heredan. El cliente conserva acceso aunque
   * deje de trabajar con Bakano (las carpetas nunca se borran).
   */
  async setAnyoneReader(fileId: string): Promise<void> {
    await axios.post(
      `${DRIVE_API}/files/${fileId}/permissions`,
      { role: "reader", type: "anyone" },
      { headers: await this.headers(), params: { supportsAllDrives: true } }
    );
  }

  /**
   * Crea la sesion resumable y devuelve la URL de subida. `origin` es el
   * origen de la pagina que va a subir: Google habilita CORS de la sesion
   * contra ese origen, sin el las PUT del navegador fallan.
   */
  async createResumableSession(input: {
    parentId: string;
    name: string;
    mimeType: string;
    size: number;
    origin?: string;
  }): Promise<string> {
    const res = await axios.post(
      `${DRIVE_UPLOAD_API}/files`,
      { name: input.name, parents: [input.parentId] },
      {
        headers: {
          ...(await this.headers()),
          "Content-Type": "application/json",
          "X-Upload-Content-Type": input.mimeType,
          "X-Upload-Content-Length": String(input.size),
          ...(input.origin ? { Origin: input.origin } : {}),
        },
        params: { uploadType: "resumable", supportsAllDrives: true },
      }
    );
    const location = res.headers["location"];
    if (!location) throw new Error("DRIVE_NO_SESSION");
    return location;
  }

  /** Re-subida: reemplaza el contenido del mismo fileId, no duplica. */
  async createReplaceSession(input: {
    fileId: string;
    mimeType: string;
    size: number;
    name?: string;
    origin?: string;
  }): Promise<string> {
    const res = await axios.patch(
      `${DRIVE_UPLOAD_API}/files/${input.fileId}`,
      input.name ? { name: input.name } : {},
      {
        headers: {
          ...(await this.headers()),
          "Content-Type": "application/json",
          "X-Upload-Content-Type": input.mimeType,
          "X-Upload-Content-Length": String(input.size),
          ...(input.origin ? { Origin: input.origin } : {}),
        },
        params: { uploadType: "resumable", supportsAllDrives: true },
      }
    );
    const location = res.headers["location"];
    if (!location) throw new Error("DRIVE_NO_SESSION");
    return location;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const res = await axios.get(`${DRIVE_API}/files/${fileId}`, {
      headers: await this.headers(),
      params: { supportsAllDrives: true, fields: "id,name,mimeType,size,parents,webViewLink" },
    });
    return res.data;
  }
}

export const googleDriveService = new GoogleDriveService();
