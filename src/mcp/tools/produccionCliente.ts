import { z } from "zod";
import models from "../../models";
import { atencionClienteService, fechaEcuador, frecuenciaEnTexto } from "../../services/atencionCliente.service";
import { produccionAnticipadaService } from "../../services/produccionAnticipada.service";
import { PlanningService } from "../../services/planning.service";
import { fecha, leerFecha, resolverCliente, type ToolMcp } from "./base";

const planningService = new PlanningService();

/**
 * Cada cliente graba a su ritmo: hay quien necesita una producción al mes y
 * quien con una cada seis meses tiene de sobra. Esto lo ajusta el equipo, y el
 * bot lo respeta cuando el cliente agenda solo.
 */
export const toolsProduccionCliente: ToolMcp[] = [
  {
    nombre: "frecuencia_produccion",
    titulo: "Cada cuánto graba un cliente",
    descripcion:
      "Cambia cada cuántos meses puede agendar su producción un cliente (1 = una al mes). Sin 'meses' solo muestra cómo está y desde cuándo puede agendar. " +
      "Los 6 meses son el punto de partida, no un absoluto: contenido lo va ajustando cliente por cliente. " +
      "Aprobar sus guiones siempre le deja agendar al instante, y con pagos vencidos nunca puede. Confirma con la persona antes de cambiarlo.",
    perfiles: ["direccion", "pm", "contenido"],
    escribe: true,
    entrada: {
      cliente: z.string(),
      meses: z.number().int().min(1).max(12).optional().describe("Cada cuántos meses; vacío para solo consultar"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      if (a.meses) {
        await models.workspaces.updateOne(
          { _id: ws._id },
          { $set: { "produccion.mesesEntre": a.meses, "produccion.mesesEntrePorNombre": u.nombre } }
        );
      }
      const estado = await atencionClienteService.estadoProduccion(ws._id);
      return {
        cliente: ws.name,
        frecuencia: frecuenciaEnTexto(estado.mesesEntre ?? 6),
        ...(a.meses ? { cambiado: true } : {}),
        puedeAgendar: estado.puedeAgendar,
        motivo:
          estado.bloqueo === "pago_pendiente"
            ? `Tiene pagos vencidos (${estado.deudaTexto}).`
            : estado.bloqueo === "ya_agendada"
              ? `Ya tiene una agendada el ${fechaEcuador(estado.proxima!)}.`
              : estado.bloqueo === "falta_ariana"
                ? "Le falta la reunión con Ariana."
                : undefined,
        desde: estado.habilitadaDesde ? fechaEcuador(estado.habilitadaDesde) : null,
        porGuionesAprobados: estado.porGuionesAprobados ?? false,
        pidioGrabarAntes: estado.solicitudPendiente ?? false,
      };
    },
  },
  {
    nombre: "responder_produccion_antes",
    titulo: "Responder a un cliente que quiere grabar antes",
    descripcion:
      "Cuando un cliente pide grabar antes de lo que le toca por su frecuencia, el bot no le dice que no: te lo pasa y te lo recuerda cada día hasta que respondas. " +
      "Sin cliente: lista quién está esperando respuesta. Con cliente y 'aprobar': sí le abre 30 días para agendar ya; no, se le explica. El cliente se entera por Telegram al momento. " +
      "Confirma la decisión con la persona antes de mandarla.",
    perfiles: ["direccion", "pm", "contenido"],
    escribe: true,
    entrada: {
      cliente: z.string().optional(),
      aprobar: z.boolean().optional(),
      mensaje: z.string().max(500).optional().describe("Nota para el cliente, tal cual la leerá (opcional)"),
    },
    async correr(a, u) {
      if (!a.cliente) {
        const lista = await produccionAnticipadaService.pendientes();
        return lista.length
          ? lista.map((p) => ({ cliente: p.cliente, motivo: p.solicitud.motivo, pidioEl: fechaEcuador(new Date(p.solicitud.en)) }))
          : "Nadie está esperando respuesta para grabar antes.";
      }
      if (a.aprobar === undefined) throw new Error("Dime si se aprueba o no.");
      const ws = await resolverCliente(a.cliente);
      const r = await produccionAnticipadaService.responder(ws._id, a.aprobar, { nombre: u.nombre }, a.mensaje);
      if (!r.ok) throw new Error("No encontré ese cliente.");
      return a.aprobar
        ? `Listo: ${ws.name} puede agendar su producción ya (hasta el ${fechaEcuador(r.hasta!)}). Se lo avisé por Telegram.`
        : `Listo: le avisé a ${ws.name} por Telegram que por ahora no hace falta adelantar la producción.`;
    },
  },
  {
    nombre: "producciones_por_cerrar",
    titulo: "Producciones pasadas sin marcar como realizadas",
    descripcion:
      "Producciones que ya pasaron y siguen sin marcarse como realizadas (de un cliente o de todos), con su id, fecha y si vienen del CRM. " +
      "Trae también las que parecen duplicadas (dos producciones del mismo cliente el mismo día). Solo lectura. Úsala antes de marcar_produccion_realizada.",
    perfiles: ["direccion", "pm", "produccion", "contenido"],
    entrada: {
      cliente: z.string().optional().describe("Nombre o id del cliente; sin esto, todos"),
      dias: z.number().int().min(1).max(365).optional().describe("Cuántos días hacia atrás (por defecto 90)"),
    },
    async correr(a) {
      const ws = a.cliente ? await resolverCliente(a.cliente) : null;
      const desde = new Date(Date.now() - (a.dias ?? 90) * 86_400_000);
      const lista = await models.planning
        .find({
          ...(ws ? { workspaceId: ws._id } : {}),
          date: { $gte: desde, $lte: new Date() },
          cumplida: { $ne: true },
          cancelada: { $ne: true },
          title: { $not: /^CANCELADA/ },
        })
        .sort({ date: 1 })
        .select("workspaceId title date source crm.appointmentId")
        .populate("workspaceId", "name")
        .lean();
      const dia = (d: Date) => new Date(d.getTime() - 5 * 3_600_000).toISOString().slice(0, 10);
      const porDia = new Map<string, number>();
      for (const p of lista as any[]) {
        const k = `${p.workspaceId?._id}|${dia(p.date)}`;
        porDia.set(k, (porDia.get(k) ?? 0) + 1);
      }
      return {
        total: lista.length,
        producciones: (lista as any[]).map((p) => ({
          id: String(p._id),
          cliente: p.workspaceId?.name ?? "?",
          titulo: p.title,
          fecha: fecha(p.date),
          delCrm: Boolean(p.crm?.appointmentId),
          posibleDuplicado: (porDia.get(`${p.workspaceId?._id}|${dia(p.date)}`) ?? 0) > 1,
        })),
      };
    },
  },
  {
    nombre: "marcar_produccion_realizada",
    titulo: "Marcar una producción como realizada",
    descripcion:
      "Marca (o desmarca con realizada=false) que una producción ya se grabó, igual que el check de la plataforma. Pasa el id de producciones_por_cerrar, o el cliente y la fecha (AAAA-MM-DD). " +
      "No se puede con producciones canceladas ni futuras. No avisa al cliente. Confirma con la persona antes.",
    perfiles: ["direccion", "pm", "produccion"],
    escribe: true,
    entrada: {
      produccion_id: z.string().optional().describe("Id de la producción"),
      cliente: z.string().optional().describe("Nombre o id del cliente (si no pasas el id)"),
      fecha: z.string().optional().describe("AAAA-MM-DD de la producción (si no pasas el id)"),
      realizada: z.boolean().optional().describe("false para desmarcarla; por defecto true"),
    },
    async correr(a, u) {
      let id = a.produccion_id as string | undefined;
      if (!id) {
        if (!a.cliente || !a.fecha) throw new Error("Pásame el id de la producción, o el cliente y la fecha.");
        const ws = await resolverCliente(a.cliente);
        const d = leerFecha(a.fecha);
        const inicio = new Date(d.getTime() - 9 * 3_600_000);
        const fin = new Date(inicio.getTime() + 24 * 3_600_000);
        const del = await models.planning
          .find({ workspaceId: ws._id, date: { $gte: inicio, $lt: fin }, title: { $not: /^CANCELADA/ } })
          .select("_id title date")
          .lean();
        if (!del.length) throw new Error(`${ws.name} no tiene producción el ${a.fecha}.`);
        if (del.length > 1) {
          throw new Error(
            `${ws.name} tiene ${del.length} producciones ese día: ${del.map((p: any) => `${p.title} (${fecha(p.date)}, id ${p._id})`).join("; ")}. Dime cuál por su id.`
          );
        }
        id = String(del[0]!._id);
      }
      const MOTIVOS: Record<string, string> = {
        INVALID_ID: "Ese id de producción no es válido.",
        NOT_FOUND: "No encontré esa producción.",
        PRODUCCION_CANCELADA: "Esa producción está cancelada: no se marca como realizada.",
        PRODUCCION_FUTURA: "Esa producción todavía no llega: se marca cuando ya se hizo.",
      };
      const entry: any = await planningService
        .marcarRealizada(id, a.realizada !== false, { id: u._id, nombre: u.nombre })
        .catch((e: any) => {
          throw new Error(MOTIVOS[e?.message] || e?.message);
        });
      return { id, titulo: entry.title, fecha: fecha(entry.date), realizada: Boolean(entry.cumplida), marcadaPor: entry.cumplidaPorNombre ?? null };
    },
  },
];
