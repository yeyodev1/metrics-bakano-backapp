import { z } from "zod";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import models from "../../models";
import { PlanningService } from "../../services/planning.service";
import { VideoPlanningService } from "../../services/videoPlanning.service";
import { atencionClienteService } from "../../services/atencionCliente.service";
import { destacarClienteService } from "../../services/destacarCliente.service";
import type { PerfilMcp, UsuarioMcp } from "../perfiles";
import { ANTICIPACION_PRODUCCION_H, fecha, leerFecha, recortar, resolverCliente, type ToolMcp } from "./base";

const planningService = new PlanningService();
const videoPlanningService = new VideoPlanningService();

/** Quién mueve qué fecha: el contenido mueve publicaciones; la producción es del PM. */
const MUEVEN_VIDEO: PerfilMcp[] = ["direccion", "pm", "contenido"];
/** Producción organiza su calendario completo; contenido se entera de cada cambio. */
const MUEVEN_PRODUCCION: PerfilMcp[] = ["direccion", "pm", "produccion"];
const MUEVEN_ALGO: PerfilMcp[] = [...new Set([...MUEVEN_VIDEO, ...MUEVEN_PRODUCCION])];
const TOKEN_MIN = 5;

function secreto(): string {
  return `${process.env.JWT_SECRET || "default_jwt_secret_key"}:mcp-fechas`;
}

async function planningDeLaProduccion(entryId: Types.ObjectId | string) {
  return models.videoPlanning
    .findOne({ planningEntryId: entryId })
    .select("-items.guionIA -items.scriptMeta -items.metrics -items.scriptRefs -notificaciones -avisosRevision")
    .lean();
}

/**
 * Revisa si una fecha se puede mover sin romper nada, sin tocar nada.
 * Devuelve un token de 5 minutos atado a ESTE cambio: mover_fecha solo acepta
 * ese token, así el modelo no puede escribir una fecha que no consultó.
 */
