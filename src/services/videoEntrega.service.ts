import { Types } from "mongoose";
import models from "../models";
import type { IVideoItem, IVideoPlanning } from "../models/videoPlanning.model";
import { googleDriveService, driveSharedDriveId, sanitizeDriveName } from "./googleDrive.service";
import { reviewEventService } from "./reviewEvent.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { telegramService, escaparHtml } from "./telegram.service";
import { chatsDeUsuario } from "./chatsTelegram.service";
import { formatoSegundo, MAX_RONDAS_VIDEO, rondasRestantes } from "./correccionVideo.service";
import { actividadService } from "./actividad.service";

/**
 * Entrega de videos por planificacion.
 *
 * El editor no entra a Drive: elige cliente y planificacion, suelta TODOS los
 * videos de una vez y despues conecta cada archivo con su guion. Por detras:
 *
 *   Unidad compartida / <Cliente> / <AAAA-MM - Planificacion> / archivos
 *
 * Los archivos viajan directo navegador → Drive (sesion resumable, igual que
 * la entrega por item); el backend solo crea carpetas y sesiones, y al
 * conectar renombra el archivo como "NN - tema (vN)" y guarda la version.
 * Una version nueva de un video rechazado NO borra la anterior: queda en la
 * carpeta y en el historial para comparar.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";
const MAX_SIZE = 5 * 1024 * 1024 * 1024;
/** Ventana de planificaciones que el editor puede elegir. */
const DIAS_ATRAS = 75;
const DIAS_ADELANTE = 45;

export class ErrorEntrega extends Error {
  constructor(
    public readonly codigo: string,
    message: string,
    public readonly status = 400
  ) {
    super(message);
  }
}

