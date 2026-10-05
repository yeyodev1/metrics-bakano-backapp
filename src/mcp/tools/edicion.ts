import { z } from "zod";
import { Types } from "mongoose";
import models from "../../models";
import { VideoPlanningService } from "../../services/videoPlanning.service";
import { videoEntregaService, type ActorEntrega } from "../../services/videoEntrega.service";
import { formatoSegundo, rondasRestantes } from "../../services/correccionVideo.service";
import type { UsuarioMcp } from "../perfiles";
import { fecha, resolverCliente, type ToolMcp } from "./base";

/**
 * Videos por MCP: el editor dice cómo se llaman sus videos, el MCP los sube a
 * Drive (la carpeta del cliente y la planificación se arman solas), propone
 * qué video va con qué guion y conecta. Después el productor los revisa por
 * aquí mismo y, si confirma, le llega el aviso al cliente para que los revise.
 */

const videoPlanningService = new VideoPlanningService();
const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const MAX_LOTE = 30;

const TIPOS_VIDEO: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/x-m4v",
  mov: "video/quicktime",
  webm: "video/webm",
  avi: "video/x-msvideo",
  mkv: "video/x-matroska",
};

function actorDe(u: UsuarioMcp): ActorEntrega {
  return { id: u._id, nombre: u.nombre, internalRole: u.internalRole ?? undefined, role: u.role };
}

