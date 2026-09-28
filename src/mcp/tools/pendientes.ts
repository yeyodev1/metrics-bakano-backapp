import { z } from "zod";
import { Types } from "mongoose";
import models from "../../models";
import { PlanningService } from "../../services/planning.service";
import { VideoPlanningService } from "../../services/videoPlanning.service";
import { onboardingProgresoService } from "../../services/onboardingProgreso.service";
import { TODOS, type UsuarioMcp } from "../perfiles";
import { fecha, recortar, type ToolMcp } from "./base";

const planningService = new PlanningService();
const videoPlanningService = new VideoPlanningService();
const DIA = 86_400_000;

/**
 * "¿Qué hay pendiente?" en vivo, armado según el perfil de quien pregunta.
 * Cada sección es una consulta independiente: si una falla, el resto sale
 * igual y la que falló lo dice.
 */
async function seccion<T>(nombre: string, fn: () => Promise<T>): Promise<[string, T | { error: string }]> {
  try {
    return [nombre, await fn()];
  } catch (e: any) {
    return [nombre, { error: e?.message || String(e) }];
  }
}

async function nombres(ids: any[]): Promise<Map<string, string>> {
  const ws = await models.workspaces.find({ _id: { $in: ids.filter(Boolean) } }).select("name").lean();
  return new Map(ws.map((w: any) => [String(w._id), w.name]));
}

const secciones = {
  notificaciones: (u: UsuarioMcp) =>
    seccion("misNotificacionesSinLeer", async () => {
      const q = { userId: new Types.ObjectId(u._id), isRead: false };
      const [total, ultimas] = await Promise.all([
        models.notifications.countDocuments(q),
        models.notifications.find(q).sort({ createdAt: -1 }).limit(5).lean(),
      ]);
      return { total, ultimas: ultimas.map((n: any) => ({ titulo: n.title, en: fecha(n.createdAt) })) };
    }),

  incidentes: () =>
    seccion("incidentesAbiertos", async () => {
      const lista = await models.incidentes.find({ estado: { $in: ["abierto", "tomado"] } }).sort({ createdAt: -1 }).limit(20).lean();
      return lista.map((i: any) => ({ id: String(i._id), cliente: i.workspaceName, gravedad: i.gravedad, estado: i.estado, frase: recortar(i.frase, 200), tomadoPor: i.tomadoPor?.nombre, en: fecha(i.createdAt) }));
    }),

  telegramEnRiesgo: () =>
    seccion("clientesEnRiesgoEnTelegram", async () => {
      const chats = await models.telegramChats
        .find({ "ultimoAnimo.estado": { $in: ["en_peligro", "angustiado", "molesto"] }, "ultimoAnimo.en": { $gte: new Date(Date.now() - 7 * DIA) } })
        .select("workspaceId firstName ultimoAnimo")
        .lean();
      const n = await nombres(chats.map((c: any) => c.workspaceId));
      return chats.map((c: any) => ({ cliente: n.get(String(c.workspaceId)), quien: c.firstName, animo: c.ultimoAnimo.estado, motivo: c.ultimoAnimo.motivo, en: fecha(c.ultimoAnimo.en) }));
    }),

  telegramAMedias: (soloGuiones: boolean) =>
    seccion(soloGuiones ? "correccionesDeGuionesSinEnviar" : "telegramAMedias", async () => {
      const or: any[] = [{ "revisionGuiones.correcciones.0": { $exists: true } }];
      if (!soloGuiones) or.push({ cambioPendiente: { $exists: true } }, { archivoEsperado: { $exists: true } });
      const chats = await models.telegramChats.find({ estado: "listo", $or: or }).select("workspaceId firstName revisionGuiones cambioPendiente archivoEsperado updatedAt").lean();
      const n = await nombres(chats.map((c: any) => c.workspaceId));
      return chats.map((c: any) => ({
        cliente: n.get(String(c.workspaceId)),
        quien: c.firstName,
        correccionesSinEnviar: c.revisionGuiones?.correcciones?.length || undefined,
        ...(soloGuiones ? {} : { cambioDeCita: c.cambioPendiente?.resumen, esperandoArchivo: c.archivoEsperado?.categoria }),
        ultimaActividad: fecha(c.updatedAt),
      }));
    }),

  mensajesDeClientes: (soloGuiones: boolean) =>
    seccion("mensajesDeClientesUltimas48h", async () => {
      const q: any = { type: "solicitud_cliente", createdAt: { $gte: new Date(Date.now() - 2 * DIA) } };
      if (soloGuiones) q.title = /guiones/i;
      const filas = await models.notifications.aggregate([
        { $match: q },
        { $group: { _id: { t: "$title", b: "$body" }, en: { $max: "$createdAt" }, leido: { $max: "$isRead" } } },
        { $sort: { en: -1 } },
        { $limit: 15 },
      ]);
      return filas.map((f: any) => ({ titulo: f._id.t, mensaje: recortar(f._id.b, 280), en: fecha(f.en), alguienLoLeyo: f.leido }));
    }),

  onboarding: () =>
    seccion("onboardingTrabado", async () => {
      const lista = await onboardingProgresoService.resumen({});
      return lista
        .filter((p) => p.bloqueado || (p.porcentaje < 100 && (p.diasSinMover ?? 0) >= 7))
        .slice(0, 25)
        .map((p) => ({ cliente: p.entorno, bloqueado: p.bloqueado, motivo: p.motivoBloqueo, siguiente: p.siguiente, diasSinMover: p.diasSinMover }));
    }),

  produccionesProximas: (dias: number, conEstadoGuiones: boolean) =>
    seccion(`produccionesProximos${dias}Dias`, async () => {
      const desde = new Date();
      const entradas = await planningService.listEntriesAcross(null, desde, new Date(desde.getTime() + dias * DIA));
      const vps = await models.videoPlanning
        .find({ planningEntryId: { $in: entradas.map((e: any) => e._id) } })
        .select("planningEntryId listaParaCliente clienteAprobado items.clienteAprobacion")
        .lean();
      const porEntrada = new Map(vps.map((v: any) => [String(v.planningEntryId), v]));
      return entradas.map((e: any) => {
        const vp: any = porEntrada.get(String(e._id));
        const fila: any = { cliente: e.workspaceName, titulo: e.title, fecha: fecha(e.date) };
        if (conEstadoGuiones) {
          fila.guiones = !vp
            ? "SIN PLANIFICAR"
            : vp.clienteAprobado
              ? "aprobados por el cliente"
              : !vp.listaParaCliente
                ? "sin enviar al cliente"
                : `esperando al cliente (${vp.items.filter((i: any) => i.clienteAprobacion === "RECHAZADO").length} rechazados)`;
        }
        return fila;
      });
    }),

  guionesRechazados: () =>
    seccion("guionesRechazadosSinResolver", async () => {
      const desde = new Date(Date.now() - 3 * DIA);
      const entradas = await planningService.listEntriesAcross(null, desde, new Date(Date.now() + 45 * DIA));
      const vps = await models.videoPlanning
        .find({ planningEntryId: { $in: entradas.map((e: any) => e._id) }, "items.clienteAprobacion": "RECHAZADO" })
        .select("workspaceId items.numero items.tema items.clienteAprobacion items.motivoRechazo items.guionPorNombre")
        .lean();
      const n = await nombres(vps.map((v: any) => v.workspaceId));
      return vps.flatMap((v: any) =>
        v.items
          .filter((i: any) => i.clienteAprobacion === "RECHAZADO")
          .map((i: any) => ({ cliente: n.get(String(v.workspaceId)), video: i.numero, tema: i.tema, motivo: recortar(i.motivoRechazo, 200), autor: i.guionPorNombre }))
      );
    }),

  revisionVideos: () =>
    seccion("videosEditadosPorRevisar", async () => {
      const cola: any[] = (await videoPlanningService.getReviewQueue()).pendientes;
      const porCliente = new Map<string, number>();
      for (const c of cola) porCliente.set(c.workspaceName, (porCliente.get(c.workspaceName) ?? 0) + 1);
      return { total: cola.length, porCliente: Object.fromEntries(porCliente) };
    }),

  colaEdicion: (u: UsuarioMcp) =>
    seccion("miColaDeEdicion", async () => {
      const cola: any = await videoPlanningService.getEditorQueue(u._id);
      const cuenta = (x: any) => (Array.isArray(x) ? x.length : undefined);
      return { reEditar: cuenta(cola?.reEditar), porEditar: cuenta(cola?.porEditar), porSubirMaster: cuenta(cola?.porSubirMaster) };
    }),

  metaSinConectar: () =>
    seccion("clientesActivosSinMetaConectado", async () => {
      const ws = await models.workspaces.find({ isActive: { $ne: false }, $or: [{ "metaAds.adAccountId": { $exists: false } }, { "metaAds.adAccountId": null }, { "metaAds.adAccountId": "" }] }).select("name").limit(50).lean();
      return ws.map((w: any) => w.name);
    }),
};

