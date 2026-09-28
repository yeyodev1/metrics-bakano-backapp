import { Types } from "mongoose";
import models from "../models";
import { contratoChatService } from "./contratoChat.service";
import { onboardingDatosService } from "./onboardingDatos.service";

/**
 * Lectura de una conversación del bot, para el equipo.
 *
 * Leer el chat solo no alcanza: el bot promete cosas ("ya le pasé a Genesis")
 * y el chat no dice si pasaron, y lo que el cliente pidió puede haberse
 * resuelto después por otro lado (ej. le mandamos el contrato por correo).
 * Aquí se juntan el chat y los HECHOS del sistema, y la IA explica dónde se
 * trabó, por qué, qué ya se resolvió y qué hacer, sin inventar.
 */

const modelo = () => process.env.AI_MODEL || "google/gemini-3.8-flash";
const LIMITE_MS = 40_000;

const importarEsm = new Function("modulo", "return import(modulo)") as (modulo: string) => Promise<any>;
async function cargarAi(): Promise<typeof import("ai")> {
  try {
    return require("ai");
  } catch (error: any) {
    if (error?.code !== "ERR_REQUIRE_ESM" && !/ES Module/i.test(String(error?.message))) throw error;
    return importarEsm("ai");
  }
}

function fechaEc(d?: Date | string | null): string | null {
  if (!d) return null;
  return new Date(d).toLocaleString("es-EC", { timeZone: "America/Guayaquil", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
}

export interface LecturaConversacion {
  resumen: string;
  seTrabo: { que: string; porque: string; vecesQueLoPidio?: number }[];
  promesasDelBot: { promesa: string; seCumplio: "si" | "no" | "no_se"; evidencia: string }[];
  yaResuelto: string[];
  faltaDelCliente: string[];
  siguientesPasos: { accion: string; responsable: string }[];
  mejoraParaElBot?: string;
}

class LecturaConversacionService {
  /** Lo que el sistema sabe del cliente, para cruzar con el chat. Sin IA: se puede mostrar siempre. */
  async hechos(workspaceId: Types.ObjectId) {
    const hace14 = new Date(Date.now() - 14 * 86_400_000);
    const [w, correo, pendientes, solicitudes, incidentes]: any[] = await Promise.all([
      models.workspaces.findById(workspaceId).select("name isActive desactivacion onboardingStatus contractData.firmadoEn").lean(),
      contratoChatService.estadoCorreo(workspaceId).catch(() => null),
      onboardingDatosService.pendientes(workspaceId).catch(() => null),
      models.notifications
        .find({ workspaceId, type: "solicitud_cliente", createdAt: { $gte: hace14 } })
        .sort({ createdAt: -1 })
        .limit(60)
        .populate("userId", "name")
        .select("title body createdAt isRead userId")
        .lean(),
      models.incidentes.find({ workspaceId, createdAt: { $gte: hace14 } }).select("estado frase motivo createdAt").lean().catch(() => []),
    ]);

    // Una notificación por persona del equipo: se juntan por mensaje.
    const avisos = new Map<string, { mensaje: string; en: string | null; recibieron: string[]; alguienLoLeyo: boolean }>();
    for (const n of solicitudes) {
      const clave = `${n.body}|${Math.floor(new Date(n.createdAt).getTime() / 60_000)}`;
      const a = avisos.get(clave) ?? { mensaje: n.body, en: fechaEc(n.createdAt), recibieron: [] as string[], alguienLoLeyo: false };
      if (n.userId?.name) a.recibieron.push(n.userId.name);
      a.alguienLoLeyo ||= n.isRead;
      avisos.set(clave, a);
    }

    return {
      entornoActivo: w?.isActive !== false,
      ...(w?.isActive === false ? { pausa: w.desactivacion?.motivo } : {}),
      contrato: {
        firmado: Boolean(w?.onboardingStatus?.contractSubmitted),
        firmadoEn: fechaEc(w?.contractData?.firmadoEn),
        ultimoCorreo: correo?.enviadoEn ? { a: correo.correo, en: fechaEc(correo.enviadoEn), estado: correo.estado } : null,
      },
      entregablesPendientes: (pendientes?.entregables || []).filter((e: any) => e.estado !== "verificado").map((e: any) => `${e.etiqueta}: ${e.estado}`),
      sesionesPorAgendar: (pendientes?.sesionesPendientes || []).map((s: any) => `${s.etiqueta} (con ${s.con?.nombre || s.con || "el equipo"})`),
      avisosQueLlegaronAlEquipo: [...avisos.values()],
      incidentes: incidentes.map((i: any) => ({ estado: i.estado, frase: i.frase, motivo: i.motivo, en: fechaEc(i.createdAt) })),
    };
  }

  async leer(params: {
    cliente: string;
    quien: string;
    mensajes: { de: string; texto: string; en: string | null }[];
    hechos: Awaited<ReturnType<LecturaConversacionService["hechos"]>>;
    esperandoArchivo?: string | null;
  }): Promise<LecturaConversacion | { error: string }> {
    const { generateText } = await cargarAi();
    const sistema = [
      "Eres analista del equipo de Bakano (agencia de marketing en Ecuador). Lees la conversación de un cliente con el bot de Telegram de Bakano y le explicas al equipo qué está pasando.",
      "Reglas:",
      "- Usa SOLO la conversación y los HECHOS que te paso. No inventes nombres, fechas ni estados.",
      "- Cruza el chat con los hechos: si el cliente pidió algo que los hechos muestran ya resuelto (por ejemplo, un correo del contrato enviado DESPUÉS de sus mensajes), va en yaResuelto y NO como pendiente.",
      "- Si el bot dijo que avisó o le pasó algo a alguien, revisa avisosQueLlegaronAlEquipo: si hay uno de esa fecha, seCumplio=si; si no hay, seCumplio=no; si no se puede saber, no_se. Pon la evidencia.",
      "- seTrabo: pedidos que el cliente repitió o que el bot no pudo resolver, con el porqué real (límite del bot, falta de un dato, nadie respondió...).",
      "- Si hay avisosQueLlegaronAlEquipo con alguienLoLeyo=false que todavía importan, di quién no lo ha leído y ponlo en siguientesPasos para esa persona.",
      "- siguientesPasos: acciones concretas con responsable (nombre de la persona si aparece en el chat o en los hechos; si no, el rol).",
      "- mejoraParaElBot: una frase si el bot hizo algo mal (repetirse, prometer sin cumplir, no escalar); si no, omítelo.",
      "- Español neutro, directo y corto. Responde SOLO con JSON válido, sin markdown, con esta forma:",
      '{"resumen":"","seTrabo":[{"que":"","porque":"","vecesQueLoPidio":0}],"promesasDelBot":[{"promesa":"","seCumplio":"si|no|no_se","evidencia":""}],"yaResuelto":[""],"faltaDelCliente":[""],"siguientesPasos":[{"accion":"","responsable":""}],"mejoraParaElBot":""}',
    ].join("\n");
    const datos = {
      cliente: params.cliente,
      quienEscribe: params.quien,
      ahora: fechaEc(new Date()),
      botEsperaUnArchivo: params.esperandoArchivo || null,
      hechos: params.hechos,
      conversacion: params.mensajes,
    };
    try {
      const { text } = await generateText({
        model: modelo(),
        system: sistema,
        prompt: JSON.stringify(datos),
        abortSignal: AbortSignal.timeout(LIMITE_MS),
      });
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      const r = JSON.parse(json) as LecturaConversacion;
      return {
        resumen: String(r.resumen || ""),
        seTrabo: Array.isArray(r.seTrabo) ? r.seTrabo : [],
        promesasDelBot: Array.isArray(r.promesasDelBot) ? r.promesasDelBot : [],
        yaResuelto: Array.isArray(r.yaResuelto) ? r.yaResuelto : [],
        faltaDelCliente: Array.isArray(r.faltaDelCliente) ? r.faltaDelCliente : [],
        siguientesPasos: Array.isArray(r.siguientesPasos) ? r.siguientesPasos : [],
        ...(r.mejoraParaElBot ? { mejoraParaElBot: String(r.mejoraParaElBot) } : {}),
      };
    } catch (error: any) {
      console.error("[Lectura conversación] IA:", error?.message || error);
      return { error: "La IA no respondió a tiempo. Los hechos de arriba sí están al día." };
    }
  }
}

export const lecturaConversacionService = new LecturaConversacionService();
