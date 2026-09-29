import type { ToolMcp } from "./base";
import { toolsPendientes } from "./pendientes";
import { toolsComunes } from "./comunes";
import { toolsTelegram } from "./telegram";
import { toolsContenido } from "./contenido";
import { toolsOnboarding } from "./onboarding";
import { toolsEntornos } from "./entornos";
import { toolsCorreos } from "./correos";
import { toolsLucas } from "./lucas";
import { toolsClienteDirecto } from "./clienteDirecto";

/** Todas las tools del MCP. Cada una declara qué perfiles la ven. */
export const TOOLS: ToolMcp[] = [...toolsPendientes, ...toolsComunes, ...toolsTelegram, ...toolsContenido, ...toolsOnboarding, ...toolsEntornos, ...toolsCorreos, ...toolsLucas, ...toolsClienteDirecto];
