import { z } from "zod";
import { Types } from "mongoose";
import models from "../../models";
import { incidentesService } from "../../services/incidentes.service";
import type { PerfilMcp, UsuarioMcp } from "../perfiles";
import { fecha, recortar, resolverCliente, type ToolMcp } from "./base";

/**
 * Lo que los clientes hablan con @BakanoAgencyBot.
 *
 * PM y dirección ven todo. Contenido ve solo lo de guiones y videos: los
 * mensajes que hablan de eso y el borrador de correcciones. El resto de la
 * conversación (pagos, quejas de atención, citas) no le toca.
 */
const TELEGRAM: PerfilMcp[] = ["direccion", "pm", "contenido"];
const TEMA_CONTENIDO = /gui[oó]n|script|video|idea|grab|correc|reel|hook|gancho|copy|tema|contenido|publica/i;
const ANIMOS_MALOS = ["en_peligro", "angustiado", "molesto"];

function soloContenido(u: UsuarioMcp) {
  return u.perfil === "contenido";
}

function nombreChat(c: any): string {
  return [c.firstName, c.telegramUsername ? `@${c.telegramUsername}` : null].filter(Boolean).join(" ") || `chat ${c.chatId}`;
}

async function nombresDeEntornos(ids: any[]): Promise<Map<string, string>> {
  const ws = await models.workspaces.find({ _id: { $in: ids.filter(Boolean) } }).select("name").lean();
  return new Map(ws.map((w: any) => [String(w._id), w.name]));
}

