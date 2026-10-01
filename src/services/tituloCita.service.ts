import axios from "axios";
import { ghlService } from "./ghl.service";

/**
 * El titulo de cada cita del equipo en el CRM, claro y sin huecos:
 *   "🗂️ Exequiel Sagredo · E. Sagredo Arquitectura - Configuración del CRM con David"
 * La empresa solo si el contacto la tiene (muchos no: con la plantilla del CRM
 * quedaba "/ Exequiel" con un hueco). GoHighLevel no deja poner condiciones en
 * la plantilla, asi que el bot titula al agendar y el cron arregla las que
 * entraron por el link.
 *
 * Formato "Persona · Empresa - Que": el sync del onboarding lee lo anterior a
 * " - " y busca ahi el nombre del entorno, asi que sigue funcionando.
 */

const GHL_API_BASE = "https://services.leadconnectorhq.com";

export const TITULO_POR_CALENDARIO: Record<string, { emoji: string; que: string }> = {
  GNizdekhY5SQaYTPdKPP: { emoji: "📣", que: "Especialización en Meta con Joel" },
  aaHn06pmWuNFuF7tjDST: { emoji: "🗂️", que: "Configuración del CRM con David" },
  JDzGl2qjoWwAk5TvBNUp: { emoji: "📝", que: "Estrategia de contenido con Ariana" },
  FWL0e2jCKpbamtlj31io: { emoji: "🤝", que: "Atención al cliente con Genesis" },
};

function limpio(t: unknown): string {
  return String(t ?? "").replace(/\s+/g, " ").trim();
}

/** "EXEQUIEL" → "Exequiel". Solo si viene todo en mayusculas o minusculas. */
function capitalizar(t: string): string {
  if (t !== t.toUpperCase() && t !== t.toLowerCase()) return t;
  return t.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_m, sep: string, l: string) => sep + l.toUpperCase());
}

/** Primer nombre y primer apellido: "Exequiel Alejandro" + "Sagredo Castro" → "Exequiel Sagredo". */
function nombreYApellido(p: { nombre?: string; apellido?: string; nombreCompleto?: string }): string {
  const nombre = limpio(p.nombre).split(" ")[0] || "";
  const apellido = limpio(p.apellido).split(" ")[0] || "";
  if (nombre || apellido) return capitalizar(limpio(`${nombre} ${apellido}`));
  const partes = limpio(p.nombreCompleto).split(" ").filter(Boolean);
  // "Nombre Nombre Apellido Apellido": el tercero es el primer apellido.
  const elegidas = partes.length >= 4 ? [partes[0], partes[2]] : partes.slice(0, 2);
  return capitalizar(elegidas.join(" "));
}

/** "Nombre Apellido · Empresa" sin huecos: lo que haya, en ese orden. */
export function quienEs(p: { nombre?: string; apellido?: string; nombreCompleto?: string; empresa?: string }): string {
  const persona = nombreYApellido(p);
  const empresa = limpio(p.empresa);
  // La empresa no se repite si es el mismo nombre de la persona.
  const conEmpresa = empresa && empresa.toLowerCase() !== persona.toLowerCase();
  return [persona, conEmpresa ? empresa : ""].filter(Boolean).join(" · ") || "Cliente";
}

/** Titulo para un calendario conocido; null si el calendario no tiene formato propio. */
export function tituloCita(
  calendarId: string,
  p: { nombre?: string; apellido?: string; nombreCompleto?: string; empresa?: string },
  que?: string
): string | null {
  const def = TITULO_POR_CALENDARIO[calendarId];
  if (!def && !que) return null;
  return `${def?.emoji ?? "📅"} ${quienEs(p)} - ${que ?? def!.que}`;
}

class TituloCitaService {
  /**
   * Revisa las citas proximas de los calendarios del equipo y les pone el
   * titulo claro si no lo tienen. No avisa al cliente (toNotify: false).
   */
  async ordenar(dias = 60): Promise<{ revisadas: number; corregidas: number }> {
    const calendarios = Object.keys(TITULO_POR_CALENDARIO);
    const eventos = await ghlService.getCalendarEvents(calendarios, new Date(Date.now() - 86_400_000), new Date(Date.now() + dias * 86_400_000));
    let corregidas = 0;
    const contactos = new Map<string, any>();
    for (const ev of eventos) {
      if (/cancel/i.test(String(ev.appointmentStatus || ""))) continue;
      const contactId = String(ev.contactId || "");
      if (!contactId) continue;
      if (!contactos.has(contactId)) contactos.set(contactId, await ghlService.getContact(contactId).catch(() => null));
      const c = contactos.get(contactId);
      if (!c) continue;
      // El contacto de la cita a veces es alguien del equipo (agendo por el
      // cliente): ahi no se toca, el titulo es lo unico que dice de quien es.
      if (/@bakano\.ec$/i.test(String(c.email || ""))) continue;
      const titulo = tituloCita(String(ev.calendarId), {
        nombre: c.firstName,
        apellido: c.lastName,
        nombreCompleto: c.contactName || c.name,
        empresa: c.companyName,
      });
      if (!titulo || limpio(ev.title) === titulo) continue;
      try {
        await axios.put(
          `${GHL_API_BASE}/calendars/events/appointments/${ev.id}`,
          { title: titulo, toNotify: false },
          { headers: ghlService.getHeaders(), timeout: 15_000 }
        );
        corregidas++;
      } catch (error: any) {
        console.error("[Títulos] no se pudo renombrar la cita:", ev.id, error.response?.status, error.response?.data?.message || error.message);
      }
    }
    return { revisadas: eventos.length, corregidas };
  }
}

export const tituloCitaService = new TituloCitaService();
