import { z } from "zod";
import { onboardingProgresoService, PASOS } from "../../services/onboardingProgreso.service";
import type { PasoOnboarding } from "../../models/onboardingEvento.model";
import { fecha, resolverCliente, type ToolMcp } from "./base";
import { TODOS } from "../perfiles";

const PASO = z.enum(PASOS as [PasoOnboarding, ...PasoOnboarding[]]);

export const toolsOnboarding: ToolMcp[] = [
  {
    nombre: "onboarding_tablero",
    titulo: "Tablero del onboarding",
    descripcion:
      "Cómo va el onboarding de cada cliente: porcentaje, siguiente paso, si está bloqueado y por qué, y cuántos días lleva sin moverse. Filtra bloqueados o pendientes.",
    perfiles: ["direccion", "pm", "contenido", "produccion"],
    entrada: { solo_bloqueados: z.boolean().optional(), solo_pendientes: z.boolean().optional() },
    async correr(a) {
      const lista = await onboardingProgresoService.resumen({ soloBloqueados: a.solo_bloqueados, soloPendientes: a.solo_pendientes });
      return {
        total: lista.length,
        bloqueados: lista.filter((p) => p.bloqueado).length,
        clientes: lista.map((p) => ({
          cliente: p.entorno, porcentaje: p.porcentaje, siguiente: p.siguiente, bloqueado: p.bloqueado,
          motivoBloqueo: p.motivoBloqueo, diasSinMover: p.diasSinMover, tieneTelegram: p.tieneTelegram,
        })),
      };
    },
  },
  {
    nombre: "onboarding_detalle",
    titulo: "Onboarding de un cliente",
    descripcion: "Cada paso del onboarding de un cliente con su estado, responsable, lo que falta del cliente y la bitácora de quién movió qué.",
    perfiles: ["direccion", "pm", "contenido", "produccion"],
    entrada: { cliente: z.string() },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const d = await onboardingProgresoService.detalle(String(ws._id));
      if (!d) throw new Error("Cliente no encontrado.");
      return {
        cliente: ws.name,
        porcentaje: d.progreso.porcentaje,
        pasos: d.progreso.pasos.map((p) => ({ ...p, fecha: fecha(p.fecha), actualizadoEn: fecha(p.actualizadoEn) })),
        bitacora: d.bitacora.slice(0, 20).map((b: any) => ({ paso: b.paso, estado: b.estado, motivo: b.motivo, nota: b.nota, por: b.porNombre, en: fecha(b.createdAt) })),
      };
    },
  },
  {
    nombre: "onboarding_marcar_paso",
    titulo: "Marcar un paso del onboarding",
    descripcion:
      "Cambia el estado de un paso del onboarding (pendiente, agendada, cumplida, bloqueada, no_aplica). Bloquear exige motivo y avisa por Slack al responsable y a Genesis. Queda en la bitácora con tu nombre. Cada responsable marca su paso; superadmin y Genesis, cualquiera.",
    // Lo ve todo el equipo: quién puede marcar cada paso se decide abajo, paso por paso.
    perfiles: TODOS,
    escribe: true,
    entrada: {
      cliente: z.string(),
      paso: PASO,
      estado: z.enum(["pendiente", "agendada", "cumplida", "bloqueada", "no_aplica"]),
      motivo: z.string().optional(),
      nota: z.string().optional(),
      pendiente_del_cliente: z.string().optional().describe("Qué le falta entregar al cliente"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      if (!onboardingProgresoService.puedeMarcar(u, a.paso)) {
        throw new Error("Ese paso lo marca su responsable o un superadmin. Pídeselo a ellos.");
      }
      try {
        const p = await onboardingProgresoService.marcar(String(ws._id), a.paso, {
          estado: a.estado, motivo: a.motivo, nota: a.nota, pendienteDelCliente: a.pendiente_del_cliente,
          porId: u._id, porNombre: u.nombre, origen: "equipo",
        });
        return { listo: true, cliente: ws.name, porcentaje: p.porcentaje, siguiente: p.siguiente };
      } catch (e: any) {
        if (e?.message === "MOTIVO_REQUERIDO") throw new Error("Para bloquear un paso hace falta el motivo.");
        throw e;
      }
    },
  },
  {
    nombre: "onboarding_recordar",
    titulo: "Recordarle al cliente por Telegram",
    descripcion:
      "Le escribe al cliente por Telegram (desde @BakanoAgencyBot) lo que le falta para avanzar en un paso del onboarding. Si no pasas texto usa lo que diga 'pendiente del cliente'. Solo si el cliente tiene el bot conectado.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: { cliente: z.string(), paso: PASO, texto: z.string().optional() },
    async correr(a) {
      const ws = await resolverCliente(a.cliente);
      const r = await onboardingProgresoService.recordarAlCliente(String(ws._id), a.paso, a.texto);
      return r.enviado
        ? `Listo, se le escribió a ${ws.name} por Telegram.`
        : `No se envió: ${ws.name} no tiene el bot conectado o no hay nada pendiente que recordarle en ese paso.`;
    },
  },
];
