import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { PlanningService } from "../services/planning.service";
import models from "../models";
import { atencionClienteService } from "../services/atencionCliente.service";
import { ANTICIPACION_PRODUCCION_H } from "../mcp/tools/base";

const planningService = new PlanningService();

export async function createEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { title, date, notes, assignedTo } = req.body;
    const userId = req.user?._id;

    if (!title || !date) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Title and Date are required." });
      return;
    }

    const entry = await planningService.createEntry({
      workspaceId,
      title,
      date: new Date(date),
      notes,
      assignedTo: Array.isArray(assignedTo) ? assignedTo : [],
      createdBy: userId!,
    });

    res.status(HttpStatusCode.Created).send({ message: "Planning entry created successfully.", entry });
    return;
  } catch (error) {
    console.error("createEntry error:", error);
    next(error);
  }
}

export async function listEntries(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const workspaceId = req.params["workspaceId"] as string;
    const { startDate, endDate } = req.query;

    // Superadmin can query any workspace without restriction
    const isSuperadmin = req.user?.role === "superadmin";

    if (!isSuperadmin) {
      // For regular users, verify they belong to this workspace
      const userId = req.user?._id;
      const user = await models.users.findById(userId).lean() as any;
      const hasAccess =
        user?.isInternal ||
        (user?.workspaces || []).some((ws: any) => {
          const wsId = ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString();
          return wsId === workspaceId;
        });

      if (!hasAccess) {
        res.status(HttpStatusCode.Forbidden).send({ message: "Access denied to this workspace." });
        return;
      }
    }

    const entries = await planningService.listEntries(
      workspaceId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined,
      req.query.incluirCanceladas === "true"
    );

    res.status(HttpStatusCode.Ok).send({ message: "Planning entries retrieved successfully.", entries });
    return;
  } catch (error) {
    console.error("listEntries error:", error);
    next(error);
  }
}

export async function updateEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entryId = req.params["entryId"] as string;
    const { title, date, notes, assignedTo } = req.body;

    const bloqueo = await revisarCambioDeFecha(req, entryId, date);
    if (bloqueo) {
      res.status(bloqueo.status).send({ message: bloqueo.message });
      return;
    }

    const entry = await planningService.updateEntry(entryId, {
      title,
      date,
      notes,
      assignedTo: Array.isArray(assignedTo) ? assignedTo : undefined,
    }, (req.user as any)?.name || req.user?.email);

    res.status(HttpStatusCode.Ok).send({ message: "Planning entry updated successfully.", entry });
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Entry not found." });
      return;
    }
    console.error("updateEntry error:", error);
    next(error);
  }
}

/**
 * Antes de mover una producción. El middleware de admin mira el workspaceId
 * del body, así que aquí se confirma que la producción sea de un entorno donde
 * la persona es admin. Si la cita vive en el CRM, el Planificador la mueve
 * forzada: el cliente solo puede llevarla a un horario que el calendario
 * ofrece y con 48 h de anticipación; el equipo, a cualquier hora que no
 * choque con otra cita y sin el mínimo de 48 h.
 */
async function revisarCambioDeFecha(
  req: AuthRequest,
  entryId: string,
  date: unknown
): Promise<{ status: number; message: string } | null> {
  const user: any = req.user?.role === "superadmin" ? { role: "superadmin" } : await models.users.findById(req.user?._id).select("role isInternal workspaces").lean();
  const equipo = user?.role === "superadmin" || user?.isInternal === true;
  const entry: any = await models.planning.findById(entryId).select("workspaceId date crm").lean().catch(() => null);
  if (!entry) return null; // el servicio responde 404

  if (!equipo) {
    const esAdmin = (user?.workspaces || []).some((w: any) => String(w.workspaceId) === String(entry.workspaceId) && w.role === "admin");
    if (!esAdmin) return { status: HttpStatusCode.Forbidden, message: "No tienes acceso a esta producción." };
  }

  if (date === undefined) return null;
  const nueva = new Date(date as string);
  if (Number.isNaN(nueva.getTime()) || Math.abs(nueva.getTime() - new Date(entry.date).getTime()) <= 60_000) return null;
  // Solo el equipo interno mueve con menos de 48 h; el cliente no.
  if (!equipo && nueva.getTime() - Date.now() < ANTICIPACION_PRODUCCION_H * 3_600_000) {
    return { status: HttpStatusCode.UnprocessableEntity, message: `La producción se mueve con al menos ${ANTICIPACION_PRODUCCION_H} h de anticipación. Si es urgente, escríbele a tu equipo de Bakano.` };
  }
  if (!entry.crm?.appointmentId || !entry.crm?.calendarId) return null;

  try {
    if (equipo) {
      const choques = await atencionClienteService.choquesProduccion(entry.crm.calendarId, nueva, entry.crm.appointmentId);
      if (choques.length) {
        return { status: HttpStatusCode.Conflict, message: `Esa hora choca con ${choques.map((c) => `"${c.titulo}" (${c.cuando})`).join(", ")} en el calendario de producción.` };
      }
    } else if (!(await atencionClienteService.sigueLibre(entry.crm.calendarId, nueva))) {
      return { status: HttpStatusCode.Conflict, message: "Ese horario no está disponible en el calendario de producción. Elige uno de los horarios libres." };
    }
  } catch (error: any) {
    console.error("[Planificador] no se pudo revisar el calendario del CRM:", error.response?.data || error.message);
    return { status: HttpStatusCode.BadGateway, message: "No pude revisar el calendario del CRM. Intenta de nuevo en un momento." };
  }
  return null;
}

