import axios from "axios";
import models from "../models";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_VERSION = "2021-04-15"; // standard version for GHL APIs

export class GhlService {
  private getHeaders() {
    const token = process.env.GHL_PIT_TOKEN;
    if (!token) throw new Error("GHL_PIT_TOKEN no configurado en variables de entorno");
    
    return {
      Authorization: `Bearer ${token}`,
      Version: GHL_VERSION,
      Accept: "application/json",
    };
  }

  /**
   * Cabeceras para la API de contactos.
   *
   * El token de produccion lee calendarios pero devuelve los contactos sin
   * correo (sin ese permiso), y sin correo no se puede saber de que cliente es
   * la cita. `GHL_PIT_TOKEN_CONTACTOS` permite usar uno con ese permiso sin
   * tocar el token principal; si no existe, se usa el de siempre.
   */
  private getContactHeaders() {
    const token = process.env.GHL_PIT_TOKEN_CONTACTOS || process.env.GHL_PIT_TOKEN;
    if (!token) throw new Error("GHL_PIT_TOKEN no configurado en variables de entorno");
    return { Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" };
  }

  /**
   * Los dos tokens, para reintentar cuando uno no tiene el permiso.
   *
   * Cada Private Integration Token del CRM lleva sus propios scopes: el de
   * contactos puede ser de solo lectura y el principal puede no leer correos.
   * Un 401 "not authorized for this scope" con uno no significa que la
   * operacion sea imposible: puede que el otro si pueda.
   */
  private cabecerasContacto(): Record<string, string>[] {
    const principal = process.env.GHL_PIT_TOKEN;
    const contactos = process.env.GHL_PIT_TOKEN_CONTACTOS;
    const tokens = [...new Set([contactos, principal].filter(Boolean) as string[])];
    return tokens.map((token) => ({ Authorization: `Bearer ${token}`, Version: "2021-07-28", Accept: "application/json" }));
  }

  /** true si el CRM respondio "no autorizado para este scope". */
  private esFaltaDePermiso(error: any): boolean {
    const status = error?.response?.status;
    const mensaje = String(error?.response?.data?.message || "");
    return status === 401 || status === 403 || /not authorized for this scope/i.test(mensaje);
  }

  /** Busca el contacto por correo. Es solo lectura: no necesita permiso de escritura. */
  async buscarContactoPorCorreo(email: string): Promise<string | null> {
    for (const headers of this.cabecerasContacto()) {
      try {
        const response = await axios.get(`${GHL_API_BASE}/contacts/`, {
          headers,
          params: { locationId: this.getLocationId(), query: email, limit: 20 },
          timeout: 15_000,
        });
        const encontrado = (response.data?.contacts || []).find(
          (c: any) => String(c?.email || "").toLowerCase() === email.toLowerCase()
        );
        if (encontrado?.id) return encontrado.id;
      } catch (error: any) {
        if (!this.esFaltaDePermiso(error)) {
          console.error("[GHL] búsqueda de contacto:", error.response?.data || error.message);
        }
      }
    }
    return null;
  }

  private getLocationId() {
    const locationId = process.env.GHL_LOCATION_ID;
    if (!locationId) throw new Error("GHL_LOCATION_ID no configurado en variables de entorno");
    return locationId;
  }

  /**
   * Fetches all calendars for the location.
   */
  async getCalendars(): Promise<{ id: string; name: string }[]> {
    try {
      const response = await axios.get(`${GHL_API_BASE}/calendars/`, {
        headers: this.getHeaders(),
        params: { locationId: this.getLocationId() }
      });
      return response.data.calendars || [];
    } catch (error: any) {
      console.error("Error fetching GHL calendars:", error.response?.data || error.message);
      return [];
    }
  }

  /** Hay token y location configurados: sin esto no se puede leer el CRM. */
  isConfigured(): boolean {
    return Boolean(process.env.GHL_PIT_TOKEN && process.env.GHL_LOCATION_ID);
  }

  /**
   * Citas de calendarios concretos (los de produccion) en un rango. Es la
   * base del cron que reconcilia el Planificador con el CRM: si el cliente
   * mueve o cancela la cita y el webhook no llego, aqui se detecta.
   */
  async getCalendarEvents(calendarIds: string[], startTime: Date, endTime: Date): Promise<any[]> {
    const results = await Promise.allSettled(
      calendarIds.map((calendarId) =>
        axios.get(`${GHL_API_BASE}/calendars/events`, {
          headers: this.getHeaders(),
          params: {
            locationId: this.getLocationId(),
            calendarId,
            startTime: startTime.getTime(),
            endTime: endTime.getTime(),
          },
        })
      )
    );
    const events: any[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        events.push(...(r.value.data?.events || []).map((e: any) => ({ ...e, calendarId: e.calendarId || calendarIds[i] })));
      } else {
        console.error(`[GHL] eventos del calendario ${calendarIds[i]}:`, r.reason?.response?.data || r.reason?.message);
        throw new Error(`No se pudieron leer las citas del calendario ${calendarIds[i]}`);
      }
    });
    return events;
  }

  /** Datos del contacto (correo, empresa, telefono) para asociarlo a un entorno. */
  async getContact(contactId: string): Promise<any | null> {
    if (!contactId) return null;
    try {
      // La API de contactos de GHL exige su propia version; con la de
      // calendarios responde error y la cita llegaba sin correo ni empresa.
      const response = await axios.get(`${GHL_API_BASE}/contacts/${contactId}`, {
        headers: this.getContactHeaders(),
      });
      return response.data?.contact || null;
    } catch (error: any) {
      console.error("[GHL] contacto:", error.response?.data || error.message);
      return null;
    }
  }

  /** Horarios libres de un calendario; el CRM ya descuenta citas y bloqueos. */
  async getFreeSlots(calendarId: string, desde: Date, hasta: Date): Promise<Date[]> {
    const response = await axios.get(`${GHL_API_BASE}/calendars/${calendarId}/free-slots`, {
      headers: this.getHeaders(),
      params: { startDate: desde.getTime(), endDate: hasta.getTime(), timezone: "America/Guayaquil" },
    });
    const data = response.data || {};
    return Object.keys(data)
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
      .sort()
      .flatMap((k) => (data[k]?.slots || []) as string[])
      .map((s) => new Date(s))
      .filter((d) => !Number.isNaN(d.getTime()) && d.getTime() >= desde.getTime());
  }

  async getCalendar(calendarId: string): Promise<{ id: string; name: string; slotDuration?: number; slotDurationUnit?: string } | null> {
    const response = await axios.get(`${GHL_API_BASE}/calendars/${calendarId}`, { headers: this.getHeaders() });
    return response.data?.calendar || null;
  }

  /** Crea o actualiza el contacto por correo y devuelve su id. */
  async upsertContact(datos: { email: string; firstName?: string; lastName?: string; companyName?: string }): Promise<string> {
    // Si ya existe, basta con leerlo: agendar no puede depender de tener
    // permiso de ESCRITURA sobre contactos.
    const existente = await this.buscarContactoPorCorreo(datos.email);
    if (existente) return existente;

    let ultimo: any = null;
    for (const headers of this.cabecerasContacto()) {
      try {
        const response = await axios.post(
          `${GHL_API_BASE}/contacts/upsert`,
          { locationId: this.getLocationId(), ...datos, source: "Telegram Bakano" },
          { headers, timeout: 15_000 }
        );
        const id = response.data?.contact?.id;
        if (id) return id;
      } catch (error: any) {
        ultimo = error;
        // Con el otro token puede que sí se pueda: se sigue intentando.
        if (!this.esFaltaDePermiso(error)) break;
      }
    }
    console.error("[GHL] contacts/upsert:", ultimo?.response?.status, ultimo?.response?.data || ultimo?.message);
    throw new Error("El CRM no dejó crear el contacto (revisa los permisos del token: contacts.write)");
  }

  /**
   * Agenda una cita. Se niega en calendarios de produccion: el sync del CRM
   * la convertiria en una grabacion del Planificador.
   */
  async createAppointment(cita: {
    calendarId: string;
    contactId: string;
    startTime: Date;
    title: string;
    /** Solo el flujo de agendar produccion lo activa, a proposito. */
    permitirProduccion?: boolean;
  }): Promise<string> {
    const calendario = await this.getCalendar(cita.calendarId);
    if (!calendario) throw new Error(`Calendario ${cita.calendarId} no encontrado`);
    const nombre = calendario.name.normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (!cita.permitirProduccion && /^equipo\b|producc|grabaci|filmaci|rodaje/i.test(nombre)) {
      throw new Error(`"${calendario.name}" es un calendario de producción; no se agendan reuniones ahí`);
    }

    const minutos =
      calendario.slotDurationUnit === "hours" ? (calendario.slotDuration || 1) * 60 : calendario.slotDuration || 30;
    let response;
    try {
      response = await axios.post(
        `${GHL_API_BASE}/calendars/events/appointments`,
        {
          calendarId: cita.calendarId,
          locationId: this.getLocationId(),
          contactId: cita.contactId,
          startTime: cita.startTime.toISOString(),
          endTime: new Date(cita.startTime.getTime() + minutos * 60_000).toISOString(),
          title: cita.title,
          appointmentStatus: "confirmed",
          toNotify: true,
        },
        { headers: this.getHeaders(), timeout: 20_000 }
      );
    } catch (error: any) {
      // Sin el scope de escritura de citas NADIE puede agendar por el bot:
      // eso no se puede quedar solo en un log que nadie mira.
      if (this.esFaltaDePermiso(error)) await this.alertarPermisos("crear la cita (calendars/events.write)");
      console.error("[GHL] crear cita:", error.response?.status, error.response?.data || error.message);
      throw error;
    }
    const id = response.data?.id || response.data?.appointment?.id;
    if (!id) throw new Error("El CRM no devolvió el id de la cita");
    return id;
  }

  private ultimaAlertaPermisos = 0;
  /** Avisa al equipo (una vez por hora) que el token del CRM se quedó sin permisos. */
  private async alertarPermisos(que: string): Promise<void> {
    if (Date.now() - this.ultimaAlertaPermisos < 3_600_000) return;
    this.ultimaAlertaPermisos = Date.now();
    try {
      const { slackService } = await import("./slack.service");
      await slackService.avisarEquipo({
        titulo: "🔴 El CRM rechaza al bot por permisos",
        detalle:
          `GoHighLevel respondió 401 "not authorized for this scope" al intentar ${que}.\n\n` +
          "Mientras tanto, los clientes NO pueden agendar desde Telegram (se les manda el link del CRM).\n" +
          "Arreglo: en GHL → Settings → Private Integrations, edita el token de Bakano Metrics y añade los scopes " +
          "`calendars/events.write` y `contacts.write`, y actualiza GHL_PIT_TOKEN en Vercel.",
        correos: ["dreyes@bakano.ec"],
      });
    } catch (error: any) {
      console.error("[GHL] no se pudo avisar del permiso:", error?.message || error);
    }
  }

  /** Una cita por id. null si no existe o el CRM no responde. */
  async getAppointment(eventId: string): Promise<any | null> {
    try {
      const response = await axios.get(`${GHL_API_BASE}/calendars/events/appointments/${eventId}`, {
        headers: this.getHeaders(),
        timeout: 15_000,
      });
      return response.data?.event || response.data?.appointment || null;
    } catch (error: any) {
      console.error("[GHL] cita:", error.response?.data || error.message);
      return null;
    }
  }

  /**
   * Cancela o mueve una cita. Cancelar es marcarla "cancelled" (nunca DELETE):
   * la cita queda con su historial en el CRM. Mover recalcula el fin con la
   * duracion del calendario y deja que el CRM valide que el horario este libre.
   */
  async updateAppointment(eventId: string, cambio: { cancelar: true } | { startTime: Date; forzar?: boolean }): Promise<void> {
    let body: Record<string, unknown>;
    if ("cancelar" in cambio) {
      body = { appointmentStatus: "cancelled", toNotify: true };
    } else {
      const actual = await this.getAppointment(eventId);
      if (!actual?.calendarId) throw new Error("Cita no encontrada en el CRM");
      const calendario = await this.getCalendar(actual.calendarId);
      const minutos =
        calendario?.slotDurationUnit === "hours" ? (calendario.slotDuration || 1) * 60 : calendario?.slotDuration || 30;
      body = {
        startTime: cambio.startTime.toISOString(),
        endTime: new Date(cambio.startTime.getTime() + minutos * 60_000).toISOString(),
        appointmentStatus: "confirmed",
        toNotify: true,
        // El equipo mueve desde el Planificador a la hora que haga falta,
        // aunque el calendario ya no muestre ese hueco como libre. Al cliente
        // nunca se le ofrece un horario ocupado, asi que ahi va sin forzar.
        ...(cambio.forzar ? { ignoreFreeSlotValidation: true } : {}),
      };
    }
    await axios.put(`${GHL_API_BASE}/calendars/events/appointments/${eventId}`, body, { headers: this.getHeaders(), timeout: 15_000 });
  }

  /**
   * Fetches all appointments for the location across all calendars within a given timeframe.
   */
  async getAppointments(startTime: string, endTime: string) {
    try {
      // 1. Fetch all calendars
      const calendars = await this.getCalendars();
      if (!calendars.length) return [];

      // 2. Fetch events for each calendar in parallel
      // We use Promise.allSettled to ensure one failing calendar doesn't crash everything
      const eventPromises = calendars.map((cal: any) =>
        axios.get(`${GHL_API_BASE}/calendars/events`, {
          headers: this.getHeaders(),
          params: {
            locationId: this.getLocationId(),
            calendarId: cal.id,
            startTime: new Date(startTime).getTime(),
            endTime: new Date(endTime).getTime(),
          },
        })
      );

      const results = await Promise.allSettled(eventPromises);

      let allEvents: any[] = [];
      results.forEach((result, index) => {
        if (result.status === "fulfilled" && result.value.data?.events) {
          const eventsWithCalendar = result.value.data.events.map((e: any) => ({
            ...e,
            calendarName: calendars[index].name
          }));
          allEvents = allEvents.concat(eventsWithCalendar);
        } else if (result.status === "rejected") {
          console.error("Error fetching events for a calendar:", result.reason?.response?.data || result.reason?.message);
        }
      });

      return allEvents;
    } catch (error: any) {
      console.error("Error fetching GHL appointments:", error.response?.data || error.message);
      // Fallback: return empty array so UI doesn't crash if locationId/token is wrong
      return [];
    }
  }

  /**
   * Gets meetings filtered by workspace users' emails or workspace name.
   */
  async getMeetingsForWorkspace(workspaceId: string, startTime: string, endTime: string) {
    // 1. Get current workspace details
    const workspace = await models.workspaces.findById(workspaceId).select("name").lean();
    const workspaceName = (workspace?.name || "").toLowerCase().trim();
    const isAgencyWorkspace = workspaceId === "69a9ea689c444c9a6e1b28e5" || workspaceName === "bakano";

    // 2. Fetch all users from the database
    const allUsers = await models.users.find().select("email photoUrl name isInternal workspaceId workspaces").lean();

    // Helper function to extract client/external users for a specific workspace
    const getClientUsersForWorkspace = (wsId: string) => {
      return allUsers.filter((u: any) => {
        const isUserInternal = u.isInternal === true || (u.email && u.email.toLowerCase().endsWith("@bakano.ec"));
        if (isUserInternal) return false; // Only want external/client users

        const idStr = u.workspaceId?.toString() ?? "";
        if (idStr === wsId) return true;
        if (u.workspaces?.some((w: any) => (w.workspaceId?._id?.toString() ?? w.workspaceId?.toString()) === wsId)) return true;
        return false;
      });
    };

    // 3. Fetch all workspaces to do cross-workspace filtering if this is the agency workspace
    const allWorkspaces = await models.workspaces.find({}, "name").lean();

    // 4. Fetch appointments from GHL
    const appointments = await this.getAppointments(startTime, endTime);

    // Coincidencia por PALABRA completa, no por substring: "juan" dentro de
    // "Rigel / Juan Gabriel..." hacia que la reunion de Rigel apareciera en
    // el calendario de CUALQUIER cliente que tuviera un usuario llamado Juan.
    const contieneComoFrase = (texto: string, frase: string): boolean => {
      if (!texto || !frase) return false;
      const esc = frase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}([^\\p{L}\\p{N}]|$)`, "iu").test(texto);
    };

    // Helper to check if an appointment matches a specific workspace (non-agency)
    const matchesWorkspace = (appt: any, ws: any) => {
      const wsName = (ws.name || "").toLowerCase().trim();
      if (!wsName || wsName === "bakano") return false;

      const apptTitle = (appt.title || appt.name || "").toLowerCase();
      const apptCompanyName = (appt.contact?.companyName || "").toLowerCase();

      // Match by workspace name (como frase completa)
      if (contieneComoFrase(apptTitle, wsName) || contieneComoFrase(apptCompanyName, wsName)) {
        return true;
      }

      // Match by client users' emails or names
      const wsClients = getClientUsersForWorkspace(ws._id.toString());

      // Check emails
      const apptEmails: string[] = [];
      if (appt.email) apptEmails.push(appt.email.toLowerCase());
      if (appt.contact?.email) apptEmails.push(appt.contact.email.toLowerCase());
      if (Array.isArray(appt.attendees)) {
        appt.attendees.forEach((a: any) => {
          if (a.email) apptEmails.push(a.email.toLowerCase());
        });
      }
      const clientEmails = wsClients.map(c => c.email.toLowerCase());
      if (apptEmails.some(e => clientEmails.includes(e))) return true;

      // Check names: solo nombres COMPLETOS (dos palabras o mas) y como
      // frase entera. Un nombre de una sola palabra ("Juan") matchea media
      // agenda ajena.
      const clientNames = wsClients
        .map(c => c.name?.toLowerCase().trim())
        .filter((n): n is string => !!n && n.includes(" ") && n.length >= 7);
      if (clientNames.some(name => contieneComoFrase(apptTitle, name))) return true;

      return false;
    };

    // 5. Get workspace users (both clients and internal experts assigned to the workspace)
    const workspaceUsers = allUsers.filter((u: any) => {
      if (u.workspaceId?.toString() === workspaceId) return true;
      if (u.workspaces?.some((w: any) => (w.workspaceId?._id?.toString() ?? w.workspaceId?.toString()) === workspaceId)) return true;
      return false;
    });

    const workspaceEmails = workspaceUsers.map((u: any) => u.email.toLowerCase());

    // 6. Filter appointments
    // 6. Filter appointments
    const filtered = appointments.filter((appt: any) => {
      // Use the standard matching logic for all workspaces, including the agency.
      // This prevents the agency workspace calendar from being flooded with unassigned client meetings.
      const currentWs = allWorkspaces.find(ws => ws._id.toString() === workspaceId);
      if (!currentWs) return false;

      // Special case: if it's the agency workspace, we check if the title mentions agency or 
      // if it's an internal meeting (attending ONLY by internal users).
      if (isAgencyWorkspace) {
        const apptTitle = (appt.title || appt.name || "").toLowerCase();
        if (apptTitle.includes("bakano") || apptTitle.includes("interna") || apptTitle.includes("equipo")) {
          return true;
        }
        
        // Exclude if it matches another client
        const matchesAnyOther = allWorkspaces.some(ws => {
          if (ws._id.toString() === workspaceId) return false;
          return matchesWorkspace(appt, ws);
        });
        if (matchesAnyOther) return false;

        // Count internal vs external attendees
        const apptEmails: string[] = [];
        if (appt.email) apptEmails.push(appt.email.toLowerCase());
        if (appt.contact?.email) apptEmails.push(appt.contact.email.toLowerCase());
        if (Array.isArray(appt.attendees)) {
          appt.attendees.forEach((a: any) => {
            if (a.email) apptEmails.push(a.email.toLowerCase());
          });
        }

        const agencyEmails = allUsers.filter(u => u.isInternal || (u.email && u.email.toLowerCase().endsWith("@bakano.ec"))).map(u => u.email.toLowerCase());
        const hasExternal = apptEmails.some(e => !agencyEmails.includes(e));
        const hasInternal = apptEmails.some(e => agencyEmails.includes(e));

        // If it's strictly an internal meeting (no external emails) and has internal people, it's for the agency
        if (hasInternal && !hasExternal && apptEmails.length > 0) return true;

        return false;
      }

      return matchesWorkspace(appt, currentWs);
    });

    // 7. Transform to match a standard format for frontend
    return filtered.map((appt: any) => {
      const apptTitle = (appt.title || appt.name || "").toLowerCase();
      
      // Map attendees to include photos
      const mappedAttendees = (appt.attendees || []).map((att: any) => {
        const foundUser = allUsers.find(u => u.email.toLowerCase() === att.email?.toLowerCase());
        return {
          ...att,
          photoUrl: foundUser?.photoUrl || null,
          name: foundUser?.name || att.name || "Invitado"
        };
      });

      // Infer client attendee from title (solo nombres completos, como frase)
      const clientAttending = workspaceUsers.find((u: any) => {
        if (!u.name || !u.email) return false;
        if (u.email.toLowerCase().endsWith('@bakano.ec')) return false;
        const nombre = u.name.toLowerCase().trim();
        if (!nombre.includes(" ") || nombre.length < 7) return false;
        return contieneComoFrase(apptTitle, nombre);
      });

      if (clientAttending && !mappedAttendees.some((a: any) => a.email === clientAttending.email)) {
        mappedAttendees.push({
          name: clientAttending.name,
          email: clientAttending.email,
          photoUrl: clientAttending.photoUrl || null
        });
      }

      // Infer host attendee from calendar name
      if (appt.calendarName) {
        const calNameLower = appt.calendarName.toLowerCase();
        
        // 1. Try to find by name match
        let host = allUsers.find(u => {
          if (!u.name || !u.email.toLowerCase().endsWith('@bakano.ec')) return false;
          return calNameLower.includes(u.name.toLowerCase());
        });

        // 2. Try to find by role match within workspace internal users
        if (!host) {
          const internalTeam = workspaceUsers.filter((u: any) => u.email && u.email.toLowerCase().endsWith('@bakano.ec'));
          if (calNameLower.includes('trafficker') || calNameLower.includes('meta') || calNameLower.includes('ads') || calNameLower.includes('campaña') || calNameLower.includes('retorno')) {
            host = internalTeam.find((u: any) => u.internalRole === 'trafficker');
          } else if (calNameLower.includes('manager') || calNameLower.includes('project') || calNameLower.includes('onboarding') || calNameLower.includes('kickoff') || calNameLower.includes('bienvenida')) {
            host = internalTeam.find((u: any) => u.internalRole === 'project_manager');
          } else if (calNameLower.includes('community') || calNameLower.includes('redes') || calNameLower.includes('cm') || calNameLower.includes('contenido')) {
            host = internalTeam.find((u: any) => u.internalRole === 'community_manager');
          } else if (calNameLower.includes('produccion') || calNameLower.includes('producción') || calNameLower.includes('grabacion') || calNameLower.includes('video')) {
            host = internalTeam.find((u: any) => u.internalRole === 'asistente_produccion' || u.internalRole === 'editor');
          }
        }

        if (host && !mappedAttendees.some((a: any) => a.email === host.email)) {
          mappedAttendees.push({
            name: host.name,
            email: host.email,
            photoUrl: host.photoUrl || null
          });
        }
      }

      return {
        _id: appt.id || appt.eventId,
        title: appt.title || appt.name || "Reunión Agendada",
        startTime: appt.startTime,
        endTime: appt.endTime,
        status: appt.status,
        calendarId: appt.calendarId,
        calendarName: appt.calendarName,
        attendees: mappedAttendees,
        contact: appt.contact || null,
        meetingLocation: appt.meetingLocation || appt.location || "",
        isGhlMeeting: true
      };
    });
  }
}

export const ghlService = new GhlService();
