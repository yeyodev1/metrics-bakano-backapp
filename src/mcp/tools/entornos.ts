import { z } from "zod";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import models from "../../models";
import { WorkspaceService } from "../../services/workspace.service";
import { fecha, resolverCliente, type ToolMcp } from "./base";

const workspaceService = new WorkspaceService();
const TOKEN_MIN = 5;

const MOTIVOS = ["falta_de_pago", "fin_de_contrato", "pausa_acordada", "otro"] as const;
const NOMBRE_MOTIVO: Record<(typeof MOTIVOS)[number], string> = {
  falta_de_pago: "Falta de pago",
  fin_de_contrato: "Fin de contrato",
  pausa_acordada: "Pausa acordada",
  otro: "Otro",
};

function secreto(): string {
  return `${process.env.JWT_SECRET || "default_jwt_secret_key"}:mcp-entornos`;
}

/** Los errores del service vienen en clave; aquí se dicen en palabras. */
function traducir(error: any): never {
  const m = error?.message;
  if (m === "WORKSPACE_NAME_TAKEN") throw new Error("Ya hay un entorno con ese nombre.");
  if (m === "NOT_FOUND" || m === "INVALID_ID") throw new Error("No encontré ese entorno.");
  if (m === "MOTIVO_REQUERIDO") throw new Error("Para pausar hace falta el motivo.");
  throw error;
}

function estado(ws: any) {
  return {
    id: String(ws._id),
    nombre: ws.name,
    activo: ws.isActive !== false,
    ...(ws.isActive === false && ws.desactivacion
      ? {
          pausa: {
            motivo: NOMBRE_MOTIVO[ws.desactivacion.motivo as keyof typeof NOMBRE_MOTIVO] ?? ws.desactivacion.motivo,
            nota: ws.desactivacion.nota,
            desde: fecha(ws.desactivacion.fecha),
            por: ws.desactivacion.porNombre,
          },
        }
      : {}),
  };
}

/**
 * Qué pasa si se borra: usuarios del cliente que se eliminan (los @bakano.ec
 * solo se desvinculan, igual que en la plataforma) y lo que queda huérfano,
 * porque deleteWorkspace no toca producciones, guiones ni chats.
 */
async function impactoDeBorrar(id: Types.ObjectId) {
  const deEste = { $or: [{ workspaceId: id }, { "workspaces.workspaceId": id }] };
  const [delCliente, delEquipo, producciones, planificaciones, chats] = await Promise.all([
    models.users.find({ ...deEste, email: { $not: /@bakano\.ec$/i } }).select("name email").lean(),
    models.users.countDocuments({ "workspaces.workspaceId": id, email: /@bakano\.ec$/i }),
    models.planning.countDocuments({ workspaceId: id }),
    models.videoPlanning.countDocuments({ workspaceId: id }),
    models.telegramChats.countDocuments({ workspaceId: id }),
  ]);
  return {
    usuariosQueSeBorran: delCliente.map((x: any) => `${x.name || "sin nombre"} <${x.email}>`),
    equipoQueSeDesvincula: delEquipo,
    quedanSinEntorno: { producciones, planificaciones, chatsTelegram: chats },
  };
}

