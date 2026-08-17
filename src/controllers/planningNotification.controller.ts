import type { Response, NextFunction } from "express";
import { HttpStatusCode } from "axios";
import { AuthRequest } from "../types/AuthRequest";
import { planningNotificationService } from "../services/planningNotification.service";
import models from "../models";

/** Botón "Notificar al cliente": dispara WhatsApp y correo. */
export async function notificarPlanificacion(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = req.params["planningId"] as string;
    const resultado = await planningNotificationService.notificar(
      planningId,
      req.user?.email
    );

    // Éxito parcial: si un canal falla el otro ya salió, y quien pulsó el
    // botón necesita saber exactamente cuál para poder actuar.
    const alguno = resultado.whatsapp.enviado || resultado.email.enviado;
    res.status(alguno ? HttpStatusCode.Ok : HttpStatusCode.BadGateway).send({
      message: alguno
        ? "Notificación enviada."
        : "No se pudo notificar por ningún canal.",
      resultado,
    });
    return;
  } catch (error: any) {
    if (error.message === "CICLO_CERRADO") {
      res.status(HttpStatusCode.Conflict).send({
        message:
          "El cliente ya respondió esta planificación. Se podrá volver a notificar cuando se envíe una nueva.",
      });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "WORKSPACE_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificación no encontrada." });
      return;
    }
    next(error);
    return;
  }
}

/** Quién va a recibir qué, antes de pulsar el botón. */
export async function destinatariosPlanificacion(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = req.params["planningId"] as string;
    const preview = await planningNotificationService.previewDestinatarios(planningId);
    res.status(HttpStatusCode.Ok).send(preview);
    return;
  } catch (error: any) {
    if (error.message === "NOT_FOUND" || error.message === "WORKSPACE_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificación no encontrada." });
      return;
    }
    next(error);
    return;
  }
}

/** Cargar el teléfono de un destinatario sin salir de la pantalla de avisos. */
export async function guardarTelefonoDestinatario(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = req.params["planningId"] as string;
    const userId = req.params["userId"] as string;
    const { phoneNumber, phoneExtension } = req.body ?? {};

    if (!phoneNumber) {
      res.status(HttpStatusCode.BadRequest).send({ message: "Falta el número." });
      return;
    }

    const usuario = await planningNotificationService.guardarTelefono(
      planningId,
      userId,
      String(phoneNumber),
      String(phoneExtension || "593")
    );
    res.status(HttpStatusCode.Ok).send({ message: "Teléfono guardado.", usuario });
    return;
  } catch (error: any) {
    if (error.message === "TELEFONO_INVALIDO") {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Ese número no es válido para el país seleccionado.",
      });
      return;
    }
    if (error.message === "USER_NOT_IN_WORKSPACE") {
      res.status(HttpStatusCode.Forbidden).send({
        message: "Ese usuario no pertenece al entorno de esta planificación.",
      });
      return;
    }
    if (error.message === "NOT_FOUND" || error.message === "USER_NOT_FOUND") {
      res.status(HttpStatusCode.NotFound).send({ message: "No encontrado." });
      return;
    }
    next(error);
    return;
  }
}

/** Historial de avisos, para la auditoría de la vista. */
export async function historialNotificaciones(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const planningId = req.params["planningId"] as string;
    const planning: any = await models.videoPlanning
      .findById(planningId)
      .select("notificaciones notificacionAbierta clienteAprobado")
      .lean();

    if (!planning) {
      res.status(HttpStatusCode.NotFound).send({ message: "Planificación no encontrada." });
      return;
    }

    const notificaciones = planning.notificaciones ?? [];
    const porCanal = (canal: string) => notificaciones.filter((n: any) => n.canal === canal);

    res.status(HttpStatusCode.Ok).send({
      puedeNotificar: planning.notificacionAbierta && !planning.clienteAprobado,
      notificaciones,
      resumen: {
        whatsapp: porCanal("whatsapp").filter((n: any) => n.exito).length,
        email: porCanal("email").filter((n: any) => n.exito).length,
        aperturas: porCanal("email").filter((n: any) => n.abiertoEn).length,
        clics: porCanal("email").filter((n: any) => n.clicEn).length,
        ultima: notificaciones.length ? notificaciones[notificaciones.length - 1] : null,
      },
    });
    return;
  } catch (error) {
    next(error);
    return;
  }
}

/** Resuelve el enlace fijo del WhatsApp: cuál es la que toca aprobar. */
export async function planificacionPendiente(
  req: AuthRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const workspaceId = req.query["workspaceId"] as string;
    if (!workspaceId) {
      res.status(HttpStatusCode.BadRequest).send({
        message: "Falta el entorno del que buscar la planificación.",
      });
      return;
    }

    const pendiente = await planningNotificationService.pendienteDeAprobar(String(workspaceId));
    res.status(HttpStatusCode.Ok).send({ pendiente });
    return;
  } catch (error) {
    next(error);
    return;
  }
}
