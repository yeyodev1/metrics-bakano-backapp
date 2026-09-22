import { Types } from "mongoose";
import models from "../models";
import type { ITelegramChat } from "../models/telegramChat.model";
import { slackService } from "./slack.service";
import { resendService } from "./resend.service";
import { notificationService } from "./notification.service";
import { atencionClienteService } from "./atencionCliente.service";
import { onboardingBotService } from "./onboardingBot.service";

/**
 * Lo que el cliente tiene que entregar en el onboarding y los datos de su
 * marca. El bot detecta que falta, se lo pide conversando y lo deja en el
 * sistema: los datos van al perfil de marca (lo usa la IA de guiones) y los
 * envios quedan "declarados" hasta que el responsable los verifique.
 */

export type Entregable = "archivosMarca" | "facturacion" | "catalogo" | "invitacionMeta";

const DENISSE = { nombre: "Denisse Quimi", email: "dquimi@bakano.ec" };
const JOEL = { nombre: "Joel Jimenez", email: "jjimenez@bakano.ec" };

export const ENTREGABLES: Record<Entregable, { etiqueta: string; que: string; a: string; responsable: { nombre: string; email: string } }> = {
  archivosMarca: {
    etiqueta: "Archivos e identidad de marca",
    que: "Logos en PNG, JPEG y vector (editable o .ai) y la identidad de marca",
    a: "dquimi@bakano.ec",
    responsable: DENISSE,
  },
  facturacion: {
    etiqueta: "Facturación de los últimos 6 meses",
    que: "Datos de facturación de al menos los últimos 6 meses",
    a: "dquimi@bakano.ec",
    responsable: DENISSE,
  },
  catalogo: {
    etiqueta: "Catálogo y precios",
    que: "Catálogo de productos o servicios con sus precios",
    a: "dquimi@bakano.ec",
    responsable: DENISSE,
  },
  invitacionMeta: {
    etiqueta: "Invitación al portafolio de Meta",
    que: "Invitación al portafolio comercial de Meta con permisos de ADMINISTRACIÓN",
    a: "agenciademi@gmail.com",
    responsable: JOEL,
  },
};

/** Campos del perfil de marca que el cliente puede contar por chat. */
export const CAMPOS_MARCA: Record<string, string> = {
  descripcion: "Qué hace el negocio",
  tipoNegocio: "Si vende productos o servicios",
  vertical: "Rubro o industria",
  productosServicios: "Qué productos o servicios vende",
  publicoObjetivo: "A quién le vende",
  propuestaValor: "Qué lo diferencia de la competencia",
  problemaResuelto: "Qué problema le resuelve a su cliente",
  tono: "Cómo le gusta comunicarse",
};

class OnboardingDatosService {
  /** Todo lo que le falta al cliente para arrancar, en el orden del proceso. */
  async pendientes(workspaceId: Types.ObjectId) {
    const [workspace, estado, diasFacturacion] = await Promise.all([
      models.workspaces.findById(workspaceId).select("name brandProfile onboardingEntregables metaAds").lean(),
      onboardingBotService.estado(workspaceId),
      models.dailyBilling
        .distinct("date", { workspaceId, date: { $gte: new Date(Date.now() - 180 * 86_400_000) } })
        .then((d) => d.length)
        .catch(() => 0),
    ]);
    const marca = ((workspace as any)?.brandProfile || {}) as Record<string, unknown>;
    const entregas = ((workspace as any)?.onboardingEntregables || {}) as Record<string, { estado?: string }>;

    return {
      entorno: workspace?.name,
      sesionesPendientes: estado.sesiones
        .filter((s) => !s.agendada && s.estado !== "cumplida" && s.estado !== "no_aplica")
        .map((s) => ({ sesion: s.sesion, etiqueta: s.etiqueta, con: s.responsable, link: s.link })),
      entregables: (Object.keys(ENTREGABLES) as Entregable[]).map((k) => ({
        clave: k,
        etiqueta: ENTREGABLES[k].etiqueta,
        que: ENTREGABLES[k].que,
        enviarA: ENTREGABLES[k].a,
        estado: entregas[k]?.estado || "pendiente",
      })),
      datosMarcaFaltantes: Object.keys(CAMPOS_MARCA)
        .filter((c) => !String(marca[c] ?? "").trim())
        .map((c) => ({ campo: c, que: CAMPOS_MARCA[c] })),
      datosMarcaCompletos: Object.keys(CAMPOS_MARCA).filter((c) => String(marca[c] ?? "").trim()),
      diasDeFacturacionEnPlataforma: diasFacturacion,
      metaConectado: Boolean((workspace as any)?.metaAds?.adAccountId || (workspace as any)?.metaAds?.pageId),
    };
  }