export const toolsEntornos: ToolMcp[] = [
  {
    nombre: "crear_entorno",
    titulo: "Crear un entorno",
    descripcion:
      "Crea un entorno (cliente) nuevo, vacío y activo, con ese nombre. No invita a nadie ni manda correos: los usuarios se agregan en metrics.bakano.ec. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: { nombre: z.string().min(2).max(120) },
    async correr(a) {
      const ws = await workspaceService.createWorkspace({ name: a.nombre }).catch(traducir);
      return { creado: true, ...estado(ws), enlace: `https://metrics.bakano.ec/app/workspaces/${ws._id}` };
    },
  },
  {
    nombre: "editar_entorno",
    titulo: "Editar un entorno",
    descripcion:
      "Cambia el nombre de un entorno y, si está pausado, el motivo o la nota de la pausa. No avisa a nadie. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      cliente: z.string().describe("Nombre actual o id del entorno"),
      nuevo_nombre: z.string().min(2).max(120).optional(),
      motivo_pausa: z.enum(MOTIVOS).optional().describe("Solo si el entorno está pausado"),
      nota_pausa: z.string().max(500).optional().describe("Solo si el entorno está pausado"),
    },
    async correr(a, u) {
      if (!a.nuevo_nombre && !a.motivo_pausa && a.nota_pausa === undefined) throw new Error("Dime qué cambiar: nombre, motivo o nota de la pausa.");
      const ref = await resolverCliente(a.cliente);
      const antes: any = await models.workspaces.findById(ref._id).select("name isActive desactivacion").lean();
      if (!antes) throw new Error("No encontré ese entorno.");
      if ((a.motivo_pausa || a.nota_pausa !== undefined) && antes.isActive !== false) {
        throw new Error(`${antes.name} está activo: no tiene pausa que editar. Para pausarlo usa pausar_entorno.`);
      }
      if (a.nuevo_nombre) await workspaceService.updateWorkspaceName(String(ref._id), a.nuevo_nombre).catch(traducir);
      if (a.motivo_pausa || a.nota_pausa !== undefined) {
        // Se reescribe con toggle para que quede quién la tocó por última vez.
        await workspaceService
          .toggleWorkspaceActive(String(ref._id), false, {
            motivo: a.motivo_pausa ?? antes.desactivacion?.motivo ?? "otro",
            nota: a.nota_pausa ?? antes.desactivacion?.nota,
            porNombre: u.email,
          })
          .catch(traducir);
      }
      const despues = await models.workspaces.findById(ref._id).select("name isActive desactivacion").lean();
      return { editado: true, antes: estado(antes), ahora: estado(despues) };
    },
  },
  {
    nombre: "pausar_entorno",
    titulo: "Pausar un entorno",
    descripcion:
      "Desactiva un entorno con su motivo (falta_de_pago, fin_de_contrato, pausa_acordada, otro): el cliente deja de entrar a metrics.bakano.ec y el entorno sale de las listas de activos. No borra nada y se deshace con reanudar_entorno. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: {
      cliente: z.string().describe("Nombre o id del entorno"),
      motivo: z.enum(MOTIVOS),
      nota: z.string().max(500).optional(),
    },
    async correr(a, u) {
      const ref = await resolverCliente(a.cliente);
      const ws = await workspaceService
        .toggleWorkspaceActive(String(ref._id), false, { motivo: a.motivo, nota: a.nota, porNombre: u.email })
        .catch(traducir);
      return { pausado: true, ...estado(ws) };
    },
  },
  {
    nombre: "reanudar_entorno",
    titulo: "Reanudar un entorno",
    descripcion:
      "Vuelve a activar un entorno pausado: el cliente puede entrar de nuevo y se limpia el motivo de la pausa. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    entrada: { cliente: z.string().describe("Nombre o id del entorno") },
    async correr(a) {
      const ref = await resolverCliente(a.cliente);
      const antes: any = await models.workspaces.findById(ref._id).select("name isActive desactivacion").lean();
      if (antes?.isActive !== false) return { reanudado: false, motivo: `${ref.name} ya estaba activo.` };
      const ws = await workspaceService.toggleWorkspaceActive(String(ref._id), true).catch(traducir);
      return { reanudado: true, estabaPausadoPor: estado(antes).pausa, ...estado(ws) };
    },
  },
  {
    nombre: "consultar_eliminar_entorno",
    titulo: "Qué pasa si elimino un entorno",
    descripcion:
      "Paso 1 de 2 para eliminar un entorno. No borra nada: dice qué usuarios del cliente se borrarían, cuánta gente del equipo se desvincula y qué datos quedan sin entorno. Solo se puede eliminar un entorno ya pausado. Si se puede, devuelve un token de 5 minutos para eliminar_entorno. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    entrada: { cliente: z.string().describe("Nombre o id del entorno") },
    async correr(a, u) {
      const ref = await resolverCliente(a.cliente);
      const ws: any = await models.workspaces.findById(ref._id).select("name isActive desactivacion").lean();
      if (!ws) throw new Error("No encontré ese entorno.");
      const impacto = await impactoDeBorrar(ws._id);
      if (ws.isActive !== false) {
        return {
          ...estado(ws),
          permitido: false,
          motivo: "Está activo. Primero pausar_entorno; si igual se quiere borrar, se vuelve a consultar.",
          impacto,
        };
      }
      const token = jwt.sign({ w: String(ws._id), u: u._id }, secreto(), { expiresIn: `${TOKEN_MIN}m` });
      return {
        ...estado(ws),
        permitido: true,
        noSeDeshace: true,
        impacto,
        token,
        venceEn: `${TOKEN_MIN} minutos`,
        siguiente: `Muéstrale el impacto a la persona. Si confirma, eliminar_entorno con este token y confirmar_nombre="${ws.name}".`,
      };
    },
  },
  {
    nombre: "eliminar_entorno",
    titulo: "Eliminar un entorno (con token)",
    descripcion:
      "Paso 2 de 2: borra para siempre el entorno que aprobó consultar_eliminar_entorno, junto con los usuarios del cliente (los @bakano.ec solo se desvinculan). Pide el token y el nombre exacto del entorno. No se puede deshacer: confirma con la persona antes. Solo superadmin.",
    perfiles: ["direccion"],
    soloSuperadmin: true,
    escribe: true,
    destructiva: true,
    entrada: {
      token: z.string(),
      confirmar_nombre: z.string().describe("El nombre exacto del entorno, como confirmación"),
    },
    async correr(a, u) {
      let d: any;
      try {
        d = jwt.verify(a.token, secreto());
      } catch {
        throw new Error("El token venció o no es válido. Vuelve a consultar_eliminar_entorno.");
      }
      if (d.u !== u._id) throw new Error("Ese token es de otra persona.");
      const ws: any = await models.workspaces.findById(d.w).select("name isActive").lean();
      if (!ws) throw new Error("Ese entorno ya no existe.");
      if (String(a.confirmar_nombre).trim() !== ws.name) throw new Error(`El nombre no coincide. El entorno se llama "${ws.name}".`);
      // En 5 minutos alguien pudo reanudarlo: un entorno activo no se borra.
      if (ws.isActive !== false) throw new Error(`${ws.name} se reactivó mientras tanto. No se borró.`);
      const impacto = await impactoDeBorrar(ws._id);
      await workspaceService.deleteWorkspace(String(ws._id)).catch(traducir);
      return { eliminado: true, entorno: ws.name, id: String(ws._id), impacto };
    },
  },
];
