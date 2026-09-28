import { Router, type Response } from "express";
import { Types } from "mongoose";
import { HttpStatusCode } from "axios";
import { authMiddleware } from "../middlewares/auth.middleware";
import type { AuthRequest } from "../types/AuthRequest";
import models from "../models";
import { McpClienteModel, McpSesionModel } from "../models/mcp.model";
import { NOMBRE_PERFIL, perfilDe } from "../mcp/perfiles";
import { TOOLS } from "../mcp/tools/index";
import { urlPublica } from "../mcp/auth.service";

/**
 * La conexión con Claude vista desde metrics.bakano.ec: qué perfil tienes en
 * el MCP, qué puedes hacer y en qué apps estás conectado (para desconectarlas).
 */
const mcpCuentaRouter = Router();
mcpCuentaRouter.use(authMiddleware);

// GET /api/mcp/mi-conexion
mcpCuentaRouter.get("/mi-conexion", async (req: AuthRequest, res: Response) => {
  const user = await models.users.findById(req.user!._id).select("role isInternal internalRole isActive").lean();
  const perfil = user ? perfilDe(user) : null;
  if (!perfil) {
    res.status(HttpStatusCode.Forbidden).json({ message: "El MCP es solo para el equipo interno de Bakano." });
    return;
  }

  const sesiones = await McpSesionModel.find({
    userId: new Types.ObjectId(req.user!._id),
    revocada: false,
    refreshExpira: { $gt: new Date() },
  })
    .sort({ updatedAt: -1 })
    .lean();
  const apps = await McpClienteModel.find({ clientId: { $in: sesiones.map((s) => s.clientId) } }).lean();
  const nombreApp = new Map(apps.map((a) => [a.clientId, a.nombre]));

  // El refresh rota: cada app deja una sola sesión viva, la última.
  res.json({
    url: `${urlPublica()}/mcp`,
    guia: urlPublica(),
    perfil,
    perfilNombre: NOMBRE_PERFIL[perfil],
    herramientas: TOOLS.filter((t) => t.perfiles.includes(perfil)).map((t) => ({
      nombre: t.nombre,
      titulo: t.titulo,
      escribe: Boolean(t.escribe),
    })),
    conexiones: sesiones.map((s) => ({
      id: String(s._id),
      app: nombreApp.get(s.clientId) || "Claude",
      desde: s.createdAt,
      ultimoUso: s.ultimoUso ?? null,
    })),
  });
});

// DELETE /api/mcp/conexiones/:id — solo las tuyas.
mcpCuentaRouter.delete("/conexiones/:id", async (req: AuthRequest, res: Response) => {
  const { id } = req.params as { id: string };
  if (!Types.ObjectId.isValid(id)) {
    res.status(HttpStatusCode.BadRequest).json({ message: "Conexión inválida." });
    return;
  }
  const r = await McpSesionModel.updateOne(
    { _id: new Types.ObjectId(id), userId: new Types.ObjectId(req.user!._id) },
    { $set: { revocada: true } }
  );
  if (!r.matchedCount) {
    res.status(HttpStatusCode.NotFound).json({ message: "No encontré esa conexión." });
    return;
  }
  res.json({ ok: true });
});

export default mcpCuentaRouter;