async function evaluarCambio(a: any, u: UsuarioMcp) {
  const nueva = leerFecha(a.nueva_fecha);
  const ahora = new Date();
  const advertencias: string[] = [];
  const bloqueos: string[] = [];
  let actual: Date | undefined;
  let descripcion = "";

  if (a.tipo === "produccion") {
    if (!MUEVEN_PRODUCCION.includes(u.perfil)) bloqueos.push("Mover producciones le toca a Producción o al Project Manager.");
    if (!a.produccion_id || !Types.ObjectId.isValid(a.produccion_id)) throw new Error("Falta produccion_id (sale de calendario_producciones).");
    const p: any = await models.planning.findById(a.produccion_id).populate("workspaceId", "name").lean();
    if (!p) throw new Error("No encontré esa producción.");
    actual = p.date;
    descripcion = `Producción "${p.title}" de ${p.workspaceId?.name}`;
    if (p.cumplida) bloqueos.push("Esa producción ya se grabó.");
    if (p.cancelada || /^CANCELADA/.test(p.title)) bloqueos.push("Esa producción está cancelada.");
    // El MCP es solo del equipo interno: las 48 h son un aviso, no un bloqueo.
    if (nueva.getTime() <= ahora.getTime()) bloqueos.push("Esa fecha ya pasó.");
    else if (nueva.getTime() - ahora.getTime() < ANTICIPACION_PRODUCCION_H * 3_600_000) {
      advertencias.push(`Queda a menos de ${ANTICIPACION_PRODUCCION_H} h: confírmalo con el cliente directamente, puede no ver el aviso a tiempo.`);
    }
    if (p.crm?.appointmentId && p.crm.calendarId && Math.abs(nueva.getTime() - new Date(p.date).getTime()) > 60_000) {
      // Se mueve en el CRM a cualquier hora (forzado): aquí se cuida que no pise nada.
      const choques = await atencionClienteService.choquesProduccion(p.crm.calendarId, nueva, p.crm.appointmentId);
      for (const c of choques) bloqueos.push(`Choca con "${c.titulo}" (${c.cuando}) en el calendario de producción.`);
      if (!choques.length) advertencias.push("Esa hora no choca con nada del equipo de producción (puede estar fuera de los horarios que ven los clientes).");
    }
    if (p.source === "crm") advertencias.push("Viene del CRM: se mueve también la cita en GoHighLevel.");
    const ariana = await atencionClienteService.reglaAriana(p.workspaceId?._id).catch(() => null);
    if (ariana?.aplica) {
      if (!ariana.tieneAriana) advertencias.push("Es su primera producción y todavía no tiene reunión con Ariana: la regla es Ariana primero y la producción al menos 4 días después.");
      else if (ariana.produccionDesde && nueva.getTime() < ariana.produccionDesde.getTime())
        advertencias.push(`Queda a menos de 4 días de su reunión con Ariana (${fecha(ariana.fechaAriana)}): la producción debería ir desde el ${fecha(ariana.produccionDesde, false)} para llegar con guiones.`);
    }
    advertencias.push("Al moverla se avisa a Ariana y a la content del cliente (in-app y correo) para que los videos estén listos para la nueva fecha.");
    const vp: any = await planningDeLaProduccion(p._id);
    if (vp?.items?.length && !vp.clienteAprobado) {
      advertencias.push("Tiene guiones sin aprobar: el plazo de correcciones del cliente (48 h antes) se corre con la nueva fecha.");
    }
    const otras = await models.planning
      .find({ _id: { $ne: p._id }, workspaceId: p.workspaceId?._id, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ }, date: { $gte: new Date(nueva.getTime() - 45 * 86_400_000), $lte: new Date(nueva.getTime() + 45 * 86_400_000) } })
      .select("title date")
      .lean();
    for (const o of otras as any[]) advertencias.push(`Queda cerca de otra producción del mismo cliente: "${o.title}" el ${fecha(o.date)}.`);
  } else {
    if (!MUEVEN_VIDEO.includes(u.perfil)) throw new Error("Mover publicaciones de videos le toca a Contenido o al Project Manager.");
    if (!a.planning_id || !a.item_id) throw new Error("Faltan planning_id e item_id (salen de ver_planificacion).");
    const vp: any = await models.videoPlanning.findById(a.planning_id).populate("workspaceId", "name").lean();
    const item = vp?.items?.find((i: any) => String(i._id) === String(a.item_id));
    if (!item) throw new Error("No encontré ese video.");
    actual = item.fechaPublicacion;
    descripcion = `Video #${item.numero} "${item.tema}" de ${vp.workspaceId?.name}`;
    if (nueva < ahora) bloqueos.push("La nueva fecha ya pasó.");
    if (item.estadoPublicacion === "PUBLICADO") bloqueos.push("Ese video ya se publicó.");
    if (item.igScheduleStatus === "SCHEDULED" || item.fbScheduleStatus === "SCHEDULED") {
      bloqueos.push("Está programado en Instagram/Facebook: muévelo desde metrics.bakano.ec para que se reprograme en Meta.");
    }
    const prod: any = await models.planning.findById(vp.planningEntryId).select("date").lean();
    if (prod?.date && item.estadoProduccion !== "GRABADO" && nueva < new Date(prod.date)) {
      bloqueos.push(`Todavía no se graba: la producción es el ${fecha(prod.date)}.`);
    }
    if (item.edicion !== "EDITADO") advertencias.push("Todavía no está editado: confirma con edición que llega a esa fecha.");
    if (item.clienteAprobacion === "RECHAZADO") advertencias.push("El cliente rechazó este guion.");
  }

  const permitido = bloqueos.length === 0;
  const token = permitido
    ? jwt.sign(
        { t: a.tipo, p: a.produccion_id, vp: a.planning_id, i: a.item_id, f: nueva.toISOString(), u: u._id },
        secreto(),
        { expiresIn: `${TOKEN_MIN}m` }
      )
    : undefined;
  return {
    que: descripcion,
    fechaActual: fecha(actual),
    fechaNueva: fecha(nueva),
    permitido,
    motivos: bloqueos,
    advertencias,
    ...(token ? { token, venceEn: `${TOKEN_MIN} minutos`, siguiente: "Confírmalo con la persona y usa mover_fecha con este token." } : {}),
  };
}

