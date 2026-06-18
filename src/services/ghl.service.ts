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
    // 1. Get workspace details
    const workspace = await models.workspaces.findById(workspaceId).select("name").lean();
    const workspaceName = (workspace?.name || "").toLowerCase().trim();

    // 2. Get workspace users (both clients and internal experts assigned to the workspace)
    const allUsers = await models.users.find().select("email photoUrl name isInternal workspaceId workspaces").lean();

    const workspaceUsers = allUsers.filter((u: any) => {
      if (u.workspaceId?.toString() === workspaceId) return true;
      if (u.workspaces?.some((w: any) => w.workspaceId?.toString() === workspaceId)) return true;
      return false;
    });

    const workspaceEmails = workspaceUsers.map((u: any) => u.email.toLowerCase());

    // 3. Fetch appointments from GHL
    const appointments = await this.getAppointments(startTime, endTime);

    // 4. Filter appointments
    const filtered = appointments.filter((appt: any) => {
      const apptTitle = (appt.title || appt.name || "").toLowerCase();
      const apptCompanyName = (appt.contact?.companyName || "").toLowerCase();

      // Condition A: Event title contains workspace name (entorno)
      if (workspaceName && apptTitle.includes(workspaceName)) return true;

      // Condition B: Event contact company name matches workspace name
      if (workspaceName && apptCompanyName.includes(workspaceName)) return true;

      // Condition C: Match any attendee email against experts and clients
      const emails: string[] = [];
      if (appt.email) emails.push(appt.email.toLowerCase());
      if (appt.contact?.email) emails.push(appt.contact.email.toLowerCase());
      if (Array.isArray(appt.attendees)) {
        appt.attendees.forEach((a: any) => {
          if (a.email) emails.push(a.email.toLowerCase());
        });
      }

      if (emails.some(e => workspaceEmails.includes(e))) return true;

      // Condition D: Event title contains an EXTERNAL workspace user's name
      const hasNameMatch = workspaceUsers.some((u: any) => {
        if (!u.name || !u.email) return false;
        // Ignore internal employees (bakano.ec)
        if (u.email.toLowerCase().endsWith('@bakano.ec')) return false;
        
        // Exact full name match in the title (case insensitive)
        return apptTitle.includes(u.name.toLowerCase());
      });

      return hasNameMatch;
    });

    // 4. Transform to match a standard format for frontend
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
