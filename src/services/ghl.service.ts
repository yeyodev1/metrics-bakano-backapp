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

  private getLocationId() {
    const locationId = process.env.GHL_LOCATION_ID;
    if (!locationId) throw new Error("GHL_LOCATION_ID no configurado en variables de entorno");
    return locationId;
  }

  /**
   * Fetches all calendars for the location.
   */
  private async getCalendars() {
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

    // Helper to check if an appointment matches a specific workspace (non-agency)
    const matchesWorkspace = (appt: any, ws: any) => {
      const wsName = (ws.name || "").toLowerCase().trim();
      if (!wsName || wsName === "bakano") return false;

      const apptTitle = (appt.title || appt.name || "").toLowerCase();
      const apptCompanyName = (appt.contact?.companyName || "").toLowerCase();

      // Match by workspace name
      if (apptTitle.includes(wsName) || apptCompanyName.includes(wsName)) {
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

      // Check names
      const clientNames = wsClients.map(c => c.name?.toLowerCase()).filter(Boolean);
      if (clientNames.some(name => apptTitle.includes(name))) return true;

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

      // Infer client attendee from title
      const clientAttending = workspaceUsers.find((u: any) => {
        if (!u.name || !u.email) return false;
        if (u.email.toLowerCase().endsWith('@bakano.ec')) return false;
        return apptTitle.includes(u.name.toLowerCase());
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
