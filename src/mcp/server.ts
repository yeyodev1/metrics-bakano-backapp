import type { Request, Response } from "express";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpAuditoriaModel } from "../models/mcp.model";
import { NOMBRE_PERFIL, type UsuarioMcp } from "./perfiles";
import { TOOLS } from "./tools/index";
import { leToca } from "./tools/base";

/**
 * Un servidor por llamada, sin sesión (serverless): se arma con las tools que
 * le tocan al perfil de quien llama y se descarta al responder.
 */
function instrucciones(u: UsuarioMcp): string {
  return [
    `MCP del equipo interno de Bakano. Estás hablando con ${u.nombre} (${u.email}), perfil ${NOMBRE_PERFIL[u.perfil]}.`,
    "Solo ves las herramientas de su perfil: si algo no aparece, no le toca; dilo así y sugiere a quién pedírselo.",
    "Los datos son en vivo (Mongo de producción y CRM). Las herramientas que escriben avisan al cliente o al equipo igual que la plataforma: confirma con la persona antes de usarlas.",
    "Antes de hacer algo que pide o que toca a un cliente, mira su estado (buscar_clientes o ver_cliente): si está pausado o con el contrato finalizado, díselo a la persona con el motivo antes de seguir.",
    "La agenda oficial es el CRM de Bakano: para ver citas usa `calendario_crm` y las producciones se crean solo con `crear_produccion`. Nunca agendes, copies ni crees producciones o reuniones de clientes en Google Calendar, Outlook u otro calendario.",
    "Si `quien_soy` lista una herramienta que no tienes disponible, la conexión guardó la lista vieja: dile a la persona que desconecte y vuelva a conectar el conector de Bakano (no basta con apagarlo y prenderlo) y abra un chat nuevo. No busques otro camino.",
    "Para saber qué hay que atender, empieza por `que_hay_pendiente`. Las fechas van en hora de Ecuador (America/Guayaquil).",
    "Responde en español, directo y corto.",
  ].join("\n");
}

function resumirArgs(args: unknown): string {
  try {
    // Las contraseñas no quedan en la auditoría.
    return JSON.stringify(args ?? {}, (k, v) => (/contrasena|password/i.test(k) && v ? "***" : v)).slice(0, 4000);
  } catch {
    return "";
  }
}

/**
 * La versión cambia cuando cambia la lista de tools del perfil: le dice al
 * cliente (claude.ai) que lo que tiene guardado ya no es lo vigente.
 */
function version(u: UsuarioMcp): string {
  const nombres = TOOLS.filter((t) => leToca(t, u)).map((t) => t.nombre).join(",");
  return `1.0.0+${createHash("sha1").update(nombres).digest("hex").slice(0, 8)}`;
}

export function crearServidor(u: UsuarioMcp): McpServer {
  const server = new McpServer(
    { name: "bakano", title: "Bakano · Equipo", version: version(u) },
    { instructions: instrucciones(u) }
  );

  for (const tool of TOOLS) {
    if (!leToca(tool, u)) continue;
    server.registerTool(
      tool.nombre,
      {
        title: tool.titulo,
        description: tool.descripcion,
        inputSchema: tool.entrada,
        annotations: { readOnlyHint: !tool.escribe, destructiveHint: tool.destructiva === true, openWorldHint: false },
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
