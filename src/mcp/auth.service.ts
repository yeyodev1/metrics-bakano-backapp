import crypto from "crypto";
import models from "../models";
import { McpClienteModel, McpSesionModel, McpSolicitudModel } from "../models/mcp.model";
import { ResendService } from "../services/resend.service";
import { perfilDe, type UsuarioMcp } from "./perfiles";

/**
 * OAuth 2.1 del MCP con enlace mágico, sin contraseñas.
 *
 * 1. Claude se registra (/oauth/register) y abre /oauth/authorize.
 * 2. Eso crea una solicitud y manda al navegador a mcp.bakano.ec/entrar.
 * 3. La persona pone su correo; le llega un enlace con un código corto que
 *    también ve en pantalla.
 * 4. Toca "conectar" en el correo (sirve desde el celular).
 * 5. La pestaña del paso 2, que estaba esperando, recoge el código de
 *    autorización y vuelve a Claude. Claude lo cambia por un token.
 *
 * El código solo lo recoge la pestaña que empezó (tiene el secreto de sondeo),
 * así un enlace reenviado o abierto por un antivirus no le da acceso a nadie.
 */

const SOLICITUD_TTL_MS = 20 * 60_000;
const ENLACE_TTL_MIN = 15;
const ENTRE_ENLACES_MS = 45_000;
const MAX_ENLACES = 5;
const ACCESS_TTL_MS = 7 * 24 * 3_600_000;
const REFRESH_TTL_MS = 90 * 24 * 3_600_000;

const resend = new ResendService();

export class McpAuthError extends Error {
  constructor(
    public codigo: string,
    mensaje: string,
    public status = 400
  ) {
    super(mensaje);
  }
}

function sha(valor: string): string {
  return crypto.createHash("sha256").update(valor).digest("hex");
}