export const toolsPendientes: ToolMcp[] = [
  {
    nombre: "que_hay_pendiente",
    titulo: "¿Qué hay pendiente?",
    descripcion:
      "Lo que hay que atender ahora mismo según tu perfil, en vivo: notificaciones sin leer, incidentes, clientes molestos en Telegram, correcciones o cambios de cita a medias en el bot, mensajes que dejaron los clientes, onboarding trabado, producciones próximas y el estado de sus guiones, guiones rechazados, videos por revisar o tu cola de edición. Empieza por aquí.",
    perfiles: TODOS,
    entrada: { dias: z.number().int().min(1).max(30).optional().describe("Ventana para producciones próximas (por defecto 7)") },
    async correr(a, u) {
      const dias = a.dias ?? 7;
      const tareas: Promise<[string, unknown]>[] = [secciones.notificaciones(u)];
      switch (u.perfil) {
        case "direccion":
          tareas.push(
            secciones.incidentes(), secciones.telegramEnRiesgo(), secciones.telegramAMedias(false), secciones.mensajesDeClientes(false),
            secciones.onboarding(), secciones.produccionesProximas(dias, true), secciones.guionesRechazados(), secciones.revisionVideos()
          );
          break;
        case "pm":
          tareas.push(
            secciones.incidentes(), secciones.telegramEnRiesgo(), secciones.telegramAMedias(false), secciones.mensajesDeClientes(false),
            secciones.onboarding(), secciones.produccionesProximas(dias, true)
          );
          break;
        case "contenido":
          tareas.push(
            secciones.telegramAMedias(true), secciones.mensajesDeClientes(true), secciones.guionesRechazados(),
            secciones.produccionesProximas(Math.max(dias, 14), true), secciones.revisionVideos()
          );
          break;
        case "produccion":
          tareas.push(secciones.produccionesProximas(dias, true));
          break;
        case "edicion":
          tareas.push(secciones.colaEdicion(u));
          break;
        case "campanas":
          tareas.push(secciones.metaSinConectar(), secciones.produccionesProximas(dias, false));
          break;
        default:
          tareas.push(secciones.produccionesProximas(dias, false));
      }
      return { para: u.nombre, alMomento: fecha(new Date()), ...Object.fromEntries(await Promise.all(tareas)) };
    },
  },
];
