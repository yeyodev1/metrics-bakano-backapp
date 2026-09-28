import { z } from "zod";
import { Types } from "mongoose";
import models from "../../models";
import { PlanningService } from "../../services/planning.service";
import { notificationService } from "../../services/notification.service";
import { onboardingProgresoService } from "../../services/onboardingProgreso.service";
import { metricasClienteService } from "../../services/metricasCliente.service";
import { McpAuditoriaModel } from "../../models/mcp.model";
import { NOMBRE_PERFIL, TODOS } from "../perfiles";
import { estadoEntorno, fecha, leToca, leerFecha, recortar, resolverCliente, type ToolMcp } from "./base";

const planningService = new PlanningService();

export const toolsComunes: ToolMcp[] = [
  {
    nombre: "quien_soy",
    titulo: "Quién soy y qué puedo hacer",
    descripcion: "Tu nombre, tu perfil en el MCP y la lista de cosas que puedes hacer desde aquí.",
    perfiles: TODOS,
    entrada: {},
    async correr(_a, u) {
      return {
        nombre: u.nombre,
        correo: u.email,
        perfil: NOMBRE_PERFIL[u.perfil],
        rolEnMetrics: u.role === "superadmin" ? "superadmin" : u.internalRole,
        // Import al vuelo: index importa este archivo, al revés sería circular al cargar.
        puedes: (await import("./index")).TOOLS.filter((t) => leToca(t, u)).map((t) => `${t.nombre}: ${t.titulo}`),
        guia: "https://mcp.bakano.ec",
      };
    },
  },
  {
    nombre: "buscar_clientes",
    titulo: "Buscar clientes",
    descripcion:
      "Lista los clientes (entornos) de Bakano con su id y su estado: activo, pausado (con motivo) o contrato finalizado. Filtra por nombre y por estado (por defecto solo activos). Úsala para encontrar el nombre exacto o el id antes de otras herramientas.",
    perfiles: TODOS,
    entrada: {
      texto: z.string().optional().describe("Parte del nombre del cliente"),
      estado: z
        .enum(["activos", "pausados", "contrato_finalizado", "inactivos", "todos"])
        .optional()
        .describe("inactivos = pausados + contrato finalizado. Por defecto: activos"),
      incluir_inactivos: z.boolean().optional().describe("Igual que estado=todos"),
    },
    async correr(a) {
      const q: any = {};
      const estado = a.estado ?? (a.incluir_inactivos ? "todos" : "activos");
      if (estado === "activos") q.isActive = { $ne: false };
      if (estado === "inactivos") q.isActive = false;
      if (estado === "contrato_finalizado") Object.assign(q, { isActive: false, "desactivacion.motivo": "fin_de_contrato" });
      if (estado === "pausados") Object.assign(q, { isActive: false, "desactivacion.motivo": { $ne: "fin_de_contrato" } });
      if (a.texto) q.name = new RegExp(String(a.texto).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const ws = await models.workspaces.find(q).select("name isActive desactivacion createdAt").sort({ name: 1 }).limit(200).lean();
      return { total: ws.length, clientes: ws.map((w: any) => ({ id: String(w._id), nombre: w.name, ...estadoEntorno(w) })) };
    },
  },
  {
    nombre: "ver_cliente",
    titulo: "Ficha de un cliente",
    descripcion:
      "Resumen en vivo de un cliente: su estado (activo, pausado con motivo o contrato finalizado), próximas producciones, estado del onboarding, último ánimo leído en Telegram y equipo con acceso.",
    perfiles: TODOS,
    entrada: { cliente: z.string().describe("Nombre o id del cliente") },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const hoy = new Date();
      const [workspace, producciones, onboarding, chats, equipo] = await Promise.all([
        models.workspaces.findById(ws._id).select("name isActive desactivacion createdAt metaAds.adAccountId").lean(),
        planningService.listEntries(String(ws._id), new Date(hoy.getTime() - 30 * 86_400_000)),
        onboardingProgresoService.detalle(String(ws._id)).catch(() => null),
        models.telegramChats.find({ workspaceId: ws._id, estado: "listo" }).select("firstName telegramUsername ultimoAnimo updatedAt").lean(),
        models.users.find({ "workspaces.workspaceId": ws._id, isInternal: true, isActive: { $ne: false } }).select("name email internalRole").lean(),
      ]);
      const verAnimo = ["direccion", "pm", "contenido"].includes(u.perfil);
      return {
        cliente: { id: String(ws._id), nombre: ws.name, desde: fecha((workspace as any)?.createdAt, false), ...estadoEntorno(workspace) },
        metaConectado: Boolean((workspace as any)?.metaAds?.adAccountId),
        producciones: producciones.map((p: any) => ({
          id: String(p._id), titulo: p.title, fecha: fecha(p.date), cumplida: p.cumplida === true, origen: p.source,
        })),
        onboarding: onboarding
          ? {
              porcentaje: onboarding.progreso.porcentaje,
              siguiente: onboarding.progreso.siguiente,
              bloqueado: onboarding.progreso.bloqueado,
              motivoBloqueo: onboarding.progreso.motivoBloqueo,
              pasos: onboarding.progreso.pasos.map((p) => ({ paso: p.paso, estado: p.estado, responsable: p.responsable })),
            }
          : null,
        telegram: {
          conectados: chats.length,
          ...(verAnimo
            ? { animo: chats.filter((c: any) => c.ultimoAnimo).map((c: any) => ({ quien: c.firstName, estado: c.ultimoAnimo.estado, motivo: c.ultimoAnimo.motivo, en: fecha(c.ultimoAnimo.en) })) }
            : {}),
        },
        equipo: equipo.map((e: any) => ({ nombre: e.name, correo: e.email, rol: e.internalRole })),
      };
    },
  },
  {
    nombre: "calendario_producciones",
    titulo: "Calendario de producciones",
    descripcion:
      "Producciones (grabaciones) de todos los clientes o de uno, en un rango de fechas. Por defecto, los próximos 14 días. Fechas en hora de Ecuador.",
    perfiles: TODOS,
    entrada: {
      desde: z.string().optional().describe("AAAA-MM-DD"),
      hasta: z.string().optional().describe("AAAA-MM-DD"),
      cliente: z.string().optional(),
    },
    async correr(a) {
      const desde = a.desde ? leerFecha(a.desde) : new Date(new Date().setHours(0, 0, 0, 0));
      const hasta = a.hasta ? leerFecha(`${a.hasta}T23:59`) : new Date(desde.getTime() + 14 * 86_400_000);
      const ids = a.cliente ? [String((await resolverCliente(a.cliente))._id)] : null;
      const entradas = await planningService.listEntriesAcross(ids, desde, hasta);
      return {
        rango: `${fecha(desde, false)} → ${fecha(hasta, false)}`,
        total: entradas.length,
        producciones: entradas.map((e: any) => ({
          id: String(e._id), cliente: e.workspaceName, titulo: e.title, fecha: fecha(e.date), cumplida: e.cumplida === true,
          delCrm: e.source === "crm",
        })),
      };
    },
  },
  {
    nombre: "mis_notificaciones",
    titulo: "Mis notificaciones",
    descripcion: "Tus notificaciones de metrics.bakano.ec (las mismas de la campanita), las más recientes primero.",
    perfiles: TODOS,
    entrada: { solo_no_leidas: z.boolean().optional(), cantidad: z.number().int().min(1).max(50).optional() },
    async correr(a, u) {
      const filtro: any = { userId: new Types.ObjectId(u._id) };
      if (a.solo_no_leidas) filtro.isRead = false;
      const [lista, noLeidas] = await Promise.all([
        models.notifications.find(filtro).sort({ createdAt: -1 }).limit(a.cantidad ?? 15).lean(),
        notificationService.getUnreadCount(u._id),
      ]);
      return {
        noLeidas,
        notificaciones: lista.map((n: any) => ({ tipo: n.type, titulo: n.title, detalle: recortar(n.body, 300), leida: n.isRead, en: fecha(n.createdAt) })),
      };
    },
  },
  {
    nombre: "metricas_cliente",
    titulo: "Métricas de un cliente",
    descripcion: "Facturación, gasto de Meta y ROAS del mes actual y el anterior, más los videos con más vistas del mes.",
    perfiles: ["direccion", "pm", "campanas", "contenido"],
    entrada: { cliente: z.string() },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      return { cliente: ws.name, ...(await metricasClienteService.resumen(ws._id)) };
    },
  },
  {
    nombre: "auditoria_mcp",
    titulo: "Quién usó el MCP",
    descripcion: "Registro de las herramientas que el equipo corrió en el MCP: quién, qué y si funcionó.",
    perfiles: ["direccion"],
    entrada: { dias: z.number().int().min(1).max(90).optional(), correo: z.string().optional(), solo_errores: z.boolean().optional() },
    async correr(a) {
      const q: any = { createdAt: { $gte: new Date(Date.now() - (a.dias ?? 7) * 86_400_000) } };
      if (a.correo) q.email = String(a.correo).toLowerCase();
      if (a.solo_errores) q.ok = false;
      const filas = await McpAuditoriaModel.find(q).sort({ createdAt: -1 }).limit(100).lean();
      return filas.map((f: any) => ({ en: fecha(f.createdAt), quien: f.email, perfil: f.perfil, tool: f.tool, ok: f.ok, error: f.error, ms: f.ms, args: recortar(f.args, 200) }));
    },
  },
];
