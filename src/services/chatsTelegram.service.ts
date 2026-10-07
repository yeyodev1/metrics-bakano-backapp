import { Types } from "mongoose";
import models from "../models";
import { usuarioBloqueado } from "../utils/contactosBloqueados";

/**
 * A quien se le escribe por Telegram.
 *
 * Los avisos al cliente van solo a chats de clientes: el equipo de Bakano
 * tambien tiene chats vinculados a los entornos y no tiene que recibir "tus
 * videos estan listos". Los contactos bloqueados por direccion quedan fuera
 * siempre.
 */

export async function chatsDeClienteDelEntorno(workspaceId: Types.ObjectId | string): Promise<{ chatId: number; userId?: Types.ObjectId }[]> {
  const chats = await models.telegramChats
    .find({ workspaceId: new Types.ObjectId(String(workspaceId)), estado: "listo" })
    .select("chatId userId")
    .lean();
  if (!chats.length) return [];
  const internos = new Set(
    (
      await models.users
        .find({ _id: { $in: chats.map((c) => c.userId).filter(Boolean) }, $or: [{ isInternal: true }, { role: "superadmin" }] })
        .select("_id")
        .lean()
    ).map((u) => String(u._id))
  );
  const destino: { chatId: number; userId?: Types.ObjectId }[] = [];
  for (const c of chats as any[]) {
    if (c.userId && internos.has(String(c.userId))) continue;
    if (c.userId && (await usuarioBloqueado(c.userId))) continue;
    destino.push({ chatId: c.chatId, userId: c.userId });
  }
  return destino;
}

/** Chats de una persona (del equipo o cliente), sin importar el entorno elegido. */
export async function chatsDeUsuario(userId: Types.ObjectId | string): Promise<number[]> {
  if (!userId || (await usuarioBloqueado(String(userId)))) return [];
  const chats = await models.telegramChats
    .find({ userId: new Types.ObjectId(String(userId)), estado: "listo" })
    .select("chatId")
    .lean();
  return [...new Set(chats.map((c) => c.chatId))];
}
