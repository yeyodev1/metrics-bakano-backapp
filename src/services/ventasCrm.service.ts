import { Types } from "mongoose";
import models from "../models";
import { crmIntegracionService } from "./crmIntegracion.service";
import type { ConversacionCrm, CrmCliente, OportunidadCrm, UsuarioCrm } from "./crmCliente.service";

/**
 * Las ventas del cliente en SU CRM, por asesor, para que Lucas le diga a cada
 * uno como va cada venta y que escribir. Metrics es quien tiene el acceso al
 * CRM (token propio cifrado o la cuenta de agencia); Lucas lo pide por aqui
 * con la llave compartida y nunca toca un token.
 *
 * Presupuesto: Lucas espera una respuesta, asi que se leen las oportunidades
 * abiertas mas recientes (tope) y la conversacion de cada una en paralelo.
 */

const MAX_OPORTUNIDADES = 25;
const CONCURRENCIA = 5;
const MENSAJES_POR_VENTA = 6;
const PRESUPUESTO_MS = 30_000;

export interface MensajeVenta {
  de: "cliente" | "negocio";
  texto: string;
  fecha: string | null;
}

export interface VentaCrm {
  oportunidad: string;
  contacto: { nombre: string | null; telefono: string | null };
  pipeline: string | null;
  etapa: string | null;
  monto: number | null;
  diasSinMoverse: number | null;
  ultimoMensaje: { de: "cliente" | "negocio" | null; haceHoras: number | null; canal: string | null };
  /** El cliente escribio ultimo y nadie le respondio. */
  esperandoRespuesta: boolean;
  mensajes: MensajeVenta[];
}

export interface AsesorCrm {
  id: string | null;
  nombre: string;
  email: string | null;
  ventasAbiertas: number;
  montoAbierto: number;
  esperandoRespuesta: number;
  ventas: VentaCrm[];
}

export type ResultadoVentasCrm =
  | { disponible: false; motivo: string }
  | {
      disponible: true;
      locationId: string;
      generadoEn: string;
      asesores: AsesorCrm[];
      /** Habia mas oportunidades abiertas de las que se leyeron. */
      truncado: boolean;
    };

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function horasDesde(d: Date | null | undefined): number | null {
  return d ? Math.max(0, Math.round((Date.now() - d.getTime()) / 3_600_000)) : null;
}

function quien(direccion: string | null | undefined): "cliente" | "negocio" | null {
  if (!direccion) return null;
  return direccion === "inbound" ? "cliente" : "negocio";
}

function venta(o: OportunidadCrm, conv: ConversacionCrm | null): VentaCrm {
  const mensajes = (conv?.mensajes || []).slice(-MENSAJES_POR_VENTA).map((m) => ({
    de: (m.direccion === "inbound" ? "cliente" : "negocio") as "cliente" | "negocio",
    texto: m.texto.slice(0, 500),
    fecha: iso(m.fecha),
  }));
  const ultimo = mensajes[mensajes.length - 1];
  const deUltimo = ultimo?.de ?? quien(conv?.ultimaDireccion);
  return {
    oportunidad: o.nombre,
    contacto: { nombre: o.contacto.nombre || conv?.nombre || null, telefono: o.contacto.telefono || conv?.telefono || null },
    pipeline: o.pipeline,
    etapa: o.etapa,
    monto: o.monto,
    diasSinMoverse: o.ultimoCambioEtapa ? Math.floor((Date.now() - o.ultimoCambioEtapa.getTime()) / 86_400_000) : null,
    ultimoMensaje: { de: deUltimo, haceHoras: horasDesde(conv?.ultimaFecha), canal: conv?.canal ?? null },
    esperandoRespuesta: deUltimo === "cliente",
    mensajes,
  };
}

class VentasCrmService {
  /** El lector del CRM del entorno, o el motivo por el que no se puede. */
  private async lector(workspaceId: string): Promise<{ cliente: CrmCliente; locationId: string } | { motivo: string }> {
    if (!Types.ObjectId.isValid(workspaceId)) return { motivo: "Entorno inválido." };
    const doc = await models.crmIntegrations.findOne({ workspaceId }).select("+tokenCifrado").lean();
    if (!doc) {
      const ws = await models.workspaces.findById(workspaceId).select("crmSubcuenta").lean();
      return {
        motivo: (ws as any)?.crmSubcuenta?.locationId
          ? "El negocio tiene su subcuenta vinculada, pero Metrics todavía no puede leer ese CRM (falta el token de agencia o el token del cliente)."
          : "Este negocio todavía no tiene su CRM vinculado en Metrics.",
      };
    }
    if ((doc as any).estado !== "conectado") return { motivo: "El CRM de este negocio está con error de conexión en Metrics." };
    return { cliente: await crmIntegracionService.cliente(doc as any), locationId: (doc as any).locationId };
  }