export async function deleteEntry(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const entryId = req.params["entryId"] as string;

    await planningService.deleteEntry(entryId);

    res.status(HttpStatusCode.Ok).send({ message: "Planning entry deleted successfully." });
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "INVALID_ID") {
      res.status(HttpStatusCode.NotFound).send({ message: "Entry not found." });
      return;
    }
    console.error("deleteEntry error:", error);
    next(error);
  }
}

export async function listMyWeek(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const userId = req.user?._id;
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      res.status(HttpStatusCode.BadRequest).send({ message: "startDate and endDate are required." });
      return;
    }

    const user = await models.users.findById(userId).populate("workspaces.workspaceId", "name metaAds").lean();

    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    let workspaceIds: string[] = [];

    // Build workspace name + Meta page id lookups — populated workspaceId is { _id, name, metaAds }
    const wsNameMap: Record<string, string> = {};
    const wsMetaPageIdMap: Record<string, string> = {};

    (user.workspaces || []).forEach((ws: any) => {
      const id = ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString();
      if (!id) return;
      if (ws.workspaceId?.name) wsNameMap[id] = ws.workspaceId.name;
      if (ws.workspaceId?.metaAds?.pageId) wsMetaPageIdMap[id] = ws.workspaceId.metaAds.pageId;
    });

    const isSuperadminOrInternal =
      req.user?.role === "superadmin" ||
      user.role === "superadmin" ||
      user.isInternal === true;

    if (isSuperadminOrInternal) {
      // Fetch all workspaces with name + metaAds so we can label entries correctly
      const allWorkspaces = await models.workspaces.find({}, "_id name metaAds.pageId").lean();
      workspaceIds = allWorkspaces.map((ws: any) => ws._id.toString());
      allWorkspaces.forEach((ws: any) => {
        const id = ws._id.toString();
        wsNameMap[id] = ws.name;
        if (ws.metaAds?.pageId) wsMetaPageIdMap[id] = ws.metaAds.pageId;
      });
    } else {
      // For regular users, workspaceId is a populated object — extract _id
      workspaceIds = (user.workspaces || [])
        .map((ws: any) => ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString())
        .filter((id: string | undefined): id is string => Boolean(id));
    }

    // Fetch from all workspaces in parallel
    const allEntriesNested = await Promise.all(
      workspaceIds.map((wsId) =>
        planningService.listEntries(wsId, new Date(startDate as string), new Date(endDate as string))
      )
    );

    const entries = allEntriesNested
      .flat()
      .map((entry) => ({
        ...(entry as any).toObject?.() ?? entry,
        workspaceName: wsNameMap[(entry as any).workspaceId?.toString()] || "Workspace",
        workspaceMetaPageId: wsMetaPageIdMap[(entry as any).workspaceId?.toString()],
      }))
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    res.status(HttpStatusCode.Ok).send({ message: "My week entries retrieved successfully.", entries });
    return;
  } catch (error) {
    console.error("listMyWeek error:", error);
    next(error);
  }
}

/**
 * GET /planning/mine?startDate&endDate — las planificaciones del mes de TODOS
 * los entornos del usuario, en una sola consulta.
 *
 * El calendario del editor pedia /planning/:workspaceId una vez por cliente
 * (100+ peticiones por mes) y se quedaba en "Cargando planificaciones..."
 * durante decenas de segundos. Un editor ve sus workspaces; si no tiene
 * ninguno asignado y es interno, ve todos.
 */
export async function listMine(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      res.status(HttpStatusCode.BadRequest).send({ message: "startDate and endDate are required." });
      return;
    }

    const user = (await models.users.findById(req.user?._id).select("workspaces isInternal role").lean()) as any;
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }

    const ownIds: string[] = (user.workspaces || [])
      .map((ws: any) => ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString())
      .filter(Boolean);
    const verTodo =
      ownIds.length === 0 && (req.user?.role === "superadmin" || user.role === "superadmin" || user.isInternal);

    const entries = await planningService.listEntriesAcross(
      verTodo ? null : ownIds,
      new Date(startDate as string),
      new Date(endDate as string)
    );

    res.status(HttpStatusCode.Ok).send({ message: "Planning entries retrieved successfully.", entries });
  } catch (error) {
    console.error("listMine error:", error);
    next(error);
  }
}

