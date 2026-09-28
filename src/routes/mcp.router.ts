import express, { Router, type Request, type Response } from "express";
import cors from "cors";
import { mcpAuthService, McpAuthError, urlPublica } from "../mcp/auth.service";

/**
 * MCP del equipo interno + su OAuth con enlace mágico.
 *
 * Todo esto se monta en la raíz (no en /api) porque los clientes MCP buscan
 * /.well-known/... y /mcp donde dice el estándar. mcp.bakano.ec reenvía estas
 * rutas a este backend, así la dirección que la gente pega en Claude es corta.
 *
 * CORS abierto: aquí no hay cookies, todo va con Bearer, y el inspector de MCP
 * o claude.ai pueden llamar desde el navegador.
 */
export const RUTAS_MCP = /^\/(mcp|oauth|\.well-known\/oauth-)/;

const router = Router();
// El router se monta en la raíz: sin este filtro el CORS abierto le tocaría también a /api.
const corsAbierto = cors({ origin: true, exposedHeaders: ["WWW-Authenticate", "Mcp-Session-Id"] });
const formulario = express.urlencoded({ extended: false });
router.use((req, res, next) => {
  if (!RUTAS_MCP.test(req.path)) return next("router");
  corsAbierto(req, res, () => formulario(req, res, next));
});

function fallo(res: Response, error: unknown) {
  if (error instanceof McpAuthError) {
    res.status(error.status).json({ error: error.codigo, error_description: error.message });
    return;
  }
  console.error("[mcp] error:", error);
  res.status(500).json({ error: "server_error", error_description: "Algo falló de nuestro lado. Intenta otra vez." });
}

// ── Descubrimiento ────────────────────────────────────────────────────────
router.get(["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"], (_req, res) => {
  res.json(mcpAuthService.metadatosServidor());
});
router.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req, res) => {
  res.json(mcpAuthService.metadatosRecurso());
});

// ── OAuth para Claude ────────────────────────────────────────────────────
router.post("/oauth/register", async (req, res) => {
  try {
    res.status(201).json(await mcpAuthService.registrar(req.body));
  } catch (e) {
    fallo(res, e);
  }
});

router.get("/oauth/authorize", async (req, res) => {
  try {
    res.redirect(302, await mcpAuthService.autorizar(req.query as Record<string, unknown>));
  } catch (e) {
    const msg = e instanceof McpAuthError ? e.message : "No se pudo empezar la entrada.";
    res.redirect(302, `${urlPublica()}/entrar?error=${encodeURIComponent(msg)}`);
  }
});

router.post("/oauth/token", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await mcpAuthService.token(req.body || {}));
  } catch (e) {
    fallo(res, e);
  }
});

router.post("/oauth/revoke", async (req, res) => {
  await mcpAuthService.revocar(req.body?.token).catch(() => {});
  res.status(200).json({});
});

// ── Pantallas de mcp.bakano.ec (entrar / confirmar) ──────────────────────
router.get("/oauth/solicitud/:id", async (req, res) => {
  try {
    res.json(await mcpAuthService.verSolicitud(req.params.id));
  } catch (e) {
    fallo(res, e);
  }
});

router.post("/oauth/solicitud/:id/enlace", async (req, res) => {
  try {
    res.json(await mcpAuthService.enviarEnlace(req.params.id, req.body?.email));
  } catch (e) {
    fallo(res, e);
  }
});

router.post("/oauth/solicitud/:id/sondeo", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json(await mcpAuthService.sondear(req.params.id, req.body?.sondeo));
  } catch (e) {
    fallo(res, e);
  }
});

router.get("/oauth/enlace", async (req, res) => {
  try {
    const { solicitud, app } = await mcpAuthService.verEnlace(String(req.query.t || ""));
    res.json({ codigo: solicitud.codigoVisual, email: solicitud.email, app, estado: solicitud.estado });
  } catch (e) {
    fallo(res, e);
  }
});

router.post("/oauth/enlace", async (req, res) => {
  try {
    res.json(await mcpAuthService.confirmarEnlace(String(req.body?.t || "")));
  } catch (e) {
    fallo(res, e);
  }
});

// ── El MCP ────────────────────────────────────────────────────────────────
function pedirLogin(res: Response) {
  res
    .status(401)
    .setHeader(
      "WWW-Authenticate",
      `Bearer resource_metadata="${urlPublica()}/.well-known/oauth-protected-resource/mcp"`
    )
    .json({ jsonrpc: "2.0", error: { code: -32001, message: "Entra con tu correo de Bakano." }, id: null });
}

async function atenderMcp(req: Request, res: Response) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const usuario = await mcpAuthService.usuarioDelToken(token).catch(() => null);
  if (!usuario) return pedirLogin(res);

  // Import diferido: si algo del SDK fallara al cargar, cae solo /mcp, no toda la API.
  const { atender } = await import("../mcp/server");
  await atender(req, res, usuario);
}

router.post("/mcp", (req, res) => {
  atenderMcp(req, res).catch((e) => {
    console.error("[mcp] error atendiendo:", e);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Error interno" }, id: null });
    }
  });
});

// Sin sesiones: no hay stream de servidor que abrir ni sesión que cerrar.
router.get("/mcp", (req, res) => {
  if (!req.headers.authorization) return pedirLogin(res);
  res.status(405).setHeader("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Usa POST." }, id: null });
});
router.delete("/mcp", (_req, res) => {
  res.status(405).setHeader("Allow", "POST").end();
});

export default router;
