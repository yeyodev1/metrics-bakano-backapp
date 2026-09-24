import { Types } from "mongoose";
import models from "../models";
import { fechaEcuador } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { CAMPOS_MARCA } from "./onboardingDatos.service";
import { ORDEN_RECORRIDO, RECORRIDO, type EtapaRecorrido } from "./onboardingSesiones.service";

/**
 * El recorrido del cliente, de la bienvenida a la salida a ventas.
 *
 * El cliente lo ve entero, tambien lo que pasa dentro del equipo: saber que
 * su video esta en la mesa de Javier y no "en proceso" es la diferencia entre
 * esperar tranquilo y escribir preguntando.
 *
 * La mayoria de las etapas se deducen de datos que ya existen (las sesiones
 * agendadas, los guiones cargados, la produccion marcada como grabada). Las
 * que no dejan rastro —los avatares, las escenas, la aprobacion de los videos
 * y la salida a ventas— las marca el equipo en Metrics.
 */

export type EstadoEtapa = "pendiente" | "en_curso" | "listo" | "no_aplica";

export interface EtapaCliente {
  etapa: EtapaRecorrido;
  orden: number;
  etiqueta: string;
  emoji: string;
  que: string;
  deQuien: "cliente" | "equipo";
  responsable?: string;
  responsableEmail?: string;
  seMarca: "automatico" | "manual";
  estado: EstadoEtapa;
  detalle?: string;
  /** Quien y cuando la movio, cuando la marco una persona. */
  porNombre?: string;
  en?: Date;
  nota?: string;
}

const ESTADOS: EstadoEtapa[] = ["pendiente", "en_curso", "listo", "no_aplica"];