/**
 * GET /planning/monthly-status?year&month — produccion del mes por entorno:
 * cumplida (ya se grabo), cuantas producciones hay y la proxima fecha.
 * Un cliente solo ve sus entornos; el equipo interno ve todos.
 */
export async function monthlyStatus(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const now = new Date();
    const year = Number(req.query.year) || now.getUTCFullYear();
    const month = Number(req.query.month) || now.getUTCMonth() + 1;
    if (month < 1 || month > 12 || year < 2020 || year > 2100) {
      res.status(HttpStatusCode.BadRequest).send({ message: "year/month inválidos." });
      return;
    }

    const user = (await models.users.findById(req.user?._id).select("workspaces workspaceId isInternal role").lean()) as any;
    if (!user) {
      res.status(HttpStatusCode.NotFound).send({ message: "User not found." });
      return;
    }
    const esInterno = req.user?.role === "superadmin" || user.role === "superadmin" || user.isInternal === true;
    const ownIds: string[] = [
      ...(user.workspaceId ? [user.workspaceId.toString()] : []),
      ...(user.workspaces || [])
        .map((ws: any) => ws.workspaceId?._id?.toString() ?? ws.workspaceId?.toString())
        .filter(Boolean),
    ];

    const status = await planningService.monthlyStatus(year, month, esInterno ? null : ownIds);
    res.status(HttpStatusCode.Ok).send({ message: "Monthly production status retrieved.", year, month, status });
  } catch (error) {
    console.error("monthlyStatus error:", error);
    next(error);
  }
}

/**
 * POST /planning/crm-sync?startDate&endDate — trae al Planificador, en el
 * momento, las citas de produccion del CRM del rango que se esta viendo.
 * Solo equipo interno. Devuelve cuantas se crearon/movieron/cancelaron para
 * que la pantalla recargue si hubo cambios.
 */
export async function syncCrmRange(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const user = (await models.users.findById(req.user?._id).select("isInternal role").lean()) as any;
    const esInterno = req.user?.role === "superadmin" || user?.role === "superadmin" || user?.isInternal === true;
    if (!esInterno) {
      res.status(HttpStatusCode.Forbidden).send({ message: "Solo el equipo interno puede sincronizar con el CRM." });
      return;
    }
    const desde = new Date(String(req.query.startDate || req.body?.startDate || ""));
    const hasta = new Date(String(req.query.endDate || req.body?.endDate || ""));
    if (Number.isNaN(desde.getTime()) || Number.isNaN(hasta.getTime()) || hasta <= desde) {
      res.status(HttpStatusCode.BadRequest).send({ message: "startDate y endDate son requeridos." });
      return;
    }
    // Tope de 3 meses: la pantalla pide una semana o un mes.
    if (hasta.getTime() - desde.getTime() > 93 * 86_400_000) {
      res.status(HttpStatusCode.BadRequest).send({ message: "El rango máximo es de 3 meses." });
      return;
    }
    const { sincronizarRangoEnVivo } = await import("../services/crmProductionSync.service");
    const resultado = await sincronizarRangoEnVivo(desde, hasta);
    const cambios = (resultado.creadas || 0) + (resultado.reprogramadas || 0) + (resultado.canceladas || 0);
    res.status(HttpStatusCode.Ok).send({ message: "Sincronización con el CRM ejecutada.", cambios, ...resultado });
  } catch (error: any) {
    console.error("syncCrmRange error:", error);
    res.status(HttpStatusCode.Ok).send({ message: "No se pudo sincronizar con el CRM.", cambios: 0, error: error.message });
  }
}

/**
 * PATCH /api/planning/:entryId/cumplida { realizada: boolean } (equipo).
 * Marca o desmarca a mano que la produccion ya se hizo.
 */
export async function marcarRealizada(req: AuthRequest, res: Response, next: NextFunction) {
  try {
    const realizada = req.body?.realizada !== false;
    const u = req.user as any;
    const entry = await planningService.marcarRealizada(String(req.params.entryId), realizada, {
      id: u?._id ? String(u._id) : undefined,
      nombre: u?.name || u?.email,
    });
    res.status(200).send({ entry });
  } catch (error: any) {
    const mensajes: Record<string, [number, string]> = {
      INVALID_ID: [400, "Identificador inválido."],
      NOT_FOUND: [404, "Producción no encontrada."],
      PRODUCCION_CANCELADA: [409, "Esa producción está cancelada: no se puede marcar como realizada."],
      PRODUCCION_FUTURA: [409, "Esa producción todavía no llega: se marca cuando ya se hizo."],
    };
    const m = mensajes[error?.message];
    if (m) return res.status(m[0]).send({ message: m[1] });
    next(error);
  }
}