export const toolsTelegram: ToolMcp[] = [
  {
    nombre: "conversaciones_telegram",
    titulo: "Conversaciones de clientes en Telegram",
    descripcion:
      "Chats de clientes con el bot de Telegram (@BakanoAgencyBot), los más recientes primero, con su ánimo y lo que quedó a medias (correcciones de guiones sin enviar, cambios de cita sin confirmar, archivos que el bot está esperando). Filtra por cliente, por ánimo en riesgo o por actividad reciente. Perfil Contenido: solo ve lo que tiene que ver con guiones y videos.",
    perfiles: TELEGRAM,
    entrada: {
      cliente: z.string().optional(),
      solo_en_riesgo: z.boolean().optional().describe("Solo chats cuyo último ánimo fue molesto, angustiado o en peligro"),
      horas: z.number().int().min(1).max(720).optional().describe("Solo chats con actividad en las últimas N horas (por defecto 72)"),
    },
    async correr(a, u) {
      const q: any = { estado: "listo" };
      if (a.cliente) q.workspaceId = (await resolverCliente(a.cliente))._id;
      else q.updatedAt = { $gte: new Date(Date.now() - (a.horas ?? 72) * 3_600_000) };
      if (a.solo_en_riesgo) q["ultimoAnimo.estado"] = { $in: ANIMOS_MALOS };
      const chats = await models.telegramChats.find(q).sort({ updatedAt: -1 }).limit(40).lean();
      const nombres = await nombresDeEntornos(chats.map((c: any) => c.workspaceId));
      const cm = soloContenido(u);

      const filas = chats
        .map((c: any) => {
          const historial = (c.historial || []).filter((m: any) => !cm || TEMA_CONTENIDO.test(m.texto || ""));
          const ultimo = historial[historial.length - 1];
          const fila: any = {
            cliente: nombres.get(String(c.workspaceId)) || "Sin entorno",
            quien: nombreChat(c),
            ultimaActividad: fecha(c.updatedAt),
            ultimoMensaje: ultimo ? { de: ultimo.rol, texto: recortar(ultimo.texto, 300), en: fecha(ultimo.en) } : null,
          };
          if (c.revisionGuiones?.correcciones?.length) {
            fila.correccionesSinEnviar = c.revisionGuiones.correcciones.length;
          }
          if (!cm) {
            if (c.ultimoAnimo) fila.animo = { estado: c.ultimoAnimo.estado, motivo: c.ultimoAnimo.motivo, en: fecha(c.ultimoAnimo.en) };
            if (c.cambioPendiente) fila.cambioDeCitaSinConfirmar = { accion: c.cambioPendiente.accion, resumen: c.cambioPendiente.resumen, desde: fecha(c.cambioPendiente.creadoEn) };
            if (c.archivoEsperado) fila.esperandoArchivo = c.archivoEsperado.categoria;
            if (c.datoEsperado) fila.esperandoDato = c.datoEsperado.campo;
          }
          return fila;
        })
        .filter((f) => !cm || f.ultimoMensaje || f.correccionesSinEnviar);
      return { total: filas.length, chats: filas };
    },
  },
  {
    nombre: "ver_conversacion_telegram",
    titulo: "Leer una conversación de Telegram",
    descripcion:
      "Los últimos mensajes entre un cliente y el bot de Telegram, en orden. El bot guarda los últimos ~20 turnos de cada chat (se borran cuando el cliente cambia de entorno). Perfil Contenido: solo los mensajes de guiones y videos, más el borrador de correcciones.",
    perfiles: TELEGRAM,
    entrada: { cliente: z.string() },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const chats = await models.telegramChats.find({ workspaceId: ws._id, estado: "listo" }).sort({ updatedAt: -1 }).lean();
      if (!chats.length) return `${ws.name} no tiene a nadie conectado al bot de Telegram en este momento.`;
      const cm = soloContenido(u);
      return {
        cliente: ws.name,
        chats: chats.map((c: any) => ({
          quien: nombreChat(c),
          ...(cm ? {} : { animo: c.ultimoAnimo ? { estado: c.ultimoAnimo.estado, motivo: c.ultimoAnimo.motivo, en: fecha(c.ultimoAnimo.en) } : null }),
          correccionesSinEnviar: (c.revisionGuiones?.correcciones || []).map((x: any) => ({ video: x.numero, tema: x.tema, correccion: x.texto, categoria: x.categoria })),
          mensajes: (c.historial || [])
            .filter((m: any) => !cm || TEMA_CONTENIDO.test(m.texto || ""))
            .map((m: any) => ({ de: m.rol, texto: recortar(m.texto, 1500), en: fecha(m.en) })),
        })),
      };
    },
  },
  {
    nombre: "mensajes_de_clientes",
    titulo: "Mensajes que los clientes le dejaron al equipo",
    descripcion:
      "Lo que los clientes pidieron por Telegram que se le pase al equipo (producción, guiones o atención), con quién lo recibió. Por defecto los últimos 3 días.",
    perfiles: ["direccion", "pm", "contenido"],
    entrada: { dias: z.number().int().min(1).max(30).optional(), cliente: z.string().optional() },
    async correr(a, u) {
      const q: any = { type: "solicitud_cliente", createdAt: { $gte: new Date(Date.now() - (a.dias ?? 3) * 86_400_000) } };
      if (a.cliente) q.workspaceId = (await resolverCliente(a.cliente))._id;
      if (u.perfil === "contenido") q.title = /guiones/i;
      const filas = await models.notifications.find(q).sort({ createdAt: -1 }).limit(200).populate("userId", "name").lean();
      // Se crea una notificación por persona del equipo: se juntan por mensaje.
      const porMensaje = new Map<string, any>();
      for (const n of filas as any[]) {
        const clave = `${n.title}|${n.body}|${Math.floor(new Date(n.createdAt).getTime() / 60_000)}`;
        const actual = porMensaje.get(clave) ?? { titulo: n.title, mensaje: n.body, en: fecha(n.createdAt), recibieron: [], leido: false };
        actual.recibieron.push(n.userId?.name);
        actual.leido ||= n.isRead;
        porMensaje.set(clave, actual);
      }
      return { total: porMensaje.size, mensajes: [...porMensaje.values()] };
    },
  },
  {
    nombre: "incidentes",
    titulo: "Incidentes con clientes",
    descripcion:
      "Clientes que en Telegram sonaron molestos, angustiados o en peligro de irse. Por defecto los abiertos. Incluye la frase del cliente, el motivo y la recomendación.",
    perfiles: ["direccion", "pm"],
    entrada: {
      estado: z.enum(["abierto", "tomado", "cerrado", "todos"]).optional(),
      solo_mios: z.boolean().optional(),
      buscar: z.string().optional(),
    },
    async correr(a, u) {
      const r = await incidentesService.listar({ estado: a.estado ?? "abierto", mios: a.solo_mios, correo: u.email, buscar: a.buscar, limite: 30 });
      return {
        abiertos: r.abiertos,
        incidentes: r.incidentes.map((i: any) => ({
          id: String(i._id), cliente: i.workspaceName, gravedad: i.gravedad, estado: i.estado, tema: i.tema,
          frase: i.frase, motivo: i.motivo, recomendacion: i.recomendacion, responsable: i.responsableNombre,
          tomadoPor: i.tomadoPor?.nombre, en: fecha(i.createdAt),
        })),
      };
    },
  },
  {
    nombre: "incidente_tomar",
    titulo: "Hacerme cargo de un incidente",
    descripcion: "Te marca como responsable de un incidente abierto. Queda en la bitácora del incidente.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: { id: z.string() },
    async correr(a, u) {
      await incidentesService.tomar(a.id, { _id: new Types.ObjectId(u._id), name: u.nombre, email: u.email });
      return "Listo, el incidente quedó a tu nombre.";
    },
  },
  {
    nombre: "incidente_cerrar",
    titulo: "Cerrar un incidente",
    descripcion: "Cierra un incidente con una nota de cómo se resolvió. Queda en la bitácora.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: { id: z.string(), nota: z.string().min(3).describe("Cómo se resolvió") },
    async correr(a, u) {
      await incidentesService.cerrar(a.id, { _id: new Types.ObjectId(u._id), name: u.nombre, email: u.email }, a.nota);
      return "Incidente cerrado.";
    },
  },
];