  /** Ventas abiertas agrupadas por asesor, con la conversacion de cada una. */
  async porAsesor(workspaceId: string, opciones: { email?: string; max?: number } = {}): Promise<ResultadoVentasCrm> {
    const l = await this.lector(workspaceId);
    if ("motivo" in l) return { disponible: false, motivo: l.motivo };
    const inicio = Date.now();

    const [usuarios, oportunidades] = await Promise.all([l.cliente.usuarios().catch(() => [] as UsuarioCrm[]), l.cliente.todasLasOportunidades()]);
    const porId = new Map(usuarios.map((u) => [u.id, u]));

    // Solo las de un asesor (el vendedor que pregunta por lo suyo).
    const email = opciones.email?.trim().toLowerCase();
    const usuario = email ? usuarios.find((u) => (u.email || "").toLowerCase() === email) : undefined;
    if (email && !usuario) {
      return { disponible: false, motivo: "No encontré a esa persona como usuario del CRM del negocio (se busca por su correo)." };
    }

    const abiertas = oportunidades
      .filter((o) => o.estado === "open")
      .filter((o) => !usuario || o.asignadoA === usuario.id)
      .sort((a, b) => (b.actualizada?.getTime() ?? 0) - (a.actualizada?.getTime() ?? 0));
    const max = Math.min(opciones.max ?? MAX_OPORTUNIDADES, MAX_OPORTUNIDADES);
    const elegidas = abiertas.slice(0, max);

    const conversaciones = new Map<string, ConversacionCrm | null>();
    for (let i = 0; i < elegidas.length; i += CONCURRENCIA) {
      if (Date.now() - inicio > PRESUPUESTO_MS) break;
      await Promise.all(
        elegidas.slice(i, i + CONCURRENCIA).map(async (o) => {
          if (!o.contactId || conversaciones.has(o.contactId)) return;
          conversaciones.set(o.contactId, await l.cliente.conversacionDeContacto(o.contactId).catch(() => null));
        })
      );
    }

    const grupos = new Map<string, AsesorCrm>();
    for (const o of elegidas) {
      const clave = o.asignadoA || "sin_asignar";
      if (!grupos.has(clave)) {
        const u = o.asignadoA ? porId.get(o.asignadoA) : undefined;
        grupos.set(clave, {
          id: o.asignadoA || null,
          nombre: u?.nombre || (o.asignadoA ? `Asesor ${o.asignadoA.slice(-4)}` : "Sin asesor asignado"),
          email: u?.email || null,
          ventasAbiertas: 0,
          montoAbierto: 0,
          esperandoRespuesta: 0,
          ventas: [],
        });
      }
      const g = grupos.get(clave)!;
      const v = venta(o, o.contactId ? conversaciones.get(o.contactId) ?? null : null);
      g.ventas.push(v);
      g.ventasAbiertas++;
      g.montoAbierto += o.monto || 0;
      if (v.esperandoRespuesta) g.esperandoRespuesta++;
    }

    return {
      disponible: true,
      locationId: l.locationId,
      generadoEn: new Date().toISOString(),
      asesores: [...grupos.values()].sort((a, b) => b.esperandoRespuesta - a.esperandoRespuesta || b.ventasAbiertas - a.ventasAbiertas),
      truncado: abiertas.length > elegidas.length,
    };
  }

  /** Lo que el CRM sabe de un lead por su telefono: su venta, su asesor y la conversacion. */
  async delContacto(workspaceId: string, telefono: string) {
    const l = await this.lector(workspaceId);
    if ("motivo" in l) return { disponible: false as const, motivo: l.motivo };
    const contacto = await l.cliente.contactoPorTelefono(telefono).catch(() => null);
    if (!contacto) return { disponible: true as const, encontrado: false as const };

    const [usuarios, oportunidades, conv] = await Promise.all([
      l.cliente.usuarios().catch(() => [] as UsuarioCrm[]),
      l.cliente.todasLasOportunidades().catch(() => [] as OportunidadCrm[]),
      l.cliente.conversacionDeContacto(contacto.id).catch(() => null),
    ]);
    const suyas = oportunidades.filter((o) => o.contactId === contacto.id);
    const abierta = suyas.find((o) => o.estado === "open") || suyas[0];
    const asesorId = abierta?.asignadoA || contacto.asignadoA || conv?.asignadoA || null;
    const asesor = asesorId ? usuarios.find((u) => u.id === asesorId) : undefined;
    return {
      disponible: true as const,
      encontrado: true as const,
      contacto: { nombre: contacto.nombre },
      asesor: asesor ? { nombre: asesor.nombre, email: asesor.email } : null,
      venta: abierta ? venta(abierta, conv) : null,
      otrasVentas: suyas.filter((o) => o !== abierta).map((o) => ({ oportunidad: o.nombre, estado: o.estado, etapa: o.etapa, monto: o.monto })),
      conversacion: abierta
        ? null
        : conv
          ? { canal: conv.canal, mensajes: conv.mensajes.slice(-MENSAJES_POR_VENTA).map((m) => ({ de: m.direccion === "inbound" ? "cliente" : "negocio", texto: m.texto.slice(0, 500), fecha: iso(m.fecha) })) }
          : null,
    };
  }
}

export const ventasCrmService = new VentasCrmService();
