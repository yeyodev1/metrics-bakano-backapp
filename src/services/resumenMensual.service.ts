import models from "../models";
import { telegramService, type InlineButton } from "./telegram.service";
import { telegramAgentService } from "./telegramAgent.service";
import { metricasClienteService } from "./metricasCliente.service";
import { comoPlata } from "./facturacionChat.service";

/**
 * Resumen de cierre de mes para el cliente, por Telegram.
 *
 * Corre el dia 1 con el mes anterior ya cerrado: los numeros no se mueven
 * mas. Lo escribe la IA con los datos reales (facturacion, ROAS, meta del
 * mes) y con una regla de tono: se cuenta en positivo, y si el mes no dio,
 * se dice de frente y se cierra con que este mes se toma accion.
 *
 * Solo clientes: los chats del equipo de Bakano quedan fuera.
 */

const APP_URL = process.env.APP_URL || "https://metrics.bakano.ec";

export interface ResumenEnviado {
  entorno: string;
  mes: string;
  facturacion: number;
  cumplioObjetivo: boolean | null;
  chats: number[];
}

class ResumenMensualService {
  /** Chats de clientes agrupados por entorno activo. */
  private async chatsDeClientes(): Promise<Map<string, number[]>> {
    const chats = await models.telegramChats
      .find({ estado: "listo", workspaceId: { $ne: null } })
      .select("chatId workspaceId userId")
      .lean();
    if (!chats.length) return new Map();

    const internos = new Set(
      (
        await models.users
          .find({
            _id: { $in: chats.map((c) => c.userId).filter(Boolean) },
            $or: [{ isInternal: true }, { role: "superadmin" }],
          })
          .select("_id")
          .lean()
      ).map((u) => String(u._id))
    );

    const porEntorno = new Map<string, number[]>();
    for (const c of chats) {
      if (c.userId && internos.has(String(c.userId))) continue;
      porEntorno.set(String(c.workspaceId), [...(porEntorno.get(String(c.workspaceId)) ?? []), c.chatId]);
    }
    return porEntorno;
  }

  async enviar(): Promise<{ enviados: number; detalle: ResumenEnviado[] }> {
    const porEntorno = await this.chatsDeClientes();
    const detalle: ResumenEnviado[] = [];
    if (!porEntorno.size) return { enviados: 0, detalle };

    const workspaces = await models.workspaces
      .find({ _id: { $in: [...porEntorno.keys()] }, isActive: true })
      .select("name")
      .lean();

    for (const w of workspaces) {
      const chats = porEntorno.get(String(w._id)) ?? [];
      if (!chats.length) continue;

      const r = await metricasClienteService.mesCerrado(w._id as any);
      // Un mes sin un solo dia registrado no da para un resumen: seria
      // contarle al cliente que facturo cero cuando lo que falta es el dato.
      if (!r.diasRegistrados) {
        detalle.push({ entorno: w.name, mes: r.mes, facturacion: 0, cumplioObjetivo: null, chats: [] });
        continue;
      }

      const datos = {
        mes: r.nombreMes,
        facturacionDelMes: comoPlata(r.facturacion),
        gastoEnMeta: r.gastoMeta > 0 ? comoPlata(r.gastoMeta) : null,
        roasDelMes: r.roas,
        objetivoDelMes: r.objetivo ? comoPlata(r.objetivo) : null,
        porcentajeDelObjetivo: r.avanceObjetivo,
        cumplioObjetivo: r.cumplioObjetivo,
        mesAnterior: r.mesAnterior.facturacion > 0 ? comoPlata(r.mesAnterior.facturacion) : null,
        variacionVsMesAnteriorEnPorcentaje: r.variacionVsMesAnterior,
        diasRegistrados: r.diasRegistrados,
        diasDelMes: r.diasDelMes,
        diasSinRegistrar: r.diasSinRegistrar,
      };

      const instruccion =
        `Escríbele el cierre de ${r.nombreMes} a este cliente. Empieza saludando y dándole el número del mes. ` +
        "Cuéntalo SIEMPRE en positivo, sin exagerar ni prometer nada. " +
        (r.cumplioObjetivo === true
          ? "Llegó a la meta: celébralo con él y dile qué lo hizo posible según los datos."
          : r.cumplioObjetivo === false
            ? "No llegó a la meta: dilo de frente y sin dramatizar, reconoce lo que sí avanzó, y cierra diciendo que este mes vamos a tomar acción en eso."
            : "No hay meta definida para ese mes: no la menciones ni la inventes, compara con el mes anterior si hay dato.") +
        (r.diasSinRegistrar > 0
          ? ` Menciona en una línea que quedaron ${r.diasSinRegistrar} días sin registrar y que con eso completo el ROAS sale más fino.`
          : "") +
        " Máximo 6 líneas.";

      const chatBase = await models.telegramChats.findOne({ chatId: chats[0] });
      const texto = chatBase ? await telegramAgentService.comentar(chatBase, instruccion, datos) : null;
      const respaldo =
        `📊 <b>Cierre de ${r.nombreMes}</b>\n\n` +
        `Facturación: <b>${comoPlata(r.facturacion)}</b>` +
        (r.objetivo ? ` de una meta de ${comoPlata(r.objetivo)} (${r.avanceObjetivo}%)` : "") +
        (r.roas ? `\nROAS del mes: <b>${r.roas}</b> con ${comoPlata(r.gastoMeta)} en Meta` : "") +
        (r.cumplioObjetivo === false ? "\n\nNo llegamos a la meta: este mes tomamos acción en eso 💪" : "") +
        (r.diasSinRegistrar > 0 ? `\n\nQuedaron ${r.diasSinRegistrar} días sin registrar.` : "");

      const botones: InlineButton[][] = [
        [{ text: "📊 Ver mis métricas", callback_data: "fact:metricas" }],
        [{ text: "💵 Mi facturación del día", callback_data: "fact:ver" }],
        [{ text: "🌐 Abrir metrics.bakano.ec", url: `${APP_URL}/app/workspaces/${w._id}/billing` }],
      ];

      for (const chatId of chats) {
        await telegramService.sendMessage(chatId, texto || respaldo, botones).catch((error: any) => {
          console.error(`[Resumen mensual] no se pudo enviar al chat ${chatId}:`, error?.message || error);
        });
      }
      detalle.push({
        entorno: w.name,
        mes: r.mes,
        facturacion: r.facturacion,
        cumplioObjetivo: r.cumplioObjetivo,
        chats,
      });
    }

    return { enviados: detalle.filter((d) => d.chats.length).length, detalle };
  }
}

export const resumenMensualService = new ResumenMensualService();
