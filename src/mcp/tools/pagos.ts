import { z } from "zod";
import { estadoPagoService } from "../../services/estadoPago.service";
import { comoDolares } from "../../services/pagosCliente.service";
import { fecha, resolverCliente, type ToolMcp } from "./base";

/**
 * Quién está al día, para saber a quién planificarle. Contenido ve si puede
 * avanzar con un cliente; los montos los ven Dirección y los PM.
 */
export const toolsPagos: ToolMcp[] = [
  {
    nombre: "estado_pagos",
    titulo: "Quién está al día con los pagos",
    descripcion:
      "Qué clientes están al día y cuáles tienen pagos vencidos, leído de Bakano Finanzas. Sirve para saber a quién planificarle: el cliente que debe no ve ni aprueba sus guiones ni agenda producción hasta pagar. " +
      "Con cliente: solo ese. solo_deben=true lista solo los que deben.",
    perfiles: ["direccion", "pm", "contenido"],
    entrada: {
      cliente: z.string().optional(),
      solo_deben: z.boolean().optional(),
    },
    async correr(a, u) {
      const conMontos = u.perfil === "direccion" || u.perfil === "pm";
      let filas = await estadoPagoService.todos();
      if (a.cliente) {
        const ws = await resolverCliente(a.cliente);
        filas = filas.filter((f) => f.workspaceId === String(ws._id));
        if (!filas.length) return `${ws.name} no está activo o no aparece en Finanzas.`;
      }
      if (a.solo_deben) filas = filas.filter((f) => !f.alDia);
      const deben = filas.filter((f) => !f.alDia);
      return {
        alDia: filas.length - deben.length,
        deben: deben.length,
        sinFacturacionVinculada: filas.filter((f) => !f.vinculado).map((f) => f.cliente),
        clientes: filas
          .sort((x, y) => Number(x.alDia) - Number(y.alDia) || x.cliente.localeCompare(y.cliente))
          .map((f) => ({
            cliente: f.cliente,
            estado: !f.vinculado ? "sin facturación vinculada (no se bloquea)" : f.alDia ? "al día" : "debe: no ve guiones ni agenda",
            ...(f.excepcion ? { excepcion: f.excepcion } : {}),
            ...(f.pagadoMesActual !== undefined ? { pagoEsteMes: f.pagadoMesActual } : {}),
            ...(conMontos && !f.alDia ? { vencido: comoDolares(f.deuda), facturasVencidas: f.facturasVencidas } : {}),
            ...(conMontos && f.ultimoPago ? { ultimoPago: fecha(new Date(f.ultimoPago)) } : {}),
          })),
      };
    },
  },
  {
    nombre: "guiones_sin_pago",
    titulo: "Dejar ver los guiones aunque deba",
    descripcion:
      "Abre por unos días (máx. 60) los guiones y la producción de un cliente con pagos vencidos: un acuerdo de pago, un pago que no se registró a tiempo. " +
      "Lo correcto es registrar el pago en Finanzas; esto es la excepción. Confirma con la persona antes.",
    perfiles: ["direccion", "pm"],
    escribe: true,
    entrada: {
      cliente: z.string(),
      dias: z.number().int().min(1).max(60),
      motivo: z.string().min(3).describe("Por qué se abre (queda registrado)"),
    },
    async correr(a, u) {
      const ws = await resolverCliente(a.cliente);
      const hasta = await estadoPagoService.ponerExcepcion(String(ws._id), a.dias, a.motivo, u.nombre);
      return `Listo: ${ws.name} ve y aprueba sus guiones y puede agendar hasta el ${fecha(hasta)}. Motivo: ${a.motivo}.`;
    },
  },
];