function aleatorio(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

/** Tres letras y tres números, sin letras que se confundan. */
function codigoVisual(): string {
  const letras = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const l = Array.from({ length: 3 }, () => letras[crypto.randomInt(letras.length)]).join("");
  return `${l}-${crypto.randomInt(100, 1000)}`;
}

function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Dirección pública del MCP (el front la reenvía a este backend). */
export function urlPublica(): string {
  return (process.env.MCP_PUBLIC_URL || "https://mcp.bakano.ec").replace(/\/+$/, "");
}

/** Donde vive la guía y la pantalla de entrada. En local puede ser otro puerto. */
function urlGuia(): string {
  return (process.env.MCP_GUIA_URL || urlPublica()).replace(/\/+$/, "");
}

/** Claude Code usa localhost con puerto variable; el resto, https. */
function redirectValida(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

export const mcpAuthService = {
  metadatosServidor() {
    const base = urlPublica();
    return {
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["bakano"],
    };
  },

  metadatosRecurso() {
    const base = urlPublica();
    return {
      resource: `${base}/mcp`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      resource_name: "Bakano · MCP del equipo",
      resource_documentation: base,
    };
  },

  /** Registro dinámico (RFC 7591). Cliente público: sin secreto, con PKCE. */
  async registrar(body: any) {
    const redirectUris: string[] = Array.isArray(body?.redirect_uris) ? body.redirect_uris.map(String) : [];
    if (!redirectUris.length || !redirectUris.every(redirectValida)) {
      throw new McpAuthError("invalid_redirect_uri", "redirect_uris inválidas.");
    }
    const nombre = String(body?.client_name || "Claude").slice(0, 80);
    const clientId = `bk_${aleatorio(18)}`;
    await McpClienteModel.create({ clientId, nombre, redirectUris });
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: nombre,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  },

  /** Valida el pedido de Claude y devuelve a dónde mandar el navegador. */
  async autorizar(q: Record<string, unknown>): Promise<string> {
    const clientId = String(q.client_id || "");
    const redirectUri = String(q.redirect_uri || "");
    const cliente = await McpClienteModel.findOne({ clientId }).lean();
    if (!cliente) throw new McpAuthError("invalid_client", "Esta app no está registrada. Vuelve a conectar desde Claude.");
    if (!cliente.redirectUris.includes(redirectUri)) {
      throw new McpAuthError("invalid_request", "La dirección de regreso no coincide con la registrada.");
    }
    if (q.response_type !== "code") throw new McpAuthError("unsupported_response_type", "Solo response_type=code.");
    if (!q.code_challenge || q.code_challenge_method !== "S256") {
      throw new McpAuthError("invalid_request", "Falta PKCE (S256).");
    }
    const solicitud = await McpSolicitudModel.create({
      clientId,
      redirectUri,
      state: q.state ? String(q.state) : undefined,
      codeChallenge: String(q.code_challenge),
      resource: q.resource ? String(q.resource) : undefined,
      codigoVisual: codigoVisual(),
      expiraEn: new Date(Date.now() + SOLICITUD_TTL_MS),
    });
    return `${urlGuia()}/entrar?solicitud=${solicitud._id}`;
  },

  async solicitudVigente(id: string) {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new McpAuthError("not_found", "Solicitud inválida.", 404);
    const s = await McpSolicitudModel.findById(id).select("+sondeoHash +enlaceHash +codeHash");
    if (!s) throw new McpAuthError("not_found", "Solicitud inválida.", 404);
    if (s.expiraEn < new Date()) throw new McpAuthError("expired", "Esta entrada venció. Vuelve a conectar desde Claude.", 410);
    return s;
  },

  /** Lo que ve la pantalla de entrada antes de poner el correo. */
  async verSolicitud(id: string) {
    const s = await this.solicitudVigente(id);
    const cliente = await McpClienteModel.findOne({ clientId: s.clientId }).lean();
    return { app: cliente?.nombre || "Claude", estado: s.estado, expiraEn: s.expiraEn };
  },

  /** Paso 3: manda el enlace. Solo equipo interno activo. */
  async enviarEnlace(id: string, correo: string) {
    const s = await this.solicitudVigente(id);
    if (s.estado === "aprobada" || s.estado === "entregada") {
      throw new McpAuthError("done", "Esta entrada ya se confirmó.", 409);
    }
    const email = String(correo || "").toLowerCase().trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new McpAuthError("invalid_email", "Escribe un correo válido.");

    const user = await models.users.findOne({ email }).select("name email role isInternal internalRole isActive").lean();
    if (!user || !perfilDe(user)) {
      throw new McpAuthError("not_internal", "Ese correo no es del equipo interno de Bakano. Usa el mismo con el que entras a metrics.bakano.ec.", 403);
    }
    if (s.enlaceEnviadoEn && Date.now() - s.enlaceEnviadoEn.getTime() < ENTRE_ENLACES_MS) {
      throw new McpAuthError("too_soon", "Ya te mandamos el enlace. Espera unos segundos antes de pedir otro.", 429);
    }
    if (s.enlacesEnviados >= MAX_ENLACES) {
      throw new McpAuthError("too_many", "Demasiados intentos. Vuelve a conectar desde Claude.", 429);
    }

    const enlace = aleatorio();
    const sondeo = aleatorio();
    s.email = email;
    s.userId = user._id as any;
    s.enlaceHash = sha(enlace);
    s.sondeoHash = sha(sondeo);
    s.enlaceEnviadoEn = new Date();
    s.enlacesEnviados += 1;
    s.estado = "enviada";
    await s.save();

    const cliente = await McpClienteModel.findOne({ clientId: s.clientId }).lean();
    await resend.sendMcpMagicLink({
      to: email,
      recipientName: user.name,
      enlace: `${urlGuia()}/confirmar?t=${enlace}`,
      codigo: s.codigoVisual,
      cliente: escaparHtml(cliente?.nombre || "Claude"),
      expiresInMinutes: ENLACE_TTL_MIN,
    });

    return { sondeo, codigo: s.codigoVisual };
  },

  /** La página de confirmación muestra el código antes de que toque el botón. */
  async verEnlace(enlace: string) {
    const s = await McpSolicitudModel.findOne({ enlaceHash: sha(String(enlace || "")) });
    if (!s || s.expiraEn < new Date()) throw new McpAuthError("expired", "Este enlace venció o ya se usó.", 410);
    const vencido = !s.enlaceEnviadoEn || Date.now() - s.enlaceEnviadoEn.getTime() > ENLACE_TTL_MIN * 60_000;
    if (vencido) throw new McpAuthError("expired", "Este enlace venció. Pide otro desde la pantalla de entrada.", 410);
    const cliente = await McpClienteModel.findOne({ clientId: s.clientId }).lean();
    return { solicitud: s, app: cliente?.nombre || "Claude" };
  },

  /** Paso 4: la persona tocó "conectar". Se hace con POST para que ningún antivirus lo dispare solo. */
  async confirmarEnlace(enlace: string) {
    const { solicitud: s, app } = await this.verEnlace(enlace);
    if (s.estado === "enviada") {
      s.estado = "aprobada";
      await s.save();
    }
    return { codigo: s.codigoVisual, email: s.email, app };
  },

  /** Paso 5: la pestaña que espera pregunta si ya puede volver a Claude. */
  async sondear(id: string, sondeo: string): Promise<{ estado: string; redirect?: string }> {
    const s = await this.solicitudVigente(id);
    if (!s.sondeoHash || s.sondeoHash !== sha(String(sondeo || ""))) {
      throw new McpAuthError("forbidden", "Esta pestaña no empezó la entrada.", 403);
    }
    if (s.estado !== "aprobada") return { estado: s.estado };

    const code = aleatorio();
    s.codeHash = sha(code);
    s.estado = "entregada";
    await s.save();

    const url = new URL(s.redirectUri);
    url.searchParams.set("code", code);
    if (s.state) url.searchParams.set("state", s.state);
    return { estado: "entregada", redirect: url.toString() };
  },

  async emitirSesion(userId: string, clientId: string) {
    const access = `bka_${aleatorio()}`;
    const refresh = `bkr_${aleatorio()}`;
    await McpSesionModel.create({
      userId,
      clientId,
      accessHash: sha(access),
      accessExpira: new Date(Date.now() + ACCESS_TTL_MS),
      refreshHash: sha(refresh),
      refreshExpira: new Date(Date.now() + REFRESH_TTL_MS),
    });
    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: "bakano",
    };
  },

  /** /oauth/token: cambia el código por tokens, o rota el refresh. */
  async token(body: Record<string, unknown>) {
    const grant = String(body.grant_type || "");
    const clientId = String(body.client_id || "");

    if (grant === "authorization_code") {
      const code = String(body.code || "");
      const s = await McpSolicitudModel.findOne({ codeHash: sha(code) }).select("+codeHash");
      if (!s || s.codeUsado || s.expiraEn < new Date() || !s.userId) {
        throw new McpAuthError("invalid_grant", "Código inválido o vencido.");
      }
      if (s.clientId !== clientId || s.redirectUri !== String(body.redirect_uri || "")) {
        throw new McpAuthError("invalid_grant", "El código no es de esta app.");
      }
      const verifier = String(body.code_verifier || "");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      if (!verifier || challenge !== s.codeChallenge) throw new McpAuthError("invalid_grant", "PKCE no coincide.");
      // Se quema antes de emitir: un código repetido no da dos sesiones.
      const quemado = await McpSolicitudModel.updateOne({ _id: s._id, codeUsado: false }, { $set: { codeUsado: true } });
      if (!quemado.modifiedCount) throw new McpAuthError("invalid_grant", "Código ya usado.");
      return this.emitirSesion(String(s.userId), clientId);
    }

    if (grant === "refresh_token") {
      const refresh = String(body.refresh_token || "");
      const sesion = await McpSesionModel.findOneAndUpdate(
        { refreshHash: sha(refresh), revocada: false, refreshExpira: { $gt: new Date() } },
        { $set: { revocada: true } }
      );
      if (!sesion || (clientId && sesion.clientId !== clientId)) throw new McpAuthError("invalid_grant", "Sesión vencida. Vuelve a entrar.");
      const user = await models.users.findById(sesion.userId).select("role isInternal internalRole isActive").lean();
      if (!user || !perfilDe(user)) throw new McpAuthError("invalid_grant", "Tu usuario ya no tiene acceso al MCP.");
      return this.emitirSesion(String(sesion.userId), sesion.clientId);
    }

    throw new McpAuthError("unsupported_grant_type", "grant_type no soportado.");
  },

  async revocar(token: string) {
    const h = sha(String(token || ""));
    await McpSesionModel.updateMany({ $or: [{ accessHash: h }, { refreshHash: h }] }, { $set: { revocada: true } });
  },

  /**
   * Quién está detrás de un token. El rol se lee de la base en cada llamada:
   * si a alguien le cambian el rol o lo desactivan, el MCP se entera al toque.
   */
  async usuarioDelToken(token: string): Promise<UsuarioMcp | null> {
    if (!token) return null;
    const sesion = await McpSesionModel.findOne({
      accessHash: sha(token),
      revocada: false,
      accessExpira: { $gt: new Date() },
    }).lean();
    if (!sesion) return null;
    const user = await models.users
      .findById(sesion.userId)
      .select("name lastName email role isInternal internalRole isActive")
      .lean();
    if (!user) return null;
    const perfil = perfilDe(user);
    if (!perfil) return null;
    McpSesionModel.updateOne({ _id: sesion._id }, { $set: { ultimoUso: new Date() } }).catch(() => {});
    return {
      _id: String(user._id),
      email: user.email,
      nombre: [user.name, user.lastName].filter(Boolean).join(" ") || user.email,
      role: user.role,
      isInternal: user.isInternal === true,
      internalRole: user.internalRole ?? null,
      perfil,
    };
  },
};