export function tipoDeVideo(nombre: string, tipo?: string): string | null {
  if (tipo && /^video\//.test(tipo)) return tipo;
  const ext = nombre.includes(".") ? nombre.split(".").pop()!.toLowerCase() : "";
  return TIPOS_VIDEO[ext] ?? null;
}

/** "archivo X → guion #3" a lo que entiende conectar(): número → itemId. */
export function asignacionesPorNumero(
  asignaciones: { archivo_id: string; numero: number }[],
  guiones: { itemId: string; numero: number }[]
): { itemId: string; fileId: string }[] {
  const faltan = asignaciones.filter((a) => !guiones.some((g) => g.numero === a.numero)).map((a) => `#${a.numero}`);
  if (faltan.length) throw new Error(`Esta planificación no tiene los guiones ${faltan.join(", ")}.`);
  return asignaciones.map((a) => ({ itemId: guiones.find((g) => g.numero === a.numero)!.itemId, fileId: a.archivo_id }));
}

type ItemRevision = {
  _id: unknown;
  numero: number;
  tema: string;
  edicion?: string;
  edicionRevisada?: boolean;
  videoClienteAprobacion?: string;
};

/**
 * Qué pasa si se aprueban esos números: cuáles se aprueban, cuáles no se
 * pueden y si con eso sale el aviso al cliente (mismo criterio que
 * avisarClienteSiTodoRevisado: ningún EDITADO esperando revisión interna y
 * alguno esperando al cliente).
 */
export function previsualizarAprobacion(items: ItemRevision[], numeros: number[]) {
  const aprobar: ItemRevision[] = [];
  const noSePueden: { numero: number; motivo: string }[] = [];
  for (const n of [...new Set(numeros)]) {
    const item = items.find((i) => i.numero === n);
    if (!item) noSePueden.push({ numero: n, motivo: "No está en esta planificación." });
    else if (item.edicion !== "EDITADO") noSePueden.push({ numero: n, motivo: "Todavía no está editado." });
    else if (item.edicionRevisada !== false) noSePueden.push({ numero: n, motivo: "Ya pasó la revisión interna." });
    else aprobar.push(item);
  }
  const ids = new Set(aprobar.map((i) => String(i._id)));
  const editados = items.filter((i) => i.edicion === "EDITADO");
  const faltan = editados.filter((i) => i.edicionRevisada === false && !ids.has(String(i._id)));
  const esperanCliente = editados.some((i) => !i.videoClienteAprobacion || i.videoClienteAprobacion === "PENDIENTE");
  return {
    aprobar,
    noSePueden,
    faltanPorRevisar: faltan.map((i) => ({ numero: i.numero, tema: i.tema })),
    saleAlCliente: aprobar.length > 0 && !faltan.length && esperanCliente,
  };
}

/** El editor solo sube a planificaciones de sus clientes (las que le lista Metrics). */
async function planificacionPermitida(planningId: string, u: UsuarioMcp) {
  if (!Types.ObjectId.isValid(planningId)) throw new Error("planning_id inválido (sale de planificaciones_para_subir).");
  const lista = await videoEntregaService.planificaciones(actorDe(u));
  const p = lista.find((x) => x.planningId === planningId);
  if (!p) throw new Error("Esa planificación no está entre las tuyas de estas semanas. Búscala con planificaciones_para_subir.");
  return p;
}

async function itemsDe(planningId: string) {
  if (!Types.ObjectId.isValid(planningId)) throw new Error("planning_id inválido.");
  const vp = await models.videoPlanning
    .findById(planningId)
    .select("workspaceId items._id items.numero items.tema items.edicion items.edicionRevisada items.videoClienteAprobacion items.driveLink items.editorPorNombre items.rondasUsadas items.correccionesVideo")
    .populate("workspaceId", "name")
    .lean();
  if (!vp) throw new Error("No encontré esa planificación.");
  return vp as any;
}

export const toolsEdicion: ToolMcp[] = [
  {
    nombre: "planificaciones_para_subir",
    titulo: "Planificaciones para subir videos",
    descripcion:
      "Planificaciones de estas semanas con sus guiones (#número, tema, estado de edición, versiones, rondas del cliente y los cambios que pidió con su segundo). De aquí sale el planning_id para subir_videos y conectar_videos.",
    perfiles: ["edicion", "produccion", "pm", "direccion"],
    entrada: { cliente: z.string().optional() },
    async correr(a, u) {
      let lista = await videoEntregaService.planificaciones(actorDe(u));
      if (a.cliente) {
        const ws = await resolverCliente(a.cliente);
        lista = lista.filter((p) => p.workspaceId === String(ws._id));
      }
      return {
        total: lista.length,
        planificaciones: lista.slice(0, 25).map((p) => ({
          planning_id: p.planningId,
          cliente: p.workspaceName,
          titulo: p.titulo,
          fecha: fecha(p.fecha, false),
          carpeta: p.carpetaLink,
          guiones: p.items.map((i) => ({
            numero: i.numero,
            tema: i.tema,
            edicion: i.edicion,
            versiones: i.versiones,
            rondasClienteRestantes: i.rondasRestantes,
            ...(i.correcciones.length ? { cambiosPedidos: i.correcciones } : {}),
          })),
        })),
      };
    },
  },
  {
    nombre: "subir_videos",
    titulo: "Subir videos a la planificación",
    descripcion:
      "Prepara la subida de videos a la carpeta de Drive del cliente y la planificación (se crea sola: el editor nunca entra a Drive). " +
      "Pásale el nombre y el tamaño en bytes de cada archivo (máx. 30 por vez). Devuelve, por archivo, un comando curl que sube el video directo desde la computadora del editor. " +
      "Cómo usarla: 1) saca el tamaño con `stat -f%z \"ruta\"` (macOS) o `stat -c%s \"ruta\"` (Linux); el tipo se deduce de la extensión (.mp4, .mov…). " +
      "2) Corre cada comando reemplazando RUTA por la ruta del archivo; cada subida termina cuando curl devuelve el JSON del archivo. " +
      "3) Después llama conectar_videos sin confirmar para proponer qué video va con qué guion. " +
      "Si no tienes terminal (por ejemplo en claude.ai web), no inventes la subida: manda al editor a https://metrics.bakano.ec/editor/subir. Los enlaces de subida vencen en unas horas.",
    perfiles: ["edicion", "direccion"],
    escribe: true,
    entrada: {
      planning_id: z.string(),
      archivos: z
        .array(z.object({ nombre: z.string().min(1), tamano_bytes: z.number().int().positive(), tipo: z.string().optional() }))
        .min(1)
        .max(MAX_LOTE),
    },
    async correr(a, u) {
      const p = await planificacionPermitida(a.planning_id, u);
      const subidas: unknown[] = [];
      const errores: string[] = [];
      for (const f of a.archivos as { nombre: string; tamano_bytes: number; tipo?: string }[]) {
        const tipo = tipoDeVideo(f.nombre, f.tipo);
        if (!tipo) {
          errores.push(`"${f.nombre}": no reconozco el tipo de video (usa .mp4, .mov, .m4v, .webm…).`);
          continue;
        }
        try {
          const { uploadUrl } = await videoEntregaService.sesionSubida(a.planning_id, { fileName: f.nombre, mimeType: tipo, size: f.tamano_bytes });
          subidas.push({
            nombre: f.nombre,
            comando: `curl -sS -X PUT -H "Content-Type: ${tipo}" --upload-file "RUTA" "${uploadUrl}"`,
          });
        } catch (e: any) {
          errores.push(`"${f.nombre}": ${e?.message || "no pude preparar la subida"}`);
        }
      }
      return {
        cliente: p.workspaceName,
        planificacion: p.titulo,
        subidas,
        ...(errores.length ? { errores } : {}),
        siguiente: "Corre cada comando con la ruta real del archivo. Cuando terminen, llama conectar_videos sin confirmar.",
      };
    },
  },
  {
    nombre: "conectar_videos",
    titulo: "Conectar videos con sus guiones",
    descripcion:
      "Sin confirmar: lista los videos ya subidos a la carpeta de la planificación que todavía no están conectados, con el guion que sugiere su nombre. " +
      "Muéstrale la propuesta al editor y PREGÚNTALE si está bien antes de confirmar. " +
      "Con confirmar=true y asignaciones [{archivo_id, numero}]: cada video queda como versión nueva de su guion, EDITADO, y pasa a la revisión del productor (se le avisa por la app, Telegram y correo). " +
      "No le llega nada al cliente todavía: eso sale cuando el productor aprueba.",
    perfiles: ["edicion", "direccion"],
    escribe: true,
    entrada: {
      planning_id: z.string(),
      asignaciones: z.array(z.object({ archivo_id: z.string(), numero: z.number().int().positive() })).optional(),
      confirmar: z.boolean().optional(),
    },
    async correr(a, u) {
      const p = await planificacionPermitida(a.planning_id, u);
      const { archivos, guiones, carpetaLink } = await videoEntregaService.archivosSinConectar(a.planning_id);
      if (!a.confirmar) {
        if (!archivos.length) {
          return {
            cliente: p.workspaceName,
            planificacion: p.titulo,
            archivos: [],
            aviso: carpetaLink ? "No hay videos nuevos en la carpeta: todos están conectados o la subida no terminó." : "Todavía no se subió nada: usa subir_videos.",
          };
        }
        return {
          cliente: p.workspaceName,
          planificacion: p.titulo,
          propuesta: archivos.map((f) => ({
            archivo_id: f.archivoId,
            nombre: f.nombre,
            tamanoMb: f.tamanoMb,
            guion: f.sugerencia ? `#${f.sugerencia.numero} ${f.sugerencia.tema}` : "sin sugerencia: pregúntale al editor",
            numero: f.sugerencia?.numero ?? null,
          })),
          guiones: guiones.map((g) => `#${g.numero} ${g.tema}`),
          siguiente: "Pregúntale al editor si la propuesta está bien (o qué cambiar) y después llama con confirmar=true y las asignaciones.",
        };
      }
      if (!a.asignaciones?.length) throw new Error("Para conectar dime qué archivo va con qué guion: asignaciones [{archivo_id, numero}].");
      const r = await videoEntregaService.conectar(a.planning_id, asignacionesPorNumero(a.asignaciones, guiones), actorDe(u));
      return {
        conectados: r.conectados.map((c) => ({ numero: c.numero, version: c.version, link: c.driveLink })),
        ...(r.errores.length ? { errores: r.errores } : {}),
        siguiente: "Quedaron en la revisión del productor (ya le avisamos). Al cliente le llegan cuando el productor los apruebe.",
      };
    },
  },
  {
    nombre: "cola_revision_videos",
    titulo: "Videos editados por revisar",
    descripcion:
      "Videos que edición subió y que nadie del equipo revisó todavía (revisión interna del productor antes del cliente): link, versión, editor y, si es una re-edición, los cambios que había pedido el cliente. Para aprobar usa aprobar_videos; para devolver, devolver_video_editor.",
    perfiles: ["direccion", "pm", "contenido", "produccion"],
    entrada: { cliente: z.string().optional() },
    async correr(a) {
      let cola: any[] = (await videoPlanningService.getReviewQueue()).pendientes;
      if (a.cliente) {
        const ws = await resolverCliente(a.cliente);
        cola = cola.filter((c) => c.workspaceId === String(ws._id));
      }
      const ids = [...new Set(cola.map((c) => c.planningId))];
      const vps = await models.videoPlanning
        .find({ _id: { $in: ids } })
        .select("items._id items.versiones items.rondasUsadas items.correccionesVideo")
        .lean();
      const porItem = new Map<string, any>();
      for (const vp of vps) for (const i of vp.items) porItem.set(String(i._id), i);
      return {
        total: cola.length,
        videos: cola.slice(0, 60).map((c) => {
          const i = porItem.get(c.itemId);
          const ronda = i?.rondasUsadas ?? 0;
          const cambios = (i?.correccionesVideo ?? []).filter((x: any) => x.ronda === ronda);
          return {
            planning_id: c.planningId,
            cliente: c.workspaceName,
            numero: c.numero,
            tema: c.tema,
            link: c.driveLink || c.linkVideo,
            version: i?.versiones?.length || 1,
            editor: c.editorNombre,
            publicacion: fecha(c.fechaPublicacion, false),
            ...(cambios.length ? { cambiosDelCliente: cambios.map((x: any) => ({ segundo: formatoSegundo(x.segundo), texto: x.texto })), rondasClienteRestantes: rondasRestantes(i) } : {}),
          };
        }),
      };
    },
  },
  {
    nombre: "aprobar_videos",
    titulo: "Aprobar videos (revisión interna)",
    descripcion:
      "Revisión interna del productor. Sin confirmar: dice qué videos se aprobarían y si con eso le llega al cliente el aviso para revisarlos (sale cuando no queda ningún video editado de esa planificación esperando revisión interna). " +
      "Antes de confirmar PREGÚNTALE a la persona: \"¿Los envío al cliente para revisión?\" (o, si faltan otros, si igual los aprueba). " +
      "Con confirmar=true: los aprueba y, si corresponde, le avisa al cliente por Telegram, WhatsApp y correo.",
    perfiles: ["produccion", "pm", "contenido", "direccion"],
    escribe: true,
    entrada: {
      planning_id: z.string(),
      numeros: z.array(z.number().int().positive()).min(1),
      confirmar: z.boolean().optional(),
    },
    async correr(a, u) {
      const vp = await itemsDe(a.planning_id);
      const prev = previsualizarAprobacion(vp.items, a.numeros);
      const resumen = {
        cliente: vp.workspaceId?.name,
        aprobar: prev.aprobar.map((i) => `#${i.numero} ${i.tema}`),
        ...(prev.noSePueden.length ? { noSePueden: prev.noSePueden } : {}),
        ...(prev.faltanPorRevisar.length ? { faltanPorRevisar: prev.faltanPorRevisar } : {}),
      };
      if (!prev.aprobar.length) return { ...resumen, aviso: "No hay nada que aprobar con esos números." };
      if (!a.confirmar) {
        return {
          ...resumen,
          alClienteLeLlegaElAviso: prev.saleAlCliente,
          siguiente: prev.saleAlCliente
            ? "Pregunta: ¿los envío al cliente para revisión? Si dice que sí, llama con confirmar=true."
            : "Con esto todavía no sale el aviso al cliente (faltan videos por revisar). Pregunta si igual los aprueba.",
        };
      }
      for (const i of prev.aprobar) {
        await videoPlanningService.updateItem(a.planning_id, String(i._id), { edicionRevisada: true }, undefined, undefined, { id: u._id, nombre: u.nombre }, { avisarCliente: false });
      }
      let enviadoAlCliente = false;
      let error: string | undefined;
      try {
        enviadoAlCliente = await videoPlanningService.avisarClienteSiTodoRevisado(a.planning_id, u.nombre);
      } catch (e: any) {
        error = e?.message || "falló el aviso";
      }
      return {
        aprobados: resumen.aprobar,
        enviadoAlCliente,
        ...(error ? { errorAviso: `Quedaron aprobados, pero el aviso al cliente falló: ${error}` } : {}),
        ...(!enviadoAlCliente && !error && prev.faltanPorRevisar.length ? { pendiente: "El aviso al cliente sale cuando se revisen los que faltan." } : {}),
      };
    },
  },
  {
    nombre: "devolver_video_editor",
    titulo: "Devolver un video al editor",
    descripcion:
      "Revisión interna: el video no está listo para el cliente. Vuelve a la cola del editor con el motivo y le avisamos (app, Telegram y correo). No gasta rondas del cliente.",
    perfiles: ["produccion", "pm", "contenido", "direccion"],
    escribe: true,
    entrada: {
      planning_id: z.string(),
      numero: z.number().int().positive(),
      motivo: z.string().min(5),
      categoria: z.enum(["calidad_video", "ritmo_edicion", "audio_musica", "subtitulos", "estructura", "otro"]).optional(),
    },
    async correr(a, u) {
      const vp = await itemsDe(a.planning_id);
      const item = vp.items.find((i: any) => i.numero === a.numero);
      if (!item) throw new Error(`Esta planificación no tiene el guion #${a.numero}.`);
      if (item.edicion !== "EDITADO" || item.edicionRevisada !== false) {
        throw new Error("Ese video no está esperando la revisión interna: solo se devuelve lo que está en cola_revision_videos.");
      }
      const actualizado: any = await videoPlanningService.updateItem(
        a.planning_id,
        String(item._id),
        { edicion: "RECHAZADO", motivoRechazo: a.motivo, motivoCategoria: a.categoria ?? "otro" },
        undefined,
        undefined,
        { id: u._id, nombre: u.nombre }
      );
      const it = actualizado.items.find((i: any) => String(i._id) === String(item._id));
      await videoEntregaService.avisarEditorDevuelto(actualizado, it, a.motivo, u.nombre).catch(() => {});
      return { devuelto: `#${item.numero} ${item.tema}`, editor: item.editorPorNombre || "editores del cliente", cola: `${APP_URL}/editor` };
    },
  },
];
