import { z } from "zod";
import { Types } from "mongoose";
import models from "../../models";
import { planningNotificationService } from "../../services/planningNotification.service";
import { telegramService } from "../../services/telegram.service";
import { usuarioBloqueado } from "../../utils/contactosBloqueados";
import type { PerfilMcp } from "../perfiles";
import { recortar, resolverCliente, type ToolMcp } from "./base";

/**
 * Hablarle al cliente sin salir de Claude: mandarle su planificacion y
 * escribirle por el bot. Todo el que trabaja con el cliente tiene que poder
 * hacerlo en el momento, sin pedirselo a otro ni abrir Telegram.
 */

const HABLAN_CON_EL_CLIENTE: PerfilMcp[] = ["direccion", "pm", "contenido"];

function escaparHtml(texto: string): string {
  return texto.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** La planificacion que toca mandar: la mas reciente con guiones y sin aprobar. */
async function planificacionPorEnviar(workspaceId: Types.ObjectId, planningId?: string) {
  if (planningId) {
    if (!Types.ObjectId.isValid(planningId)) throw new Error("Ese planning_id no es válido.");
    const p: any = await models.videoPlanning.findById(planningId).select("workspaceId items._id clienteAprobado listaParaCliente notificacionAbierta planningEntryId").lean();
    if (!p || String(p.workspaceId) !== String(workspaceId)) throw new Error("Esa planificación no es de este cliente.");
    return p;
  }
  const p: any = await models.videoPlanning
    .findOne({ workspaceId, clienteAprobado: { $ne: true }, "items.0": { $exists: true } })
    .sort({ createdAt: -1 })
    .select("workspaceId items._id clienteAprobado listaParaCliente notificacionAbierta planningEntryId")
    .lean();
  if (!p) throw new Error("Este cliente no tiene ninguna planificación con guiones pendiente de aprobar.");
  return p;
}

export const toolsClienteDirecto: ToolMcp[] = [
  {
    nombre: "enviar_planificacion",
    titulo: "Mandarle la planificación al cliente",
    descripcion:
      "Le avisa al cliente que su planificación (sus guiones) está lista para revisar: por Telegram (bot), WhatsApp y correo, igual que el botón 'Notificar al cliente' de Metrics. " +
      "Si no estaba marcada como lista, la marca. Sin planning_id usa la más reciente sin aprobar. " +
      "Si el cliente tiene pagos vencidos, el aviso le dice que primero tiene que pagar para verlos. Confirma con la persona antes.",
    perfiles: HABLAN_CON_EL_CLIENTE,
    escribe: true,
    entrada: {
      cliente: z.string(),
      planning_id: z.string().optional().describe("De ver_planificacion; si no se da, la más reciente sin aprobar"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const p = await planificacionPorEnviar(ws._id, a.planning_id);
      if (p.clienteAprobado) throw new Error("El cliente ya aprobó esa planificación: no hay nada que mandarle.");
      if (p.notificacionAbierta === false) {
        throw new Error("El ciclo de avisos de esa planificación está cerrado (el cliente ya respondió). Si hay que reabrirla, se hace desde Metrics.");
      }
      if (!p.listaParaCliente) {
        await models.videoPlanning.updateOne(
          { _id: p._id },
          { $set: { listaParaCliente: true, listaMarcadaEn: new Date(), listaMarcadaPor: new Types.ObjectId(u._id) } }
        );
      }
      const r = await planningNotificationService.notificar(String(p._id), u.nombre);
      return {
        cliente: ws.name,
        guiones: p.items?.length ?? 0,
        telegram: r.telegram.enviado
          ? r.telegram.bloqueadoPorPago
            ? "Enviado, pero con el aviso de que primero tiene que pagar: tiene pagos vencidos."
            : `Enviado (${r.telegram.chats} chat${r.telegram.chats === 1 ? "" : "s"}).`
          : r.telegram.error,
        whatsapp: r.whatsapp.enviado ? "Enviado." : r.whatsapp.error,
        correo: r.email.enviado ? `Enviado a ${r.email.destinatarios.join(", ")}.` : r.email.error,
      };
    },
  },
  {
    nombre: "escribir_cliente_telegram",
    titulo: "Escribirle al cliente por Telegram",
    descripcion:
      "Le manda un mensaje al cliente por el bot de Bakano (@BakanoAgencyBot), firmado con tu nombre. Para avisos puntuales: una duda sobre un guion, una promo, un cambio. " +
      "Escribe el texto tal cual lo leerá el cliente y confírmalo con la persona antes de mandarlo.",
    perfiles: HABLAN_CON_EL_CLIENTE,
    escribe: true,
    entrada: {
      cliente: z.string(),
      mensaje: z.string().min(2).max(3000).describe("El texto exacto que leerá el cliente"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const chats: any[] = await models.telegramChats.find({ workspaceId: ws._id, estado: "listo" }).select("chatId userId").lean();
      const destino = [];
      for (const c of chats) if (!(c.userId && (await usuarioBloqueado(c.userId)))) destino.push(c);
      if (!destino.length) {
        return `${ws.name} no tiene el bot de Telegram conectado. Escríbele por correo o pídele a Genesis que lo conecte.`;
      }
      const texto = `${escaparHtml(a.mensaje.trim())}\n\n— <b>${escaparHtml(u.nombre)}</b>, equipo Bakano`;
      let enviados = 0;
      for (const c of destino) {
        await telegramService
          .sendMessage(c.chatId, texto)
          .then(() => enviados++)
          .catch((e: any) => console.error("[MCP] escribir por Telegram:", e?.message || e));
      }
      return enviados
        ? `Listo, le llegó a ${ws.name} por Telegram: "${recortar(a.mensaje, 120)}"`
        : `No se pudo enviar a ${ws.name} por Telegram. Inténtalo de nuevo en un momento.`;
    },
  },
];
