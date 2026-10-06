import { z } from "zod";
import { CALENDARIOS_PRODUCCION } from "../../services/equipoAtencion.service";
import { crmProductionSyncService, fechaEcuador } from "../../services/crmProductionSync.service";
import { ghlService } from "../../services/ghl.service";
import type { PerfilMcp, UsuarioMcp } from "../perfiles";
import { TODOS, NOMBRE_PERFIL } from "../perfiles";
import { leerFecha, type ToolMcp } from "./base";

/**
 * El calendario del CRM de cada persona, según su correo y su rol. Es el
 * mismo correo con el que entra al MCP: así Claude mira la agenda real del
 * CRM y no se inventa eventos en otro calendario (Google, Outlook).
 */

interface CalendarioPersona {
  nombre: string;
  /** IDs fijos del CRM, o un patrón para encontrarlo por nombre. */
  ids?: string[];
  patron?: RegExp;
}

/** Calendarios propios por correo (uno por persona, el que usa el bot). */
const POR_CORREO: Record<string, CalendarioPersona> = {
  "jortega@bakano.ec": { nombre: "Jean Ortega", ids: Object.values(CALENDARIOS_PRODUCCION) },
  "kmunoz@bakano.ec": { nombre: "Karen Muñoz", ids: Object.values(CALENDARIOS_PRODUCCION) },
  "jleon@bakano.ec": { nombre: "Javier León", patron: /alfa\s*lobo/i },
  "jjimenez@bakano.ec": { nombre: "Joel Jimenez", ids: ["GNizdekhY5SQaYTPdKPP"] },
  "drobles@bakano.ec": { nombre: "David Robles", ids: ["aaHn06pmWuNFuF7tjDST"] },
  "avera@bakano.ec": { nombre: "Ariana Vera", ids: ["JDzGl2qjoWwAk5TvBNUp"] },
  "gbenalcazar@bakano.ec": { nombre: "Genesis Benalcazar", ids: ["FWL0e2jCKpbamtlj31io"] },
};

/** Además de lo suyo, quién ve todos los calendarios de producción. */
const VEN_PRODUCCION: PerfilMcp[] = ["direccion", "pm", "produccion", "contenido"];
/** Quién puede mirar el calendario de otra persona. */
const VEN_A_OTROS: PerfilMcp[] = ["direccion", "pm"];

const DIA = 86_400_000;

function normalizar(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

async function idsDe(p: CalendarioPersona, delCrm: { id: string; name: string }[]): Promise<string[]> {
  if (p.ids) return p.ids;
  return delCrm.filter((c) => p.patron!.test(c.name)).map((c) => c.id);
}

function buscarPersona(texto: string): [string, CalendarioPersona] | null {
  const t = normalizar(texto);
  return Object.entries(POR_CORREO).find(([correo, p]) => correo === t || normalizar(p.nombre).includes(t)) ?? null;
}

export const toolsCalendarioCrm: ToolMcp[] = [
  {
    nombre: "calendario_crm",
    titulo: "Mi calendario del CRM",
    descripcion:
      "Las citas reales del CRM de Bakano (GoHighLevel) en tu calendario, según tu correo y tu rol: producción ve todos los calendarios de producción (Dinamita y Alfa Lobo, standard y premium); cada persona ve su calendario propio; dirección y PM pueden mirar el de otra persona con `persona`. " +
      "Es la agenda oficial: las producciones se agendan aquí con crear_produccion, nunca en Google Calendar ni en otro calendario. Solo lectura.",
    perfiles: TODOS,
    entrada: {
      desde: z.string().optional().describe("AAAA-MM-DD (por defecto, hoy)"),
      dias: z.number().int().min(1).max(31).optional().describe("Cuántos días mirar (por defecto 14)"),
      persona: z.string().optional().describe("Correo o nombre de otra persona del equipo (solo dirección y PM)"),
      incluir_canceladas: z.boolean().optional(),
    },
    async correr(a, u: UsuarioMcp) {
      if (!ghlService.isConfigured()) throw new Error("El calendario del CRM no está configurado en el servidor.");
      if (a.persona && !VEN_A_OTROS.includes(u.perfil)) {
        throw new Error(`Con tu perfil (${NOMBRE_PERFIL[u.perfil]}) ves tu calendario y el de producción; el de otra persona lo ve dirección o el PM.`);
      }

      const delCrm = await ghlService.getCalendars();
      const nombreDe = new Map(delCrm.map((c) => [c.id, c.name]));
      const calendarios = new Map<string, string>(); // id → de quién/por qué

      if (a.persona) {
        const encontrada = buscarPersona(a.persona);
        if (!encontrada) {
          throw new Error(`No tengo calendario del CRM para "${a.persona}". Con calendario: ${Object.values(POR_CORREO).map((p) => p.nombre).join(", ")}.`);
        }
        for (const id of await idsDe(encontrada[1], delCrm)) calendarios.set(id, encontrada[1].nombre);
      } else {
        const propio = POR_CORREO[u.email.toLowerCase()];
        if (propio) for (const id of await idsDe(propio, delCrm)) calendarios.set(id, "tuyo");
        if (VEN_PRODUCCION.includes(u.perfil)) {
          for (const c of await crmProductionSyncService.calendariosDeProduccion()) {
            if (c.id && !calendarios.has(c.id)) calendarios.set(c.id, "producción");
          }
        }
      }
      if (!calendarios.size) {
        return "No tienes un calendario propio en el CRM y tu perfil no ve los de producción. Para las grabaciones de todos, usa calendario_producciones.";
      }

      const desde = a.desde ? leerFecha(a.desde) : new Date(new Date().setHours(0, 0, 0, 0));
      const hasta = new Date(desde.getTime() + (a.dias ?? 14) * DIA);
      const lecturas = await Promise.allSettled(
        [...calendarios.keys()].map((id) => ghlService.getCalendarEvents([id], desde, hasta))
      );
      const sinLeer: string[] = [];
      const citas = lecturas.flatMap((r, i) => {
        const id = [...calendarios.keys()][i];
        if (r.status === "rejected") {
          sinLeer.push(nombreDe.get(id) ?? id);
          return [];
        }
        return r.value;
      });

      const visibles = citas
        .filter((e: any) => a.incluir_canceladas || !/cancel|invalid/i.test(String(e.appointmentStatus ?? "")))
        .sort((x: any, y: any) => new Date(x.startTime).getTime() - new Date(y.startTime).getTime());

      return {
        rango: `${fechaEcuador(desde)} → ${fechaEcuador(hasta)}`,
        calendarios: [...calendarios.entries()].map(([id, de]) => ({ calendario: nombreDe.get(id) ?? id, de })),
        total: visibles.length,
        citas: visibles.slice(0, 100).map((e: any) => ({
          cuando: fechaEcuador(new Date(e.startTime)),
          hasta: e.endTime ? fechaEcuador(new Date(e.endTime)) : null,
          titulo: e.title,
          calendario: nombreDe.get(e.calendarId) ?? e.calendarId,
          estado: e.appointmentStatus,
          id: e.id,
        })),
        ...(sinLeer.length ? { sinLeer } : {}),
      };
    },
  },
];