function ym(fecha: Date): string {
  const d = new Date(fecha);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function extension(nombre?: string): string {
  const ext = nombre && nombre.includes(".") ? nombre.split(".").pop()!.toLowerCase() : "";
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : "mp4";
}

/** "03 - Promo de verano (v2).mp4" */
export function nombreVersion(item: { numero: number; tema: string }, version: number, archivoOriginal?: string): string {
  const base = `${String(item.numero).padStart(2, "0")} - ${sanitizeDriveName(item.tema)}`;
  return `${base}${version > 1 ? ` (v${version})` : ""}.${extension(archivoOriginal)}`;
}

/**
 * Sugiere el guion de un archivo por su nombre: primero el numero ("03",
 * "#3", "video 3", "v3_final" no cuenta como numero si es una version), y si
 * no, el tema con mas palabras en comun. null si no hay nada razonable.
 */
export function sugerirGuion(
  nombreArchivo: string,
  items: { itemId: string; numero: number; tema: string }[]
): string | null {
  const limpio = nombreArchivo
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  const sinVersion = limpio.replace(/\bv(ersion)?\s?\d+\b/g, " ").replace(/\b(final|edit(ado)?|export|master)\b/g, " ");
  const numeros = [...sinVersion.matchAll(/(?:^|[^0-9])(\d{1,2})(?![0-9])/g)].map((m) => Number(m[1]));
  for (const n of numeros) {
    const item = items.find((i) => i.numero === n);
    if (item) return item.itemId;
  }
  const palabras = new Set(sinVersion.split(/[^a-z0-9]+/).filter((p) => p.length > 3));
  let mejor: { itemId: string; puntos: number } | null = null;
  for (const i of items) {
    const tema = i.tema.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().split(/[^a-z0-9]+/).filter((p) => p.length > 3);
    const puntos = tema.filter((p) => palabras.has(p)).length;
    if (puntos > 0 && (!mejor || puntos > mejor.puntos)) mejor = { itemId: i.itemId, puntos };
  }
  return mejor?.itemId ?? null;
}

export interface ActorEntrega {
  id: string;
  nombre?: string;
  internalRole?: string;
  role?: string;
}

class VideoEntregaService {
  /**
   * Planificaciones que el editor puede cargar: las de sus entornos (o todas,
   * si es del equipo y no editor) en una ventana alrededor de hoy.
   */
  async planificaciones(actor: ActorEntrega) {
    const desde = new Date(Date.now() - DIAS_ATRAS * 86_400_000);
    const hasta = new Date(Date.now() + DIAS_ADELANTE * 86_400_000);
    const filtro: Record<string, unknown> = { date: { $gte: desde, $lte: hasta } };
    if (actor.internalRole === "editor" && actor.role !== "superadmin") {
      const user = await models.users.findById(actor.id).select("workspaces").lean();
      const ids = (user?.workspaces ?? []).map((w: any) => w.workspaceId).filter(Boolean);
      filtro.$or = [{ assignedTo: new Types.ObjectId(actor.id) }, { workspaceId: { $in: ids } }];
    }
    const entradas = await models.planning.find(filtro).select("_id title date workspaceId").sort({ date: -1 }).lean();
    if (!entradas.length) return [];
    const vps = await models.videoPlanning
      .find({ planningEntryId: { $in: entradas.map((e) => e._id) } })
      .select(
        "planningEntryId workspaceId driveMonthFolderLink items._id items.numero items.tema items.estadoIdea items.estadoProduccion items.edicion items.videoClienteAprobacion items.rondasUsadas items.versiones items.driveLink items.correccionesVideo"
      )
      .populate("workspaceId", "name")
      .lean();
    const porEntrada = new Map(entradas.map((e) => [String(e._id), e]));
    return vps
      .filter((vp) => vp.items?.length)
      .map((vp) => {
        const e = porEntrada.get(String(vp.planningEntryId))!;
        const ws = vp.workspaceId as any;
        return {
          planningId: String(vp._id),
          entryId: String(vp.planningEntryId),
          workspaceId: String(ws?._id ?? ""),
          workspaceName: ws?.name || "Sin entorno",
          titulo: e?.title || "Planificación",
          fecha: e?.date,
          carpetaLink: vp.driveMonthFolderLink || null,
          items: [...vp.items]
            .filter((i) => i.estadoIdea !== "RECHAZADO")
            .sort((a, b) => a.numero - b.numero)
            .map((i) => ({
              itemId: String(i._id),
              numero: i.numero,
              tema: i.tema,
              estadoProduccion: i.estadoProduccion,
              edicion: i.edicion,
              videoClienteAprobacion: i.videoClienteAprobacion ?? null,
              versiones: i.versiones?.length ?? (i.driveLink ? 1 : 0),
              rondasRestantes: rondasRestantes(i),
              driveLink: i.driveLink ?? null,
              correcciones: (i.correccionesVideo ?? [])
                .filter((c) => c.ronda === (i.rondasUsadas ?? 0))
                .map((c) => ({ segundo: formatoSegundo(c.segundo), texto: c.texto })),
            })),
        };
      })
      .sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime());
  }

  /** Carpeta del cliente y de la planificacion, creadas una sola vez. */
  private async carpeta(planning: any): Promise<string> {
    if (planning.driveMonthFolderId) return planning.driveMonthFolderId;
    const workspace = await models.workspaces.findById(planning.workspaceId);
    if (!workspace) throw new ErrorEntrega("SIN_ENTORNO", "El entorno de esta planificación no existe.", 404);
    if (!workspace.driveFolderId) {
      const folder = await googleDriveService.ensureFolder(driveSharedDriveId(), sanitizeDriveName(workspace.name));
      await googleDriveService.setAnyoneReader(folder.id);
      workspace.driveFolderId = folder.id;
      workspace.driveFolderLink = folder.webViewLink;
      await workspace.save();
    }
    const entrada = await models.planning.findById(planning.planningEntryId).select("title date").lean();
    const nombre = sanitizeDriveName(`${ym(entrada?.date ?? planning.createdAt ?? new Date())} - ${entrada?.title || "Planificación"}`);
    const folder = await googleDriveService.ensureFolder(workspace.driveFolderId!, nombre);
    // Dos subidas en paralelo pueden crearla a la vez: gana la primera que se guardo.
    const r = await models.videoPlanning.findOneAndUpdate(
      { _id: planning._id, driveMonthFolderId: { $in: [null, ""] } },
      { $set: { driveMonthFolderId: folder.id, driveMonthFolderLink: folder.webViewLink } },
      { new: true }
    );
    if (r) return folder.id;
    const actual = await models.videoPlanning.findById(planning._id).select("driveMonthFolderId").lean();
    return actual?.driveMonthFolderId || folder.id;
  }

  /** Sesion resumable para un archivo del lote, dentro de la carpeta de la planificacion. */
  async sesionSubida(
    planningId: string,
    archivo: { fileName?: string; mimeType?: string; size?: number },
    origin?: string
  ): Promise<{ uploadUrl: string; carpetaId: string }> {
    if (!Types.ObjectId.isValid(planningId)) throw new ErrorEntrega("ID_INVALIDO", "Planificación inválida.");
    const { fileName, mimeType, size } = archivo;
    if (!fileName || !mimeType || !size || size <= 0 || size > MAX_SIZE) {
      throw new ErrorEntrega("ARCHIVO_INVALIDO", "Cada archivo necesita nombre, tipo y tamaño (máx 5GB).");
    }
    if (!mimeType.startsWith("video/")) throw new ErrorEntrega("NO_ES_VIDEO", `"${fileName}" no es un video.`);
    const planning = await models.videoPlanning.findById(planningId).select("_id workspaceId planningEntryId driveMonthFolderId createdAt").lean();
    if (!planning) throw new ErrorEntrega("NO_ENCONTRADA", "Planificación no encontrada.", 404);
    const carpetaId = await this.carpeta(planning);
    const uploadUrl = await googleDriveService.createResumableSession({
      parentId: carpetaId,
      name: sanitizeDriveName(fileName),
      mimeType,
      size,
      origin,
    });
    return { uploadUrl, carpetaId };
  }

  /**
   * Conecta archivos ya subidos con sus guiones. Cada uno queda como version
   * nueva, EDITADO y con la revision interna abierta (mismo circuito que
   * marcar EDITADO a mano: correo al PM/CM, banderas).
   */
  async conectar(planningId: string, asignaciones: { itemId?: string; fileId?: string }[], actor: ActorEntrega) {
    if (!Types.ObjectId.isValid(planningId)) throw new ErrorEntrega("ID_INVALIDO", "Planificación inválida.");
    if (!Array.isArray(asignaciones) || !asignaciones.length) throw new ErrorEntrega("SIN_ASIGNACIONES", "No hay videos para conectar.");
    const items = new Set<string>();
    const archivos = new Set<string>();
    for (const a of asignaciones) {
      if (!a?.itemId || !a?.fileId || !Types.ObjectId.isValid(a.itemId)) throw new ErrorEntrega("ASIGNACION_INVALIDA", "Cada video necesita su guion.");
      if (items.has(a.itemId)) throw new ErrorEntrega("GUION_REPETIDO", "Dos videos quedaron conectados al mismo guion.");
      if (archivos.has(a.fileId)) throw new ErrorEntrega("ARCHIVO_REPETIDO", "Un archivo quedó conectado a dos guiones.");
      items.add(a.itemId);
      archivos.add(a.fileId);
    }

    const planning = await models.videoPlanning.findById(planningId);
    if (!planning) throw new ErrorEntrega("NO_ENCONTRADA", "Planificación no encontrada.", 404);
    if (!planning.driveMonthFolderId) throw new ErrorEntrega("SIN_CARPETA", "Primero sube los videos: la planificación todavía no tiene carpeta.");

    const nombreActor =
      actor.nombre || (await models.users.findById(actor.id).select("name email").lean().then((u) => u?.name || u?.email)) || undefined;
    const ahora = new Date();
    const cambios: { item: IVideoItem; prevEdicion: string; version: number }[] = [];
    const errores: string[] = [];

    for (const a of asignaciones) {
      const item = planning.items.find((i) => String(i._id) === a.itemId);
      if (!item) {
        errores.push(`Guion ${a.itemId} no está en esta planificación.`);
        continue;
      }
      let file;
      try {
        file = await googleDriveService.getFile(a.fileId!);
      } catch {
        errores.push(`#${item.numero}: no encontré el archivo en Drive.`);
        continue;
      }
      if (!(file.parents ?? []).includes(planning.driveMonthFolderId)) {
        errores.push(`#${item.numero}: el archivo no está en la carpeta de esta planificación.`);
        continue;
      }
      if (item.driveFileId === file.id) {
        errores.push(`#${item.numero}: ese archivo ya es la versión vigente.`);
        continue;
      }

      // El historial arranca con la entrega vieja (hecha por item) si la habia.
      const versiones = [...(item.versiones ?? [])];
      if (!versiones.length && item.driveFileId) {
        versiones.push({
          n: 1,
          driveFileId: item.driveFileId,
          driveLink: item.driveLink,
          subidoPorId: item.editorPorId,
          subidoPorNombre: item.editorPorNombre,
          en: item.editadoEn ?? item.edicionRevisadaEn ?? planning.updatedAt ?? ahora,
        });
      }
      const version = versiones.length + 1;
      const renombrado = await googleDriveService.renameFile(file.id, nombreVersion(item, version, file.name)).catch(() => file);
      versiones.push({
        n: version,
        driveFileId: file.id,
        driveLink: renombrado.webViewLink || file.webViewLink,
        nombreArchivo: renombrado.name || file.name,
        subidoPorId: new Types.ObjectId(actor.id),
        subidoPorNombre: nombreActor,
        en: ahora,
      });

      const prevEdicion = item.edicion;
      const linkAnterior = item.driveLink;
      item.versiones = versiones;
      item.driveFileId = file.id;
      item.driveLink = renombrado.webViewLink || file.webViewLink;
      // linkVideo es lo que el cliente abre en la revision web: si apuntaba a
      // la version anterior (o no habia), pasa a la nueva.
      if (!item.linkVideo || item.linkVideo === linkAnterior) item.linkVideo = item.driveLink;
      item.edicion = "EDITADO";
      item.editadoEn = ahora;
      item.edicionRevisada = false;
      item.edicionRevisadaPorId = undefined;
      item.edicionRevisadaNombre = undefined;
      item.edicionRevisadaEn = undefined;
      item.videoClienteAprobacion = "PENDIENTE";
      item.videoClienteMotivo = undefined;
      item.videoAprobadoEn = undefined;
      if (actor.internalRole === "editor" || !item.editorPorId) {
        item.editorPorId = new Types.ObjectId(actor.id);
        if (nombreActor) item.editorPorNombre = nombreActor;
      }
      cambios.push({ item, prevEdicion, version });
    }

    if (!cambios.length) throw new ErrorEntrega("NADA_CONECTADO", errores.join(" ") || "No se pudo conectar ningún video.");
    await planning.save();

    // Lo de despues no frena la respuesta: banderas, revision interna y bitacora.
    (async () => {
      const vp = planning as unknown as IVideoPlanning;
      const [workspace, revisores] = await Promise.all([
        models.workspaces.findById(planning.workspaceId).select("name").lean(),
        models.users
          .find({ isInternal: true, internalRole: { $in: ["project_manager", "content_manager"] } })
          .select("email")
          .lean(),
      ]);
      for (const c of cambios) {
        await reviewEventService
          .recordItemTransitions({ planning: vp, item: c.item, prevEstadoIdea: c.item.estadoIdea, prevEdicion: c.prevEdicion, actorId: actor.id })
          .catch(() => {});
        await resendService
          .sendVideoReadyForReview({
            to: revisores.map((r) => r.email),
            workspaceName: workspace?.name || "Cliente",
            numero: c.item.numero,
            tema: c.version > 1 ? `${c.item.tema} (versión ${c.version})` : c.item.tema,
            editorNombre: nombreActor,
            driveLink: c.item.driveLink,
          })
          .catch((e: any) => console.warn("[Entrega videos] correo de revisión:", e?.message));
        await actividadService
          .registrar({
            workspaceId: planning.workspaceId,
            tipo: "video_subido",
            actorId: actor.id,
            actorNombre: nombreActor,
            planningId: planning._id,
            itemId: c.item._id,
            numero: c.item.numero,
            tema: c.item.tema,
            detalle: c.version > 1 ? `Versión ${c.version}` : undefined,
          })
          .catch(() => {});
      }
    })().catch((e: any) => console.warn("[Entrega videos] después de conectar:", e?.message));

    return {
      conectados: cambios.map((c) => ({ itemId: String(c.item._id), numero: c.item.numero, version: c.version, driveLink: c.item.driveLink })),
      errores,
      carpetaLink: planning.driveMonthFolderLink || null,
    };
  }

  /**
   * El cliente pidio cambios: le llega al editor del video por la app, por
   * Telegram (si tiene el bot) y por correo, con cada segundo.
   */
  async avisarEditor(
    planning: { _id: unknown; workspaceId: unknown },
    item: IVideoItem,
    ronda: number,
    cambios: { segundo: number; texto: string }[],
    clienteNombre?: string
  ): Promise<void> {
    const workspaceId = String(planning.workspaceId);
    let editores: { _id: Types.ObjectId; email?: string }[] = [];
    if (item.editorPorId) {
      const u = await models.users.findById(item.editorPorId).select("email").lean();
      if (u) editores = [u as any];
    }
    if (!editores.length) {
      editores = (await models.users
        .find({ isInternal: true, internalRole: "editor", isActive: { $ne: false }, "workspaces.workspaceId": new Types.ObjectId(workspaceId) })
        .select("email")
        .lean()) as any;
    }
    if (!editores.length) return;

    const workspace = await models.workspaces.findById(workspaceId).select("name").lean();
    const cliente = workspace?.name || "Cliente";
    const num = String(item.numero).padStart(2, "0");
    const lineas = cambios.map((c) => `${formatoSegundo(c.segundo)} — ${c.texto}`);
    const ultima = ronda >= MAX_RONDAS_VIDEO;
    const titulo = `Correcciones · ${cliente} #${num}`;
    const cuerpo = `Ronda ${ronda} de ${MAX_RONDAS_VIDEO}${ultima ? " (la última)" : ""}: ${lineas.join(" · ")}`.slice(0, 900);

    for (const ed of editores) {
      await notificationService
        .create(ed._id, "video_corregido", titulo, cuerpo, { workspaceId, referenceId: String(planning._id) })
        .catch(() => {});
      for (const chatId of await chatsDeUsuario(ed._id)) {
        await telegramService
          .sendMessage(
            chatId,
            `🎬 <b>${escaparHtml(cliente)} pidió cambios</b> en el #${num} ${escaparHtml(item.tema)}\n` +
              `Ronda ${ronda} de ${MAX_RONDAS_VIDEO}${ultima ? " · es la última" : ""}\n\n` +
              cambios.map((c) => `<b>${formatoSegundo(c.segundo)}</b> — ${escaparHtml(c.texto)}`).join("\n"),
            [[{ text: "🎞️ Ir a mi cola", url: `${APP_URL}/editor` }]]
          )
          .catch(() => {});
      }
    }
    await resendService
      .sendCorreccionesVideoEditor({
        to: editores.map((e) => e.email).filter(Boolean) as string[],
        workspaceName: cliente,
        numero: item.numero,
        tema: item.tema,
        ronda,
        rondasMax: MAX_RONDAS_VIDEO,
        clienteNombre,
        cambios: cambios.map((c) => ({ segundo: formatoSegundo(c.segundo), texto: c.texto })),
        driveLink: item.driveLink,
        colaUrl: `${APP_URL}/editor`,
      })
      .catch((e: any) => console.warn("[Entrega videos] correo al editor:", e?.message));
  }
}

export const videoEntregaService = new VideoEntregaService();
