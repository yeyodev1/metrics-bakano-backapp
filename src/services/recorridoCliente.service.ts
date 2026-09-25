import { Types } from "mongoose";
import models from "../models";
import { fechaEcuador } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";
import { CAMPOS_MARCA } from "./onboardingDatos.service";
import { ORDEN_RECORRIDO, RECORRIDO, type EtapaRecorrido } from "./onboardingSesiones.service";
import { telegramService } from "./telegram.service";

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
  /** Lo que deduce el sistema, cuando alguien marcó algo distinto a mano. */
  segunElSistema?: EstadoEtapa;
}

const ESTADOS: EstadoEtapa[] = ["pendiente", "en_curso", "listo", "no_aplica"];

class RecorridoClienteService {
  /** El recorrido completo con el estado real de cada etapa. */
  async de(workspaceId: Types.ObjectId | string): Promise<{ etapas: EtapaCliente[]; actual?: EtapaRecorrido; listas: number }> {
    const [workspace, estadoOnb, planes, produccion, chatVinculado, accesos] = await Promise.all([
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
      // Quien del entorno ya recibio su invitacion y su acceso a la academia.
      models.users
        .find({
          isActive: true,
          isInternal: { $ne: true },
          $or: [{ workspaceId }, { "workspaces.workspaceId": workspaceId }],
        })
        .select("presentacionBotEnviadaEn accesoBakanologyEn")
        .lean(),
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
      } else if (clave === "accesos") {
        const invitados = (accesos as any[]).filter((u) => u.presentacionBotEnviadaEn).length;
        estado = !accesos.length ? "pendiente" : invitados >= accesos.length ? "listo" : invitados ? "en_curso" : "pendiente";
        detalle = accesos.length ? `${invitados} de ${accesos.length} personas invitadas` : "sin usuarios todavía";
      } else if (clave === "logueoTelegram") {
        estado = chatVinculado ? "listo" : "pendiente";
        detalle = chatVinculado ? "conectado" : undefined;
      } else if (clave === "bakanology") {
        const conAcceso = (accesos as any[]).filter((u) => u.accesoBakanologyEn).length;
        estado = !accesos.length ? "pendiente" : conAcceso >= accesos.length ? "listo" : conAcceso ? "en_curso" : "pendiente";
        detalle = accesos.length ? `${conAcceso} de ${accesos.length} con acceso` : undefined;
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

      // Lo que alguien marcó a mano manda sobre lo deducido: el equipo ve
      // cosas que los datos no cuentan. Pero se guarda lo que el sistema cree,
      // para poder mostrar cuándo no coinciden.
      const segunElSistema = estado;
      if (def.seMarca !== "manual" && ESTADOS.includes(guardada?.estado)) {
        estado = guardada.estado;
        if (guardada.nota) detalle = guardada.nota;
      }

      return {
        etapa: clave,
        orden: def.orden,
        segunElSistema: def.seMarca === "manual" ? undefined : segunElSistema,
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

  /**
   * Le avisa al cliente que acaba de cerrar un paso.
   *
   * No es decoracion: el cliente que no ve avanzar su proceso escribe
   * preguntando, o peor, se queda callado pensando que nadie esta trabajando.
   * Cada paso cerrado se celebra UNA vez y se le dice que sigue y de quien
   * depende.
   */
  async celebrar(workspaceId: Types.ObjectId | string, etapa: EtapaRecorrido): Promise<boolean> {
    const def = RECORRIDO[etapa];
    if (!def) return false;

    const chats = await models.telegramChats.find({ workspaceId, estado: "listo" }).select("chatId").lean();
    if (!chats.length) return false;

    const { etapas } = await this.de(workspaceId);
    const hechas = etapas.filter((e) => e.estado === "listo" || e.estado === "no_aplica").length;
    const siguiente = etapas.find((e) => e.orden > def.orden && e.estado !== "listo" && e.estado !== "no_aplica");

    const cierre = siguiente
      ? `👉 <b>Lo que sigue:</b> ${siguiente.emoji} ${siguiente.etiqueta}` +
        (siguiente.responsable ? ` · con <b>${siguiente.responsable}</b>` : "") +
        `\n${siguiente.que}` +
        (siguiente.deQuien === "cliente" ? "\n\nEsta te toca a ti: cuando quieras, me dices y lo vemos por aquí." : "\n\nDe eso nos encargamos nosotros, no tienes que hacer nada.")
      : "Y con eso <b>terminaste tu recorrido</b> 🚀 De aquí en adelante es puro seguimiento: tus videos saliendo y tus números subiendo.";

    const texto =
      `🎉 <b>¡Listo!</b> ${def.emoji} <b>${def.etiqueta}</b>\n\n` +
      `${def.que}\n\n` +
      `Llevas <b>${hechas} de ${etapas.length}</b> pasos.\n\n${cierre}`;

    for (const chat of chats as any[]) {
      await telegramService
        .sendMessage(chat.chatId, texto, [
          [{ text: "🚀 Ver mi recorrido", callback_data: "menu:onboarding" }],
          [{ text: "📋 Ver menú", callback_data: "menu:ver" }],
        ])
        .catch((error: any) => console.error("[Recorrido] felicitación:", error?.message || error));
    }

    await models.workspaces.updateOne(
      { _id: workspaceId },
      { $set: { [`recorrido.${etapa}.avisadoEn`]: new Date(), [`recorrido.${etapa}.avisadoComo`]: "listo" } }
    );
    return true;
  }

  /**
   * Las etapas que se cierran solas (una reunion marcada en el CRM, los
   * guiones cargados, la produccion grabada) no pasan por ningun boton: nadie
   * las anunciaria. Esto las detecta y las celebra, una sola vez cada una.
   */
  async revisarYCelebrar(workspaceId: Types.ObjectId | string): Promise<number> {
    const workspace = await models.workspaces.findById(workspaceId).select("recorrido").lean();
    const marcas = ((workspace as any)?.recorrido || {}) as Record<string, any>;
    const { etapas } = await this.de(workspaceId);

    let avisadas = 0;
    for (const e of etapas) {
      if (e.estado !== "listo") continue;
      if (marcas[e.etapa]?.avisadoComo === "listo") continue;
      const ok = await this.celebrar(workspaceId, e.etapa);
      if (ok) avisadas++;
      else {
        // Sin chat vinculado no hay a quien avisarle: se marca igual para no
        // soltarle diez felicitaciones juntas el dia que conecte el bot.
        await models.workspaces.updateOne(
          { _id: workspaceId },
          { $set: { [`recorrido.${e.etapa}.avisadoComo`]: "listo" } }
        );
      }
    }
    return avisadas;
  }

  /** Recorre todos los entornos activos. Lo llama el cron. */
  async celebrarPendientes(): Promise<{ revisados: number; avisos: number }> {
    const activos = await models.workspaces.find({ isActive: true }).select("_id").lean();
    let avisos = 0;
    for (const w of activos) {
      avisos += await this.revisarYCelebrar(w._id as Types.ObjectId).catch(() => 0);
    }
    return { revisados: activos.length, avisos };
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

    const previo = await models.workspaces.findById(workspaceId).select("recorrido").lean();
    const marcaPrevia = ((previo as any)?.recorrido || {})[etapa] || {};

    await models.workspaces.updateOne(
      { _id: workspaceId },
      {
        $set: {
          [`recorrido.${etapa}`]: {
            estado,
            en: new Date(),
            porNombre: quien.nombre,
            nota: nota?.slice(0, 500),
            // Se conserva si ya se felicito, para no repetirlo al corregir.
            avisadoEn: marcaPrevia.avisadoEn,
            avisadoComo: estado === "listo" ? marcaPrevia.avisadoComo : undefined,
          },
        },
      }
    );

    // Se cerro un paso: el cliente se entera al momento.
    if (estado === "listo" && marcaPrevia.avisadoComo !== "listo") {
      await this.celebrar(workspaceId, etapa as EtapaRecorrido).catch((error: any) =>
        console.error("[Recorrido] no se pudo felicitar:", error?.message || error)
      );
    }
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
