import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpAuditoriaModel } from "../models/mcp.model";
import { NOMBRE_PERFIL, type UsuarioMcp } from "./perfiles";
import { TOOLS } from "./tools/index";

/**
 * Un servidor por llamada, sin sesión (serverless): se arma con las tools que
 * le tocan al perfil de quien llama y se descarta al responder.
 */
function instrucciones(u: UsuarioMcp): string {
  return [
    `MCP del equipo interno de Bakano. Estás hablando con ${u.nombre} (${u.email}), perfil ${NOMBRE_PERFIL[u.perfil]}.`,
    "Solo ves las herramientas de su perfil: si algo no aparece, no le toca; dilo así y sugiere a quién pedírselo.",
    "Los datos son en vivo (Mongo de producción y CRM). Las herramientas que escriben avisan al cliente o al equipo igual que la plataforma: confirma con la persona antes de usarlas.",
    "Para saber qué hay que atender, empieza por `que_hay_pendiente`. Las fechas van en hora de Ecuador (America/Guayaquil).",
    "Responde en español, directo y corto.",
  ].join("\n");
}

function resumirArgs(args: unknown): string {
  try {
    return JSON.stringify(args ?? {}).slice(0, 4000);
  } catch {
    return "";
  }
}

export function crearServidor(u: UsuarioMcp): McpServer {
  const server = new McpServer(
    { name: "bakano", title: "Bakano · Equipo", version: "1.0.0" },
    { instructions: instrucciones(u) }
  );

  for (const tool of TOOLS) {
    if (!tool.perfiles.includes(u.perfil)) continue;
    server.registerTool(
      tool.nombre,
      {
        title: tool.titulo,
        description: tool.descripcion,
        inputSchema: tool.entrada,
        annotations: { readOnlyHint: !tool.escribe, destructiveHint: false, openWorldHint: false },
      },
      async (args: any) => {
        const inicio = Date.now();
        try {
          const resultado = await tool.correr(args ?? {}, u);
          McpAuditoriaModel.create({
            userId: u._id, email: u.email, perfil: u.perfil, tool: tool.nombre,
            args: resumirArgs(args), ok: true, ms: Date.now() - inicio,
          }).catch(() => {});
          const texto = typeof resultado === "string" ? resultado : JSON.stringify(resultado, null, 1);
          return { content: [{ type: "text" as const, text: texto }] };
        } catch (error: any) {
          const mensaje = error?.message || String(error);
          McpAuditoriaModel.create({
            userId: u._id, email: u.email, perfil: u.perfil, tool: tool.nombre,
            args: resumirArgs(args), ok: false, error: mensaje.slice(0, 1000), ms: Date.now() - inicio,
          }).catch(() => {});
          return { isError: true, content: [{ type: "text" as const, text: `No se pudo: ${mensaje}` }] };
        }
      }
    );
  }
  return server;
}

export async function atender(req: Request, res: Response, u: UsuarioMcp): Promise<void> {
  const server = crearServidor(u);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on("close", () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req as any, res as any, req.body);
}