class RecorridoClienteService {
  /** El recorrido completo con el estado real de cada etapa. */
  async de(workspaceId: Types.ObjectId | string): Promise<{ etapas: EtapaCliente[]; actual?: EtapaRecorrido; listas: number }> {
    const [workspace, estadoOnb, planes, produccion, chatVinculado] = await Promise.all([
      models.workspaces.findById(workspaceId).select("brandProfile recorrido").lean(),
      onboardingBotService.estado(workspaceId as Types.ObjectId).catch(() => null),
      models.videoPlanning.find({ workspaceId }).select("items listaParaCliente").lean(),
      models.planning
        .findOne({ workspaceId, cancelada: { $ne: true }, title: { $not: /^CANCELADA/ } })
        .sort({ date: -1 })
        .select("date cumplida")
        .lean(),
      // Si el cliente ya esta en el chat, la bienvenida ocurrio: fue ahi donde
      // Genesis creo el entorno y salio su invitacion.
      models.telegramChats.exists({ workspaceId, estado: "listo" }),
    ]);

    const marcas = ((workspace as any)?.recorrido || {}) as Record<string, any>;
    const marca = (brandProfile: Record<string, unknown>) =>
      Object.keys(CAMPOS_MARCA).filter((c) => String(brandProfile[c] ?? "").trim()).length;
    const perfil = ((workspace as any)?.brandProfile || {}) as Record<string, unknown>;
    const camposLlenos = marca(perfil);
    const camposTotal = Object.keys(CAMPOS_MARCA).length;

    const items = (planes as any[]).flatMap((p) => p.items || []);
    const guiones = items.length;
    const aprobados = items.filter((i: any) => i.clienteAprobacion === "APROBADO").length;
    const editados = items.filter((i: any) => i.edicion === "EDITADO").length;

    const sesion = (clave: string) => estadoOnb?.sesiones.find((s: any) => s.sesion === clave);

    const etapas: EtapaCliente[] = ORDEN_RECORRIDO.map((clave) => {
      const def = RECORRIDO[clave];
      const guardada = marcas[clave];
      let estado: EstadoEtapa = "pendiente";
      let detalle: string | undefined;

      if (def.seMarca === "manual") {
        estado = ESTADOS.includes(guardada?.estado) ? guardada.estado : "pendiente";
        detalle = guardada?.nota;
      } else if (clave === "bienvenida") {
        const s = sesion("bienvenida");
        estado = chatVinculado || s?.estado === "cumplida" ? "listo" : s?.estado === "no_aplica" ? "no_aplica" : "en_curso";
        detalle = chatVinculado ? "Ya estás conectado al bot" : undefined;
      } else if (clave === "especializacion" || clave === "levantamiento") {
        const s = sesion(clave);
        estado = s?.estado === "cumplida" ? "listo" : s?.estado === "no_aplica" ? "no_aplica" : s?.agendada ? "en_curso" : "pendiente";
        detalle = s?.fecha ? fechaEcuador(new Date(s.fecha)) : undefined;
      } else if (clave === "datosMarca") {
        estado = camposLlenos >= camposTotal ? "listo" : camposLlenos ? "en_curso" : "pendiente";
        detalle = `${camposLlenos} de ${camposTotal} datos`;
      } else if (clave === "guiones") {
        estado = guiones ? "listo" : "pendiente";
        detalle = guiones ? `${guiones} guiones escritos` : undefined;
      } else if (clave === "aprobacionGuiones") {
        estado = !guiones ? "pendiente" : aprobados >= guiones ? "listo" : aprobados ? "en_curso" : "pendiente";
        detalle = guiones ? `${aprobados} de ${guiones} aprobados` : undefined;
      } else if (clave === "produccion") {
        estado = produccion?.cumplida ? "listo" : produccion ? "en_curso" : "pendiente";
        detalle = produccion?.date ? fechaEcuador(new Date(produccion.date)) : undefined;
      } else if (clave === "edicion") {
        estado = !guiones ? "pendiente" : editados >= guiones ? "listo" : editados ? "en_curso" : "pendiente";
        detalle = guiones ? `${editados} de ${guiones} editados` : undefined;
      }

      return {
        etapa: clave,
        orden: def.orden,
        etiqueta: def.etiqueta,
        emoji: def.emoji,
        que: def.que,
        deQuien: def.deQuien,
        responsable: def.responsable?.nombre,
        responsableEmail: def.responsable?.email,
        seMarca: def.seMarca,
        estado,
        detalle,
        porNombre: guardada?.porNombre,
        en: guardada?.en,
        nota: guardada?.nota,
      };
    });

    const actual = etapas.find((e) => e.estado === "en_curso")?.etapa ?? etapas.find((e) => e.estado === "pendiente")?.etapa;
    return { etapas, actual, listas: etapas.filter((e) => e.estado === "listo" || e.estado === "no_aplica").length };
  }

  /** El equipo mueve una etapa desde Metrics. Solo las que no dejan rastro solas. */
  async marcar(
    workspaceId: Types.ObjectId | string,
    etapa: string,
    estado: EstadoEtapa,
    quien: { nombre: string; userId?: Types.ObjectId },
    nota?: string
  ): Promise<{ ok: boolean; motivo?: string }> {
    if (!(etapa in RECORRIDO)) return { ok: false, motivo: "etapa_desconocida" };
    if (!ESTADOS.includes(estado)) return { ok: false, motivo: "estado_invalido" };
    if (RECORRIDO[etapa as EtapaRecorrido].seMarca !== "manual") {
      return { ok: false, motivo: "esa_etapa_se_deduce_sola" };
    }

    await models.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          [`recorrido.${etapa}`]: {
            estado,
            en: new Date(),
            porNombre: quien.nombre,
            nota: nota?.slice(0, 500),
          },
        },
      }
    );
    return { ok: true };
  }

  /** El recorrido en texto para el chat del cliente. */
  enTexto(etapas: EtapaCliente[]): string {
    const icono: Record<EstadoEtapa, string> = { listo: "✅", en_curso: "🔄", pendiente: "⬜", no_aplica: "➖" };
    return etapas
      .map((e) => {
        const quien = e.responsable ? ` · ${e.responsable}` : "";
        const detalle = e.detalle ? ` · ${e.detalle}` : "";
        return `${icono[e.estado]} ${e.emoji} <b>${e.etiqueta}</b>${quien}${detalle}`;
      })
      .join("\n");
  }
}

export const recorridoClienteService = new RecorridoClienteService();