export const toolsContenido: ToolMcp[] = [
  {
    nombre: "ver_planificacion",
    titulo: "Planificación de videos de un cliente",
    descripcion:
      "Los videos planificados de un cliente por producción: tema, guion (resumen), estado de idea, grabación, edición y publicación, aprobación del cliente y fecha de publicación. Trae los ids que usan mover_fecha y actualizar_edicion.",
    perfiles: ["direccion", "pm", "contenido", "produccion", "edicion"],
    entrada: {
      cliente: z.string(),
      meses_atras: z.number().int().min(0).max(6).optional().describe("Desde hace cuántos meses (por defecto 1)"),
      con_guion_completo: z.boolean().optional(),
    },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const desde = new Date();
      desde.setMonth(desde.getMonth() - (a.meses_atras ?? 1), 1);
      desde.setHours(0, 0, 0, 0);
      const producciones = await planningService.listEntries(String(ws._id), desde);
      const salida = [];
      for (const p of producciones as any[]) {
        const vp: any = await models.videoPlanning.findOne({ planningEntryId: p._id }).select("-items.metrics -items.scriptRefs -notificaciones -avisosRevision").lean();
        salida.push({
          produccion: { id: String(p._id), titulo: p.title, fecha: fecha(p.date), cumplida: p.cumplida === true },
          planificacion: vp
            ? {
                planning_id: String(vp._id),
                listaParaCliente: vp.listaParaCliente,
                aprobadaPorCliente: vp.clienteAprobado,
                videos: vp.items.map((i: any) => ({
                  item_id: String(i._id), numero: i.numero, tema: i.tema,
                  guion: a.con_guion_completo ? i.guion || i.guionIA : recortar(i.guion || i.guionIA?.gancho, 200),
                  guionPor: i.guionPorNombre,
                  idea: i.estadoIdea, grabacion: i.estadoProduccion, edicion: i.edicion, publicacion: i.estadoPublicacion,
                  cliente: i.clienteAprobacion, motivoRechazo: i.motivoRechazo,
                  fechaPublicacion: fecha(i.fechaPublicacion), linkVideo: i.linkVideo,
                })),
              }
            : "Sin videos planificados todavía.",
        });
      }
      // Lo que el cliente quiere destacar: sobre eso se planifica.
      const destacar = await destacarClienteService.de(ws._id).catch(() => null);
      return {
        cliente: ws.name,
        queQuiereDestacar: destacar?.actual ? { texto: destacar.actual.texto, cuando: fecha(destacar.actual.en) } : null,
        producciones: salida,
      };
    },
  },
  {
    nombre: "consultar_cambio_fecha",
    titulo: "¿Se puede mover esta fecha?",
    descripcion:
      "Paso 1 de 2 para mover una fecha. No cambia nada: revisa si la fecha de publicación de un video (tipo=video) o la fecha de una producción (tipo=produccion) se puede mover, con motivos y advertencias. Si se puede, devuelve un token de 5 minutos para mover_fecha. Contenido y PM mueven videos; Producción, PM y dirección mueven producciones (se mueve también en el CRM y se avisa a Ariana y a la content del cliente).",
    perfiles: MUEVEN_ALGO,
    entrada: {
      tipo: z.enum(["video", "produccion"]),
      nueva_fecha: z.string().describe("AAAA-MM-DD o AAAA-MM-DDTHH:mm, hora de Ecuador"),
      planning_id: z.string().optional().describe("tipo=video"),
      item_id: z.string().optional().describe("tipo=video"),
      produccion_id: z.string().optional().describe("tipo=produccion"),
    },
    correr: evaluarCambio,
  },
  {
    nombre: "mover_fecha",
    titulo: "Mover la fecha (con token)",
    descripcion:
      "Paso 2 de 2: aplica el cambio que consultar_cambio_fecha aprobó. Solo acepta ese token (vence en 5 minutos y es de quien lo pidió). Si es una producción, avisa a Ariana y a la content del cliente. Confirma con la persona antes.",
    perfiles: MUEVEN_ALGO,
    escribe: true,
    entrada: { token: z.string() },
    async correr(a, u) {
      let d: any;
      try {
        d = jwt.verify(a.token, secreto());
      } catch {
        throw new Error("El token venció o no es válido. Vuelve a consultar_cambio_fecha.");
      }
      if (d.u !== u._id) throw new Error("Ese token es de otra persona.");
      // Se vuelve a evaluar: en 5 minutos algo pudo cambiar (otro lo movió, se publicó...).
      const revision = await evaluarCambio(
        { tipo: d.t, produccion_id: d.p, planning_id: d.vp, item_id: d.i, nueva_fecha: d.f },
        u
      );
      if (!revision.permitido) return { movido: false, motivos: revision.motivos };
      if (d.t === "produccion") {
        await planningService.updateEntry(d.p, { date: d.f }, u.nombre);
      } else {
        await videoPlanningService.updateItem(d.vp, d.i, { fechaPublicacion: d.f }, u.internalRole ?? undefined, undefined, { id: u._id, nombre: u.nombre });
      }
      return { movido: true, que: revision.que, antes: revision.fechaActual, ahora: revision.fechaNueva, advertencias: revision.advertencias };
    },
  },
  {
    nombre: "dejar_feedback_guion",
    titulo: "Dejar feedback de guiones",
    descripcion:
      "Anota feedback sobre los guiones de un cliente (general o de un video). Lo usa la IA al generar los próximos guiones y lo ve el equipo en metrics.bakano.ec. No le avisa al cliente.",
    perfiles: ["direccion", "pm", "contenido"],
    escribe: true,
    entrada: {
      cliente: z.string(),
      texto: z.string().min(3).max(4000),
      planning_id: z.string().optional(),
      item_id: z.string().optional(),
      tema_video: z.string().optional(),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const valido = (id?: string) => (id && Types.ObjectId.isValid(id) ? new Types.ObjectId(id) : undefined);
      await models.scriptFeedback.create({
        workspaceId: ws._id,
        videoItemId: valido(a.item_id),
        planningId: valido(a.planning_id),
        videoTema: a.tema_video?.slice(0, 200),
        tipo: a.item_id ? "video" : "general",
        texto: a.texto.trim(),
        authorId: new Types.ObjectId(u._id),
        authorName: u.nombre,
      });
      return `Feedback guardado en ${ws.name}.`;
    },
  },
  {
    nombre: "cola_revision_videos",
    titulo: "Videos editados por revisar",
    descripcion: "Videos que edición ya marcó como EDITADO y que nadie del equipo revisó todavía.",
    perfiles: ["direccion", "pm", "contenido"],
    entrada: { cliente: z.string().optional() },
    async correr(a) {
      let cola: any[] = (await videoPlanningService.getReviewQueue()).pendientes;
      if (a.cliente) {
        const ws = await resolverCliente(a.cliente);
        cola = cola.filter((c) => c.workspaceId === String(ws._id));
      }
      return { total: cola.length, videos: cola.slice(0, 60) };
    },
  },
  {
    nombre: "mi_cola_edicion",
    titulo: "Mi cola de edición",
    descripcion: "Lo que te toca editar este mes: re-ediciones pedidas por el cliente, por editar, por subir el máster y listos.",
    perfiles: ["direccion", "edicion"],
    entrada: {},
    async correr(_a, u) {
      return videoPlanningService.getEditorQueue(u._id);
    },
  },
  {
    nombre: "actualizar_edicion",
    titulo: "Actualizar un video (edición)",
    descripcion:
      "Cambia el estado de edición (EDITADO / POR_EDITAR), de grabación o el link del video final. Marcar EDITADO lo manda a la cola de revisión del equipo.",
    perfiles: ["direccion", "edicion"],
    escribe: true,
    entrada: {
      planning_id: z.string(),
      item_id: z.string(),
      edicion: z.enum(["EDITADO", "POR_EDITAR", "RECHAZADO"]).optional(),
      estado_grabacion: z.enum(["GRABADO", "POR_GRABAR", "RECHAZADO"]).optional(),
      link_video: z.string().url().optional(),
    },
    async correr(a, u) {
      const campos: Record<string, unknown> = {};
      if (a.edicion) campos.edicion = a.edicion;
      if (a.estado_grabacion) campos.estadoProduccion = a.estado_grabacion;
      if (a.link_video) campos.linkVideo = a.link_video;
      if (!Object.keys(campos).length) throw new Error("Dime qué cambiar.");
      // Con rol "editor" el servicio solo deja tocar esos tres campos, pase lo que pase.
      const rol = u.perfil === "direccion" ? u.internalRole ?? undefined : "editor";
      const vp: any = await videoPlanningService.updateItem(a.planning_id, a.item_id, campos, rol, undefined, { id: u._id, nombre: u.nombre });
      const item = vp.items.find((i: any) => String(i._id) === a.item_id);
      return { listo: true, video: item ? { numero: item.numero, tema: item.tema, edicion: item.edicion, grabacion: item.estadoProduccion, link: item.linkVideo } : null };
    },
  },
];