  /** Guarda un dato de la marca con las palabras del cliente. */
  async registrarDatoMarca(chat: ITelegramChat, campo: string, valor: string, reemplazar = false) {
    if (!(campo in CAMPOS_MARCA)) return { ok: false as const, motivo: `campo desconocido: ${campo}` };
    // Lo que ya estaba (lo lleno el equipo o el cliente en la web) no se pisa
    // sin que el cliente diga que quiere cambiarlo.
    const previo = (await models.workspaces.findById(chat.workspaceId).select(`brandProfile.${campo}`).lean()) as any;
    const actual = String(previo?.brandProfile?.[campo] ?? "").trim();
    if (actual && !reemplazar) {
      return { ok: false as const, motivo: "ya_tiene_valor", actual, siguiente: "Pregúntale si quiere reemplazarlo; si dice que sí, vuelve a llamar con reemplazar=true." };
    }
    let limpio = String(valor || "").trim().slice(0, 1500);
    if (campo === "tipoNegocio") {
      const v = limpio.toLowerCase();
      limpio = /servicio/.test(v) ? "SERVICIOS" : /producto/.test(v) ? "PRODUCTOS" : "";
      if (!limpio) return { ok: false as const, motivo: "tipoNegocio debe ser productos o servicios" };
    } else if (limpio.length < 3) {
      return { ok: false as const, motivo: "muy corto: pídele un poco más de detalle" };
    }
    // Entorno nuevo: brandProfile es null y Mongo no deja crear un campo
    // dentro de null. Primero se crea vacio (solo si sigue en null).
    await models.workspaces.updateOne(
      { _id: chat.workspaceId, $or: [{ brandProfile: null }, { brandProfile: { $exists: false } }] },
      { $set: { brandProfile: { descripcion: "", vertical: "", trafficLink: "", archivos: [] } } }
    );
    await models.workspaces.updateOne(
      { _id: chat.workspaceId },
      { $set: { [`brandProfile.${campo}`]: limpio, "brandProfile.updatedAt": new Date() } }
    );
    return { ok: true as const, guardado: CAMPOS_MARCA[campo] };
  }

  /** El cliente dice que ya envio algo: queda declarado y se avisa al responsable para verificar. */
  async registrarEntregable(chat: ITelegramChat, clave: string, nota?: string) {
    const def = ENTREGABLES[clave as Entregable];
    if (!def) return { ok: false as const, motivo: `entregable desconocido: ${clave}` };
    const workspace = await models.workspaces.findById(chat.workspaceId).select("onboardingEntregables").lean();
    const actual = (workspace as any)?.onboardingEntregables?.[clave]?.estado;
    if (actual === "declarado" || actual === "verificado") return { ok: true as const, yaEstaba: actual, etiqueta: def.etiqueta };

    await models.workspaces.updateOne(
      { _id: chat.workspaceId },
      {
        $set: {
          [`onboardingEntregables.${clave}`]: {
            estado: "declarado",
            declaradoEn: new Date(),
            nota: nota?.trim().slice(0, 500) || undefined,
          },
        },
      }
    );

    const cliente = await atencionClienteService.datosCliente(chat);
    const titulo = `📦 ${cliente.entorno} dice que ya envió: ${def.etiqueta}`;
    const detalle = `${cliente.nombre} lo declaró por Telegram. Debió llegar a ${def.a}. Verifica que esté completo.${nota ? `\nNota del cliente: ${nota}` : ""}`;
    const internos = await models.users.find({ email: def.responsable.email, isActive: true }).select("_id").lean();
    await Promise.allSettled([
      slackService.avisarEquipo({ titulo, detalle, correos: [def.responsable.email] }),
      ...internos.map((u) =>
        notificationService.create(u._id as Types.ObjectId, "solicitud_cliente", titulo, detalle, { workspaceId: chat.workspaceId! })
      ),
      resendService.sendSolicitudClienteEmail({
        to: [def.responsable.email],
        tema: "onboarding",
        workspaceName: cliente.entorno,
        clienteNombre: cliente.nombre,
        clienteEmail: cliente.email,
        telegramUsername: chat.telegramUsername,
        mensaje: detalle,
        asunto: titulo,
        encabezado: titulo,
      }),
    ]);
    return { ok: true as const, etiqueta: def.etiqueta, verificara: def.responsable.nombre };
  }
}

export const onboardingDatosService = new OnboardingDatosService();
